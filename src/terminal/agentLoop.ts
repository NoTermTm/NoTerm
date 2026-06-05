import type { AiSettings, AiMessage } from "../api/ai";
import { sendAiChatStream } from "../api/ai";
import type {
  AgentApprovalMode,
  AgentCommandResult,
  AgentPolicyDecision,
  AgentStepAction,
  AgentActionStatus,
} from "../types/agent";
import {
  parseAgentResponse,
  extractStreamingThinking,
  type ParsedAgentResponse,
} from "./agentResponseParser";
import { evaluateCommandPolicy, type PolicyEvaluationInput } from "./agentPolicy";
import { appendAgentAuditRecord } from "./agentAudit";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface AgentLoopConfig {
  sessionId: string;
  aiSettings: AiSettings;
  approvalMode: AgentApprovalMode;
  terminalContext: () => string;
  locale: "zh-CN" | "en-US";
  conversationHistory?: AiMessage[];
  onThinkingDelta: (thinking: string) => void;
  onThinkingComplete: (content: string) => void;
  onActionDecided: (action: AgentStepAction) => void;
  onActionStatusChange: (actionId: string, status: AgentActionStatus) => void;
  onOutputReceived: (actionId: string, result: AgentCommandResult) => void;
  onConfirmationNeeded: (
    actionId: string,
    action: AgentStepAction,
    policy: AgentPolicyDecision,
  ) => void;
  onLoopComplete: (summary: string) => void;
  onError: (error: string) => void;
  executeCommand: (command: string, timeoutSec: number) => Promise<AgentCommandResult>;
}

