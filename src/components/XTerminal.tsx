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
import { sendAiChat, type AiMessage } from "../api/ai";
import AiRenderer from "./AiRenderer2";
import {
  DEFAULT_APP_SETTINGS,
  getAppSettingsStore,
  type TerminalThemeName,
} from "../store/appSettings";
import { getXtermTheme } from "../terminal/xtermThemes";
import { getModifierKeyAbbr, getModifierKeyLabel } from "../utils/platform";
import { useI18n } from "../i18n";

interface XTerminalProps {
  sessionId: string;
  host: string;
  port: number;
  isLocal?: boolean;
  onConnect?: () => Promise<void>;
  onRequestSplit?: (direction: "vertical" | "horizontal") => void;
  onCloseSession?: () => void;
  isSplit?: boolean;
  onSendScript?: (content: string, scope: "current" | "all") => Promise<void> | void;
}

type ConnectionStatus = "idle" | "connecting" | "connected" | "error";
type TransferTaskDirection = "upload" | "download";
type TransferTaskStatus = "running" | "success" | "failed";

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

const OPENAI_MODEL_OPTIONS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
];

const ANTHROPIC_MODEL_OPTIONS = [
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-20250514",
  "claude-3-5-sonnet-20240620",
  "claude-3-5-haiku-20241022",
];
const MAX_TRANSFER_TASKS = 120;

