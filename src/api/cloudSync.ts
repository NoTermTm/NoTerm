import { load } from "@tauri-apps/plugin-store";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { decryptString, encryptString, isEncryptedPayload } from "../utils/security";
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
  payload: unknown;
};

type StorageProvider = {
  readText(key: string): Promise<string | null>;
  writeText(key: string, value: string): Promise<void>;
  deleteKey(key: string): Promise<void>;
  testConnection(): Promise<void>;
};

const REMOTE_KEY = "noterm.sync.v1.json";

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
      if (resp.status === 404 || resp.status === 403) return null;
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

const buildSyncPayload = async (): Promise<SyncPayload> => {
  const connectionStore = await load("connections.json");
  const keysStore = await load("keys.json");
  const scriptsStore = await load("scripts.json");
  const forwardingStore = await load("forwardings.json");
  const aiModelsStore = await load("ai-models.json");

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
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
  const payload = await buildSyncPayload();
  const encrypted = await encryptString(
    JSON.stringify(payload),
    input.masterKey,
    input.encSalt,
  );
  const envelope: SyncEnvelope = {
    version: 1,
    updatedAt: new Date().toISOString(),
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
  const provider = buildProvider(input.config);
  const text = await provider.readText(REMOTE_KEY);
  if (!text) {
    throw new Error("No remote sync data found");
  }
  const envelope = JSON.parse(text) as { payload?: unknown; updatedAt?: string };
  const encrypted = ensureDecryptablePayload(envelope.payload);
  const decrypted = await decryptString(encrypted, input.masterKey, input.encSalt);
  const payload = JSON.parse(decrypted) as SyncPayload;
  if (payload.version !== 1) {
    throw new Error("Unsupported sync payload version");
  }
  await applySyncPayload(payload);
  return {
    updatedAt: envelope.updatedAt ?? "",
    payload,
  };
};