export interface AgentLoopController {
  start(userMessage: string): void;
  stop(): void;
  confirmAction(actionId: string): void;
  rejectAction(actionId: string): void;
  isRunning(): boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_STEPS = 20;
const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_COMMAND_TIMEOUT_SEC = 30;
const MAX_COMMAND_OUTPUT_CHARS = 6000;
const MAX_COMMAND_OUTPUT_LINES = 120;

// ─── System Prompt Builder (Task 6.2) ─────────────────────────────────────────

/**
 * Build the system prompt for the Agent loop.
 * Instructs the AI to respond using separate <thinking>, <action>, <done> blocks.
 * Includes terminal context and supports zh-CN / en-US locales.
 */
export function buildAgentSystemPrompt(
  terminalContext: string,
  locale: string,
): string {
  if (locale === "zh-CN") {
    return `你是一个终端 AI 助手，帮助用户在服务器上执行运维任务。

## 终端上下文
${terminalContext}

## 响应格式

你必须严格按照以下格式响应：

### 需要执行命令时：
<thinking>
分析用户请求，说明你的推理过程和计划执行的命令。评估命令的风险等级。
</thinking>

<action>
{"command": "要执行的命令", "risk": "low|medium|high|critical", "reason": "执行原因"}
</action>

### 任务完成或无需执行命令时：
<thinking>
简要记录你的内部判断、是否需要命令、以及答案组织思路。
</thinking>

<done>
直接给用户看的最终答复。不要重复 thinking，要给结论、建议、下一步。
</done>

## 规则

1. 每次只执行一个命令，观察结果后再决定下一步
2. 为每个命令评估风险等级：
   - low: 只读命令（ls, cat, ps, df 等）
   - medium: 服务管理命令（systemctl restart 等）
   - high: 文件修改、权限变更命令（rm, chmod, sed -i 等）
   - critical: 可能造成不可逆损害的命令
3. 如果命令被阻止或被用户拒绝，根据反馈调整策略
4. 如果命令执行失败，分析错误输出并尝试修正
5. thinking 是内部过程，不要把它当作最终答复
6. 完成任务后使用 <done>...</done> 输出最终答复`;
  }

  // en-US (default)
  return `You are a terminal AI assistant that helps users perform operations on servers.

## Terminal Context
${terminalContext}

## Response Format

You MUST respond strictly in the following format:

### When a command needs to be executed:
<thinking>
Analyze the user's request, explain your reasoning and the command you plan to execute. Assess the risk level of the command.
</thinking>

<action>
{"command": "command to execute", "risk": "low|medium|high|critical", "reason": "reason for execution"}
</action>

### When the task is complete or no command is needed:
<thinking>
Briefly capture your internal reasoning, whether commands are needed, and how you will answer.
</thinking>

<done>
The final user-facing answer. Do not repeat the thinking block. Give the conclusion, recommendation, and next step.
</done>

## Rules

1. Execute only one command at a time, observe the result, then decide the next step
2. Assess risk level for each command:
   - low: read-only commands (ls, cat, ps, df, etc.)
   - medium: service management commands (systemctl restart, etc.)
   - high: file modification, permission changes (rm, chmod, sed -i, etc.)
   - critical: commands that may cause irreversible damage
3. If a command is blocked or rejected by the user, adjust your strategy based on the feedback
4. If a command fails, analyze the error output and attempt to correct
5. Treat thinking as internal process, not the final answer
6. Use <done>...</done> for the final user-facing answer`;
}

// ─── Agent Loop Factory (Task 6.1) ───────────────────────────────────────────

/**
 * Create an Agent Loop controller that orchestrates the think-act-observe cycle.
 */
export function createAgentLoop(config: AgentLoopConfig): AgentLoopController {
  let running = false;
  let abortController: AbortController | null = null;
  let pendingConfirmResolve: ((confirmed: boolean) => void) | null = null;
  let confirmationTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingActionId: string | null = null;

  /**
   * Build the conversation history messages for the next AI call.
   */
  function buildMessages(
    userRequest: string,
    steps: Array<{
      aiResponse: string;
      commandOutput?: string;
    }>,
  ): AiMessage[] {
    const systemPrompt = buildAgentSystemPrompt(
      config.terminalContext(),
      config.locale,
    );

    const history = config.conversationHistory ?? [];
    const messages: AiMessage[] = [{ role: "system", content: systemPrompt }, ...history];

    messages.push({ role: "user", content: userRequest });

    for (const step of steps) {
      messages.push({ role: "assistant", content: step.aiResponse });
      if (step.commandOutput !== undefined) {
        messages.push({ role: "user", content: step.commandOutput });
      }
    }

    return messages;
  }

  /**
   * Format command output as a user message for the conversation history.
   */
  function formatCommandOutput(
    command: string,
    result: AgentCommandResult,
  ): string {
    const truncateOutput = (label: string, value: string) => {
      const normalized = (value || "").trim();
      if (!normalized) return `${label}: [empty]`;

      const lines = normalized.split("\n");
      const lineTrimmed =
        lines.length > MAX_COMMAND_OUTPUT_LINES
          ? [
              ...lines.slice(0, 80),
              `... [${lines.length - 100} more lines omitted] ...`,
              ...lines.slice(-20),
            ].join("\n")
          : normalized;

      if (lineTrimmed.length <= MAX_COMMAND_OUTPUT_CHARS) {
        return `${label}: ${lineTrimmed}`;
      }

      const head = lineTrimmed.slice(0, 4200).trimEnd();
      const tail = lineTrimmed.slice(-1400).trimStart();
      const omitted = Math.max(0, lineTrimmed.length - head.length - tail.length);
      return `${label}: ${head}\n... [${omitted} chars omitted] ...\n${tail}`;
    };

    const parts = [
      "[Command Output]",
      `command: ${command}`,
      `exit_code: ${result.exitCode}`,
      truncateOutput("stdout", result.stdout),
      truncateOutput("stderr", result.stderr),
    ];
    if (result.timedOut) {
      parts.push("note: command timed out");
    }
    return parts.join("\n");
  }

  /**
   * Format a blocked/rejected message for the conversation history.
   */
  function formatBlockedOutput(command: string, reason: string): string {
    return `[Command Blocked]\ncommand: ${command}\nreason: ${reason}`;
  }

  /**
   * Format a rejection message for the conversation history.
   */
  function formatRejectedOutput(command: string): string {
    return `[Command Rejected]\ncommand: ${command}\nreason: User rejected the command execution.`;
  }

  function deriveVisibleSummary(rawResponse: string, parsed: ParsedAgentResponse): string {
    const explicit = (parsed.finalAnswer || "").trim();
    if (explicit) return explicit;

    const thinking = (parsed.thinking || "").trim();
    if (thinking) return thinking;

    const stripped = rawResponse
      .replace(/<\/?(thinking|action|done)>/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (stripped) return stripped;

    return config.locale === "zh-CN"
      ? "本轮分析已完成，但模型没有返回可展示的答复。"
      : "The analysis finished, but the model returned no displayable answer.";
  }

  /**
   * Wait for user confirmation with a 5-minute timeout.
   * Returns true if confirmed, false if rejected or timed out.
   */
  function waitForConfirmation(
    actionId: string,
    action: AgentStepAction,
    policy: AgentPolicyDecision,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      pendingActionId = actionId;
      pendingConfirmResolve = resolve;

      config.onConfirmationNeeded(actionId, action, policy);

      confirmationTimer = setTimeout(() => {
        if (pendingConfirmResolve) {
          pendingConfirmResolve(false);
          pendingConfirmResolve = null;
          pendingActionId = null;
          config.onActionStatusChange(actionId, "timeout");
        }
      }, CONFIRMATION_TIMEOUT_MS);
    });
  }

