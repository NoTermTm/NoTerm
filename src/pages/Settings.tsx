import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  writeAppSetting,
  getAppSettingsStore,
  DEFAULT_TERMINAL_FONT_FAMILY,
} from "../store/appSettings";
import { load } from "@tauri-apps/plugin-store";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { TERMINAL_THEME_OPTIONS, getXtermTheme } from "../terminal/xtermThemes";
import { sendAiChat, type AiMessage } from "../api/ai";
import { generateSalt, hashMasterKey } from "../utils/security";
import { getModifierKeyName } from "../utils/platform";
import {
  clearMasterKeySession,
  setMasterKeySession,
} from "../utils/securitySession";
import { getVersion } from "@tauri-apps/api/app";
import { check as checkForUpdates } from "@tauri-apps/plugin-updater";
import { useI18n } from "../i18n";
import { Select } from "../components/Select";
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

const OPENAI_MODEL_OPTIONS = [
  { label: "gpt-4o", value: "gpt-4o" },
  { label: "gpt-4o-mini", value: "gpt-4o-mini" },
  { label: "gpt-4.1", value: "gpt-4.1" },
  { label: "gpt-4.1-mini", value: "gpt-4.1-mini" },
  { label: "gpt-4.1-nano", value: "gpt-4.1-nano" },
];

const ANTHROPIC_MODEL_OPTIONS = [
  { label: "claude-sonnet-4-5-20250929", value: "claude-sonnet-4-5-20250929" },
  { label: "claude-opus-4-20250514", value: "claude-opus-4-20250514" },
  { label: "claude-3-5-sonnet-20240620", value: "claude-3-5-sonnet-20240620" },
  { label: "claude-3-5-haiku-20241022", value: "claude-3-5-haiku-20241022" },
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

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const previewTheme = getXtermTheme(settings["terminal.theme"]);
  const previewSelection = previewTheme.selectionBackground ?? "rgba(15, 143, 255, 0.18)";
  const [aiTestStatus, setAiTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [aiTestMessage, setAiTestMessage] = useState<string | null>(null);
  const [masterKeyInput, setMasterKeyInput] = useState("");
  const [masterKeyConfirm, setMasterKeyConfirm] = useState("");
  const [masterKeyStatus, setMasterKeyStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [masterKeyMessage, setMasterKeyMessage] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [_, setExportMessage] = useState<string | null>(null);
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
  const updateRef = useRef<Awaited<ReturnType<typeof checkForUpdates>> | null>(null);
  const updateStatusRef = useRef(updateStatus);
  const hasMasterKey = Boolean(settings["security.masterKeyHash"]);
  const modifierKeyName = getModifierKeyName();
  const { t } = useI18n();

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

  const handleSetMasterKey = async () => {
    if (masterKeyInput.trim().length < 6) {
      setMasterKeyStatus("error");
      setMasterKeyMessage(t("settings.security.masterKey.tooShort"));
      return;
    }
    if (masterKeyInput !== masterKeyConfirm) {
      setMasterKeyStatus("error");
      setMasterKeyMessage(t("settings.security.masterKey.mismatch"));
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
      setMasterKeyMessage(t("settings.security.masterKey.updated"));
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("master-key-updated"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMasterKeyStatus("error");
      setMasterKeyMessage(message || t("settings.security.masterKey.failed"));
    }
  };

  const handleClearMasterKey = () => {
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
  const aiModelOptions =
    settings["ai.provider"] === "openai"
      ? OPENAI_MODEL_OPTIONS
      : ANTHROPIC_MODEL_OPTIONS;
  const aiModelOptionsWithCurrent = aiModelOptions.some(
    (opt) => opt.value === settings["ai.model"],
  )
    ? aiModelOptions
    : [
        ...aiModelOptions,
        { value: settings["ai.model"], label: settings["ai.model"] },
      ];

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
                  className="settings-preview-content"
                  style={{
                    fontFamily: settings["terminal.fontFamily"],
                    fontSize: settings["terminal.fontSize"],
                    fontWeight: settings["terminal.fontWeight"],
                    background: previewTheme.background,
                    color: previewTheme.foreground,
                    lineHeight: settings["terminal.lineHeight"],
                  }}
                >
                  <span style={{ color: previewTheme.green }}>orcatem</span>{" "}
                  <span style={{ color: previewTheme.blue }}>OpenCloudOS</span>$ ls
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
          <div className="settings-item-control">
            <Select
              className="settings-select"
              value={settings["ai.model"]}
              onChange={(nextValue) => updateSetting("ai.model", nextValue)}
              disabled={!settings["ai.enabled"]}
              options={aiModelOptionsWithCurrent.map((opt) => ({
                value: opt.value,
                label: opt.label,
              }))}
            />
          </div>
        </div>
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
