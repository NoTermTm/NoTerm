import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { AppIcon } from "../components/AppIcon";
import { Select } from "../components/Select";
import { sshApi } from "../api/ssh";
import { rdpApi } from "../api/rdp";
import type {
  ConnectionConfig,
  RdpConnectionConfig,
  SshConnectionConfig,
} from "../types/connection";
import { load } from "@tauri-apps/plugin-store";
import { useNavigate } from "react-router-dom";
import { XTerminal } from "../components/XTerminal";
import { SlidePanel } from "../components/SlidePanel";
import { Modal } from "../components/Modal";
import { Tab } from "../components/TitleBar";
import type { AuthProfile } from "../types/auth";
import { readAppSetting, writeAppSetting } from "../store/appSettings";
import {
  decryptString,
  encryptString,
  generateSalt,
  isEncryptedPayload,
  type EncryptedPayload,
} from "../utils/security";
import { getMasterKeySession } from "../utils/securitySession";
import { useI18n } from "../i18n";
import "./Connections.css";

const ENCODING_OPTIONS = [
  { value: "utf-8", label: "UTF-8" },
  { value: "gbk", label: "GBK" },
  { value: "gb2312", label: "GB2312" },
  { value: "big5", label: "Big5" },
  { value: "shift_jis", label: "Shift_JIS" },
  { value: "euc-kr", label: "EUC-KR" },
];

const RDP_COLOR_DEPTHS: Array<RdpConnectionConfig["colorDepth"]> = [16, 24, 32];
const DEFAULT_CONNECTION_COLOR = "#ffb347";
const CONNECTION_COLOR_OPTIONS = [
  "#ffb347",
  "#ff8a4c",
  "#ffd166",
  "#5ec8ff",
  "#7f8cff",
  "#6adba2",
  "#f38ba8",
  "#b58cff",
];

type OsType = "windows" | "macos" | "linux" | "unknown";

const normalizeTags = (tags?: string[]) =>
  Array.from(
    new Set(
      (tags ?? [])
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 8),
    ),
  );

const normalizeColor = (color?: string) =>
  color && color.trim() ? color.trim() : DEFAULT_CONNECTION_COLOR;

const normalizeOsType = (value?: string): OsType | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "windows" ||
    normalized === "macos" ||
    normalized === "linux" ||
    normalized === "unknown"
  ) {
    return normalized as OsType;
  }
  return undefined;
};

const SETTINGS_TAB_ID = "__settings__";

