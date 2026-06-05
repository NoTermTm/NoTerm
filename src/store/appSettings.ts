import { Store } from "@tauri-apps/plugin-store";
import type { AgentApprovalMode } from "../types/agent";

export type TerminalThemeName =
  | "light"
  | "paper"
  | "dark"
  | "monokai"
  | "solarized"
  | "nord"
  | "dracula"
  | "gruvbox"
  | "tokyo"
  | "catppuccin"
  | "onedark"
  | "kanagawa"
  | "rosepine"
  | "ayu";

export type TerminalBackgroundFit = "cover" | "contain" | "stretch";

export type AppSettings = {
  "i18n.locale": "zh-CN" | "en-US";
  "ui.theme": "bright" | "mint" | "kraft" | "dark";
  "connection.autoConnect": boolean;
  "connection.savePassword": boolean;
  "connection.keepAlive": boolean;
  "connection.keepAliveInterval": number;
  "security.masterKeyHash": string;
  "security.masterKeySalt": string;
  "security.masterKeyEncSalt": string;
  "security.lockTimeoutMinutes": number;
  "terminal.theme": TerminalThemeName;
  "terminal.fontSize": number;
  "terminal.fontFamily": string;
  "terminal.fontWeight": number;
  "terminal.cursorStyle": "block" | "underline" | "bar";
  "terminal.cursorBlink": boolean;
  "terminal.lineHeight": number;
  "terminal.autoCopy": boolean;
  "terminal.reconnectWriteFailures": number;
  "terminal.backgroundImage": string;
  "terminal.backgroundFit": TerminalBackgroundFit;
  "terminal.backgroundOpacity": number;
  "terminal.backgroundBlur": number;
  "ai.enabled": boolean;
  "ai.provider": "openai" | "anthropic" | "volcengine" | "deepseek";
  "ai.openai.baseUrl": string;
  "ai.openai.apiKey": string;
  "ai.openai.model": string;
  "ai.openai.models": string[];
  "ai.anthropic.baseUrl": string;
  "ai.anthropic.apiKey": string;
  "ai.anthropic.model": string;
  "ai.anthropic.models": string[];
  "ai.volcengine.baseUrl": string;
  "ai.volcengine.apiKey": string;
  "ai.volcengine.model": string;
  "ai.volcengine.models": string[];
  "ai.deepseek.baseUrl": string;
  "ai.deepseek.apiKey": string;
  "ai.deepseek.model": string;
  "ai.deepseek.models": string[];
  "ai.model": string;
  "ai.models": string[];
  "ai.approvalMode": AgentApprovalMode;
  "sync.enabled": boolean;
  "sync.provider": "webdav" | "s3";
  "sync.lastSyncedAt": string;
  "sync.autoBackupEnabled": boolean;
  "sync.autoBackupIntervalMinutes": number;
  "sync.webdav.endpoint": string;
  "sync.webdav.username": string;
  "sync.webdav.password": string;
  "sync.webdav.basePath": string;
  "sync.s3.endpoint": string;
  "sync.s3.region": string;
  "sync.s3.bucket": string;
  "sync.s3.prefix": string;
  "sync.s3.accessKeyId": string;
  "sync.s3.secretAccessKey": string;
  "sync.s3.forcePathStyle": boolean;
};

const isWindowsPlatform = () =>
  typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent || navigator.platform);

export const TERMINAL_ICON_FONT_FALLBACKS = [
  "Symbols Nerd Font Mono",
  "Symbols Nerd Font",
  "Nerd Font Symbols",
  "Font Awesome 6 Free",
  "Font Awesome 5 Free",
  "FontAwesome",
  "Material Symbols Rounded",
  "Material Symbols Outlined",
  "Material Icons",
  "Apple Color Emoji",
  "Segoe UI Emoji",
] as const;

const quoteFontFamily = (family: string) => `"${family.replace(/"/g, '\\"')}"`;

export const TERMINAL_ICON_FONT_FALLBACK_STACK =
  TERMINAL_ICON_FONT_FALLBACKS.map(quoteFontFamily).join(", ");

