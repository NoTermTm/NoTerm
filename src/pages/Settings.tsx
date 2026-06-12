import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  DEFAULT_APP_SETTINGS,
  SENSITIVE_APP_SETTING_KEYS,
  type AppSettings,
  clearVolatileSecretAppSettings,
  writeAppSetting,
  DEFAULT_TERMINAL_FONT_FAMILY,
  normalizeAppTheme,
  withTerminalIconFontFallback,
} from "../store/appSettings";
import { load } from "@tauri-apps/plugin-store";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { mkdir, readFile, readTextFile, remove, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { BaseDirectory } from "@tauri-apps/api/path";
import { TERMINAL_THEME_OPTIONS, getXtermTheme } from "../terminal/xtermThemes";
import { sendAiChat, type AiMessage, type AiProvider } from "../api/ai";
import {
  cloudSyncDownload,
  cloudSyncRollbackPreviousRemoteVersion,
  cloudSyncRestoreLatestLocalBackup,
  cloudSyncTestConnection,
  cloudSyncUpload,
  readSettingsSnapshot,
  type CloudSyncConfig,
} from "../api/cloudSync";
import { generateSalt, hashMasterKey } from "../utils/security";
import { getModifierKeyName } from "../utils/platform";
import {
  clearMasterKeySession,
  getMasterKeySession,
  setMasterKeySession,
} from "../utils/securitySession";
import { getVersion } from "@tauri-apps/api/app";
import { check as checkForUpdates } from "@tauri-apps/plugin-updater";
import { useI18n } from "../i18n";
import { Select } from "../components/Select";
import { Modal } from "../components/Modal";
import { AppIcon } from "../components/AppIcon";
import { toRgba } from "../utils/color";
import { loadTerminalBackgroundUrl, TERMINAL_BG_DIR } from "../utils/terminalBackground";
import {
  buildExportSettings,
  mergeImportedSettings,
} from "../utils/settingsSecurity";
import { readAllAiModels, writeAiModels } from "../store/aiModels";
import "./Settings.css";

const TERMINAL_FONT_CANDIDATES = [
  { label: "SF Mono", family: "SF Mono", value: withTerminalIconFontFallback('"SF Mono", Monaco, Menlo, "Ubuntu Mono", monospace') },
  { label: "JetBrains Mono", family: "JetBrains Mono", value: withTerminalIconFontFallback('"JetBrains Mono", "SF Mono", Menlo, monospace') },
  { label: "Fira Code", family: "Fira Code", value: withTerminalIconFontFallback('"Fira Code", "SF Mono", Menlo, monospace') },
  { label: "Hack", family: "Hack", value: withTerminalIconFontFallback('Hack, "SF Mono", Menlo, monospace') },
  { label: "Source Code Pro", family: "Source Code Pro", value: withTerminalIconFontFallback('"Source Code Pro", "SF Mono", Menlo, monospace') },
  { label: "Ubuntu Mono", family: "Ubuntu Mono", value: withTerminalIconFontFallback('"Ubuntu Mono", "SF Mono", Menlo, monospace') },
  { label: "Menlo", family: "Menlo", value: withTerminalIconFontFallback('Menlo, "SF Mono", monospace') },
  { label: "Consolas", family: "Consolas", value: withTerminalIconFontFallback('Consolas, "Courier New", monospace') },
  { label: "Cascadia Mono", family: "Cascadia Mono", value: withTerminalIconFontFallback('"Cascadia Mono", Consolas, "Courier New", monospace') },
  { label: "Cascadia Code", family: "Cascadia Code", value: withTerminalIconFontFallback('"Cascadia Code", Consolas, "Courier New", monospace') },
  { label: "Lucida Console", family: "Lucida Console", value: withTerminalIconFontFallback('"Lucida Console", Consolas, monospace') },
  { label: "Courier New", family: "Courier New", value: withTerminalIconFontFallback('"Courier New", Consolas, monospace') },
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
  { labelKey: "settings.theme.chal", value: "chal" },
  { labelKey: "settings.theme.github", value: "github" },
  { labelKey: "settings.theme.notinish", value: "notinish" },
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

const TERMINAL_BG_SIZE_MAP: Record<AppSettings["terminal.backgroundFit"], string> = {
  cover: "cover",
  contain: "contain",
  stretch: "100% 100%",
};

type AiModelStatus = "idle" | "loading" | "success" | "error";

const normalizeBaseUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
};

const getAiProviderBaseUrl = (settings: AppSettings, provider: AiProvider) =>
  provider === "openai"
    ? settings["ai.openai.baseUrl"]
    : provider === "anthropic"
      ? settings["ai.anthropic.baseUrl"]
      : provider === "volcengine"
        ? settings["ai.volcengine.baseUrl"]
        : settings["ai.deepseek.baseUrl"];

const getAiProviderApiKey = (settings: AppSettings, provider: AiProvider) =>
  provider === "openai"
    ? settings["ai.openai.apiKey"]
    : provider === "anthropic"
      ? settings["ai.anthropic.apiKey"]
      : provider === "volcengine"
        ? settings["ai.volcengine.apiKey"]
        : settings["ai.deepseek.apiKey"];

const getAiProviderUrlErrorKey = (provider: AiProvider) =>
  provider === "openai"
    ? "settings.ai.error.openaiUrl"
    : provider === "anthropic"
      ? "settings.ai.error.anthropicUrl"
      : provider === "volcengine"
        ? "settings.ai.error.volcengineUrl"
        : "settings.ai.error.deepseekUrl";

const getAiProviderKeyErrorKey = (provider: AiProvider) =>
  provider === "openai"
    ? "settings.ai.error.openaiKey"
    : provider === "anthropic"
      ? "settings.ai.error.anthropicKey"
      : provider === "volcengine"
        ? "settings.ai.error.volcengineKey"
        : "settings.ai.error.deepseekKey";

const getAiProviderLabel = (provider: AiProvider) =>
  provider === "openai"
    ? "OpenAI"
    : provider === "anthropic"
      ? "Anthropic"
      : provider === "volcengine"
        ? "Volcengine Ark"
        : "DeepSeek";

const getAiProviderModelKey = (provider: AiProvider): keyof AppSettings =>
  provider === "openai"
    ? "ai.openai.model"
    : provider === "anthropic"
      ? "ai.anthropic.model"
      : provider === "volcengine"
        ? "ai.volcengine.model"
        : "ai.deepseek.model";

const getAiProviderModelsKey = (provider: AiProvider): keyof AppSettings =>
  provider === "openai"
    ? "ai.openai.models"
    : provider === "anthropic"
      ? "ai.anthropic.models"
      : provider === "volcengine"
        ? "ai.volcengine.models"
        : "ai.deepseek.models";

const getAiProviderCurrentModel = (settings: AppSettings, provider: AiProvider) => {
  const providerModel = settings[getAiProviderModelKey(provider)];
  if (typeof providerModel === "string" && providerModel.trim()) {
    return providerModel;
  }
  return provider === settings["ai.provider"] ? settings["ai.model"] : "";
};

const getAiProviderSelectedModels = (settings: AppSettings, provider: AiProvider) => {
  const providerModels = settings[getAiProviderModelsKey(provider)];
  if (Array.isArray(providerModels) && providerModels.length > 0) {
    return providerModels.filter(isChatCapableModel);
  }
  if (provider === settings["ai.provider"]) {
    if (Array.isArray(settings["ai.models"]) && settings["ai.models"].length > 0) {
      return settings["ai.models"].filter(isChatCapableModel);
    }
    if (typeof settings["ai.model"] === "string" && isChatCapableModel(settings["ai.model"])) {
      return [settings["ai.model"]];
    }
  }
  return [];
};

const getAiProviderModelListUrl = (provider: AiProvider, normalizedBase: string) =>
  provider === "openai" || provider === "anthropic"
    ? `${normalizedBase}/v1/models`
    : `${normalizedBase}/models`;

const getAiProviderHeaders = (provider: AiProvider, apiKey: string) => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (provider === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
};

const normalizeAiRefreshError = (
  provider: AiProvider,
  error: unknown,
  t: (key: string, vars?: Record<string, string | number>) => string,
) => {
  const message = error instanceof Error ? error.message : String(error);
  if (provider === "volcengine" && /load failed|failed to fetch/i.test(message)) {
    return t("settings.ai.model.refresh.volcengineHint");
  }
  return message || t("settings.ai.model.refresh.fail");
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
  const [aiTestStatus, setAiTestStatus] = useState<"idle" | "testing">("idle");
  const [aiModels, setAiModels] = useState<Record<AiProvider, string[]>>({
    openai: [],
    anthropic: [],
    volcengine: [],
    deepseek: [],
  });
  const [aiModelStatus, setAiModelStatus] = useState<Record<AiProvider, AiModelStatus>>({
    openai: "idle",
    anthropic: "idle",
    volcengine: "idle",
    deepseek: "idle",
  });
  const [aiModelMessage, setAiModelMessage] = useState<Record<AiProvider, string | null>>({
    openai: null,
    anthropic: null,
    volcengine: null,
    deepseek: null,
  });
  const aiModelAutoSignatureRef = useRef<Record<AiProvider, string>>({
    openai: "",
    anthropic: "",
    volcengine: "",
    deepseek: "",
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
  const [cloudSyncStatus, setCloudSyncStatus] = useState<
    "idle" | "working" | "success" | "error"
  >("idle");
  const [cloudSyncMessage, setCloudSyncMessage] = useState<string>("");
  const [cloudSyncAction, setCloudSyncAction] = useState<
    "test" | "upload" | "download" | "restore" | "rollback" | null
  >(null);
  const [cloudSyncModalOpen, setCloudSyncModalOpen] = useState(false);
  const [showS3SecretAccessKey, setShowS3SecretAccessKey] = useState(false);
  const [appVersion, setAppVersion] = useState<string>("--");
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "available" | "up-to-date" | "downloading" | "installed" | "error"
  >("idle");
  const [updateInfo, setUpdateInfo] = useState<{
    version?: string;
    date?: string;
    notes?: string;
  } | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateCheckedAt, setUpdateCheckedAt] = useState<string | null>(null);
  const [terminalBgUploading, setTerminalBgUploading] = useState(false);
  const [terminalFontOptions, setTerminalFontOptions] = useState(
    TERMINAL_FONT_CANDIDATES.map((opt) => ({ label: opt.label, value: opt.value })),
  );
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
        ["--settings-term-bg-size"]:
          TERMINAL_BG_SIZE_MAP[settings["terminal.backgroundFit"]],
        backgroundColor: previewTheme.background ?? "#0f111a",
      } as CSSProperties)
    : { backgroundColor: previewTheme.background ?? "#0f111a" };

  useEffect(() => {
    updateStatusRef.current = updateStatus;
  }, [updateStatus]);

  useEffect(() => {
    if (typeof document === "undefined" || !("fonts" in document)) return;
    const hasFont = (family: string) => {
      try {
        return document.fonts.check(`12px "${family}"`);
      } catch {
        return true;
      }
    };
    const installed = TERMINAL_FONT_CANDIDATES.filter((opt) => hasFont(opt.family));
    const next = (installed.length > 0 ? installed : TERMINAL_FONT_CANDIDATES).map((opt) => ({
      label: opt.label,
      value: opt.value,
    }));
    const current = settings["terminal.fontFamily"];
    if (current && !next.some((opt) => opt.value === current)) {
      const first = current.split(",")[0]?.trim().replace(/^"|"$/g, "") || "Custom";
      next.unshift({ label: first, value: withTerminalIconFontFallback(current) });
    }
    setTerminalFontOptions(next);
  }, [settings["terminal.fontFamily"]]);

  useEffect(() => {
    let disposed = false;
    const run = async () => {
      const next = await readSettingsSnapshot();
      if (!disposed) {
        setSettings({
          ...next,
          "ui.theme": normalizeAppTheme(next["ui.theme"]),
        });
      }
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
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("app-message", {
              detail: {
                title: detail.error,
                tone: "error",
                toast: true,
                store: false,
              },
            }),
          );
        }
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
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("app-message", {
              detail: {
                title: detail.version
                  ? t("settings.update.availableWithVersion", {
                      version: detail.version,
                      dateSuffix: "",
                    })
                  : t("settings.update.available"),
                tone: "info",
                toast: true,
                store: false,
              },
            }),
          );
        }
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
  }, [
    settings["ai.enabled"],
    settings["ai.provider"],
    settings["ai.openai.baseUrl"],
    settings["ai.openai.apiKey"],
    settings["ai.anthropic.baseUrl"],
    settings["ai.anthropic.apiKey"],
    settings["ai.volcengine.baseUrl"],
    settings["ai.volcengine.apiKey"],
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

  const buildCloudSyncConfig = (): CloudSyncConfig => ({
    provider: settings["sync.provider"],
    webdav: {
      endpoint: settings["sync.webdav.endpoint"],
      username: settings["sync.webdav.username"],
      password: settings["sync.webdav.password"],
      basePath: settings["sync.webdav.basePath"] || "/noterm-sync",
    },
    s3: {
      endpoint: settings["sync.s3.endpoint"],
      region: settings["sync.s3.region"],
      bucket: settings["sync.s3.bucket"],
      prefix: settings["sync.s3.prefix"],
      accessKeyId: settings["sync.s3.accessKeyId"],
      secretAccessKey: settings["sync.s3.secretAccessKey"],
      forcePathStyle: settings["sync.s3.forcePathStyle"],
    },
  });

  const getUnlockedMasterKey = () => {
    const masterKey = getMasterKeySession();
    const encSalt = settings["security.masterKeyEncSalt"];
    if (!masterKey || !encSalt) {
      throw new Error(t("settings.sync.error.masterKeyRequired"));
    }
    return { masterKey, encSalt };
  };

  const applyLatestSettingsSnapshot = async () => {
    const snapshot = await readSettingsSnapshot();
    setSettings(snapshot);
  };

  const setCloudSyncResult = (
    status: "success" | "error",
    message: string,
    toast = true,
  ) => {
    setCloudSyncStatus(status);
    setCloudSyncMessage(message);
    if (toast && typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("app-message", {
          detail: {
            title:
              status === "success"
                ? t("settings.sync.toast.title")
                : t("settings.sync.toast.errorTitle"),
            detail: message,
            tone: status === "success" ? "success" : "error",
            toast: status === "success",
            autoOpen: status === "error",
            store: status !== "success",
          },
        }),
      );
    }
  };

  const handleCloudSyncTest = async () => {
    setCloudSyncAction("test");
    setCloudSyncStatus("working");
    setCloudSyncMessage(t("settings.sync.status.testing"));
    try {
      await cloudSyncTestConnection(buildCloudSyncConfig());
      setCloudSyncResult("success", t("settings.sync.status.testPassed"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCloudSyncResult("error", message || t("settings.sync.status.testFailed"));
    } finally {
      setCloudSyncAction(null);
    }
  };

  const handleCloudSyncUpload = async () => {
    setCloudSyncAction("upload");
    setCloudSyncStatus("working");
    setCloudSyncMessage(t("settings.sync.status.uploading"));
    try {
      const { masterKey, encSalt } = getUnlockedMasterKey();
      const syncedAt = await cloudSyncUpload({
        config: buildCloudSyncConfig(),
        masterKey,
        encSalt,
      });
      updateSetting("sync.lastSyncedAt", syncedAt);
      setCloudSyncResult("success", t("settings.sync.status.uploadDone"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCloudSyncResult("error", message || t("settings.sync.status.uploadFailed"));
    } finally {
      setCloudSyncAction(null);
    }
  };

  const handleCloudSyncDownload = async () => {
    setCloudSyncAction("download");
    setCloudSyncStatus("working");
    setCloudSyncMessage(t("settings.sync.status.downloading"));
    try {
      const { masterKey, encSalt } = getUnlockedMasterKey();
      const result = await cloudSyncDownload({
        config: buildCloudSyncConfig(),
        masterKey,
        encSalt,
      });
      updateSetting("sync.lastSyncedAt", result.updatedAt || new Date().toISOString());
      await applyLatestSettingsSnapshot();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("master-key-updated"));
        window.dispatchEvent(new CustomEvent("auth-profiles-updated"));
      }
      const backupTime = result.backupAt
        ? new Date(result.backupAt).toLocaleString()
        : "--";
      setCloudSyncResult(
        "success",
        t("settings.sync.status.downloadDoneWithBackup", { time: backupTime }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCloudSyncResult("error", message || t("settings.sync.status.downloadFailed"));
    } finally {
      setCloudSyncAction(null);
    }
  };

  const handleCloudSyncRestore = async () => {
    setCloudSyncAction("restore");
    setCloudSyncStatus("working");
    setCloudSyncMessage(t("settings.sync.status.restoring"));
    try {
      const { masterKey, encSalt } = getUnlockedMasterKey();
      const result = await cloudSyncRestoreLatestLocalBackup({ masterKey, encSalt });
      await applyLatestSettingsSnapshot();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("master-key-updated"));
        window.dispatchEvent(new CustomEvent("auth-profiles-updated"));
      }
      const backupTime = result.backupAt
        ? new Date(result.backupAt).toLocaleString()
        : "--";
      setCloudSyncResult(
        "success",
        t("settings.sync.status.restoreDone", { time: backupTime }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCloudSyncResult("error", message || t("settings.sync.status.restoreFailed"));
    } finally {
      setCloudSyncAction(null);
    }
  };

  const handleCloudSyncRollback = async () => {
    setCloudSyncAction("rollback");
    setCloudSyncStatus("working");
    setCloudSyncMessage(t("settings.sync.status.rollbacking"));
    try {
      const { masterKey, encSalt } = getUnlockedMasterKey();
      const result = await cloudSyncRollbackPreviousRemoteVersion({
        config: buildCloudSyncConfig(),
        masterKey,
        encSalt,
      });
      updateSetting("sync.lastSyncedAt", result.updatedAt || new Date().toISOString());
      await applyLatestSettingsSnapshot();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("master-key-updated"));
        window.dispatchEvent(new CustomEvent("auth-profiles-updated"));
      }
      setCloudSyncResult("success", t("settings.sync.status.rollbackDone"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCloudSyncResult("error", message || t("settings.sync.status.rollbackFailed"));
    } finally {
      setCloudSyncAction(null);
    }
  };

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

      const current = await readSettingsSnapshot();
      const keys = Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettings>;
      const next = mergeImportedSettings(current, importedSettings);

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
      const nextLockTimeout =
        settings["security.lockTimeoutMinutes"] <= 0
          ? 10
          : settings["security.lockTimeoutMinutes"];
      await writeAppSetting("security.masterKeyHash", hash);
      await writeAppSetting("security.masterKeySalt", salt);
      await writeAppSetting("security.masterKeyEncSalt", encSalt);
      if (nextLockTimeout !== settings["security.lockTimeoutMinutes"]) {
        await writeAppSetting("security.lockTimeoutMinutes", nextLockTimeout);
      }
      setMasterKeySession(masterKeyInput);
      for (const key of SENSITIVE_APP_SETTING_KEYS) {
        const value = settings[key];
        if (typeof value === "string" && value.trim()) {
          await writeAppSetting(key, value as AppSettings[typeof key]);
        }
      }
      setSettings((prev) => ({
        ...prev,
        "security.masterKeyHash": hash,
        "security.masterKeySalt": salt,
        "security.masterKeyEncSalt": encSalt,
        "security.lockTimeoutMinutes": nextLockTimeout,
      }));
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
    clearVolatileSecretAppSettings();
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

    const baseUrl = getAiProviderBaseUrl(settings, provider);
    const apiKey = getAiProviderApiKey(settings, provider);
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const signature = `${normalizedBase}|${apiKey.trim()}`;
    if (force) {
      aiModelAutoSignatureRef.current[provider] = signature;
    }

    if (!normalizedBase) {
      setAiModelStatus((prev) => ({ ...prev, [provider]: "error" }));
      setAiModelMessage((prev) => ({
        ...prev,
        [provider]: t(getAiProviderUrlErrorKey(provider)),
      }));
      return;
    }

    if (!apiKey.trim()) {
      setAiModelStatus((prev) => ({ ...prev, [provider]: "error" }));
      setAiModelMessage((prev) => ({
        ...prev,
        [provider]: t(getAiProviderKeyErrorKey(provider)),
      }));
      return;
    }

    setAiModelStatus((prev) => ({ ...prev, [provider]: "loading" }));
    setAiModelMessage((prev) => ({
      ...prev,
      [provider]: t("settings.ai.model.refreshing"),
    }));

    try {
      const url = getAiProviderModelListUrl(provider, normalizedBase);
      const headers = getAiProviderHeaders(provider, apiKey.trim());

      const resp = await tauriFetch(url, { headers, method: "GET" });
      if (!resp.ok) {
        throw new Error(`${resp.status} ${resp.statusText}`.trim());
      }
      const data = (await resp.json()) as { data?: Array<{ id?: string }> };
      // Keep only distinct chat-capable models so the terminal model picker stays focused.
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
      const message = normalizeAiRefreshError(provider, error, t);
      setAiModelStatus((prev) => ({ ...prev, [provider]: "error" }));
      setAiModelMessage((prev) => ({
        ...prev,
        [provider]: message,
      }));
    }
  };

  const updateAiModelsSelection = (next: string[]) => {
    const unique = Array.from(
      new Set(next.map((item) => item.trim()).filter((item) => item && isChatCapableModel(item))),
    );
    const provider = settings["ai.provider"];
    const currentModel = getAiProviderCurrentModel(settings, provider);
    const nextCurrentModel = unique.includes(currentModel) ? currentModel : (unique[0] ?? "");
    updateSetting("ai.models", unique);
    updateSetting("ai.model", nextCurrentModel);
    updateSetting(getAiProviderModelsKey(provider), unique);
    updateSetting(getAiProviderModelKey(provider), nextCurrentModel);
  };

  const handleAiProviderChange = (provider: AiProvider) => {
    const nextSelectedModels = getAiProviderSelectedModels(settings, provider);
    const nextCurrentModel = getAiProviderCurrentModel(settings, provider);
    updateSetting("ai.provider", provider);
    updateSetting("ai.models", nextSelectedModels);
    updateSetting("ai.model", nextCurrentModel);
    setAiModelSearch("");
    setAiModelCustomInput("");
  };

  const handleAiCurrentModelChange = (nextValue: string) => {
    const provider = settings["ai.provider"];
    updateSetting("ai.model", nextValue);
    updateSetting(getAiProviderModelKey(provider), nextValue);
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
    const baseUrl = getAiProviderBaseUrl(settings, provider);
    const apiKey = getAiProviderApiKey(settings, provider);
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
    settings["ai.deepseek.apiKey"],
    settings["ai.deepseek.baseUrl"],
    settings["ai.volcengine.apiKey"],
    settings["ai.volcengine.baseUrl"],
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

      const entries = await readSettingsSnapshot();

      const exportSettings = buildExportSettings(entries);

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
    const showAiTestMessage = (title: string, tone: "success" | "error") => {
      if (typeof window === "undefined") return;
      window.dispatchEvent(
        new CustomEvent("app-message", {
          detail: {
            title,
            tone,
            toast: true,
            store: false,
          },
        }),
      );
    };

    if (!settings["ai.enabled"]) {
      showAiTestMessage(t("settings.ai.error.disabled"), "error");
      return;
    }

    if (!settings["ai.model"].trim()) {
      showAiTestMessage(t("settings.ai.error.model"), "error");
      return;
    }

    if (!getAiProviderBaseUrl(settings, settings["ai.provider"]).trim()) {
      showAiTestMessage(t(getAiProviderUrlErrorKey(settings["ai.provider"])), "error");
      return;
    }
    if (!getAiProviderApiKey(settings, settings["ai.provider"]).trim()) {
      showAiTestMessage(t(getAiProviderKeyErrorKey(settings["ai.provider"])), "error");
      return;
    }

    setAiTestStatus("testing");

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
          volcengine: {
            baseUrl: settings["ai.volcengine.baseUrl"],
            apiKey: settings["ai.volcengine.apiKey"],
          },
          deepseek: {
            baseUrl: settings["ai.deepseek.baseUrl"],
            apiKey: settings["ai.deepseek.apiKey"],
          },
        },
        messages,
      );
      showAiTestMessage(t("settings.ai.test.success"), "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showAiTestMessage(message || t("settings.ai.test.fail"), "error");
    } finally {
      setAiTestStatus("idle");
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
    const showUpdateMessage = (title: string, tone: "success" | "error" | "info") => {
      if (typeof window === "undefined") return;
      window.dispatchEvent(
        new CustomEvent("app-message", {
          detail: {
            title,
            tone,
            toast: true,
            store: false,
          },
        }),
      );
    };

    setUpdateStatus("checking");
    setUpdateProgress(null);
    try {
      const update = await checkForUpdates();
      setUpdateCheckedAt(new Date().toISOString());
      releaseUpdateHandle();
      updateRef.current = update;
      if (!update?.available) {
        setUpdateStatus("up-to-date");
        setUpdateInfo(null);
        showUpdateMessage(t("settings.update.upToDate"), "success");
        return;
      }
      setUpdateStatus("available");
      const nextInfo = {
        version: update.version,
        date: update.date,
        notes: update.body,
      };
      setUpdateInfo(nextInfo);
      showUpdateMessage(
        nextInfo.version
          ? t("settings.update.availableWithVersion", {
              version: nextInfo.version,
              dateSuffix: "",
            })
          : t("settings.update.available"),
        "info",
      );
    } catch (error) {
      setUpdateStatus("error");
      showUpdateMessage(formatUpdateError(error), "error");
    }
  };

  const handleDownloadUpdate = async () => {
    const showUpdateMessage = (title: string, tone: "success" | "error" | "info") => {
      if (typeof window === "undefined") return;
      window.dispatchEvent(
        new CustomEvent("app-message", {
          detail: {
            title,
            tone,
            toast: true,
            store: false,
          },
        }),
      );
    };

    setUpdateStatus("downloading");
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
        setUpdateInfo(null);
        setUpdateProgress(null);
        showUpdateMessage(t("settings.update.upToDate"), "success");
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
      showUpdateMessage(t("settings.update.installed"), "success");
    } catch (error) {
      setUpdateStatus("error");
      showUpdateMessage(formatUpdateError(error), "error");
    }
  };
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
  const currentProviderModel = getAiProviderCurrentModel(settings, currentProvider);
  const selectedModels = getAiProviderSelectedModels(settings, currentProvider);
  const mergedModels = Array.from(new Set([...currentModelList, ...selectedModels]));
  const searchKeyword = aiModelSearch.trim().toLowerCase();
  const filteredModels = searchKeyword
    ? mergedModels.filter((model) => model.toLowerCase().includes(searchKeyword))
    : mergedModels;
  const aiModelStatusValue = aiModelStatus[currentProvider];
  const aiModelMessageValue = aiModelMessage[currentProvider];
  const currentProviderLabel = getAiProviderLabel(currentProvider);
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
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">
              {t("settings.connection.reconnectWriteFailures")}
            </div>
            <div className="settings-item-description">
              {t("settings.connection.reconnectWriteFailures.desc")}
            </div>
          </div>
          <div className="settings-item-control">
            <Select
              className="settings-select"
              value={String(settings["terminal.reconnectWriteFailures"])}
              onChange={(nextValue) =>
                updateSetting(
                  "terminal.reconnectWriteFailures",
                  Math.max(
                    1,
                    Math.min(
                      15,
                      parseInt(nextValue, 10) ||
                        DEFAULT_APP_SETTINGS["terminal.reconnectWriteFailures"],
                    ),
                  ),
                )
              }
              options={[
                { value: "1", label: "1" },
                { value: "2", label: "2" },
                { value: "3", label: "3" },
                { value: "4", label: "4" },
                { value: "5", label: "5" },
                { value: "6", label: "6" },
                { value: "8", label: "8" },
                { value: "10", label: "10" },
                { value: "12", label: "12" },
                { value: "15", label: "15" },
              ]}
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
                    options={terminalFontOptions}
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
                <div className="settings-advanced-body">
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
                <div className="settings-group-body settings-group-body--background">
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
                  <div className="settings-row settings-row--single">
                    <div className="settings-field">
                      <label className="settings-field-label">{t("settings.terminal.backgroundFit")}</label>
                      <Select
                        className="settings-select settings-select--bg-fit"
                        value={settings["terminal.backgroundFit"]}
                        onChange={(nextValue) =>
                          updateSetting(
                            "terminal.backgroundFit",
                            nextValue as AppSettings["terminal.backgroundFit"],
                          )
                        }
                        options={[
                          { value: "cover", label: t("settings.terminal.backgroundFit.cover") },
                          { value: "contain", label: t("settings.terminal.backgroundFit.contain") },
                          { value: "stretch", label: t("settings.terminal.backgroundFit.stretch") },
                        ]}
                        disabled={!terminalBackgroundImage}
                      />
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
                    fontFamily: withTerminalIconFontFallback(settings["terminal.fontFamily"]),
                    fontSize: settings["terminal.fontSize"],
                    fontWeight: settings["terminal.fontWeight"],
                    ...previewBackgroundStyle,
                    color: previewTheme.foreground,
                    lineHeight: settings["terminal.lineHeight"],
                  }}
                >
                  <span className="settings-preview-content-text">
                    <span style={{ color: previewTheme.green }}>NoTerm</span>{" "}
                    <span style={{ color: previewTheme.blue }}>root</span>$ ls
                    {"\n"}-drwxr-xr-x 1 root  <span style={{ color: previewTheme.yellow }}>Document</span>
                    {"\n"}-drwxr-xr-x 1 root  <span style={{ background: previewTheme.green, color: previewTheme.background, padding: "0 4px", borderRadius: 3 }}>Downloads</span>
                    {"\n"}-drwxr-xr-x 1 root  <span style={{ background: previewSelection, color: previewTheme.foreground, padding: "0 4px", borderRadius: 3 }}>Pictures</span>
                    {"\n"}-drwxr-xr-x 1 root
                  </span>
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
                handleAiProviderChange(nextValue as AppSettings["ai.provider"])
              }
              disabled={!settings["ai.enabled"]}
              options={[
                { value: "openai", label: "OpenAI" },
                { value: "anthropic", label: "Anthropic" },
                { value: "volcengine", label: "Volcengine Ark" },
                { value: "deepseek", label: "DeepSeek" },
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
        ) : settings["ai.provider"] === "volcengine" ? (
          <>
            <div className="settings-item">
              <div className="settings-item-info">
                <div className="settings-item-label">{t("settings.ai.apiUrl")}</div>
                <div className="settings-item-description">{t("settings.ai.volcengine.desc")}</div>
              </div>
              <div className="settings-item-control">
                <input
                  type="text"
                  className="settings-input"
                  value={settings["ai.volcengine.baseUrl"]}
                  onChange={(e) => updateSetting("ai.volcengine.baseUrl", e.target.value)}
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
                  value={settings["ai.volcengine.apiKey"]}
                  onChange={(e) => updateSetting("ai.volcengine.apiKey", e.target.value)}
                  disabled={!settings["ai.enabled"]}
                />
              </div>
            </div>
          </>
        ) : settings["ai.provider"] === "deepseek" ? (
          <>
            <div className="settings-item">
              <div className="settings-item-info">
                <div className="settings-item-label">{t("settings.ai.apiUrl")}</div>
                <div className="settings-item-description">{t("settings.ai.deepseek.desc")}</div>
              </div>
              <div className="settings-item-control">
                <input
                  type="text"
                  className="settings-input"
                  value={settings["ai.deepseek.baseUrl"]}
                  onChange={(e) => updateSetting("ai.deepseek.baseUrl", e.target.value)}
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
                  value={settings["ai.deepseek.apiKey"]}
                  onChange={(e) => updateSetting("ai.deepseek.apiKey", e.target.value)}
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
                  value={currentProviderModel}
                  onChange={(nextValue) => handleAiCurrentModelChange(nextValue)}
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
                  value={currentProviderModel}
                  onChange={(e) => handleAiCurrentModelChange(e.target.value)}
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
        <div className="settings-item settings-item--responsive">
          <div className="settings-item-info">
            <div className="settings-item-label">{t("settings.ai.test")}</div>
            <div className="settings-item-description">{t("settings.ai.test.desc")}</div>
          </div>
          <div className="settings-item-control settings-item-control--stack settings-item-control--test">
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => void handleAiTest()}
              disabled={!settings["ai.enabled"] || aiTestStatus === "testing"}
            >
              {aiTestStatus === "testing" ? t("settings.ai.test.testing") : t("settings.ai.test.action")}
            </button>
          </div>
        </div>
      </div>


      <div className="settings-section">
        <h2>{t("settings.section.data")}</h2>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">
              {t("settings.sync.title")}
            </div>
            <div className="settings-item-description">
              {t("settings.sync.desc")}
            </div>
          </div>
          <div className="settings-item-control settings-item-control--stack">
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => setCloudSyncModalOpen(true)}
            >
              {t("settings.sync.configure")}
            </button>
            {settings["sync.lastSyncedAt"] && (
              <span className="settings-inline-meta">
                {t("settings.sync.lastSyncedAt", {
                  time: new Date(settings["sync.lastSyncedAt"]).toLocaleString(),
                })}
              </span>
            )}
          </div>
        </div>

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

        <Modal
          open={cloudSyncModalOpen}
          title={t("settings.sync.modal.title")}
          onClose={() => setCloudSyncModalOpen(false)}
          width={720}
        >
          <div className="settings-row settings-row--single">
            <div className="settings-field">
              <label className="settings-field-label" htmlFor="sync-provider">
                {t("settings.sync.provider")}
              </label>
              <Select
                className="settings-select"
                value={settings["sync.provider"]}
                onChange={(nextValue) =>
                  updateSetting(
                    "sync.provider",
                    nextValue as AppSettings["sync.provider"],
                  )
                }
                options={[
                  { value: "webdav", label: "WebDAV" },
                  { value: "s3", label: "S3" },
                ]}
              />
            </div>
            <div className="settings-row settings-row--two">
              <div className="settings-field">
                <label className="settings-field-label">
                  {t("settings.sync.autoBackup")}
                </label>
                <label className="settings-inline-actions">
                  <button
                    type="button"
                    className={`toggle-switch ${settings["sync.autoBackupEnabled"] ? "active" : ""}`}
                    role="switch"
                    aria-checked={settings["sync.autoBackupEnabled"]}
                    onClick={() =>
                      updateSetting(
                        "sync.autoBackupEnabled",
                        !settings["sync.autoBackupEnabled"],
                      )
                    }
                  >
                    <div className="toggle-switch-handle" />
                  </button>
                  <span className="settings-inline-meta">
                    {settings["sync.autoBackupEnabled"]
                      ? t("settings.sync.autoBackup.enabled")
                      : t("settings.sync.autoBackup.disabled")}
                  </span>
                </label>
              </div>
              <div className="settings-field">
                <label className="settings-field-label">
                  {t("settings.sync.autoBackupInterval")}
                </label>
                <Select
                  className="settings-select"
                  value={String(settings["sync.autoBackupIntervalMinutes"])}
                  onChange={(nextValue) =>
                    updateSetting(
                      "sync.autoBackupIntervalMinutes",
                      Math.max(1, Number(nextValue) || 30),
                    )
                  }
                  options={[
                    { value: "5", label: t("settings.sync.autoBackup.everyMinutes", { count: 5 }) },
                    { value: "10", label: t("settings.sync.autoBackup.everyMinutes", { count: 10 }) },
                    { value: "15", label: t("settings.sync.autoBackup.everyMinutes", { count: 15 }) },
                    { value: "30", label: t("settings.sync.autoBackup.everyMinutes", { count: 30 }) },
                    { value: "60", label: t("settings.sync.autoBackup.everyMinutes", { count: 60 }) },
                    { value: "120", label: t("settings.sync.autoBackup.everyMinutes", { count: 120 }) },
                  ]}
                  disabled={!settings["sync.autoBackupEnabled"]}
                />
              </div>
            </div>

            {settings["sync.provider"] === "webdav" ? (
              <div className="settings-row settings-row--two">
                <div className="settings-field">
                  <label className="settings-field-label">
                    {t("settings.sync.webdav.endpoint")}
                  </label>
                  <input
                    className="settings-input"
                    placeholder={t("settings.sync.webdav.endpoint.placeholder")}
                    value={settings["sync.webdav.endpoint"]}
                    onChange={(event) =>
                      updateSetting("sync.webdav.endpoint", event.target.value)
                    }
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">{t("settings.sync.webdav.path")}</label>
                  <input
                    className="settings-input"
                    placeholder={t("settings.sync.webdav.path.placeholder")}
                    value={settings["sync.webdav.basePath"]}
                    onChange={(event) =>
                      updateSetting("sync.webdav.basePath", event.target.value)
                    }
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">{t("settings.sync.username")}</label>
                  <input
                    className="settings-input"
                    value={settings["sync.webdav.username"]}
                    onChange={(event) =>
                      updateSetting("sync.webdav.username", event.target.value)
                    }
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">{t("settings.sync.password")}</label>
                  <input
                    className="settings-input"
                    type="password"
                    value={settings["sync.webdav.password"]}
                    onChange={(event) =>
                      updateSetting("sync.webdav.password", event.target.value)
                    }
                  />
                </div>
              </div>
            ) : (
              <div className="settings-row settings-row--two">
                <div className="settings-field">
                  <label className="settings-field-label">{t("settings.sync.s3.endpoint")}</label>
                  <input
                    className="settings-input"
                    placeholder={t("settings.sync.webdav.endpoint.placeholder")}
                    value={settings["sync.s3.endpoint"]}
                    onChange={(event) =>
                      updateSetting("sync.s3.endpoint", event.target.value)
                    }
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">{t("settings.sync.s3.region")}</label>
                  <input
                    className="settings-input"
                    value={settings["sync.s3.region"]}
                    onChange={(event) =>
                      updateSetting("sync.s3.region", event.target.value)
                    }
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">{t("settings.sync.s3.bucket")}</label>
                  <input
                    className="settings-input"
                    value={settings["sync.s3.bucket"]}
                    onChange={(event) =>
                      updateSetting("sync.s3.bucket", event.target.value)
                    }
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">{t("settings.sync.s3.prefix")}</label>
                  <input
                    className="settings-input"
                    value={settings["sync.s3.prefix"]}
                    onChange={(event) =>
                      updateSetting("sync.s3.prefix", event.target.value)
                    }
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">
                    {t("settings.sync.s3.accessKeyId")}
                  </label>
                  <input
                    className="settings-input"
                    value={settings["sync.s3.accessKeyId"]}
                    onChange={(event) =>
                      updateSetting("sync.s3.accessKeyId", event.target.value)
                    }
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">
                    {t("settings.sync.s3.secretAccessKey")}
                  </label>
                  <div className="settings-input-with-action">
                    <input
                      className="settings-input"
                      type={showS3SecretAccessKey ? "text" : "password"}
                      value={settings["sync.s3.secretAccessKey"]}
                      onChange={(event) =>
                        updateSetting("sync.s3.secretAccessKey", event.target.value)
                      }
                    />
                    <button
                      className="settings-input-action-btn"
                      type="button"
                      onClick={() => setShowS3SecretAccessKey((prev) => !prev)}
                      title={
                        showS3SecretAccessKey
                          ? t("connections.password.hide")
                          : t("connections.password.show")
                      }
                      aria-label={
                        showS3SecretAccessKey
                          ? t("connections.password.hide")
                          : t("connections.password.show")
                      }
                    >
                      <AppIcon
                        icon={
                          showS3SecretAccessKey
                            ? "material-symbols:visibility-off-rounded"
                            : "material-symbols:visibility-rounded"
                        }
                        size={16}
                      />
                    </button>
                  </div>
                </div>
                <label className="settings-inline-actions">
                  <input
                    type="checkbox"
                    checked={settings["sync.s3.forcePathStyle"]}
                    onChange={(event) =>
                      updateSetting("sync.s3.forcePathStyle", event.target.checked)
                    }
                  />
                  <span className="settings-inline-meta">
                    {t("settings.sync.s3.pathStyle")}
                  </span>
                </label>
              </div>
            )}

            <div className="settings-inline-actions settings-sync-actions">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => void handleCloudSyncTest()}
                disabled={cloudSyncAction !== null}
              >
                {cloudSyncAction === "test"
                  ? t("settings.sync.testing")
                  : t("settings.sync.action.test")}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => void handleCloudSyncUpload()}
                disabled={cloudSyncAction !== null}
              >
                {cloudSyncAction === "upload"
                  ? t("settings.sync.uploading")
                  : t("settings.sync.action.upload")}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => void handleCloudSyncDownload()}
                disabled={cloudSyncAction !== null}
              >
                {cloudSyncAction === "download"
                  ? t("settings.sync.downloading")
                  : t("settings.sync.action.download")}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => void handleCloudSyncRestore()}
                disabled={cloudSyncAction !== null}
              >
                {cloudSyncAction === "restore"
                  ? t("settings.sync.restoring")
                  : t("settings.sync.action.restore")}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => void handleCloudSyncRollback()}
                disabled={cloudSyncAction !== null}
              >
                {cloudSyncAction === "rollback"
                  ? t("settings.sync.rollbacking")
                  : t("settings.sync.action.rollback")}
              </button>
            </div>
            {cloudSyncMessage && cloudSyncStatus !== "success" && (
              <span
                className={`settings-test-status ${
                  cloudSyncStatus === "error"
                      ? "settings-test-status--error"
                      : ""
                }`}
              >
                {cloudSyncMessage}
              </span>
            )}
          </div>
        </Modal>
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
