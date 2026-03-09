import { load } from "@tauri-apps/plugin-store";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  decryptString,
  encryptString,
  isEncryptedPayload,
  type EncryptedPayload,
} from "../utils/security";
import {
  DEFAULT_APP_SETTINGS,
  getAppSettingsStore,
  type AppSettings,
} from "../store/appSettings";

type SyncProviderType = "webdav" | "s3";

type WebDavConfig = {
  endpoint: string;
  username: string;
  password: string;
  basePath: string;
};

type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export type CloudSyncConfig = {
  provider: SyncProviderType;
  webdav: WebDavConfig;
  s3: S3Config;
};

type SyncPayload = {
  version: 1;
  exportedAt: string;
  encSalt?: string;
  settings: Partial<AppSettings>;
  connections: unknown[];
  profiles: unknown[];
  scripts: unknown;
  forwardings: unknown;
  aiModels: unknown;
};

type SyncEnvelope = {
  version: 1;
  updatedAt: string;
  encSalt?: string;
  payload: unknown;
};

type LocalSyncBackup = {
  version: 1;
  backupAt: string;
  remoteUpdatedAt: string;
  encSalt: string;
  payload: EncryptedPayload;
};

type StorageProvider = {
  readText(key: string): Promise<string | null>;
  writeText(key: string, value: string): Promise<void>;
  deleteKey(key: string): Promise<void>;
  testConnection(): Promise<void>;
};

const REMOTE_KEY = "noterm.sync.v1.json";
const LEGACY_REMOTE_KEYS = ["noterm.sync.json", "noterm-sync.json"];
const LOCAL_BACKUP_STORE = "cloud-sync-backup.json";
const LOCAL_BACKUP_KEY = "latest";

const SYNC_EXCLUDED_SETTINGS = new Set<keyof AppSettings>([
  "security.masterKeyHash",
  "security.masterKeySalt",
  "security.masterKeyEncSalt",
  "sync.enabled",
  "sync.provider",
  "sync.lastSyncedAt",
  "sync.autoBackupEnabled",
  "sync.autoBackupIntervalMinutes",
  "sync.webdav.endpoint",
  "sync.webdav.username",
  "sync.webdav.password",
  "sync.webdav.basePath",
  "sync.s3.endpoint",
  "sync.s3.region",
  "sync.s3.bucket",
  "sync.s3.prefix",
  "sync.s3.accessKeyId",
  "sync.s3.secretAccessKey",
  "sync.s3.forcePathStyle",
]);

const textEncoder = new TextEncoder();

const toBase64 = (value: string) => btoa(unescape(encodeURIComponent(value)));
const encodeUriPath = (value: string) =>
  value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const normalizePrefix = (prefix: string) =>
  prefix
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

const joinKey = (prefix: string, key: string) => {
  const cleanPrefix = normalizePrefix(prefix);
  if (!cleanPrefix) return key;
  return `${cleanPrefix}/${key}`;
};

const sha256Hex = async (value: string | Uint8Array) => {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
};

const hmacSha256 = async (key: Uint8Array, value: string) => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(value));
  return new Uint8Array(signature);
};

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");

const formatAmzDate = (date: Date) => {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    shortDate: iso.slice(0, 8),
  };
};

const getS3HostAndPath = (config: S3Config, key: string) => {
  const endpoint = new URL(config.endpoint.trim());
  const encodedKey = encodeUriPath(key);
  const hasEndpointPath = endpoint.pathname && endpoint.pathname !== "/";
  const endpointPath = hasEndpointPath ? endpoint.pathname.replace(/\/+$/, "") : "";

  if (config.forcePathStyle) {
    return {
      host: endpoint.host,
      path: `${endpointPath}/${encodeURIComponent(config.bucket)}/${encodedKey}`.replace(
        /\/{2,}/g,
        "/",
      ),
      origin: endpoint.origin,
    };
  }

  return {
    host: `${encodeURIComponent(config.bucket)}.${endpoint.host}`,
    path: `${endpointPath}/${encodedKey}`.replace(/\/{2,}/g, "/"),
    origin: `${endpoint.protocol}//${encodeURIComponent(config.bucket)}.${endpoint.host}`,
  };
};

