import { Store } from "@tauri-apps/plugin-store";

export type TerminalThemeName =
  | "light"
  | "dark"
  | "monokai"
  | "solarized"
  | "nord"
  | "dracula"
  | "gruvbox"
  | "tokyo"
  | "catppuccin";

export type AppSettings = {
  "i18n.locale": "zh-CN" | "en-US";
  "ui.theme": "bright" | "mint" | "dark";
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
  "terminal.backgroundImage": string;
  "terminal.backgroundOpacity": number;
  "terminal.backgroundBlur": number;
  "ai.enabled": boolean;
  "ai.provider": "openai" | "anthropic";
  "ai.openai.baseUrl": string;
  "ai.openai.apiKey": string;
  "ai.anthropic.baseUrl": string;
  "ai.anthropic.apiKey": string;
  "ai.model": string;
  "ai.models": string[];
  "ai.agentMode": "suggest_only" | "confirm_then_execute";
};

export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"SF Mono", Monaco, Menlo, "Ubuntu Mono", monospace';

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
  "terminal.backgroundImage": "",
  "terminal.backgroundOpacity": 0.6,
  "terminal.backgroundBlur": 6,
  "ai.enabled": false,
  "ai.provider": "openai",
  "ai.openai.baseUrl": "https://api.openai.com",
  "ai.openai.apiKey": "",
  "ai.anthropic.baseUrl": "https://api.anthropic.com",
  "ai.anthropic.apiKey": "",
  "ai.model": "claude-sonnet-4-5-20250929",
  "ai.models": [],
  "ai.agentMode": "suggest_only",
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
