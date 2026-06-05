import {
  useCallback,
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
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { mkdir, readFile, readTextFile, remove, stat, watch, type UnwatchFn } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import { sshApi } from "../api/ssh";
import { telnetApi } from "../api/telnet";
import type { SftpEntry } from "../types/ssh";
import "@xterm/xterm/css/xterm.css";
import "./XTerminal.css";
import { AppIcon } from "./AppIcon";
import { Select } from "./Select";
import { Modal } from "./Modal";
import { ScriptPicker } from "./ScriptPicker";
import { sendAiChat, type AiMessage, type AiMessagePart } from "../api/ai";
import AgentStreamView from "./AgentStreamView";
import {
  type AppSettings,
  DEFAULT_APP_SETTINGS,
  getAppSettingsStore,
  writeAppSetting,
  type TerminalBackgroundFit,
  type TerminalThemeName,
  withTerminalIconFontFallback,
} from "../store/appSettings";
import { getXtermTheme } from "../terminal/xtermThemes";
import {
  categorizeLogLine,
  detectSmartCommand,
  sanitizeTerminalChunk,
  shellEscapeArg,
  stripSymlinkSuffix,
  type DockerPsRow,
  type LogCategory,
  type LsTableRow,
  type SmartCommandInfo,
} from "../terminal/smartTerminal";
import { createAgentLoop, type AgentLoopController } from "../terminal/agentLoop";
import type {
  AgentApprovalMode,
  AgentBlock,
  AgentRisk,
} from "../types/agent";
import { getModifierKeyAbbr, getModifierKeyLabel } from "../utils/platform";
import { toRgba } from "../utils/color";
import { loadTerminalBackgroundUrl } from "../utils/terminalBackground";
import { getResourceStatsCommand, parseResourceStatsOutput } from "../utils/resourceStats";
import { useI18n } from "../i18n";

interface XTerminalProps {
  sessionId: string;
  host: string;
  port: number;
  isLocal?: boolean;
  sessionKind?: "ssh" | "telnet" | "local";
  osType?: "windows" | "macos" | "linux" | "unknown";
  onConnect?: () => Promise<void>;
  onRequestSplit?: (direction: "vertical" | "horizontal") => void;
  onCloseSession?: () => void;
  isSplit?: boolean;
  onSendScript?: (content: string, scope: "current" | "all") => Promise<void> | void;
}

type ConnectionStatus = "idle" | "connecting" | "connected" | "error";
type TransferTaskDirection = "upload" | "download";
type TransferTaskStatus = "running" | "paused" | "success" | "failed";
type AppMessageTone = "info" | "success" | "error";
type AiChatMessage = AiMessage & {
  createdAt: number;
  id: string;
};

interface TransferTask {
  id: string;
  direction: TransferTaskDirection;
  name: string;
  sourcePath: string;
  targetPath: string;
  status: TransferTaskStatus;
  progress: number;
  speedBps?: number;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

interface SftpTransferProgressEvent {
  session_id: string;
  transfer_id: string;
  direction: TransferTaskDirection;
  transferred: number;
  total: number;
  percent: number;
}

type AppMessageDetail = {
  title: string;
  detail?: string;
  tone?: AppMessageTone;
  autoOpen?: boolean;
  toast?: boolean;
  toastDuration?: number;
  store?: boolean;
};

type SftpEditSession = {
  localDir: string;
  localPath: string;
  name: string;
  remotePath: string;
  unwatch: UnwatchFn | null;
  debounceId: number | null;
  lastSyncedSignature: string;
  syncing: boolean;
  pendingSync: boolean;
  lastSyncErrorMessage: string | null;
  lastSyncErrorAt: number;
};

type TransferUiProgressState = {
  lastAt: number;
  timer: number | null;
  latest:
    | {
        progress: number;
        speedBps: number;
        detail: string;
      }
    | null;
};

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

type TerminalSnapshot = {
  lines: string[];
  viewportY: number;
};

const terminalSnapshotCache = new Map<string, TerminalSnapshot>();

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

type SendAiMessageOptions = {
  extraSystemPrompt?: string;
};

type AiAttachment = {
  id: string;
  kind: "image" | "text";
  name: string;
  mimeType: string;
  content: string;
  filePath: string;
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

type ToolbarResourceStats = {
  cpuPercent: number | null;
  memoryPercent: number | null;
};

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
const normalizeFsPath = (value: string) => value.replace(/\\/g, "/");
const SFTP_EDIT_CACHE_DIR = "sftp-edit-cache";
const SFTP_LIST_TIMEOUT_MS = 20_000;
const SFTP_EDIT_SYNC_DEBOUNCE_MS = 1200;
const SFTP_SYNC_ERROR_TOAST_DEDUPE_MS = 15000;

const toSafePathSegment = (value: string) => {
  const sanitized = value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "");
  return sanitized || "file";
};

const createStableHash = (value: string) => {
  let hash = 5381;
  for (const char of value) {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16);
};

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "log",
  "json",
  "yaml",
  "yml",
  "xml",
  "csv",
  "tsv",
  "ini",
  "conf",
  "config",
  "sh",
  "bash",
  "zsh",
  "js",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rs",
  "sql",
]);

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

const MAX_TRANSFER_TASKS = 120;
const MAX_LOG_SIGNALS = 200;
const LOG_SUMMARY_WINDOW_MS = 60_000;
const MAX_LOG_SUMMARIES = 12;
const AGENT_TERMINAL_CAPTURE_CHARS = 220_000;
const MAX_AI_MESSAGES = 60;
const TERMINAL_FONT_SIZE_MIN = 9;
const TERMINAL_FONT_SIZE_MAX = 28;
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