  /**
   * Clean up confirmation state.
   */
  function clearConfirmation() {
    if (confirmationTimer) {
      clearTimeout(confirmationTimer);
      confirmationTimer = null;
    }
    pendingConfirmResolve = null;
    pendingActionId = null;
  }

  /**
   * The main agent loop execution.
   */
  async function runLoop(userMessage: string) {
    running = true;
    abortController = new AbortController();

    const steps: Array<{ aiResponse: string; commandOutput?: string }> = [];

    // Audit: loop started
    await appendAgentAuditRecord({
      event: "loop_started",
      session_id: config.sessionId,
      user_request: userMessage,
    }).catch(() => {});

    try {
      for (let stepIndex = 0; stepIndex < MAX_STEPS; stepIndex++) {
        if (!running) break;

        // Build messages with full conversation history
        const messages = buildMessages(userMessage, steps);
        const requestStartedAt = Date.now();
        let firstTokenRecorded = false;

        // Track streaming content for thinking extraction
        let streamBuffer = "";

        // Call AI with streaming
        const fullResponse = await sendAiChatStream(
          config.aiSettings,
          messages,
          (delta) => {
            if (!firstTokenRecorded) {
              firstTokenRecorded = true;
              void appendAgentAuditRecord({
                event: "step_thinking",
                session_id: config.sessionId,
                step_index: stepIndex,
                reason: `first_token_ms=${Date.now() - requestStartedAt};messages=${messages.length}`,
              }).catch(() => {});
            }
            // Accumulate the full response to extract thinking progressively
            streamBuffer += delta;
            const currentThinking = extractStreamingThinking(streamBuffer);
            if (currentThinking) {
              config.onThinkingDelta(currentThinking);
            }
          },
          { signal: abortController!.signal },
        );

        if (!firstTokenRecorded) {
          await appendAgentAuditRecord({
            event: "step_thinking",
            session_id: config.sessionId,
            step_index: stepIndex,
            reason: `first_token_ms=none;request_ms=${Date.now() - requestStartedAt};messages=${messages.length}`,
          }).catch(() => {});
        }

        if (!running) break;

        // Parse the complete response
        const parsed = parseAgentResponse(fullResponse);

        // Notify thinking complete
        if (parsed.thinking) {
          config.onThinkingComplete(parsed.thinking);
        }

        // If done (no action), loop ends
        if (parsed.done && !parsed.action) {
          const visibleSummary = deriveVisibleSummary(fullResponse, parsed);
          steps.push({ aiResponse: fullResponse });

          // Audit: loop completed
          await appendAgentAuditRecord({
            event: "loop_completed",
            session_id: config.sessionId,
            step_index: stepIndex,
          }).catch(() => {});

          config.onLoopComplete(visibleSummary);
          break;
        }

        // If there's an action, process it
        if (parsed.action) {
          const action = parsed.action;
          config.onActionDecided(action);

          // Audit: action decided
          await appendAgentAuditRecord({
            event: "step_action_decided",
            session_id: config.sessionId,
            step_index: stepIndex,
            command: action.command,
            risk: action.risk,
          }).catch(() => {});

          // Evaluate policy
          const policyInput: PolicyEvaluationInput = {
            command: action.command,
            risk: action.risk,
            session_id: config.sessionId,
          };
          const policyDecision = evaluateCommandPolicy(policyInput, config.sessionId);

          if (policyDecision.status === "blocked" && config.approvalMode !== "copilot") {
            // Command blocked by policy
            config.onActionStatusChange(action.id, "blocked");

            // Audit: action blocked
            await appendAgentAuditRecord({
              event: "step_action_blocked",
              session_id: config.sessionId,
              step_index: stepIndex,
              command: action.command,
              risk: policyDecision.normalized_risk,
              reason: policyDecision.reason,
            }).catch(() => {});

            const blockedOutput = formatBlockedOutput(
              action.command,
              policyDecision.reason,
            );
            steps.push({ aiResponse: fullResponse, commandOutput: blockedOutput });
            continue;
          }

          if (policyDecision.status === "needs_strong_confirmation") {
            if (config.approvalMode === "delegate" || config.approvalMode === "copilot") {
              config.onActionStatusChange(action.id, "confirmed");

              await appendAgentAuditRecord({
                event: "step_action_confirmed",
                session_id: config.sessionId,
                step_index: stepIndex,
                command: action.command,
                risk: policyDecision.normalized_risk,
                reason: `auto_confirmed:${config.approvalMode}`,
              }).catch(() => {});
            } else {
            // Needs user confirmation
              config.onActionStatusChange(action.id, "pending");

              const confirmed = await waitForConfirmation(
                action.id,
                action,
                policyDecision,
              );
              clearConfirmation();

              if (!running) break;

              if (!confirmed) {
                // User rejected or timed out
                config.onActionStatusChange(action.id, "rejected");

                // Audit: action rejected
                await appendAgentAuditRecord({
                  event: "step_action_rejected",
                  session_id: config.sessionId,
                  step_index: stepIndex,
                  command: action.command,
                  risk: policyDecision.normalized_risk,
                }).catch(() => {});

                // Determine if it was a timeout or explicit rejection
                const rejectedOutput = formatRejectedOutput(action.command);
                steps.push({ aiResponse: fullResponse, commandOutput: rejectedOutput });
                continue;
              }

              // User confirmed
              config.onActionStatusChange(action.id, "confirmed");

              // Audit: action confirmed
              await appendAgentAuditRecord({
                event: "step_action_confirmed",
                session_id: config.sessionId,
                step_index: stepIndex,
                command: action.command,
                risk: policyDecision.normalized_risk,
              }).catch(() => {});
            }
          }

          // Execute the command
          config.onActionStatusChange(action.id, "running");

          const result = await config.executeCommand(
            action.command,
            DEFAULT_COMMAND_TIMEOUT_SEC,
          );

          if (!running) break;

          // Report result
          const status: AgentActionStatus =
            result.exitCode === 0 ? "success" : "failed";
          config.onActionStatusChange(action.id, status);
          config.onOutputReceived(action.id, result);

          // Audit: action executed
          await appendAgentAuditRecord({
            event: "step_action_executed",
            session_id: config.sessionId,
            step_index: stepIndex,
            command: action.command,
            risk: policyDecision.normalized_risk,
            result: {
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              timedOut: result.timedOut,
              stderr: result.stderr,
              stdout: result.stdout,
            },
          }).catch(() => {});

          // Add to conversation history
          const commandOutput = formatCommandOutput(action.command, result);
          steps.push({ aiResponse: fullResponse, commandOutput });
        }
      }

      // If we hit max steps without completing
      if (running && steps.length >= MAX_STEPS) {
        config.onLoopComplete(
          config.locale === "zh-CN"
            ? "已达到最大步骤数限制（20步），循环结束。"
            : "Maximum step limit reached (20 steps). Loop ended.",
        );

        await appendAgentAuditRecord({
          event: "loop_completed",
          session_id: config.sessionId,
          reason: "max_steps_reached",
        }).catch(() => {});
      }
    } catch (error: unknown) {
      if (!running) {
        // Stopped by user — not an error
        await appendAgentAuditRecord({
          event: "loop_stopped",
          session_id: config.sessionId,
        }).catch(() => {});
        return;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Check if it's an abort error
      if (
        errorMessage.includes("abort") ||
        errorMessage.includes("AbortError")
      ) {
        await appendAgentAuditRecord({
          event: "loop_stopped",
          session_id: config.sessionId,
        }).catch(() => {});
        return;
      }

      // Audit: loop error
      await appendAgentAuditRecord({
        event: "loop_error",
        session_id: config.sessionId,
        reason: errorMessage,
      }).catch(() => {});

      config.onError(errorMessage);
    } finally {
      running = false;
      abortController = null;
      clearConfirmation();
    }
  }

  // ─── Controller Methods ───────────────────────────────────────────────────

  function start(userMessage: string): void {
    if (running) return;
    runLoop(userMessage);
  }

  function stop(): void {
    if (!running) return;
    running = false;

    // Abort any in-flight AI request
    if (abortController) {
      abortController.abort();
      abortController = null;
    }

    // Resolve any pending confirmation as rejected
    if (pendingConfirmResolve) {
      pendingConfirmResolve(false);
    }
    clearConfirmation();
  }

  function confirmAction(actionId: string): void {
    if (pendingActionId === actionId && pendingConfirmResolve) {
      clearTimeout(confirmationTimer!);
      confirmationTimer = null;
      const resolve = pendingConfirmResolve;
      pendingConfirmResolve = null;
      pendingActionId = null;
      resolve(true);
    }
  }

  function rejectAction(actionId: string): void {
    if (pendingActionId === actionId && pendingConfirmResolve) {
      clearTimeout(confirmationTimer!);
      confirmationTimer = null;
      const resolve = pendingConfirmResolve;
      pendingConfirmResolve = null;
      pendingActionId = null;
      resolve(false);
    }
  }

  function isRunningFn(): boolean {
    return running;
  }

  return {
    start,
    stop,
    confirmAction,
    rejectAction,
    isRunning: isRunningFn,
  };
}
