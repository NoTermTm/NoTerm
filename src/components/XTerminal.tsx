import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { sshApi } from "../api/ssh";
import type { SftpEntry } from "../types/ssh";
import "@xterm/xterm/css/xterm.css";
import "./XTerminal.css";
import { AppIcon } from "./AppIcon";
import { Select } from "./Select";
import { Modal } from "./Modal";
import { ScriptPicker } from "./ScriptPicker";
import { parseAgentPlanFromText, sendAiChatStream, type AiMessage } from "../api/ai";
import AiRenderer from "./AiRenderer2";
import {
  DEFAULT_APP_SETTINGS,
  getAppSettingsStore,
  writeAppSetting,
  type TerminalThemeName,
} from "../store/appSettings";
import { getXtermTheme } from "../terminal/xtermThemes";
import {
  categorizeLogLine,
  detectSmartCommand,
  parseDockerPsOutput,
  parseLsOutput,
  sanitizeTerminalChunk,
  shellEscapeArg,
  stripSymlinkSuffix,
  type DockerPsRow,
  type LogCategory,
  type LsTableRow,
  type SmartCommandInfo,
} from "../terminal/smartTerminal";
import { appendAgentAuditRecord } from "../terminal/agentAudit";
import { evaluateAgentActionPolicy } from "../terminal/agentPolicy";
import type {
  AgentActionRuntime,
  AgentMode,
  AgentPlan,
  AgentPlanRuntime,
  AgentRisk,
  AgentPlanActivityTone,
  AgentActionStatus,
} from "../types/agent";
import { getModifierKeyAbbr, getModifierKeyLabel } from "../utils/platform";
import { toRgba } from "../utils/color";
import { loadTerminalBackgroundUrl } from "../utils/terminalBackground";
import { useI18n } from "../i18n";

interface XTerminalProps {
  sessionId: string;
  host: string;
  port: number;
  isLocal?: boolean;
  osType?: "windows" | "macos" | "linux" | "unknown";
  onConnect?: () => Promise<void>;
  onRequestSplit?: (direction: "vertical" | "horizontal") => void;
  onCloseSession?: () => void;
  isSplit?: boolean;
  onSendScript?: (content: string, scope: "current" | "all") => Promise<void> | void;
}

type ConnectionStatus = "idle" | "connecting" | "connected" | "error";
type TransferTaskDirection = "upload" | "download";
type TransferTaskStatus = "running" | "success" | "failed";
type AiChatMessage = AiMessage & {
  createdAt: number;
  id: string;
  agentPlan?: AgentPlanRuntime;
  agentPlanRaw?: AgentPlan;
};