export function withTerminalIconFontFallback(fontFamily: string) {
  const base = (fontFamily || "").trim();
  const baseWithoutGeneric = base
    .replace(/,\s*monospace\s*$/i, "")
    .replace(/\bmonospace\s*$/i, "")
    .trim()
    .replace(/,\s*$/, "");
  const normalized = baseWithoutGeneric.toLowerCase();
  const iconFallbacks = TERMINAL_ICON_FONT_FALLBACKS.filter(
    (family) => !normalized.includes(family.toLowerCase()),
  )
    .map(quoteFontFamily)
    .join(", ");

  if (!baseWithoutGeneric) return `${TERMINAL_ICON_FONT_FALLBACK_STACK}, monospace`;
  if (!iconFallbacks) return `${baseWithoutGeneric}, monospace`;
  return `${baseWithoutGeneric}, ${iconFallbacks}, monospace`;
}

export const DEFAULT_TERMINAL_FONT_FAMILY = isWindowsPlatform()
  ? withTerminalIconFontFallback('"Cascadia Code", Consolas, "Courier New", monospace')
  : withTerminalIconFontFallback('"SF Mono", Monaco, Menlo, "Ubuntu Mono", monospace');

export const DEFAULT_APP_SETTINGS: AppSettings = {
  "i18n.locale": "zh-CN",
  "ui.theme": "bright",
  "connection.autoConnect": false,
  "connection.savePassword": true,
  "connection.keepAlive": true,
  "connection.keepAliveInterval": 60,
  "security.masterKeyHash": "",
  "security.masterKeySalt": "",
  "security.masterKeyEncSalt": "",
  "security.lockTimeoutMinutes": 0,
  "terminal.theme": "light",
  "terminal.fontSize": 13,
  "terminal.fontFamily": DEFAULT_TERMINAL_FONT_FAMILY,
  "terminal.fontWeight": 400,
  "terminal.cursorStyle": "block",
  "terminal.cursorBlink": true,
  "terminal.lineHeight": 1.4,
  "terminal.autoCopy": false,
  "terminal.reconnectWriteFailures": 3,
  "terminal.backgroundImage": "",
  "terminal.backgroundFit": "cover",
  "terminal.backgroundOpacity": 0.6,
  "terminal.backgroundBlur": 6,
  "ai.enabled": false,
  "ai.provider": "openai",
  "ai.openai.baseUrl": "https://api.openai.com",
  "ai.openai.apiKey": "",
  "ai.openai.model": "",
  "ai.openai.models": [],
  "ai.anthropic.baseUrl": "https://api.anthropic.com",
  "ai.anthropic.apiKey": "",
  "ai.anthropic.model": "",
  "ai.anthropic.models": [],
  "ai.volcengine.baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
  "ai.volcengine.apiKey": "",
  "ai.volcengine.model": "",
  "ai.volcengine.models": [],
  "ai.deepseek.baseUrl": "https://api.deepseek.com",
  "ai.deepseek.apiKey": "",
  "ai.deepseek.model": "",
  "ai.deepseek.models": [],
  "ai.model": "claude-sonnet-4-5-20250929",
  "ai.models": [],
  "ai.approvalMode": "auto",
  "sync.enabled": false,
  "sync.provider": "webdav",
  "sync.lastSyncedAt": "",
  "sync.autoBackupEnabled": false,
  "sync.autoBackupIntervalMinutes": 30,
  "sync.webdav.endpoint": "",
  "sync.webdav.username": "",
  "sync.webdav.password": "",
  "sync.webdav.basePath": "/noterm-sync",
  "sync.s3.endpoint": "",
  "sync.s3.region": "us-east-1",
  "sync.s3.bucket": "",
  "sync.s3.prefix": "noterm-sync",
  "sync.s3.accessKeyId": "",
  "sync.s3.secretAccessKey": "",
  "sync.s3.forcePathStyle": true,
};

const STORE_PATH = "settings.json";

let storePromise: Promise<Store> | null = null;

export function getAppSettingsStore() {
  if (!storePromise) {
    storePromise = Store.load(STORE_PATH, {
      defaults: DEFAULT_APP_SETTINGS,
      // Reduce disk churn while still feeling instant in the UI.
      autoSave: 200,
    });
  }
  return storePromise;
}

export async function readAppSetting<K extends keyof AppSettings>(
  key: K,
): Promise<AppSettings[K]> {
  const store = await getAppSettingsStore();
  const v = await store.get<AppSettings[K]>(key);
  return (v ?? DEFAULT_APP_SETTINGS[key]) as AppSettings[K];
}

export async function writeAppSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
) {
  const store = await getAppSettingsStore();
  await store.set(key, value);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("app-settings-updated", { detail: { key, value } }),
    );
  }
}