const parseColorToRgb = (color: string): [number, number, number] | null => {
  const normalized = color.trim();
  const shortHex = normalized.match(/^#([0-9a-fA-F]{3})$/);
  if (shortHex) {
    const chars = shortHex[1];
    return [
      parseInt(chars[0] + chars[0], 16),
      parseInt(chars[1] + chars[1], 16),
      parseInt(chars[2] + chars[2], 16),
    ];
  }
  const longHex = normalized.match(/^#([0-9a-fA-F]{6})$/);
  if (longHex) {
    const hex = longHex[1];
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  const rgb = normalized.match(
    /^rgb\(\s*([01]?\d?\d|2[0-4]\d|25[0-5])\s*,\s*([01]?\d?\d|2[0-4]\d|25[0-5])\s*,\s*([01]?\d?\d|2[0-4]\d|25[0-5])\s*\)$/,
  );
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return null;
};

const inferOsTypeFromText = (value: string): OsType | null => {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (
    text.includes("darwin") ||
    text.includes("macos") ||
    text.includes("mac os") ||
    text.includes("os x")
  ) {
    return "macos";
  }
  if (text.includes("linux")) return "linux";
  if (
    text.includes("windows") ||
    text.includes("mingw") ||
    text.includes("msys") ||
    text.includes("cygwin") ||
    text.includes("win32")
  ) {
    return "windows";
  }
  return null;
};

const detectRemoteOsType = async (sessionId: string): Promise<OsType> => {
  const uname = await sshApi
    .executeCommand(sessionId, "uname -s")
    .catch(() => "");
  const unameType = inferOsTypeFromText(uname);
  if (unameType) return unameType;

  const swVers = await sshApi
    .executeCommand(sessionId, "sw_vers -productName")
    .catch(() => "");
  const swType = inferOsTypeFromText(swVers);
  if (swType) return swType;

  const winVer = await sshApi
    .executeCommand(sessionId, "cmd.exe /c ver")
    .catch(() => "");
  const winType = inferOsTypeFromText(winVer);
  if (winType) return winType;

  const psOs = await sshApi
    .executeCommand(sessionId, 'powershell -NoProfile -Command "$env:OS"')
    .catch(() => "");
  const psType = inferOsTypeFromText(psOs);
  if (psType) return psType;

  return "unknown";
};

const getConnectionIcon = (conn: ConnectionConfig): string => {
  if (conn.kind === "rdp") {
    return "material-symbols:desktop-windows-rounded";
  }
  // 对于 SSH 连接，如果明确了系统类型，则展示对应的图标；如果系统类型未知，则展示通用的终端图标
  if (conn.osType === "windows") {
    return "simple-icons:windows";
  }
  if (conn.osType === "macos") {
    return "simple-icons:macos";
  }
  // 默认展示为 Linux 图标，因为很多时候无法准确识别系统，且 Linux 占比较大
  if (conn.osType === "linux") {
    return "simple-icons:linux";
  }
  return "material-symbols:dns";
};


const getTagStyle = (color: string) => {
  const rgb = parseColorToRgb(color);
  if (!rgb) return undefined;
  const [r, g, b] = rgb;
  return {
    background: `rgba(${r}, ${g}, ${b}, 0.16)`,
    borderColor: `rgba(${r}, ${g}, ${b}, 0.42)`,
    color: `rgb(${r}, ${g}, ${b})`,
  } as CSSProperties;
};

const createDefaultSshConnection = (name: string): SshConnectionConfig => ({
  kind: "ssh",
  id: crypto.randomUUID(),
  name,
  tags: [],
  color: DEFAULT_CONNECTION_COLOR,
  host: "",
  port: 22,
  username: "",
  auth_type: { type: "Password", password: "" },
  encoding: "utf-8",
});

const createDefaultRdpConnection = (name: string): RdpConnectionConfig => ({
  kind: "rdp",
  id: crypto.randomUUID(),
  name,
  tags: [],
  color: DEFAULT_CONNECTION_COLOR,
  host: "",
  port: 3389,
  username: "",
  password: "",
  gatewayHost: "",
  gatewayUsername: "",
  gatewayPassword: "",
  gatewayDomain: "",
  resolutionWidth: undefined,
  resolutionHeight: undefined,
  colorDepth: 32,
  certPolicy: "default",
  redirectClipboard: true,
  redirectAudio: false,
  redirectDrives: false,
});

const normalizeSshConnection = (
  conn: Partial<SshConnectionConfig>,
  fallbackName: string,
): SshConnectionConfig => ({
  kind: "ssh",
  id: conn.id ?? crypto.randomUUID(),
  name: conn.name ?? fallbackName,
  tags: normalizeTags(conn.tags),
  color: normalizeColor(conn.color),
  host: conn.host ?? "",
  port: Number.isFinite(conn.port as number) ? (conn.port as number) : 22,
  username: conn.username ?? "",
  auth_type: conn.auth_type ?? { type: "Password", password: "" },
  auth_profile_id: conn.auth_profile_id,
  encoding: conn.encoding ?? "utf-8",
  osType: normalizeOsType(conn.osType),
});

const normalizeRdpConnection = (
  conn: Partial<RdpConnectionConfig>,
  fallbackName: string,
): RdpConnectionConfig => ({
  kind: "rdp",
  id: conn.id ?? crypto.randomUUID(),
  name: conn.name ?? fallbackName,
  tags: normalizeTags(conn.tags),
  color: normalizeColor(conn.color),
  host: conn.host ?? "",
  port: Number.isFinite(conn.port as number) ? (conn.port as number) : 3389,
  username: conn.username ?? "",
  password: conn.password ?? "",
  gatewayHost: conn.gatewayHost ?? "",
  gatewayUsername: conn.gatewayUsername ?? "",
  gatewayPassword: conn.gatewayPassword ?? "",
  gatewayDomain: conn.gatewayDomain ?? "",
  resolutionWidth: conn.resolutionWidth,
  resolutionHeight: conn.resolutionHeight,
  colorDepth: conn.colorDepth ?? 32,
  certPolicy: conn.certPolicy ?? "default",
  redirectClipboard: conn.redirectClipboard ?? true,
  redirectAudio: conn.redirectAudio ?? false,
  redirectDrives: conn.redirectDrives ?? false,
});

const normalizeConnection = (
  conn: any,
  fallbackSshName: string,
  fallbackRdpName: string,
): ConnectionConfig => {
  if (conn?.kind === "rdp") return normalizeRdpConnection(conn, fallbackRdpName);
  return normalizeSshConnection(conn, fallbackSshName);
};

const isSshConnection = (
  conn: ConnectionConfig | null | undefined,
): conn is SshConnectionConfig => !!conn && conn.kind !== "rdp";

// 验证 PEM 私钥格式
function validatePemKey(
  content: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): { valid: boolean; message: string } {
  if (!content || !content.trim()) {
    return { valid: false, message: t("connections.pem.empty") };
  }

  const trimmed = content.trim();

  const hasBegin = /-----BEGIN\s+[A-Z\s]+PRIVATE KEY-----/.test(trimmed);
  const hasEnd = /-----END\s+[A-Z\s]+PRIVATE KEY-----/.test(trimmed);

  if (!hasBegin || !hasEnd) {
    return {
      valid: false,
      message: t("connections.pem.missingMarkers"),
    };
  }

  const beginMatch = trimmed.match(/-----BEGIN\s+([A-Z\s]+PRIVATE KEY)-----/);
  const endMatch = trimmed.match(/-----END\s+([A-Z\s]+PRIVATE KEY)-----/);

  if (beginMatch && endMatch && beginMatch[1] !== endMatch[1]) {
    return {
      valid: false,
      message: t("connections.pem.mismatchMarkers"),
    };
  }

  const lines = trimmed.split("\n");
  const contentLines = lines.filter(
    (line) =>
      !line.includes("-----BEGIN") &&
      !line.includes("-----END") &&
      line.trim() !== "",
  );

  if (contentLines.length === 0) {
    return {
      valid: false,
      message: t("connections.pem.noContent"),
    };
  }

  const supportedFormats = [
    "RSA PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "EC PRIVATE KEY",
    "DSA PRIVATE KEY",
    "PRIVATE KEY",
  ];

  const keyType = beginMatch ? beginMatch[1] : "";
  const isSupported = supportedFormats.some((format) =>
    keyType.includes(format),
  );

  if (!isSupported) {
    return {
      valid: false,
      message: t("connections.pem.unsupported", { type: keyType }),
    };
  }

  return { valid: true, message: t("connections.pem.valid") };
}

let store: Awaited<ReturnType<typeof load>> | null = null;
let keyStore: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!store) {
    store = await load("connections.json");
  }
  return store;
}

async function getKeyStore() {
  if (!keyStore) {
    keyStore = await load("keys.json");
  }
  return keyStore;
}

type SecurityContext = {
  masterKey: string | null;
  encSalt: string;
  savePassword: boolean;
};

async function getSecurityContext(): Promise<SecurityContext> {
  const masterKey = getMasterKeySession();
  let encSalt = await readAppSetting("security.masterKeyEncSalt");
  const savePassword = await readAppSetting("connection.savePassword");
  const hasMasterKey = Boolean(await readAppSetting("security.masterKeyHash"));
  if (savePassword && hasMasterKey && masterKey && !encSalt) {
    encSalt = generateSalt();
    await writeAppSetting("security.masterKeyEncSalt", encSalt);
  }
  return {
    masterKey: masterKey && encSalt ? masterKey : null,
    encSalt,
    savePassword,
  };
}

const decryptMaybe = async (
  value: unknown,
  ctx: SecurityContext,
): Promise<string> => {
  if (!value) return "";
  if (isEncryptedPayload(value)) {
    if (!ctx.masterKey) return "";
    try {
      return await decryptString(value, ctx.masterKey, ctx.encSalt);
    } catch {
      return "";
    }
  }
  if (typeof value === "string") return value;
  return "";
};

const encryptMaybe = async (
  value: string | undefined,
  ctx: SecurityContext,
): Promise<string | EncryptedPayload> => {
  if (!value?.trim()) return "";
  if (!ctx.masterKey || !ctx.savePassword) return "";
  return encryptString(value, ctx.masterKey, ctx.encSalt);
};

const deserializeConnection = async (
  conn: any,
  ctx: SecurityContext,
  fallbackNames: { ssh: string; rdp: string },
) => {
  if (conn?.kind === "rdp") {
    const rdp = { ...conn };
    rdp.password = await decryptMaybe(rdp.password, ctx);
    rdp.gatewayPassword = await decryptMaybe(rdp.gatewayPassword, ctx);
    return normalizeConnection(rdp, fallbackNames.ssh, fallbackNames.rdp);
  }
  const ssh = { ...conn };
  if (ssh.auth_type?.type === "Password") {
    ssh.auth_type = {
      ...ssh.auth_type,
      password: await decryptMaybe(ssh.auth_type.password, ctx),
    };
  }
  if (ssh.auth_type?.type === "PrivateKey") {
    ssh.auth_type = {
      ...ssh.auth_type,
      key_content: await decryptMaybe(ssh.auth_type.key_content, ctx),
      passphrase: await decryptMaybe(ssh.auth_type.passphrase, ctx),
    };
  }
  return normalizeConnection(ssh, fallbackNames.ssh, fallbackNames.rdp);
};

const serializeConnection = async (conn: ConnectionConfig, ctx: SecurityContext) => {
  if (conn.kind === "rdp") {
    return {
      ...conn,
      password: await encryptMaybe(conn.password, ctx),
      gatewayPassword: await encryptMaybe(conn.gatewayPassword, ctx),
    };
  }
  if (conn.auth_type.type === "Password") {
    return {
      ...conn,
      auth_type: {
        ...conn.auth_type,
        password: await encryptMaybe(conn.auth_type.password, ctx),
      },
    };
  }
  if (conn.auth_type.type === "PrivateKey") {
    return {
      ...conn,
      auth_type: {
        ...conn.auth_type,
        key_content: await encryptMaybe(conn.auth_type.key_content, ctx),
        passphrase: await encryptMaybe(conn.auth_type.passphrase, ctx),
      },
    };
  }
  return conn;
};

const mergeStoredConnectionSecrets = (
  conn: ConnectionConfig,
  stored: ConnectionConfig | undefined,
) => {
  if (!stored) return conn;
  if (conn.kind === "rdp") {
    if (stored.kind !== "rdp") return conn;
    return {
      ...conn,
      password: stored.password ?? "",
      gatewayPassword: stored.gatewayPassword ?? "",
    };
  }
  if (stored.kind === "rdp") return conn;
  if (conn.auth_type.type === "Password") {
    if (stored.auth_type?.type !== "Password") return conn;
    return {
      ...conn,
      auth_type: {
        ...conn.auth_type,
        password: stored.auth_type.password ?? "",
      },
    };
  }
  if (conn.auth_type.type === "PrivateKey") {
    if (stored.auth_type?.type !== "PrivateKey") return conn;
    return {
      ...conn,
      auth_type: {
        ...conn.auth_type,
        key_content: stored.auth_type.key_content ?? "",
        passphrase: stored.auth_type.passphrase ?? "",
      },
    };
  }
  return conn;
};

const deserializeProfile = async (profile: AuthProfile, ctx: SecurityContext) => {
  if (profile.auth_type.type === "Password") {
    return {
      ...profile,
      auth_type: {
        ...profile.auth_type,
        password: await decryptMaybe(profile.auth_type.password, ctx),
      },
    };
  }
  if (profile.auth_type.type === "PrivateKey") {
    return {
      ...profile,
      auth_type: {
        ...profile.auth_type,
        key_content: await decryptMaybe(profile.auth_type.key_content, ctx),
        passphrase: await decryptMaybe(profile.auth_type.passphrase, ctx),
      },
    };
  }
  return profile;
};

const serializeProfile = async (profile: AuthProfile, ctx: SecurityContext) => {
  if (profile.auth_type.type === "Password") {
    return {
      ...profile,
      auth_type: {
        ...profile.auth_type,
        password: await encryptMaybe(profile.auth_type.password, ctx),
      },
    };
  }
  if (profile.auth_type.type === "PrivateKey") {
    return {
      ...profile,
      auth_type: {
        ...profile.auth_type,
        key_content: await encryptMaybe(profile.auth_type.key_content, ctx),
        passphrase: await encryptMaybe(profile.auth_type.passphrase, ctx),
      },
    };
  }
  return profile;
};

const mergeStoredProfileSecrets = (
  profile: AuthProfile,
  stored: AuthProfile | undefined,
) => {
  if (!stored) return profile;
  if (profile.auth_type.type === "Password") {
    if (stored.auth_type?.type !== "Password") return profile;
    return {
      ...profile,
      auth_type: {
        ...profile.auth_type,
        password: stored.auth_type.password ?? "",
      },
    };
  }
  if (profile.auth_type.type === "PrivateKey") {
    if (stored.auth_type?.type !== "PrivateKey") return profile;
    return {
      ...profile,
      auth_type: {
        ...profile.auth_type,
        key_content: stored.auth_type.key_content ?? "",
        passphrase: stored.auth_type.passphrase ?? "",
      },
    };
  }
  return profile;
};

const cloneAuthType = (authType: AuthProfile["auth_type"]): AuthProfile["auth_type"] => {
  if (authType.type === "Password") {
    return {
      type: "Password",
      password: authType.password,
    };
  }
  return {
    type: "PrivateKey",
    key_path: authType.key_path,
    key_content: authType.key_content,
    passphrase: authType.passphrase,
  };
};

const authTypeEquals = (
  left: AuthProfile["auth_type"],
  right: AuthProfile["auth_type"],
) => {
  if (left.type !== right.type) return false;
  if (left.type === "Password" && right.type === "Password") {
    return left.password === right.password;
  }
  if (left.type === "PrivateKey" && right.type === "PrivateKey") {
    return (
      left.key_path === right.key_path &&
      left.key_content === right.key_content &&
      left.passphrase === right.passphrase
    );
  }
  return false;
};

interface ConnectionsPageProps {
  activePanel: string | null;
  setActivePanel: (panel: string | null) => void;
  tabs: Tab[];
  setTabs: (tabs: Tab[] | ((prev: Tab[]) => Tab[])) => void;
  activeTabId: string | null;
  setActiveTabId: (id: string | null) => void;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
  onNewTab: () => void;
}

interface ActiveSession {
  sessionId: string;
  connectionId: string;
  connection: SshConnectionConfig;
  kind: "ssh" | "local";
}

interface SplitLayout {
  direction: "vertical" | "horizontal";
  secondarySessionId: string;
}

export function ConnectionsPage({
  activePanel,
  setActivePanel,
  tabs,
  setTabs,
  activeTabId,
  setActiveTabId,
}: ConnectionsPageProps) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const fallbackNames = {
    ssh: t("connections.defaultName"),
    rdp: t("connections.rdpDefaultName"),
  };
  const localSessionIdRef = useRef<string | null>(null);
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [selectedConnection, setSelectedConnection] =
    useState<ConnectionConfig | null>(null);
  const [editingConnection, setEditingConnection] =
    useState<ConnectionConfig | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]);
  const [authProfileId, setAuthProfileId] = useState<string>("");
  const [activeSessions, setActiveSessions] = useState<
    Map<string, ActiveSession>
  >(new Map());
  const [searchQuery, setSearchQuery] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [pkMode, setPkMode] = useState<"path" | "manual">("path");
  const [pemValidation, setPemValidation] = useState<{
    valid: boolean;
    message: string;
  } | null>(null);
  const [splitLayouts, setSplitLayouts] = useState<Map<string, SplitLayout>>(
    new Map(),
  );
  const [splitPickerOpen, setSplitPickerOpen] = useState(false);
  const [splitPickerDirection, setSplitPickerDirection] =
    useState<SplitLayout["direction"]>("vertical");
  const [splitPickerBaseSessionId, setSplitPickerBaseSessionId] = useState<
    string | null
  >(null);
  const [connectPickerOpen, setConnectPickerOpen] = useState(false);
  const [connectPickerQuery, setConnectPickerQuery] = useState("");
  const connectPickerInputRef = useRef<HTMLInputElement | null>(null);
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false);
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [colorFilter, setColorFilter] = useState<string>("all");
  const [actionMenu, setActionMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [showMasterKeyPrompt, setShowMasterKeyPrompt] = useState(false);

  useEffect(() => {
    void (async () => {
      await loadConnections();
      const nextProfiles = await loadAuthProfiles();
      await syncConnectionsByProfiles(nextProfiles);
    })();
  }, []);

  useEffect(() => {
    const refresh = () => {
      void (async () => {
        await loadConnections();
        const nextProfiles = await loadAuthProfiles();
        await syncConnectionsByProfiles(nextProfiles);
      })();
    };
    window.addEventListener("master-key-updated", refresh);
    return () => {
      window.removeEventListener("master-key-updated", refresh);
    };
  }, []);

  useEffect(() => {
    const onAuthProfilesUpdated = () => {
      void (async () => {
        const nextProfiles = await loadAuthProfiles();
        await syncConnectionsByProfiles(nextProfiles);
      })();
    };
    window.addEventListener("auth-profiles-updated", onAuthProfilesUpdated);
    return () => {
      window.removeEventListener("auth-profiles-updated", onAuthProfilesUpdated);
    };
  }, [connections]);

  useEffect(() => {
    if (!editingConnection) return;
    setTestStatus("idle");
    setTestMessage(null);
  }, [editingConnection]);

  useEffect(() => {
    const onOpen = () => setConnectPickerOpen(true);
    window.addEventListener("open-connection-picker", onOpen);
    return () => {
      window.removeEventListener("open-connection-picker", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!connectPickerOpen) return;
    setConnectPickerQuery("");
    requestAnimationFrame(() => connectPickerInputRef.current?.focus());
  }, [connectPickerOpen]);

  useEffect(() => {
    if (!actionMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".connection-menu, .connection-menu-btn")) return;
      setActionMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActionMenu(null);
      }
    };
    const onScroll = () => setActionMenu(null);
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [actionMenu]);

  useEffect(() => {
    const onOpenSplit = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          sessionId?: string;
          direction?: SplitLayout["direction"];
        }>
      ).detail;
      if (!detail?.sessionId) return;
      if (!activeSessions.has(detail.sessionId)) return;
      setSplitPickerBaseSessionId(detail.sessionId);
      setSplitPickerDirection(detail.direction ?? "vertical");
      setSplitPickerOpen(true);
    };

    window.addEventListener("open-split-picker", onOpenSplit);
    return () => {
      window.removeEventListener("open-split-picker", onOpenSplit);
    };
  }, [activeSessions]);

  const loadConnections = async () => {
    const s = await getStore();
    const saved = await s.get<ConnectionConfig[]>("connections");
    if (saved) {
      const ctx = await getSecurityContext();
      const normalized = await Promise.all(
        saved.map((conn) => deserializeConnection(conn, ctx, fallbackNames)),
      );
      setConnections(normalized);
    }
  };

  const loadAuthProfiles = async () => {
    const s = await getKeyStore();
    const saved = await s.get<AuthProfile[]>("profiles");
    if (!saved) return [] as AuthProfile[];
    const ctx = await getSecurityContext();
    const next = await Promise.all(saved.map((p) => deserializeProfile(p, ctx)));
    setAuthProfiles(next);
    return next;
  };

  const saveConnections = async (conns: ConnectionConfig[]) => {
    const s = await getStore();
    const ctx = await getSecurityContext();
    const stored = await s.get<ConnectionConfig[]>("connections");
    const storedMap = new Map((stored ?? []).map((conn) => [conn.id, conn]));
    const persisted = await Promise.all(
      conns.map((conn) => {
        if (!ctx.masterKey && ctx.savePassword) {
          const merged = mergeStoredConnectionSecrets(
            conn,
            storedMap.get(conn.id),
          );
          return merged;
        }
        return serializeConnection(conn, ctx);
      }),
    );
    await s.set("connections", persisted);
    await s.save();
    setConnections(conns);
  };

  const updateConnectionOsType = async (
    connectionId: string,
    osType: OsType,
  ) => {
    if (osType === "unknown") return;
    let changed = false;
    const nextConnections = connections.map((conn) => {
      if (conn.kind !== "ssh" || conn.id !== connectionId) return conn;
      if (conn.osType === osType) return conn;
      changed = true;
      return { ...conn, osType };
    });
    if (!changed) return;
    await saveConnections(nextConnections);
    setSelectedConnection((prev) =>
      prev?.id === connectionId ? { ...prev, osType } : prev,
    );
    setActiveSessions((prev) => {
      let updated = false;
      const next = new Map(prev);
      for (const [sessionId, session] of next.entries()) {
        if (session.connectionId !== connectionId) continue;
        if (session.connection.osType === osType) continue;
        updated = true;
        next.set(sessionId, {
          ...session,
          connection: {
            ...session.connection,
            osType,
          },
        });
      }
      return updated ? next : prev;
    });
  };

  const saveAuthProfiles = async (next: AuthProfile[]) => {
    const s = await getKeyStore();
    const ctx = await getSecurityContext();
    const stored = await s.get<AuthProfile[]>("profiles");
    const storedMap = new Map((stored ?? []).map((profile) => [profile.id, profile]));
    const persisted = await Promise.all(
      next.map((profile) => {
        if (!ctx.masterKey && ctx.savePassword) {
          const merged = mergeStoredProfileSecrets(
            profile,
            storedMap.get(profile.id),
          );
          return merged;
        }
        return serializeProfile(profile, ctx);
      }),
    );
    await s.set("profiles", persisted);
    await s.save();
    setAuthProfiles(next);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("auth-profiles-updated"));
    }
  };

  const syncConnectionsByProfiles = async (profilesToApply: AuthProfile[]) => {
    if (profilesToApply.length === 0) return;
    const profileMap = new Map(profilesToApply.map((profile) => [profile.id, profile]));
    let changed = false;
    const nextConnections = connections.map((conn) => {
      if (!isSshConnection(conn) || !conn.auth_profile_id) return conn;
      const profile = profileMap.get(conn.auth_profile_id);
      if (!profile) return conn;
      const nextAuthType = cloneAuthType(profile.auth_type);
      const needUpdate =
        conn.username !== profile.username ||
        !authTypeEquals(conn.auth_type, nextAuthType);
      if (!needUpdate) return conn;
      changed = true;
      return {
        ...conn,
        username: profile.username,
        auth_type: nextAuthType,
      };
    });
    if (!changed) return;
    await saveConnections(nextConnections);
  };

  const handleAddConnection = async () => {
    const masterKeyHash = await readAppSetting("security.masterKeyHash");
    if (!masterKeyHash) {
      setShowMasterKeyPrompt(true);
      return;
    }
    const newConnection = createDefaultSshConnection(fallbackNames.ssh);
    setEditingConnection(newConnection);
    setAuthProfileId("");
    setPkMode("path"); // 重置为默认模式
    setShowAdvancedConfig(false);
    setIsEditModalOpen(true);
  };

  const handlePanelClose = () => {
    setActivePanel(null);
  };

  const openSettingsTab = () => {
    setIsEditModalOpen(false);
    setEditingConnection(null);
    setAuthProfileId("");
    setShowAdvancedConfig(false);
    setTabs((prev) => {
      if (prev.some((tab) => tab.id === SETTINGS_TAB_ID)) return prev;
      return [
        ...prev,
        {
          id: SETTINGS_TAB_ID,
          title: t("tab.settings.title"),
          subtitle: t("tab.settings.subtitle"),
        },
      ];
    });
    setActiveTabId(SETTINGS_TAB_ID);
    setActivePanel(null);
    navigate("/settings");
  };

  const handleSaveConnection = async () => {
    if (!editingConnection) return;
    const isExisting = connections.some((c) => c.id === editingConnection.id);
    if (!isExisting) {
      const masterKeyHash = await readAppSetting("security.masterKeyHash");
      if (!masterKeyHash) {
        setShowMasterKeyPrompt(true);
        return;
      }
    }

    const normalizedEditing = normalizeConnection(
      editingConnection,
      fallbackNames.ssh,
      fallbackNames.rdp,
    );

    const existingIndex = connections.findIndex(
      (c) => c.id === normalizedEditing.id,
    );
    let updatedConnections: ConnectionConfig[];

    if (existingIndex >= 0) {
      updatedConnections = [...connections];
      updatedConnections[existingIndex] = normalizedEditing;
    } else {
      updatedConnections = [...connections, normalizedEditing];
    }

    await saveConnections(updatedConnections);
    setSelectedConnection(normalizedEditing);
    setEditingConnection(null);
    setShowAdvancedConfig(false);
    setIsEditModalOpen(false);
  };

  const activeAuthProfile = useMemo(() => {
    if (!authProfileId) return null;
    return authProfiles.find((p) => p.id === authProfileId) ?? null;
  }, [authProfiles, authProfileId]);

  useEffect(() => {
    if (!isSshConnection(editingConnection)) return;
    if (!activeAuthProfile) return;
    setEditingConnection((prev) => {
      if (!prev) return prev;
      if (!isSshConnection(prev)) return prev;
      return {
        ...prev,
        username: activeAuthProfile.username,
        auth_type: cloneAuthType(activeAuthProfile.auth_type),
        auth_profile_id: activeAuthProfile.id,
      };
    });

    // 根据 auth_type 设置正确的 pkMode
    if (activeAuthProfile.auth_type.type === "PrivateKey") {
      if (activeAuthProfile.auth_type.key_content) {
        setPkMode("manual");
      } else {
        setPkMode("path");
      }
    }
    // Intentionally only re-apply when selecting a different profile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAuthProfile?.id]);

  useEffect(() => {
    if (authProfileId) return;
    if (!isSshConnection(editingConnection)) return;
    setEditingConnection((prev) => {
      if (!prev || !isSshConnection(prev)) return prev;
      if (!prev.auth_profile_id) return prev;
      return {
        ...prev,
        auth_profile_id: undefined,
      };
    });
  }, [authProfileId, editingConnection]);

  const canSaveAuthProfileFromEditing = useMemo(() => {
    if (!isSshConnection(editingConnection)) return false;
    if (!editingConnection.username.trim()) return false;
    if (editingConnection.auth_type.type === "Password") {
      return !!editingConnection.auth_type.password;
    }
    // 私钥模式：需要有 key_path 或 key_content
    return (
      !!editingConnection.auth_type.key_path ||
      !!editingConnection.auth_type.key_content
    );
  }, [editingConnection]);

  const saveEditingAuthToProfiles = async () => {
    if (!isSshConnection(editingConnection)) return;
    if (!canSaveAuthProfileFromEditing) return;

    const nextProfile: AuthProfile = {
      id: crypto.randomUUID(),
      name:
        editingConnection.auth_type.type === "Password"
          ? t("connections.authProfile.passwordName", {
              username: editingConnection.username,
            })
          : t("connections.authProfile.keyName", {
              username: editingConnection.username,
            }),
      username: editingConnection.username,
      auth_type: editingConnection.auth_type,
    };

    const next = [...authProfiles, nextProfile];
    await saveAuthProfiles(next);
    setAuthProfileId(nextProfile.id);
  };

  const handleDeleteConnection = async (id: string) => {
    // 断开所有使用此连接配置的会话
    const sessionsToDisconnect = Array.from(activeSessions.entries())
      .filter(([_, session]) => session.connectionId === id)
      .map(([sessionId]) => sessionId);

    for (const sessionId of sessionsToDisconnect) {
      await handleDisconnect(sessionId);
    }

    const updatedConnections = connections.filter((c) => c.id !== id);
    await saveConnections(updatedConnections);
    if (selectedConnection?.id === id) {
      setSelectedConnection(null);
    }
  };

  const createSession = (
    connection: SshConnectionConfig,
    withTab: boolean,
    activateTab: boolean,
    kind: "ssh" | "local" = "ssh",
  ) => {
    const sessionId = crypto.randomUUID();
    const sessionCount =
      Array.from(activeSessions.values()).filter(
        (s) => s.connectionId === connection.id,
      ).length + 1;

    if (withTab) {
      const tabTitle =
        sessionCount > 1
          ? `${connection.name} (${sessionCount})`
          : connection.name;
      const newTab: Tab = {
        id: sessionId,
        title: tabTitle,
        subtitle: `${connection.username ? `${connection.username}@` : ""}${connection.host}`,
        color: kind === "ssh" ? normalizeColor(connection.color) : undefined,
      };
      setTabs((prev) => [...prev, newTab]);
      if (activateTab) setActiveTabId(sessionId);
    }

    setActiveSessions((prev) => {
      const next = new Map(prev);
      next.set(sessionId, {
        sessionId,
        connectionId: connection.id,
        connection,
        kind,
      });
      return next;
    });

    setSelectedConnection(connection);
    return sessionId;
  };

  const handleConnect = async (connection: ConnectionConfig) => {
    if (connection.kind === "rdp") {
      await rdpApi.open(connection);
      return;
    }
    createSession(connection, true, true);
  };

  useEffect(() => {
    if (localSessionIdRef.current) return;
    const localConnection: SshConnectionConfig = {
      kind: "ssh",
      id: "local",
      name: t("connections.localTerminal"),
      host: "local",
      port: 0,
      username: "local",
      auth_type: { type: "Password", password: "" },
      encoding: "utf-8",
    };
    const sessionId = createSession(localConnection, true, true, "local");
    localSessionIdRef.current = sessionId;
  }, []);

  const openSplitPicker = (
    baseSessionId: string,
    direction: SplitLayout["direction"],
  ) => {
    setSplitPickerBaseSessionId(baseSessionId);
    setSplitPickerDirection(direction);
    setSplitPickerOpen(true);
  };

  const handleCreateSplit = async (connection: SshConnectionConfig) => {
    if (!splitPickerBaseSessionId) return;

    const existing = splitLayouts.get(splitPickerBaseSessionId);
    if (existing) {
      await handleDisconnect(existing.secondarySessionId);
      setSplitLayouts((prev) => {
        const next = new Map(prev);
        next.delete(splitPickerBaseSessionId);
        return next;
      });
    }

    const secondarySessionId = createSession(connection, false, false);
    setSplitLayouts((prev) => {
      const next = new Map(prev);
      next.set(splitPickerBaseSessionId, {
        direction: splitPickerDirection,
        secondarySessionId,
      });
      return next;
    });
    setSplitPickerOpen(false);
    setSplitPickerBaseSessionId(null);
  };

  const disconnectSession = async (targetSessionId: string) => {
    const session = activeSessions.get(targetSessionId);
    if (session?.kind === "local") {
      await sshApi.localDisconnect(targetSessionId);
      return;
    }
    await sshApi.disconnect(targetSessionId);
  };

  const handleDisconnect = async (sessionId: string) => {
    try {
      const splitForPrimary = splitLayouts.get(sessionId);
      const splitForSecondary = Array.from(splitLayouts.entries()).find(
        ([, layout]) => layout.secondarySessionId === sessionId,
      );

      if (splitForPrimary) {
        await disconnectSession(splitForPrimary.secondarySessionId);
      }

      await disconnectSession(sessionId);

      setActiveSessions((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        if (splitForPrimary) {
          next.delete(splitForPrimary.secondarySessionId);
        }
        return next;
      });

      if (splitForPrimary || splitForSecondary) {
        setSplitLayouts((prev) => {
          const next = new Map(prev);
          if (splitForPrimary) next.delete(sessionId);
          if (splitForSecondary) next.delete(splitForSecondary[0]);
          return next;
        });
      }

      // 移除标签页
      setTabs((prev) => prev.filter((tab) => tab.id !== sessionId));
      if (activeTabId === sessionId) {
        setActiveTabId(null);
        setSelectedConnection(null);
      }
    } catch (error) {
      console.error("Disconnect error:", error);
    }
  };

  const handleTestConnection = async () => {
    if (!isSshConnection(editingConnection)) return;

    const trimmedHost = editingConnection.host.trim();
    const trimmedUser = editingConnection.username.trim();
    const isPrivateKeyAuth = editingConnection.auth_type.type === "PrivateKey";
    const port = Number.isFinite(editingConnection.port)
      ? editingConnection.port
      : 22;

    if (!trimmedHost) {
      setTestStatus("error");
      setTestMessage(t("connections.test.requireHost"));
      return;
    }

    if (!trimmedUser && !isPrivateKeyAuth) {
      setTestStatus("error");
      setTestMessage(t("connections.test.requireUsername"));
      return;
    }

    if (editingConnection.auth_type.type === "Password") {
      const password = (editingConnection.auth_type as any).password?.trim();
      if (!password) {
        setTestStatus("error");
        setTestMessage(t("connections.test.requirePassword"));
        return;
      }
    }

    if (editingConnection.auth_type.type === "PrivateKey") {
      const keyContent = (
        editingConnection.auth_type as any
      ).key_content?.trim();
      const keyPath = (editingConnection.auth_type as any).key_path?.trim();

      if (keyContent) {
        const validation = validatePemKey(keyContent, t);
        if (!validation.valid) {
          setTestStatus("error");
          setTestMessage(validation.message);
          return;
        }
      } else if (!keyPath) {
        setTestStatus("error");
        setTestMessage(t("connections.test.requireKey"));
        return;
      }
    }

    setTestStatus("testing");
    setTestMessage(t("connections.test.testing"));

    const testConnection: SshConnectionConfig = {
      ...editingConnection,
      id: crypto.randomUUID(),
      host: trimmedHost,
      username: trimmedUser,
      port,
    };

    try {
      const sessionId = await sshApi.connect(testConnection);
      await sshApi.disconnect(sessionId);
      setTestStatus("success");
      setTestMessage(t("connections.test.success"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTestStatus("error");
      setTestMessage(message || t("connections.test.fail"));
    }
  };

  const renderConnectionForm = () => {
    if (!editingConnection) return null;

    const isRdp = editingConnection.kind === "rdp";
    const authType = isSshConnection(editingConnection)
      ? editingConnection.auth_type.type
      : "Password";

    // 初始化 pkMode：如果有 key_content 则为 manual，否则为 path
    const currentPkMode =
      isSshConnection(editingConnection) &&
      editingConnection.auth_type.type === "PrivateKey" &&
      editingConnection.auth_type.key_content
        ? "manual"
        : pkMode;
    const tags = normalizeTags(editingConnection.tags);
    const color = normalizeColor(editingConnection.color);
    const moreConfigSummary = [
      editingConnection.name?.trim() || t("connections.unnamed"),
      tags.length > 0 ? `#${tags.join(" #")}` : t("connections.tags.none"),
      color,
    ].join(" / ");

    const handleKindChange = (nextKind: "ssh" | "rdp") => {
      setEditingConnection((prev) => {
        if (!prev) return prev;
        if (prev.kind === nextKind) return prev;
        if (nextKind === "ssh") {
          const defaults = createDefaultSshConnection(fallbackNames.ssh);
          return normalizeSshConnection(
            {
              ...defaults,
              id: prev.id,
              name: prev.name,
              tags: normalizeTags(prev.tags),
              color: normalizeColor(prev.color),
              host: prev.host,
              username: prev.username,
            },
            fallbackNames.ssh,
          );
        }
        const defaults = createDefaultRdpConnection(fallbackNames.rdp);
        return normalizeRdpConnection(
          {
            ...defaults,
            id: prev.id,
            name: prev.name,
            tags: normalizeTags(prev.tags),
            color: normalizeColor(prev.color),
            host: prev.host,
            username: prev.username,
          },
          fallbackNames.rdp,
        );
      });
      setAuthProfileId("");
      setPkMode("path");
    };

    return (
      <div className="connection-form connection-form-layout">
        <div className="connection-form-section">
          <div className="connection-form-section-title">
            {t("connections.section.basic")}
          </div>
          <div className="connection-form-grid">
            <div className="form-group">
              <label>{t("connections.field.host")}</label>
              <input
                type="text"
                value={editingConnection.host}
                onChange={(e) =>
                  setEditingConnection({
                    ...editingConnection,
                    host: e.target.value,
                  })
                }
                placeholder={t("connections.field.hostPlaceholder")}
              />
            </div>
            <div className="form-group">
              <label>{t("connections.field.protocol")}</label>
              <div className="connection-type-switch">
                <button
                  type="button"
                  className={`connection-type-switch-btn ${editingConnection.kind === "ssh" ? "active" : ""}`}
                  onClick={() => handleKindChange("ssh")}
                >
                  {t("connections.protocol.ssh")}
                </button>
                <button
                  type="button"
                  className={`connection-type-switch-btn ${editingConnection.kind === "rdp" ? "active" : ""}`}
                  onClick={() => handleKindChange("rdp")}
                >
                  {t("connections.protocol.rdp")}
                </button>
              </div>
            </div>
            <div className="form-group connection-form-grid-col-compact">
              <label>{t("connections.field.port")}</label>
              <input
                type="number"
                value={editingConnection.port}
                onChange={(e) => {
                  const nextPort = Number.parseInt(e.target.value, 10);
                  setEditingConnection({
                    ...editingConnection,
                    port: Number.isFinite(nextPort)
                      ? nextPort
                      : editingConnection.port,
                  });
                }}
              />
            </div>
          </div>
        </div>

        <div className="connection-form-section">
          <div className="connection-form-section-title">
            {t("connections.section.auth")}
          </div>
          {!isRdp && (
            <div className="form-group">
              <label>{t("connections.quickAuth.label")}</label>
              <div className="quick-auth-row">
                <Select
                  className="quick-auth-select"
                  wrapperClassName="quick-auth-select-wrapper"
                  value={authProfileId}
                  onChange={(nextValue) => setAuthProfileId(nextValue)}
                  options={[
                    { value: "", label: t("connections.quickAuth.none") },
                    ...authProfiles.map((profile) => ({
                      value: profile.id,
                      label: (
                        <>
                          {profile.name}（{profile.username} /{" "}
                          {profile.auth_type.type === "Password"
                            ? t("connections.quickAuth.password")
                            : t("connections.quickAuth.key")}
                          ）
                        </>
                      ),
                    })),
                  ]}
                />
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  onClick={() => void saveEditingAuthToProfiles()}
                  disabled={!canSaveAuthProfileFromEditing}
                  title={t("connections.quickAuth.saveTitle")}
                >
                  <AppIcon icon="material-symbols:save-rounded" size={16} />
                  {t("connections.quickAuth.save")}
                </button>
              </div>
              <div className="quick-auth-hint">
                {t("connections.quickAuth.hint")}
              </div>
            </div>
          )}

          <div className="connection-form-grid">
            <div className="form-group">
              <label>
                {!isRdp && authType === "PrivateKey"
                  ? t("connections.username.optional")
                  : t("connections.username")}
              </label>
              <input
                type="text"
                value={editingConnection.username}
                onChange={(e) =>
                  setEditingConnection({
                    ...editingConnection,
                    username: e.target.value,
                  })
                }
                placeholder={
                  !isRdp && authType === "PrivateKey"
                    ? t("connections.username.placeholderPrivateKey")
                    : isRdp
                      ? "Administrator"
                      : "root"
                }
              />
            </div>

            {isRdp && (
              <div className="form-group">
                <label>{t("connections.password")}</label>
                <div className="password-input-wrapper">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={
                      (editingConnection as RdpConnectionConfig).password || ""
                    }
                    onChange={(e) =>
                      setEditingConnection({
                        ...(editingConnection as RdpConnectionConfig),
                        password: e.target.value,
                      })
                    }
                  />
                  <button
                    type="button"
                    className="password-toggle-btn"
                    onClick={() => setShowPassword(!showPassword)}
                    title={
                      showPassword
                        ? t("connections.password.hide")
                        : t("connections.password.show")
                    }
                  >
                    <AppIcon
                      icon={
                        showPassword
                          ? "material-symbols:visibility-off-rounded"
                          : "material-symbols:visibility-rounded"
                      }
                      size={20}
                    />
                  </button>
                </div>
              </div>
            )}
          </div>

          {!isRdp && (
            <>
              <div className="form-group">
                <label>{t("connections.authType.label")}</label>
                <div className="auth-type-selector">
                  <button
                    type="button"
                    className={`auth-type-btn ${authType === "Password" ? "active" : ""}`}
                    onClick={() => {
                      setAuthProfileId("");
                      setEditingConnection({
                        ...(editingConnection as SshConnectionConfig),
                        auth_profile_id: undefined,
                        auth_type: { type: "Password", password: "" },
                      });
                    }}
                  >
                    {t("connections.authType.password")}
                  </button>
                  <button
                    type="button"
                    className={`auth-type-btn ${authType === "PrivateKey" ? "active" : ""}`}
                    onClick={() => {
                      setAuthProfileId("");
                      setEditingConnection({
                        ...(editingConnection as SshConnectionConfig),
                        auth_profile_id: undefined,
                        auth_type: {
                          type: "PrivateKey",
                          key_path: "",
                          passphrase: "",
                        },
                      });
                    }}
                  >
                    {t("connections.authType.key")}
                  </button>
                </div>
              </div>

              {authType === "Password" && (
                <div className="form-group">
                  <label>{t("connections.password")}</label>
                  <div className="password-input-wrapper">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={
                        (
                          (editingConnection as SshConnectionConfig)
                            .auth_type as any
                        ).password || ""
                      }
                      onChange={(e) =>
                        setEditingConnection({
                          ...(editingConnection as SshConnectionConfig),
                          auth_type: {
                            type: "Password",
                            password: e.target.value,
                          },
                        })
                      }
                    />
                    <button
                      type="button"
                      className="password-toggle-btn"
                      onClick={() => setShowPassword(!showPassword)}
                      title={
                        showPassword
                          ? t("connections.password.hide")
                          : t("connections.password.show")
                      }
                    >
                      <AppIcon
                        icon={
                          showPassword
                            ? "material-symbols:visibility-off-rounded"
                            : "material-symbols:visibility-rounded"
                        }
                        size={20}
                      />
                    </button>
                  </div>
                </div>
              )}

              {authType === "PrivateKey" && (
                <>
                  <div className="keys-pk-mode">
                    <button
                      type="button"
                      className={`keys-pk-mode-btn ${currentPkMode === "path" ? "active" : ""}`}
                      onClick={() => setPkMode("path")}
                    >
                      {t("connections.pkMode.path")}
                    </button>
                    <button
                      type="button"
                      className={`keys-pk-mode-btn ${currentPkMode === "manual" ? "active" : ""}`}
                      onClick={() => setPkMode("manual")}
                    >
                      {t("connections.pkMode.manual")}
                    </button>
                  </div>

                  {currentPkMode === "path" && (
                    <>
                      <div className="form-group">
                        <label>{t("connections.pk.path")}</label>
                        <input
                          type="text"
                          value={
                            (
                              (editingConnection as SshConnectionConfig)
                                .auth_type as any
                            ).key_path || ""
                          }
                          onChange={(e) =>
                            setEditingConnection({
                              ...(editingConnection as SshConnectionConfig),
                              auth_type: {
                                ...((editingConnection as SshConnectionConfig)
                                  .auth_type as any),
                                type: "PrivateKey",
                                key_path: e.target.value,
                                key_content: undefined,
                              },
                            })
                          }
                          placeholder="/home/user/.ssh/id_rsa"
                        />
                      </div>
                      <div className="form-group">
                        <label>{t("connections.pk.passphraseOptional")}</label>
                        <div className="password-input-wrapper">
                          <input
                            type={showPassphrase ? "text" : "password"}
                            value={
                              (
                                (editingConnection as SshConnectionConfig)
                                  .auth_type as any
                              ).passphrase || ""
                            }
                            onChange={(e) =>
                              setEditingConnection({
                                ...(editingConnection as SshConnectionConfig),
                                auth_type: {
                                  ...((editingConnection as SshConnectionConfig)
                                    .auth_type as any),
                                  type: "PrivateKey",
                                  passphrase: e.target.value,
                                },
                              })
                            }
                          />
                          <button
                            type="button"
                            className="password-toggle-btn"
                            onClick={() => setShowPassphrase(!showPassphrase)}
                            title={
                              showPassphrase
                                ? t("connections.password.hide")
                                : t("connections.password.show")
                            }
                          >
                            <AppIcon
                              icon={
                                showPassphrase
                                  ? "material-symbols:visibility-off-rounded"
                                  : "material-symbols:visibility-rounded"
                              }
                              size={20}
                            />
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {currentPkMode === "manual" && (
                    <div className="keys-manual">
                      <div className="form-group">
                        <label>{t("connections.pk.content")}</label>
                        <textarea
                          className="keys-pem-textarea"
                          value={
                            (
                              (editingConnection as SshConnectionConfig)
                                .auth_type as any
                            ).key_content || ""
                          }
                          onChange={(e) => {
                            const content = e.target.value;
                            setEditingConnection({
                              ...(editingConnection as SshConnectionConfig),
                              auth_type: {
                                ...((editingConnection as SshConnectionConfig)
                                  .auth_type as any),
                                type: "PrivateKey",
                                key_path: "",
                                key_content: content,
                              },
                            });
                            if (content.trim()) {
                              setPemValidation(validatePemKey(content, t));
                            } else {
                              setPemValidation(null);
                            }
                          }}
                          onBlur={(e) => {
                            const content = e.target.value;
                            if (content.trim()) {
                              setPemValidation(validatePemKey(content, t));
                            }
                          }}
                          placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;MIIEpAIBAAKCAQEA...&#10;-----END RSA PRIVATE KEY-----"
                          rows={12}
                        />
                        {pemValidation && (
                          <div
                            className={`keys-validation ${pemValidation.valid ? "valid" : "invalid"}`}
                          >
                            <AppIcon
                              icon={
                                pemValidation.valid
                                  ? "material-symbols:check-circle-rounded"
                                  : "material-symbols:error-rounded"
                              }
                              size={16}
                            />
                            {pemValidation.message}
                          </div>
                        )}
                        <div className="keys-hint">
                          <strong>{t("connections.pk.hint.title")}</strong>
                          {t("connections.pk.hint.desc")}
                          <br />• <code>
                            -----BEGIN RSA PRIVATE KEY-----
                          </code>{" "}
                          (OpenSSH RSA)
                          <br />•{" "}
                          <code>-----BEGIN OPENSSH PRIVATE KEY-----</code>{" "}
                          ({t("connections.pk.hint.opensshNew")})
                          <br />• <code>
                            -----BEGIN EC PRIVATE KEY-----
                          </code>{" "}
                          (ECDSA)
                          <br />• {t("connections.pk.hint.ensureFull")}
                        </div>
                      </div>

                      <div className="form-group">
                        <label>{t("connections.pk.passphraseOptional")}</label>
                        <div className="password-input-wrapper">
                          <input
                            type={showPassphrase ? "text" : "password"}
                            value={
                              (
                                (editingConnection as SshConnectionConfig)
                                  .auth_type as any
                              ).passphrase || ""
                            }
                            onChange={(e) =>
                              setEditingConnection({
                                ...(editingConnection as SshConnectionConfig),
                                auth_type: {
                                  ...((editingConnection as SshConnectionConfig)
                                    .auth_type as any),
                                  type: "PrivateKey",
                                  passphrase: e.target.value,
                                },
                              })
                            }
                            placeholder={t("connections.pk.passphrasePlaceholder")}
                          />
                          <button
                            type="button"
                            className="password-toggle-btn"
                            onClick={() => setShowPassphrase(!showPassphrase)}
                            title={
                              showPassphrase
                                ? t("connections.password.hide")
                                : t("connections.password.show")
                            }
                          >
                            <AppIcon
                              icon={
                                showPassphrase
                                  ? "material-symbols:visibility-off-rounded"
                                  : "material-symbols:visibility-rounded"
                              }
                              size={20}
                            />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <div className="connection-more-section">
          <button
            type="button"
            className="connection-more-toggle"
            onClick={() => setShowAdvancedConfig((prev) => !prev)}
          >
            <span className="connection-more-label">
              {t("connections.more.label")}
            </span>
            <span className="connection-more-summary">{moreConfigSummary}</span>
            <AppIcon
              icon={
                showAdvancedConfig
                  ? "material-symbols:keyboard-arrow-up-rounded"
                  : "material-symbols:keyboard-arrow-down-rounded"
              }
              size={18}
            />
          </button>

          {showAdvancedConfig && (
            <div className="connection-more-body">
              <div className="form-row">
                <div className="form-group">
                  <label>{t("connections.field.name")}</label>
                  <input
                    type="text"
                    value={editingConnection.name}
                    onChange={(e) =>
                      setEditingConnection({
                        ...editingConnection,
                        name: e.target.value,
                      })
                    }
                  />
                </div>
                <div className="form-group">
                  <label>{t("connections.field.tags")}</label>
                  <input
                    type="text"
                    value={tags.join(", ")}
                    onChange={(e) =>
                      setEditingConnection({
                        ...editingConnection,
                        tags: normalizeTags(e.target.value.split(/[，,]/g)),
                      })
                    }
                    placeholder={t("connections.field.tagsPlaceholder")}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>{t("connections.field.color")}</label>
                <div className="connection-color-row">
                  <div className="connection-color-options">
                    {CONNECTION_COLOR_OPTIONS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={`connection-color-option ${color === option ? "active" : ""}`}
                        style={{ backgroundColor: option }}
                        onClick={() =>
                          setEditingConnection({
                            ...editingConnection,
                            color: option,
                          })
                        }
                        aria-label={t("connections.color.select", {
                          color: option,
                        })}
                      />
                    ))}
                  </div>
                  <input
                    type="color"
                    className="connection-color-picker"
                    value={color}
                    onChange={(e) =>
                      setEditingConnection({
                        ...editingConnection,
                        color: e.target.value,
                      })
                    }
                    aria-label={t("connections.color.custom")}
                  />
                </div>
              </div>

              {!isRdp && (
                <div className="form-group">
                  <label>{t("connections.field.encoding")}</label>
                  <Select
                    value={
                      (editingConnection as SshConnectionConfig).encoding ||
                      "utf-8"
                    }
                    onChange={(nextValue) =>
                      setEditingConnection({
                        ...(editingConnection as SshConnectionConfig),
                        encoding: nextValue,
                      })
                    }
                    options={ENCODING_OPTIONS.map((item) => ({
                      value: item.value,
                      label: item.label,
                    }))}
                  />
                </div>
              )}

              {isRdp && (
                <>
                  <div className="form-group">
                    <label>{t("connections.rdp.gatewayHost")}</label>
                    <input
                      type="text"
                      value={
                        (editingConnection as RdpConnectionConfig)
                          .gatewayHost || ""
                      }
                      onChange={(e) =>
                        setEditingConnection({
                          ...(editingConnection as RdpConnectionConfig),
                          gatewayHost: e.target.value,
                        })
                      }
                      placeholder="rdp-gateway.example.com"
                    />
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t("connections.rdp.gatewayUser")}</label>
                      <input
                        type="text"
                        value={
                          (editingConnection as RdpConnectionConfig)
                            .gatewayUsername || ""
                        }
                        onChange={(e) =>
                          setEditingConnection({
                            ...(editingConnection as RdpConnectionConfig),
                            gatewayUsername: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="form-group">
                      <label>{t("connections.rdp.gatewayPassword")}</label>
                      <input
                        type="password"
                        value={
                          (editingConnection as RdpConnectionConfig)
                            .gatewayPassword || ""
                        }
                        onChange={(e) =>
                          setEditingConnection({
                            ...(editingConnection as RdpConnectionConfig),
                            gatewayPassword: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t("connections.rdp.gatewayDomain")}</label>
                      <input
                        type="text"
                        value={
                          (editingConnection as RdpConnectionConfig)
                            .gatewayDomain || ""
                        }
                        onChange={(e) =>
                          setEditingConnection({
                            ...(editingConnection as RdpConnectionConfig),
                            gatewayDomain: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="form-group">
                      <label>{t("connections.rdp.certPolicy")}</label>
                      <Select
                        value={
                          (editingConnection as RdpConnectionConfig)
                            .certPolicy || "default"
                        }
                        onChange={(nextValue) =>
                          setEditingConnection({
                            ...(editingConnection as RdpConnectionConfig),
                            certPolicy:
                              nextValue as RdpConnectionConfig["certPolicy"],
                          })
                        }
                        options={[
                          {
                            value: "default",
                            label: t("connections.rdp.certPolicy.default"),
                          },
                          {
                            value: "ignore",
                            label: t("connections.rdp.certPolicy.ignore"),
                          },
                        ]}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t("connections.rdp.resolutionWidth")}</label>
                      <input
                        type="number"
                        value={
                          (editingConnection as RdpConnectionConfig)
                            .resolutionWidth ?? ""
                        }
                        onChange={(e) =>
                          setEditingConnection({
                            ...(editingConnection as RdpConnectionConfig),
                            resolutionWidth: e.target.value
                              ? Number(e.target.value)
                              : undefined,
                          })
                        }
                        placeholder={t("connections.rdp.resolutionWidthPlaceholder")}
                      />
                    </div>
                    <div className="form-group">
                      <label>{t("connections.rdp.resolutionHeight")}</label>
                      <input
                        type="number"
                        value={
                          (editingConnection as RdpConnectionConfig)
                            .resolutionHeight ?? ""
                        }
                        onChange={(e) =>
                          setEditingConnection({
                            ...(editingConnection as RdpConnectionConfig),
                            resolutionHeight: e.target.value
                              ? Number(e.target.value)
                              : undefined,
                          })
                        }
                        placeholder={t("connections.rdp.resolutionHeightPlaceholder")}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t("connections.rdp.colorDepth")}</label>
                      <Select
                        value={String(
                          (editingConnection as RdpConnectionConfig)
                            .colorDepth ?? 32,
                        )}
                        onChange={(nextValue) =>
                          setEditingConnection({
                            ...(editingConnection as RdpConnectionConfig),
                            colorDepth: Number(
                              nextValue,
                            ) as RdpConnectionConfig["colorDepth"],
                          })
                        }
                        options={RDP_COLOR_DEPTHS.map((depth) => ({
                          value: String(depth),
                          label: t("connections.rdp.colorDepthBits", { depth }),
                        }))}
                      />
                    </div>
                    <div className="form-group">
                      <label>{t("connections.rdp.clipboard")}</label>
                      <Select
                        value={
                          (editingConnection as RdpConnectionConfig)
                            .redirectClipboard
                            ? "on"
                            : "off"
                        }
                        onChange={(nextValue) =>
                          setEditingConnection({
                            ...(editingConnection as RdpConnectionConfig),
                            redirectClipboard: nextValue === "on",
                          })
                        }
                        options={[
                          { value: "on", label: t("connections.option.on") },
                          { value: "off", label: t("connections.option.off") },
                        ]}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t("connections.rdp.audio")}</label>
                      <Select
                        value={
                          (editingConnection as RdpConnectionConfig)
                            .redirectAudio
                            ? "on"
                            : "off"
                        }
                        onChange={(nextValue) =>
                          setEditingConnection({
                            ...(editingConnection as RdpConnectionConfig),
                            redirectAudio: nextValue === "on",
                          })
                        }
                        options={[
                          { value: "on", label: t("connections.option.on") },
                          { value: "off", label: t("connections.option.off") },
                        ]}
                      />
                    </div>
                    <div className="form-group">
                      <label>{t("connections.rdp.drives")}</label>
                      <Select
                        value={
                          (editingConnection as RdpConnectionConfig)
                            .redirectDrives
                            ? "on"
                            : "off"
                        }
                        onChange={(nextValue) =>
                          setEditingConnection({
                            ...(editingConnection as RdpConnectionConfig),
                            redirectDrives: nextValue === "on",
                          })
                        }
                        options={[
                          { value: "on", label: t("connections.option.on") },
                          { value: "off", label: t("connections.option.off") },
                        ]}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="connection-detail-actions connection-form-actions">
          <button
            className="btn btn-secondary"
            onClick={() => {
              setEditingConnection(null);
              setShowAdvancedConfig(false);
              setIsEditModalOpen(false);
            }}
          >
            {t("common.cancel")}
          </button>
          <button className="btn btn-secondary" onClick={handleSaveConnection}>
            {t("common.save")}
          </button>
          {!isRdp && (
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => void handleTestConnection()}
              disabled={testStatus === "testing"}
            >
              {testStatus === "testing"
                ? t("connections.test.testing")
                : t("connections.test.action")}
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={async () => {
              const connectionToConnect =
                normalizeConnection(
                  editingConnection,
                  fallbackNames.ssh,
                  fallbackNames.rdp,
                );
              await handleSaveConnection();
              await handleConnect(connectionToConnect);
            }}
          >
            {isRdp
              ? t("connections.action.saveAndOpen")
              : t("connections.action.connectAndSave")}
          </button>
          {!isRdp && testMessage && (
            <span
              className={`connection-test-status connection-test-status--${testStatus}`}
            >
              {testMessage}
            </span>
          )}
        </div>
      </div>
    );
  };

  const renderConnectionDetail = () => {
    const renderTerminal = (
      sessionId: string,
      session: ActiveSession,
      isSplit: boolean,
      onCloseSession?: () => void,
      onRequestSplit?: (direction: SplitLayout["direction"]) => void,
    ) => {
      const sendScript = async (content: string, scope: "current" | "all") => {
        if (scope === "all") {
          const targets = Array.from(activeSessions.keys());
          await Promise.all(
            targets.map((id) => {
              const targetSession = activeSessions.get(id);
              if (targetSession?.kind === "local") {
                return sshApi.localWriteToShell(id, content).catch(() => {});
              }
              return sshApi.writeToShell(id, content).catch(() => {});
            }),
          );
          return;
        }
        if (session.kind === "local") {
          await sshApi.localWriteToShell(sessionId, content).catch(() => {});
          return;
        }
        await sshApi.writeToShell(sessionId, content).catch(() => {});
      };
      const handleTerminalConnect = async () => {
        if (session.kind === "local") {
          await sshApi.localOpenShell(sessionId);
          return;
        }
        const backendSessionId = await sshApi.connect({
          ...session.connection,
          id: sessionId,
        });
        await sshApi.openShell(backendSessionId);
        if (!session.connection.osType || session.connection.osType === "unknown") {
          void (async () => {
            try {
              const osType = await detectRemoteOsType(backendSessionId);
              await updateConnectionOsType(session.connection.id, osType);
            } catch {
              // Ignore detection errors; terminal is already connected.
            }
          })();
        }
      };

      return (
        <XTerminal
          sessionId={sessionId}
          host={session.connection.host}
          port={session.connection.port}
          isLocal={session.kind === "local"}
          osType={session.connection.osType ?? "unknown"}
          onConnect={handleTerminalConnect}
          onRequestSplit={onRequestSplit}
          onCloseSession={onCloseSession}
          isSplit={isSplit}
          onSendScript={sendScript}
        />
      );
    };

    const connectedTerminals = tabs
      .map((tab) => tab.id)
      .filter((sessionId) => activeSessions.has(sessionId))
      .map((sessionId) => {
        const session = activeSessions.get(sessionId);
        if (!session) return null;
        const split = splitLayouts.get(sessionId);
        const show = activeTabId === sessionId ? "flex" : "none";

        if (split) {
          const secondary = activeSessions.get(split.secondarySessionId);
          if (!secondary) {
            return (
              <div
                key={sessionId}
                className="terminal-fullscreen"
                style={{ display: show }}
              >
                <div className="terminal-container">
                  {renderTerminal(
                    sessionId,
                    session,
                    false,
                    undefined,
                    (direction) => openSplitPicker(sessionId, direction),
                  )}
                </div>
              </div>
            );
          }

          return (
            <div
              key={sessionId}
              className={`terminal-fullscreen terminal-split terminal-split--${split.direction}`}
              style={{ display: show }}
            >
              <div className="terminal-split-pane">
                {renderTerminal(
                  sessionId,
                  session,
                  true,
                  () => void handleDisconnect(sessionId),
                  undefined,
                )}
              </div>
              <div className="terminal-split-pane">
                {renderTerminal(
                  split.secondarySessionId,
                  secondary,
                  true,
                  () => void handleDisconnect(split.secondarySessionId),
                )}
              </div>
            </div>
          );
        }

        return (
          <div
            key={sessionId}
            className="terminal-fullscreen"
            style={{ display: show }}
          >
            <div className="terminal-container">
              {renderTerminal(
                sessionId,
                session,
                false,
                () => void handleDisconnect(sessionId),
                (direction) => openSplitPicker(sessionId, direction),
              )}
            </div>
          </div>
        );
      })
      .filter(Boolean);

    // 如果有已连接的终端，渲染它们
    if (connectedTerminals.length > 0) {
      return <>{connectedTerminals}</>;
    }

    if (selectedConnection?.kind === "rdp") {
      const rdp = selectedConnection as RdpConnectionConfig;
      return (
        <div className="empty-state">
          <span className="empty-state-icon" aria-hidden="true">
            <AppIcon
              icon="material-symbols:desktop-windows-rounded"
              size={64}
            />
          </span>
          <div>
            <h3>{t("connections.empty.rdp.title")}</h3>
            <p style={{ marginTop: 12 }}>
              {t("connections.empty.rdp.target", {
                target: `${rdp.username}@${rdp.host}:${rdp.port}`,
              })}
            </p>
            <div style={{ marginTop: 16 }}>
              <button
                className="btn btn-primary"
                onClick={() => void rdpApi.open(rdp)}
              >
                {t("connections.action.openRdp")}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="empty-state">
        <span className="empty-state-icon" aria-hidden="true">
          <AppIcon icon="material-symbols:terminal-rounded" size={64} />
        </span>
        <div>
          <h3>{t("connections.empty.readyTitle")}</h3>
          <p style={{ marginTop: 20 }}>
            {t("connections.empty.readyDesc")}
          </p>
        </div>
      </div>
    );
  };

  const availableTags = useMemo(() => {
    const unique = new Set<string>();
    for (const conn of connections) {
      for (const tag of normalizeTags(conn.tags)) {
        unique.add(tag);
      }
    }
    return Array.from(unique).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }, [connections]);

  const availableColors = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];

    for (const color of CONNECTION_COLOR_OPTIONS) {
      const exists = connections.some(
        (conn) => normalizeColor(conn.color) === color,
      );
      if (exists) {
        seen.add(color);
        ordered.push(color);
      }
    }

    for (const conn of connections) {
      const color = normalizeColor(conn.color);
      if (!seen.has(color)) {
        seen.add(color);
        ordered.push(color);
      }
    }

    return ordered;
  }, [connections]);

  useEffect(() => {
    if (tagFilter !== "all" && !availableTags.includes(tagFilter)) {
      setTagFilter("all");
    }
  }, [availableTags, tagFilter]);

  useEffect(() => {
    if (colorFilter !== "all" && !availableColors.includes(colorFilter)) {
      setColorFilter("all");
    }
  }, [availableColors, colorFilter]);

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredConnections = connections.filter((conn) => {
    const tags = normalizeTags(conn.tags);
    const connColor = normalizeColor(conn.color);
    const matchesQuery =
      !normalizedQuery ||
      conn.name.toLowerCase().includes(normalizedQuery) ||
      conn.host.toLowerCase().includes(normalizedQuery) ||
      conn.username.toLowerCase().includes(normalizedQuery) ||
      tags.some((tag) => tag.toLowerCase().includes(normalizedQuery));
    const matchesTag = tagFilter === "all" || tags.includes(tagFilter);
    const matchesColor = colorFilter === "all" || connColor === colorFilter;

    return matchesQuery && matchesTag && matchesColor;
  });

  const connectPickerResults = useMemo(() => {
    const query = connectPickerQuery.trim().toLowerCase();
    if (!query) return connections;
    const tokens = query.split(/\s+/).filter(Boolean);
    return connections.filter((conn) => {
      const tags = (conn.tags ?? []).join(" ");
      const haystack = [
        conn.name,
        conn.host,
        conn.username,
        conn.kind,
        tags,
      ]
        .join(" ")
        .toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }, [connections, connectPickerQuery]);

  return (
    <>
      <div
        className={`connections-page ${activePanel === "connections" ? "connections-page--panel-open" : ""}`}
      >
        <SlidePanel
          isOpen={activePanel === "connections"}
          title={t("connections.panel.title")}
          onAdd={() => void handleAddConnection()}
          closePanel={handlePanelClose}
          dockToWindow
        >
          <div className="connecting-header">
            <div className="search-box">
              <input
                type="text"
                placeholder={t("connections.search.placeholder")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="search-input"
              />
              <span className="search-icon" aria-hidden="true">
                <AppIcon icon="material-symbols:search-rounded" size={18} />
              </span>
            </div>
            <div className="connection-filters">
              <div className="connection-filter-row">
                <span className="connection-filter-label">
                  {t("connections.filter.tags")}
                </span>
                <div className="connection-filter-options connection-filter-options--select">
                  <Select
                    className="connection-filter-select"
                    value={tagFilter}
                    onChange={(nextValue) => setTagFilter(nextValue)}
                    disabled={availableTags.length === 0}
                    options={[
                      { value: "all", label: t("connections.filter.all") },
                      ...availableTags.map((tag) => ({
                        value: tag,
                        label: tag,
                      })),
                    ]}
                  />
                </div>
              </div>
              <div className="connection-filter-row">
                <span className="connection-filter-label">
                  {t("connections.filter.colors")}
                </span>
                <div className="connection-filter-options">
                  <button
                    type="button"
                    className={`connection-filter-chip ${colorFilter === "all" ? "active" : ""}`}
                    onClick={() => setColorFilter("all")}
                  >
                    {t("connections.filter.all")}
                  </button>
                  {availableColors.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={`connection-filter-color-chip ${colorFilter === color ? "active" : ""}`}
                      onClick={() => setColorFilter(color)}
                      aria-label={t("connections.filter.colorAria", {
                        color,
                      })}
                      title={color}
                    >
                      <span
                        className="connection-filter-color-dot"
                        style={{ backgroundColor: color }}
                        aria-hidden="true"
                      />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className="connections-list-items">
            {filteredConnections.length === 0 && (
              <div className="connections-empty-hint">
                {t("connections.list.empty")}
              </div>
            )}
            {filteredConnections.map((conn) => {
              const connColor = normalizeColor(conn.color);
              const tagStyle = getTagStyle(connColor);
              return (
                <div
                  key={conn.id}
                  className={`connection-item ${selectedConnection?.id === conn.id ? "active" : ""}`}
                  style={
                    {
                      "--conn-color": connColor,
                    } as CSSProperties
                  }
                  onClick={() => {
                    setSelectedConnection(conn);
                    void handleConnect(conn);
                  }}
                >
                  <div className="connection-item-top">
                    {/* 图标*/}
                    <span className="connection-icon" aria-hidden="true">
                      <span
                        className="connection-icon-tile"
                      >
                        <AppIcon
                          icon={getConnectionIcon(conn)}
                          size={18}
                        />
                      </span>
                    </span>
                  {/* 基础信息 */}
                  <div className="connection-info">
                    <div className="connection-name-row">
                      <div className="connection-name">{conn.name}</div>
                    </div>
                    <div className="connection-details">
                      {conn.username ? `${conn.username}` : ""}
                    </div>
                  </div>
                  <div
                    className={`connection-actions ${
                      actionMenu?.id === conn.id ? "open" : ""
                    }`}
                  >
                    <button
                      type="button"
                      className="connection-menu-btn"
                      title={t("connections.menu.more")}
                      aria-haspopup="menu"
                      aria-expanded={actionMenu?.id === conn.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect = (
                          event.currentTarget as HTMLButtonElement
                        ).getBoundingClientRect();
                        setActionMenu((prev) => {
                          if (prev?.id === conn.id) return null;
                          const menuWidth = 168;
                          const padding = 12;
                          const left = Math.min(
                            Math.max(padding, rect.right - menuWidth),
                            window.innerWidth - padding - menuWidth,
                          );
                          const top = Math.min(
                            rect.bottom + 8,
                            window.innerHeight - padding - 160,
                          );
                          return { id: conn.id, x: left, y: top };
                        });
                      }}
                    >
                      <AppIcon icon="material-symbols:more-horiz" size={18} />
                    </button>
                  </div>
                </div>
                {(conn.tags ?? []).length > 0 && (
                  <div className="connection-tags">
                    {(conn.tags ?? []).slice(0, 3).map((tag) => (
                      <span
                        key={`${conn.id}-${tag}`}
                        className="connection-tag"
                        style={tagStyle}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                </div>
              );
            })}
          </div>
        </SlidePanel>

        <div className="connection-detail">{renderConnectionDetail()}</div>
      </div>

      {actionMenu &&
        createPortal(
          <div
            className="connection-menu-layer"
            onMouseDown={() => setActionMenu(null)}
          >
            <div
              className="connection-menu"
              role="menu"
              style={{ left: actionMenu.x, top: actionMenu.y }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {(() => {
                const conn = connections.find((item) => item.id === actionMenu.id);
                if (!conn) return null;
                return (
                  <>
                    <button
                      type="button"
                      className="connection-menu-item"
                      onClick={() => {
                        setActionMenu(null);
                        handleConnect(conn);
                      }}
                    >
                      <AppIcon
                        icon="material-symbols:play-arrow-rounded"
                        size={16}
                      />
                      {t("connections.action.connect")}
                    </button>
                    <button
                      type="button"
                      className="connection-menu-item"
                      onClick={() => {
                        setActionMenu(null);
                        setSelectedConnection(conn);
                        setEditingConnection(conn);
                        setAuthProfileId(
                          isSshConnection(conn) ? conn.auth_profile_id ?? "" : "",
                        );
                        // 根据连接的 auth_type 设置 pkMode
                        if (
                          isSshConnection(conn) &&
                          conn.auth_type.type === "PrivateKey"
                        ) {
                          if (conn.auth_type.key_content) {
                            setPkMode("manual");
                          } else {
                            setPkMode("path");
                          }
                        }
                        setShowAdvancedConfig(false);
                        setIsEditModalOpen(true);
                      }}
                    >
                      <AppIcon icon="material-symbols:edit-rounded" size={16} />
                      {t("common.edit")}
                    </button>
                    <button
                      type="button"
                      className="connection-menu-item connection-menu-item--danger"
                      onClick={() => {
                        setActionMenu(null);
                        handleDeleteConnection(conn.id);
                      }}
                    >
                      <AppIcon
                        icon="material-symbols:delete-rounded"
                        size={16}
                      />
                      {t("common.delete")}
                    </button>
                  </>
                );
              })()}
            </div>
          </div>,
          document.body,
        )}

      <Modal
        open={isEditModalOpen}
        title={
          editingConnection &&
          connections.some((c) => c.id === editingConnection.id)
            ? t("connections.modal.editTitle")
            : t("connections.modal.addTitle")
        }
        onClose={() => {
          setIsEditModalOpen(false);
          setEditingConnection(null);
          setAuthProfileId("");
          setShowAdvancedConfig(false);
        }}
        width={860}
      >
        {renderConnectionForm()}
      </Modal>

      <Modal
        open={splitPickerOpen}
        title={
          splitPickerDirection === "vertical"
            ? t("connections.split.vertical")
            : t("connections.split.horizontal")
        }
        onClose={() => {
          setSplitPickerOpen(false);
          setSplitPickerBaseSessionId(null);
        }}
        width={520}
      >
        <div className="split-picker">
          {connections.length === 0 && (
            <div className="split-picker-empty">{t("connections.split.empty")}</div>
          )}
          {connections.filter(isSshConnection).map((conn) => (
            <button
              key={conn.id}
              type="button"
              className="split-picker-item"
              onClick={() => void handleCreateSplit(conn)}
            >
              <span className="split-picker-name">{conn.name}</span>
              <span className="split-picker-meta">
                {conn.username}@{conn.host}
              </span>
            </button>
          ))}
        </div>
      </Modal>

      <Modal
        open={showMasterKeyPrompt}
        title={t("connections.masterKey.title")}
        onClose={() => setShowMasterKeyPrompt(false)}
        width={520}
      >
        <div className="masterkey-prompt">
          <div className="settings-item" style={{ padding: "12px 4px 12px" }}>
            <div className="settings-item-info">
              <div className="settings-item-label">
                {t("connections.masterKey.label")}
              </div>
              <div className="settings-item-description">
                {t("connections.masterKey.desc")}
              </div>
            </div>
          </div>
          <div className="connection-form-actions masterkey-prompt-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowMasterKeyPrompt(false)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setShowMasterKeyPrompt(false);
                openSettingsTab();
              }}
            >
              {t("connections.masterKey.goSettings")}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={connectPickerOpen}
        title={t("connections.picker.title")}
        onClose={() => setConnectPickerOpen(false)}
        width={520}
      >
        <div className="connect-picker">
          <div className="connect-picker-search">
            <AppIcon icon="material-symbols:search-rounded" size={16} />
            <input
              ref={connectPickerInputRef}
              value={connectPickerQuery}
              onChange={(event) => setConnectPickerQuery(event.target.value)}
              placeholder={t("connections.picker.search.placeholder")}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                if (connectPickerResults.length === 0) return;
                event.preventDefault();
                void handleConnect(connectPickerResults[0]);
                setConnectPickerOpen(false);
              }}
            />
            {connectPickerQuery && (
              <button
                type="button"
                className="connect-picker-clear"
                onClick={() => setConnectPickerQuery("")}
                aria-label={t("common.clear")}
              >
                <AppIcon icon="material-symbols:close-rounded" size={14} />
              </button>
            )}
          </div>
          <div className="connect-picker-list">
            {connections.length === 0 && (
              <div className="connect-picker-empty">
                {t("connections.picker.empty")}
              </div>
            )}
            {connections.length > 0 && connectPickerResults.length === 0 && (
              <div className="connect-picker-empty">
                {t("connections.picker.noResults")}
              </div>
            )}
            {connectPickerResults.map((conn) => (
              <button
                key={conn.id}
                type="button"
                className="connect-picker-item"
                onClick={() => {
                  void handleConnect(conn);
                  setConnectPickerOpen(false);
                }}
              >
                <span className="connect-picker-name">{conn.name}</span>
                <span className="connect-picker-meta">
                  {conn.username}@{conn.host}
                </span>
              </button>
            ))}
          </div>
        </div>
      </Modal>
    </>
  );
}