export function XTerminal({
  sessionId,
  host,
  port,
  isLocal = false,
  onConnect,
  onRequestSplit,
  onCloseSession,
  isSplit = false,
  onSendScript,
}: XTerminalProps) {
  const { t } = useI18n();
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
  const [xtermBg, setXtermBg] = useState<string | undefined>(undefined);
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
  const [aiMessages, setAiMessages] = useState<Array<AiMessage & { createdAt: number }>>([]);
  const [aiInput, setAiInput] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiWidth, setAiWidth] = useState(360);
  const [aiProvider, setAiProvider] = useState<"openai" | "anthropic">(
    DEFAULT_APP_SETTINGS["ai.provider"],
  );
  const [aiModel, setAiModel] = useState<string>("");
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
  const autoCopyRef = useRef<boolean>(DEFAULT_APP_SETTINGS["terminal.autoCopy"]);
  const lastSelectionRef = useRef<string>("");
  const lastCopyAtRef = useRef<number>(0);
  const modelOptions = aiProvider === "openai" ? OPENAI_MODEL_OPTIONS : ANTHROPIC_MODEL_OPTIONS;
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
    setAiProvider(settings.provider);
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
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const loadHistory = async () => {
      try {
        const store = await getAppSettingsStore();
        const raw = await store.get<
          Array<AiMessage & { createdAt?: number }>
        >(aiHistoryKey);
        if (!disposed && Array.isArray(raw) && raw.length > 0) {
          const normalized = raw
            .filter((item) => item && typeof item.content === "string" && item.role)
            .map((item) => ({
              role: item.role,
              content: item.content,
              createdAt: item.createdAt ?? Date.now(),
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

  const formatError = (error: unknown) => {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  };

  const formatTransferTime = (value: number) =>
    new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(value));

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

  const endpointLabel = useMemo(() => {
    if (!endpointIp) return "--";
    return endpointIp;
  }, [endpointIp]);

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
        resizing.type === "sftp"
          ? aiOpen
            ? aiWidth
            : 0
          : sftpOpen
            ? sftpWidth
            : 0;
      const minWidth = resizing.type === "sftp" ? 220 : 260;
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
    setScriptPanelOpen(true);
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

  const sendAiMessage = async (content: string) => {
    if (!content.trim()) return;
    setAiError(null);
    setAiBusy(true);

    const userMessage: AiMessage & { createdAt: number } = { role: "user", content, createdAt: Date.now() };
    const nextMessages = [...aiMessages, userMessage];
    setAiMessages(nextMessages);

    try {
      const settings = await readAiSettings();
      const selectedModel = aiModel.trim() || settings.model;
      const nextSettings = selectedModel ? { ...settings, model: selectedModel } : settings;
      const systemMessage: AiMessage = {
        role: "system",
        content: t("terminal.ai.system"),
      };
      const response = await sendAiChat(nextSettings, [
        systemMessage,
        ...nextMessages.map(({ role, content }) => ({ role, content })),
      ]);
      setAiMessages((prev) => [
        ...prev,
        { role: "assistant", content: response, createdAt: Date.now() },
      ]);
    } catch (error) {
      const message = formatError(error);
      setAiError(message);
    } finally {
      setAiBusy(false);
    }
  };

  const openAiFromTerminal = async (mode: "ask" | "fix") => {
    setTermMenu(null);
    const context = getTerminalContext();
    if (!context) {
      setAiError(t("terminal.ai.noContext"));
      setScriptPanelOpen(true);
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

  useEffect(() => {
    if (!terminalRef.current) return;

    let disposed = false;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let unlistenOutput: (() => void) | null = null;
    let unlistenTheme: (() => void) | null = null;
    let unlistenFontSize: (() => void) | null = null;
    let unlistenFontFamily: (() => void) | null = null;
    let unlistenFontWeight: (() => void) | null = null;
    let unlistenCursorStyle: (() => void) | null = null;
    let unlistenCursorBlink: (() => void) | null = null;
    let unlistenLineHeight: (() => void) | null = null;
    let unlistenAutoCopy: (() => void) | null = null;
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

      if (disposed || !terminalRef.current) return;

      const xtermTheme = getXtermTheme(themeName);
      setXtermBg(xtermTheme.background);
      autoCopyRef.current = autoCopy;

      term = new Terminal({
        cursorBlink,
        cursorStyle,
        lineHeight,
        fontWeight,
        fontSize,
        fontFamily,
        theme: xtermTheme,
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
        const isCopy =
          (ev.ctrlKey && ev.shiftKey && key === "c") ||
          (ev.metaKey && !ev.shiftKey && key === "c");
        const isPaste =
          (ev.ctrlKey && ev.shiftKey && key === "v") ||
          (ev.metaKey && !ev.shiftKey && key === "v");

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
            term.write(event.payload.data);
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

      // Handle user input
      disposable = term.onData((data) => {
        lastInputAtRef.current = Date.now();
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
          const t = getXtermTheme(next);
          setXtermBg(t.background);
          term.options.theme = t;
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
      removeContextMenu?.();
      unlistenFontWeight?.();
      unlistenCursorStyle?.();
      unlistenCursorBlink?.();
      unlistenLineHeight?.();
      unlistenAutoCopy?.();
      selectionDisposable?.dispose();
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

  const statusIcon = useMemo(() => {
    if (connStatus === "connecting") return "material-symbols:sync-rounded";
    if (connStatus === "connected")
      return "material-symbols:check-circle-rounded";
    if (connStatus === "error") return "material-symbols:error-rounded";
    return "material-symbols:cloud-off-rounded";
  }, [connStatus, t]);

  const statusText = useMemo(() => {
    if (connStatus === "connecting") return t("terminal.status.connecting");
    if (connStatus === "connected") return t("terminal.status.connected");
    if (connStatus === "error") return t("terminal.status.error");
    return t("terminal.status.idle");
  }, [connStatus]);

  return (
    <>
      <div
        className="xterminal"
        style={
          xtermBg
            ? ({
                ["--xterminal-xterm-bg"]: xtermBg,
              } as CSSProperties)
            : undefined
        }
      >
      <div className="xterminal-topbar">
        <div className= {[
          "xterminal-topbar-left",
          `xterminal-topbar-left--${connStatus}`
        ].filter(Boolean).join(" ")}
          title={connError ?? undefined}>
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
            <AppIcon icon={statusIcon} size={18} />
          </span>
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
                <AppIcon icon="material-symbols:splitscreen-right" size={18} />
              </button>
              <button
                className="xterminal-topbar-btn"
                type="button"
                onClick={() => onRequestSplit("horizontal")}
                title={t("terminal.split.horizontal")}
                aria-label={t("terminal.split.horizontal")}
              >
                <AppIcon icon="material-symbols:splitscreen-bottom" size={18} />
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
            <AppIcon icon="material-symbols:folder-open-outline-rounded" size={18} />
          </button>
          <button
            className={`xterminal-topbar-btn ${aiOpen ? "xterminal-topbar-btn--active" : ""}`}
            type="button"
            onClick={() => setAiOpen((prev) => !prev)}
            title={t("terminal.ai.toggle")}
          >
            <AppIcon icon="material-symbols:forum-rounded" size={18} />
          </button>
          {onCloseSession && (
            <button
              className="xterminal-topbar-btn"
              type="button"
              onClick={onCloseSession}
              title={t("terminal.close")}
              aria-label={t("terminal.close")}
            >
              <AppIcon icon="material-symbols:close-rounded" size={18} />
            </button>
          )}
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
                  <div className="xterminal-ai-title">{t("terminal.ai.title")}</div>
                  <button
                    type="button"
                    className="xterminal-ai-close"
                    onClick={() => setAiOpen(false)}
                    title={t("common.close")}
                  >
                    <AppIcon icon="material-symbols:close-rounded" size={16} />
                  </button>
                </div>
              <div className="xterminal-ai-body">
                <div className="xterminal-ai-history">
                  {aiMessages.length === 0 && (
                    <div className="xterminal-ai-empty">
                      {t("terminal.ai.empty")}
                    </div>
                  )}
                  {aiMessages.map((msg, index) => {
                    const prev = aiMessages[index - 1];
                    const grouped = prev && prev.role === msg.role;
                    return (
                    <div
                      key={`${msg.role}-${index}`}
                      className={`xterminal-ai-message xterminal-ai-message--${msg.role}${grouped ? " xterminal-ai-message--grouped" : ""}`}
                    >
                      <div className="xterminal-ai-content">
                        <AiRenderer content={msg.content} sessionId={sessionId} useLocal={isLocal} role={msg.role} />
                      </div>
                    </div>
                  );
                  })}
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
                              icon="material-symbols:smart-toy-outline"
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
                        <AppIcon icon="material-symbols:send-outline-rounded" size={16}/>
                        {/* {aiBusy ? "发送中..." : "发送"} */}
                      </button>
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
            <AppIcon icon="material-symbols:speed-rounded" size={16} />
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
            <AppIcon icon="material-symbols:lan" size={16} />
            <span className="xterminal-toolbar-label">
              {t("terminal.toolbar.endpoint")}
            </span>
            <span className="xterminal-toolbar-value">{endpointLabel}</span>
          </div>

          <button
            type="button"
            className="xterminal-toolbar-btn"
            onClick={() => setScriptPanelOpen((prev) => !prev)}
            title={t("terminal.toolbar.script")}
          >
            <AppIcon icon="material-symbols:terminal-rounded" size={16} />
            {t("terminal.toolbar.quickActions")}
          </button>
          <button
            type="button"
            className={`xterminal-toolbar-btn ${transferPanelOpen ? "xterminal-toolbar-btn--active" : ""}`}
            onClick={() => setTransferPanelOpen((prev) => !prev)}
            title={t("terminal.transfer.title")}
          >
            <AppIcon icon="material-symbols:download-rounded" size={16} />
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
                  <AppIcon icon="material-symbols:code-blocks-rounded" size={16} />
                  {t("terminal.script.library")}
                </button>
                <button
                  type="button"
                  className="xterminal-script-link"
                  onClick={() => setScriptText("")}
                >
                  <AppIcon icon="material-symbols:delete-outline-rounded" size={16} />
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
                  <AppIcon icon="material-symbols:content-copy-outline-rounded" size={16} />
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
                  <AppIcon icon="material-symbols:content-paste-rounded" size={16} />
                  {t("terminal.menu.paste")}
                </button>
                <button
                  type="button"
                  className="xterminal-term-menu-item"
                  onClick={handleTermClear}
                >
                  <AppIcon icon="material-symbols:delete-sweep-rounded" size={16} />
                  {t("terminal.menu.clear")}
                </button>
                <div className="xterminal-term-menu-divider" />
                <button
                  type="button"
                  className="xterminal-term-menu-item"
                  onClick={() => void openAiFromTerminal("fix")}
                >
                  <AppIcon icon="material-symbols:build-rounded" size={16} />
                  {t("terminal.menu.ai.fix")}
                </button>
                <button
                  type="button"
                  className="xterminal-term-menu-item"
                  onClick={() => void openAiFromTerminal("ask")}
                >
                  <AppIcon icon="material-symbols:forum-rounded" size={16} />
                  {t("terminal.menu.ai.ask")}
                </button>
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