const createWebDavProvider = (config: WebDavConfig): StorageProvider => {
  const endpoint = config.endpoint.trim().replace(/\/+$/, "");
  const basePath = config.basePath.trim() || "/";
  const normalizedBasePath = basePath.startsWith("/") ? basePath : `/${basePath}`;
  const auth =
    config.username || config.password
      ? `Basic ${toBase64(`${config.username}:${config.password}`)}`
      : "";

  const request = async (method: string, key: string, body?: string) => {
    const keyPath = key.replace(/^\/+/, "");
    const path = `${normalizedBasePath.replace(/\/+$/, "")}/${keyPath}`.replace(
      /\/{2,}/g,
      "/",
    );
    const url = `${endpoint}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (auth) headers.Authorization = auth;
    return tauriFetch(url, {
      method,
      headers,
      body,
    });
  };

  const ensureCollection = async () => {
    const parts = normalizedBasePath
      .split("/")
      .map((item) => item.trim())
      .filter(Boolean);
    let currentPath = "";
    for (const part of parts) {
      currentPath = `${currentPath}/${part}`;
      const url = `${endpoint}${currentPath}`;
      const headers: Record<string, string> = {};
      if (auth) headers.Authorization = auth;
      const resp = await tauriFetch(url, { method: "MKCOL", headers });
      if (resp.ok || resp.status === 405 || resp.status === 301) continue;
      if (resp.status === 409) continue;
      throw new Error(`WebDAV MKCOL failed: ${resp.status} ${resp.statusText}`);
    }
  };

  return {
    async readText(key) {
      const resp = await request("GET", key);
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`WebDAV GET failed: ${resp.status} ${resp.statusText}`);
      return resp.text();
    },
    async writeText(key, value) {
      await ensureCollection();
      const resp = await request("PUT", key, value);
      if (!resp.ok) throw new Error(`WebDAV PUT failed: ${resp.status} ${resp.statusText}`);
    },
    async deleteKey(key) {
      const resp = await request("DELETE", key);
      if (!resp.ok && resp.status !== 404) {
        throw new Error(`WebDAV DELETE failed: ${resp.status} ${resp.statusText}`);
      }
    },
    async testConnection() {
      const marker = `.noterm-sync-test-${Date.now()}.txt`;
      await ensureCollection();
      await this.writeText(marker, "ok");
      const echoed = await this.readText(marker);
      await this.deleteKey(marker);
      if (echoed !== "ok") {
        throw new Error("WebDAV read-back verification failed");
      }
    },
  };
};

const createS3Provider = (config: S3Config): StorageProvider => {
  const buildSignedRequest = async (
    method: "GET" | "PUT" | "DELETE",
    key: string,
    body = "",
  ) => {
    const targetKey = joinKey(config.prefix, key);
    const { host, path, origin } = getS3HostAndPath(config, targetKey);
    const now = new Date();
    const { amzDate, shortDate } = formatAmzDate(now);
    const payloadHash = await sha256Hex(body);
    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      method,
      path,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${shortDate}/${config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      await sha256Hex(canonicalRequest),
    ].join("\n");

    const kDate = await hmacSha256(textEncoder.encode(`AWS4${config.secretAccessKey}`), shortDate);
    const kRegion = await hmacSha256(kDate, config.region);
    const kService = await hmacSha256(kRegion, "s3");
    const kSigning = await hmacSha256(kService, "aws4_request");
    const signature = bytesToHex(await hmacSha256(kSigning, stringToSign));

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const headers: Record<string, string> = {
      Host: host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      Authorization: authorization,
    };
    if (method === "PUT") {
      headers["Content-Type"] = "application/json";
    }
    return {
      url: `${origin}${path}`,
      headers,
      body: method === "PUT" ? body : undefined,
    };
  };

  return {
    async readText(key) {
      const req = await buildSignedRequest("GET", key);
      const resp = await tauriFetch(req.url, { method: "GET", headers: req.headers });
      if (resp.status === 404) return null;
      if (resp.status === 403) {
        throw new Error(`S3 GET access denied (403) for key "${joinKey(config.prefix, key)}"`);
      }
      if (!resp.ok) throw new Error(`S3 GET failed: ${resp.status} ${resp.statusText}`);
      return resp.text();
    },
    async writeText(key, value) {
      const req = await buildSignedRequest("PUT", key, value);
      const resp = await tauriFetch(req.url, {
        method: "PUT",
        headers: req.headers,
        body: req.body,
      });
      if (!resp.ok) throw new Error(`S3 PUT failed: ${resp.status} ${resp.statusText}`);
    },
    async deleteKey(key) {
      const req = await buildSignedRequest("DELETE", key);
      const resp = await tauriFetch(req.url, { method: "DELETE", headers: req.headers });
      if (!resp.ok && resp.status !== 404) {
        throw new Error(`S3 DELETE failed: ${resp.status} ${resp.statusText}`);
      }
    },
    async testConnection() {
      const marker = `.noterm-sync-test-${Date.now()}.txt`;
      await this.writeText(marker, "ok");
      const echoed = await this.readText(marker);
      await this.deleteKey(marker);
      if (echoed !== "ok") {
        throw new Error("S3 read-back verification failed");
      }
    },
  };
};

const buildProvider = (config: CloudSyncConfig): StorageProvider => {
  if (config.provider === "webdav") return createWebDavProvider(config.webdav);
  return createS3Provider(config.s3);
};

const buildDownloadCandidates = (config: CloudSyncConfig) => {
  const candidates: Array<{ provider: StorageProvider; key: string }> = [];
  const provider = buildProvider(config);
  candidates.push({ provider, key: REMOTE_KEY });
  for (const legacyKey of LEGACY_REMOTE_KEYS) {
    candidates.push({ provider, key: legacyKey });
  }

  if (config.provider === "s3" && normalizePrefix(config.s3.prefix)) {
    const noPrefixProvider = buildProvider({
      ...config,
      s3: { ...config.s3, prefix: "" },
    });
    candidates.push({ provider: noPrefixProvider, key: REMOTE_KEY });
    for (const legacyKey of LEGACY_REMOTE_KEYS) {
      candidates.push({ provider: noPrefixProvider, key: legacyKey });
    }
  }

  return candidates;
};

const readAllSettingsForSync = async () => {
  const store = await getAppSettingsStore();
  const keys = Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettings>;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (SYNC_EXCLUDED_SETTINGS.has(key)) continue;
    const value = await store.get<AppSettings[typeof key]>(key);
    result[key] = value ?? DEFAULT_APP_SETTINGS[key];
  }
  return result as Partial<AppSettings>;
};

export const readSettingsSnapshot = async () => {
  const store = await getAppSettingsStore();
  const keys = Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettings>;
  const next = {} as Record<keyof AppSettings, AppSettings[keyof AppSettings]>;
  for (const key of keys) {
    const value = await store.get<AppSettings[typeof key]>(key);
    next[key] = (value ?? DEFAULT_APP_SETTINGS[key]) as AppSettings[typeof key];
  }
  return next as AppSettings;
};

const buildSyncPayload = async (fallbackEncSalt = ""): Promise<SyncPayload> => {
  const settingsStore = await getAppSettingsStore();
  const encSalt =
    (await settingsStore.get<string>("security.masterKeyEncSalt")) ??
    fallbackEncSalt;
  const connectionStore = await load("connections.json");
  const keysStore = await load("keys.json");
  const scriptsStore = await load("scripts.json");
  const forwardingStore = await load("forwardings.json");
  const aiModelsStore = await load("ai-models.json");

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    encSalt: encSalt?.trim() ? encSalt : undefined,
    settings: await readAllSettingsForSync(),
    connections: (await connectionStore.get("connections")) ?? [],
    profiles: (await keysStore.get("profiles")) ?? [],
    scripts: (await scriptsStore.get("data")) ?? { folders: [], scripts: [] },
    forwardings: (await forwardingStore.get("forwardings")) ?? { rules: [] },
    aiModels: {
      openai: (await aiModelsStore.get("openai")) ?? [],
      anthropic: (await aiModelsStore.get("anthropic")) ?? [],
    },
  };
};

const applySyncPayload = async (payload: SyncPayload) => {
  const settingsStore = await getAppSettingsStore();
  if (payload.encSalt && payload.encSalt.trim()) {
    await settingsStore.set("security.masterKeyEncSalt", payload.encSalt);
  }
  const keys = Object.keys(payload.settings) as Array<keyof AppSettings>;
  for (const key of keys) {
    if (!(key in DEFAULT_APP_SETTINGS)) continue;
    await settingsStore.set(key, payload.settings[key] as AppSettings[typeof key]);
  }
  await settingsStore.save();

  const connectionStore = await load("connections.json");
  await connectionStore.set("connections", payload.connections ?? []);
  await connectionStore.save();

  const keysStore = await load("keys.json");
  await keysStore.set("profiles", payload.profiles ?? []);
  await keysStore.save();

  const scriptsStore = await load("scripts.json");
  await scriptsStore.set("data", payload.scripts ?? { folders: [], scripts: [] });
  await scriptsStore.save();

  const forwardingStore = await load("forwardings.json");
  await forwardingStore.set("forwardings", payload.forwardings ?? { rules: [] });
  await forwardingStore.save();

  const aiModelsStore = await load("ai-models.json");
  const aiModels = (payload.aiModels ?? {}) as Record<string, unknown>;
  await aiModelsStore.set(
    "openai",
    Array.isArray(aiModels.openai) ? aiModels.openai : [],
  );
  await aiModelsStore.set(
    "anthropic",
    Array.isArray(aiModels.anthropic) ? aiModels.anthropic : [],
  );
  await aiModelsStore.save();
};

const ensureDecryptablePayload = (value: unknown) => {
  if (!isEncryptedPayload(value)) {
    throw new Error("Remote payload format is invalid");
  }
  return value;
};

const isLocalSyncBackup = (value: unknown): value is LocalSyncBackup => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.backupAt === "string" &&
    typeof record.remoteUpdatedAt === "string" &&
    typeof record.encSalt === "string" &&
    isEncryptedPayload(record.payload)
  );
};

const saveLocalBackupBeforeDownload = async (
  remoteUpdatedAt: string,
  masterKey: string,
  encSalt: string,
) => {
  const localPayload = await buildSyncPayload();
  const encryptedPayload = await encryptString(
    JSON.stringify(localPayload),
    masterKey,
    encSalt,
  );
  const backup: LocalSyncBackup = {
    version: 1,
    backupAt: new Date().toISOString(),
    remoteUpdatedAt,
    encSalt,
    payload: encryptedPayload,
  };
  const backupStore = await load(LOCAL_BACKUP_STORE);
  await backupStore.set(LOCAL_BACKUP_KEY, backup);
  await backupStore.save();
  return backup.backupAt;
};

export const cloudSyncRestoreLatestLocalBackup = async (input: {
  masterKey: string;
  encSalt: string;
}) => {
  const backupStore = await load(LOCAL_BACKUP_STORE);
  const backupRaw = await backupStore.get(LOCAL_BACKUP_KEY);
  if (!isLocalSyncBackup(backupRaw)) {
    throw new Error("No local backup found");
  }
  const decryptSalt = backupRaw.encSalt || input.encSalt;
  let decrypted = "";
  try {
    decrypted = await decryptString(backupRaw.payload, input.masterKey, decryptSalt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /operation-specific reason|OperationError|decrypt/i.test(message)
    ) {
      throw new Error(
        "Unable to decrypt local backup. Ensure the Master Key matches when backup was created.",
      );
    }
    throw error;
  }
  const payload = JSON.parse(decrypted) as SyncPayload;
  if (payload.version !== 1) {
    throw new Error("Unsupported local backup payload version");
  }
  await applySyncPayload(payload);
  return {
    backupAt: backupRaw.backupAt,
    remoteUpdatedAt: backupRaw.remoteUpdatedAt,
  };
};

export const cloudSyncTestConnection = async (config: CloudSyncConfig) => {
  const provider = buildProvider(config);
  await provider.testConnection();
};

export const cloudSyncUpload = async (input: {
  config: CloudSyncConfig;
  masterKey: string;
  encSalt: string;
}) => {
  const provider = buildProvider(input.config);
  const payload = await buildSyncPayload(input.encSalt);
  const encrypted = await encryptString(
    JSON.stringify(payload),
    input.masterKey,
    input.encSalt,
  );
  const envelope: SyncEnvelope = {
    version: 1,
    updatedAt: new Date().toISOString(),
    encSalt: input.encSalt,
    payload: encrypted,
  };
  await provider.writeText(REMOTE_KEY, JSON.stringify(envelope));
  return envelope.updatedAt;
};

export const cloudSyncDownload = async (input: {
  config: CloudSyncConfig;
  masterKey: string;
  encSalt: string;
}) => {
  const candidates = buildDownloadCandidates(input.config);
  let text: string | null = null;
  for (const candidate of candidates) {
    text = await candidate.provider.readText(candidate.key);
    if (text) break;
  }
  if (!text) {
    throw new Error(
      `No remote sync data found (tried keys: ${[
        REMOTE_KEY,
        ...LEGACY_REMOTE_KEYS,
      ].join(", ")}${input.config.provider === "s3" && normalizePrefix(input.config.s3.prefix) ? ", and no-prefix fallback" : ""})`,
    );
  }
  const envelope = JSON.parse(text) as {
    payload?: unknown;
    updatedAt?: string;
    encSalt?: unknown;
  };
  const encrypted = ensureDecryptablePayload(envelope.payload);
  const decryptSalt =
    typeof envelope.encSalt === "string" && envelope.encSalt.trim()
      ? envelope.encSalt
      : input.encSalt;
  let decrypted = "";
  try {
    decrypted = await decryptString(encrypted, input.masterKey, decryptSalt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /operation-specific reason|OperationError|decrypt/i.test(message)
    ) {
      throw new Error(
        "Unable to decrypt remote sync data. Ensure the Master Key matches the uploading device.",
      );
    }
    throw error;
  }
  const payload = JSON.parse(decrypted) as SyncPayload;
  if (payload.version !== 1) {
    throw new Error("Unsupported sync payload version");
  }
  const backupAt = await saveLocalBackupBeforeDownload(
    envelope.updatedAt ?? "",
    input.masterKey,
    input.encSalt,
  );
  await applySyncPayload(payload);
  return {
    backupAt,
    updatedAt: envelope.updatedAt ?? "",
    payload,
  };
};
