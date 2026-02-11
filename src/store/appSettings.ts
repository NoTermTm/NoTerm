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
  "connection.autoConnect": boolean;
  "connection.savePassword": boolean;
  "connection.keepAlive": boolean;
  "connection.keepAliveInterval": number;
  "terminal.theme": TerminalThemeName;
  "terminal.fontSize": number;
  "terminal.fontFamily": string;
  "terminal.fontWeight": number;
  "terminal.cursorStyle": "block" | "underline" | "bar";
  "terminal.cursorBlink": boolean;
  "terminal.lineHeight": number;
};

export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"SF Mono", Monaco, Menlo, "Ubuntu Mono", monospace';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  "connection.autoConnect": false,
  "connection.savePassword": true,
  "connection.keepAlive": true,
  "connection.keepAliveInterval": 60,
  "terminal.theme": "light",
  "terminal.fontSize": 13,
  "terminal.fontFamily": DEFAULT_TERMINAL_FONT_FAMILY,
  "terminal.fontWeight": 400,
  "terminal.cursorStyle": "block",
  "terminal.cursorBlink": true,
  "terminal.lineHeight": 1.4,
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
}

