import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from "../store/appSettings";

const PROTECTED_IMPORT_KEYS: Array<keyof AppSettings> = [
  "security.masterKeyHash",
  "security.masterKeySalt",
  "security.masterKeyEncSalt",
  "ai.openai.apiKey",
  "ai.anthropic.apiKey",
  "ai.volcengine.apiKey",
  "ai.deepseek.apiKey",
  "sync.webdav.username",
  "sync.webdav.password",
  "sync.s3.accessKeyId",
  "sync.s3.secretAccessKey",
];

const EXPORTED_SECRET_KEYS: Array<keyof AppSettings> = [
  "security.masterKeyHash",
  "security.masterKeySalt",
  "ai.openai.apiKey",
  "ai.anthropic.apiKey",
  "ai.volcengine.apiKey",
  "ai.deepseek.apiKey",
  "sync.webdav.username",
  "sync.webdav.password",
  "sync.s3.accessKeyId",
  "sync.s3.secretAccessKey",
];

export const buildExportSettings = (settings: AppSettings): AppSettings => {
  const next = { ...settings } as Record<
    keyof AppSettings,
    AppSettings[keyof AppSettings]
  >;
  for (const key of EXPORTED_SECRET_KEYS) {
    next[key] = "" as AppSettings[keyof AppSettings];
  }
  return next as AppSettings;
};

export const mergeImportedSettings = (
  current: AppSettings,
  importedSettings: Partial<AppSettings>,
): AppSettings => {
  const keys = Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettings>;
  const protectedKeys = new Set<keyof AppSettings>(PROTECTED_IMPORT_KEYS);
  const next = { ...current } as Record<
    keyof AppSettings,
    AppSettings[keyof AppSettings]
  >;

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(importedSettings, key)) {
      continue;
    }
    const value = importedSettings[key];
    if (
      protectedKeys.has(key) &&
      (value === "" || value === null || typeof value === "undefined")
    ) {
      continue;
    }
    next[key] = (value as AppSettings[keyof AppSettings]) ?? next[key];
  }

  const endpointProvided = Object.prototype.hasOwnProperty.call(
    importedSettings,
    "sync.webdav.endpoint",
  );
  const usernameProvided = Object.prototype.hasOwnProperty.call(
    importedSettings,
    "sync.webdav.username",
  );
  const passwordProvided = Object.prototype.hasOwnProperty.call(
    importedSettings,
    "sync.webdav.password",
  );
  const endpointChanged =
    endpointProvided &&
    String(next["sync.webdav.endpoint"] || "").trim() !==
      String(current["sync.webdav.endpoint"] || "").trim();
  if (endpointChanged && (!usernameProvided || !passwordProvided)) {
    next["sync.webdav.username"] = "";
    next["sync.webdav.password"] = "";
  }

  return next as AppSettings;
};
