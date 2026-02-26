import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  writeAppSetting,
  getAppSettingsStore,
  DEFAULT_TERMINAL_FONT_FAMILY,
} from "../store/appSettings";
import { load } from "@tauri-apps/plugin-store";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { mkdir, readFile, readTextFile, remove, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { BaseDirectory } from "@tauri-apps/api/path";
import { TERMINAL_THEME_OPTIONS, getXtermTheme } from "../terminal/xtermThemes";
import { sendAiChat, type AiMessage, type AiProvider } from "../api/ai";
import { generateSalt, hashMasterKey } from "../utils/security";
import { getModifierKeyName } from "../utils/platform";
import { clearMasterKeySession, setMasterKeySession } from "../utils/securitySession";
import { getVersion } from "@tauri-apps/api/app";
import { check as checkForUpdates } from "@tauri-apps/plugin-updater";
import { useI18n } from "../i18n";
import { Select } from "../components/Select";
import { Modal } from "../components/Modal";
import { AppIcon } from "../components/AppIcon";
import { toRgba } from "../utils/color";
import { loadTerminalBackgroundUrl, TERMINAL_BG_DIR } from "../utils/terminalBackground";
import { readAllAiModels, writeAiModels } from "../store/aiModels";
import "./Settings.css";

const TERMINAL_FONT_OPTIONS = [
  { label: "SF Mono", value: '"SF Mono", Monaco, Menlo, "Ubuntu Mono", monospace' },
  { label: "JetBrains Mono", value: '"JetBrains Mono", "SF Mono", Menlo, monospace' },
  { label: "Fira Code", value: '"Fira Code", "SF Mono", Menlo, monospace' },
  { label: "Hack", value: 'Hack, "SF Mono", Menlo, monospace' },
  { label: "Source Code Pro", value: '"Source Code Pro", "SF Mono", Menlo, monospace' },
  { label: "Ubuntu Mono", value: '"Ubuntu Mono", "SF Mono", Menlo, monospace' },
  { label: "Menlo", value: 'Menlo, "SF Mono", monospace' },
];

const TERMINAL_FONT_WEIGHT_OPTIONS = [
  { label: "Regular", value: 400 },
  { label: "Medium", value: 500 },
  { label: "Semibold", value: 600 },
  { label: "Bold", value: 700 },
];

const APP_THEME_OPTIONS = [
  { labelKey: "settings.theme.bright", value: "bright" },
  { labelKey: "settings.theme.mint", value: "mint" },
  { labelKey: "settings.theme.dark", value: "dark" },
];

const LOCK_TIMEOUT_OPTIONS = [
  { labelKey: "settings.security.lock.none", value: 0 },
  { labelKey: "settings.security.lock.5", value: 5 },
  { labelKey: "settings.security.lock.10", value: 10 },
  { labelKey: "settings.security.lock.15", value: 15 },
  { labelKey: "settings.security.lock.30", value: 30 },
  { labelKey: "settings.security.lock.60", value: 60 },
  { labelKey: "settings.security.lock.120", value: 120 },
];

const TERMINAL_BG_MAX_BYTES = 4 * 1024 * 1024;
const TERMINAL_BG_ALLOWED: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

type AiModelStatus = "idle" | "loading" | "success" | "error";

const normalizeBaseUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
};

const NON_CHAT_MODEL_KEYWORDS = [
  "embedding",
  "text-embedding",
  "bge-",
  "/bge",
  "rerank",
  "moderation",
  "omni-moderation",
  "whisper",
  "tts",
  "transcribe",
  "speech",
  "text-to-image",
  "image-generation",
  "dall-e",
  "sdxl",
  "stable-diffusion",
];

const isChatCapableModel = (model: string) => {
  const lower = model.toLowerCase();
  return !NON_CHAT_MODEL_KEYWORDS.some((keyword) => lower.includes(keyword));
};

const detectModelCapability = (model: string) => {
  const lower = model.toLowerCase();
  if (lower.includes("embedding") || lower.includes("bge")) return "Embedding";
  if (lower.includes("rerank")) return "Reranker";
  if (lower.includes("vision")) return "Vision";
  if (lower.includes("audio")) return "Audio";
  if (lower.includes("reason") || lower.includes("r1")) return "Reasoning";
  return "Chat";
};