interface TransferTask {
  id: string;
  direction: TransferTaskDirection;
  name: string;
  sourcePath: string;
  targetPath: string;
  status: TransferTaskStatus;
  progress: number;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

type SmartTableState =
  | {
      kind: "ls";
      command: string;
      rows: LsTableRow[];
      updatedAt: number;
    }
  | {
      kind: "docker-ps";
      command: string;
      rows: DockerPsRow[];
      updatedAt: number;
    };

type SmartMenuState =
  | {
      kind: "ls";
      row: LsTableRow;
      x: number;
      y: number;
    }
  | {
      kind: "docker-ps";
      row: DockerPsRow;
      x: number;
      y: number;
    };

type SmartTrackedCommand = SmartCommandInfo & {
  output: string;
  startedAt: number;
};

type LogSignal = {
  ts: number;
  category: LogCategory;
};

type LogSummaryItem = {
  id: string;
  ts: number;
  loginFailed: number;
  dbTimeout: number;
  errorCount: number;
};

type AgentStepDecision = {
  decision: "continue" | "update_plan" | "stop";
  note?: string;
  plan?: AgentPlan;
};

type SendAiMessageOptions = {
  extraSystemPrompt?: string;
};

type AgentTerminalExecutionState = {
  marker: string;
  startedAt: number;
  output: string;
  timeoutId: number;
  timeoutSec: number;
  timedOutRecovering: boolean;
  finish: (result: {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    durationMs: number;
  }) => void;
};

type TerminalHashCommand =
  | { kind: "ai"; query: string }
  | { kind: "fix"; query: string }
  | { kind: "help" }
  | { kind: "unknown"; name: string };

const parseTerminalHashCommand = (input: string): TerminalHashCommand | null => {
  const trimmed = input.trim();
  if (!trimmed.startsWith("#")) return null;
  if (trimmed === "#") return { kind: "help" };

  const match = trimmed.match(/^#([^\s]+)(?:\s+([\s\S]*))?$/);
  const commandName = (match?.[1] || "").toLowerCase();
  const query = (match?.[2] || "").trim();

  if (commandName === "ai") {
    return { kind: "ai", query };
  }
  if (commandName === "fix") {
    return { kind: "fix", query };
  }
  if (commandName === "help" || commandName === "commands" || commandName === "?") {
    return { kind: "help" };
  }
  return { kind: "unknown", name: `#${commandName}` };
};

const hasExecutableCommand = (text: string): boolean => {
  const normalized = text.trim();
  if (!normalized) return false;
  if (/```(?:bash|sh|shell)?\s*[\s\S]+```/i.test(normalized)) return true;
  return /(^|\n)\s*(?:sudo\s+)?(?:ls|pwd|cd|rm|mv|cp|find|grep|cat|chmod|chown|systemctl|journalctl|apt|yum|dnf|apk|tar|curl|wget|docker|kubectl|npm|pnpm)\b/i.test(
    normalized,
  );
};

const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const MAX_TRANSFER_TASKS = 120;
const MAX_SMART_OUTPUT_CHARS = 160_000;
const MAX_LOG_SIGNALS = 900;
const LOG_SUMMARY_WINDOW_MS = 60_000;
const MAX_LOG_SUMMARIES = 12;
const AGENT_MAX_ACTIONS = 5;
const AGENT_RESULT_SNIPPET_CHARS = 2000;
const AGENT_TERMINAL_CAPTURE_CHARS = 220_000;
const AGENT_MAX_ACTIVITY_ITEMS = 40;
const AI_SCROLL_BOTTOM_THRESHOLD = 72;
const AGENT_INTERNAL_PRINTF_PATTERN =
  /printf\s+["']\\n__CODEX_AGENT_DONE_\d+_[a-z0-9]+__(?:_RECOVER)?:%s\\n["']\s+["']\$\?["']/gi;
const AGENT_INTERNAL_MARKER_PATTERN =
  /__CODEX_AGENT_DONE_\d+_[a-z0-9]+__(?:_RECOVER)?:-?\d+/gi;

const stripAgentInternalOutput = (value: string) => {
  if (!value) return value;
  let next = value.replace(AGENT_INTERNAL_PRINTF_PATTERN, "");
  next = next.replace(AGENT_INTERNAL_MARKER_PATTERN, "");
  return next;
};

const normalizeAgentActionStatus = (
  statuses: AgentActionStatus[],
): AgentPlanRuntime["status"] => {
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "pending" || status === "approved")) {
    return "pending";
  }
  if (statuses.every((status) => status === "blocked")) return "failed";
  if (statuses.every((status) => status === "rejected" || status === "skipped")) {
    return "stopped";
  }
  return "completed";
};

const createMessageId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const createAgentActivityId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `agent-activity-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export function XTerminal({
  sessionId,
  host,
  port,
  isLocal = false,
  osType = "unknown",
  onConnect,
  onRequestSplit,
  isSplit = false,
  onSendScript,
}: XTerminalProps) {
  const { t, locale } = useI18n();
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const onConnectRef = useRef<XTerminalProps["onConnect"]>(onConnect);
  const mountedRef = useRef(true);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>("idle");
  const [connError, setConnError] = useState<string | null>(null);
  const [endpointIp, setEndpointIp] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [endpointCopied, setEndpointCopied] = useState(false);
  const endpointCopyTimerRef = useRef<number | null>(null);
  const [xtermBg, setXtermBg] = useState<string | undefined>(undefined);
  const [xtermBaseBg, setXtermBaseBg] = useState<string | undefined>(undefined);
  const [terminalBgImage, setTerminalBgImage] = useState<string>("");
  const [terminalBgOpacity, setTerminalBgOpacity] = useState<number>(
    DEFAULT_APP_SETTINGS["terminal.backgroundOpacity"],
  );
  const [terminalBgBlur, setTerminalBgBlur] = useState<number>(
    DEFAULT_APP_SETTINGS["terminal.backgroundBlur"],
  );
  const terminalBgImageRef = useRef<string>(DEFAULT_APP_SETTINGS["terminal.backgroundImage"]);
  const terminalBgObjectUrlRef = useRef<string>("");
  const themeNameRef = useRef<TerminalThemeName>(DEFAULT_APP_SETTINGS["terminal.theme"]);
  const [sftpOpen, setSftpOpen] = useState(false);
  const [sftpPath, setSftpPath] = useState("/");
  const [sftpEntries, setSftpEntries] = useState<SftpEntry[]>([]);
  const [sftpLoading, setSftpLoading] = useState(false);
  const [sftpError, setSftpError] = useState<string | null>(null);
  const [sftpDragging, setSftpDragging] = useState(false);
  const [sftpWidth, setSftpWidth] = useState(280);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [renameEntry, setRenameEntry] = useState<SftpEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [chmodEntry, setChmodEntry] = useState<SftpEntry | null>(null);
  const [chmodValue, setChmodValue] = useState("");
  const modifierKeyAbbr = getModifierKeyAbbr();
  const modifierKeyLabel = getModifierKeyLabel();
  const [sftpActionError, setSftpActionError] = useState<string | null>(null);
  const [sftpActionBusy, setSftpActionBusy] = useState(false);
  const [sftpMenu, setSftpMenu] = useState<{
    entry: SftpEntry | null;
    x: number;
    y: number;
  } | null>(null);
  const sftpMenuRef = useRef<HTMLDivElement>(null);
  const sftpDragCounterRef = useRef(0);
  const sftpPanelRef = useRef<HTMLDivElement>(null);
  const sftpPathRef = useRef(sftpPath);
  const sftpDraggingRef = useRef(false);
  const writeQueueRef = useRef<string[]>([]);
  const writingRef = useRef(false);
  const reconnectPromiseRef = useRef<Promise<boolean> | null>(null);
  const writeBlockedRef = useRef(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [scriptPickerOpen, setScriptPickerOpen] = useState(false);
  const [scriptPanelOpen, setScriptPanelOpen] = useState(false);
  const [transferPanelOpen, setTransferPanelOpen] = useState(false);
  const [transferTasks, setTransferTasks] = useState<TransferTask[]>([]);
  const [aiOpen, setAiOpen] = useState(false);
  const [scriptTarget, setScriptTarget] = useState<"current" | "all">("current");
  const [scriptText, setScriptText] = useState("");
  const [aiMessages, setAiMessages] = useState<AiChatMessage[]>([]);
  const aiMessagesRef = useRef<AiChatMessage[]>([]);
  const aiHistoryRef = useRef<HTMLDivElement>(null);
  const agentActivityListRef = useRef<HTMLDivElement>(null);
  const aiAutoStickToBottomRef = useRef(true);
  const aiStreamAbortRef = useRef<AbortController | null>(null);
  const aiAbortReasonRef = useRef<"stop" | "clear" | null>(null);
  const [aiInput, setAiInput] = useState("");
  const [terminalQuickDraft, setTerminalQuickDraft] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [forceRunDialog, setForceRunDialog] = useState<{
    messageId: string;
    blockedCount: number;
  } | null>(null);
  const [forceRunConfirmInput, setForceRunConfirmInput] = useState("");
  const [forceRunConfirmError, setForceRunConfirmError] = useState<string | null>(null);
  const [aiWidth, setAiWidth] = useState(380);
  const [aiModel, setAiModel] = useState<string>("");
  const [aiModelOptions, setAiModelOptions] = useState<string[]>([]);
  const [agentMode, setAgentMode] = useState<AgentMode>(
    DEFAULT_APP_SETTINGS["ai.agentMode"],
  );
  const planStopRequestedRef = useRef<Record<string, boolean>>({});
  const planExecutionLockRef = useRef<Record<string, boolean>>({});
  const aiModelTouchedRef = useRef(false);
  const [aiModelMenuOpen, setAiModelMenuOpen] = useState(false);
  const aiModelMenuRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState<{
    type: "sftp" | "ai";
    startX: number;
    startWidth: number;
  } | null>(null);
  const [terminalIssue, setTerminalIssue] = useState<{
    message: string;
    timestamp: number;
  } | null>(null);
  const terminalIssueRef = useRef<{
    message: string;
    timestamp: number;
  } | null>(null);
  const terminalLogRef = useRef<
    Array<{ time: string; level: "info" | "warn" | "error"; message: string }>
  >([]);
  const lastOutputAtRef = useRef<number>(0);
  const lastInputAtRef = useRef<number>(0);
  const [termMenu, setTermMenu] = useState<{ x: number; y: number } | null>(null);
  const termMenuRef = useRef<HTMLDivElement>(null);
  const [smartTable, setSmartTable] = useState<SmartTableState | null>(null);
  const [smartMenu, setSmartMenu] = useState<SmartMenuState | null>(null);
  const smartMenuRef = useRef<HTMLDivElement>(null);
  const [logSummaries, setLogSummaries] = useState<LogSummaryItem[]>([]);
  const inputCommandBufferRef = useRef("");
  const inputEscapeModeRef = useRef(false);
  const terminalQuickDraftRef = useRef("");
  const agentTerminalExecutionRef = useRef<AgentTerminalExecutionState | null>(null);
  const trackedCommandRef = useRef<SmartTrackedCommand | null>(null);
  const logSignalsRef = useRef<LogSignal[]>([]);
  const logSummaryTimerRef = useRef<number | null>(null);
  const autoCopyRef = useRef<boolean>(DEFAULT_APP_SETTINGS["terminal.autoCopy"]);
  const lastSelectionRef = useRef<string>("");
  const lastCopyAtRef = useRef<number>(0);
  const modelOptions =
    aiModelOptions.length > 0 ? aiModelOptions : aiModel ? [aiModel] : [];
  const modelOptionsWithCurrent =
    aiModel && !modelOptions.includes(aiModel)
      ? [aiModel, ...modelOptions]
      : modelOptions;
  const aiHistoryKey = `ai.history.${sessionId}`;
  const aiHistoryLoadedRef = useRef(false);
  const transferStatusLabel = (status: TransferTaskStatus) =>
    t(`terminal.transfer.status.${status}`);
  const transferDirectionLabel = (direction: TransferTaskDirection) =>
    t(`terminal.transfer.direction.${direction}`);
  const hasAiInsights = !!smartTable || logSummaries.length > 0;
  const latestAgentPlanForActivity = useMemo(() => {
    for (let i = aiMessages.length - 1; i >= 0; i -= 1) {
      const message = aiMessages[i];
      if (message?.agentPlan) {
        return message.agentPlan;
      }
    }
    return null;
  }, [aiMessages]);
  const latestAgentActivityKey = useMemo(() => {
    const list = latestAgentPlanForActivity?.activities || [];
    if (list.length === 0) return "empty";
    const tail = list[list.length - 1];
    return `${list.length}-${tail.id}-${tail.ts}`;
  }, [latestAgentPlanForActivity]);
  const terminalQuickCommands = useMemo(
    () => [
      {
        id: "ai",
        syntax: "#ai <question>",
        insertText: "#ai ",
        description: t("terminal.ai.quick.command.ai"),
      },
      {
        id: "fix",
        syntax: "#fix <issue>",
        insertText: "#fix ",
        description: t("terminal.ai.quick.command.fix"),
      },
      {
        id: "help",
        syntax: "#help",
        insertText: "#help",
        description: t("terminal.ai.quick.command.help"),
      },
    ],
    [t],
  );
  const shouldShowQuickOverlay = useMemo(() => {
    const draft = terminalQuickDraft.trim();
    if (!draft.startsWith("#")) return false;
    if (draft === "#") return true;
    const parsed = parseTerminalHashCommand(draft);
    if (!parsed) return false;
    return parsed.kind === "unknown";
  }, [terminalQuickDraft]);

  const setTerminalQuickDraftState = (value: string) => {
    if (terminalQuickDraftRef.current === value) return;
    terminalQuickDraftRef.current = value;
    setTerminalQuickDraft(value);
  };

  const syncTerminalQuickDraftFromBuffer = (buffer: string) => {
    const normalized = buffer.trimStart();
    const nextDraft = normalized.startsWith("#") ? normalized.slice(0, 160) : "";
    setTerminalQuickDraftState(nextDraft);
  };

  const scheduleLogSummaryUpdate = () => {
    if (logSummaryTimerRef.current) return;
    logSummaryTimerRef.current = window.setTimeout(() => {
      logSummaryTimerRef.current = null;
      const now = Date.now();
      const windowStart = now - LOG_SUMMARY_WINDOW_MS;
      const recentSignals = logSignalsRef.current.filter((item) => item.ts >= windowStart);
      logSignalsRef.current = logSignalsRef.current.filter(
        (item) => item.ts >= now - LOG_SUMMARY_WINDOW_MS * 5,
      );
      if (recentSignals.length === 0) return;

      const loginFailed = recentSignals.filter(
        (item) => item.category === "login_failed",
      ).length;
      const dbTimeout = recentSignals.filter(
        (item) => item.category === "db_timeout",
      ).length;
      const errorCount = recentSignals.filter((item) => item.category === "error").length;
      if (loginFailed === 0 && dbTimeout === 0 && errorCount === 0) return;

      setLogSummaries((prev) => {
        const last = prev[prev.length - 1];
        if (
          last &&
          last.loginFailed === loginFailed &&
          last.dbTimeout === dbTimeout &&
          last.errorCount === errorCount
        ) {
          return prev;
        }
        const next = [
          ...prev,
          {
            id: createMessageId(),
            ts: now,
            loginFailed,
            dbTimeout,
            errorCount,
          },
        ];
        if (next.length > MAX_LOG_SUMMARIES) {
          next.splice(0, next.length - MAX_LOG_SUMMARIES);
        }
        return next;
      });
      setAiOpen(true);
    }, 1000);
  };

  const consumeTailOutput = (cleanChunk: string) => {
    const signals: LogSignal[] = [];
    const lines = cleanChunk.split(/\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const category = categorizeLogLine(line);
      if (!category) continue;
      signals.push({ ts: Date.now(), category });
    }
    if (signals.length === 0) return;
    logSignalsRef.current = [...logSignalsRef.current, ...signals];
    if (logSignalsRef.current.length > MAX_LOG_SIGNALS) {
      logSignalsRef.current.splice(0, logSignalsRef.current.length - MAX_LOG_SIGNALS);
    }
    scheduleLogSummaryUpdate();
  };

  const beginSmartTracking = (tracking: SmartCommandInfo | null) => {
    if (!tracking) {
      trackedCommandRef.current = null;
      setSmartMenu(null);
      setSmartTable(null);
      return;
    }
    trackedCommandRef.current = {
      ...tracking,
      output: "",
      startedAt: Date.now(),
    };
    setSmartMenu(null);
    setSmartTable(null);

    if (tracking.kind === "tail-follow") {
      logSignalsRef.current = [];
      setLogSummaries([]);
      return;
    }
  };

  const consumeTerminalInput = (data: string) => {
    for (const ch of data) {
      if (inputEscapeModeRef.current) {
        if (/[A-Za-z~]/.test(ch)) {
          inputEscapeModeRef.current = false;
        }
        continue;
      }

      if (ch === "\u001b") {
        inputEscapeModeRef.current = true;
        continue;
      }

      if (ch === "\r") {
        const command = inputCommandBufferRef.current.trim();
        inputCommandBufferRef.current = "";
        setTerminalQuickDraftState("");
        if (command.startsWith("#")) {
          void handleTerminalHashCommand(command);
        }
        beginSmartTracking(command ? detectSmartCommand(command) : null);
        continue;
      }

      if (ch === "\u0003") {
        // Ctrl+C typically interrupts follow-mode commands.
        inputCommandBufferRef.current = "";
        setTerminalQuickDraftState("");
        trackedCommandRef.current = null;
        continue;
      }

      if (ch === "\u0015") {
        // Ctrl+U clears current shell line.
        inputCommandBufferRef.current = "";
        setTerminalQuickDraftState("");
        continue;
      }

      if (ch === "\u007f" || ch === "\b") {
        inputCommandBufferRef.current = inputCommandBufferRef.current.slice(0, -1);
        syncTerminalQuickDraftFromBuffer(inputCommandBufferRef.current);
        continue;
      }

      if (ch < " " || ch === "\t" || ch === "\n") continue;

      inputCommandBufferRef.current += ch;
      if (inputCommandBufferRef.current.length > 320) {
        inputCommandBufferRef.current = inputCommandBufferRef.current.slice(-320);
      }
      syncTerminalQuickDraftFromBuffer(inputCommandBufferRef.current);
    }
  };

  const consumeSmartOutput = (chunk: string) => {
    const tracking = trackedCommandRef.current;
    if (!tracking) return;

    const cleanChunk = sanitizeTerminalChunk(chunk);
    if (!cleanChunk) return;

    if (tracking.kind === "tail-follow") {
      consumeTailOutput(cleanChunk);
      return;
    }

    tracking.output = (tracking.output + cleanChunk).slice(-MAX_SMART_OUTPUT_CHARS);

    if (tracking.kind === "ls") {
      const rows = parseLsOutput(tracking.output);
      if (!rows.length) return;
      setSmartTable({
        kind: "ls",
        command: tracking.command,
        rows,
        updatedAt: Date.now(),
      });
      setAiOpen(true);
      return;
    }

    const rows = parseDockerPsOutput(tracking.output);
    if (!rows.length) return;
    setSmartTable({
      kind: "docker-ps",
      command: tracking.command,
      rows,
      updatedAt: Date.now(),
    });
    setAiOpen(true);
  };

  const finalizeAgentTerminalExecution = (
    state: AgentTerminalExecutionState,
    payload: {
      exitCode: number;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    },
  ) => {
    if (agentTerminalExecutionRef.current !== state) return;
    window.clearTimeout(state.timeoutId);
    agentTerminalExecutionRef.current = null;
    state.finish({
      ...payload,
      durationMs: Date.now() - state.startedAt,
    });
  };

  const consumeAgentTerminalOutput = (chunk: string) => {
    const state = agentTerminalExecutionRef.current;
    if (!state) return;

    const cleanChunk = sanitizeTerminalChunk(chunk);
    if (!cleanChunk) return;

    state.output = (state.output + cleanChunk).slice(-AGENT_TERMINAL_CAPTURE_CHARS);
    const markerMatch = state.output.match(
      new RegExp(`${escapeForRegExp(state.marker)}:(-?\\d+)`),
    );
    if (!markerMatch || markerMatch.index === undefined) return;

    const stdout = stripAgentInternalOutput(
      state.output.slice(0, markerMatch.index).trimEnd(),
    ).trimEnd();
    const exitCode = Number(markerMatch[1] || "-1");
    const stderr =
      exitCode === 0 ? "" : `exit code ${exitCode} (details are in terminal output)`;
    finalizeAgentTerminalExecution(state, {
      exitCode,
      stdout,
      stderr,
      timedOut: false,
    });
  };

  const executeAgentActionInTerminal = async (
    command: string,
    timeoutSec: number,
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    durationMs: number;
  }> => {
    if (agentTerminalExecutionRef.current) {
      throw new Error("Agent command is already running in terminal");
    }

    const safeTimeoutSec = Math.max(3, Math.min(300, Math.round(timeoutSec || 30)));
    const marker = `__CODEX_AGENT_DONE_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
    return await new Promise((resolve) => {
      const startedAt = Date.now();
      const state: AgentTerminalExecutionState = {
        marker,
        startedAt,
        output: "",
        timeoutSec: safeTimeoutSec,
        timedOutRecovering: false,
        timeoutId: 0,
        finish: resolve,
      };
      state.timeoutId = window.setTimeout(() => {
        if (agentTerminalExecutionRef.current !== state) return;
        if (!state.timedOutRecovering) {
          state.timedOutRecovering = true;
          // One quick recovery probe: sometimes command already finished but marker line was missed.
          const recoveryMarker = `${marker}_RECOVER`;
          state.marker = recoveryMarker;
          enqueueTerminalWrite(`\nprintf "\\n${recoveryMarker}:%s\\n" "$?"\n`);
          state.timeoutId = window.setTimeout(() => {
            finalizeAgentTerminalExecution(state, {
              exitCode: -1,
              stdout: stripAgentInternalOutput(state.output.trimEnd()).trimEnd(),
              stderr: "Command timed out",
              timedOut: true,
            });
          }, 1800);
          return;
        }
        finalizeAgentTerminalExecution(state, {
          exitCode: -1,
          stdout: stripAgentInternalOutput(state.output.trimEnd()).trimEnd(),
          stderr: "Command timed out",
          timedOut: true,
        });
      }, safeTimeoutSec * 1000);
      agentTerminalExecutionRef.current = state;
      // Execute in current PTY, then emit a marker line containing previous command exit code.
      enqueueTerminalWrite(
        `${command}\nprintf "\\n${marker}:%s\\n" "$?"\n`,
      );
      pushTerminalLog("info", `agent command enqueued marker=${marker}`);
    });
  };

  const writeToShell = (data: string) => {
    if (isLocal) {
      return sshApi.localWriteToShell(sessionId, data);
    }
    return sshApi.writeToShell(sessionId, data);
  };

  useEffect(() => {
    terminalIssueRef.current = terminalIssue;
  }, [terminalIssue]);

  useEffect(() => {
    sftpPathRef.current = sftpPath;
  }, [sftpPath]);

  useEffect(() => {
    sftpDraggingRef.current = sftpDragging;
  }, [sftpDragging]);

  useEffect(
    () => () => {
      if (logSummaryTimerRef.current) {
        window.clearTimeout(logSummaryTimerRef.current);
      }
    },
    [],
  );

  const pushTerminalLog = (
    level: "info" | "warn" | "error",
    message: string,
  ) => {
    const time = new Date().toISOString();
    const next = [...terminalLogRef.current, { time, level, message }];
    if (next.length > 160) {
      next.splice(0, next.length - 160);
    }
    terminalLogRef.current = next;
  };

  const copyTerminalLog = async () => {
    const header = `session=${sessionId} local=${isLocal} conn=${connStatus} sftp=${sftpOpen} ai=${aiOpen} lastInput=${lastInputAtRef.current} lastOutput=${lastOutputAtRef.current}`;
    const lines = terminalLogRef.current.map(
      (item) => `${item.time} [${item.level}] ${item.message}`,
    );
    await clipboardWrite([header, ...lines].join("\n"));
  };

  const startReconnectFlow = () => {
    if (isLocal) return;
    if (reconnectPromiseRef.current) return;
    writeBlockedRef.current = true;
    reconnectPromiseRef.current = (async () => {
      let ok = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          pushTerminalLog("info", `reconnect attempt ${attempt}`);
          await connectNow();
          const connected = await sshApi.isConnected(sessionId);
          if (connected) {
            ok = true;
            pushTerminalLog("info", "reconnect ok");
            break;
          }
        } catch (error) {
          pushTerminalLog("warn", `reconnect error: ${formatError(error)}`);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 300 * attempt));
      }
      if (!ok) {
        pushTerminalLog("warn", "reconnect failed");
      }
      return ok;
    })().finally(() => {
      writeBlockedRef.current = false;
      reconnectPromiseRef.current = null;
    });
    reconnectPromiseRef.current
      .then((ok) => {
        if (ok) {
          void flushWriteQueue();
        } else {
          setConnStatus("error");
          setConnError(t("terminal.session.disconnected"));
        }
      })
      .catch(() => {
        // ignore
      });
  };

  const writeToShellWithTimeout = async (data: string) => {
    const startedAt = Date.now();
    pushTerminalLog("info", `input bytes=${data.length}`);
    let timeoutId: number | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error("write_timeout"));
        }, 4000);
        pushTerminalLog("info", "write attempt 1");
        writeToShell(data)
          .then(() => resolve())
          .catch((err) => reject(err));
      });
      pushTerminalLog("info", `write ok ${Date.now() - startedAt}ms`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const detail =
        message === "write_timeout"
          ? t("terminal.write.timeout")
          : t("terminal.write.fail");
      pushTerminalLog("error", `${detail} (${Date.now() - startedAt}ms) err=${message}`);
      if (!terminalIssueRef.current) {
        setTerminalIssue({
          message: t("terminal.write.issue", { detail }),
          timestamp: Date.now(),
        });
      }
      if (!isLocal) {
        startReconnectFlow();
      }
      return false;
    } finally {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    }
  };

  const flushWriteQueue = async () => {
    if (writingRef.current) return;
    if (writeBlockedRef.current) return;
    writingRef.current = true;
    try {
      while (writeQueueRef.current.length > 0) {
        const batch = writeQueueRef.current.join("");
        writeQueueRef.current = [];
        const ok = await writeToShellWithTimeout(batch);
        if (!ok) {
          writeQueueRef.current = [batch, ...writeQueueRef.current];
          break;
        }
      }
    } finally {
      writingRef.current = false;
    }
  };

  const enqueueTerminalWrite = (data: string) => {
    writeQueueRef.current.push(data);
    void flushWriteQueue();
  };

  const resizePty = (cols: number, rows: number) => {
    if (isLocal) {
      return sshApi.localResizePty(sessionId, cols, rows);
    }
    return sshApi.resizePty(sessionId, cols, rows);
  };

  const disconnectShell = () => {
    if (isLocal) {
      return sshApi.localDisconnect(sessionId);
    }
    return sshApi.disconnect(sessionId);
  };

  const clipboardWrite = async (text: string) => {
    if (!text) return;
    try {
      await invoke("clipboard_write_text", { text });
      return;
    } catch {
      // fallback to Web API
    }
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fallback for restricted clipboard environments.
    }

    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      // ignore
    } finally {
      document.body.removeChild(ta);
    }
  };

  const clipboardRead = async () => {
    try {
      const text = await invoke<string>("clipboard_read_text");
      if (typeof text === "string") return text;
    } catch {
      // fallback to Web API
    }

    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  };

  const handleCopyEndpoint = async () => {
    if (!endpointCopyText) return;
    await clipboardWrite(endpointCopyText);
    setEndpointCopied(true);
    window.dispatchEvent(
      new CustomEvent("app-message", {
        detail: {
          title: t("terminal.toolbar.endpoint.toast.title"),
          detail: t("terminal.toolbar.endpoint.toast.detail", {
            ip: endpointCopyText,
          }),
          tone: "success",
          toast: true,
          toastDuration: 1800,
          store: false,
        },
      }),
    );
    if (endpointCopyTimerRef.current) {
      window.clearTimeout(endpointCopyTimerRef.current);
    }
    endpointCopyTimerRef.current = window.setTimeout(() => {
      setEndpointCopied(false);
    }, 1200);
  };

  const readAiSettings = async () => {
    const store = await getAppSettingsStore();
    return {
      enabled:
        (await store.get<boolean>("ai.enabled")) ??
        DEFAULT_APP_SETTINGS["ai.enabled"],
      provider:
        (await store.get<"openai" | "anthropic">("ai.provider")) ??
        DEFAULT_APP_SETTINGS["ai.provider"],
      model:
        (await store.get<string>("ai.model")) ??
        DEFAULT_APP_SETTINGS["ai.model"],
      models:
        (await store.get<string[]>("ai.models")) ??
        DEFAULT_APP_SETTINGS["ai.models"],
      agentMode:
        (await store.get<AgentMode>("ai.agentMode")) ??
        DEFAULT_APP_SETTINGS["ai.agentMode"],
      openai: {
        baseUrl:
          (await store.get<string>("ai.openai.baseUrl")) ??
          DEFAULT_APP_SETTINGS["ai.openai.baseUrl"],
        apiKey:
          (await store.get<string>("ai.openai.apiKey")) ??
          DEFAULT_APP_SETTINGS["ai.openai.apiKey"],
      },
      anthropic: {
        baseUrl:
          (await store.get<string>("ai.anthropic.baseUrl")) ??
          DEFAULT_APP_SETTINGS["ai.anthropic.baseUrl"],
        apiKey:
          (await store.get<string>("ai.anthropic.apiKey")) ??
          DEFAULT_APP_SETTINGS["ai.anthropic.apiKey"],
      },
    };
  };

  const syncAiSettings = async () => {
    const settings = await readAiSettings();
    setAgentMode(settings.agentMode || DEFAULT_APP_SETTINGS["ai.agentMode"]);
    setAiModelOptions(settings.models ?? []);
    if (!aiModelTouchedRef.current) {
      setAiModel(settings.model);
    }
    return settings;
  };

  useEffect(() => {
    onConnectRef.current = onConnect;
  }, [onConnect]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      aiStreamAbortRef.current?.abort();
      aiStreamAbortRef.current = null;
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    aiMessagesRef.current = aiMessages;
  }, [aiMessages]);

  const updateAiAutoStickFlag = () => {
    const el = aiHistoryRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    aiAutoStickToBottomRef.current = distanceToBottom <= AI_SCROLL_BOTTOM_THRESHOLD;
  };

  const scrollAiToBottom = (force = false) => {
    const el = aiHistoryRef.current;
    if (!el) return;
    if (!force && !aiAutoStickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    aiAutoStickToBottomRef.current = true;
  };

  useEffect(() => {
    if (!aiOpen) return;
    const handle = requestAnimationFrame(() => {
      scrollAiToBottom(true);
    });
    return () => cancelAnimationFrame(handle);
  }, [aiOpen]);

  useEffect(() => {
    if (!aiOpen) return;
    const handle = requestAnimationFrame(() => {
      scrollAiToBottom();
    });
    return () => cancelAnimationFrame(handle);
  }, [aiMessages, aiOpen]);

  useEffect(() => {
    if (!aiOpen) return;
    const el = agentActivityListRef.current;
    if (!el) return;
    const handle = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(handle);
  }, [aiOpen, latestAgentActivityKey]);

  useEffect(() => {
    let disposed = false;
    const loadHistory = async () => {
      try {
        const store = await getAppSettingsStore();
        const raw = await store.get<
          Array<AiMessage & { createdAt?: number; id?: string }>
        >(aiHistoryKey);
        if (!disposed && Array.isArray(raw) && raw.length > 0) {
          const normalized = raw
            .filter((item) => item && typeof item.content === "string" && item.role)
            .map((item) => ({
              role: item.role,
              content: item.content,
              createdAt: item.createdAt ?? Date.now(),
              id: item.id ?? createMessageId(),
            }));
          setAiMessages(normalized);
        }
      } finally {
        aiHistoryLoadedRef.current = true;
      }
    };

    void loadHistory();
    return () => {
      disposed = true;
    };
  }, [aiHistoryKey]);

  useEffect(() => {
    if (!aiHistoryLoadedRef.current) return;
    const persist = async () => {
      const store = await getAppSettingsStore();
      await store.set(aiHistoryKey, aiMessages);
    };
    void persist();
  }, [aiHistoryKey, aiMessages]);

  const normalizeBackendErrorMessage = (message: string) => {
    const text = message.trim();
    if (!text) return text;
    const lower = text.toLowerCase();
    if (
      lower.includes("would block") ||
      lower.includes("would blok") ||
      lower.includes("wouldblok")
    ) {
      return "SSH 会话当前忙碌（would block），请稍后重试";
    }
    if (lower.includes("resource temporarily unavailable")) {
      return "资源暂时不可用，请稍后重试";
    }
    return text;
  };

  const formatError = (error: unknown) => {
    if (typeof error === "string") return normalizeBackendErrorMessage(error);
    if (error instanceof Error) return normalizeBackendErrorMessage(error.message);
    try {
      return normalizeBackendErrorMessage(JSON.stringify(error));
    } catch {
      return normalizeBackendErrorMessage(String(error));
    }
  };

  const isAbortError = (error: unknown) => {
    if (!error) return false;
    if (error instanceof DOMException && error.name === "AbortError") return true;
    if (error instanceof Error && error.name === "AbortError") return true;
    return String(error).toLowerCase().includes("abort");
  };

  const interruptAiConversation = () => {
    if (!aiStreamAbortRef.current) return;
    aiAbortReasonRef.current = "stop";
    aiStreamAbortRef.current.abort();
    setAiBusy(false);
  };

  const clearAiConversationContext = () => {
    if (aiStreamAbortRef.current) {
      aiAbortReasonRef.current = "clear";
      aiStreamAbortRef.current.abort();
    }
    setAiBusy(false);
    setAiMessages([]);
    setAiError(null);
    setAiInput("");
  };

  const formatTransferTime = (value: number) =>
    new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(value));

  const formatAgentActivityTime = (value: number) =>
    new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  const createTransferTask = (
    direction: TransferTaskDirection,
    name: string,
    sourcePath: string,
    targetPath: string,
  ) => {
    const id = crypto.randomUUID();
    const next: TransferTask = {
      id,
      direction,
      name,
      sourcePath,
      targetPath,
      status: "running",
      progress: 35,
      startedAt: Date.now(),
    };
    setTransferTasks((prev) => [next, ...prev].slice(0, MAX_TRANSFER_TASKS));
    return id;
  };

  const updateTransferTask = (id: string, patch: Partial<TransferTask>) => {
    setTransferTasks((prev) =>
      prev.map((task) => (task.id === id ? { ...task, ...patch } : task)),
    );
  };

  const clearTransferHistory = () => {
    setTransferTasks((prev) => prev.filter((task) => task.status === "running"));
  };

  const runningTransferCount = useMemo(
    () => transferTasks.filter((task) => task.status === "running").length,
    [transferTasks],
  );

  const failedTransferCount = useMemo(
    () => transferTasks.filter((task) => task.status === "failed").length,
    [transferTasks],
  );

  const openScriptPanel = () => {
    setTransferPanelOpen(false);
    setScriptPanelOpen(true);
  };

  const toggleScriptPanel = () => {
    if (scriptPanelOpen) {
      setScriptPanelOpen(false);
      return;
    }
    setTransferPanelOpen(false);
    setScriptPanelOpen(true);
  };

  const toggleTransferPanel = () => {
    if (transferPanelOpen) {
      setTransferPanelOpen(false);
      return;
    }
    setScriptPanelOpen(false);
    setTransferPanelOpen(true);
  };

  const endpointLabel = useMemo(() => {
    if (!endpointIp) return "--";
    return endpointIp;
  }, [endpointIp]);
  const endpointCopyText = useMemo(() => {
    if (!endpointIp) return "";
    if (endpointIp === t("terminal.endpoint.local")) return "";
    return endpointIp;
  }, [endpointIp, t]);
  const endpointCopyLabel = endpointCopied
    ? t("terminal.toolbar.endpoint.copied")
    : t("terminal.toolbar.endpoint.copy");

  const latencyTone = useMemo(() => {
    if (latencyMs === null) return "unknown";
    if (latencyMs < 120) return "ok";
    if (latencyMs < 250) return "warn";
    return "bad";
  }, [latencyMs]);

  const connectNow = async () => {
    const doConnect = onConnectRef.current;
    if (!doConnect) return;

    setConnStatus("connecting");
    setConnError(null);

    // Best-effort reset before reconnect.
    await disconnectShell().catch(() => {});

    try {
      await doConnect();
      if (!mountedRef.current) return;
      setConnStatus("connected");
    } catch (error) {
      if (!mountedRef.current) return;
      const message = formatError(error);
      setConnStatus("error");
      setConnError(message);
    }
  };

  const recoverSessionAfterUnlock = async () => {
    setConnStatus("connecting");
    setConnError(null);
    try {
      if (isLocal) {
        await sshApi.localOpenShell(sessionId);
        if (!mountedRef.current) return;
        setConnStatus("connected");
        return;
      }

      const connected = await sshApi.isConnected(sessionId).catch(() => false);
      if (connected) {
        try {
          await sshApi.openShell(sessionId);
          if (!mountedRef.current) return;
          setConnStatus("connected");
          return;
        } catch (error) {
          pushTerminalLog(
            "warn",
            `open shell after unlock failed: ${formatError(error)}`,
          );
        }
      }

      await connectNow();
    } catch (error) {
      if (!mountedRef.current) return;
      const message = formatError(error);
      setConnStatus("error");
      setConnError(message);
    }
  };

  const loadSftpEntries = async (path = sftpPath) => {
    setSftpLoading(true);
    setSftpError(null);
    try {
      const timeoutMs = 5000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        window.setTimeout(
          () => reject(new Error(t("terminal.sftp.timeout"))),
          timeoutMs,
        );
      });
      const entries = (await Promise.race([
        sshApi.listSftpDir(sessionId, path),
        timeoutPromise,
      ])) as SftpEntry[];
      setSftpEntries(entries);
      setSftpPath(path); // 更新当前路径
    } catch (error) {
      const message = formatError(error);
      setSftpError(message);
    } finally {
      setSftpLoading(false);
    }
  };

  const buildRemotePath = (name: string) => {
    const base = sftpPath || "/";
    return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
  };

  const formatPermValue = (perm?: number, isDir?: boolean) => {
    if (typeof perm === "number") {
      return (perm & 0o7777).toString(8);
    }
    return isDir ? "755" : "644";
  };

  const openRename = (entry: SftpEntry) => {
    if (entry.name === "..") return;
    setRenameEntry(entry);
    setRenameValue(entry.name);
    setSftpActionError(null);
  };

  const openChmod = (entry: SftpEntry) => {
    if (entry.name === "..") return;
    setChmodEntry(entry);
    setChmodValue(formatPermValue(entry.perm, entry.is_dir));
    setSftpActionError(null);
  };

  const handleRenameSubmit = async () => {
    if (!renameEntry) return;
    const nextName = renameValue.trim();
    if (!nextName) {
      setSftpActionError(t("terminal.sftp.rename.empty"));
      return;
    }
    if (nextName.includes("/")) {
      setSftpActionError(t("terminal.sftp.rename.invalid"));
      return;
    }

    const fromPath = buildRemotePath(renameEntry.name);
    const toPath = buildRemotePath(nextName);

    setSftpActionBusy(true);
    setSftpActionError(null);
    try {
      await sshApi.renameSftpEntry(sessionId, fromPath, toPath);
      setRenameEntry(null);
      await loadSftpEntries();
    } catch (error) {
      setSftpActionError(formatError(error));
    } finally {
      setSftpActionBusy(false);
    }
  };

  const handleChmodSubmit = async () => {
    if (!chmodEntry) return;
    const value = chmodValue.trim();
    if (!/^[0-7]{3,4}$/.test(value)) {
      setSftpActionError(t("terminal.sftp.chmod.invalid"));
      return;
    }

    const mode = parseInt(value, 8);
    const path = buildRemotePath(chmodEntry.name);

    setSftpActionBusy(true);
    setSftpActionError(null);
    try {
      await sshApi.chmodSftpEntry(sessionId, path, mode);
      setChmodEntry(null);
      await loadSftpEntries();
    } catch (error) {
      setSftpActionError(formatError(error));
    } finally {
      setSftpActionBusy(false);
    }
  };

  const handleDeleteEntry = async (entry: SftpEntry) => {
    if (entry.name === "..") return;
    const path = buildRemotePath(entry.name);
    const label = entry.is_dir
      ? t("terminal.sftp.entry.folder")
      : t("terminal.sftp.entry.file");
    const ok = window.confirm(
      t("terminal.sftp.delete.confirm", { label, name: entry.name }),
    );
    if (!ok) return;

    setSftpActionBusy(true);
    setSftpActionError(null);
    try {
      await sshApi.deleteSftpEntry(sessionId, path, entry.is_dir);
      await loadSftpEntries();
    } catch (error) {
      setSftpActionError(formatError(error));
    } finally {
      setSftpActionBusy(false);
    }
  };

  const handleNewFolderSubmit = async () => {
    const name = newFolderName.trim();
    if (!name) {
      setSftpActionError(t("terminal.sftp.newFolder.empty"));
      return;
    }
    if (name.includes("/")) {
      setSftpActionError(t("terminal.sftp.rename.invalid"));
      return;
    }

    const path = buildRemotePath(name);
    setSftpActionBusy(true);
    setSftpActionError(null);
    try {
      await sshApi.mkdirSftpEntry(sessionId, path);
      setNewFolderOpen(false);
      setNewFolderName("");
      await loadSftpEntries();
    } catch (error) {
      setSftpActionError(formatError(error));
    } finally {
      setSftpActionBusy(false);
    }
  };

  useEffect(() => {
    if (!sftpMenu) return;

    const closeMenu = () => setSftpMenu(null);
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (sftpMenuRef.current && target && sftpMenuRef.current.contains(target)) {
        return;
      }
      closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("contextmenu", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("contextmenu", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [sftpMenu]);

  useEffect(() => {
    if (!sftpOpen) {
      sftpDragCounterRef.current = 0;
      setSftpDragging(false);
      return;
    }

    let active = true;
    let unlistenDrop: (() => void) | null = null;
    let unlistenHover: (() => void) | null = null;
    let unlistenCancel: (() => void) | null = null;

    const withinSftpPanel = (position?: { x: number; y: number }) => {
      const panel = sftpPanelRef.current;
      if (!panel || !position) return false;
      const rect = panel.getBoundingClientRect();
      return (
        position.x >= rect.left &&
        position.x <= rect.right &&
        position.y >= rect.top &&
        position.y <= rect.bottom
      );
    };

    const resetDragging = () => {
      sftpDragCounterRef.current = 0;
      setSftpDragging(false);
    };

    const register = async () => {
      unlistenHover = await listen("tauri://file-drop-hover", (event) => {
        if (!active) return;
        const payload = event.payload as { position?: { x: number; y: number } } | null;
        if (withinSftpPanel(payload?.position)) {
          setSftpDragging(true);
        } else {
          setSftpDragging(false);
        }
      });

      unlistenCancel = await listen("tauri://file-drop-cancelled", () => {
        if (!active) return;
        resetDragging();
      });

      unlistenDrop = await listen("tauri://file-drop", (event) => {
        if (!active) return;
        const payload = event.payload as
          | { paths?: string[]; position?: { x: number; y: number } }
          | null;
        const inside =
          payload?.position ? withinSftpPanel(payload.position) : sftpDraggingRef.current;
        resetDragging();
        if (!inside) return;
        const paths = Array.isArray(payload?.paths) ? payload?.paths : [];
        if (!paths.length) return;
        if (uploadProgress) {
          setSftpError(t("terminal.sftp.upload.inProgress"));
          return;
        }
        void handleUploadFiles(paths);
      });
    };

    void register();
    return () => {
      active = false;
      if (unlistenDrop) unlistenDrop();
      if (unlistenHover) unlistenHover();
      if (unlistenCancel) unlistenCancel();
    };
  }, [sftpOpen, uploadProgress, t]);

  const handleEntryClick = (entry: SftpEntry) => {
    if (!entry.is_dir) return; // 只处理文件夹点击

    // 构建新路径
    let newPath: string;
    const currentPath = sftpPath || "/";

    if (entry.name === "..") {
      // 返回上一级
      const parts = currentPath.split("/").filter(p => p);
      if (parts.length > 0) {
        parts.pop();
        newPath = parts.length > 0 ? "/" + parts.join("/") : "/";
      } else {
        newPath = "/";
      }
    } else {
      // 进入子目录 - 规范化路径拼接
      if (currentPath === "/" || currentPath === "") {
        newPath = "/" + entry.name;
      } else {
        newPath = currentPath.endsWith("/")
          ? currentPath + entry.name
          : currentPath + "/" + entry.name;
      }
    }

    void loadSftpEntries(newPath);
  };

  const openSftpMenu = (
    event: { preventDefault: () => void; stopPropagation: () => void; clientX: number; clientY: number },
    entry?: SftpEntry | null,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (entry?.name === "..") return;
    setSftpMenu({
      entry: entry ?? null,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const isSftpItemTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    return !!target.closest(".xterminal-sftp-item");
  };

  const clamp = (value: number, min: number, max: number) => {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  };

  useEffect(() => {
    if (!resizing) return;
    const onMove = (event: PointerEvent) => {
      const delta = resizing.startX - event.clientX;
      const paneWidth = paneRef.current?.clientWidth ?? 0;
      const otherWidth =
        (resizing.type === "sftp" || !sftpOpen ? 0 : sftpWidth) +
        (resizing.type === "ai" || !aiOpen ? 0 : aiWidth);
      const minWidth =
        resizing.type === "sftp"
          ? 220
          : 260;
      const maxWidth = paneWidth
        ? Math.max(minWidth, paneWidth - otherWidth - 240)
        : minWidth + 320;
      const next = clamp(resizing.startWidth + delta, minWidth, maxWidth);
      if (resizing.type === "sftp") {
        setSftpWidth(next);
      } else {
        setAiWidth(next);
      }
    };
    const onUp = () => setResizing(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [resizing, aiOpen, aiWidth, sftpOpen, sftpWidth]);

  useEffect(() => {
    if (!termMenu) return;

    const closeMenu = () => setTermMenu(null);
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (termMenuRef.current && target && termMenuRef.current.contains(target)) {
        return;
      }
      closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("contextmenu", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("contextmenu", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [termMenu]);

  useEffect(() => {
    if (!smartMenu) return;

    const closeMenu = () => setSmartMenu(null);
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (smartMenuRef.current && target && smartMenuRef.current.contains(target)) {
        return;
      }
      closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("contextmenu", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("contextmenu", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [smartMenu]);

  useLayoutEffect(() => {
    if (!termMenu || !termMenuRef.current) return;

    const menuEl = termMenuRef.current;
    const rect = menuEl.getBoundingClientRect();
    const margin = 8;
    const maxX = window.innerWidth - rect.width - margin;
    const maxY = window.innerHeight - rect.height - margin;
    const nextX = clamp(termMenu.x, margin, Math.max(margin, maxX));
    const nextY = clamp(termMenu.y, margin, Math.max(margin, maxY));

    if (nextX === termMenu.x && nextY === termMenu.y) return;
    setTermMenu((prev) => (prev ? { ...prev, x: nextX, y: nextY } : prev));
  }, [termMenu]);

  useLayoutEffect(() => {
    if (!smartMenu || !smartMenuRef.current) return;

    const menuEl = smartMenuRef.current;
    const rect = menuEl.getBoundingClientRect();
    const margin = 8;
    const maxX = window.innerWidth - rect.width - margin;
    const maxY = window.innerHeight - rect.height - margin;
    const nextX = clamp(smartMenu.x, margin, Math.max(margin, maxX));
    const nextY = clamp(smartMenu.y, margin, Math.max(margin, maxY));

    if (nextX === smartMenu.x && nextY === smartMenu.y) return;
    setSmartMenu((prev) => (prev ? { ...prev, x: nextX, y: nextY } : prev));
  }, [smartMenu]);

  useLayoutEffect(() => {
    if (!sftpMenu || !sftpMenuRef.current) return;

    const menuEl = sftpMenuRef.current;
    const rect = menuEl.getBoundingClientRect();
    const margin = 8;
    const maxX = window.innerWidth - rect.width - margin;
    const maxY = window.innerHeight - rect.height - margin;
    const nextX = clamp(sftpMenu.x, margin, Math.max(margin, maxX));
    const nextY = clamp(sftpMenu.y, margin, Math.max(margin, maxY));

    if (nextX === sftpMenu.x && nextY === sftpMenu.y) return;
    setSftpMenu((prev) => (prev ? { ...prev, x: nextX, y: nextY } : prev));
  }, [sftpMenu]);

  const handleDownloadFile = async (entry: SftpEntry) => {
    if (entry.is_dir) return; // 只下载文件

    let taskId: string | null = null;
    try {
      const currentPath = sftpPath || "/";
      const remotePath = currentPath.endsWith("/")
        ? currentPath + entry.name
        : currentPath + "/" + entry.name;

      // 打开保存对话框
      const localPath = await saveDialog({
        defaultPath: entry.name,
        title: t("terminal.sftp.saveDialog.title"),
      });

      if (!localPath) return; // 用户取消

      taskId = createTransferTask("download", entry.name, remotePath, localPath);
      setUploadProgress(
        t("terminal.sftp.download.progress", { name: entry.name }),
      );
      await sshApi.downloadFile(sessionId, remotePath, localPath);
      if (taskId) {
        updateTransferTask(taskId, {
          status: "success",
          progress: 100,
          detail: t("terminal.sftp.download.done"),
          finishedAt: Date.now(),
        });
      }
      setUploadProgress(null);
    } catch (error) {
      const message = formatError(error);
      setSftpError(t("terminal.sftp.download.fail", { message }));
      if (taskId) {
        updateTransferTask(taskId, {
          status: "failed",
          progress: 100,
          detail: message,
          finishedAt: Date.now(),
        });
      }
      setUploadProgress(null);
    }
  };

  const handleUploadFiles = async (filePaths: string[]) => {
    for (const filePath of filePaths) {
      let taskId: string | null = null;
      try {
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'unknown';
        setUploadProgress(
          t("terminal.sftp.upload.progress", { name: fileName }),
        );

        // 构建远程路径
        const currentPath = sftpPathRef.current || "/";
        const remotePath = currentPath.endsWith("/")
          ? currentPath + fileName
          : currentPath + "/" + fileName;

        taskId = createTransferTask("upload", fileName, filePath, remotePath);
        await sshApi.uploadFile(sessionId, filePath, remotePath);
        if (taskId) {
          updateTransferTask(taskId, {
            status: "success",
            progress: 100,
            detail: t("terminal.sftp.upload.done"),
            finishedAt: Date.now(),
          });
        }
      } catch (error) {
        const message = formatError(error);
        setSftpError(
          t("terminal.sftp.upload.fail", { path: filePath, message }),
        );
        if (taskId) {
          updateTransferTask(taskId, {
            status: "failed",
            progress: 100,
            detail: message,
            finishedAt: Date.now(),
          });
        }
      }
    }

    setUploadProgress(null);
    void loadSftpEntries();
  };

  const isFileDrag = (event: DragEvent) => {
    const types = Array.from(event.dataTransfer?.types ?? []);
    return types.includes("Files");
  };

  const extractDroppedPaths = (event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    const paths = files
      .map((file) => (file as unknown as { path?: string }).path)
      .filter((path): path is string => Boolean(path));
    return paths;
  };

  const handleSftpDragEnter = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    sftpDragCounterRef.current += 1;
    setSftpDragging(true);
  };

  const handleSftpDragLeave = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    sftpDragCounterRef.current = Math.max(0, sftpDragCounterRef.current - 1);
    if (sftpDragCounterRef.current === 0) {
      setSftpDragging(false);
    }
  };

  const handleSftpDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleSftpDrop = async (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    sftpDragCounterRef.current = 0;
    setSftpDragging(false);
    if (uploadProgress) {
      setSftpError(t("terminal.sftp.upload.inProgress"));
      return;
    }
    const filePaths = extractDroppedPaths(event);
    if (filePaths.length === 0) {
      setSftpError(t("terminal.sftp.drop.error"));
      return;
    }
    await handleUploadFiles(filePaths);
  };

  const handleFileSelect = async () => {
    try {
      const selected = await openDialog({
        multiple: true,
        title: t("terminal.sftp.select.title"),
      });

      if (!selected) return; // 用户取消

      const files = Array.isArray(selected) ? selected : [selected];
      await handleUploadFiles(files);
    } catch (error) {
      const message = formatError(error);
      setSftpError(t("terminal.sftp.select.fail", { message }));
      setUploadProgress(null);
    }
  };

  const handleInsertScript = (content: string) => {
    if (!content) return;
    setScriptText(content.trimEnd());
    openScriptPanel();
  };

  const getTerminalContext = (lineCount = 40) => {
    const term = terminalInstance.current;
    if (!term) return "";
    const selection = term.getSelection();
    if (selection && selection.trim()) {
      return selection.trim();
    }
    const buffer = term.buffer.active;
    const start = Math.max(0, buffer.length - lineCount);
    const lines: string[] = [];
    for (let i = start; i < buffer.length; i += 1) {
      const line = buffer.getLine(i)?.translateToString(true).trimEnd();
      if (line) lines.push(line);
    }
    return lines.join("\n").trim();
  };

  const buildAiPrompt = (mode: "ask" | "fix", context: string) => {
    if (mode === "fix") {
      return [
        t("terminal.ai.prompt.fix.line1"),
        t("terminal.ai.prompt.fix.line2"),
        "",
        context,
      ].join("\n");
    }
    return [
      t("terminal.ai.prompt.ask.line1"),
      "",
      context,
    ].join("\n");
  };

  const inferOsProfileForPrompt = (terminalContext: string): string => {
    if (osType && osType !== "unknown") {
      return osType;
    }

    const platform =
      typeof navigator !== "undefined" ? navigator.platform.toLowerCase() : "";
    const ua =
      typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";
    const text = `${terminalContext}\n${platform}\n${ua}`.toLowerCase();

    if (text.includes("ubuntu")) return "linux ubuntu";
    if (text.includes("debian")) return "linux debian";
    if (text.includes("centos")) return "linux centos";
    if (text.includes("fedora")) return "linux fedora";
    if (text.includes("alpine")) return "linux alpine";
    if (text.includes("arch")) return "linux arch";
    if (text.includes("rocky")) return "linux rocky";
    if (text.includes("amazon linux")) return "linux amazon";
    if (
      text.includes("darwin") ||
      text.includes("macos") ||
      text.includes("mac os")
    ) {
      return "macos";
    }
    if (text.includes("windows") || text.includes("powershell") || text.includes("cmd.exe")) {
      return "windows";
    }
    if (text.includes("linux")) return "linux";
    if (isLocal) return "local_unknown";
    return "unknown";
  };

  const buildTerminalFactsForPrompt = (terminalContext: string) => {
    const normalizedContext = terminalContext.trim().slice(-3200);
    const osProfile = inferOsProfileForPrompt(normalizedContext);

    const lines = [
      "Terminal Facts:",
      `- session_id: ${sessionId}`,
      `- connection_type: ${isLocal ? "local" : "ssh"}`,
      `- target_host: ${host || "unknown"}`,
      `- target_port: ${isLocal ? "N/A" : port}`,
      `- endpoint_ip: ${endpointIp || "unknown"}`,
      `- connection_status: ${connStatus}`,
      `- os_profile_hint: ${osProfile}`,
      "",
      "Recent Terminal Output Excerpt:",
      normalizedContext || "(empty)",
    ];

    return lines.join("\n");
  };

  const buildConversationSystemPrompt = (terminalContext: string) =>
    [
      t("terminal.ai.system"),
      locale === "en-US" ? "Respond in English only." : "请仅使用中文回复。",
      "",
      "Always tailor commands and paths to the terminal facts below.",
      "If information is uncertain, state assumptions briefly before commands.",
      "When the user asks how to do/check/fix something in terminal, you must provide executable commands.",
      "Format commands in fenced markdown code blocks with language bash.",
      "Prefer OS-specific commands that match os_profile_hint. If multiple OS variants are needed, label them clearly.",
      "",
      buildTerminalFactsForPrompt(terminalContext),
    ].join("\n");

  const buildAgentSystemPrompt = (terminalContext: string) =>
    (locale === "en-US"
      ? [
          "You are a terminal Agent. Convert the user request into an auditable command plan.",
          "Use English only for all text fields in JSON (summary, reason, expected_effect).",
          `The only available session_id is: ${sessionId}`,
          "You must prioritize terminal facts, especially OS/distribution differences.",
          "",
          buildTerminalFactsForPrompt(terminalContext),
          "",
          "Output JSON only. Do not output Markdown or code fences.",
          "JSON contract:",
          "{",
          '  "id": "plan_xxx",',
          `  "session_id": "${sessionId}",`,
          '  "summary": "short summary",',
          '  "actions": [',
          "    {",
          '      "id": "action_xxx",',
          `      "session_id": "${sessionId}",`,
          '      "command": "single command",',
          '      "risk": "low|medium|high|critical",',
          '      "reason": "why this action is needed",',
          '      "expected_effect": "expected outcome",',
          '      "timeout_sec": 30',
          "    }",
          "  ]",
          "}",
          "Constraints:",
          "- At most 5 actions;",
          "- No command chaining; do not include ; && || | ;",
          "- Commands must be directly executable in shell;",
          "- If no executable steps are possible, return actions=[] and explain in summary.",
        ]
      : [
          "你是终端 Agent。目标是把用户请求转换成可审核的命令计划。",
          "JSON 中所有文本字段（summary/reason/expected_effect）必须使用中文。",
          `当前唯一可用会话 session_id: ${sessionId}`,
          "你必须优先根据“终端事实”选择命令，尤其是操作系统与发行版差异。",
          "",
          buildTerminalFactsForPrompt(terminalContext),
          "",
          "必须只输出 JSON，不要输出 Markdown，不要输出代码块标记。",
          "JSON 协议：",
          "{",
          '  "id": "plan_xxx",',
          `  "session_id": "${sessionId}",`,
          '  "summary": "简短摘要",',
          '  "actions": [',
          "    {",
          '      "id": "action_xxx",',
          `      "session_id": "${sessionId}",`,
          '      "command": "单条命令",',
          '      "risk": "low|medium|high|critical",',
          '      "reason": "为什么执行",',
          '      "expected_effect": "预期结果",',
          '      "timeout_sec": 30',
          "    }",
          "  ]",
          "}",
          "限制：",
          "- 最多 5 个 action；",
          "- 禁止拼接命令，不要包含 ; && || |；",
          "- 命令必须可在 shell 中直接执行；",
          "- 如果无法生成可执行步骤，返回 actions=[] 并在 summary 说明原因。",
        ]).join("\n");

  const buildAgentDecisionSystemPrompt = (terminalContext: string) =>
    (locale === "en-US"
      ? [
          "You are a terminal Agent execution supervisor.",
          "Use English only for all text fields in JSON (note, summary, reason, expected_effect).",
          "Based on completed steps, decide whether to continue, update the remaining plan, or stop.",
          "",
          buildTerminalFactsForPrompt(terminalContext),
          "",
          "Output JSON only. Do not output Markdown. Format:",
          "{",
          '  "decision": "continue | update_plan | stop",',
          '  "note": "short user-facing note",',
          '  "plan": {',
          '    "id": "plan_xxx",',
          `    "session_id": "${sessionId}",`,
          '    "summary": "optional summary",',
          '    "actions": [',
          "      {",
          '        "id": "action_xxx",',
          `        "session_id": "${sessionId}",`,
          '        "command": "single follow-up command only",',
          '        "risk": "low|medium|high|critical",',
          '        "reason": "reason",',
          '        "expected_effect": "expected effect",',
          '        "timeout_sec": 30',
          "      }",
          "    ]",
          "  }",
          "}",
          "Constraints:",
          "- plan.actions must include only not-yet-executed follow-up steps;",
          "- Do not repeat executed steps;",
          "- Return at most 5 follow-up steps;",
          "- If no plan change is needed, set decision=continue and omit plan;",
          "- If execution should stop, set decision=stop.",
        ]
      : [
          "你是终端 Agent 执行监督器。",
          "JSON 中所有文本字段（note/summary/reason/expected_effect）必须使用中文。",
          "根据已执行步骤结果，决定是否继续执行、更新后续计划或停止。",
          "",
          buildTerminalFactsForPrompt(terminalContext),
          "",
          "必须仅输出 JSON，不要输出 Markdown。格式：",
          "{",
          '  "decision": "continue | update_plan | stop",',
          '  "note": "给用户的简短说明",',
          '  "plan": {',
          '    "id": "plan_xxx",',
          `    "session_id": "${sessionId}",`,
          '    "summary": "可选摘要",',
          '    "actions": [',
          "      {",
          '        "id": "action_xxx",',
          `        "session_id": "${sessionId}",`,
          '        "command": "仅后续要执行的单条命令",',
          '        "risk": "low|medium|high|critical",',
          '        "reason": "原因",',
          '        "expected_effect": "预期影响",',
          '        "timeout_sec": 30',
          "      }",
          "    ]",
          "  }",
          "}",
          "约束：",
          "- plan.actions 只包含“尚未执行”的后续步骤；",
          "- 不要重复已执行步骤；",
          "- 每次最多返回 5 个后续步骤；",
          "- 若无需变更计划，decision=continue 且省略 plan；",
          "- 若应停止执行，decision=stop。",
        ]).join("\n");

  const buildAgentFinalReportSystemPrompt = (terminalContext: string) =>
    (locale === "en-US"
      ? [
          "You are a terminal Agent reporting assistant.",
          "Produce a user-readable summary based on execution records.",
          "",
          buildTerminalFactsForPrompt(terminalContext),
          "",
          "Output requirements:",
          "- Use concise English Markdown;",
          "- Must include: overall conclusion, step-by-step results, failure reasons (if any), and next suggestions;",
          "- For each step, clearly mark success/failure and key details.",
        ]
      : [
          "你是终端 Agent 汇报助手。",
          "请根据执行记录给出用户可读总结。",
          "",
          buildTerminalFactsForPrompt(terminalContext),
          "",
          "输出要求：",
          "- 使用简洁中文 Markdown；",
          "- 必须包含：总体结论、每一步结果、失败原因（如有）、下一步建议；",
          "- 每一步结果要明确成功/失败与关键信息。",
        ]).join("\n");

  const getEffectiveAiSettings = async () => {
    const settings = await readAiSettings();
    const selectedModel = aiModel.trim() || settings.model;
    return selectedModel ? { ...settings, model: selectedModel } : settings;
  };

  const toRuntimeActions = (actions: AgentPlan["actions"], fallbackSessionId: string) =>
    actions.slice(0, AGENT_MAX_ACTIONS).map((action) => {
      const normalizedAction = {
        ...action,
        session_id: action.session_id || fallbackSessionId || sessionId,
        timeout_sec: Math.max(3, Math.min(300, action.timeout_sec || 30)),
      };
      const policy = evaluateAgentActionPolicy(
        {
          command: normalizedAction.command,
          risk: normalizedAction.risk,
          session_id: normalizedAction.session_id,
        },
        sessionId,
      );
      return {
        ...normalizedAction,
        risk: policy.normalized_risk,
        edited_command: policy.normalized_command || normalizedAction.command,
        policy,
        status: policy.status === "blocked" ? "blocked" : "pending",
        strong_confirm_input: "",
      } satisfies AgentActionRuntime;
    });

  const truncateResultText = (text: string | undefined) => {
    const value = (text || "").trim();
    if (!value) return "";
    if (value.length <= AGENT_RESULT_SNIPPET_CHARS) return value;
    return `${value.slice(0, AGENT_RESULT_SNIPPET_CHARS)}\n...<truncated>`;
  };

  const waitForUiStateSync = () =>
    new Promise<void>((resolve) => {
      if (
        typeof window !== "undefined" &&
        typeof window.requestAnimationFrame === "function"
      ) {
        window.requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(() => resolve(), 0);
    });

  const extractJsonBlock = (text: string) => {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return text.slice(start, end + 1).trim();
    return "";
  };

  const parseAgentStepDecision = (raw: string): AgentStepDecision | null => {
    const jsonText = extractJsonBlock(raw);
    if (!jsonText) return null;
    try {
      const data = JSON.parse(jsonText) as Record<string, unknown>;
      const decisionRaw = String(data.decision || "").trim().toLowerCase();
      const decision: AgentStepDecision["decision"] =
        decisionRaw === "update_plan"
          ? "update_plan"
          : decisionRaw === "stop"
            ? "stop"
            : "continue";
      const note = typeof data.note === "string" ? data.note.trim() : "";
      const parsedPlan = parseAgentPlanFromText(
        typeof data.plan === "object" && data.plan
          ? JSON.stringify(data.plan)
          : typeof data === "object"
            ? JSON.stringify(data)
            : "",
      ).plan;
      return {
        decision,
        note,
        plan: decision === "update_plan" ? parsedPlan || undefined : undefined,
      };
    } catch {
      return null;
    }
  };

  const applyRevisedPlan = (messageId: string, revisedPlan: AgentPlan) => {
    updateMessageAgentPlan(messageId, (plan) => {
      const completed = plan.actions.filter(
        (action) =>
          action.status === "success" ||
          action.status === "failed" ||
          action.status === "blocked" ||
          action.status === "rejected" ||
          action.status === "skipped",
      );
      const revised = toRuntimeActions(
        revisedPlan.actions,
        revisedPlan.session_id || plan.session_id,
      );
      return {
        ...plan,
        summary: revisedPlan.summary?.trim() || plan.summary,
        actions: [...completed, ...revised].slice(0, AGENT_MAX_ACTIONS + completed.length),
      };
    });
  };

  const riskLevelLabel = (risk: AgentRisk) => t(`terminal.agent.risk.${risk}`);

  const policyStatusLabel = (
    status: AgentActionRuntime["policy"]["status"],
  ) => t(`terminal.agent.policy.${status}`);

  const actionStatusLabel = (status: AgentActionStatus) =>
    t(`terminal.agent.status.${status}`);

  const buildAgentPlanRuntime = (
    plan: AgentPlan,
    userRequest: string,
    mode: AgentMode,
  ): AgentPlanRuntime => {
    const actions = toRuntimeActions(plan.actions, plan.session_id);

    return {
      id: plan.id,
      session_id: plan.session_id,
      summary: plan.summary || t("terminal.agent.plan.generated"),
      actions,
      status: normalizeAgentActionStatus(actions.map((item) => item.status)),
      mode,
      created_at: Date.now(),
      user_request: userRequest,
      thinking: false,
      final_report_ready: false,
      activities: [
        {
          id: createAgentActivityId(),
          ts: Date.now(),
          text: t("terminal.agent.activity.planReady"),
          tone: "info",
        },
      ],
    };
  };

  const updateMessageAgentPlan = (
    messageId: string,
    updater: (plan: AgentPlanRuntime) => AgentPlanRuntime,
  ) => {
    setAiMessages((prev) =>
      prev.map((msg) => {
        if (msg.id !== messageId || !msg.agentPlan) return msg;
        const nextPlan = updater(msg.agentPlan);
        const normalizedStatus = normalizeAgentActionStatus(
          nextPlan.actions.map((item) => item.status),
        );
        let resolvedStatus = normalizedStatus;
        if (nextPlan.status === "running" && normalizedStatus === "pending") {
          resolvedStatus = "running";
        }
        if (nextPlan.status === "failed" && normalizedStatus === "completed") {
          resolvedStatus = "failed";
        }
        if (nextPlan.status === "stopped" || nextPlan.stop_requested) {
          resolvedStatus = normalizedStatus === "running" ? "running" : "stopped";
        }
        return {
          ...msg,
          agentPlan: {
            ...nextPlan,
            status: resolvedStatus,
          },
        };
      }),
    );
  };

  const appendAgentPlanActivity = (
    messageId: string,
    text: string,
    tone: AgentPlanActivityTone = "info",
  ) => {
    const value = text.trim();
    if (!value) return;
    updateMessageAgentPlan(messageId, (plan) => {
      const next = [
        ...(plan.activities || []),
        {
          id: createAgentActivityId(),
          ts: Date.now(),
          text: value,
          tone,
        },
      ];
      if (next.length > AGENT_MAX_ACTIVITY_ITEMS) {
        next.splice(0, next.length - AGENT_MAX_ACTIVITY_ITEMS);
      }
      return {
        ...plan,
        activities: next,
      };
    });
  };

  const setAgentPlanThinking = (
    messageId: string,
    thinking: boolean,
  ) => {
    updateMessageAgentPlan(messageId, (plan) => ({
      ...plan,
      thinking,
    }));
  };

  const updateAgentAction = (
    messageId: string,
    actionId: string,
    updater: (action: AgentActionRuntime) => AgentActionRuntime,
  ) => {
    updateMessageAgentPlan(messageId, (plan) => ({
      ...plan,
      actions: plan.actions.map((action) =>
        action.id === actionId ? updater(action) : action,
      ),
    }));
  };

  const runAgentAction = async (
    messageId: string,
    actionId: string,
    options?: {
      allowBlocked?: boolean;
    },
  ): Promise<AgentActionStatus | null> => {
    const allowBlocked = options?.allowBlocked === true;
    const msg = aiMessagesRef.current.find((item) => item.id === messageId);
    if (!msg?.agentPlan) return null;
    const plan = msg.agentPlan;
    const action = plan.actions.find((item) => item.id === actionId);
    if (!action) return null;
    if (action.status === "rejected") return action.status;
    if (action.status === "blocked" && !allowBlocked) return action.status;
    if (action.status === "running") return "running";
    if (agentMode !== "confirm_then_execute") {
      setAiError(t("terminal.agent.mode.suggestBlock"));
      return null;
    }

    const command = action.edited_command.trim();
    if (!command) {
      setAiError(t("terminal.write.fail"));
      updateAgentAction(messageId, actionId, (prev) => ({
        ...prev,
        status: "failed",
        error: t("terminal.write.fail"),
      }));
      return "failed";
    }

    const latestPolicy = evaluateAgentActionPolicy(
      {
        command,
        risk: action.risk,
        session_id: action.session_id,
      },
      sessionId,
    );

    if (latestPolicy.status === "blocked" && !allowBlocked) {
      setAiError(latestPolicy.reason);
      updateAgentAction(messageId, actionId, (prev) => ({
        ...prev,
        status: "blocked",
        policy: latestPolicy,
        risk: latestPolicy.normalized_risk,
        error: latestPolicy.reason,
      }));
      return "blocked";
    }

    const effectivePolicy =
      allowBlocked && latestPolicy.status === "blocked"
        ? {
            ...latestPolicy,
            status: "needs_strong_confirmation" as const,
            reason: `${latestPolicy.reason}（用户强制执行）`,
          }
        : latestPolicy;

    updateAgentAction(messageId, actionId, (prev) => ({
      ...prev,
      policy: effectivePolicy,
      risk: effectivePolicy.normalized_risk,
      status: "running",
      confirmed_at: Date.now(),
      error: undefined,
    }));

    await appendAgentAuditRecord({
      event: "action_confirmed",
      mode: agentMode,
      session_id: sessionId,
      user_request: plan.user_request,
      action_id: actionId,
      command,
      risk: action.risk,
      reason: allowBlocked ? `${action.reason} [force_blocked=true]` : action.reason,
      plan: msg.agentPlanRaw,
    }).catch(() => {});

    await appendAgentAuditRecord({
      event: "action_started",
      mode: agentMode,
      session_id: sessionId,
      user_request: plan.user_request,
      action_id: actionId,
      command,
      risk: action.risk,
      reason: allowBlocked ? `${action.reason} [force_blocked=true]` : action.reason,
      plan: msg.agentPlanRaw,
    }).catch(() => {});

    try {
      const result = await executeAgentActionInTerminal(command, action.timeout_sec);

      const status: AgentActionStatus =
        !result.timedOut && result.exitCode === 0 ? "success" : "failed";

      updateAgentAction(messageId, actionId, (prev) => ({
        ...prev,
        status,
        result,
        execution_note:
          status === "success"
            ? `exit=${result.exitCode}, ${result.durationMs}ms`
            : `exit=${result.exitCode}, ${result.durationMs}ms, ${truncateResultText(result.stderr || result.stdout)}`,
        finished_at: Date.now(),
        error:
          status === "failed"
            ? result.stderr || `exit code ${result.exitCode}`
            : undefined,
      }));

      await appendAgentAuditRecord({
        event: "action_finished",
        mode: agentMode,
        session_id: sessionId,
        user_request: plan.user_request,
        action_id: actionId,
        command,
        risk: action.risk,
        reason: action.reason,
        plan: msg.agentPlanRaw,
        result: {
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          stderr: result.stderr,
          stdout: result.stdout,
        },
      }).catch(() => {});

      return status;
    } catch (error) {
      const message = formatError(error);
      updateAgentAction(messageId, actionId, (prev) => ({
        ...prev,
        status: "failed",
        error: message,
        execution_note: message,
        finished_at: Date.now(),
      }));

      await appendAgentAuditRecord({
        event: "action_finished",
        mode: agentMode,
        session_id: sessionId,
        user_request: plan.user_request,
        action_id: actionId,
        command,
        risk: action.risk,
        reason: action.reason,
        plan: msg.agentPlanRaw,
        result: {
          stderr: message,
        },
      }).catch(() => {});

      return "failed";
    }
  };

  const askAgentStepDecision = async (
    messageId: string,
    actionId: string,
  ): Promise<AgentStepDecision | null> => {
    const message = aiMessagesRef.current.find((item) => item.id === messageId);
    const plan = message?.agentPlan;
    const action = plan?.actions.find((item) => item.id === actionId);
    if (!plan || !action) return null;

    const terminalContextForPrompt = getTerminalContext(60);
    const systemMessage: AiMessage = {
      role: "system",
      content: buildAgentDecisionSystemPrompt(terminalContextForPrompt),
    };

    const payload = {
      user_request: plan.user_request,
      current_summary: plan.summary,
      current_plan: {
        id: plan.id,
        session_id: plan.session_id,
        actions: plan.actions.map((item) => ({
          id: item.id,
          command: item.edited_command,
          status: item.status,
          risk: item.risk,
          reason: item.reason,
          expected_effect: item.expected_effect,
          timeout_sec: item.timeout_sec,
        })),
      },
      executed_step: {
        id: action.id,
        command: action.edited_command,
        status: action.status,
        exit_code: action.result?.exitCode,
        duration_ms: action.result?.durationMs,
        timed_out: action.result?.timedOut,
        stdout: truncateResultText(action.result?.stdout),
        stderr: truncateResultText(action.error || action.result?.stderr),
      },
    };

    try {
      const settings = await getEffectiveAiSettings();
      const raw = await sendAiChatStream(
        settings,
        [systemMessage, { role: "user", content: JSON.stringify(payload, null, 2) }],
        () => {},
      );
      return parseAgentStepDecision(raw);
    } catch {
      return null;
    }
  };

  const askAgentFinalReport = async (messageId: string): Promise<string | null> => {
    const message = aiMessagesRef.current.find((item) => item.id === messageId);
    const plan = message?.agentPlan;
    if (!plan) return null;

    const terminalContextForPrompt = getTerminalContext(60);
    const systemMessage: AiMessage = {
      role: "system",
      content: buildAgentFinalReportSystemPrompt(terminalContextForPrompt),
    };

    const payload = {
      user_request: plan.user_request,
      final_plan_summary: plan.summary,
      final_status: plan.status,
      steps: plan.actions.map((item) => ({
        id: item.id,
        command: item.edited_command,
        status: item.status,
        risk: item.risk,
        reason: item.reason,
        expected_effect: item.expected_effect,
        exit_code: item.result?.exitCode,
        duration_ms: item.result?.durationMs,
        timed_out: item.result?.timedOut,
        stdout: truncateResultText(item.result?.stdout),
        stderr: truncateResultText(item.error || item.result?.stderr),
      })),
    };

    try {
      const settings = await getEffectiveAiSettings();
      return await sendAiChatStream(
        settings,
        [systemMessage, { role: "user", content: JSON.stringify(payload, null, 2) }],
        () => {},
      );
    } catch {
      return null;
    }
  };

  const runRemainingAgentActions = async (
    messageId: string,
    options?: {
      allowBlocked?: boolean;
    },
  ) => {
    const allowBlocked = options?.allowBlocked === true;
    if (agentMode !== "confirm_then_execute") {
      setAiError(t("terminal.agent.mode.suggestBlock"));
      return;
    }
    if (planExecutionLockRef.current[messageId]) {
      return;
    }
    planExecutionLockRef.current[messageId] = true;

    try {
      planStopRequestedRef.current[messageId] = false;
      updateMessageAgentPlan(messageId, (plan) => ({
        ...plan,
        stop_requested: false,
        status: "running",
        final_report_ready: false,
      }));
      setAgentPlanThinking(messageId, false);
      const initialPlan = aiMessagesRef.current.find((item) => item.id === messageId)?.agentPlan;
      appendAgentPlanActivity(
        messageId,
        t("terminal.agent.activity.planStart", {
          count: initialPlan?.actions.length || 0,
        }),
        "info",
      );

      while (true) {
        const current = aiMessagesRef.current.find((item) => item.id === messageId);
        const plan = current?.agentPlan;
        if (!plan) break;

        if (planStopRequestedRef.current[messageId]) {
          updateMessageAgentPlan(messageId, (prev) => ({
            ...prev,
            actions: prev.actions.map((action) =>
              action.status === "pending" ||
              action.status === "approved" ||
              (allowBlocked && action.status === "blocked")
                ? { ...action, status: "skipped" }
                : action,
            ),
            status: "stopped",
            stop_requested: true,
          }));
          appendAgentPlanActivity(
            messageId,
            t("terminal.agent.activity.userStopped"),
            "warn",
          );
          break;
        }

        const next = plan.actions.find(
          (action) =>
            action.status === "pending" ||
            action.status === "approved" ||
            (allowBlocked && action.status === "blocked"),
        );
        if (!next) break;
        const stepIndex =
          plan.actions.findIndex((item) => item.id === next.id) + 1;
        appendAgentPlanActivity(
          messageId,
          t("terminal.agent.activity.stepStart", {
            index: stepIndex,
            command: next.edited_command,
          }),
          "info",
        );

        const status = await runAgentAction(messageId, next.id, {
          allowBlocked,
        });
        if (status === null) break;

        if (status === "success") {
          appendAgentPlanActivity(
            messageId,
            t("terminal.agent.activity.stepSuccess", {
              index: stepIndex,
            }),
            "success",
          );
        } else if (status === "failed") {
          appendAgentPlanActivity(
            messageId,
            t("terminal.agent.activity.stepFailed", {
              index: stepIndex,
            }),
            "error",
          );
        } else if (status === "blocked") {
          appendAgentPlanActivity(
            messageId,
            t("terminal.agent.activity.stepBlocked", {
              index: stepIndex,
            }),
            "warn",
          );
        }

        await waitForUiStateSync();

        setAgentPlanThinking(messageId, true);
        appendAgentPlanActivity(
          messageId,
          t("terminal.agent.activity.thinkingDecision"),
          "info",
        );
        const decision = await askAgentStepDecision(messageId, next.id);
        setAgentPlanThinking(messageId, false);
        if (decision?.note) {
          updateMessageAgentPlan(messageId, (prev) => ({
            ...prev,
            summary: decision.note || prev.summary,
          }));
          appendAgentPlanActivity(
            messageId,
            t("terminal.agent.activity.decisionNote", {
              note: decision.note,
            }),
            "info",
          );
          await waitForUiStateSync();
        }
        if (decision?.decision === "update_plan" && decision.plan) {
          appendAgentPlanActivity(
            messageId,
            t("terminal.agent.activity.replanStart"),
            "warn",
          );
          applyRevisedPlan(messageId, decision.plan);
          appendAgentPlanActivity(
            messageId,
            t("terminal.agent.activity.replanDone", {
              count: decision.plan.actions.length,
            }),
            "success",
          );
          await waitForUiStateSync();
        }
        if (decision?.decision === "stop") {
          appendAgentPlanActivity(
            messageId,
            t("terminal.agent.activity.planStoppedByAgent"),
            "warn",
          );
          stopRemainingAgentActions(messageId);
          break;
        }
      }

      await waitForUiStateSync();
      setAgentPlanThinking(messageId, true);
      appendAgentPlanActivity(
        messageId,
        t("terminal.agent.activity.thinkingFinalReport"),
        "info",
      );
      const finalReport = await askAgentFinalReport(messageId);
      setAgentPlanThinking(messageId, false);
      if (finalReport?.trim()) {
        setAiMessages((prev) => [
          ...prev,
          {
            id: createMessageId(),
            role: "assistant",
            content: finalReport.trim(),
            createdAt: Date.now(),
          },
        ]);
        updateMessageAgentPlan(messageId, (prev) => ({
          ...prev,
          final_report_ready: true,
        }));
        appendAgentPlanActivity(
          messageId,
          t("terminal.agent.activity.finalReportReady"),
          "success",
        );
      }
    } finally {
      setAgentPlanThinking(messageId, false);
      planExecutionLockRef.current[messageId] = false;
    }
  };

  const openForceRunDialog = (messageId: string) => {
    const message = aiMessagesRef.current.find((item) => item.id === messageId);
    const blockedCount =
      message?.agentPlan?.actions.filter((action) => action.status === "blocked").length || 0;
    if (blockedCount <= 0) {
      void runRemainingAgentActions(messageId);
      return;
    }
    setForceRunDialog({ messageId, blockedCount });
    setForceRunConfirmInput("");
    setForceRunConfirmError(null);
  };

  const confirmForceRunDialog = async () => {
    const dialog = forceRunDialog;
    if (!dialog) return;
    const keyword = t("terminal.agent.plan.force.keyword").trim();
    if (forceRunConfirmInput.trim() !== keyword) {
      setForceRunConfirmError(
        t("terminal.agent.plan.force.invalid", {
          keyword,
        }),
      );
      return;
    }
    const messageId = dialog.messageId;
    setForceRunDialog(null);
    setForceRunConfirmInput("");
    setForceRunConfirmError(null);
    await runRemainingAgentActions(messageId, { allowBlocked: true });
  };

  const stopRemainingAgentActions = (messageId: string) => {
    planStopRequestedRef.current[messageId] = true;
    updateMessageAgentPlan(messageId, (plan) => ({
      ...plan,
      stop_requested: true,
    }));
    void appendAgentAuditRecord({
      event: "plan_stopped",
      mode: agentMode,
      session_id: sessionId,
      user_request:
        aiMessagesRef.current.find((item) => item.id === messageId)?.agentPlan?.user_request ||
        "",
      plan: aiMessagesRef.current.find((item) => item.id === messageId)?.agentPlanRaw,
    }).catch(() => {});
  };

  const sendAiMessage = async (
    content: string,
    options?: SendAiMessageOptions,
  ): Promise<string | null> => {
    if (!content.trim()) return null;
    setAiError(null);
    setAiBusy(true);

    const userMessage: AiChatMessage = {
      id: createMessageId(),
      role: "user",
      content,
      createdAt: Date.now(),
    };
    const assistantId = createMessageId();
    const assistantMessage: AiChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };
    const requestAbortController = new AbortController();
    aiStreamAbortRef.current = requestAbortController;
    aiAbortReasonRef.current = null;
    const nextMessages = [...aiMessagesRef.current, userMessage];
    setAiMessages((prev) => [...prev, userMessage, assistantMessage]);

    try {
      const settings = await readAiSettings();
      const selectedModel = aiModel.trim() || settings.model;
      const nextSettings = selectedModel ? { ...settings, model: selectedModel } : settings;
      const useAgentMode = agentMode === "confirm_then_execute";
      const terminalContextForPrompt = getTerminalContext(60);
      const baseSystemPrompt = useAgentMode
        ? buildAgentSystemPrompt(terminalContextForPrompt)
        : buildConversationSystemPrompt(terminalContextForPrompt);
      const systemMessage: AiMessage = {
        role: "system",
        content: options?.extraSystemPrompt
          ? [baseSystemPrompt, "", options.extraSystemPrompt].join("\n")
          : baseSystemPrompt,
      };
      const finalContent = await sendAiChatStream(
        nextSettings,
        [systemMessage, ...nextMessages.map(({ role, content }) => ({ role, content }))],
        (delta) => {
          if (!delta) return;
          setAiMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantId ? { ...msg, content: msg.content + delta } : msg,
            ),
          );
        },
        {
          signal: requestAbortController.signal,
        },
      );

      if (!useAgentMode) {
        return finalContent;
      }

      const parsed = parseAgentPlanFromText(finalContent);
      if (!parsed.plan) {
        setAiError(t("terminal.agent.plan.parseFailed"));
        setAiMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: parsed.note || finalContent,
                }
              : msg,
          ),
        );
        void appendAgentAuditRecord({
          event: "plan_parse_failed",
          mode: agentMode,
          session_id: sessionId,
          user_request: content,
          reason: parsed.error,
          command: parsed.raw_json || finalContent,
        }).catch(() => {});
        return parsed.note || finalContent;
      }

      const runtimePlan = buildAgentPlanRuntime(parsed.plan, content, agentMode);
      const assistantContent = parsed.note || t("terminal.agent.plan.generated");
      setAiMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                content: assistantContent,
                agentPlan: runtimePlan,
                agentPlanRaw: parsed.plan || undefined,
              }
            : msg,
        ),
      );

      void appendAgentAuditRecord({
        event: "plan_created",
        mode: agentMode,
        session_id: sessionId,
        user_request: content,
        plan: parsed.plan,
      }).catch(() => {});
      return assistantContent;
    } catch (error) {
      if (isAbortError(error)) {
        if (aiAbortReasonRef.current === "stop") {
          setAiError(t("terminal.ai.interrupted"));
        } else {
          setAiError(null);
        }
        setAiMessages((prev) =>
          prev.filter((msg) => msg.id !== assistantId || msg.content.trim()),
        );
        return null;
      }
      const message = formatError(error);
      setAiError(message);
      setAiMessages((prev) =>
        prev.filter((msg) => msg.id !== assistantId || msg.content.trim()),
      );
      return null;
    } finally {
      if (aiStreamAbortRef.current === requestAbortController) {
        aiStreamAbortRef.current = null;
      }
      aiAbortReasonRef.current = null;
      setAiBusy(false);
    }
  };

  const handleTerminalHashCommand = async (rawCommand: string) => {
    const parsed = parseTerminalHashCommand(rawCommand);
    if (!parsed) return;
    setAiOpen(true);
    setAiError(null);
    const strictCommandPrompt =
      locale === "en-US"
        ? [
            "Respond in English only.",
            "You must provide executable next-step commands, not only high-level promises.",
            "Output format:",
            "1) One short sentence explaining the approach;",
            "2) At least one bash fenced code block with runnable commands;",
            "3) A short note after each command describing purpose and risk.",
          ].join("\n")
        : [
            "你必须给出可执行的下一步命令，不能只说“我会帮你处理”。",
            "输出格式：",
            "1) 一句话说明方案；",
            "2) 至少一个 bash 代码块，包含可直接执行命令；",
            "3) 每条命令后简短说明作用与风险。",
          ].join("\n");

    if (parsed.kind === "help") {
      const lines = terminalQuickCommands.map(
        (item) => `- \`${item.syntax}\` ${item.description}`,
      );
      const content = [
        t("terminal.ai.quick.help.title"),
        "",
        ...lines,
        "",
        t("terminal.ai.quick.tip"),
      ].join("\n");
      setAiMessages((prev) => [
        ...prev,
        {
          id: createMessageId(),
          role: "assistant",
          content,
          createdAt: Date.now(),
        },
      ]);
      return;
    }

    if (parsed.kind === "unknown") {
      setAiError(t("terminal.ai.quick.unsupported", { command: parsed.name }));
      return;
    }

    if (aiBusy) {
      setAiError(t("terminal.ai.quick.busy"));
      return;
    }

    if (parsed.kind === "ai") {
      if (!parsed.query) {
        setAiError(t("terminal.ai.quick.aiEmpty"));
        return;
      }
      setAiInput("");
      const firstReply = await sendAiMessage(parsed.query, {
        extraSystemPrompt: strictCommandPrompt,
      });
      if (firstReply && !hasExecutableCommand(firstReply)) {
        await sendAiMessage(t("terminal.ai.quick.followup.commandsOnly"), {
          extraSystemPrompt: strictCommandPrompt,
        });
      }
      return;
    }

    const context = getTerminalContext(60);
    if (!context) {
      setAiError(t("terminal.ai.noContext"));
      return;
    }
    const fixPromptPrefix = parsed.query
      ? t("terminal.ai.quick.fix.prefix", { query: parsed.query })
      : t("terminal.ai.quick.fix.prefixEmpty");
    const prompt = [fixPromptPrefix, "", buildAiPrompt("fix", context)].join("\n");
    setAiInput("");
    const firstReply = await sendAiMessage(prompt, {
      extraSystemPrompt: strictCommandPrompt,
    });
    if (firstReply && !hasExecutableCommand(firstReply)) {
      await sendAiMessage(t("terminal.ai.quick.followup.commandsOnly"), {
        extraSystemPrompt: strictCommandPrompt,
      });
    }
  };

  const openAiFromTerminal = async (mode: "ask" | "fix") => {
    setTermMenu(null);
    const context = getTerminalContext();
    if (!context) {
      setAiError(t("terminal.ai.noContext"));
      openScriptPanel();
      setAiOpen(true);
      return;
    }

    const prompt = buildAiPrompt(mode, context);
    setAiOpen(true);
    setAiInput("");
    await sendAiMessage(prompt);
  };

  const handleAgentModeChange = async (nextMode: AgentMode) => {
    if (nextMode === agentMode) return;
    setAgentMode(nextMode);
    try {
      await writeAppSetting("ai.agentMode", nextMode);
    } catch (error) {
      setAiError(formatError(error));
    }
  };

  useEffect(() => {
    if (!aiOpen) return;
    void syncAiSettings();
  }, [aiOpen]);

  useEffect(() => {
    if (!aiModelMenuOpen) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || !aiModelMenuRef.current) return;
      if (!aiModelMenuRef.current.contains(target)) {
        setAiModelMenuOpen(false);
      }
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAiModelMenuOpen(false);
    };

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [aiModelMenuOpen]);

  useEffect(() => {
    const focusTerminalForEvent = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          activeTabId?: string | null;
        }>
      ).detail;
      if (detail?.activeTabId && detail.activeTabId !== sessionId) {
        return;
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const term = terminalInstance.current;
          if (!term) return;
          if (!paneRef.current) return;
          if (paneRef.current.offsetParent === null) return;
          term.focus();
        });
      });
    };

    window.addEventListener("app-unlocked", focusTerminalForEvent);
    window.addEventListener("app-window-activated", focusTerminalForEvent);
    return () => {
      window.removeEventListener("app-unlocked", focusTerminalForEvent);
      window.removeEventListener("app-window-activated", focusTerminalForEvent);
    };
  }, [sessionId]);

  useEffect(() => {
    const onReconnectAllTerminals = () => {
      writeQueueRef.current = [];
      setTerminalIssue(null);
      void recoverSessionAfterUnlock();
    };

    window.addEventListener("app-reconnect-terminals", onReconnectAllTerminals);
    return () => {
      window.removeEventListener("app-reconnect-terminals", onReconnectAllTerminals);
    };
  }, [sessionId]);

  useEffect(() => {
    const onPointerDownFocus = () => {
      window.setTimeout(() => {
        const term = terminalInstance.current;
        if (!term) return;
        if (!paneRef.current) return;
        if (paneRef.current.offsetParent === null) return;
        term.focus();
      }, 0);
    };

    const mount = terminalRef.current;
    if (!mount) return;
    mount.addEventListener("pointerdown", onPointerDownFocus);
    return () => {
      mount.removeEventListener("pointerdown", onPointerDownFocus);
    };
  }, []);

  const handleSendScript = async () => {
    const trimmed = scriptText.trim();
    if (!trimmed) return;
    const payload = trimmed + "\n";
    if (onSendScript) {
      await onSendScript(payload, scriptTarget);
      return;
    }
    enqueueTerminalWrite(payload);
  };

  const handleTermCopy = async () => {
    const term = terminalInstance.current;
    if (!term || !term.hasSelection()) return;
    await clipboardWrite(term.getSelection());
    setTermMenu(null);
  };

  const handleTermPaste = async () => {
    const term = terminalInstance.current;
    if (!term) return;
    const text = await clipboardRead();
    if (!text) return;
    term.paste(text);
    setTermMenu(null);
  };

  const handleTermClear = () => {
    const term = terminalInstance.current;
    if (!term) return;
    term.clear();
    setTermMenu(null);
  };

  const handleTermMenuClose = () => {
    setTermMenu(null);
  };

  const openSmartMenu = (
    event: {
      preventDefault: () => void;
      stopPropagation: () => void;
      clientX: number;
      clientY: number;
    },
    payload: SmartMenuState,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setSmartMenu({
      ...payload,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const runSmartAction = (command: string) => {
    if (!command.trim()) return;
    enqueueTerminalWrite(`${command}\n`);
    setSmartMenu(null);
  };

  const handleApplyTerminalQuickCommand = (command: string) => {
    if (!command.trim()) return;
    inputCommandBufferRef.current = command;
    syncTerminalQuickDraftFromBuffer(command);
    enqueueTerminalWrite(`\u0015${command}`);
    terminalInstance.current?.focus();
  };

  const handleSmartStopContainer = (row: DockerPsRow) => {
    runSmartAction(`docker stop ${shellEscapeArg(row.containerId)}`);
  };

  const handleSmartEditFile = (row: LsTableRow) => {
    const target = stripSymlinkSuffix(row.name).trim();
    if (!target) return;
    runSmartAction(`vi ${shellEscapeArg(target)}`);
  };

  const handleSmartEnterDir = (row: LsTableRow) => {
    const target = stripSymlinkSuffix(row.name).trim();
    if (!target) return;
    runSmartAction(`cd ${shellEscapeArg(target)}`);
  };

  const handleSmartMenuClose = () => {
    setSmartMenu(null);
  };

  useEffect(() => {
    if (!terminalRef.current) return;

    let disposed = false;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let unlistenOutput: (() => void) | null = null;
    let unlistenDisconnect: (() => void) | null = null;
    let unlistenTheme: (() => void) | null = null;
    let unlistenFontSize: (() => void) | null = null;
    let unlistenFontFamily: (() => void) | null = null;
    let unlistenFontWeight: (() => void) | null = null;
    let unlistenCursorStyle: (() => void) | null = null;
    let unlistenCursorBlink: (() => void) | null = null;
    let unlistenLineHeight: (() => void) | null = null;
    let unlistenAutoCopy: (() => void) | null = null;
    let unlistenBackgroundImage: (() => void) | null = null;
    let unlistenBackgroundOpacity: (() => void) | null = null;
    let unlistenBackgroundBlur: (() => void) | null = null;
    let disposable: { dispose: () => void } | null = null;
    let selectionDisposable: { dispose: () => void } | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let removeContextMenu: (() => void) | null = null;

    const fitAndResize = () => {
      if (!term || !fit) return;
      if (!paneRef.current) return;
      if (paneRef.current.offsetParent === null) return; // hidden (e.g. inactive tab)
      fit.fit();
      resizePty(term.cols, term.rows).catch(() => {});
    };

    const init = async () => {
      const store = await getAppSettingsStore();
      const themeName =
        (await store.get<TerminalThemeName>("terminal.theme")) ??
        DEFAULT_APP_SETTINGS["terminal.theme"];
      const fontSize =
        (await store.get<number>("terminal.fontSize")) ??
        DEFAULT_APP_SETTINGS["terminal.fontSize"];
      const fontFamily =
        (await store.get<string>("terminal.fontFamily")) ??
        DEFAULT_APP_SETTINGS["terminal.fontFamily"];
      const fontWeight =
        (await store.get<number>("terminal.fontWeight")) ??
        DEFAULT_APP_SETTINGS["terminal.fontWeight"];
      const cursorStyle =
        (await store.get<"block" | "underline" | "bar">("terminal.cursorStyle")) ??
        DEFAULT_APP_SETTINGS["terminal.cursorStyle"];
      const cursorBlink =
        (await store.get<boolean>("terminal.cursorBlink")) ??
        DEFAULT_APP_SETTINGS["terminal.cursorBlink"];
      const lineHeight =
        (await store.get<number>("terminal.lineHeight")) ??
        DEFAULT_APP_SETTINGS["terminal.lineHeight"];
      const autoCopy =
        (await store.get<boolean>("terminal.autoCopy")) ??
        DEFAULT_APP_SETTINGS["terminal.autoCopy"];
      const backgroundImage =
        (await store.get<string>("terminal.backgroundImage")) ??
        DEFAULT_APP_SETTINGS["terminal.backgroundImage"];
      const backgroundOpacity =
        (await store.get<number>("terminal.backgroundOpacity")) ??
        DEFAULT_APP_SETTINGS["terminal.backgroundOpacity"];
      const backgroundBlur =
        (await store.get<number>("terminal.backgroundBlur")) ??
        DEFAULT_APP_SETTINGS["terminal.backgroundBlur"];

      if (disposed || !terminalRef.current) return;

      const xtermTheme = getXtermTheme(themeName);
      const baseBg = xtermTheme.background ?? "#0f111a";
      const hasBgImage = Boolean(backgroundImage);
      const themeBg = hasBgImage ? "transparent" : baseBg;
      const resolvedBackgroundImage = await loadTerminalBackgroundUrl(backgroundImage);
      if (disposed) {
        if (resolvedBackgroundImage.startsWith("blob:")) {
          URL.revokeObjectURL(resolvedBackgroundImage);
        }
        return;
      }
      if (
        terminalBgObjectUrlRef.current &&
        terminalBgObjectUrlRef.current.startsWith("blob:") &&
        terminalBgObjectUrlRef.current !== resolvedBackgroundImage
      ) {
        URL.revokeObjectURL(terminalBgObjectUrlRef.current);
      }
      terminalBgObjectUrlRef.current =
        resolvedBackgroundImage.startsWith("blob:") ? resolvedBackgroundImage : "";
      themeNameRef.current = themeName;
      terminalBgImageRef.current = backgroundImage;
      setTerminalBgImage(resolvedBackgroundImage);
      setTerminalBgOpacity(backgroundOpacity);
      setTerminalBgBlur(backgroundBlur);
      setXtermBaseBg(baseBg);
      setXtermBg(themeBg);
      autoCopyRef.current = autoCopy;

      term = new Terminal({
        cursorBlink,
        cursorStyle,
        lineHeight,
        fontWeight,
        fontSize,
        fontFamily,
        theme: { ...xtermTheme, background: themeBg },
        allowProposedApi: true,
        scrollback: 10000,
      });

      fit = new FitAddon();
      const webLinks = new WebLinksAddon();

      term.loadAddon(fit);
      term.loadAddon(webLinks);

      term.open(terminalRef.current);
      fit.fit();

      terminalInstance.current = term;
      fitAddon.current = fit;

      // Copy/paste integration:
      // - Cmd+C copies selection; otherwise it remains Ctrl+C (interrupt).
      // - Ctrl+Shift+C copies selection (Windows/Linux convention).
      // - Cmd+V / Ctrl+Shift+V pastes.
      term.attachCustomKeyEventHandler((ev) => {
        if (!term) return true;
        if (ev.type !== "keydown") return true;

        const key = ev.key.toLowerCase();
        const isMac = /mac|iphone|ipad|ipod/.test(navigator.platform.toLowerCase());
        const isCopy =
          (ev.ctrlKey && ev.shiftKey && key === "c") ||
          (ev.metaKey && !ev.shiftKey && key === "c");
        const isPaste =
          (ev.ctrlKey && ev.shiftKey && key === "v") ||
          (ev.metaKey && !ev.shiftKey && key === "v");

        if (
          isMac &&
          ev.altKey &&
          !ev.metaKey &&
          !ev.ctrlKey &&
          (key === "arrowleft" || key === "arrowright")
        ) {
          ev.preventDefault();
          ev.stopPropagation();
          enqueueTerminalWrite(key === "arrowleft" ? "\u001bb" : "\u001bf");
          return false;
        }

        if (isCopy) {
          if (!term.hasSelection()) return true;
          ev.preventDefault();
          ev.stopPropagation();
          void clipboardWrite(term.getSelection());
          return false;
        }

        if (isPaste) {
          ev.preventDefault();
          ev.stopPropagation();
          void clipboardRead().then((text) => {
            if (!term || disposed) return;
            if (!text) return;
            term.paste(text);
          });
          return false;
        }

        return true;
      });

      selectionDisposable = term.onSelectionChange(() => {
        if (!term || disposed) return;
        if (!autoCopyRef.current) return;
        const selection = term.getSelection();
        if (!selection) {
          lastSelectionRef.current = "";
          return;
        }
        if (selection === lastSelectionRef.current) return;
        const now = Date.now();
        if (now - lastCopyAtRef.current < 120) return;
        lastSelectionRef.current = selection;
        lastCopyAtRef.current = now;
        void clipboardWrite(selection);
      });

      // Right click: open terminal menu.
      if (term.element) {
        const el = term.element;
        const onContextMenu = (ev: MouseEvent) => {
          if (!term) return;
          ev.preventDefault();
          ev.stopPropagation();
          setTermMenu({ x: ev.clientX, y: ev.clientY });
        };

        el.addEventListener("contextmenu", onContextMenu);
        removeContextMenu = () => el.removeEventListener("contextmenu", onContextMenu);
      }

      void connectNow();

      // Listen for terminal output from backend
      const unlisten = await listen<{ session_id: string; data: string }>(
        "terminal-output",
        (event) => {
          if (!term) return;
          if (event.payload.session_id === sessionId) {
            consumeAgentTerminalOutput(event.payload.data);
            const displayChunk = stripAgentInternalOutput(event.payload.data);
            if (displayChunk) {
              term.write(displayChunk);
              consumeSmartOutput(displayChunk);
            }
            lastOutputAtRef.current = Date.now();
            if (terminalIssueRef.current) {
              pushTerminalLog(
                "info",
                `output resumed bytes=${event.payload.data.length}`,
              );
              setTerminalIssue(null);
            }
          }
        },
      );
      unlistenOutput = unlisten;

      const unlistenDisconnectEvent = await listen<{
        session_id: string;
        reason: string;
      }>("terminal-disconnected", (event) => {
        if (disposed) return;
        if (event.payload.session_id !== sessionId) return;
        const pendingExec = agentTerminalExecutionRef.current;
        if (pendingExec) {
          finalizeAgentTerminalExecution(pendingExec, {
            exitCode: -1,
            stdout: stripAgentInternalOutput(pendingExec.output.trimEnd()).trimEnd(),
            stderr: event.payload.reason || "terminal disconnected",
            timedOut: false,
          });
        }
        pushTerminalLog("warn", `disconnected: ${event.payload.reason}`);
        setConnStatus("error");
        setConnError(t("terminal.session.disconnected"));
        if (!isLocal) {
          startReconnectFlow();
        }
      });
      unlistenDisconnect = unlistenDisconnectEvent;

      // Handle user input
      disposable = term.onData((data) => {
        lastInputAtRef.current = Date.now();
        consumeTerminalInput(data);
        enqueueTerminalWrite(data);
      });

      // Handle terminal resize
      const handleResize = () => {
        fitAndResize();
      };
      window.addEventListener("resize", handleResize);

      resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        // Next tick: let layout settle before fitting.
        setTimeout(() => {
          fitAndResize();
        }, 0);
      });
      if (paneRef.current) {
        resizeObserver.observe(paneRef.current);
      }

      // Live-update appearance without reconnecting.
      unlistenTheme = await store.onKeyChange<TerminalThemeName>(
        "terminal.theme",
        (v) => {
          if (!term || disposed) return;
          const next = v ?? DEFAULT_APP_SETTINGS["terminal.theme"];
          const theme = getXtermTheme(next);
          const baseBg = theme.background ?? "#0f111a";
          const hasBgImage = Boolean(terminalBgImageRef.current);
          const themeBg = hasBgImage ? "transparent" : baseBg;
          themeNameRef.current = next;
          setXtermBaseBg(baseBg);
          setXtermBg(themeBg);
          term.options.theme = { ...theme, background: themeBg };
          term.refresh(0, Math.max(0, term.rows - 1));
        },
      );
      unlistenFontSize = await store.onKeyChange<number>(
        "terminal.fontSize",
        (v) => {
          if (!term || disposed) return;
          const next = v ?? DEFAULT_APP_SETTINGS["terminal.fontSize"];
          term.options.fontSize = next;
          requestAnimationFrame(() => {
            fitAndResize();
          });
        },
      );
      unlistenFontFamily = await store.onKeyChange<string>(
        "terminal.fontFamily",
        (v) => {
          if (!term || disposed) return;
          const next = v ?? DEFAULT_APP_SETTINGS["terminal.fontFamily"];
          term.options.fontFamily = next;
          requestAnimationFrame(() => {
            fitAndResize();
          });
        },
      );
      unlistenFontWeight = await store.onKeyChange<number>(
        "terminal.fontWeight",
        (v) => {
          if (!term || disposed) return;
          term.options.fontWeight = v ?? DEFAULT_APP_SETTINGS["terminal.fontWeight"];
          requestAnimationFrame(() => {
            fitAndResize();
          });
        },
      );
      unlistenCursorStyle = await store.onKeyChange<
        "block" | "underline" | "bar"
      >("terminal.cursorStyle", (v) => {
        if (!term || disposed) return;
        term.options.cursorStyle = v ?? DEFAULT_APP_SETTINGS["terminal.cursorStyle"];
      });
      unlistenCursorBlink = await store.onKeyChange<boolean>(
        "terminal.cursorBlink",
        (v) => {
          if (!term || disposed) return;
          term.options.cursorBlink = v ?? DEFAULT_APP_SETTINGS["terminal.cursorBlink"];
        },
      );
      unlistenLineHeight = await store.onKeyChange<number>(
        "terminal.lineHeight",
        (v) => {
          if (!term || disposed) return;
          term.options.lineHeight = v ?? DEFAULT_APP_SETTINGS["terminal.lineHeight"];
          requestAnimationFrame(() => {
            fitAndResize();
          });
        },
      );
      unlistenAutoCopy = await store.onKeyChange<boolean>(
        "terminal.autoCopy",
        (v) => {
          autoCopyRef.current = v ?? DEFAULT_APP_SETTINGS["terminal.autoCopy"];
          if (!autoCopyRef.current) {
            lastSelectionRef.current = "";
          }
        },
      );
      unlistenBackgroundImage = await store.onKeyChange<string>(
        "terminal.backgroundImage",
        (v) => {
          if (!term || disposed) return;
          const next = v ?? DEFAULT_APP_SETTINGS["terminal.backgroundImage"];
          terminalBgImageRef.current = next;
          const themeName = themeNameRef.current;
          const theme = getXtermTheme(themeName);
          const baseBg = theme.background ?? "#0f111a";
          const hasBgImage = Boolean(next);
          const themeBg = hasBgImage ? "transparent" : baseBg;
          setXtermBaseBg(baseBg);
          setXtermBg(themeBg);
          term.options.theme = { ...theme, background: themeBg };
          term.refresh(0, Math.max(0, term.rows - 1));
          if (!next) {
            if (
              terminalBgObjectUrlRef.current &&
              terminalBgObjectUrlRef.current.startsWith("blob:")
            ) {
              URL.revokeObjectURL(terminalBgObjectUrlRef.current);
            }
            terminalBgObjectUrlRef.current = "";
            setTerminalBgImage("");
            return;
          }
          void loadTerminalBackgroundUrl(next).then((resolved) => {
            if (disposed) {
              if (resolved.startsWith("blob:")) {
                URL.revokeObjectURL(resolved);
              }
              return;
            }
            if (
              terminalBgObjectUrlRef.current &&
              terminalBgObjectUrlRef.current.startsWith("blob:") &&
              terminalBgObjectUrlRef.current !== resolved
            ) {
              URL.revokeObjectURL(terminalBgObjectUrlRef.current);
            }
            terminalBgObjectUrlRef.current =
              resolved.startsWith("blob:") ? resolved : "";
            setTerminalBgImage(resolved);
          });
        },
      );
      unlistenBackgroundOpacity = await store.onKeyChange<number>(
        "terminal.backgroundOpacity",
        (v) => {
          if (disposed) return;
          setTerminalBgOpacity(v ?? DEFAULT_APP_SETTINGS["terminal.backgroundOpacity"]);
        },
      );
      unlistenBackgroundBlur = await store.onKeyChange<number>(
        "terminal.backgroundBlur",
        (v) => {
          if (disposed) return;
          setTerminalBgBlur(v ?? DEFAULT_APP_SETTINGS["terminal.backgroundBlur"]);
        },
      );

      // Initial resize (after fonts are applied)
      setTimeout(() => {
        fitAndResize();
      }, 100);

      return () => {
        window.removeEventListener("resize", handleResize);
      };
    };

    let cleanupResizeListener: (() => void) | undefined;
    void init().then((cleanup) => {
      cleanupResizeListener = cleanup;
    });

    // Cleanup
    return () => {
      disposed = true;
      cleanupResizeListener?.();
      resizeObserver?.disconnect();
      disposable?.dispose();
      unlistenTheme?.();
      unlistenFontSize?.();
      unlistenFontFamily?.();
      unlistenOutput?.();
      unlistenDisconnect?.();
      removeContextMenu?.();
      unlistenFontWeight?.();
      unlistenCursorStyle?.();
      unlistenCursorBlink?.();
      unlistenLineHeight?.();
      unlistenAutoCopy?.();
      unlistenBackgroundImage?.();
      unlistenBackgroundOpacity?.();
      unlistenBackgroundBlur?.();
      selectionDisposable?.dispose();
      if (
        terminalBgObjectUrlRef.current &&
        terminalBgObjectUrlRef.current.startsWith("blob:")
      ) {
        URL.revokeObjectURL(terminalBgObjectUrlRef.current);
        terminalBgObjectUrlRef.current = "";
      }
      const pendingExec = agentTerminalExecutionRef.current;
      if (pendingExec) {
        finalizeAgentTerminalExecution(pendingExec, {
          exitCode: -1,
          stdout: stripAgentInternalOutput(pendingExec.output.trimEnd()).trimEnd(),
          stderr: "terminal session closed",
          timedOut: false,
        });
      }
      term?.dispose();
    };
  }, [sessionId]);

  useEffect(() => {
    if (isLocal) {
      setEndpointIp(t("terminal.endpoint.local"));
      setLatencyMs(null);
      return;
    }

    let disposed = false;
    let timer: number | null = null;

    const run = async () => {
      try {
        const info = await sshApi.checkEndpoint(host, port);
        if (disposed) return;
        setEndpointIp(info.ip);
        setLatencyMs(info.latency_ms);
      } catch {
        if (disposed) return;
        setLatencyMs(null);
      } finally {
        if (disposed) return;
        timer = window.setTimeout(run, 5000);
      }
    };

    run();

    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [host, port, isLocal, t]);

  useEffect(() => {
    setEndpointCopied(false);
  }, [endpointCopyText]);

  useEffect(
    () => () => {
      if (endpointCopyTimerRef.current) {
        window.clearTimeout(endpointCopyTimerRef.current);
      }
    },
    [],
  );

  const statusIcon = useMemo(() => {
    const connStatusMap: Record<ConnectionStatus, string> = {
      'connecting': 'dot-green dot-spin',
      'connected': 'dot-green',
      'error': 'dot-red dot-spin',
      'idle': 'dot-red',
    }
    return connStatusMap[connStatus];
  }, [connStatus, t]);

  const statusText = useMemo(() => {
    if (connStatus === "connecting") return t("terminal.status.connecting");
    if (connStatus === "connected") return t("terminal.status.connected");
    if (connStatus === "error") return t("terminal.status.error");
    return t("terminal.status.idle");
  }, [connStatus]);

  const terminalStyle = useMemo(() => {
    if (!xtermBg && !terminalBgImage) return undefined;
    const style: CSSProperties = {};
    const customStyle = style as Record<string, string>;
    if (xtermBg) {
      customStyle["--xterminal-xterm-bg"] = xtermBg;
    }
    if (terminalBgImage) {
      customStyle["--xterminal-bg-image"] = `url("${terminalBgImage}")`;
      customStyle["--xterminal-bg-overlay"] = toRgba(
        xtermBaseBg ?? "#0f111a",
        terminalBgOpacity,
      );
      customStyle["--xterminal-bg-blur"] = `${terminalBgBlur}px`;
    }
    return style;
  }, [terminalBgBlur, terminalBgImage, terminalBgOpacity, xtermBaseBg, xtermBg]);

  return (
    <>
      <div
        className={`xterminal${terminalBgImage ? " xterminal--bg" : ""}`}
        style={terminalStyle}
      >
      <div className="xterminal-topbar">
        <div className= {[
          "xterminal-topbar-left",
          `xterminal-topbar-left--${connStatus}`
        ].filter(Boolean).join(" ")}
          title={connError ?? undefined}>
          {/* 状态按钮 */}
          <span
            className={[
              "xterminal-topbar-status",
              connStatus === "connecting"
                ? "xterminal-topbar-status--spin"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-hidden="true"
          >
            <span className={[
              "dot",
              statusIcon,
            ].join(" ")}></span>
            {/* <AppIcon icon={statusIcon} size={18} /> */}
          </span>
          {/* 连接状态文本 */}
          <span className="xterminal-topbar-text">
            {statusText}
            {connStatus === "error" && connError ? `：${connError}` : ""}
          </span>
        </div>

        <div className="xterminal-topbar-right">
          {/* <span className="xterminal-topbar-meta">
            {host}:{port}
          </span> */}
          {!isSplit && onRequestSplit && (
            <>
              <button
                className="xterminal-topbar-btn"
                type="button"
                onClick={() => onRequestSplit("vertical")}
                title={t("terminal.split.vertical")}
                aria-label={t("terminal.split.vertical")}
              >
                <AppIcon icon="proicons:panel-right-open" size={18} />
              </button>
              <button
                className="xterminal-topbar-btn"
                type="button"
                onClick={() => onRequestSplit("horizontal")}
                title={t("terminal.split.horizontal")}
                aria-label={t("terminal.split.horizontal")}
              >
                <AppIcon icon="proicons:panel-bottom-open" size={18} />
              </button>
            </>
          )}
          <button
            className={`xterminal-topbar-btn ${sftpOpen ? "xterminal-topbar-btn--active" : ""}`}
            type="button"
            onClick={() => {
              const nextOpen = !sftpOpen;
              setSftpOpen(nextOpen);
              if (nextOpen) {
                void loadSftpEntries();
              }
            }}
            title={t("terminal.sftp.open")}
          >
            <AppIcon icon="proicons:folder-multiple" size={18} />
          </button>
          <button
            className={`xterminal-topbar-btn ${aiOpen ? "xterminal-topbar-btn--active" : ""}`}
            type="button"
            onClick={() => setAiOpen((prev) => !prev)}
            title={t("terminal.ai.toggle")}
          >
            <AppIcon icon="proicons:openai" size={18} />
          </button>
          {connStatus === "error" && (
            <button
              className="xterminal-topbar-btn"
              type="button"
              onClick={() => {
                void connectNow();
              }}
            >
              <AppIcon icon="material-symbols:refresh-rounded" size={18} />
              {t("terminal.reconnect")}
            </button>
          )}
        </div>
      </div>

      <div className="xterminal-body">
        {terminalIssue && (
          <div className="xterminal-alert">
            <div className="xterminal-alert-text">
              {terminalIssue.message}
            </div>
            <div className="xterminal-alert-actions">
              <button
                type="button"
                className="xterminal-alert-btn"
                onClick={() => void copyTerminalLog()}
              >
                {t("terminal.alert.copyLog")}
              </button>
              <button
                type="button"
                className="xterminal-alert-btn xterminal-alert-btn--ghost"
                onClick={() => setTerminalIssue(null)}
              >
                {t("terminal.alert.close")}
              </button>
            </div>
          </div>
        )}
        <div className="xterminal-pane" ref={paneRef}>
          <div className="xterminal-pad">
            <div className="xterminal-mount" ref={terminalRef} />
            {shouldShowQuickOverlay && (
              <section className="xterminal-quick-overlay">
                <div className="xterminal-quick-overlay-head">
                  <div className="xterminal-quick-overlay-title">
                    <AppIcon icon="material-symbols:terminal-rounded" size={15} />
                    {t("terminal.ai.quick.title")}
                  </div>
                </div>
                <div className="xterminal-quick-overlay-current">
                  {t("terminal.ai.quick.detected", { command: terminalQuickDraft })}
                </div>
                <div className="xterminal-quick-overlay-list">
                  {terminalQuickCommands.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="xterminal-quick-overlay-item"
                      onClick={() => handleApplyTerminalQuickCommand(item.insertText)}
                    >
                      <div className="xterminal-quick-overlay-command">{item.syntax}</div>
                      <div className="xterminal-quick-overlay-desc">{item.description}</div>
                    </button>
                  ))}
                </div>
                <div className="xterminal-quick-overlay-tip">{t("terminal.quick.overlay.tip")}</div>
              </section>
            )}
          </div>
          {sftpOpen && (
            <>
              <div
                className={`xterminal-resize-handle ${
                  resizing?.type === "sftp" ? "is-active" : ""
                }`}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setResizing({
                    type: "sftp",
                    startX: event.clientX,
                    startWidth: sftpWidth,
                  });
                }}
              />
              <div
                className={`xterminal-sftp ${sftpDragging ? "xterminal-sftp--dragging" : ""}`}
                style={{ width: sftpWidth }}
                ref={sftpPanelRef}
                onDragEnter={handleSftpDragEnter}
                onDragLeave={handleSftpDragLeave}
                onDragOver={handleSftpDragOver}
                onDrop={(event) => void handleSftpDrop(event)}
              >
                {sftpDragging && (
                  <div className="xterminal-sftp-drop-overlay">
                    <div className="xterminal-sftp-drop-content">
                      <AppIcon icon="material-symbols:upload-rounded" size={24} />
                      <span>{t("terminal.sftp.dropHint")}</span>
                    </div>
                  </div>
                )}
                <div className="xterminal-sftp-header">
                  <div className="xterminal-sftp-title">
                    {t("terminal.sftp.title")}
                  </div>
                  <div className="xterminal-sftp-actions">
                    <button
                      type="button"
                      className="xterminal-sftp-icon-btn"
                      onClick={handleFileSelect}
                      disabled={sftpLoading || !!uploadProgress}
                      title={t("terminal.sftp.action.upload")}
                    >
                      <AppIcon icon="material-symbols:upload-rounded" size={16} />
                    </button>
                    <button
                      type="button"
                      className="xterminal-sftp-icon-btn"
                      onClick={() => void loadSftpEntries()}
                      disabled={sftpLoading}
                      title={t("terminal.sftp.action.refresh")}
                    >
                      <AppIcon icon="material-symbols:refresh-rounded" size={16} />
                    </button>
                    <button
                      type="button"
                      className="xterminal-sftp-icon-btn"
                      onClick={() => setSftpOpen(false)}
                      title={t("terminal.sftp.action.close")}
                    >
                      <AppIcon icon="material-symbols:close-rounded" size={16} />
                    </button>
                  </div>
                </div>

              <div className="xterminal-sftp-pathbar">
                <button
                  type="button"
                  className="xterminal-sftp-icon-btn"
                  onClick={() => {
                    const currentPath = sftpPath || "/";
                    const parts = currentPath.split("/").filter((p) => p);
                    if (parts.length > 0) {
                      parts.pop();
                      const newPath = parts.length > 0 ? "/" + parts.join("/") : "/";
                      void loadSftpEntries(newPath);
                    }
                  }}
                  disabled={sftpLoading || sftpPath === "/" || !sftpPath}
                  title={t("terminal.sftp.action.up")}
                >
                  <AppIcon icon="material-symbols:keyboard-return-rounded" size={16} />
                </button>
                <div className="xterminal-sftp-path-input">
                  <input
                    type="text"
                    value={sftpPath}
                    onChange={(event) => setSftpPath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void loadSftpEntries();
                      }
                    }}
                    placeholder="/"
                  />
                </div>
              </div>

              <div className="xterminal-sftp-table-header">
                <span className="xterminal-sftp-check" aria-hidden="true" />
                <span className="xterminal-sftp-col-name">
                  {t("terminal.sftp.col.name")}
                </span>
                <span className="xterminal-sftp-col-size">
                  {t("terminal.sftp.col.size")}
                </span>
              </div>
              {uploadProgress && (
                <div className="xterminal-sftp-progress">
                  {uploadProgress}
                </div>
              )}
              <div
                className="xterminal-sftp-body"
                onPointerDown={(event) => {
                  if (event.button !== 2) return;
                  if (isSftpItemTarget(event.target)) return;
                  openSftpMenu(event, null);
                }}
                onContextMenu={(event) => {
                  if (isSftpItemTarget(event.target)) return;
                  openSftpMenu(event, null);
                }}
              >
                {sftpLoading && (
                  <div className="xterminal-sftp-state xterminal-sftp-state--loading">
                    <AppIcon
                        className="xterminal-sftp-loading-icon"
                        icon="material-symbols:refresh"
                        size={16}
                    />
                    <span>{t("terminal.sftp.loading")}</span>
                    </div>
                )}
                {!sftpLoading && sftpError && (
                  <div className="xterminal-sftp-state xterminal-sftp-state--error">
                    {sftpError}
                    <button
                      type="button"
                      className="xterminal-sftp-error-close"
                      onClick={() => setSftpError(null)}
                    >
                      ×
                    </button>
                  </div>
                )}
                {!sftpLoading && !sftpError && sftpEntries.length === 0 && (
                  <div className="xterminal-sftp-state">
                    {t("terminal.sftp.empty")}
                  </div>
                )}
                {!sftpLoading && !sftpError && sftpEntries.length > 0 && (
                  <ul className="xterminal-sftp-list">
                    {sftpEntries.map((entry) => (
                      <li
                        key={entry.name}
                        className={`xterminal-sftp-item ${entry.is_dir ? "xterminal-sftp-item--dir" : "xterminal-sftp-item--file"}`}
                        onClick={() => handleEntryClick(entry)}
                        onPointerDown={(event) => {
                          if (event.button !== 2) return;
                          openSftpMenu(event, entry);
                        }}
                        onContextMenu={(event) => openSftpMenu(event, entry)}
                      >
                        <span className="xterminal-sftp-check" aria-hidden="true" />
                        <span className="xterminal-sftp-icon" aria-hidden="true">
                          <AppIcon
                            icon={
                              entry.is_dir
                                ? "material-symbols:folder-rounded"
                                : "material-symbols:description-rounded"
                            }
                            size={16}
                          />
                        </span>
                        <span className="xterminal-sftp-name">{entry.name}</span>
                        {typeof entry.size === "number" && !entry.is_dir && (
                          <span className="xterminal-sftp-meta">
                            {entry.size.toLocaleString()} B
                          </span>
                        )}
                        {entry.is_dir && <span className="xterminal-sftp-meta">-</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {sftpMenu && (
                <div
                  className="xterminal-sftp-menu"
                  style={{ top: sftpMenu.y, left: sftpMenu.x }}
                  ref={sftpMenuRef}
                >
                  {!sftpMenu.entry && (
                    <>
                      <button
                        type="button"
                        className="xterminal-sftp-menu-item"
                        onClick={() => {
                          void handleFileSelect();
                          setSftpMenu(null);
                        }}
                      >
                        <AppIcon icon="material-symbols:upload-rounded" size={16} />
                        {t("terminal.sftp.menu.upload")}
                      </button>
                      <button
                        type="button"
                        className="xterminal-sftp-menu-item"
                        onClick={() => {
                          void loadSftpEntries();
                          setSftpMenu(null);
                        }}
                      >
                        <AppIcon icon="material-symbols:refresh-rounded" size={16} />
                        {t("terminal.sftp.menu.refresh")}
                      </button>
                    </>
                  )}
                  {sftpMenu.entry && (
                    <>
                      <button
                        type="button"
                        className="xterminal-sftp-menu-item"
                        onClick={() => {
                          if (!sftpMenu.entry) return;
                          openRename(sftpMenu.entry);
                          setSftpMenu(null);
                        }}
                      >
                        <AppIcon icon="material-symbols:edit-outline-rounded" size={16} />
                        {t("terminal.sftp.menu.rename")}
                      </button>
                      <button
                        type="button"
                        className="xterminal-sftp-menu-item"
                        onClick={() => {
                          if (!sftpMenu.entry) return;
                          openChmod(sftpMenu.entry);
                          setSftpMenu(null);
                        }}
                      >
                        <AppIcon icon="material-symbols:lock-person-outline-rounded" size={16} />
                        {t("terminal.sftp.menu.chmod")}
                      </button>
                      <button
                        type="button"
                        className="xterminal-sftp-menu-item"
                        onClick={async () => {
                          if (!sftpMenu.entry) return;
                          const path = buildRemotePath(sftpMenu.entry.name);
                          try {
                            await navigator.clipboard.writeText(path);
                          } catch {
                            // ignore
                          }
                          setSftpMenu(null);
                        }}
                      >
                        <AppIcon icon="material-symbols:content-copy-outline-rounded" size={16} />
                        {t("terminal.sftp.menu.copyPath")}
                      </button>
                      {!sftpMenu.entry.is_dir && (
                        <button
                          type="button"
                          className="xterminal-sftp-menu-item"
                          onClick={() => {
                            if (!sftpMenu.entry) return;
                            void handleDownloadFile(sftpMenu.entry);
                            setSftpMenu(null);
                          }}
                        >
                          <AppIcon icon="material-symbols:download-rounded" size={16} />
                          {t("terminal.sftp.menu.download")}
                        </button>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className="xterminal-sftp-menu-item"
                    onClick={() => {
                      setNewFolderOpen(true);
                      setNewFolderName("");
                      setSftpActionError(null);
                      setSftpMenu(null);
                    }}
                  >
                    <AppIcon icon="material-symbols:create-new-folder-outline-rounded" size={16} />
                    {t("terminal.sftp.menu.newFolder")}
                  </button>
                  {sftpMenu.entry && (
                    <button
                      type="button"
                      className="xterminal-sftp-menu-item xterminal-sftp-menu-item--danger"
                      onClick={() => {
                        if (!sftpMenu.entry) return;
                        void handleDeleteEntry(sftpMenu.entry);
                        setSftpMenu(null);
                      }}
                    >
                      <AppIcon icon="material-symbols:delete-outline-rounded" size={16} />
                      {t("common.delete")}
                    </button>
                  )}
                </div>
              )}
            </div>
            </>
          )}
          {aiOpen && (
            <>
              <div
                className={`xterminal-resize-handle ${
                  resizing?.type === "ai" ? "is-active" : ""
                }`}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setResizing({
                    type: "ai",
                    startX: event.clientX,
                    startWidth: aiWidth,
                  });
                }}
              />
              <div className="xterminal-ai" style={{ width: aiWidth }}>
                <div className="xterminal-ai-header">
                  <div className="xterminal-ai-header-main">
                    <div className="xterminal-ai-title">
                      {t(
                        agentMode === "confirm_then_execute"
                          ? "terminal.ai.title.agent"
                          : "terminal.ai.title.chat",
                      )}
                    </div>
                    <div className="xterminal-agent-mode" role="group" aria-label="agent mode">
                      <button
                        type="button"
                        className={`xterminal-agent-mode-btn${
                          agentMode === "suggest_only" ? " is-active" : ""
                        }`}
                        onClick={() => {
                          void handleAgentModeChange("suggest_only");
                        }}
                        disabled={aiBusy}
                      >
                        {t("terminal.agent.mode.suggest")}
                      </button>
                      <button
                        type="button"
                        className={`xterminal-agent-mode-btn${
                          agentMode === "confirm_then_execute" ? " is-active" : ""
                        }`}
                        onClick={() => {
                          void handleAgentModeChange("confirm_then_execute");
                        }}
                        disabled={aiBusy}
                      >
                        {t("terminal.agent.mode.confirm")}
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="xterminal-ai-close"
                    onClick={() => setAiOpen(false)}
                    title={t("common.close")}
                  >
                    <AppIcon icon="proicons:cancel" size={16} />
                  </button>
              </div>
              <div className="xterminal-ai-body">
                <div
                  className="xterminal-ai-history"
                  ref={aiHistoryRef}
                  onScroll={updateAiAutoStickFlag}
                >
                  {hasAiInsights && (
                    <div className="xterminal-ai-insights">
                      {smartTable && (
                        <section className="xterminal-ai-card">
                          <div className="xterminal-ai-card-head">
                            <div className="xterminal-ai-card-title">
                              <AppIcon icon="material-symbols:table-view-rounded" size={15} />
                              {t("terminal.ai.smartTable.title")}
                            </div>
                            <span className="xterminal-ai-card-time">
                              {new Date(smartTable.updatedAt).toLocaleTimeString()}
                            </span>
                          </div>
                          <div className="xterminal-ai-card-subtitle">
                            {t("terminal.ai.smartTable.command", { command: smartTable.command })}
                          </div>
                          {smartTable.kind === "docker-ps" ? (
                            <div className="xterminal-ai-table">
                              <div className="xterminal-ai-table-head xterminal-ai-table-head--docker">
                                <span>{t("terminal.ai.table.docker.name")}</span>
                                <span>{t("terminal.ai.table.docker.image")}</span>
                                <span>{t("terminal.ai.table.docker.status")}</span>
                                <span>{t("terminal.ai.table.docker.ports")}</span>
                              </div>
                              <div className="xterminal-ai-table-body">
                                {smartTable.rows.map((row) => (
                                  <button
                                    key={row.id}
                                    type="button"
                                    className="xterminal-ai-table-row xterminal-ai-table-row--docker"
                                    onClick={(event) =>
                                      openSmartMenu(event, {
                                        kind: "docker-ps",
                                        row,
                                        x: event.clientX,
                                        y: event.clientY,
                                      })
                                    }
                                  >
                                    <span>{row.name || row.containerId}</span>
                                    <span>{row.image || "--"}</span>
                                    <span>{row.status || "--"}</span>
                                    <span>{row.ports || "--"}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="xterminal-ai-table">
                              <div className="xterminal-ai-table-head xterminal-ai-table-head--ls">
                                <span>{t("terminal.ai.table.ls.name")}</span>
                                <span>{t("terminal.ai.table.ls.mode")}</span>
                                <span>{t("terminal.ai.table.ls.size")}</span>
                                <span>{t("terminal.ai.table.ls.modified")}</span>
                              </div>
                              <div className="xterminal-ai-table-body">
                                {smartTable.rows.map((row) => (
                                  <button
                                    key={row.id}
                                    type="button"
                                    className="xterminal-ai-table-row xterminal-ai-table-row--ls"
                                    onClick={(event) =>
                                      openSmartMenu(event, {
                                        kind: "ls",
                                        row,
                                        x: event.clientX,
                                        y: event.clientY,
                                      })
                                    }
                                  >
                                    <span>{row.name}</span>
                                    <span>{row.mode}</span>
                                    <span>{row.size}</span>
                                    <span>{row.modified}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </section>
                      )}
                      {logSummaries.length > 0 && (
                        <section className="xterminal-ai-card xterminal-ai-card--log">
                          <div className="xterminal-ai-card-head">
                            <div className="xterminal-ai-card-title">
                              <AppIcon icon="material-symbols:analytics-rounded" size={15} />
                              {t("terminal.ai.logSummary.title")}
                            </div>
                          </div>
                          <div className="xterminal-ai-log-list">
                            {[...logSummaries].reverse().map((item) => (
                              <div key={item.id} className="xterminal-ai-log-item">
                                <div className="xterminal-ai-log-time">
                                  {new Date(item.ts).toLocaleTimeString()}
                                </div>
                                <div className="xterminal-ai-log-text">
                                  {t("terminal.ai.logSummary.line", {
                                    loginFailed: item.loginFailed,
                                    dbTimeout: item.dbTimeout,
                                    errorCount: item.errorCount,
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        </section>
                      )}
                    </div>
                  )}
                  {aiMessages.length === 0 && !hasAiInsights && (
                    <div className="xterminal-ai-empty">
                      {t("terminal.ai.empty")}
                    </div>
                  )}
                  {aiMessages.map((msg, index) => {
                    const prev = aiMessages[index - 1];
                    const grouped = prev && prev.role === msg.role;
                    const plan = msg.agentPlan;
                    const showThinking =
                      msg.role === "assistant" &&
                      !plan &&
                      !msg.content.trim();
                    const hasBlockedActions =
                      !!plan?.actions.some((action) => action.status === "blocked");
                    const hasRunnableActions =
                      !!plan?.actions.some(
                        (action) =>
                          action.status === "pending" ||
                          action.status === "approved" ||
                          action.status === "blocked",
                      );
                    return (
                    <div
                      key={msg.id}
                      className={`xterminal-ai-message xterminal-ai-message--${msg.role}${grouped ? " xterminal-ai-message--grouped" : ""}`}
                    >
                      <div className="xterminal-ai-content">
                        {showThinking ? (
                          <div className="xterminal-ai-thinking">
                            <span className="xterminal-ai-thinking-dot" aria-hidden="true" />
                            <span>{t("terminal.ai.thinking")}</span>
                          </div>
                        ) : (
                          <AiRenderer content={msg.content} sessionId={sessionId} useLocal={isLocal} role={msg.role} />
                        )}
                      </div>
                      {plan && (
                        <div className="xterminal-agent-plan">
                          <div className="xterminal-agent-plan-head">
                            <div className="xterminal-agent-plan-title">
                              {t("terminal.agent.card.title")}
                            </div>
                            <div className="xterminal-agent-plan-actions">
                              <button
                                type="button"
                                className={`xterminal-agent-plan-btn${
                                  hasBlockedActions ? " xterminal-agent-plan-btn--danger" : ""
                                }`}
                                onClick={() => {
                                  if (hasBlockedActions) {
                                    openForceRunDialog(msg.id);
                                    return;
                                  }
                                  void runRemainingAgentActions(msg.id);
                                }}
                                disabled={
                                  agentMode !== "confirm_then_execute" ||
                                  plan.status === "running" ||
                                  !hasRunnableActions ||
                                  plan.actions.some((action) => action.status === "running")
                                }
                              >
                                {t("terminal.agent.plan.executeRemaining")}
                              </button>
                              <button
                                type="button"
                                className="xterminal-agent-plan-btn xterminal-agent-plan-btn--ghost"
                                onClick={() => stopRemainingAgentActions(msg.id)}
                                disabled={
                                  plan.status !== "running" &&
                                  !plan.actions.some((action) => action.status === "running")
                                }
                              >
                                {t("terminal.agent.plan.stopRemaining")}
                              </button>
                            </div>
                          </div>
                          <div className="xterminal-agent-plan-summary">
                            {t("terminal.agent.card.summary", {
                              summary: plan.summary,
                            })}
                          </div>
                          <div className="xterminal-agent-plan-session">
                            {t("terminal.agent.card.session", {
                              sessionId: plan.session_id,
                            })}
                          </div>
                          {plan.actions.length === 0 && (
                            <div className="xterminal-agent-plan-empty">
                              {t("terminal.agent.card.empty")}
                            </div>
                          )}
                          {plan.actions.map((action, actionIndex) => (
                            <div
                              key={action.id}
                              className={`xterminal-agent-action xterminal-agent-action--${action.status}`}
                            >
                              <div className="xterminal-agent-action-head">
                                <div className="xterminal-agent-action-index">
                                  #{actionIndex + 1}
                                </div>
                                <div className="xterminal-agent-action-badges">
                                  <span className={`xterminal-agent-risk xterminal-agent-risk--${action.risk}`}>
                                    {riskLevelLabel(action.risk)}
                                  </span>
                                  <span className={`xterminal-agent-status xterminal-agent-status--${action.status}`}>
                                    {actionStatusLabel(action.status)}
                                  </span>
                                </div>
                              </div>

                              <pre className="xterminal-agent-command-readonly">
                                {action.edited_command}
                              </pre>

                              <div className="xterminal-agent-action-meta">
                                <span>
                                  {t("terminal.agent.action.policy", {
                                    value: `${policyStatusLabel(action.policy.status)} / ${action.policy.reason}`,
                                  })}
                                </span>
                                <span>
                                  {t("terminal.agent.action.timeout", { value: action.timeout_sec })}
                                </span>
                              </div>
                              {!!action.reason && (
                                <div className="xterminal-agent-action-text">
                                  {t("terminal.agent.action.reason", { value: action.reason })}
                                </div>
                              )}
                              {!!action.expected_effect && (
                                <div className="xterminal-agent-action-text">
                                  {t("terminal.agent.action.expected", {
                                    value: action.expected_effect,
                                  })}
                                </div>
                              )}

                              {!!action.execution_note && (
                                <div className="xterminal-agent-action-note">
                                  {action.execution_note}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                  })}
                  {latestAgentPlanForActivity &&
                    !latestAgentPlanForActivity.final_report_ready &&
                    (latestAgentPlanForActivity.thinking ||
                      (latestAgentPlanForActivity.activities?.length || 0) > 0) && (
                    <section className="xterminal-agent-activity-panel" aria-live="polite">
                      <div className="xterminal-agent-activity-title">
                        {t("terminal.agent.activity.title")}
                      </div>
                      {latestAgentPlanForActivity.thinking && (
                        <div className="xterminal-agent-plan-thinking" role="status" aria-live="polite">
                          <span
                            className="xterminal-agent-plan-thinking-dot"
                            aria-hidden="true"
                          />
                          <span>{t("terminal.agent.activity.thinkingStatus")}</span>
                        </div>
                      )}
                      {(latestAgentPlanForActivity.activities?.length || 0) > 0 && (
                        <div
                          className="xterminal-agent-activity-list"
                          role="log"
                          aria-live="polite"
                          ref={agentActivityListRef}
                        >
                          {(latestAgentPlanForActivity.activities || []).map((activity) => (
                            <div
                              key={activity.id}
                              className={`xterminal-agent-activity-item xterminal-agent-activity-item--${activity.tone}`}
                            >
                              <span className="xterminal-agent-activity-time">
                                {formatAgentActivityTime(activity.ts)}
                              </span>
                              <span className="xterminal-agent-activity-text">
                                {activity.text}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  )}
                </div>
                {aiError && <div className="xterminal-ai-error">{aiError}</div>}
                <div className="xterminal-ai-input">
                  <div className="xterminal-ai-input-box">
                    <textarea
                      value={aiInput}
                      onChange={(event) => setAiInput(event.target.value)}
                      placeholder={t("terminal.ai.input.placeholder", {
                        modifier: modifierKeyAbbr,
                      })}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                          event.preventDefault();
                          void sendAiMessage(aiInput);
                          setAiInput("");
                        }
                      }}
                      disabled={aiBusy}
                    />
                    <div className="xterminal-ai-input-footer">
                      <div className="xterminal-ai-input-meta">
                        <div className="xterminal-ai-model-dropdown" ref={aiModelMenuRef}>
                          <button
                            type="button"
                            className={`xterminal-ai-model-pill${aiModelMenuOpen ? " xterminal-ai-model-pill--open" : ""}`}
                            onClick={() => setAiModelMenuOpen((prev) => !prev)}
                            disabled={aiBusy}
                            aria-haspopup="listbox"
                            aria-expanded={aiModelMenuOpen}
                          >
                            <AppIcon
                              className="xterminal-ai-model-icon"
                              icon="proicons:egg-fried"
                              size={16}
                            />
                            <span className="xterminal-ai-model-value">
                              {aiModel || t("terminal.ai.model.placeholder")}
                            </span>
                            <AppIcon
                              className="xterminal-ai-model-caret"
                              icon="material-symbols:keyboard-arrow-down-rounded"
                              size={16}
                            />
                          </button>
                          {aiModelMenuOpen && (
                            <div className="xterminal-ai-model-menu" role="listbox">
                              {modelOptionsWithCurrent.map((model) => (
                                <button
                                  key={model}
                                  type="button"
                                  className={`xterminal-ai-model-item${model === aiModel ? " is-active" : ""}`}
                                  onClick={() => {
                                    aiModelTouchedRef.current = true;
                                    setAiModel(model);
                                    setAiModelMenuOpen(false);
                                  }}
                                  role="option"
                                  aria-selected={model === aiModel}
                                >
                                  {model}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="xterminal-ai-input-actions">
                        <button
                          type="button"
                          className="xterminal-ai-footer-icon-btn"
                          onClick={clearAiConversationContext}
                          title={t("terminal.ai.clearContext")}
                          aria-label={t("terminal.ai.clearContext")}
                        >
                          <AppIcon icon="proicons:delete" size={16} />
                        </button>
                        <button
                          type="button"
                          className="xterminal-ai-footer-icon-btn xterminal-ai-footer-icon-btn--danger"
                          onClick={interruptAiConversation}
                          disabled={!aiBusy}
                          title={t("terminal.ai.stop")}
                          aria-label={t("terminal.ai.stop")}
                        >
                          <AppIcon icon="proicons:record-stop" size={16} />
                        </button>
                        <button
                          type="button"
                          className="xterminal-ai-send"
                          onClick={() => {
                            void sendAiMessage(aiInput);
                            setAiInput("");
                          }}
                          disabled={aiBusy || !aiInput.trim()}
                          title={t("terminal.ai.send")}
                          aria-label={t("terminal.ai.send")}
                        >
                          <AppIcon icon="proicons:send" size={16}/>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              </div>
            </>
          )}
        </div>

        <div className="xterminal-toolbar">
          <div className="xterminal-toolbar-item">
            <AppIcon icon="proicons:globe" size={16} />
            <span className="xterminal-toolbar-label">
              {t("terminal.toolbar.latency")}
            </span>
            <span
              className={`xterminal-toolbar-value xterminal-latency xterminal-latency--${latencyTone}`}
            >
              {latencyMs === null ? "--" : `${latencyMs} ms`}
            </span>
          </div>

          <span className="xterminal-toolbar-dot" aria-hidden="true" />

          <div
            className="xterminal-toolbar-item"
            style={{ flex: 1, minWidth: 0 }}
          >
            <AppIcon icon="proicons:server" size={16} />
            <span className="xterminal-toolbar-label">
              {t("terminal.toolbar.endpoint")}
            </span>
            <button
              type="button"
              className={`xterminal-toolbar-value xterminal-toolbar-value--copy ${
                endpointCopied ? "is-copied" : ""
              }`}
              onClick={() => void handleCopyEndpoint()}
              disabled={!endpointCopyText}
              title={endpointCopyLabel}
              aria-label={endpointCopyLabel}
            >
              {endpointLabel}
            </button>
          </div>

          <button
            type="button"
            className="xterminal-toolbar-btn"
            onClick={toggleScriptPanel}
            title={t("terminal.toolbar.script")}
          >
            <AppIcon icon="proicons:terminal" size={16} />
            {t("terminal.toolbar.quickActions")}
          </button>
          <button
            type="button"
            className={`xterminal-toolbar-btn ${transferPanelOpen ? "xterminal-toolbar-btn--active" : ""}`}
            onClick={toggleTransferPanel}
            title={t("terminal.transfer.title")}
          >
            <AppIcon icon="proicons:arrow-download" size={16} />
            {t("terminal.transfer.title")}
            {(runningTransferCount > 0 || failedTransferCount > 0) && (
              <span
                className={`xterminal-transfer-badge ${
                  failedTransferCount > 0 ? "xterminal-transfer-badge--error" : ""
                }`}
              >
                {failedTransferCount > 0 ? failedTransferCount : runningTransferCount}
              </span>
            )}
          </button>
        </div>

        {scriptPanelOpen && (
          <div className="xterminal-script-panel">
            <div className="xterminal-script-header">
              <div className="xterminal-script-actions">
                <button
                  type="button"
                  className="xterminal-script-link"
                  onClick={() => setScriptPickerOpen(true)}
                >
                  <AppIcon icon="proicons:terminal" size={16} />
                  {t("terminal.script.library")}
                </button>
                <button
                  type="button"
                  className="xterminal-script-link"
                  onClick={() => setScriptText("")}
                >
                  <AppIcon icon="proicons:delete" size={16} />
                  {t("terminal.script.clear")}
                </button>
              </div>
              <div className="xterminal-script-target">
                <span>{t("terminal.script.sendTo")}</span>
                <Select
                  value={scriptTarget}
                  onChange={(nextValue) =>
                    setScriptTarget(nextValue as "current" | "all")
                  }
                  options={[
                    {
                      value: "current",
                      label: t("terminal.script.target.current"),
                    },
                    { value: "all", label: t("terminal.script.target.all") },
                  ]}
                />
              </div>
            </div>
            <div className="xterminal-script-body">
              <textarea
                value={scriptText}
                onChange={(event) => setScriptText(event.target.value)}
                placeholder={t("terminal.script.placeholder", {
                  modifier: modifierKeyAbbr,
                })}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void handleSendScript();
                  }
                }}
              />
              <button
                type="button"
                className="xterminal-script-send"
                onClick={() => void handleSendScript()}
              >
                {t("terminal.script.run")}
                <span className="xterminal-script-shortcut">{modifierKeyLabel} Enter</span>
              </button>
            </div>
          </div>
        )}
        {transferPanelOpen && (
          <div className="xterminal-transfer-panel">
            <div className="xterminal-transfer-header">
              <div className="xterminal-transfer-title">
                {t("terminal.transfer.title")}
              </div>
              <div className="xterminal-transfer-actions">
                <span className="xterminal-transfer-summary">
                  {t("terminal.transfer.summary", {
                    running: runningTransferCount,
                    failed: failedTransferCount,
                  })}
                </span>
                <button
                  type="button"
                  className="xterminal-script-link"
                  onClick={clearTransferHistory}
                  disabled={transferTasks.length === 0}
                >
                  <AppIcon icon="material-symbols:delete-outline-rounded" size={16} />
                  {t("terminal.transfer.clear")}
                </button>
              </div>
            </div>
            {transferTasks.length === 0 ? (
              <div className="xterminal-transfer-empty">
                {t("terminal.transfer.empty")}
              </div>
            ) : (
              <div className="xterminal-transfer-list">
                {transferTasks.map((task) => (
                  <div
                    key={task.id}
                    className={`xterminal-transfer-item xterminal-transfer-item--${task.status}`}
                  >
                    <div className="xterminal-transfer-row">
                      <div className="xterminal-transfer-name">
                        <AppIcon
                          icon={
                            task.direction === "upload"
                              ? "material-symbols:upload-rounded"
                              : "material-symbols:download-rounded"
                          }
                          size={16}
                        />
                        <span>{task.name}</span>
                      </div>
                      <span
                        className={`xterminal-transfer-status xterminal-transfer-status--${task.status}`}
                      >
                        {transferStatusLabel(task.status)}
                      </span>
                    </div>
                    <div className="xterminal-transfer-meta">
                      {t("terminal.transfer.meta", {
                        direction: transferDirectionLabel(task.direction),
                        start: formatTransferTime(task.startedAt),
                        endSuffix: task.finishedAt
                          ? t("terminal.transfer.finishedAt", {
                              time: formatTransferTime(task.finishedAt),
                            })
                          : "",
                      })}
                    </div>
                    <div className="xterminal-transfer-path">
                      {t("terminal.transfer.source", { path: task.sourcePath })}
                    </div>
                    <div className="xterminal-transfer-path">
                      {t("terminal.transfer.target", { path: task.targetPath })}
                    </div>
                    <div className="xterminal-transfer-progressbar">
                      <span
                        className={`xterminal-transfer-progressvalue xterminal-transfer-progressvalue--${task.status}`}
                        style={{ width: `${task.progress}%` }}
                      />
                    </div>
                    {task.detail && (
                      <div className="xterminal-transfer-detail">{task.detail}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      </div>

        {termMenu &&
          createPortal(
            <div
              className="xterminal-term-menu-layer"
              onMouseDown={handleTermMenuClose}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <div
                className="xterminal-term-menu"
                ref={termMenuRef}
                style={{ left: termMenu.x, top: termMenu.y }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                <button
                  type="button"
                  className="xterminal-term-menu-item"
                  onClick={() => void handleTermCopy()}
                  disabled={!terminalInstance.current?.hasSelection()}
                >
                  <AppIcon icon="proicons:copy" size={16} />
                  {t("terminal.menu.copy")}
                </button>
                <button
                  type="button"
                  className="xterminal-term-menu-item"
                  onClick={() => void handleTermPaste()}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onMouseUp={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <AppIcon icon="proicons:clipboard-paste" size={16} />
                  {t("terminal.menu.paste")}
                </button>
                <button
                  type="button"
                  className="xterminal-term-menu-item"
                  onClick={handleTermClear}
                >
                  <AppIcon icon="proicons:delete" size={16} />
                  {t("terminal.menu.clear")}
                </button>
                <div className="xterminal-term-menu-divider" />
                <button
                  type="button"
                  className="xterminal-term-menu-item"
                  onClick={() => void openAiFromTerminal("fix")}
                >
                  <AppIcon icon="proicons:wrench" size={16} />
                  {t("terminal.menu.ai.fix")}
                </button>
                <button
                  type="button"
                  className="xterminal-term-menu-item"
                  onClick={() => void openAiFromTerminal("ask")}
                >
                  <AppIcon icon="proicons:egg-fried" size={16} />
                  {t("terminal.menu.ai.ask")}
                </button>
              </div>
            </div>,
            document.body,
          )}
        {smartMenu &&
          createPortal(
            <div
              className="xterminal-term-menu-layer"
              onMouseDown={handleSmartMenuClose}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <div
                className="xterminal-term-menu xterminal-smart-menu"
                ref={smartMenuRef}
                style={{ left: smartMenu.x, top: smartMenu.y }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                {smartMenu.kind === "docker-ps" ? (
                  <>
                    <button
                      type="button"
                      className="xterminal-term-menu-item"
                      onClick={() => handleSmartStopContainer(smartMenu.row)}
                    >
                      <AppIcon icon="material-symbols:stop-circle-outline-rounded" size={16} />
                      {t("terminal.ai.smartMenu.stopContainer")}
                    </button>
                    <button
                      type="button"
                      className="xterminal-term-menu-item"
                      onClick={() => {
                        void clipboardWrite(smartMenu.row.containerId);
                        setSmartMenu(null);
                      }}
                    >
                      <AppIcon icon="material-symbols:content-copy-outline-rounded" size={16} />
                      {t("terminal.ai.smartMenu.copyContainerId")}
                    </button>
                  </>
                ) : (
                  <>
                    {smartMenu.row.entryType === "dir" ? (
                      <button
                        type="button"
                        className="xterminal-term-menu-item"
                        onClick={() => handleSmartEnterDir(smartMenu.row)}
                      >
                        <AppIcon icon="material-symbols:folder-open-rounded" size={16} />
                        {t("terminal.ai.smartMenu.enterDir")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="xterminal-term-menu-item"
                        onClick={() => handleSmartEditFile(smartMenu.row)}
                      >
                        <AppIcon icon="material-symbols:edit-square-outline-rounded" size={16} />
                        {t("terminal.ai.smartMenu.editFile")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="xterminal-term-menu-item"
                      onClick={() => {
                        void clipboardWrite(stripSymlinkSuffix(smartMenu.row.name).trim());
                        setSmartMenu(null);
                      }}
                    >
                      <AppIcon icon="material-symbols:content-copy-outline-rounded" size={16} />
                      {t("terminal.ai.smartMenu.copyFileName")}
                    </button>
                  </>
                )}
              </div>
            </div>,
            document.body,
          )}
      <Modal
        open={!!renameEntry}
        title={
          renameEntry
            ? t("terminal.sftp.rename.titleWithName", { name: renameEntry.name })
            : t("terminal.sftp.rename.title")
        }
        onClose={() => {
          setRenameEntry(null);
          setSftpActionError(null);
        }}
        width={420}
      >
        <div className="xterminal-sftp-modal">
          <div className="form-group">
            <label>{t("terminal.sftp.rename.label")}</label>
            <input
              type="text"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleRenameSubmit();
                }
              }}
              placeholder={t("terminal.sftp.rename.placeholder")}
            />
          </div>
          {sftpActionError && (
            <div className="xterminal-sftp-modal-error">{sftpActionError}</div>
          )}
          <div className="xterminal-sftp-modal-actions">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void handleRenameSubmit()}
              disabled={sftpActionBusy}
            >
              {t("common.save")}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setRenameEntry(null);
                setSftpActionError(null);
              }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!chmodEntry}
        title={
          chmodEntry
            ? t("terminal.sftp.chmod.titleWithName", { name: chmodEntry.name })
            : t("terminal.sftp.chmod.title")
        }
        onClose={() => {
          setChmodEntry(null);
          setSftpActionError(null);
        }}
        width={420}
      >
        <div className="xterminal-sftp-modal">
          <div className="form-group">
            <label>{t("terminal.sftp.chmod.label")}</label>
            <input
              type="text"
              value={chmodValue}
              onChange={(event) => setChmodValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleChmodSubmit();
                }
              }}
              placeholder={t("terminal.sftp.chmod.placeholder")}
            />
            <div className="xterminal-sftp-modal-hint">
              {t("terminal.sftp.chmod.hint")}
            </div>
          </div>
          {sftpActionError && (
            <div className="xterminal-sftp-modal-error">{sftpActionError}</div>
          )}
          <div className="xterminal-sftp-modal-actions">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void handleChmodSubmit()}
              disabled={sftpActionBusy}
            >
              {t("common.save")}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setChmodEntry(null);
                setSftpActionError(null);
              }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={newFolderOpen}
        title={t("terminal.sftp.newFolder.title")}
        onClose={() => {
          setNewFolderOpen(false);
          setSftpActionError(null);
        }}
        width={420}
      >
        <div className="xterminal-sftp-modal">
          <div className="form-group">
            <label>{t("terminal.sftp.newFolder.label")}</label>
            <input
              type="text"
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleNewFolderSubmit();
                }
              }}
              placeholder={t("terminal.sftp.newFolder.placeholder")}
            />
          </div>
          {sftpActionError && (
            <div className="xterminal-sftp-modal-error">{sftpActionError}</div>
          )}
          <div className="xterminal-sftp-modal-actions">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void handleNewFolderSubmit()}
              disabled={sftpActionBusy}
            >
              {t("terminal.sftp.newFolder.create")}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setNewFolderOpen(false);
                setSftpActionError(null);
              }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!forceRunDialog}
        title={t("terminal.agent.plan.force.title")}
        onClose={() => {
          setForceRunDialog(null);
          setForceRunConfirmInput("");
          setForceRunConfirmError(null);
        }}
        width={460}
      >
        <div className="xterminal-agent-force-modal">
          <div className="xterminal-agent-force-desc">
            {t("terminal.agent.plan.force.desc", {
              count: forceRunDialog?.blockedCount ?? 0,
              keyword: t("terminal.agent.plan.force.keyword"),
            })}
          </div>
          <input
            type="text"
            value={forceRunConfirmInput}
            onChange={(event) => {
              setForceRunConfirmInput(event.target.value);
              if (forceRunConfirmError) {
                setForceRunConfirmError(null);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void confirmForceRunDialog();
              }
            }}
            placeholder={t("terminal.agent.plan.force.placeholder", {
              keyword: t("terminal.agent.plan.force.keyword"),
            })}
          />
          {forceRunConfirmError && (
            <div className="xterminal-agent-force-error">{forceRunConfirmError}</div>
          )}
          <div className="xterminal-agent-force-actions">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setForceRunDialog(null);
                setForceRunConfirmInput("");
                setForceRunConfirmError(null);
              }}
            >
              {t("common.cancel")}
            </button>
            <button
              className="xterminal-agent-force-confirm"
              type="button"
              onClick={() => {
                void confirmForceRunDialog();
              }}
            >
              {t("terminal.agent.plan.force.confirm")}
            </button>
          </div>
        </div>
      </Modal>

      <ScriptPicker
        open={scriptPickerOpen}
        onClose={() => setScriptPickerOpen(false)}
        onSelect={(script) => handleInsertScript(script.content)}
      />
    </>
  );
}