const RECONNECT_PROMPT_PATTERN = /(?:^|\n)([^\n]*[@:][^\n]*[#$] )/;

const stripReconnectBanner = (value: string) => {
  const promptMatch = value.match(RECONNECT_PROMPT_PATTERN);
  if (!promptMatch || promptMatch.index === undefined) return null;
  return value.slice(promptMatch.index + (promptMatch[0].startsWith("\n") ? 1 : 0));
};

const createMessageId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const dropTrailingAgentStatusBlock = (blocks: AgentBlock[]) => {
  const last = blocks[blocks.length - 1];
  if (last?.type === "status") {
    return blocks.slice(0, -1);
  }
  return blocks;
};

const TERMINAL_BG_SIZE_MAP: Record<TerminalBackgroundFit, string> = {
  cover: "cover",
  contain: "contain",
  stretch: "100% 100%",
};

const isTransferTaskStatus = (value: unknown): value is TransferTaskStatus =>
  value === "running" ||
  value === "paused" ||
  value === "success" ||
  value === "failed";

export function XTerminal({
  sessionId,
  host,
  port,
  isLocal = false,
  sessionKind = isLocal ? "local" : "ssh",
  osType: _osType = "unknown",
  onConnect,
  onRequestSplit,
  onCloseSession,
  isSplit = false,
  onSendScript,
}: XTerminalProps) {
  const { t, locale } = useI18n();
  const isTelnet = sessionKind === "telnet";
  const supportsSftp = sessionKind === "ssh";
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const onConnectRef = useRef<XTerminalProps["onConnect"]>(onConnect);
  const mountedRef = useRef(true);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>("idle");
  const [connError, setConnError] = useState<string | null>(null);
  const [connectionLogs, setConnectionLogs] = useState<string[]>([]);
  const [connectionLogOpen, setConnectionLogOpen] = useState(false);
  const [endpointIp, setEndpointIp] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [toolbarResourceStats, setToolbarResourceStats] = useState<ToolbarResourceStats>({
    cpuPercent: null,
    memoryPercent: null,
  });
  const endpointProbeLogRef = useRef<string>("");
  const endpointLatencyRef = useRef<number | null>(null);
  const observedLatencyRef = useRef<number | null>(null);
  const resourceStatsBusyRef = useRef(false);
  const resourceStatsLastErrorRef = useRef<string | null>(null);
  const resourceStatsLastSuccessRef = useRef<string | null>(null);
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
  const [terminalBgFit, setTerminalBgFit] = useState<TerminalBackgroundFit>(
    DEFAULT_APP_SETTINGS["terminal.backgroundFit"],
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
  const [sftpDropTarget, setSftpDropTarget] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [sftpWidth, setSftpWidth] = useState(320);
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
  const sftpEditSessionsRef = useRef<Record<string, SftpEditSession>>({});
  const writeQueueRef = useRef<string[]>([]);
  const writingRef = useRef(false);
  const typingBufferRef = useRef("");
  const typingFlushTimerRef = useRef<number | null>(null);
  const reconnectPromiseRef = useRef<Promise<boolean> | null>(null);
  const reconnectingRef = useRef(false);
  const writeBlockedRef = useRef(false);
  const writeFailureCountRef = useRef(0);
  const suppressReconnectBannerRef = useRef(false);
  const reconnectBannerBufferRef = useRef("");
  const reconnectWriteFailuresRef = useRef<number>(
    DEFAULT_APP_SETTINGS["terminal.reconnectWriteFailures"],
  );
  const reconnectCooldownUntilRef = useRef(0);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [scriptPickerOpen, setScriptPickerOpen] = useState(false);
  const [scriptPanelOpen, setScriptPanelOpen] = useState(false);
  const [transferPanelOpen, setTransferPanelOpen] = useState(false);
  const [transferTasks, setTransferTasks] = useState<TransferTask[]>([]);
  const transferTasksRef = useRef<TransferTask[]>([]);
  const transferHistoryLoadedRef = useRef(false);
  const transferRateRef = useRef<
    Record<string, { transferred: number; ts: number; speedBps: number }>
  >({});
  const transferUiProgressRef = useRef<Record<string, TransferUiProgressState>>({});
  const [aiOpen, setAiOpen] = useState(false);
  const [scriptTarget, setScriptTarget] = useState<"current" | "all">("current");
  const [scriptText, setScriptText] = useState("");
  const [aiMessages, setAiMessages] = useState<AiChatMessage[]>([]);
  const aiMessagesRef = useRef<AiChatMessage[]>([]);
  const agentConversationHistoryRef = useRef<AiMessage[]>([]);
  const aiInputRef = useRef<HTMLTextAreaElement | null>(null);
  const aiStreamAbortRef = useRef<AbortController | null>(null);
  const aiAbortReasonRef = useRef<"stop" | "clear" | null>(null);
  const [aiInput, setAiInput] = useState("");
  const [terminalQuickDraft, setTerminalQuickDraft] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiWidth, setAiWidth] = useState(460);
  const [aiModel, setAiModel] = useState<string>("");
  const [aiModelOptions, setAiModelOptions] = useState<string[]>([]);
  const [aiApprovalMode, setAiApprovalMode] = useState<AgentApprovalMode>(
    DEFAULT_APP_SETTINGS["ai.approvalMode"],
  );
  const [aiAttachments, setAiAttachments] = useState<AiAttachment[]>([]);
  const [agentBlocks, setAgentBlocks] = useState<AgentBlock[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentPendingConfirmation, setAgentPendingConfirmation] = useState<{
    actionId: string;
    command: string;
    risk: AgentRisk;
    reason: string;
  } | null>(null);
  const agentLoopRef = useRef<AgentLoopController | null>(null);
  // @ts-expect-error — will be used when thinking delta throttling is wired up
  const agentThinkingBufferRef = useRef<string>("");
  // @ts-expect-error — will be used when thinking delta throttling is wired up
  const agentThinkingRafRef = useRef<number | null>(null);
  const aiModelTouchedRef = useRef(false);
  const [aiModelMenuOpen, setAiModelMenuOpen] = useState(false);
  const aiModelMenuRef = useRef<HTMLDivElement>(null);
  const [aiApprovalMenuOpen, setAiApprovalMenuOpen] = useState(false);
  const aiApprovalMenuRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState<{
    type: "sftp" | "ai";
    startX: number;
    startWidth: number;
  } | null>(null);
  const [terminalIssue, setTerminalIssue] = useState<{
    message: string;
    timestamp: number;
  } | null>(null);
  const [terminalFindOpen, setTerminalFindOpen] = useState(false);
  const [terminalFindQuery, setTerminalFindQuery] = useState("");
  const [terminalFindCaseSensitive, setTerminalFindCaseSensitive] =
    useState(false);
  const [terminalFindStatus, setTerminalFindStatus] = useState<
    "idle" | "found" | "not_found"
  >("idle");
  const terminalFindInputRef = useRef<HTMLInputElement | null>(null);
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
  // @ts-expect-error smartTable read value temporarily unused after AI panel refactor (smart insights will be re-integrated)
  const [smartTable, setSmartTable] = useState<SmartTableState | null>(null);
  const [smartMenu, setSmartMenu] = useState<SmartMenuState | null>(null);
  const smartMenuRef = useRef<HTMLDivElement>(null);
  // @ts-expect-error logSummaries read value temporarily unused after AI panel refactor
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
  const transferHistoryKey = useMemo(() => {
    const scope = isLocal
      ? "local"
      : `${host.trim().toLowerCase()}:${port}`;
    return `noterm.transfer.history.${createStableHash(scope)}`;
  }, [host, isLocal, port]);
  const aiHistoryLoadedRef = useRef(false);
  const transferStatusLabel = (status: TransferTaskStatus) =>
    t(`terminal.transfer.status.${status}`);

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

  const normalizeTransferTask = useCallback((value: unknown): TransferTask | null => {
    if (!value || typeof value !== "object") return null;
    const task = value as Partial<TransferTask>;
    if (typeof task.id !== "string" || !task.id.trim()) return null;
    if (task.direction !== "upload" && task.direction !== "download") return null;
    if (typeof task.name !== "string") return null;
    if (typeof task.sourcePath !== "string" || typeof task.targetPath !== "string") {
      return null;
    }
    if (!isTransferTaskStatus(task.status)) return null;
    const startedAt = Number(task.startedAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
    const progressRaw = Number(task.progress);
    const progress = Number.isFinite(progressRaw)
      ? Math.max(0, Math.min(100, Math.round(progressRaw)))
      : 0;
    const finishedAtRaw = task.finishedAt;
    const finishedAt =
      typeof finishedAtRaw === "number" && Number.isFinite(finishedAtRaw) && finishedAtRaw > 0
        ? finishedAtRaw
        : undefined;
    const speedBpsRaw = task.speedBps;
    const speedBps =
      typeof speedBpsRaw === "number" && Number.isFinite(speedBpsRaw) && speedBpsRaw > 0
        ? speedBpsRaw
        : undefined;
    return {
      id: task.id,
      direction: task.direction,
      name: task.name,
      sourcePath: task.sourcePath,
      targetPath: task.targetPath,
      status: task.status,
      progress,
      detail: typeof task.detail === "string" ? task.detail : undefined,
      speedBps,
      startedAt,
      finishedAt,
    };
  }, []);

  const persistTransferTasks = useCallback(
    (tasks: TransferTask[]) => {
      if (typeof window === "undefined") return;
      if (tasks.length === 0) {
        window.localStorage.removeItem(transferHistoryKey);
        return;
      }
      window.localStorage.setItem(
        transferHistoryKey,
        JSON.stringify(tasks.slice(0, MAX_TRANSFER_TASKS)),
      );
    },
    [transferHistoryKey],
  );

  const markRunningTransfersInterrupted = useCallback(
    (tasks: TransferTask[]) => {
      const now = Date.now();
      return tasks.map((task) =>
        task.status === "running"
          ? {
              ...task,
              status: "failed" as const,
              finishedAt: task.finishedAt ?? now,
              speedBps: undefined,
              detail:
                t("terminal.transfer.interrupted.detail"),
            }
          : task,
      );
    },
    [t],
  );

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
    if (isTelnet) {
      return telnetApi.writeToShell(sessionId, data);
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

  const appendConnectionLog = useCallback((message: string) => {
    const stamp = new Date().toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : "en-US", {
      hour12: false,
    });
    setConnectionLogs((prev) => {
      const next = [...prev, `[${stamp}] ${message}`];
      if (next.length > 80) {
        next.splice(0, next.length - 80);
      }
      return next;
    });
  }, [locale]);

  const appendAgentDebugLog = useCallback((message: string) => {
    appendConnectionLog(`${locale === "zh-CN" ? "[Agent]" : "[Agent]"} ${message}`);
  }, [appendConnectionLog, locale]);

  const captureTerminalSnapshot = useCallback(() => {
    const term = terminalInstance.current;
    if (!term) return;
    const buffer = term.buffer.active;
    if (!buffer || buffer.length <= 0) {
      terminalSnapshotCache.delete(sessionId);
      return;
    }
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i += 1) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    if (lines.every((line) => !line.trim())) {
      terminalSnapshotCache.delete(sessionId);
      return;
    }
    terminalSnapshotCache.set(sessionId, {
      lines,
      viewportY: buffer.viewportY,
    });
  }, [sessionId]);

  const restoreTerminalSnapshot = useCallback((term: Terminal) => {
    const snapshot = terminalSnapshotCache.get(sessionId);
    if (!snapshot || snapshot.lines.length === 0) return;
    const content = snapshot.lines.join("\r\n");
    if (!content.trim()) return;
    term.write(content, () => {
      if (snapshot.viewportY > 0) {
        term.scrollToLine(snapshot.viewportY);
      }
    });
  }, [sessionId]);

  const copyTerminalLog = async () => {
    const header = `session=${sessionId} type=${sessionKind} conn=${connStatus} sftp=${sftpOpen} ai=${aiOpen} lastInput=${lastInputAtRef.current} lastOutput=${lastOutputAtRef.current}`;
    const lines = terminalLogRef.current.map(
      (item) => `${item.time} [${item.level}] ${item.message}`,
    );
    await clipboardWrite([header, ...lines].join("\n"));
  };

  const findInTerminal = (
    direction: "next" | "prev",
    queryOverride?: string,
  ): boolean => {
    const term = terminalInstance.current;
    if (!term) return false;
    const rawQuery = queryOverride ?? terminalFindQuery;
    const query = rawQuery.trim();
    if (!query) {
      setTerminalFindStatus("idle");
      return false;
    }

    const buffer = term.buffer.active;
    const total = buffer.length;
    if (total <= 0) {
      setTerminalFindStatus("not_found");
      return false;
    }

    const caseSensitive = terminalFindCaseSensitive;
    const needle = caseSensitive ? query : query.toLowerCase();
    const selection = term.getSelectionPosition();
    const isNext = direction === "next";
    const startRow = selection
      ? isNext
        ? selection.end.y
        : selection.start.y
      : buffer.viewportY;
    const startCol = selection
      ? isNext
        ? selection.end.x
        : selection.start.x
      : 0;

    const getLineText = (row: number) => {
      const raw = buffer.getLine(row)?.translateToString(true) ?? "";
      return caseSensitive ? raw : raw.toLowerCase();
    };

    if (isNext) {
      for (let step = 0; step < total; step += 1) {
        const row = (startRow + step) % total;
        const hay = getLineText(row);
        const from =
          step === 0 ? Math.max(0, startCol + (selection ? 1 : 0)) : 0;
        const col = hay.indexOf(needle, from);
        if (col >= 0) {
          term.select(col, row, query.length);
          term.scrollToLine(Math.max(0, row - 2));
          setTerminalFindStatus("found");
          return true;
        }
      }
    } else {
      for (let step = 0; step < total; step += 1) {
        const row = (startRow - step + total) % total;
        const hay = getLineText(row);
        const from =
          step === 0 ? Math.max(0, startCol - (selection ? 1 : 0)) : hay.length;
        const col = hay.lastIndexOf(needle, from);
        if (col >= 0) {
          term.select(col, row, query.length);
          term.scrollToLine(Math.max(0, row - 2));
          setTerminalFindStatus("found");
          return true;
        }
      }
    }

    setTerminalFindStatus("not_found");
    return false;
  };

  const openTerminalFind = () => {
    setTerminalFindOpen(true);
    const selected = terminalInstance.current?.getSelection()?.trim() ?? "";
    if (selected && !selected.includes("\n")) {
      setTerminalFindQuery(selected);
      setTerminalFindStatus("idle");
    }
    requestAnimationFrame(() => {
      terminalFindInputRef.current?.focus();
      terminalFindInputRef.current?.select();
    });
  };

  const closeTerminalFind = () => {
    setTerminalFindOpen(false);
    setTerminalFindStatus("idle");
    terminalInstance.current?.focus();
  };

  const drainTypingBufferToWriteQueue = () => {
    if (typingFlushTimerRef.current !== null) {
      window.clearTimeout(typingFlushTimerRef.current);
      typingFlushTimerRef.current = null;
    }
    const pendingTyping = typingBufferRef.current;
    typingBufferRef.current = "";
    if (pendingTyping) {
      writeQueueRef.current.push(pendingTyping);
      pushTerminalLog("info", `preserved pending input bytes=${pendingTyping.length}`);
    }
  };

  const startReconnectFlow = () => {
    if (isLocal) return;
    if (reconnectPromiseRef.current) return;
    const now = Date.now();
    if (now < reconnectCooldownUntilRef.current) {
      pushTerminalLog("warn", "reconnect skipped (cooldown)");
      return;
    }
    reconnectCooldownUntilRef.current = now + 10_000;
    drainTypingBufferToWriteQueue();
    writeFailureCountRef.current = 0;
    writeBlockedRef.current = true;
    reconnectingRef.current = true;
    suppressReconnectBannerRef.current = true;
    reconnectBannerBufferRef.current = "";
    setConnStatus("connecting");
    setConnError(null);
    reconnectPromiseRef.current = (async () => {
      let ok = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const connectedBeforeReconnect = await (
            isTelnet
              ? telnetApi.isConnected(sessionId)
              : sshApi.isConnected(sessionId)
          ).catch(() => false);
          if (connectedBeforeReconnect) {
            ok = true;
            pushTerminalLog("info", "reconnect skipped (session still alive)");
            break;
          }

          pushTerminalLog("info", `reconnect attempt ${attempt}`);
          await connectNow({ forceReset: attempt > 1 });
          const connected = isTelnet
            ? await telnetApi.isConnected(sessionId)
            : await sshApi.isConnected(sessionId);
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
      reconnectingRef.current = false;
      reconnectPromiseRef.current = null;
    });
    reconnectPromiseRef.current
      .then((ok) => {
        if (ok) {
          trackedCommandRef.current = null;
          terminalInstance.current?.write(`\r\n\x1b[33m[${t("terminal.session.recreated")}]\x1b[0m\r\n`);
          void flushWriteQueue();
        } else {
          suppressReconnectBannerRef.current = false;
          reconnectBannerBufferRef.current = "";
          setConnStatus("error");
          setConnError(t("terminal.session.disconnected"));
        }
      })
      .catch(() => {
        // ignore
      });
  };

  const writeToShellWithTimeout = async (data: string) => {
    const updateDisplayLatency = () => {
      const endpoint = endpointLatencyRef.current;
      const observed = observedLatencyRef.current;
      if (endpoint === null && observed === null) {
        setLatencyMs(null);
        return;
      }
      setLatencyMs(Math.max(endpoint ?? 0, observed ?? 0));
    };
    const startedAt = Date.now();
    pushTerminalLog("info", `input bytes=${data.length}`);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let timeoutId: number | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          timeoutId = window.setTimeout(() => {
            reject(new Error("write_timeout"));
          }, 12_000);
          pushTerminalLog("info", `write attempt ${attempt}`);
          writeToShell(data)
            .then(() => resolve())
            .catch((err) => reject(err));
        });
        writeFailureCountRef.current = 0;
        const elapsed = Date.now() - startedAt;
        observedLatencyRef.current =
          observedLatencyRef.current === null
            ? elapsed
            : Math.round(observedLatencyRef.current * 0.7 + elapsed * 0.3);
        updateDisplayLatency();
        pushTerminalLog("info", `write ok ${Date.now() - startedAt}ms`);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const detail =
          message === "write_timeout"
            ? t("terminal.write.timeout")
            : t("terminal.write.fail");
        pushTerminalLog(
          "error",
          `${detail} (${Date.now() - startedAt}ms) attempt=${attempt} err=${message}`,
        );
        if (attempt < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 180));
          continue;
        }
        writeFailureCountRef.current += 1;
        observedLatencyRef.current = Math.max(observedLatencyRef.current ?? 0, 1200);
        updateDisplayLatency();
        if (!terminalIssueRef.current) {
          setTerminalIssue({
            message: t("terminal.write.issue", { detail }),
            timestamp: Date.now(),
          });
        }
        if (
          !isLocal &&
          writeFailureCountRef.current >= reconnectWriteFailuresRef.current
        ) {
          const stillConnected = await (
            isTelnet
              ? telnetApi.isConnected(sessionId)
              : sshApi.isConnected(sessionId)
          ).catch(() => false);
          pushTerminalLog(
            stillConnected
              ? "warn"
              : "error",
            `write failures reached threshold connected=${stillConnected}`,
          );
          if (!stillConnected) {
            startReconnectFlow();
          }
        }
        return false;
      } finally {
        if (timeoutId) {
          window.clearTimeout(timeoutId);
        }
      }
    }
    return false;
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

  const enqueueTypingWrite = (data: string) => {
    typingBufferRef.current += data;
    if (typingFlushTimerRef.current !== null) return;
    typingFlushTimerRef.current = window.setTimeout(() => {
      typingFlushTimerRef.current = null;
      const chunk = typingBufferRef.current;
      typingBufferRef.current = "";
      if (!chunk) return;
      enqueueTerminalWrite(chunk);
    }, 12);
  };

  const resizePty = (cols: number, rows: number) => {
    if (isLocal) {
      return sshApi.localResizePty(sessionId, cols, rows);
    }
    if (isTelnet) {
      return telnetApi.resizePty(sessionId, cols, rows);
    }
    return sshApi.resizePty(sessionId, cols, rows);
  };

  const disconnectShell = () => {
    if (isLocal) {
      return sshApi.localDisconnect(sessionId);
    }
    if (isTelnet) {
      return telnetApi.disconnect(sessionId);
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
      // ignore
    }

    return "";
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
        (await store.get<AppSettings["ai.provider"]>("ai.provider")) ??
        DEFAULT_APP_SETTINGS["ai.provider"],
      model:
        (await store.get<string>("ai.model")) ??
        DEFAULT_APP_SETTINGS["ai.model"],
      models:
        (await store.get<string[]>("ai.models")) ??
        DEFAULT_APP_SETTINGS["ai.models"],
      approvalMode:
        (await store.get<AgentApprovalMode>("ai.approvalMode")) ??
        DEFAULT_APP_SETTINGS["ai.approvalMode"],
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
      volcengine: {
        baseUrl:
          (await store.get<string>("ai.volcengine.baseUrl")) ??
          DEFAULT_APP_SETTINGS["ai.volcengine.baseUrl"],
        apiKey:
          (await store.get<string>("ai.volcengine.apiKey")) ??
          DEFAULT_APP_SETTINGS["ai.volcengine.apiKey"],
      },
      deepseek: {
        baseUrl:
          (await store.get<string>("ai.deepseek.baseUrl")) ??
          DEFAULT_APP_SETTINGS["ai.deepseek.baseUrl"],
        apiKey:
          (await store.get<string>("ai.deepseek.apiKey")) ??
          DEFAULT_APP_SETTINGS["ai.deepseek.apiKey"],
      },
    };
  };

  const syncAiSettings = async () => {
    const settings = await readAiSettings();
    setAiModelOptions(settings.models ?? []);
    setAiApprovalMode(settings.approvalMode ?? DEFAULT_APP_SETTINGS["ai.approvalMode"]);
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
      for (const remotePath of Object.keys(sftpEditSessionsRef.current)) {
        disposeSftpEditSession(remotePath);
      }
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    aiMessagesRef.current = aiMessages;
  }, [aiMessages]);

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
            }))
            .slice(-MAX_AI_MESSAGES);
          setAiMessages(normalized);
          agentConversationHistoryRef.current = normalized.map((item) => ({
            role: item.role,
            content: item.content,
          }));
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

  useEffect(() => {
    transferTasksRef.current = transferTasks;
  }, [transferTasks]);

  useEffect(() => {
    transferHistoryLoadedRef.current = false;
    if (typeof window === "undefined") {
      setTransferTasks([]);
      transferHistoryLoadedRef.current = true;
      return;
    }
    try {
      const raw = window.localStorage.getItem(transferHistoryKey);
      if (!raw) {
        setTransferTasks([]);
        return;
      }
      const parsed = JSON.parse(raw);
      const normalized = Array.isArray(parsed)
        ? parsed
            .map((item) => normalizeTransferTask(item))
            .filter((item): item is TransferTask => Boolean(item))
            .slice(0, MAX_TRANSFER_TASKS)
        : [];
      setTransferTasks(markRunningTransfersInterrupted(normalized));
    } catch {
      setTransferTasks([]);
    } finally {
      transferHistoryLoadedRef.current = true;
    }
  }, [markRunningTransfersInterrupted, normalizeTransferTask, transferHistoryKey]);

  useEffect(() => {
    if (!transferHistoryLoadedRef.current) return;
    persistTransferTasks(transferTasks);
  }, [persistTransferTasks, transferTasks]);

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

  const emitAppMessage = (detail: AppMessageDetail) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("app-message", { detail }));
  };

  const showSftpNotice = (
    message: string,
    tone: AppMessageTone = "error",
  ) => {
    emitAppMessage({
      title: t("terminal.sftp.title"),
      detail: message,
      tone,
      toast: true,
      toastDuration: tone === "error" ? 4200 : 2600,
      store: false,
    });
  };

  const isPermissionDeniedError = (message: string) =>
    /\bpermission denied\b/i.test(message);

  const reportSftpSyncFailure = (
    session: SftpEditSession,
    message: string,
  ) => {
    const permissionDenied = isPermissionDeniedError(message);
    showSftpNotice(
      permissionDenied
        ? t("terminal.sftp.edit.sync.notice.permission", {
            name: session.name,
          })
        : t("terminal.sftp.edit.sync.notice.generic", {
            name: session.name,
          }),
      "error",
    );

    const now = Date.now();
    const shouldToast =
      session.lastSyncErrorMessage !== message ||
      now - session.lastSyncErrorAt > SFTP_SYNC_ERROR_TOAST_DEDUPE_MS;

    session.lastSyncErrorMessage = message;
    session.lastSyncErrorAt = now;

    if (!shouldToast) return;

    emitAppMessage({
      title: t("terminal.sftp.edit.sync.toast.title"),
      detail: permissionDenied
        ? t("terminal.sftp.edit.sync.toast.permission.detail", {
            path: session.remotePath,
          })
        : t("terminal.sftp.edit.sync.fail", {
            name: session.name,
            message,
          }),
      tone: "error",
      toast: true,
      toastDuration: 4200,
      store: false,
    });
  };

  const interruptAiConversation = () => {
    // Stop the agent loop if running
    if (agentLoopRef.current?.isRunning()) {
      agentLoopRef.current.stop();
      setAgentRunning(false);
      setAgentPendingConfirmation(null);
    }
    if (aiStreamAbortRef.current) {
      aiAbortReasonRef.current = "stop";
      aiStreamAbortRef.current.abort();
    }
    setAiBusy(false);
  };

  const clearAiConversationContext = () => {
    // Stop the agent loop if running
    if (agentLoopRef.current?.isRunning()) {
      agentLoopRef.current.stop();
    }
    if (aiStreamAbortRef.current) {
      aiAbortReasonRef.current = "clear";
      aiStreamAbortRef.current.abort();
    }
    setAiBusy(false);
    setAiMessages([]);
    agentConversationHistoryRef.current = [];
    setAiAttachments([]);
    setAgentBlocks([]);
    setAgentRunning(false);
    setAgentPendingConfirmation(null);
    setAiError(null);
    setAiInput("");
  };

  const formatTransferTime = (value: number) =>
    new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(value));

  const formatTransferBytes = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = value;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    const precision = unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(precision)} ${units[unitIndex]}`;
  };

  const formatTransferSpeed = (value?: number) => {
    if (!value || !Number.isFinite(value) || value <= 0) return "";
    return `${formatTransferBytes(value)}/s`;
  };

  const formatSftpListSize = (bytes?: number) => {
    if (!Number.isFinite(bytes) || bytes === undefined || bytes <= 0) {
      return "0 KB";
    }
    const kb = bytes / 1024;
    if (kb > 1024 * 1024) {
      return `${(kb / (1024 * 1024)).toFixed(2)} GB`;
    }
    if (kb > 1024) {
      return `${(kb / 1024).toFixed(2)} MB`;
    }
    return `${kb.toFixed(2)} KB`;
  };

  const getTransferLocalPath = (task: TransferTask) =>
    task.direction === "download" ? task.targetPath : task.sourcePath;

  const getParentDirectory = (filePath: string) => {
    const normalized = filePath.trim();
    const idx = Math.max(
      normalized.lastIndexOf("/"),
      normalized.lastIndexOf("\\"),
    );
    if (idx <= 0) return normalized;
    return normalized.slice(0, idx);
  };

  const handleOpenTransferDirectory = async (task: TransferTask) => {
    const localPath = getTransferLocalPath(task);
    if (!localPath) return;
    const localDir = getParentDirectory(localPath);
    try {
      await openPath(localDir);
    } catch (error) {
      try {
        // Fallback: some platforms may fail to open the folder path directly.
        await openPath(localPath);
      } catch (fallbackError) {
        const message = formatError(fallbackError || error);
        showSftpNotice(t("terminal.transfer.openFolder.fail", { message }));
      }
    }
  };

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
      progress: 0,
      startedAt: Date.now(),
    };
    transferRateRef.current[id] = {
      transferred: 0,
      ts: Date.now(),
      speedBps: 0,
    };
    setTransferTasks((prev) => [next, ...prev].slice(0, MAX_TRANSFER_TASKS));
    return id;
  };

  const updateTransferTask = (id: string, patch: Partial<TransferTask>) => {
    if (patch.status && patch.status !== "running") {
      delete transferRateRef.current[id];
      const uiState = transferUiProgressRef.current[id];
      if (uiState?.timer) {
        window.clearTimeout(uiState.timer);
      }
      delete transferUiProgressRef.current[id];
      if (patch.status !== "paused" && !patch.finishedAt) {
        patch = { ...patch, finishedAt: Date.now() };
      }
    }
    setTransferTasks((prev) =>
      prev.map((task) => (task.id === id ? { ...task, ...patch } : task)),
    );
  };

  const isTransferCancelledError = (error: unknown) =>
    formatError(error).includes("transfer_cancelled");

  const resetTransferRate = (id: string) => {
    transferRateRef.current[id] = {
      transferred: 0,
      ts: Date.now(),
      speedBps: 0,
    };
  };

  const handlePauseTransferTask = async (task: TransferTask) => {
    if (task.direction !== "download" || task.status !== "running") return;
    updateTransferTask(task.id, {
      status: "paused",
      detail: t("terminal.transfer.paused.detail"),
    });
    try {
      await sshApi.cancelTransfer(task.id);
    } catch (error) {
      updateTransferTask(task.id, {
        status: "failed",
        progress: task.progress,
        detail: formatError(error),
      });
    }
  };

  const handleResumeTransferTask = async (task: TransferTask) => {
    if (task.direction !== "download" || task.status !== "paused") return;
    resetTransferRate(task.id);
    updateTransferTask(task.id, {
      status: "running",
      detail: t("terminal.transfer.resuming"),
      startedAt: Date.now(),
      finishedAt: undefined,
    });
    try {
      await sshApi.downloadFile(sessionId, task.sourcePath, task.targetPath, task.id);
      updateTransferTask(task.id, {
        status: "success",
        progress: 100,
        detail: t("terminal.sftp.download.done"),
        finishedAt: Date.now(),
      });
    } catch (error) {
      if (isTransferCancelledError(error)) {
        updateTransferTask(task.id, {
          status: "paused",
          detail: t("terminal.transfer.paused.detail"),
        });
        return;
      }
      const message = formatError(error);
      showSftpNotice(t("terminal.sftp.download.fail", { message }));
      updateTransferTask(task.id, {
        status: "failed",
        progress: task.progress,
        detail: message,
        finishedAt: Date.now(),
      });
    }
  };

  const removeTransferRuntimeState = (id: string) => {
    delete transferRateRef.current[id];
    const uiState = transferUiProgressRef.current[id];
    if (uiState?.timer) {
      window.clearTimeout(uiState.timer);
    }
    delete transferUiProgressRef.current[id];
  };

  const handleDeleteTransferTask = async (task: TransferTask) => {
    if (task.direction === "download" && task.status === "running") {
      try {
        await sshApi.cancelTransfer(task.id);
      } catch {
        // The worker may already have completed; removal below is still valid.
      }
    }
    removeTransferRuntimeState(task.id);
    setTransferTasks((prev) => prev.filter((item) => item.id !== task.id));

    if (task.direction === "download" && task.status !== "success" && task.targetPath) {
      try {
        await remove(task.targetPath);
      } catch {
        // Missing partial files are expected after failed or cancelled downloads.
      }
    }
  };

  const clearTransferHistory = () => {
    setTransferTasks((prev) => {
      const active = prev.filter(
        (task) => task.status === "running" || task.status === "paused",
      );
      const keep = new Set(active.map((task) => task.id));
      for (const [id, state] of Object.entries(transferUiProgressRef.current)) {
        if (!keep.has(id) && state.timer) {
          window.clearTimeout(state.timer);
        }
      }
      transferRateRef.current = Object.fromEntries(
        Object.entries(transferRateRef.current).filter(([id]) => keep.has(id)),
      );
      transferUiProgressRef.current = Object.fromEntries(
        Object.entries(transferUiProgressRef.current).filter(([id]) => keep.has(id)),
      );
      return active;
    });
  };

  useEffect(
    () => () => {
      for (const state of Object.values(transferUiProgressRef.current)) {
        if (state.timer) {
          window.clearTimeout(state.timer);
        }
      }
      transferUiProgressRef.current = {};
      if (transferHistoryLoadedRef.current) {
        persistTransferTasks(
          markRunningTransfersInterrupted(transferTasksRef.current),
        );
      }
    },
    [markRunningTransfersInterrupted, persistTransferTasks],
  );

  // Auto-remove completed/failed transfers older than 5 minutes
  useEffect(() => {
    const COMPLETED_TTL_MS = 5 * 60 * 1000;
    const id = window.setInterval(() => {
      const now = Date.now();
      setTransferTasks((prev) => {
        const hasStale = prev.some(
          (t) =>
            t.status !== "running" &&
            t.status !== "paused" &&
            t.finishedAt &&
            now - t.finishedAt > COMPLETED_TTL_MS,
        );
        if (!hasStale) return prev;
        return prev.filter(
          (t) =>
            t.status === "running" ||
            t.status === "paused" ||
            !t.finishedAt ||
            now - t.finishedAt <= COMPLETED_TTL_MS,
        );
      });
    }, COMPLETED_TTL_MS);
    return () => window.clearInterval(id);
  }, []);

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
    if (!supportsSftp) return;
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

  useEffect(() => {
    if (supportsSftp) return;
    setSftpOpen(false);
    setTransferPanelOpen(false);
  }, [supportsSftp]);

  const latencyTone = useMemo(() => {
    if (latencyMs === null) return "unknown";
    if (latencyMs < 120) return "ok";
    if (latencyMs < 250) return "warn";
    return "bad";
  }, [latencyMs]);

  const supportsToolbarResourceStats = !isTelnet && _osType !== "windows";
  const resourceCpuLabel =
    toolbarResourceStats.cpuPercent === null ? "--" : `${toolbarResourceStats.cpuPercent}%`;
  const resourceMemoryLabel =
    toolbarResourceStats.memoryPercent === null ? "--" : `${toolbarResourceStats.memoryPercent}%`;

  useEffect(() => {
    if (!supportsToolbarResourceStats || connStatus !== "connected") {
      resourceStatsBusyRef.current = false;
      resourceStatsLastErrorRef.current = null;
      resourceStatsLastSuccessRef.current = null;
      setToolbarResourceStats({ cpuPercent: null, memoryPercent: null });
      return;
    }

    let disposed = false;
    const command = getResourceStatsCommand();
    appendConnectionLog(
      locale === "zh-CN"
        ? "资源监控已启动：每 5 秒采样一次 CPU/内存"
        : "Resource monitor started: sampling CPU/memory every 5 seconds",
    );

    const pollResourceStats = async () => {
      if (disposed || resourceStatsBusyRef.current) return;
      resourceStatsBusyRef.current = true;
      try {
        const result = isLocal
          ? await sshApi.localExecuteControlledCommand(sessionId, command, 8)
          : await sshApi.executeControlledCommand(sessionId, command, 8);
        if (disposed) return;
        if (result.exitCode !== 0 || result.timedOut) {
          const nextError = `resource stats failed exit=${result.exitCode} timedOut=${result.timedOut} stderr=${result.stderr.trim() || "n/a"}`;
          if (resourceStatsLastErrorRef.current !== nextError) {
            pushTerminalLog("warn", nextError);
            appendConnectionLog(
              locale === "zh-CN"
                ? `资源监控失败：exit=${result.exitCode} timeout=${result.timedOut ? "yes" : "no"} stderr=${result.stderr.trim() || "n/a"}`
                : `Resource monitor failed: exit=${result.exitCode} timeout=${result.timedOut ? "yes" : "no"} stderr=${result.stderr.trim() || "n/a"}`,
            );
            resourceStatsLastErrorRef.current = nextError;
            resourceStatsLastSuccessRef.current = null;
          }
          setToolbarResourceStats({ cpuPercent: null, memoryPercent: null });
          return;
        }

        const parsed = parseResourceStatsOutput(result.stdout);
        if (!parsed) {
          const stdoutPreview = result.stdout.replace(/\s+/g, " ").trim().slice(0, 180) || "empty";
          const nextError = `resource stats parse failed stdout=${stdoutPreview}`;
          if (resourceStatsLastErrorRef.current !== nextError) {
            pushTerminalLog("warn", nextError);
            appendConnectionLog(
              locale === "zh-CN"
                ? `资源监控解析失败：${stdoutPreview}`
                : `Resource monitor parse failed: ${stdoutPreview}`,
            );
            resourceStatsLastErrorRef.current = nextError;
            resourceStatsLastSuccessRef.current = null;
          }
          setToolbarResourceStats({ cpuPercent: null, memoryPercent: null });
          return;
        }

        const nextSuccess = `${parsed.cpuPercent}/${parsed.memoryPercent}`;
        if (resourceStatsLastSuccessRef.current !== nextSuccess) {
          appendConnectionLog(
            locale === "zh-CN"
              ? `资源监控成功：CPU ${parsed.cpuPercent}% · 内存 ${parsed.memoryPercent}%`
              : `Resource monitor ok: CPU ${parsed.cpuPercent}% · MEM ${parsed.memoryPercent}%`,
          );
          resourceStatsLastSuccessRef.current = nextSuccess;
        }
        if (resourceStatsLastErrorRef.current) {
          pushTerminalLog("info", "resource stats polling recovered");
          appendConnectionLog(
            locale === "zh-CN"
              ? "资源监控已恢复"
              : "Resource monitor recovered",
          );
          resourceStatsLastErrorRef.current = null;
        }
        setToolbarResourceStats(parsed);
      } catch (error) {
        if (!disposed) {
          const errorMessage = formatError(error) || "unknown error";
          const nextError = `resource stats polling threw before completion: ${errorMessage}`;
          if (resourceStatsLastErrorRef.current !== nextError) {
            pushTerminalLog("warn", nextError);
            appendConnectionLog(
              locale === "zh-CN"
                ? `资源监控异常：${errorMessage}`
                : `Resource monitor error: ${errorMessage}`,
            );
            resourceStatsLastErrorRef.current = nextError;
            resourceStatsLastSuccessRef.current = null;
          }
          setToolbarResourceStats({ cpuPercent: null, memoryPercent: null });
        }
      } finally {
        resourceStatsBusyRef.current = false;
      }
    };

    const initialDelayId = window.setTimeout(() => {
      void pollResourceStats();
    }, 1800);
    const intervalId = window.setInterval(() => {
      void pollResourceStats();
    }, 5000);

    return () => {
      disposed = true;
      window.clearTimeout(initialDelayId);
      window.clearInterval(intervalId);
      resourceStatsBusyRef.current = false;
    };
  }, [connStatus, isLocal, sessionId, supportsToolbarResourceStats]);

  const connectNow = async (options?: { forceReset?: boolean }) => {
    const doConnect = onConnectRef.current;
    if (!doConnect) return;

    setConnStatus("connecting");
    setConnError(null);
    if (!options?.forceReset) {
      setConnectionLogs([]);
      endpointProbeLogRef.current = "";
    }
    appendConnectionLog(
      isLocal
        ? locale === "zh-CN"
          ? "开始连接本地终端"
          : "Starting local terminal session"
        : locale === "zh-CN"
          ? `开始连接 ${host}:${port}`
          : `Starting connection to ${host}:${port}`,
    );

    if (options?.forceReset) {
      // Best-effort reset when explicitly requested.
      appendConnectionLog(
        locale === "zh-CN" ? "执行连接重置（force reset）" : "Running force reset before reconnect",
      );
      await disconnectShell().catch(() => {});
    }

    try {
      appendConnectionLog(locale === "zh-CN" ? "调用后端连接接口..." : "Calling backend connect...");
      await doConnect();
      if (!mountedRef.current) return;
      setConnStatus("connected");
      appendConnectionLog(locale === "zh-CN" ? "连接成功" : "Connection established");
      void syncTerminalGeometry();
    } catch (error) {
      if (!mountedRef.current) return;
      const message = formatError(error);
      setConnStatus("error");
      setConnError(message);
      appendConnectionLog(
        locale === "zh-CN" ? `连接失败：${message}` : `Connection failed: ${message}`,
      );
    }
  };

  const ensureSessionReady = async (reason: "mount" | "unlock" = "mount") => {
    setConnStatus("connecting");
    setConnError(null);
    appendConnectionLog(
      locale === "zh-CN"
        ? reason === "unlock"
          ? "检测到解锁，尝试恢复会话"
          : "检测到终端重新挂载，尝试恢复会话"
        : reason === "unlock"
          ? "Session unlock detected, attempting recovery"
          : "Terminal remounted, attempting session recovery",
    );
    try {
      if (isLocal) {
        await sshApi.localOpenShell(sessionId);
        if (!mountedRef.current) return;
        setConnStatus("connected");
        appendConnectionLog(
          locale === "zh-CN" ? "本地会话恢复成功" : "Local session recovered",
        );
        void syncTerminalGeometry();
        return;
      }

      const connected = await (
        isTelnet
          ? telnetApi.isConnected(sessionId)
          : sshApi.isConnected(sessionId)
      ).catch(() => false);
      if (connected) {
        if (!mountedRef.current) return;
        setConnStatus("connected");
        appendConnectionLog(
          locale === "zh-CN" ? "检测到现有会话仍可用" : "Existing session is still alive",
        );
        void syncTerminalGeometry();
        return;
      }

      await connectNow();
    } catch (error) {
      if (!mountedRef.current) return;
      const message = formatError(error);
      setConnStatus("error");
      setConnError(message);
      appendConnectionLog(
        locale === "zh-CN" ? `恢复失败：${message}` : `Recovery failed: ${message}`,
      );
    }
  };

  const loadSftpEntries = async (path = sftpPath) => {
    if (!supportsSftp) return;
    setSftpLoading(true);
    setSftpError(null);
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        window.setTimeout(
          () => reject(new Error(t("terminal.sftp.timeout"))),
          SFTP_LIST_TIMEOUT_MS,
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

  const buildNestedRemotePath = (basePath: string, name: string) => {
    return basePath.endsWith("/") ? `${basePath}${name}` : `${basePath}/${name}`;
  };

  const getSftpEditSessionKey = (remotePath: string) => normalizeFsPath(remotePath);

  const getRemoteParentPath = (remotePath: string) => {
    const parts = normalizeFsPath(remotePath).split("/").filter(Boolean);
    parts.pop();
    return parts.length > 0 ? `/${parts.join("/")}` : "/";
  };

  const getLocalFileSignature = async (localPath: string) => {
    const info = await stat(localPath);
    return `${info.size}:${info.mtime?.getTime() ?? 0}`;
  };

  const disposeSftpEditSession = (remotePath: string) => {
    const key = getSftpEditSessionKey(remotePath);
    const session = sftpEditSessionsRef.current[key];
    if (!session) return;
    if (session.debounceId !== null) {
      window.clearTimeout(session.debounceId);
    }
    session.unwatch?.();
    delete sftpEditSessionsRef.current[key];
  };

  const buildSftpEditLocalPaths = async (remotePath: string, fileName: string) => {
    const baseDir = await appLocalDataDir();
    const localDir = await join(
      baseDir,
      SFTP_EDIT_CACHE_DIR,
      toSafePathSegment(sessionId),
      `${toSafePathSegment(fileName)}-${createStableHash(remotePath)}`,
    );
    const localPath = await join(localDir, fileName);
    return { localDir, localPath };
  };

  const syncSftpEditedFile = async (remotePath: string) => {
    const key = getSftpEditSessionKey(remotePath);
    const session = sftpEditSessionsRef.current[key];
    if (!session) return;

    let signature = "";
    try {
      signature = await getLocalFileSignature(session.localPath);
    } catch {
      return;
    }

    if (!signature || signature === session.lastSyncedSignature) {
      return;
    }

    if (session.syncing) {
      session.pendingSync = true;
      return;
    }

    let taskId: string | null = null;
    session.syncing = true;
    session.pendingSync = false;
    try {
      taskId = createTransferTask("upload", session.name, session.localPath, session.remotePath);
      setUploadProgress(t("terminal.sftp.edit.sync.progress", { name: session.name }));
      await sshApi.uploadFile(
        sessionId,
        session.localPath,
        session.remotePath,
        taskId,
        false,
      );
      session.lastSyncErrorMessage = null;
      session.lastSyncErrorAt = 0;
      session.lastSyncedSignature = signature;
      if (taskId) {
        updateTransferTask(taskId, {
          status: "success",
          progress: 100,
          detail: t("terminal.sftp.edit.sync.done"),
          finishedAt: Date.now(),
        });
      }
      if (getRemoteParentPath(session.remotePath) === normalizeFsPath(sftpPathRef.current || "/")) {
        void loadSftpEntries(sftpPathRef.current || "/");
      }
    } catch (error) {
      const message = formatError(error);
      reportSftpSyncFailure(session, message);
      if (taskId) {
        updateTransferTask(taskId, {
          status: "failed",
          progress: 100,
          detail: message,
          finishedAt: Date.now(),
        });
      }
    } finally {
      setUploadProgress(null);
      session.syncing = false;
      if (session.pendingSync) {
        session.pendingSync = false;
        session.debounceId = window.setTimeout(() => {
          const nextSession = sftpEditSessionsRef.current[key];
          if (!nextSession) return;
          nextSession.debounceId = null;
          void syncSftpEditedFile(remotePath);
        }, SFTP_EDIT_SYNC_DEBOUNCE_MS);
      }
    }
  };

  const scheduleSftpEditSync = (remotePath: string) => {
    const key = getSftpEditSessionKey(remotePath);
    const session = sftpEditSessionsRef.current[key];
    if (!session) return;
    if (session.debounceId !== null) {
      window.clearTimeout(session.debounceId);
    }
    session.debounceId = window.setTimeout(() => {
      const nextSession = sftpEditSessionsRef.current[key];
      if (!nextSession) return;
      nextSession.debounceId = null;
      void syncSftpEditedFile(remotePath);
    }, SFTP_EDIT_SYNC_DEBOUNCE_MS);
  };

  const ensureSftpEditSession = async (
    remotePath: string,
    fileName: string,
    localDir: string,
    localPath: string,
    signature: string,
  ) => {
    const key = getSftpEditSessionKey(remotePath);
    const existing = sftpEditSessionsRef.current[key];
    if (existing) {
      existing.lastSyncedSignature = signature;
      return existing;
    }

    const session: SftpEditSession = {
      localDir,
      localPath,
      name: fileName,
      remotePath,
      unwatch: null,
      debounceId: null,
      lastSyncedSignature: signature,
      syncing: false,
      pendingSync: false,
      lastSyncErrorMessage: null,
      lastSyncErrorAt: 0,
    };

    session.unwatch = await watch(
      localDir,
      () => {
        scheduleSftpEditSync(remotePath);
      },
      {
        recursive: false,
        delayMs: 250,
      },
    );

    sftpEditSessionsRef.current[key] = session;
    return session;
  };

  const handleOpenFileForEditing = async (entry: SftpEntry) => {
    if (entry.is_dir) return;

    const remotePath = buildRemotePath(entry.name);
    const key = getSftpEditSessionKey(remotePath);
    const existing = sftpEditSessionsRef.current[key];
    if (existing) {
      try {
        await openPath(existing.localPath);
      } catch (error) {
        showSftpNotice(
          t("terminal.sftp.edit.open.fail", { message: formatError(error) }),
        );
        disposeSftpEditSession(remotePath);
        return;
      }
      return;
    }

    let taskId: string | null = null;
    try {
      const { localDir, localPath } = await buildSftpEditLocalPaths(remotePath, entry.name);
      await mkdir(localDir, { recursive: true });

      taskId = createTransferTask("download", entry.name, remotePath, localPath);
      setUploadProgress(t("terminal.sftp.edit.download.progress", { name: entry.name }));
      await sshApi.downloadFile(sessionId, remotePath, localPath, taskId);
      const signature = await getLocalFileSignature(localPath);
      await ensureSftpEditSession(remotePath, entry.name, localDir, localPath, signature);
      await openPath(localPath);
      if (taskId) {
        updateTransferTask(taskId, {
          status: "success",
          progress: 100,
          detail: t("terminal.sftp.edit.opened"),
          finishedAt: Date.now(),
        });
      }
      emitAppMessage({
        title: t("terminal.sftp.edit.opened.title"),
        detail: t("terminal.sftp.edit.opened.detail", { name: entry.name }),
        tone: "success",
        toast: true,
        store: false,
      });
    } catch (error) {
      if (taskId && isTransferCancelledError(error)) {
        updateTransferTask(taskId, {
          status: "paused",
          detail: t("terminal.transfer.paused.detail"),
        });
        return;
      }
      const message = formatError(error);
      disposeSftpEditSession(remotePath);
      showSftpNotice(t("terminal.sftp.edit.open.fail", { message }));
      if (taskId) {
        updateTransferTask(taskId, {
          status: "failed",
          progress: 100,
          detail: message,
          finishedAt: Date.now(),
        });
      }
    } finally {
      setUploadProgress(null);
    }
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

    const getDropTargetFromPosition = (position?: { x: number; y: number }) => {
      if (!position) return null;
      const hovered = document.elementFromPoint(position.x, position.y);
      const row = hovered?.closest?.(".xterminal-sftp-item--dir") as HTMLElement | null;
      const path = row?.dataset.dropPath;
      const name = row?.dataset.dropName;
      if (!path || !name) return null;
      return { path, name };
    };

    const resetDragging = () => {
      sftpDragCounterRef.current = 0;
      setSftpDragging(false);
      setSftpDropTarget(null);
    };

    const register = async () => {
      unlistenHover = await listen("tauri://file-drop-hover", (event) => {
        if (!active) return;
        const payload = event.payload as { position?: { x: number; y: number } } | null;
        if (payload?.position) {
          setSftpDragging(true);
          setSftpDropTarget(getDropTargetFromPosition(payload.position));
        } else {
          resetDragging();
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
        const dropTarget = getDropTargetFromPosition(payload?.position) ?? sftpDropTarget;
        resetDragging();
        if (!inside && !sftpDraggingRef.current) return;
        const paths = Array.isArray(payload?.paths) ? payload?.paths : [];
        if (!paths.length) return;
        if (uploadProgress) {
          showSftpNotice(t("terminal.sftp.upload.inProgress"), "info");
          return;
        }
        void handleUploadFiles(paths, dropTarget?.path);
      });
    };

    void register();
    return () => {
      active = false;
      if (unlistenDrop) unlistenDrop();
      if (unlistenHover) unlistenHover();
      if (unlistenCancel) unlistenCancel();
    };
  }, [sftpDropTarget, sftpOpen, uploadProgress, t]);

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
      await sshApi.downloadFile(sessionId, remotePath, localPath, taskId);
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
      if (taskId && isTransferCancelledError(error)) {
        updateTransferTask(taskId, {
          status: "paused",
          detail: t("terminal.transfer.paused.detail"),
        });
        setUploadProgress(null);
        return;
      }
      const message = formatError(error);
      showSftpNotice(t("terminal.sftp.download.fail", { message }));
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

  const handleUploadFiles = async (filePaths: string[], targetDirectory?: string) => {
    for (const filePath of filePaths) {
      let taskId: string | null = null;
      try {
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'unknown';
        setUploadProgress(
          t("terminal.sftp.upload.progress", { name: fileName }),
        );

        // 构建远程路径
        const currentPath = targetDirectory || sftpPathRef.current || "/";
        const remotePath = currentPath.endsWith("/")
          ? currentPath + fileName
          : currentPath + "/" + fileName;

        taskId = createTransferTask("upload", fileName, filePath, remotePath);
        await sshApi.uploadFile(sessionId, filePath, remotePath, taskId);
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
        showSftpNotice(
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
    const items = Array.from(event.dataTransfer?.items ?? []);
    return (
      types.includes("Files") ||
      types.includes("application/x-moz-file") ||
      items.some((item) => item.kind === "file")
    );
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
      setSftpDropTarget(null);
    }
  };

  const handleSftpDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const hovered = (event.target as Element | null)?.closest?.(".xterminal-sftp-item--dir") as HTMLElement | null;
    const path = hovered?.dataset.dropPath;
    const name = hovered?.dataset.dropName;
    setSftpDropTarget(path && name ? { path, name } : null);
  };

  const handleSftpDrop = async (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    sftpDragCounterRef.current = 0;
    setSftpDragging(false);
    const targetDirectory = sftpDropTarget?.path;
    setSftpDropTarget(null);
    if (uploadProgress) {
      showSftpNotice(t("terminal.sftp.upload.inProgress"), "info");
      return;
    }
    const filePaths = extractDroppedPaths(event);
    if (filePaths.length === 0) {
      showSftpNotice(t("terminal.sftp.drop.error"));
      return;
    }
    await handleUploadFiles(filePaths, targetDirectory);
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
      showSftpNotice(t("terminal.sftp.select.fail", { message }));
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

  const normalizeAgentBlockText = (value: string) =>
    value.replace(/\s+/g, " ").trim();

  const getFileExtension = (filePath: string) => {
    const normalized = filePath.split(/[\\/]/).pop() || filePath;
    const dotIndex = normalized.lastIndexOf(".");
    return dotIndex >= 0 ? normalized.slice(dotIndex + 1).toLowerCase() : "";
  };

  const buildAiDisplayMessageWithAttachments = (content: string, attachments: AiAttachment[]) => {
    const trimmed = content.trim();
    if (attachments.length === 0) return trimmed;

    const attachmentSections = attachments.map((attachment) => {
      if (attachment.kind === "image") {
        return [
          `![${attachment.name}](${attachment.filePath})`,
          `*Image attachment: ${attachment.name}*`,
        ].join("\n");
      }

      return [
        `**Text attachment:** ${attachment.name}`,
      ].join("\n");
    });

    return [trimmed, ...attachmentSections].filter(Boolean).join("\n\n");
  };

  const buildAiApiMessageWithAttachments = (
    content: string,
    attachments: AiAttachment[],
  ): AiMessage["content"] => {
    const trimmed = content.trim();
    const hasImageAttachment = attachments.some((attachment) => attachment.kind === "image");

    if (!hasImageAttachment) {
      const attachmentSections = attachments.map((attachment) =>
        attachment.kind === "text"
          ? `[Text Attachment: ${attachment.name}]\n${attachment.content}`
          : `[Image Attachment: ${attachment.name}]`,
      );
      return [trimmed, ...attachmentSections].filter(Boolean).join("\n\n");
    }

    const parts: AiMessagePart[] = [];
    if (trimmed) {
      parts.push({ type: "text", text: trimmed });
    }

    for (const attachment of attachments) {
      if (attachment.kind === "text") {
        parts.push({
          type: "text",
          text: `[Text Attachment: ${attachment.name}]\n${attachment.content}`,
        });
        continue;
      }

      parts.push({
        type: "text",
        text: `[Image Attachment: ${attachment.name}]`,
      });
      parts.push({
        type: "image",
        mediaType: attachment.mimeType,
        dataUrl: attachment.content,
      });
    }

    return parts;
  };

  const removeAiAttachment = (attachmentId: string) => {
    setAiAttachments((prev) => prev.filter((item) => item.id !== attachmentId));
  };

  const handlePickAiAttachments = async () => {
    try {
      const selected = await openDialog({
        multiple: true,
        filters: [
          {
            name: "Attachments",
            extensions: [
              "png", "jpg", "jpeg", "webp", "gif", "bmp", "svg",
              "txt", "md", "markdown", "log", "json", "yaml", "yml", "xml", "csv", "tsv",
              "ini", "conf", "config", "sh", "bash", "zsh", "js", "ts", "tsx", "jsx", "py", "rs", "sql",
            ],
          },
        ],
      });
      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      const nextAttachments = await Promise.all(paths.map(async (filePath) => {
        const name = filePath.split(/[\\/]/).pop() || filePath;
        const ext = getFileExtension(filePath);

        if (ext in IMAGE_MIME_BY_EXTENSION) {
          const bytes = await readFile(filePath);
          const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
          return {
            id: createMessageId(),
            kind: "image" as const,
            name,
            mimeType: IMAGE_MIME_BY_EXTENSION[ext] || "image/png",
            content: `data:${IMAGE_MIME_BY_EXTENSION[ext] || "image/png"};base64,${btoa(binary)}`,
            filePath,
          };
        }

        if (TEXT_ATTACHMENT_EXTENSIONS.has(ext)) {
          const raw = await readTextFile(filePath);
          return {
            id: createMessageId(),
            kind: "text" as const,
            name,
            mimeType: "text/plain",
            content: raw,
            filePath,
          };
        }

        return null;
      }));

      const validAttachments = nextAttachments.filter((item): item is AiAttachment => Boolean(item));
      if (validAttachments.length === 0) {
        setAiError("Only image and text attachments are supported.");
        return;
      }

      setAiError(null);
      setAiAttachments((prev) => {
        const deduped = new Map(prev.map((item) => [item.name, item]));
        for (const attachment of validAttachments) {
          deduped.set(attachment.name, attachment);
        }
        return Array.from(deduped.values());
      });
    } catch (error) {
      setAiError(formatError(error));
    }
  };

  const sendAiMessage = async (
    content: string,
    _options?: SendAiMessageOptions,
  ): Promise<string | null> => {
    const displayContent = buildAiDisplayMessageWithAttachments(content, aiAttachments);
    const apiContent = buildAiApiMessageWithAttachments(content, aiAttachments);
    const hasApiTextContent =
      typeof apiContent === "string"
        ? apiContent.trim().length > 0
        : apiContent.some((part) => part.type === "image" || part.text.trim().length > 0);
    if (!hasApiTextContent) return null;
    setAiError(null);
    setAiBusy(true);

    // Stop any existing agent loop
    if (agentLoopRef.current?.isRunning()) {
      agentLoopRef.current.stop();
    }

    const userMessage: AiChatMessage = {
      id: createMessageId(),
      role: "user",
      content: apiContent,
      createdAt: Date.now(),
    };
    setAiMessages((prev) => [...prev, userMessage].slice(-MAX_AI_MESSAGES));

    // Append user message block to existing conversation (preserve history)
    setAgentBlocks((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        type: "user" as AgentBlock["type"],
        content: displayContent,
        timestamp: Date.now(),
      },
    ]);
    setAgentRunning(true);
    setAgentPendingConfirmation(null);
    appendAgentDebugLog(
      locale === "zh-CN"
        ? `开始新一轮对话，现有消息=${aiMessagesRef.current.length}`
        : `Starting new agent turn, existing messages=${aiMessagesRef.current.length}`,
    );

    try {
      const settings = await readAiSettings();
      const selectedModel = aiModel.trim() || settings.model;
      const nextSettings = selectedModel ? { ...settings, model: selectedModel } : settings;
      const nextApprovalMode =
        aiApprovalMode || settings.approvalMode || DEFAULT_APP_SETTINGS["ai.approvalMode"];
      const priorConversationHistory = [...agentConversationHistoryRef.current];
      appendAgentDebugLog(
        locale === "zh-CN"
          ? `模型=${selectedModel || settings.model} 模式=${nextApprovalMode} 历史轮次=${priorConversationHistory.length}`
          : `model=${selectedModel || settings.model} mode=${nextApprovalMode} history=${priorConversationHistory.length}`,
      );

      if (aiAttachments.length > 0) {
        const multimodalSystemMessage: AiMessage = {
          role: "system",
          content:
            locale === "zh-CN"
              ? "你是一个多模态助手。直接回答用户，不要输出思考过程、计划、内部推理或自我说明。"
              : "You are a multimodal assistant. Answer the user directly. Do not output internal reasoning, planning, or self-referential process.",
        };
        const multimodalUserMessage: AiMessage = {
          role: "user",
          content: apiContent,
        };
        const multimodalMessages: AiMessage[] = [
          ...priorConversationHistory,
          multimodalSystemMessage,
          multimodalUserMessage,
        ];

        const reply = await sendAiChat(nextSettings, multimodalMessages);

        setAgentRunning(false);
        setAiBusy(false);
        setAgentPendingConfirmation(null);
        setAiAttachments([]);
        const nextMultimodalConversationHistory: AiMessage[] = [
          ...priorConversationHistory,
          multimodalUserMessage,
          { role: "assistant", content: reply },
        ];
        agentConversationHistoryRef.current = nextMultimodalConversationHistory.slice(-MAX_AI_MESSAGES);
        setAiMessages((prev) => [
          ...prev,
          {
            id: createMessageId(),
            role: "assistant" as const,
            content: reply,
            createdAt: Date.now(),
          },
        ].slice(-MAX_AI_MESSAGES));
        setAgentBlocks((prev) => [
          ...prev,
          { id: crypto.randomUUID(), type: "done", content: reply, timestamp: Date.now() },
        ]);
        return reply;
      }

      const loop = createAgentLoop({
        sessionId,
        aiSettings: nextSettings,
        approvalMode: nextApprovalMode,
        terminalContext: () => getTerminalContext(60),
        locale: locale as "zh-CN" | "en-US",
        conversationHistory: priorConversationHistory,
        onThinkingDelta: (thinking) => {
          appendAgentDebugLog(
            locale === "zh-CN"
              ? `thinking 更新 ${thinking.length} chars`
              : `thinking update ${thinking.length} chars`,
          );
          setAgentBlocks((prev) => {
            const normalized = dropTrailingAgentStatusBlock(prev);
            const last = normalized[normalized.length - 1];
            if (last?.type === "thinking") {
              return [...normalized.slice(0, -1), { ...last, content: thinking }];
            }
            return [
              ...normalized,
              {
                id: crypto.randomUUID(),
                type: "thinking",
                content: thinking,
                timestamp: Date.now(),
              },
            ];
          });
        },
        onThinkingComplete: (thinkingContent) => {
          setAgentBlocks((prev) => {
            const normalized = dropTrailingAgentStatusBlock(prev);
            const last = normalized[normalized.length - 1];
            if (last?.type === "thinking") {
              return [...normalized.slice(0, -1), { ...last, content: thinkingContent }];
            }
            return normalized;
          });
        },
        onActionDecided: (action) => {
          appendAgentDebugLog(
            locale === "zh-CN"
              ? `决策命令: ${action.command}`
              : `decided command: ${action.command}`,
          );
          setAgentBlocks((prev) => {
            const normalized = dropTrailingAgentStatusBlock(prev);
            return [
              ...normalized,
              {
                id: action.id,
                type: "action",
                content: action.reason,
                command: action.command,
                risk: action.risk,
                status: "pending",
                timestamp: Date.now(),
              },
            ];
          });
        },
        onActionStatusChange: (actionId, status) => {
          appendAgentDebugLog(
            locale === "zh-CN"
              ? `命令状态 ${actionId}: ${status}`
              : `command status ${actionId}: ${status}`,
          );
          setAgentBlocks((prev) =>
            prev.map((b) => (b.id === actionId ? { ...b, status: status as AgentBlock["status"] } : b)),
          );
        },
        onOutputReceived: (actionId, result) => {
          appendAgentDebugLog(
            locale === "zh-CN"
              ? `命令完成 ${actionId}: exit=${result.exitCode} stdout=${result.stdout.length} stderr=${result.stderr.length}`
              : `command finished ${actionId}: exit=${result.exitCode} stdout=${result.stdout.length} stderr=${result.stderr.length}`,
          );
          setAgentBlocks((prev) => [
            ...prev,
            {
              id: `output-${actionId}`,
              type: "output",
              content: result.stdout,
              exitCode: result.exitCode,
              stderr: result.stderr,
              timestamp: Date.now(),
            },
            {
              id: `status-${actionId}`,
              type: "status",
              content: "",
              phase: "analyzing_output",
              timestamp: Date.now(),
            },
          ]);
        },
        onConfirmationNeeded: (actionId, action, policy) => {
          setAgentPendingConfirmation({
            actionId,
            command: action.command,
            risk: policy.normalized_risk,
            reason: policy.reason,
          });
        },
        onLoopComplete: (summary) => {
          appendAgentDebugLog(
            locale === "zh-CN"
              ? `loop 完成，summary=${summary.length} chars`
              : `loop complete, summary=${summary.length} chars`,
          );
          setAgentRunning(false);
          setAiBusy(false);
          setAgentPendingConfirmation(null);
          const nextConversationHistory: AiMessage[] = [
            ...priorConversationHistory,
            { role: "user", content: apiContent },
            ...(summary.trim() ? [{ role: "assistant" as const, content: summary }] : []),
          ];
          agentConversationHistoryRef.current = nextConversationHistory.slice(-MAX_AI_MESSAGES);
          if (summary.trim()) {
            setAiMessages((prev) => [
              ...prev,
              {
                id: createMessageId(),
                role: "assistant" as const,
                content: summary,
                createdAt: Date.now(),
              },
            ].slice(-MAX_AI_MESSAGES));
          }
          if (summary) {
            setAgentBlocks((prev) => {
              const normalized = dropTrailingAgentStatusBlock(prev);
              const last = normalized[normalized.length - 1];
              if (
                last?.type === "thinking" &&
                normalizeAgentBlockText(last.content) === normalizeAgentBlockText(summary)
              ) {
                return [
                  ...normalized.slice(0, -1),
                  {
                    ...last,
                    type: "done" as const,
                    content: summary,
                    timestamp: Date.now(),
                  },
                ];
              }

              return [
                ...normalized,
                { id: crypto.randomUUID(), type: "done", content: summary, timestamp: Date.now() },
              ];
            });
          }
        },
        onError: (error) => {
          appendAgentDebugLog(
            locale === "zh-CN" ? `loop 错误: ${error}` : `loop error: ${error}`,
          );
          setAgentRunning(false);
          setAiBusy(false);
          setAgentPendingConfirmation(null);
          setAgentBlocks((prev) => [
            ...dropTrailingAgentStatusBlock(prev),
            { id: crypto.randomUUID(), type: "error", content: error, timestamp: Date.now() },
          ]);
          setAiError(error);
        },
        executeCommand: async (command, timeoutSec) => {
          return await executeAgentActionInTerminal(command, timeoutSec);
        },
      });

      agentLoopRef.current = loop;
      setAiAttachments([]);
      loop.start(typeof apiContent === "string" ? apiContent : content.trim());
      return null;
    } catch (error) {
      const message = formatError(error);
      appendAgentDebugLog(
        locale === "zh-CN" ? `发送失败: ${message}` : `send failed: ${message}`,
      );
      setAiError(message);
      setAgentRunning(false);
      setAiBusy(false);
      return null;
    }
  };

  const buildStrictCommandPrompt = () =>
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

  const handleTerminalHashCommand = async (rawCommand: string) => {
    const parsed = parseTerminalHashCommand(rawCommand);
    if (!parsed) return;
    setAiOpen(true);
    setAiError(null);
    const strictCommandPrompt = buildStrictCommandPrompt();

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

  useEffect(() => {
    if (!aiOpen) return;
    void syncAiSettings();
  }, [aiOpen]);

  const handleSelectAiApprovalMode = async (mode: AgentApprovalMode) => {
    setAiApprovalMode(mode);
    setAiApprovalMenuOpen(false);
    await writeAppSetting("ai.approvalMode", mode);
  };

  const aiApprovalModeOptions: Array<{
    value: AgentApprovalMode;
    label: string;
    description: string;
  }> = [
    {
      value: "auto",
      label: t("terminal.ai.approvalMode.auto"),
      description: t("terminal.ai.approvalMode.auto.desc"),
    },
    {
      value: "delegate",
      label: t("terminal.ai.approvalMode.delegate"),
      description: t("terminal.ai.approvalMode.delegate.desc"),
    },
    {
      value: "copilot",
      label: t("terminal.ai.approvalMode.copilot"),
      description: t("terminal.ai.approvalMode.copilot.desc"),
    },
  ];

  const activeAiApprovalMode =
    aiApprovalModeOptions.find((item) => item.value === aiApprovalMode) ??
    aiApprovalModeOptions[0];

  useEffect(() => {
    if (!aiModelMenuOpen && !aiApprovalMenuOpen) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (aiModelMenuRef.current && !aiModelMenuRef.current.contains(target)) {
        setAiModelMenuOpen(false);
      }
      if (aiApprovalMenuRef.current && !aiApprovalMenuRef.current.contains(target)) {
        setAiApprovalMenuOpen(false);
      }
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAiModelMenuOpen(false);
        setAiApprovalMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [aiApprovalMenuOpen, aiModelMenuOpen]);

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
    const onKeyDown = (event: KeyboardEvent) => {
      const isFindShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f";
      if (!isFindShortcut) return;
      if (!paneRef.current) return;
      if (paneRef.current.offsetParent === null) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".xterminal-find")) return;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openTerminalFind();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, []);

  useEffect(() => {
    const onReconnectAllTerminals = () => {
      if (connStatus === "connected" && !terminalIssueRef.current) {
        return;
      }
      setTerminalIssue(null);
      void ensureSessionReady("unlock");
    };

    window.addEventListener("app-reconnect-terminals", onReconnectAllTerminals);
    return () => {
      window.removeEventListener("app-reconnect-terminals", onReconnectAllTerminals);
    };
  }, [connStatus, sessionId]);

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

  const syncTerminalGeometry = async () => {
    const term = terminalInstance.current;
    const fit = fitAddon.current;
    if (!term || !fit || !paneRef.current) return;
    if (paneRef.current.offsetParent === null) return;
    fit.fit();
    try {
      await resizePty(term.cols, term.rows);
    } catch {
      // Paste can proceed even if PTY resize fails; this is a best-effort sync.
    }
  };

  const handleTermPaste = async () => {
    const term = terminalInstance.current;
    if (!term) return;
    const text = await clipboardRead();
    if (!text) return;
    await syncTerminalGeometry();
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

  // @ts-expect-error openSmartMenu temporarily unused after AI panel refactor (smart table UI will be re-integrated)
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
    let unlistenSftpProgress: (() => void) | null = null;
    let unlistenDisconnect: (() => void) | null = null;
    let unlistenTheme: (() => void) | null = null;
    let unlistenFontSize: (() => void) | null = null;
    let unlistenFontFamily: (() => void) | null = null;
    let unlistenFontWeight: (() => void) | null = null;
    let unlistenCursorStyle: (() => void) | null = null;
    let unlistenCursorBlink: (() => void) | null = null;
    let unlistenLineHeight: (() => void) | null = null;
    let unlistenAutoCopy: (() => void) | null = null;
    let unlistenReconnectWriteFailures: (() => void) | null = null;
    let unlistenBackgroundImage: (() => void) | null = null;
    let unlistenBackgroundFit: (() => void) | null = null;
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
      const reconnectWriteFailures =
        (await store.get<number>("terminal.reconnectWriteFailures")) ??
        DEFAULT_APP_SETTINGS["terminal.reconnectWriteFailures"];
      const backgroundImage =
        (await store.get<string>("terminal.backgroundImage")) ??
        DEFAULT_APP_SETTINGS["terminal.backgroundImage"];
      const backgroundOpacity =
        (await store.get<number>("terminal.backgroundOpacity")) ??
        DEFAULT_APP_SETTINGS["terminal.backgroundOpacity"];
      const backgroundBlur =
        (await store.get<number>("terminal.backgroundBlur")) ??
        DEFAULT_APP_SETTINGS["terminal.backgroundBlur"];
      const backgroundFit =
        (await store.get<TerminalBackgroundFit>("terminal.backgroundFit")) ??
        DEFAULT_APP_SETTINGS["terminal.backgroundFit"];

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
      setTerminalBgFit(backgroundFit);
      setXtermBaseBg(baseBg);
      setXtermBg(themeBg);
      autoCopyRef.current = autoCopy;
      reconnectWriteFailuresRef.current = Math.max(
        1,
        Math.min(15, reconnectWriteFailures),
      );

      term = new Terminal({
        cursorBlink,
        cursorStyle,
        lineHeight,
        fontWeight,
        fontSize,
        fontFamily: withTerminalIconFontFallback(fontFamily),
        theme: { ...xtermTheme, background: themeBg },
        allowTransparency: true,
        allowProposedApi: true,
        scrollback: 2000,
      });

      fit = new FitAddon();
      const webLinks = new WebLinksAddon();

      term.loadAddon(fit);
      term.loadAddon(webLinks);

      term.open(terminalRef.current);
      fit.fit();
      restoreTerminalSnapshot(term);

      terminalInstance.current = term;
      fitAddon.current = fit;

      const syncGeometryOnNativePaste = () => {
        void syncTerminalGeometry();
      };
      term.textarea?.addEventListener("paste", syncGeometryOnNativePaste, true);
      term.element?.addEventListener("paste", syncGeometryOnNativePaste, true);

      const adjustTerminalFontSize = (delta: number) => {
        if (!term) return;
        const current =
          typeof term.options.fontSize === "number"
            ? term.options.fontSize
            : DEFAULT_APP_SETTINGS["terminal.fontSize"];
        const next = Math.max(
          TERMINAL_FONT_SIZE_MIN,
          Math.min(TERMINAL_FONT_SIZE_MAX, Math.round(current + delta)),
        );
        if (next === current) return;
        term.options.fontSize = next;
        requestAnimationFrame(() => {
          fitAndResize();
        });
        void writeAppSetting("terminal.fontSize", next);
      };

      // Copy/paste integration:
      // - Cmd+C copies selection; otherwise it remains Ctrl+C (interrupt).
      // - Ctrl+Shift+C copies selection (Windows/Linux convention).
      // - Cmd+V uses native paste event handling to avoid browser clipboard permission UI.
      // - Ctrl+Shift+V uses app clipboard read (Windows/Linux convention).
      term.attachCustomKeyEventHandler((ev) => {
        if (!term) return true;
        if (ev.type !== "keydown") return true;

        const key = ev.key.toLowerCase();
        const isMac = /mac|iphone|ipad|ipod/.test(navigator.platform.toLowerCase());
        const isCmdOrCtrl = ev.metaKey || ev.ctrlKey;
        const isCopy =
          (ev.ctrlKey && ev.shiftKey && key === "c") ||
          (ev.metaKey && !ev.shiftKey && key === "c");
        const isPaste =
          (ev.ctrlKey && ev.shiftKey && key === "v") ||
          (ev.metaKey && !ev.shiftKey && key === "v");
        const isZoomIn =
          isCmdOrCtrl &&
          !ev.altKey &&
          !(
            (ev.ctrlKey && ev.metaKey) ||
            (ev.ctrlKey && ev.shiftKey && key === "c") ||
            (ev.ctrlKey && ev.shiftKey && key === "v")
          ) &&
          (key === "+" ||
            key === "=" ||
            ev.code === "NumpadAdd");
        const isZoomOut =
          isCmdOrCtrl &&
          !ev.altKey &&
          !(
            (ev.ctrlKey && ev.metaKey) ||
            (ev.ctrlKey && ev.shiftKey && key === "c") ||
            (ev.ctrlKey && ev.shiftKey && key === "v")
          ) &&
          (key === "-" || key === "_" || ev.code === "NumpadSubtract");
        const isFindShortcut =
          isCmdOrCtrl && !ev.altKey && !ev.shiftKey && key === "f";

        if (isFindShortcut) {
          ev.preventDefault();
          openTerminalFind();
          return false;
        }

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

        if (isZoomIn) {
          ev.preventDefault();
          ev.stopPropagation();
          adjustTerminalFontSize(1);
          return false;
        }

        if (isZoomOut) {
          ev.preventDefault();
          ev.stopPropagation();
          adjustTerminalFontSize(-1);
          return false;
        }

        if (isPaste) {
          // On macOS, let the browser/xterm native paste event flow.
          // This avoids Chromium permission UI showing an extra "paste" button.
          if (ev.metaKey && !ev.ctrlKey && !ev.shiftKey) {
            return true;
          }

          ev.preventDefault();
          ev.stopPropagation();
          void clipboardRead().then((text) => {
            if (!term || disposed) return;
            if (!text) return;
            void syncTerminalGeometry().then(() => {
              if (!term || disposed) return;
              term.paste(text);
            });
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
        removeContextMenu = () => {
          const activeTerm = term;
          el.removeEventListener("contextmenu", onContextMenu);
          activeTerm?.textarea?.removeEventListener("paste", syncGeometryOnNativePaste, true);
          activeTerm?.element?.removeEventListener("paste", syncGeometryOnNativePaste, true);
        };
      }

      void ensureSessionReady("mount");

      // Listen for terminal output from backend
      const unlisten = await listen<{ session_id: string; data: string }>(
        "terminal-output",
        (event) => {
          if (!term) return;
          if (event.payload.session_id === sessionId) {
            let nextChunk = event.payload.data;
            if (suppressReconnectBannerRef.current) {
              reconnectBannerBufferRef.current += nextChunk;
              const stripped = stripReconnectBanner(reconnectBannerBufferRef.current);
              if (stripped === null) {
                if (reconnectBannerBufferRef.current.length < 4096 && reconnectingRef.current) {
                  return;
                }
                nextChunk = reconnectBannerBufferRef.current;
              } else {
                nextChunk = stripped;
              }
              suppressReconnectBannerRef.current = false;
              reconnectBannerBufferRef.current = "";
            }
            consumeAgentTerminalOutput(nextChunk);
            const displayChunk = stripAgentInternalOutput(nextChunk);
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

      const unlistenTransferProgress = await listen<SftpTransferProgressEvent>(
        "sftp-transfer-progress",
        (event) => {
          if (event.payload.session_id !== sessionId) return;
          const transferId = event.payload.transfer_id;
          if (!transferId) return;
          const percent = Number.isFinite(event.payload.percent)
            ? Math.max(0, Math.min(100, Math.round(event.payload.percent)))
            : 0;
          const transferred = Math.max(0, event.payload.transferred ?? 0);
          const total = Math.max(0, event.payload.total ?? 0);
          const now = Date.now();
          const prevRate = transferRateRef.current[transferId] ?? {
            transferred,
            ts: now,
            speedBps: 0,
          };
          const deltaBytes = Math.max(0, transferred - prevRate.transferred);
          const deltaMs = Math.max(1, now - prevRate.ts);
          const instantBps = deltaBytes > 0 ? (deltaBytes * 1000) / deltaMs : 0;
          const speedBps =
            prevRate.speedBps > 0 && instantBps > 0
              ? prevRate.speedBps * 0.65 + instantBps * 0.35
              : instantBps;
          transferRateRef.current[transferId] = {
            transferred,
            ts: now,
            speedBps,
          };
          const speedText = formatTransferSpeed(speedBps);
          const detail =
            total > 0
              ? `${percent}% · ${formatTransferBytes(transferred)} / ${formatTransferBytes(total)}${
                  speedText ? ` · ${speedText}` : ""
                }`
              : `${formatTransferBytes(transferred)}${speedText ? ` · ${speedText}` : ""}`;

          const pendingPatch = {
            progress: percent,
            speedBps,
            detail,
          };
          const nowTs = Date.now();
          const uiState = transferUiProgressRef.current[transferId] ?? {
            lastAt: 0,
            timer: null,
            latest: null,
          };
          transferUiProgressRef.current[transferId] = uiState;

          const applyNow = () => {
            uiState.lastAt = Date.now();
            uiState.latest = null;
            if (uiState.timer) {
              window.clearTimeout(uiState.timer);
              uiState.timer = null;
            }
            updateTransferTask(transferId, pendingPatch);
          };

          if (nowTs - uiState.lastAt >= 2000) {
            applyNow();
            return;
          }

          uiState.latest = pendingPatch;
          if (uiState.timer) return;
          const waitMs = Math.max(0, 2000 - (nowTs - uiState.lastAt));
          uiState.timer = window.setTimeout(() => {
            const state = transferUiProgressRef.current[transferId];
            if (!state) return;
            state.timer = null;
            if (!state.latest) return;
            const latest = state.latest;
            state.latest = null;
            state.lastAt = Date.now();
            updateTransferTask(transferId, latest);
          }, waitMs);
        },
      );
      unlistenSftpProgress = unlistenTransferProgress;

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
        if (!isLocal) {
          startReconnectFlow();
          return;
        }
        setConnStatus("error");
        setConnError(t("terminal.session.disconnected"));
      });
      unlistenDisconnect = unlistenDisconnectEvent;

      // Handle user input
      disposable = term.onData((data) => {
        lastInputAtRef.current = Date.now();
        consumeTerminalInput(data);
        enqueueTypingWrite(data);
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
          term.options.fontFamily = withTerminalIconFontFallback(next);
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
      unlistenReconnectWriteFailures = await store.onKeyChange<number>(
        "terminal.reconnectWriteFailures",
        (v) => {
          if (disposed) return;
          const next = v ?? DEFAULT_APP_SETTINGS["terminal.reconnectWriteFailures"];
          reconnectWriteFailuresRef.current = Math.max(1, Math.min(15, next));
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
      unlistenBackgroundFit = await store.onKeyChange<TerminalBackgroundFit>(
        "terminal.backgroundFit",
        (v) => {
          if (disposed) return;
          setTerminalBgFit(v ?? DEFAULT_APP_SETTINGS["terminal.backgroundFit"]);
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
      if (transferHistoryLoadedRef.current) {
        persistTransferTasks(
          markRunningTransfersInterrupted(transferTasksRef.current),
        );
      }
      cleanupResizeListener?.();
      resizeObserver?.disconnect();
      disposable?.dispose();
      unlistenTheme?.();
      unlistenFontSize?.();
      unlistenFontFamily?.();
      unlistenOutput?.();
      unlistenSftpProgress?.();
      unlistenDisconnect?.();
      removeContextMenu?.();
      unlistenFontWeight?.();
      unlistenCursorStyle?.();
      unlistenCursorBlink?.();
      unlistenLineHeight?.();
      unlistenAutoCopy?.();
      unlistenReconnectWriteFailures?.();
      unlistenBackgroundImage?.();
      unlistenBackgroundFit?.();
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
      captureTerminalSnapshot();
      term?.dispose();
      if (typingFlushTimerRef.current !== null) {
        window.clearTimeout(typingFlushTimerRef.current);
        typingFlushTimerRef.current = null;
      }
      typingBufferRef.current = "";
    };
  }, [sessionId]);

  useEffect(() => {
    if (isLocal) {
      setEndpointIp(t("terminal.endpoint.local"));
      endpointLatencyRef.current = null;
      observedLatencyRef.current = null;
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
        const probe = `${info.ip}:${info.port}/${info.latency_ms}ms`;
        if (connStatus === "connecting" && endpointProbeLogRef.current !== probe) {
          endpointProbeLogRef.current = probe;
          appendConnectionLog(
            locale === "zh-CN"
              ? `端点探测成功：${info.ip}:${info.port}（${info.latency_ms}ms）`
              : `Endpoint probe ok: ${info.ip}:${info.port} (${info.latency_ms}ms)`,
          );
        }
        endpointLatencyRef.current = info.latency_ms;
        if (observedLatencyRef.current !== null) {
          observedLatencyRef.current = Math.round(observedLatencyRef.current * 0.85);
          if (observedLatencyRef.current < 20) {
            observedLatencyRef.current = null;
          }
        }
        setLatencyMs(
          Math.max(
            endpointLatencyRef.current ?? 0,
            observedLatencyRef.current ?? 0,
          ),
        );
      } catch {
        if (disposed) return;
        endpointLatencyRef.current = null;
        setLatencyMs(observedLatencyRef.current);
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
  }, [appendConnectionLog, connStatus, host, isLocal, locale, port, t]);

  useEffect(() => {
    setEndpointCopied(false);
  }, [endpointCopyText]);

  useEffect(() => {
    setConnectionLogOpen(false);
  }, [sessionId]);

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
      customStyle["--xterminal-bg-size"] = TERMINAL_BG_SIZE_MAP[terminalBgFit];
    }
    return style;
  }, [terminalBgBlur, terminalBgFit, terminalBgImage, terminalBgOpacity, xtermBaseBg, xtermBg]);

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
          <button
            className={`xterminal-topbar-btn ${connectionLogOpen ? "xterminal-topbar-btn--active" : ""}`}
            type="button"
            onClick={() => setConnectionLogOpen((prev) => !prev)}
            title={locale === "zh-CN" ? "连接日志" : "Connection log"}
            aria-label={locale === "zh-CN" ? "连接日志" : "Connection log"}
          >
            <AppIcon icon="material-symbols:article-outline-rounded" size={18} />
          </button>
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
          {supportsSftp && (
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
          )}
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
          {onCloseSession && (
            <button
              className="xterminal-topbar-btn"
              type="button"
              onClick={onCloseSession}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <AppIcon icon="material-symbols:close-rounded" size={18} />
            </button>
          )}
        </div>
      </div>

      {connectionLogOpen && (
        <div className="xterminal-connect-log" role="status" aria-live="polite">
          <div className="xterminal-connect-log-title">
            {locale === "zh-CN" ? "连接日志" : "Connection Log"}
          </div>
          <div className="xterminal-connect-log-list">
            {connectionLogs.length > 0 ? (
              connectionLogs.slice(-8).map((line, index) => (
                <div key={`${line}-${index}`} className="xterminal-connect-log-line">
                  {line}
                </div>
              ))
            ) : (
              <div className="xterminal-connect-log-line">
                {locale === "zh-CN" ? "暂无连接日志" : "No connection logs yet"}
              </div>
            )}
          </div>
        </div>
      )}

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
            {terminalFindOpen && (
              <div className="xterminal-find" role="search" aria-label="Terminal search">
                <div className="xterminal-find-main">
                  <AppIcon icon="material-symbols:search-rounded" size={14} />
                  <input
                    ref={terminalFindInputRef}
                    type="text"
                    value={terminalFindQuery}
                    onChange={(event) => {
                      setTerminalFindQuery(event.target.value);
                      setTerminalFindStatus("idle");
                    }}
                    placeholder={locale === "zh-CN" ? "搜索终端内容" : "Search terminal output"}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void findInTerminal(event.shiftKey ? "prev" : "next");
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        closeTerminalFind();
                      }
                    }}
                  />
                </div>
                <div className="xterminal-find-actions">
                  <button
                    type="button"
                    className={`xterminal-find-flag ${
                      terminalFindCaseSensitive ? "is-active" : ""
                    }`}
                    onClick={() => {
                      setTerminalFindCaseSensitive((prev) => !prev);
                      setTerminalFindStatus("idle");
                    }}
                    title={locale === "zh-CN" ? "区分大小写" : "Case sensitive"}
                  >
                    Aa
                  </button>
                  <button
                    type="button"
                    className="xterminal-find-btn"
                    onClick={() => {
                      void findInTerminal("prev");
                    }}
                    title={locale === "zh-CN" ? "上一个" : "Previous"}
                  >
                    <AppIcon icon="material-symbols:keyboard-arrow-up-rounded" size={16} />
                  </button>
                  <button
                    type="button"
                    className="xterminal-find-btn"
                    onClick={() => {
                      void findInTerminal("next");
                    }}
                    title={locale === "zh-CN" ? "下一个" : "Next"}
                  >
                    <AppIcon icon="material-symbols:keyboard-arrow-down-rounded" size={16} />
                  </button>
                  <span
                    className={`xterminal-find-status ${
                      terminalFindStatus === "not_found" ? "is-error" : ""
                    }`}
                  >
                    {terminalFindStatus === "not_found"
                      ? locale === "zh-CN"
                        ? "未找到"
                        : "No match"
                      : terminalFindStatus === "found"
                      ? locale === "zh-CN"
                        ? "已匹配"
                        : "Matched"
                      : ""}
                  </span>
                  <button
                    type="button"
                    className="xterminal-find-btn"
                    onClick={closeTerminalFind}
                    title={locale === "zh-CN" ? "关闭" : "Close"}
                  >
                    <AppIcon icon="material-symbols:close-rounded" size={16} />
                  </button>
                </div>
              </div>
            )}
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
          {supportsSftp && sftpOpen && (
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
              <div
                className="xterminal-sftp-body"
                onDragEnter={handleSftpDragEnter}
                onDragLeave={handleSftpDragLeave}
                onDragOver={handleSftpDragOver}
                onDrop={(event) => void handleSftpDrop(event)}
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
                {sftpDragging && (
                  <div className="xterminal-sftp-drop-overlay">
                    <div className="xterminal-sftp-drop-content">
                      <AppIcon icon="material-symbols:upload-rounded" size={24} />
                      <span>
                        {sftpDropTarget
                          ? t("terminal.sftp.dropHintTarget", { name: sftpDropTarget.name })
                          : t("terminal.sftp.dropHint")}
                      </span>
                    </div>
                  </div>
                )}
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
                    <AppIcon
                      className="xterminal-sftp-notice-icon"
                      icon="material-symbols:error-outline-rounded"
                      size={16}
                    />
                    <span className="xterminal-sftp-notice-text">{sftpError}</span>
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
                        className={`xterminal-sftp-item ${entry.is_dir ? "xterminal-sftp-item--dir" : "xterminal-sftp-item--file"} ${
                          sftpDropTarget?.name === entry.name && entry.is_dir ? "xterminal-sftp-item--drop-target" : ""
                        }`}
                        data-drop-path={entry.is_dir && entry.name !== ".." ? buildNestedRemotePath(sftpPath || "/", entry.name) : undefined}
                        data-drop-name={entry.is_dir && entry.name !== ".." ? entry.name : undefined}
                        onClick={() => handleEntryClick(entry)}
                        onDoubleClick={() => {
                          if (entry.is_dir) return;
                          void handleOpenFileForEditing(entry);
                        }}
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
                            {formatSftpListSize(entry.size)}
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
                            void handleOpenFileForEditing(sftpMenu.entry);
                            setSftpMenu(null);
                          }}
                        >
                          <AppIcon icon="material-symbols:open-in-new-rounded" size={16} />
                          {t("terminal.sftp.menu.open")}
                        </button>
                      )}
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
	                      {t("terminal.ai.title")}
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
                <AgentStreamView
                  blocks={agentBlocks}
                  isRunning={agentRunning}
                  pendingConfirmation={agentPendingConfirmation}
                  onConfirm={(actionId) => {
                    setAgentPendingConfirmation(null);
                    agentLoopRef.current?.confirmAction(actionId);
                  }}
                  onReject={(actionId) => {
                    setAgentPendingConfirmation(null);
                    agentLoopRef.current?.rejectAction(actionId);
                  }}
                  onCopy={(text) => clipboardWrite(text)}
                />
                {aiError && <div className="xterminal-ai-error">{aiError}</div>}
                <div className="xterminal-ai-input">
	                  <div className="xterminal-ai-input-box">
	                    <textarea
	                      ref={aiInputRef}
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
                      {aiAttachments.length > 0 && (
                        <div className="xterminal-ai-attachments">
                          {aiAttachments.map((attachment) => (
                            <span key={attachment.id} className="xterminal-ai-attachment-chip">
                              <AppIcon
                                icon={attachment.kind === "image" ? "proicons:image" : "material-symbols:description-outline-rounded"}
                                size={14}
                              />
                              <span className="xterminal-ai-attachment-name">{attachment.name}</span>
                              <button
                                type="button"
                                className="xterminal-ai-attachment-remove"
                                onClick={() => removeAiAttachment(attachment.id)}
                                aria-label={t("common.close")}
                                title={t("common.close")}
                                disabled={aiBusy}
                              >
                                <AppIcon icon="material-symbols:close-rounded" size={14} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
	                      <div className="xterminal-ai-input-footer">
	                      <div className="xterminal-ai-input-meta">
                          <button
                            type="button"
                            className="xterminal-ai-footer-icon-btn"
                            onClick={() => void handlePickAiAttachments()}
                            title={t("terminal.ai.attach")}
                            aria-label={t("terminal.ai.attach")}
                            disabled={aiBusy}
                          >
                            <AppIcon icon="material-symbols:add-rounded" size={18} />
                          </button>
                          <div className="xterminal-ai-mode-dropdown" ref={aiApprovalMenuRef}>
                            <button
                              type="button"
                              className={`xterminal-ai-mode-pill${aiApprovalMenuOpen ? " xterminal-ai-mode-pill--open" : ""}`}
                              onClick={() => {
                                setAiModelMenuOpen(false);
                                setAiApprovalMenuOpen((prev) => !prev);
                              }}
                              disabled={aiBusy}
                              aria-haspopup="listbox"
                              aria-expanded={aiApprovalMenuOpen}
                              title={t("terminal.ai.approvalMode.title")}
                            >
                              <span className="xterminal-ai-mode-value">
                                {activeAiApprovalMode.label}
                              </span>
                              <AppIcon
                                className="xterminal-ai-model-caret"
                                icon="material-symbols:keyboard-arrow-down-rounded"
                                size={16}
                              />
                            </button>
                            {aiApprovalMenuOpen && (
                              <div className="xterminal-ai-mode-menu" role="listbox">
                                {aiApprovalModeOptions.map((option) => (
                                  <button
                                    key={option.value}
                                    type="button"
                                    className={`xterminal-ai-mode-item${option.value === aiApprovalMode ? " is-active" : ""}`}
                                    onClick={() => void handleSelectAiApprovalMode(option.value)}
                                    role="option"
                                    aria-selected={option.value === aiApprovalMode}
                                  >
                                    <span className="xterminal-ai-mode-copy">
                                      <span className="xterminal-ai-mode-label">{option.label}</span>
                                      <span className="xterminal-ai-mode-description">
                                        {option.description}
                                      </span>
                                    </span>
                                    {option.value === aiApprovalMode && (
                                      <AppIcon
                                        className="xterminal-ai-mode-check"
                                        icon="material-symbols:check-rounded"
                                        size={18}
                                      />
                                    )}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
	                      </div>
	                      <div className="xterminal-ai-input-actions">
                          <div className="xterminal-ai-model-dropdown" ref={aiModelMenuRef}>
                            <button
                              type="button"
                              className={`xterminal-ai-model-pill${aiModelMenuOpen ? " xterminal-ai-model-pill--open" : ""}`}
                              onClick={() => {
                                setAiApprovalMenuOpen(false);
                                setAiModelMenuOpen((prev) => !prev);
                              }}
                              disabled={aiBusy}
                              aria-haspopup="listbox"
                              aria-expanded={aiModelMenuOpen}
                            >
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
	                        {aiMessages.length > 0 && (
	                          <button
	                            type="button"
	                            className="xterminal-ai-footer-icon-btn"
	                            onClick={clearAiConversationContext}
	                            title={t("terminal.ai.clearContext")}
	                            aria-label={t("terminal.ai.clearContext")}
	                          >
	                            <AppIcon icon="proicons:delete" size={16} />
	                          </button>
	                        )}
	                        <button
	                          type="button"
	                          className="xterminal-ai-send"
                          onClick={() => {
                            if (aiBusy) {
                              interruptAiConversation();
                              return;
                            }
                            void sendAiMessage(aiInput);
                            setAiInput("");
                          }}
                          disabled={!aiBusy && !aiInput.trim() && aiAttachments.length === 0}
                          title={aiBusy ? t("terminal.ai.stop") : t("terminal.ai.send")}
                          aria-label={aiBusy ? t("terminal.ai.stop") : t("terminal.ai.send")}
                        >
                          <AppIcon icon={aiBusy ? "proicons:record-stop" : "proicons:send"} size={16}/>
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
          <div className="xterminal-toolbar-item xterminal-toolbar-item--metric">
            <AppIcon icon="proicons:globe" size={16} />
            <span
              className={`xterminal-toolbar-value xterminal-toolbar-value--metric xterminal-latency xterminal-latency--${latencyTone}`}
              title={t("terminal.toolbar.latency")}
            >
              {latencyMs === null ? "--" : `${latencyMs} ms`}
            </span>
          </div>

          {supportsToolbarResourceStats && (
            <>
              <span className="xterminal-toolbar-dot" aria-hidden="true" />
              <div className="xterminal-toolbar-item xterminal-toolbar-item--metric-group">
                <span
                  className="xterminal-toolbar-value xterminal-toolbar-value--resource-group"
                  title={t("terminal.toolbar.cpuShort")}
                >
                  <AppIcon icon="material-symbols:developer-board-rounded" size={16} />
                  <span className="xterminal-toolbar-value xterminal-toolbar-value--metric">
                    {resourceCpuLabel}
                  </span>
                </span>
                <span
                  className="xterminal-toolbar-value xterminal-toolbar-value--resource-group"
                  title={t("terminal.toolbar.memShort")}
                >
                  <AppIcon icon="material-symbols:view-stream-rounded" size={16} />
                  <span className="xterminal-toolbar-value xterminal-toolbar-value--metric">
                    {resourceMemoryLabel}
                  </span>
                </span>
              </div>
            </>
          )}

          <span className="xterminal-toolbar-dot" aria-hidden="true" />

          <div
            className="xterminal-toolbar-item"
            style={{ flex: 1, minWidth: 0 }}
          >
            <AppIcon icon="proicons:server" size={16} />
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
          {supportsSftp && (
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
          )}
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
        {supportsSftp && transferPanelOpen && (
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
                      {t("terminal.transfer.createdAt", {
                        time: formatTransferTime(task.startedAt),
                      })}
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
                    <div className="xterminal-transfer-item-actions">
                      {task.direction === "download" && task.status === "running" && (
                        <button
                          type="button"
                          className="xterminal-script-link"
                          onClick={() => void handlePauseTransferTask(task)}
                        >
                          <AppIcon icon="material-symbols:pause-rounded" size={16} />
                          {t("terminal.transfer.pause")}
                        </button>
                      )}
                      {task.direction === "download" && task.status === "paused" && (
                        <button
                          type="button"
                          className="xterminal-script-link"
                          onClick={() => void handleResumeTransferTask(task)}
                        >
                          <AppIcon icon="material-symbols:play-arrow-rounded" size={16} />
                          {t("terminal.transfer.resume")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="xterminal-script-link"
                        onClick={() => void handleOpenTransferDirectory(task)}
                      >
                        <AppIcon icon="material-symbols:folder-open-rounded" size={16} />
                        {t("terminal.transfer.openFolder")}
                      </button>
                      <button
                        type="button"
                        className="xterminal-script-link xterminal-transfer-delete"
                        onClick={() => void handleDeleteTransferTask(task)}
                      >
                        <AppIcon icon="material-symbols:close-rounded" size={16} />
                        {t("terminal.transfer.delete")}
                      </button>
                    </div>
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

      <ScriptPicker
        open={scriptPickerOpen}
        onClose={() => setScriptPickerOpen(false)}
        onSelect={(script) => handleInsertScript(script.content)}
      />
    </>
  );
}