export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const previewTheme = getXtermTheme(settings["terminal.theme"]);
  const previewSelection = previewTheme.selectionBackground ?? "rgba(15, 143, 255, 0.18)";
  const terminalBackgroundImage = settings["terminal.backgroundImage"];
  const [terminalBackgroundUrl, setTerminalBackgroundUrl] = useState("");
  const terminalBackgroundUrlRef = useRef("");
  const [aiTestStatus, setAiTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [aiTestMessage, setAiTestMessage] = useState<string | null>(null);
  const [aiModels, setAiModels] = useState<Record<AiProvider, string[]>>({
    openai: [],
    anthropic: [],
  });
  const [aiModelStatus, setAiModelStatus] = useState<Record<AiProvider, AiModelStatus>>({
    openai: "idle",
    anthropic: "idle",
  });
  const [aiModelMessage, setAiModelMessage] = useState<Record<AiProvider, string | null>>({
    openai: null,
    anthropic: null,
  });
  const aiModelAutoSignatureRef = useRef<Record<AiProvider, string>>({
    openai: "",
    anthropic: "",
  });
  const [aiModelSearch, setAiModelSearch] = useState("");
  const [aiModelCustomInput, setAiModelCustomInput] = useState("");
  const [aiModelModalOpen, setAiModelModalOpen] = useState(false);
  const [masterKeyInput, setMasterKeyInput] = useState("");
  const [masterKeyConfirm, setMasterKeyConfirm] = useState("");
  const [masterKeyStatus, setMasterKeyStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [masterKeyMessage, setMasterKeyMessage] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [_, setExportMessage] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [_importMessage, setImportMessage] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>("--");
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "available" | "up-to-date" | "downloading" | "installed" | "error"
  >("idle");
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<{
    version?: string;
    date?: string;
    notes?: string;
  } | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateCheckedAt, setUpdateCheckedAt] = useState<string | null>(null);
  const [terminalBgUploading, setTerminalBgUploading] = useState(false);
  const updateRef = useRef<Awaited<ReturnType<typeof checkForUpdates>> | null>(null);
  const updateStatusRef = useRef(updateStatus);
  const hasMasterKey = Boolean(settings["security.masterKeyHash"]);
  const modifierKeyName = getModifierKeyName();
  const { t } = useI18n();
  const previewOverlay = terminalBackgroundUrl
    ? toRgba(previewTheme.background ?? "#0f111a", settings["terminal.backgroundOpacity"])
    : (previewTheme.background ?? "#0f111a");
  const previewBackgroundStyle = terminalBackgroundUrl
    ? ({
        ["--settings-term-bg-image"]: `url("${terminalBackgroundUrl}")`,
        ["--settings-term-bg-overlay"]: previewOverlay,
        ["--settings-term-bg-blur"]: `${settings["terminal.backgroundBlur"]}px`,
        backgroundColor: previewTheme.background ?? "#0f111a",
      } as CSSProperties)
    : { backgroundColor: previewTheme.background ?? "#0f111a" };

  useEffect(() => {
    updateStatusRef.current = updateStatus;
  }, [updateStatus]);

  useEffect(() => {
    let disposed = false;
    const run = async () => {
      const store = await getAppSettingsStore();
      const next: AppSettings = {
        "i18n.locale":
          (await store.get<AppSettings["i18n.locale"]>("i18n.locale")) ??
          DEFAULT_APP_SETTINGS["i18n.locale"],
        "ui.theme":
          (await store.get<AppSettings["ui.theme"]>("ui.theme")) ??
          DEFAULT_APP_SETTINGS["ui.theme"],
        "connection.autoConnect":
          (await store.get<boolean>("connection.autoConnect")) ??
          DEFAULT_APP_SETTINGS["connection.autoConnect"],
        "connection.savePassword":
          (await store.get<boolean>("connection.savePassword")) ??
          DEFAULT_APP_SETTINGS["connection.savePassword"],
        "connection.keepAlive":
          (await store.get<boolean>("connection.keepAlive")) ??
          DEFAULT_APP_SETTINGS["connection.keepAlive"],
        "connection.keepAliveInterval":
          (await store.get<number>("connection.keepAliveInterval")) ??
          DEFAULT_APP_SETTINGS["connection.keepAliveInterval"],
        "security.masterKeyHash":
          (await store.get<string>("security.masterKeyHash")) ??
          DEFAULT_APP_SETTINGS["security.masterKeyHash"],
        "security.masterKeySalt":
          (await store.get<string>("security.masterKeySalt")) ??
          DEFAULT_APP_SETTINGS["security.masterKeySalt"],
        "security.masterKeyEncSalt":
          (await store.get<string>("security.masterKeyEncSalt")) ??
          DEFAULT_APP_SETTINGS["security.masterKeyEncSalt"],
        "security.lockTimeoutMinutes":
          (await store.get<number>("security.lockTimeoutMinutes")) ??
          DEFAULT_APP_SETTINGS["security.lockTimeoutMinutes"],
        "terminal.theme":
          (await store.get<AppSettings["terminal.theme"]>("terminal.theme")) ??
          DEFAULT_APP_SETTINGS["terminal.theme"],
        "terminal.fontSize":
          (await store.get<number>("terminal.fontSize")) ??
          DEFAULT_APP_SETTINGS["terminal.fontSize"],
        "terminal.fontFamily":
          (await store.get<string>("terminal.fontFamily")) ??
          DEFAULT_APP_SETTINGS["terminal.fontFamily"],
        "terminal.fontWeight":
          (await store.get<number>("terminal.fontWeight")) ??
          DEFAULT_APP_SETTINGS["terminal.fontWeight"],
        "terminal.cursorStyle":
          (await store.get<AppSettings["terminal.cursorStyle"]>("terminal.cursorStyle")) ??
          DEFAULT_APP_SETTINGS["terminal.cursorStyle"],
        "terminal.cursorBlink":
          (await store.get<boolean>("terminal.cursorBlink")) ??
          DEFAULT_APP_SETTINGS["terminal.cursorBlink"],
        "terminal.lineHeight":
          (await store.get<number>("terminal.lineHeight")) ??
          DEFAULT_APP_SETTINGS["terminal.lineHeight"],
        "terminal.autoCopy":
          (await store.get<boolean>("terminal.autoCopy")) ??
          DEFAULT_APP_SETTINGS["terminal.autoCopy"],
        "terminal.backgroundImage":
          (await store.get<string>("terminal.backgroundImage")) ??
          DEFAULT_APP_SETTINGS["terminal.backgroundImage"],
        "terminal.backgroundOpacity":
          (await store.get<number>("terminal.backgroundOpacity")) ??
          DEFAULT_APP_SETTINGS["terminal.backgroundOpacity"],
        "terminal.backgroundBlur":
          (await store.get<number>("terminal.backgroundBlur")) ??
          DEFAULT_APP_SETTINGS["terminal.backgroundBlur"],
        "ai.enabled":
          (await store.get<boolean>("ai.enabled")) ??
          DEFAULT_APP_SETTINGS["ai.enabled"],
        "ai.provider":
          (await store.get<AppSettings["ai.provider"]>("ai.provider")) ??
          DEFAULT_APP_SETTINGS["ai.provider"],
        "ai.openai.baseUrl":
          (await store.get<string>("ai.openai.baseUrl")) ??
          DEFAULT_APP_SETTINGS["ai.openai.baseUrl"],
        "ai.openai.apiKey":
          (await store.get<string>("ai.openai.apiKey")) ??
          DEFAULT_APP_SETTINGS["ai.openai.apiKey"],
        "ai.anthropic.baseUrl":
          (await store.get<string>("ai.anthropic.baseUrl")) ??
          DEFAULT_APP_SETTINGS["ai.anthropic.baseUrl"],
        "ai.anthropic.apiKey":
          (await store.get<string>("ai.anthropic.apiKey")) ??
          DEFAULT_APP_SETTINGS["ai.anthropic.apiKey"],
        "ai.model":
          (await store.get<string>("ai.model")) ??
          DEFAULT_APP_SETTINGS["ai.model"],
        "ai.models":
          (await store.get<string[]>("ai.models")) ??
          DEFAULT_APP_SETTINGS["ai.models"],
        "ai.agentMode":
          (await store.get<AppSettings["ai.agentMode"]>("ai.agentMode")) ??
          DEFAULT_APP_SETTINGS["ai.agentMode"],
      };
      if (!disposed) setSettings(next);
    };

    void run();
    return () => {
      disposed = true;
    };
  }, []);


  useEffect(() => {
    let disposed = false;
    const run = async () => {
      const cached = await readAllAiModels();
      if (!disposed) setAiModels(cached);
    };
    void run();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const run = async () => {
      if (!terminalBackgroundImage) {
        if (!disposed) setTerminalBackgroundUrl("");
        return;
      }
      const resolved = await loadTerminalBackgroundUrl(terminalBackgroundImage);
      if (disposed) {
        if (resolved.startsWith("blob:")) {
          URL.revokeObjectURL(resolved);
        }
        return;
      }
      const prev = terminalBackgroundUrlRef.current;
      if (prev && prev.startsWith("blob:") && prev !== resolved) {
        URL.revokeObjectURL(prev);
      }
      terminalBackgroundUrlRef.current = resolved;
      setTerminalBackgroundUrl(resolved);
    };
    void run();
    return () => {
      disposed = true;
    };
  }, [terminalBackgroundImage]);

  useEffect(
    () => () => {
      const prev = terminalBackgroundUrlRef.current;
      if (prev && prev.startsWith("blob:")) {
        URL.revokeObjectURL(prev);
      }
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    const run = async () => {
      try {
        const version = await getVersion();
        if (!disposed) setAppVersion(version);
      } catch {
        if (!disposed) setAppVersion("--");
      }
    };
    void run();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onUpdateChecked = (
      event: Event,
    ) => {
      const detail = (
        event as CustomEvent<{
          checkedAt?: string;
          error?: string;
        }>
      ).detail;
      if (!detail) return;
      if (detail.checkedAt) {
        setUpdateCheckedAt(detail.checkedAt);
      }
      if (detail.error && updateStatusRef.current === "idle") {
        setUpdateStatus("error");
        setUpdateMessage(detail.error);
      }
    };

    const onUpdateAvailable = (
      event: Event,
    ) => {
      const detail = (
        event as CustomEvent<{
          version?: string;
          date?: string;
          notes?: string;
          checkedAt?: string;
        }>
      ).detail;
      if (!detail) return;
      setUpdateInfo({
        version: detail.version,
        date: detail.date,
        notes: detail.notes,
      });
      if (detail.checkedAt) {
        setUpdateCheckedAt(detail.checkedAt);
      }
      if (updateStatusRef.current === "idle" || updateStatusRef.current === "up-to-date") {
        setUpdateStatus("available");
        setUpdateMessage(
          detail.version
            ? t("settings.update.availableWithVersion", {
                version: detail.version,
                dateSuffix: "",
              })
            : t("settings.update.available"),
        );
      }
    };

    window.addEventListener("app-update-checked", onUpdateChecked);
    window.addEventListener("app-update-available", onUpdateAvailable);
    return () => {
      window.removeEventListener("app-update-checked", onUpdateChecked);
      window.removeEventListener("app-update-available", onUpdateAvailable);
    };
  }, []);

  useEffect(() => {
    return () => {
      releaseUpdateHandle();
    };
  }, []);

  const toggleSetting = <K extends keyof AppSettings>(key: K) => {
    setSettings((prev) => {
      const next = (!prev[key]) as AppSettings[K];
      void writeAppSetting(key, next);
      return { ...prev, [key]: next };
    });
  };

  const updateSetting = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => {
    setSettings((prev) => {
      void writeAppSetting(key, value);
      return { ...prev, [key]: value };
    });
  };

  useEffect(() => {
    setAiTestStatus("idle");
    setAiTestMessage(null);
  }, [
    settings["ai.enabled"],
    settings["ai.provider"],
    settings["ai.openai.baseUrl"],
    settings["ai.openai.apiKey"],
    settings["ai.anthropic.baseUrl"],
    settings["ai.anthropic.apiKey"],
    settings["ai.model"],
  ]);

  useEffect(() => {
    setMasterKeyStatus("idle");
    setMasterKeyMessage(null);
  }, [masterKeyInput, masterKeyConfirm]);


  useEffect(() => {
    setExportStatus("idle");
    setExportMessage(null);
  }, []);

  useEffect(() => {
    setImportStatus("idle");
    setImportMessage(null);
  }, []);

  const handleImportConfig = async () => {
    setImportStatus("loading");
    setImportMessage(null);
    try {
      const path = await openDialog({
        filters: [{ name: "JSON", extensions: ["json"] }],
        multiple: false,
      });
      if (!path) {
        setImportStatus("idle");
        return;
      }
      const filePath = Array.isArray(path) ? path[0] : path;
      if (!filePath) {
        setImportStatus("idle");
        return;
      }
      const raw = await readTextFile(filePath);
      const payload = JSON.parse(raw);
      if (!payload || typeof payload !== "object") {
        throw new Error(t("settings.data.import.invalid"));
      }
      const importedSettings = (payload as { settings?: Partial<AppSettings> }).settings ?? {};
      const connections = Array.isArray((payload as any).connections)
        ? (payload as any).connections
        : [];
      const profiles = Array.isArray((payload as any).profiles)
        ? (payload as any).profiles
        : [];

      const settingsStore = await getAppSettingsStore();
      const keys = Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettings>;
      const current = {} as Record<keyof AppSettings, AppSettings[keyof AppSettings]>;
      for (const key of keys) {
        const stored = await settingsStore.get<AppSettings[typeof key]>(key);
        current[key] = (stored ?? DEFAULT_APP_SETTINGS[key]) as AppSettings[typeof key];
      }

      const protectedKeys = new Set<keyof AppSettings>([
        "security.masterKeyHash",
        "security.masterKeySalt",
        "security.masterKeyEncSalt",
        "ai.openai.apiKey",
        "ai.anthropic.apiKey",
      ]);

      const next = { ...current } as Record<
        keyof AppSettings,
        AppSettings[keyof AppSettings]
      >;
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(importedSettings, key)) {
          const value = importedSettings[key];
          if (
            protectedKeys.has(key) &&
            (value === "" || value === null || typeof value === "undefined")
          ) {
            continue;
          }
          next[key] = (value as AppSettings[typeof key]) ?? next[key];
        }
      }

      for (const key of keys) {
        await writeAppSetting(key, next[key] as AppSettings[typeof key]);
      }
      setSettings(next as AppSettings);

      const connectionStore = await load("connections.json");
      await connectionStore.set("connections", connections);
      await connectionStore.save();
      const keysStore = await load("keys.json");
      await keysStore.set("profiles", profiles);
      await keysStore.save();

      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("master-key-updated"));
        window.dispatchEvent(new CustomEvent("auth-profiles-updated"));
        window.dispatchEvent(
          new CustomEvent("app-message", {
            detail: {
              title: t("settings.data.import.success"),
              detail: t("settings.data.import.success.desc"),
              tone: "success",
              toast: true,
              store: false,
            },
          }),
        );
      }

      setImportStatus("success");
      setImportMessage(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportStatus("error");
      setImportMessage(null);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("app-message", {
            detail: {
              title: t("settings.data.import.fail"),
              detail: message || t("settings.data.import.fail"),
              tone: "error",
              autoOpen: true,
            },
          }),
        );
      }
    }
  };

  const handleSetMasterKey = async () => {
    if (masterKeyInput.trim().length < 6) {
      setMasterKeyStatus("error");
      const message = t("settings.security.masterKey.tooShort");
      setMasterKeyMessage(message);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("app-message", {
            detail: {
              title: t("settings.security.masterKey.failed"),
              detail: message,
              tone: "error",
              toast: true,
            },
          }),
        );
      }
      return;
    }
    if (masterKeyInput !== masterKeyConfirm) {
      setMasterKeyStatus("error");
      const message = t("settings.security.masterKey.mismatch");
      setMasterKeyMessage(message);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("app-message", {
            detail: {
              title: t("settings.security.masterKey.failed"),
              detail: message,
              tone: "error",
              toast: true,
            },
          }),
        );
      }
      return;
    }
    setMasterKeyStatus("saving");
    setMasterKeyMessage(null);
    try {
      const salt = generateSalt();
      const hash = await hashMasterKey(masterKeyInput, salt);
      const encSalt =
        settings["security.masterKeyEncSalt"] || generateSalt();
      updateSetting("security.masterKeyHash", hash);
      updateSetting("security.masterKeySalt", salt);
      updateSetting("security.masterKeyEncSalt", encSalt);
      if (settings["security.lockTimeoutMinutes"] <= 0) {
        updateSetting("security.lockTimeoutMinutes", 10);
      }
      setMasterKeySession(masterKeyInput);
      setMasterKeyInput("");
      setMasterKeyConfirm("");
      setMasterKeyStatus("success");
      const message = t("settings.security.masterKey.updated");
      setMasterKeyMessage(message);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("app-message", {
            detail: {
              title: message,
              tone: "success",
              toast: true,
            },
          }),
        );
        window.dispatchEvent(new CustomEvent("master-key-updated"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMasterKeyStatus("error");
      const detail = message || t("settings.security.masterKey.failed");
      setMasterKeyMessage(detail);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("app-message", {
            detail: {
              title: t("settings.security.masterKey.failed"),
              detail,
              tone: "error",
              toast: true,
            },
          }),
        );
      }
    }
  };

  const handleClearMasterKey = async () => {
    updateSetting("security.masterKeyHash", "");
    updateSetting("security.masterKeySalt", "");
    updateSetting("security.masterKeyEncSalt", "");
    updateSetting("security.lockTimeoutMinutes", 0);
    clearMasterKeySession();
    setMasterKeyInput("");
    setMasterKeyConfirm("");
    setMasterKeyStatus("success");
    setMasterKeyMessage(t("settings.security.masterKey.cleared"));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("master-key-updated"));
    }
  };

  const handleSelectTerminalBackground = async () => {
    setTerminalBgUploading(true);
    try {
      const previousPath = settings["terminal.backgroundImage"];
      const path = await openDialog({
        filters: [
          { name: t("settings.terminal.backgroundImage"), extensions: Object.keys(TERMINAL_BG_ALLOWED) },
        ],
        multiple: false,
      });
      if (!path) return;
      const filePath = Array.isArray(path) ? path[0] : path;
      if (!filePath) return;
      const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
      const mime = TERMINAL_BG_ALLOWED[ext];
      if (!mime) {
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("app-message", {
              detail: {
                title: t("settings.terminal.backgroundImage"),
                detail: t("settings.terminal.backgroundImage.unsupported"),
                tone: "error",
                toast: true,
              },
            }),
          );
        }
        return;
      }
      const bytes = await readFile(filePath);
      if (bytes.length > TERMINAL_BG_MAX_BYTES) {
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("app-message", {
              detail: {
                title: t("settings.terminal.backgroundImage"),
                detail: t("settings.terminal.backgroundImage.tooLarge"),
                tone: "error",
                toast: true,
              },
            }),
          );
        }
        return;
      }
      await mkdir(TERMINAL_BG_DIR, { baseDir: BaseDirectory.AppLocalData, recursive: true });
      const stamp = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const fileName = `${TERMINAL_BG_DIR}/${stamp}-${rand}.${ext}`;
      await writeFile(fileName, bytes, { baseDir: BaseDirectory.AppLocalData });
      updateSetting("terminal.backgroundImage", fileName);
      if (
        previousPath &&
        previousPath !== fileName &&
        !previousPath.startsWith("data:") &&
        !previousPath.startsWith("http") &&
        !previousPath.startsWith("blob:") &&
        previousPath.startsWith(`${TERMINAL_BG_DIR}/`)
      ) {
        await remove(previousPath, { baseDir: BaseDirectory.AppLocalData });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("app-message", {
            detail: {
              title: t("settings.terminal.backgroundImage.fail"),
              detail: message || t("settings.terminal.backgroundImage.fail"),
              tone: "error",
              autoOpen: true,
            },
          }),
        );
      }
    } finally {
      setTerminalBgUploading(false);
    }
  };

  const handleRemoveTerminalBackground = async () => {
    const previousPath = settings["terminal.backgroundImage"];
    updateSetting("terminal.backgroundImage", "");
    if (
      previousPath &&
      !previousPath.startsWith("data:") &&
      !previousPath.startsWith("http") &&
      !previousPath.startsWith("blob:") &&
      previousPath.startsWith(`${TERMINAL_BG_DIR}/`)
    ) {
      try {
        await remove(previousPath, { baseDir: BaseDirectory.AppLocalData });
      } catch {
        // Ignore cleanup errors; preference reset already applied.
      }
    }
  };

  const fetchAiModels = async (provider: AiProvider, force = false) => {
    const models = aiModels[provider];
    if (!force && models.length > 0) return;

    const baseUrl =
      provider === "openai" ? settings["ai.openai.baseUrl"] : settings["ai.anthropic.baseUrl"];
    const apiKey =
      provider === "openai" ? settings["ai.openai.apiKey"] : settings["ai.anthropic.apiKey"];
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const signature = `${normalizedBase}|${apiKey.trim()}`;
    if (force) {
      aiModelAutoSignatureRef.current[provider] = signature;
    }

    if (!normalizedBase) {
      setAiModelStatus((prev) => ({ ...prev, [provider]: "error" }));
      setAiModelMessage((prev) => ({
        ...prev,
        [provider]:
          provider === "openai"
            ? t("settings.ai.error.openaiUrl")
            : t("settings.ai.error.anthropicUrl"),
      }));
      return;
    }

    if (!apiKey.trim()) {
      setAiModelStatus((prev) => ({ ...prev, [provider]: "error" }));
      setAiModelMessage((prev) => ({
        ...prev,
        [provider]:
          provider === "openai"
            ? t("settings.ai.error.openaiKey")
            : t("settings.ai.error.anthropicKey"),
      }));
      return;
    }

    setAiModelStatus((prev) => ({ ...prev, [provider]: "loading" }));
    setAiModelMessage((prev) => ({
      ...prev,
      [provider]: t("settings.ai.model.refreshing"),
    }));

    try {
      const apiRoot = normalizedBase.endsWith("/v1")
        ? normalizedBase
        : `${normalizedBase}/v1`;
      const url = `${apiRoot}/models`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (provider === "openai") {
        headers.Authorization = `Bearer ${apiKey.trim()}`;
      } else {
        headers["x-api-key"] = apiKey.trim();
        headers["anthropic-version"] = "2023-06-01";
      }

      const resp = await fetch(url, { headers, method: "GET" });
      if (!resp.ok) {
        throw new Error(`${resp.status} ${resp.statusText}`.trim());
      }
      const data = (await resp.json()) as { data?: Array<{ id?: string }> };
      const list: string[] = Array.isArray(data.data)
        ? data.data
            .map((item: { id?: string }) => item?.id)
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      const unique: string[] = Array.from(new Set(list)).sort();
      const chatModels = unique.filter(isChatCapableModel);

      await writeAiModels(provider, chatModels);
      setAiModels((prev) => ({ ...prev, [provider]: chatModels }));
      setAiModelStatus((prev) => ({ ...prev, [provider]: "success" }));
      setAiModelMessage((prev) => ({
        ...prev,
        [provider]:
          chatModels.length > 0
            ? t("settings.ai.model.refresh.success", { count: chatModels.length })
            : t("settings.ai.model.refresh.empty"),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAiModelStatus((prev) => ({ ...prev, [provider]: "error" }));
      setAiModelMessage((prev) => ({
        ...prev,
        [provider]: message || t("settings.ai.model.refresh.fail"),
      }));
    }
  };

  const updateAiModelsSelection = (next: string[]) => {
    const unique = Array.from(
      new Set(next.map((item) => item.trim()).filter((item) => item && isChatCapableModel(item))),
    );
    updateSetting("ai.models", unique);
    if (!unique.includes(settings["ai.model"])) {
      updateSetting("ai.model", unique[0] ?? "");
    }
  };

  const toggleAiModelSelection = (model: string) => {
    if (selectedModels.includes(model)) {
      updateAiModelsSelection(selectedModels.filter((item) => item !== model));
    } else {
      updateAiModelsSelection([...selectedModels, model]);
    }
  };

  const handleAddCustomModel = () => {
    const value = aiModelCustomInput.trim();
    if (!value) return;
    if (!isChatCapableModel(value)) {
      setAiModelStatus((prev) => ({ ...prev, [settings["ai.provider"]]: "error" }));
      setAiModelMessage((prev) => ({
        ...prev,
        [settings["ai.provider"]]: t("settings.ai.model.chatOnly"),
      }));
      return;
    }
    updateAiModelsSelection([...selectedModels, value]);
    setAiModelCustomInput("");
  };

  useEffect(() => {
    const provider = settings["ai.provider"];
    if (!settings["ai.enabled"]) return;
    const cached = aiModels[provider];
    const baseUrl =
      provider === "openai" ? settings["ai.openai.baseUrl"] : settings["ai.anthropic.baseUrl"];
    const apiKey =
      provider === "openai" ? settings["ai.openai.apiKey"] : settings["ai.anthropic.apiKey"];
    const signature = `${normalizeBaseUrl(baseUrl)}|${apiKey.trim()}`;

    if (cached.length > 0) return;
    if (aiModelStatus[provider] === "loading") return;

    if (aiModelAutoSignatureRef.current[provider] === signature) return;
    aiModelAutoSignatureRef.current[provider] = signature;
    void fetchAiModels(provider, true);
  }, [
    aiModels,
    aiModelStatus,
    settings["ai.anthropic.apiKey"],
    settings["ai.anthropic.baseUrl"],
    settings["ai.enabled"],
    settings["ai.openai.apiKey"],
    settings["ai.openai.baseUrl"],
    settings["ai.provider"],
  ]);


  const handleExportConfig = async () => {
    setExportStatus("saving");
    setExportMessage(null);
    try {
      const now = new Date();
      const dateTag = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
        now.getDate(),
      ).padStart(2, "0")}`;
      const path = await saveDialog({
        defaultPath: `noterm-config-${dateTag}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) {
        setExportStatus("idle");
        return;
      }

      const settingsStore = await getAppSettingsStore();
      const entries = { ...DEFAULT_APP_SETTINGS } as AppSettings;
      const typedEntries = entries as Record<keyof AppSettings, AppSettings[keyof AppSettings]>;
      for (const key of Object.keys(DEFAULT_APP_SETTINGS) as Array<
        keyof AppSettings
      >) {
        const stored = await settingsStore.get<AppSettings[typeof key]>(key);
        typedEntries[key] = (stored ?? DEFAULT_APP_SETTINGS[key]) as AppSettings[typeof key];
      }

      const exportSettings = {
        ...entries,
        "security.masterKeyHash": "",
        "security.masterKeySalt": "",
        "ai.openai.apiKey": "",
        "ai.anthropic.apiKey": "",
      } as AppSettings;

      const connectionStore = await load("connections.json");
      const connections = (await connectionStore.get("connections")) ?? [];
      const keysStore = await load("keys.json");
      const profiles = (await keysStore.get("profiles")) ?? [];

      const payload = {
        version: 1,
        exportedAt: now.toISOString(),
        settings: exportSettings,
        connections,
        profiles,
      };

      await writeTextFile(path, JSON.stringify(payload, null, 2));
      setExportStatus("success");
      setExportMessage(null);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("app-message", {
            detail: {
              title: t("settings.data.export.success"),
              detail: t("settings.data.export.success.desc"),
              tone: "success",
              toast: true,
              store: false,
            },
          }),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setExportStatus("error");
      setExportMessage(null);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("app-message", {
            detail: {
              title: t("settings.data.export.fail"),
              detail: message || t("settings.data.export.fail"),
              tone: "error",
              autoOpen: true,
            },
          }),
        );
      }
    }
  };

  const handleAiTest = async () => {
    if (!settings["ai.enabled"]) {
      setAiTestStatus("error");
      setAiTestMessage(t("settings.ai.error.disabled"));
      return;
    }

    if (!settings["ai.model"].trim()) {
      setAiTestStatus("error");
      setAiTestMessage(t("settings.ai.error.model"));
      return;
    }

    if (settings["ai.provider"] === "openai") {
      if (!settings["ai.openai.baseUrl"].trim()) {
        setAiTestStatus("error");
        setAiTestMessage(t("settings.ai.error.openaiUrl"));
        return;
      }
      if (!settings["ai.openai.apiKey"].trim()) {
        setAiTestStatus("error");
        setAiTestMessage(t("settings.ai.error.openaiKey"));
        return;
      }
    } else {
      if (!settings["ai.anthropic.baseUrl"].trim()) {
        setAiTestStatus("error");
        setAiTestMessage(t("settings.ai.error.anthropicUrl"));
        return;
      }
      if (!settings["ai.anthropic.apiKey"].trim()) {
        setAiTestStatus("error");
        setAiTestMessage(t("settings.ai.error.anthropicKey"));
        return;
      }
    }

    setAiTestStatus("testing");
    setAiTestMessage(t("settings.ai.test.testing"));

    const messages: AiMessage[] = [
      { role: "system", content: t("settings.ai.test.systemPrompt") },
      { role: "user", content: "OK" },
    ];

    try {
      await sendAiChat(
        {
          enabled: settings["ai.enabled"],
          provider: settings["ai.provider"],
          model: settings["ai.model"],
          openai: {
            baseUrl: settings["ai.openai.baseUrl"],
            apiKey: settings["ai.openai.apiKey"],
          },
          anthropic: {
            baseUrl: settings["ai.anthropic.baseUrl"],
            apiKey: settings["ai.anthropic.apiKey"],
          },
        },
        messages,
      );
      setAiTestStatus("success");
      setAiTestMessage(t("settings.ai.test.success"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAiTestStatus("error");
      setAiTestMessage(message || t("settings.ai.test.fail"));
    }
  };

  const formatUpdateError = (error: unknown) => {
    if (!error) return t("settings.update.error");
    if (error instanceof Error) return error.message;
    return String(error);
  };

  const releaseUpdateHandle = () => {
    const current = updateRef.current;
    updateRef.current = null;
    const close = (current as { close?: () => Promise<void> | void } | null)?.close;
    if (typeof close === "function") {
      void close();
    }
  };

  const handleCheckUpdate = async () => {
    setUpdateStatus("checking");
    setUpdateMessage(t("settings.update.checkingStatus"));
    setUpdateProgress(null);
    try {
      const update = await checkForUpdates();
      setUpdateCheckedAt(new Date().toISOString());
      releaseUpdateHandle();
      updateRef.current = update;
      if (!update?.available) {
        setUpdateStatus("up-to-date");
        setUpdateMessage(t("settings.update.upToDate"));
        setUpdateInfo(null);
        return;
      }
      setUpdateStatus("available");
      setUpdateInfo({
        version: update.version,
        date: update.date,
        notes: update.body,
      });
      setUpdateMessage(
        update.version
          ? t("settings.update.availableWithVersion", {
              version: update.version,
              dateSuffix: "",
            })
          : t("settings.update.available"),
      );
    } catch (error) {
      setUpdateStatus("error");
      setUpdateMessage(formatUpdateError(error));
    }
  };

  const handleDownloadUpdate = async () => {
    setUpdateStatus("downloading");
    setUpdateMessage(t("settings.update.downloadingStatus"));
    setUpdateProgress(0);
    try {
      let update = updateRef.current;
      if (!update || !update.available) {
        update = await checkForUpdates();
        releaseUpdateHandle();
        updateRef.current = update;
      }
      if (!update?.available) {
        setUpdateStatus("up-to-date");
        setUpdateMessage(t("settings.update.upToDate"));
        setUpdateInfo(null);
        setUpdateProgress(null);
        return;
      }

      setUpdateInfo({
        version: update.version,
        date: update.date,
        notes: update.body,
      });

      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = Number(event.data?.contentLength ?? 0);
          if (!total) {
            setUpdateProgress(null);
          } else {
            setUpdateProgress(0);
          }
          return;
        }
        if (event.event === "Progress") {
          downloaded += Number(event.data?.chunkLength ?? 0);
          if (total > 0) {
            const next = Math.min(100, Math.round((downloaded / total) * 100));
            setUpdateProgress(next);
          }
          return;
        }
        if (event.event === "Finished") {
          setUpdateProgress(100);
        }
      });
      setUpdateStatus("installed");
      setUpdateMessage(t("settings.update.installed"));
    } catch (error) {
      setUpdateStatus("error");
      setUpdateMessage(formatUpdateError(error));
    }
  };

  const updateToneClass =
    updateStatus === "error"
      ? "settings-test-status--error"
      : updateStatus === "up-to-date" || updateStatus === "installed"
        ? "settings-test-status--success"
        : updateStatus === "available"
          ? "settings-test-status--success"
          : "";
  const updateReleaseLabel = updateInfo?.date
    ? new Date(updateInfo.date).toLocaleDateString()
    : null;
  const updateDescription = updateInfo
    ? updateInfo.version
      ? t("settings.update.availableWithVersion", {
          version: updateInfo.version,
          dateSuffix: updateReleaseLabel ? ` · ${updateReleaseLabel}` : "",
        })
      : t("settings.update.available")
    : t("settings.update.autoCheck");
  const updateCheckedLabel = updateCheckedAt
    ? t("settings.update.lastChecked", {
        time: new Date(updateCheckedAt).toLocaleString(),
      })
    : null;
  const isDownloading = updateStatus === "downloading";
  const isChecking = updateStatus === "checking";
  const showDownloadAction = Boolean(updateInfo) && updateStatus !== "installed";
  const currentProvider = settings["ai.provider"];
  const currentModelList = (aiModels[currentProvider] ?? []).filter(isChatCapableModel);
  const selectedModels =
    settings["ai.models"] && settings["ai.models"].length > 0
      ? settings["ai.models"].filter(isChatCapableModel)
      : settings["ai.model"]
        ? (isChatCapableModel(settings["ai.model"]) ? [settings["ai.model"]] : [])
        : [];
  const mergedModels = Array.from(new Set([...currentModelList, ...selectedModels]));
  const searchKeyword = aiModelSearch.trim().toLowerCase();
  const filteredModels = searchKeyword
    ? mergedModels.filter((model) => model.toLowerCase().includes(searchKeyword))
    : mergedModels;
  const aiModelStatusValue = aiModelStatus[currentProvider];
  const aiModelMessageValue = aiModelMessage[currentProvider];
  const currentProviderLabel = currentProvider === "openai" ? "OpenAI" : "Anthropic";
  const previewedModels = selectedModels.slice(0, 6);
  const extraModelsCount = Math.max(0, selectedModels.length - previewedModels.length);

  return (
    <div className="settings-page">
      <h1>{t("settings.title")}</h1>

      <div className="settings-section">
        <h2>{t("settings.section.general")}</h2>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.language.label")}</div>
            <div className="settings-item-description">{t("settings.language.desc")}</div>
          </div>
          <div className="settings-item-control">
            <Select
              className="settings-select"
              value={settings["i18n.locale"]}
              onChange={(nextValue) =>
                updateSetting("i18n.locale", nextValue as AppSettings["i18n.locale"])
              }
              options={[
                { value: "zh-CN", label: t("settings.language.zh") },
                { value: "en-US", label: t("settings.language.en") },
              ]}
            />
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.theme.label")}</div>
            <div className="settings-item-description">{t("settings.theme.desc")}</div>
          </div>
          <div className="settings-item-control">
            <Select
              className="settings-select"
              value={settings["ui.theme"]}
              onChange={(nextValue) =>
                updateSetting("ui.theme", nextValue as AppSettings["ui.theme"])
              }
              options={APP_THEME_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
            />
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h2>{t("settings.section.connection")}</h2>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.connection.autoReconnect")}</div>
            <div className="settings-item-description">{t("settings.connection.autoReconnect.desc")}</div>
          </div>
          <div className="settings-item-control">
            <div
              className={`toggle-switch ${settings["connection.autoConnect"] ? "active" : ""}`}
              onClick={() => toggleSetting("connection.autoConnect")}
            >
              <div className="toggle-switch-handle" />
            </div>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.connection.savePassword")}</div>
            <div className="settings-item-description">{t("settings.connection.savePassword.desc")}</div>
          </div>
          <div className="settings-item-control">
            <div
              className={`toggle-switch ${settings["connection.savePassword"] ? "active" : ""}`}
              onClick={() => toggleSetting("connection.savePassword")}
            >
              <div className="toggle-switch-handle" />
            </div>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.connection.keepAlive")}</div>
            <div className="settings-item-description">{t("settings.connection.keepAlive.desc")}</div>
          </div>
          <div className="settings-item-control">
            <div
              className={`toggle-switch ${settings["connection.keepAlive"] ? "active" : ""}`}
              onClick={() => toggleSetting("connection.keepAlive")}
            >
              <div className="toggle-switch-handle" />
            </div>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.connection.keepAliveInterval")}</div>
            <div className="settings-item-description">{t("settings.connection.keepAliveInterval.desc")}</div>
          </div>
          <div className="settings-item-control">
            <input
              type="number"
              className="settings-input"
              value={settings["connection.keepAliveInterval"]}
              onChange={(e) =>
                updateSetting(
                  "connection.keepAliveInterval",
                  Math.max(1, parseInt(e.target.value || "0", 10) || 0),
                )
              }
              disabled={!settings["connection.keepAlive"]}
            />
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h2>{t("settings.section.security")}</h2>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.security.masterKey")}</div>
            <div className="settings-item-description">
              {hasMasterKey
                ? t("settings.security.masterKey.enabled")
                : t("settings.security.masterKey.disabled")}
            </div>
          </div>
          <div className="settings-item-control settings-item-control--stack">
            <div className="settings-masterkey-row">
              <input
                type="password"
                className="settings-input settings-masterkey-input"
                placeholder={t("settings.security.masterKey.placeholder")}
                value={masterKeyInput}
                onChange={(e) => setMasterKeyInput(e.target.value)}
              />
            </div>
            <div className="settings-masterkey-row">
              <input
                type="password"
                className="settings-input settings-masterkey-input"
                placeholder={t("settings.security.masterKey.confirm")}
                value={masterKeyConfirm}
                onChange={(e) => setMasterKeyConfirm(e.target.value)}
              />
            </div>
            <div className="settings-masterkey-actions">
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={() => void handleSetMasterKey()}
                disabled={masterKeyStatus === "saving"}
              >
                {masterKeyStatus === "saving"
                  ? t("settings.security.masterKey.saving")
                  : t("settings.security.masterKey.save")}
              </button>
              {hasMasterKey && (
                <button
                  className="btn btn-secondary btn-sm settings-danger-btn"
                  type="button"
                  onClick={handleClearMasterKey}
                >
                  {t("settings.security.masterKey.clear")}
                </button>
              )}
            </div>
            {masterKeyMessage && (
              <span
                className={`settings-test-status settings-test-status--${
                  masterKeyStatus === "error" ? "error" : "success"
                }`}
              >
                {masterKeyMessage}
              </span>
            )}
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.security.autoLock")}</div>
            <div className="settings-item-description">
              {t("settings.security.autoLock.desc")}
            </div>
          </div>
          <div className="settings-item-control">
            <Select
              className="settings-select"
              value={String(settings["security.lockTimeoutMinutes"])}
              onChange={(nextValue) =>
                updateSetting(
                  "security.lockTimeoutMinutes",
                  Math.max(0, parseInt(nextValue, 10) || 0),
                )
              }
              disabled={!hasMasterKey}
              options={LOCK_TIMEOUT_OPTIONS.map((opt) => ({
                value: String(opt.value),
                label: t(opt.labelKey),
              }))}
            />
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h2>{t("settings.section.update")}</h2>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.update.current")}</div>
            <div className="settings-item-description">{t("settings.update.autoCheck")}</div>
          </div>
          <div className="settings-item-control">
            <span className="settings-update-version">v{appVersion}</span>
          </div>
        </div>
        <div className="settings-item settings-item--start">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.update.status")}</div>
            <div className="settings-item-description">{updateDescription}</div>
            {updateInfo?.notes && (
              <div className="settings-update-notes">{updateInfo.notes}</div>
            )}
          </div>
          <div className="settings-item-control settings-item-control--stack">
            <div className="settings-update-actions">
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={() => void handleCheckUpdate()}
                disabled={isChecking || isDownloading}
              >
                {isChecking ? t("settings.update.checking") : t("settings.update.check")}
              </button>
              {showDownloadAction && (
                <button
                  className="btn btn-primary btn-sm"
                  type="button"
                  onClick={() => void handleDownloadUpdate()}
                  disabled={isDownloading}
                >
                  {isDownloading ? t("settings.update.downloading") : t("settings.update.download")}
                </button>
              )}
            </div>
            {updateMessage && (
              <span className={`settings-test-status ${updateToneClass}`}>
                {updateMessage}
              </span>
            )}
            {updateStatus === "downloading" && updateProgress !== null && (
              <div className="settings-update-progress" aria-label={t("settings.update.progress")}>
                <div
                  className="settings-update-progress-bar"
                  style={{ width: `${updateProgress}%` }}
                />
              </div>
            )}
            {updateCheckedLabel && (
              <span className="settings-update-meta">{updateCheckedLabel}</span>
            )}
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h2>{t("settings.section.terminal")}</h2>
        <div className="settings-card">
          <div className="settings-card-body">
            <div className="settings-card-controls">
              <div className="settings-row settings-row--single">
                <div className="settings-field">
                  <label className="settings-field-label">{t("settings.terminal.theme")}</label>
                  <Select
                    className="settings-select"
                    value={settings["terminal.theme"]}
                    onChange={(nextValue) =>
                      updateSetting("terminal.theme", nextValue as AppSettings["terminal.theme"])
                    }
                    options={TERMINAL_THEME_OPTIONS.map((opt) => ({
                      value: opt.value,
                      label: opt.label,
                    }))}
                  />
                </div>
              </div>
              <div className="settings-row settings-row--three">
                <div className="settings-field">
                  <label className="settings-field-label">{t("settings.terminal.fontFamily")}</label>
                  <Select
                    className="settings-select"
                    value={settings["terminal.fontFamily"]}
                    onChange={(nextValue) =>
                      updateSetting(
                        "terminal.fontFamily",
                        nextValue || DEFAULT_TERMINAL_FONT_FAMILY,
                      )
                    }
                    options={TERMINAL_FONT_OPTIONS.map((opt) => ({
                      value: opt.value,
                      label: opt.label,
                    }))}
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">{t("settings.terminal.fontWeight")}</label>
                  <Select
                    className="settings-select"
                    value={String(settings["terminal.fontWeight"])}
                    onChange={(nextValue) =>
                      updateSetting(
                        "terminal.fontWeight",
                        parseInt(nextValue, 10) || DEFAULT_APP_SETTINGS["terminal.fontWeight"],
                      )
                    }
                    options={TERMINAL_FONT_WEIGHT_OPTIONS.map((opt) => ({
                      value: String(opt.value),
                      label: opt.label,
                    }))}
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">{t("settings.terminal.fontSize")}</label>
                  <Select
                    className="settings-select"
                    value={String(settings["terminal.fontSize"])}
                    onChange={(nextValue) =>
                      updateSetting(
                        "terminal.fontSize",
                        Math.max(9, parseInt(nextValue, 10) || DEFAULT_APP_SETTINGS["terminal.fontSize"]),
                      )
                    }
                    options={[
                      { value: "11", label: "11" },
                      { value: "12", label: "12" },
                      { value: "13", label: "13" },
                      { value: "14", label: "14" },
                      { value: "15", label: "15" },
                      { value: "16", label: "16" },
                      { value: "18", label: "18" },
                    ]}
                  />
                </div>
              </div>
              <div className="settings-row settings-row--two">
                <div className="settings-field">
                  <label className="settings-field-label">{t("settings.terminal.cursorStyle")}</label>
                  <Select
                    className="settings-select"
                    value={settings["terminal.cursorStyle"]}
                    onChange={(nextValue) =>
                      updateSetting(
                        "terminal.cursorStyle",
                        nextValue as AppSettings["terminal.cursorStyle"],
                      )
                    }
                    options={[
                      { value: "block", label: t("settings.terminal.cursor.block") },
                      { value: "underline", label: t("settings.terminal.cursor.underline") },
                      { value: "bar", label: t("settings.terminal.cursor.bar") },
                    ]}
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">{t("settings.terminal.cursorBlink")}</label>
                  <div
                    className={`toggle-switch ${settings["terminal.cursorBlink"] ? "active" : ""}`}
                    onClick={() => updateSetting("terminal.cursorBlink", !settings["terminal.cursorBlink"])}
                  >
                    <div className="toggle-switch-handle" />
                  </div>
                </div>
              </div>
              <div className="settings-row settings-row--single">
                <div className="settings-field">
                  <label className="settings-field-label">{t("settings.terminal.lineHeight")}</label>
                  <Select
                    className="settings-select"
                    value={String(settings["terminal.lineHeight"])}
                    onChange={(nextValue) =>
                      updateSetting(
                        "terminal.lineHeight",
                        Math.max(1, Math.min(2, parseFloat(nextValue) || DEFAULT_APP_SETTINGS["terminal.lineHeight"])),
                      )
                    }
                    options={[
                      { value: "1", label: "1.0" },
                      { value: "1.2", label: "1.2" },
                      { value: "1.4", label: "1.4" },
                      { value: "1.6", label: "1.6" },
                      { value: "1.8", label: "1.8" },
                    ]}
                  />
                </div>
              </div>
              <div className="settings-advanced">
                <div className="settings-advanced-title">{t("settings.terminal.advanced")}</div>
                <div className="settings-row settings-row--two">
                  <div className="settings-field">
                    <label className="settings-field-label">{t("settings.terminal.autoCopy")}</label>
                    <div
                      className={`toggle-switch ${settings["terminal.autoCopy"] ? "active" : ""}`}
                      onClick={() => updateSetting("terminal.autoCopy", !settings["terminal.autoCopy"])}
                    >
                      <div className="toggle-switch-handle" />
                    </div>
                  </div>
                  <div className="settings-field">
                    <div className="settings-field-description">
                      {t("settings.terminal.autoCopy.desc")}
                    </div>
                  </div>
                </div>
              </div>
              <div className="settings-group">
                <div className="settings-group-header">
                  <div className="settings-group-title">
                    {t("settings.terminal.backgroundGroup")}
                  </div>
                  <div className="settings-group-desc">
                    {t("settings.terminal.backgroundGroup.desc")}
                  </div>
                </div>
                <div className="settings-group-body">
                  <div className="settings-row settings-row--single">
                    <div className="settings-field">
                      <label className="settings-field-label">{t("settings.terminal.backgroundImage")}</label>
                      <div className="settings-inline-actions">
                        {terminalBackgroundUrl && (
                          <span
                            className="settings-bg-thumb"
                            style={{ backgroundImage: `url("${terminalBackgroundUrl}")` }}
                            aria-hidden="true"
                          />
                        )}
                        <button
                          className="btn btn-secondary btn-sm"
                          type="button"
                          onClick={() => void handleSelectTerminalBackground()}
                          disabled={terminalBgUploading}
                        >
                          {terminalBgUploading
                            ? t("settings.terminal.backgroundImage.uploading")
                            : t("settings.terminal.backgroundImage.upload")}
                        </button>
                        {terminalBackgroundImage && (
                          <button
                            className="btn btn-danger btn-sm"
                            type="button"
                            onClick={handleRemoveTerminalBackground}
                          >
                            {t("settings.terminal.backgroundImage.remove")}
                          </button>
                        )}
                        <span className="settings-inline-meta">
                          {terminalBackgroundImage
                            ? t("settings.terminal.backgroundImage.ready")
                            : t("settings.terminal.backgroundImage.empty")}
                        </span>
                      </div>
                      <div className="settings-field-description">
                        {t("settings.terminal.backgroundImage.desc")}
                      </div>
                    </div>
                  </div>
                  <div className="settings-row settings-row--two">
                    <div className="settings-field">
                      <label className="settings-field-label">{t("settings.terminal.backgroundOpacity")}</label>
                      <div className="settings-range-row">
                        <input
                          className="settings-range"
                          type="range"
                          min="0.2"
                          max="0.9"
                          step="0.05"
                          value={String(settings["terminal.backgroundOpacity"])}
                          onChange={(event) =>
                            updateSetting(
                              "terminal.backgroundOpacity",
                              Math.min(0.9, Math.max(0.2, parseFloat(event.target.value) || 0.6)),
                            )
                          }
                          disabled={!terminalBackgroundImage}
                        />
                        <span className="settings-range-value">
                          {Math.round(settings["terminal.backgroundOpacity"] * 100)}%
                        </span>
                      </div>
                    </div>
                    <div className="settings-field">
                      <label className="settings-field-label">{t("settings.terminal.backgroundBlur")}</label>
                      <div className="settings-range-row">
                        <input
                          className="settings-range"
                          type="range"
                          min="0"
                          max="16"
                          step="1"
                          value={String(settings["terminal.backgroundBlur"])}
                          onChange={(event) =>
                            updateSetting(
                              "terminal.backgroundBlur",
                              Math.min(16, Math.max(0, parseFloat(event.target.value) || 0)),
                            )
                          }
                          disabled={!terminalBackgroundImage}
                        />
                        <span className="settings-range-value">
                          {settings["terminal.backgroundBlur"]}px
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="settings-card-preview">
              <div className="settings-preview-header">{t("settings.terminal.preview")}</div>
              <div className="settings-preview-window">
                <div className="settings-preview-titlebar">
                  <span className="settings-preview-dot settings-preview-dot--red" />
                  <span className="settings-preview-dot settings-preview-dot--yellow" />
                  <span className="settings-preview-dot settings-preview-dot--green" />
                </div>
                <pre
                  className={`settings-preview-content${terminalBackgroundUrl ? " settings-preview-content--bg" : ""}`}
                  style={{
                    fontFamily: settings["terminal.fontFamily"],
                    fontSize: settings["terminal.fontSize"],
                    fontWeight: settings["terminal.fontWeight"],
                    ...previewBackgroundStyle,
                    color: previewTheme.foreground,
                    lineHeight: settings["terminal.lineHeight"],
                  }}
                >
                  <span style={{ color: previewTheme.green }}>NoTerm</span>{" "}
                  <span style={{ color: previewTheme.blue }}>root</span>$ ls
                  {"\n"}-drwxr-xr-x 1 root  <span style={{ color: previewTheme.yellow }}>Document</span>
                  {"\n"}-drwxr-xr-x 1 root  <span style={{ background: previewTheme.green, color: previewTheme.background, padding: "0 4px", borderRadius: 3 }}>Downloads</span>
                  {"\n"}-drwxr-xr-x 1 root  <span style={{ background: previewSelection, color: previewTheme.foreground, padding: "0 4px", borderRadius: 3 }}>Pictures</span>
                  {"\n"}-drwxr-xr-x 1 root
                </pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h2>{t("settings.section.shortcuts")}</h2>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.shortcuts.newSession")}</div>
            <div className="settings-item-description">{t("settings.shortcuts.newSession.desc")}</div>
          </div>
          <div className="settings-item-control">
            <div className="shortcut-keys">
              <span className="shortcut-key">{modifierKeyName}</span>
              <span className="shortcut-key">T</span>
            </div>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.shortcuts.split")}</div>
            <div className="settings-item-description">{t("settings.shortcuts.split.desc")}</div>
          </div>
          <div className="settings-item-control">
            <div className="shortcut-keys">
              <span className="shortcut-key">{modifierKeyName}</span>
              <span className="shortcut-key">D</span>
            </div>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.shortcuts.switch")}</div>
            <div className="settings-item-description">{t("settings.shortcuts.switch.desc")}</div>
          </div>
          <div className="settings-item-control">
            <div className="shortcut-keys">
              <span className="shortcut-key">{modifierKeyName}</span>
              <span className="shortcut-key">~</span>
            </div>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.shortcuts.connections")}</div>
            <div className="settings-item-description">{t("settings.shortcuts.connections.desc")}</div>
          </div>
          <div className="settings-item-control">
            <div className="shortcut-keys">
              <span className="shortcut-key">{modifierKeyName}</span>
              <span className="shortcut-key">B</span>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h2>{t("settings.section.ai")}</h2>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.ai.enabled")}</div>
            <div className="settings-item-description">{t("settings.ai.enabled.desc")}</div>
          </div>
          <div className="settings-item-control">
            <div
              className={`toggle-switch ${settings["ai.enabled"] ? "active" : ""}`}
              onClick={() => toggleSetting("ai.enabled")}
            >
              <div className="toggle-switch-handle" />
            </div>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.ai.provider")}</div>
            <div className="settings-item-description">{t("settings.ai.provider.desc")}</div>
          </div>
          <div className="settings-item-control">
            <Select
              className="settings-select"
              value={settings["ai.provider"]}
              onChange={(nextValue) =>
                updateSetting("ai.provider", nextValue as AppSettings["ai.provider"])
              }
              disabled={!settings["ai.enabled"]}
              options={[
                { value: "openai", label: "OpenAI" },
                { value: "anthropic", label: "Anthropic" },
              ]}
            />
          </div>
        </div>
        {settings["ai.provider"] === "openai" ? (
          <>
            <div className="settings-item">
              <div className="settings-item-info">
                <div className="settings-item-label">{t("settings.ai.apiUrl")}</div>
                <div className="settings-item-description">{t("settings.ai.openai.desc")}</div>
              </div>
              <div className="settings-item-control">
                <input
                  type="text"
                  className="settings-input"
                  value={settings["ai.openai.baseUrl"]}
                  onChange={(e) => updateSetting("ai.openai.baseUrl", e.target.value)}
                  disabled={!settings["ai.enabled"]}
                />
              </div>
            </div>
            <div className="settings-item">
              <div className="settings-item-info">
                <div className="settings-item-label">{t("settings.ai.apiKey")}</div>
                <div className="settings-item-description">{t("settings.ai.apiKey.desc")}</div>
              </div>
              <div className="settings-item-control">
                <input
                  type="password"
                  className="settings-input"
                  value={settings["ai.openai.apiKey"]}
                  onChange={(e) => updateSetting("ai.openai.apiKey", e.target.value)}
                  disabled={!settings["ai.enabled"]}
                />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="settings-item">
              <div className="settings-item-info">
                <div className="settings-item-label">{t("settings.ai.apiUrl")}</div>
                <div className="settings-item-description">{t("settings.ai.anthropic.desc")}</div>
              </div>
              <div className="settings-item-control">
                <input
                  type="text"
                  className="settings-input"
                  value={settings["ai.anthropic.baseUrl"]}
                  onChange={(e) => updateSetting("ai.anthropic.baseUrl", e.target.value)}
                  disabled={!settings["ai.enabled"]}
                />
              </div>
            </div>
            <div className="settings-item">
              <div className="settings-item-info">
                <div className="settings-item-label">{t("settings.ai.apiKey")}</div>
                <div className="settings-item-description">{t("settings.ai.apiKey.desc")}</div>
              </div>
              <div className="settings-item-control">
                <input
                  type="password"
                  className="settings-input"
                  value={settings["ai.anthropic.apiKey"]}
                  onChange={(e) => updateSetting("ai.anthropic.apiKey", e.target.value)}
                  disabled={!settings["ai.enabled"]}
                />
              </div>
            </div>
          </>
        )}
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.ai.model")}</div>
            <div className="settings-item-description">{t("settings.ai.model.desc")}</div>
          </div>
          <div className="settings-item-control settings-item-control--stack">
            <div className="settings-model-current">
              <span className="settings-model-current-label">
                {t("settings.ai.model.current")}
              </span>
              {selectedModels.length > 0 ? (
                <Select
                  className="settings-select settings-select--compact"
                  value={settings["ai.model"]}
                  onChange={(nextValue) => updateSetting("ai.model", nextValue)}
                  disabled={!settings["ai.enabled"]}
                  options={selectedModels.map((model) => ({
                    value: model,
                    label: model,
                  }))}
                />
              ) : (
                <input
                  type="text"
                  className="settings-input settings-input--compact"
                  value={settings["ai.model"]}
                  onChange={(e) => updateSetting("ai.model", e.target.value)}
                  disabled={!settings["ai.enabled"]}
                  placeholder={t("settings.ai.model.placeholder")}
                />
              )}
              <button
                className="btn btn-secondary btn-sm settings-model-manage"
                type="button"
                onClick={() => setAiModelModalOpen(true)}
                disabled={!settings["ai.enabled"]}
              >
                {t("settings.ai.model.manage")}
              </button>
            </div>
            <div className="settings-models-selected">
              {selectedModels.length === 0 ? (
                <span className="settings-inline-meta">
                  {t("settings.ai.model.selected.empty")}
                </span>
              ) : (
                <>
                  {previewedModels.map((model) => (
                    <span key={model} className="settings-model-chip">
                      {model}
                    </span>
                  ))}
                  {extraModelsCount > 0 && (
                    <span className="settings-model-chip">
                      +{extraModelsCount}
                    </span>
                  )}
                </>
              )}
            </div>
            {aiModelMessageValue && (
              <span
                className={`settings-test-status ${
                  aiModelStatusValue === "success"
                    ? "settings-test-status--success"
                    : aiModelStatusValue === "error"
                      ? "settings-test-status--error"
                      : ""
                }`}
              >
                {aiModelMessageValue}
              </span>
            )}
          </div>
        </div>
        <Modal
          open={aiModelModalOpen}
          onClose={() => setAiModelModalOpen(false)}
          title={t("settings.ai.model.manage.title")}
          width={1180}
          bodyNoScroll
        >
          <div className="settings-model-modal">
            <div className="settings-model-subtitle">
              {t("settings.ai.model.manage.subtitle")}
            </div>
            <div className="settings-model-toolbar">
              <label className="settings-model-search-wrap">
                <AppIcon
                  icon="material-symbols:search-rounded"
                  size={18}
                  className="settings-model-search-icon"
                />
                <input
                  type="text"
                  className="settings-input settings-model-search-input"
                  value={aiModelSearch}
                  onChange={(event) => setAiModelSearch(event.target.value)}
                  disabled={!settings["ai.enabled"]}
                  placeholder={t("settings.ai.model.search.placeholder")}
                />
              </label>
              <button
                className="btn btn-secondary settings-model-refresh-btn"
                type="button"
                onClick={() => void fetchAiModels(currentProvider, true)}
                disabled={!settings["ai.enabled"] || aiModelStatusValue === "loading"}
              >
                <AppIcon icon="material-symbols:refresh-rounded" size={16} />
                {aiModelStatusValue === "loading"
                  ? t("settings.ai.model.refreshing")
                  : t("settings.ai.model.refresh")}
              </button>
            </div>
            <div className="settings-model-grid">
              <section className="settings-model-panel">
                <div className="settings-model-panel-head">
                  <div className="settings-model-panel-title-wrap">
                    <span className="settings-model-panel-title">
                      {t("settings.ai.model.selected")}
                    </span>
                    <span className="settings-model-panel-count">{selectedModels.length}</span>
                  </div>
                  <span className="settings-model-panel-hint">
                    {t("settings.ai.model.selected.hint")}
                  </span>
                </div>
                <div className="settings-model-selected-panel">
                  {selectedModels.length === 0 ? (
                    <span className="settings-inline-meta">
                      {t("settings.ai.model.selected.empty")}
                    </span>
                  ) : (
                    selectedModels.map((model) => (
                      <button
                        key={model}
                        type="button"
                        className="settings-model-token"
                        onClick={() => toggleAiModelSelection(model)}
                        disabled={!settings["ai.enabled"]}
                      >
                        <span className="settings-model-token-text">{model}</span>
                        <AppIcon icon="material-symbols:close-small-rounded" size={16} />
                      </button>
                    ))
                  )}
                </div>
              </section>
              <section className="settings-model-panel settings-model-panel--available">
                <div className="settings-model-panel-head">
                  <div className="settings-model-panel-title-wrap">
                    <span className="settings-model-panel-title">
                      {t("settings.ai.model.available")}
                    </span>
                    <span className="settings-model-panel-count">{filteredModels.length}</span>
                  </div>
                  <span className="settings-model-panel-hint">
                    {t("settings.ai.model.available.hint")}
                  </span>
                </div>
                <div className="settings-models-list settings-models-list--panel">
                  {filteredModels.length === 0 ? (
                    <div className="settings-inline-meta">
                      {t("settings.ai.model.search.empty")}
                    </div>
                  ) : (
                    filteredModels.map((model) => {
                      const selected = selectedModels.includes(model);
                      return (
                        <button
                          key={model}
                          type="button"
                          className={`settings-model-row${selected ? " is-selected" : ""}`}
                          onClick={() => toggleAiModelSelection(model)}
                          disabled={!settings["ai.enabled"]}
                        >
                          <span
                            className={`settings-model-radio${selected ? " is-selected" : ""}`}
                            aria-hidden="true"
                          />
                          <div className="settings-model-row-main">
                            <span className="settings-model-row-name">{model}</span>
                            <span className="settings-model-row-badges">
                              <span className="settings-model-row-badge">
                                {currentProviderLabel}
                              </span>
                              <span className="settings-model-row-badge">
                                {detectModelCapability(model)}
                              </span>
                            </span>
                          </div>
                          <span
                            className={`settings-model-row-status${selected ? " is-selected" : ""}`}
                          >
                            {selected
                              ? t("settings.ai.model.state.selected")
                              : t("settings.ai.model.state.unselected")}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </section>
            </div>
            <div className="settings-model-footer">
              <label className="settings-model-add-wrap">
                <AppIcon
                  icon="material-symbols:add-rounded"
                  size={18}
                  className="settings-model-add-icon"
                />
                <input
                  type="text"
                  className="settings-input settings-model-add-input"
                  value={aiModelCustomInput}
                  onChange={(event) => setAiModelCustomInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleAddCustomModel();
                    }
                  }}
                  disabled={!settings["ai.enabled"]}
                  placeholder={t("settings.ai.model.add.placeholder")}
                />
              </label>
              <button
                className="btn settings-model-add-btn"
                type="button"
                onClick={handleAddCustomModel}
                disabled={!settings["ai.enabled"] || !aiModelCustomInput.trim()}
              >
                {t("settings.ai.model.add")}
              </button>
            </div>
            {aiModelMessageValue && (
              <span
                className={`settings-test-status ${
                  aiModelStatusValue === "success"
                    ? "settings-test-status--success"
                    : aiModelStatusValue === "error"
                      ? "settings-test-status--error"
                      : ""
                }`}
              >
                {aiModelMessageValue}
              </span>
            )}
          </div>
        </Modal>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.ai.test")}</div>
            <div className="settings-item-description">{t("settings.ai.test.desc")}</div>
          </div>
          <div className="settings-item-control settings-item-control--stack">
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => void handleAiTest()}
              disabled={!settings["ai.enabled"] || aiTestStatus === "testing"}
            >
              {aiTestStatus === "testing" ? t("settings.ai.test.testing") : t("settings.ai.test.action")}
            </button>
            {aiTestMessage && (
              <span className={`settings-test-status settings-test-status--${aiTestStatus}`}>
                {aiTestMessage}
              </span>
            )}
          </div>
        </div>
      </div>


      <div className="settings-section">
        <h2>{t("settings.section.data")}</h2>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.data.export")}</div>
            <div className="settings-item-description">
              {t("settings.data.export.desc")}
            </div>
          </div>
          <div className="settings-item-control settings-item-control--stack">
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => void handleExportConfig()}
              disabled={exportStatus === "saving"}
            >
              {exportStatus === "saving"
                ? t("settings.data.export.exporting")
                : t("settings.data.export.action")}
            </button>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.data.import")}</div>
            <div className="settings-item-description">
              {t("settings.data.import.desc")}
            </div>
          </div>
          <div className="settings-item-control settings-item-control--stack">
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => void handleImportConfig()}
              disabled={importStatus === "loading"}
            >
              {importStatus === "loading"
                ? t("settings.data.import.importing")
                : t("settings.data.import.action")}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h2>{t("settings.section.about")}</h2>
        <div className="app-info">
          <div className="app-info-row">
            <span className="app-info-label">{t("settings.about.appName")}</span>
            <span>NoTerm</span>
          </div>
          <div className="app-info-row">
            <span className="app-info-label">{t("settings.about.version")}</span>
            <span>{appVersion}</span>
          </div>
          <div className="app-info-row">
            <span className="app-info-label">{t("settings.about.framework")}</span>
            <span>Tauri 2 + React</span>
          </div>
          <div className="app-info-row">
            <span className="app-info-label">{t("settings.about.buildDate")}</span>
            <span>2026-02-09</span>
          </div>
        </div>
      </div>
    </div>
  );
}
