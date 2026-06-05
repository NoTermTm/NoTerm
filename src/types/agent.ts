// === 保留的类型 ===

export type AgentRisk = "low" | "medium" | "high" | "critical";
export type AgentApprovalMode = "auto" | "delegate" | "copilot";

export type AgentPolicyStatus =
  | "allowed"
  | "blocked"
  | "needs_strong_confirmation";

export type AgentActionStatus =
  | "pending"
  | "confirmed"
  | "running"
  | "success"
  | "failed"
  | "blocked"
  | "rejected"
  | "timeout";

export interface AgentPolicyDecision {
  status: AgentPolicyStatus;
  reason: string;
  normalized_command: string;
  normalized_risk: AgentRisk;
}

export interface AgentCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
}

// === 新增类型 ===

export interface AgentStepAction {
  id: string;
  command: string;
  risk: AgentRisk;
  reason: string;
}

export interface AgentStep {
  index: number;
  thinking: string;
  action: AgentStepAction | null;
  actionStatus: AgentActionStatus | null;
  result: AgentCommandResult | null;
  policyDecision: AgentPolicyDecision | null;
}

export interface AgentSession {
  id: string;
  sessionId: string;
  userRequest: string;
  steps: AgentStep[];
  status: "running" | "completed" | "stopped" | "error";
  createdAt: number;
  completedAt?: number;
}

// === UI 渲染块类型 ===

export type AgentBlockType = "thinking" | "action" | "output" | "error" | "done" | "user" | "status";

export interface AgentBlock {
  id: string;
  type: AgentBlockType;
  content: string;
  timestamp: number;
  phase?: "analyzing_output" | "waiting_model";
  command?: string;
  risk?: AgentRisk;
  status?: "pending" | "running" | "success" | "failed" | "blocked" | "rejected";
  exitCode?: number;
  stderr?: string;
}
