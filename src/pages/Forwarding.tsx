import { useEffect, useMemo, useState } from "react";
import { load } from "@tauri-apps/plugin-store";
import { AppIcon } from "../components/AppIcon";
import { Modal } from "../components/Modal";
import { Select } from "../components/Select";
import {
  readForwardRules,
  writeForwardRules,
  type ForwardRule,
  type ForwardKind,
} from "../store/forwardings";
import { startForward, stopForward, listForwards } from "../api/forwarding";
import type { ConnectionConfig, SshConnectionConfig } from "../types/connection";
import type { AuthProfile } from "../types/auth";
import {
  decryptString,
  generateSalt,
  isEncryptedPayload,
} from "../utils/security";
import { getMasterKeySession } from "../utils/securitySession";
import { readAppSetting, writeAppSetting } from "../store/appSettings";
import { useI18n } from "../i18n";
import "./Forwarding.css";

const DEFAULT_CONNECTION_COLOR = "#ffb347";

let keyStore: Awaited<ReturnType<typeof load>> | null = null;

const normalizeTags = (tags?: string[]) =>
  Array.from(new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean)));

const normalizeColor = (color?: string) =>
  color && color.trim() ? color.trim() : DEFAULT_CONNECTION_COLOR;

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
});

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

type SecurityContext = {
  masterKey: string | null;
  encSalt: string;
  savePassword: boolean;
};

async function getKeyStore() {
  if (!keyStore) {
    keyStore = await load("keys.json");
  }
  return keyStore;
}

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

const deserializeProfile = async (
  profile: AuthProfile,
  ctx: SecurityContext,
): Promise<AuthProfile> => {
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

const isEncryptedAuthPayload = (value: unknown, ctx: SecurityContext) => {
  if (ctx.masterKey) return false;
  return isEncryptedPayload(value);
};

const deserializeConnection = async (
  conn: any,
  ctx: SecurityContext,
  fallbackName: string,
): Promise<SshConnectionConfig | null> => {
  if (!conn || conn.kind === "rdp") return null;
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
  return normalizeSshConnection(ssh, fallbackName);
};

const createDefaultRule = (): ForwardRule => ({
  id: crypto.randomUUID(),
  name: "",
  kind: "local",
  connectionId: "",
  localBindHost: "127.0.0.1",
  localBindPort: 8080,
  remoteBindHost: "0.0.0.0",
  remoteBindPort: 9000,
  targetHost: "127.0.0.1",
  targetPort: 3306,
});

export function ForwardingPage() {
  const { t } = useI18n();
  const [rules, setRules] = useState<ForwardRule[]>([]);
  const [connections, setConnections] = useState<SshConnectionConfig[]>([]);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [lockedConnectionIds, setLockedConnectionIds] = useState<Set<string>>(
    new Set(),
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ForwardRule | null>(null);
  const [draft, setDraft] = useState<ForwardRule>(createDefaultRule());
  const [busyId, setBusyId] = useState<string | null>(null);

  const reloadConnections = async () => {
    const store = await load("connections.json");
    const saved = (await store.get<ConnectionConfig[]>("connections")) ?? [];
    const ctx = await getSecurityContext();
    const fallbackName = t("connections.defaultName");
    const keyStore = await getKeyStore();
    const savedProfiles = (await keyStore.get<AuthProfile[]>("profiles")) ?? [];
    const lockedProfiles = new Set<string>();
    if (!ctx.masterKey) {
      for (const profile of savedProfiles) {
        if (profile.auth_type.type === "Password") {
          if (isEncryptedAuthPayload(profile.auth_type.password, ctx)) {
            lockedProfiles.add(profile.id);
          }
        }
        if (profile.auth_type.type === "PrivateKey") {
          if (
            isEncryptedAuthPayload(profile.auth_type.key_content, ctx) ||
            isEncryptedAuthPayload(profile.auth_type.passphrase, ctx)
          ) {
            lockedProfiles.add(profile.id);
          }
        }
      }
    }
    const profiles = await Promise.all(
      savedProfiles.map((profile) => deserializeProfile(profile, ctx)),
    );
    const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
    const normalized = await Promise.all(
      saved.map((conn) => deserializeConnection(conn, ctx, fallbackName)),
    );
    const lockedIds = new Set<string>();
    if (!ctx.masterKey) {
      for (const conn of saved) {
        if (!conn || conn.kind === "rdp") continue;
        const auth = conn.auth_type;
        const hasEncryptedAuth =
          (auth?.type === "Password" &&
            isEncryptedAuthPayload(auth.password, ctx)) ||
          (auth?.type === "PrivateKey" &&
            (isEncryptedAuthPayload(auth.key_content, ctx) ||
              isEncryptedAuthPayload(auth.passphrase, ctx)));
        const usesLockedProfile =
          Boolean(conn.auth_profile_id) && lockedProfiles.has(conn.auth_profile_id ?? "");
        if (hasEncryptedAuth || usesLockedProfile) {
          lockedIds.add(conn.id);
        }
      }
    }
    const synced = normalized.map((conn) => {
      if (!conn || !conn.auth_profile_id) return conn;
      const profile = profileMap.get(conn.auth_profile_id);
      if (!profile) return conn;
      return {
        ...conn,
        username: profile.username,
        auth_type: cloneAuthType(profile.auth_type),
      };
    });
    const sshConnections = synced.filter(
      (item): item is SshConnectionConfig => Boolean(item),
    );
    setConnections(sshConnections);
    setLockedConnectionIds(lockedIds);
  };

  useEffect(() => {
    void (async () => {
      const data = await readForwardRules();
      setRules(data);
    })();
  }, []);

  useEffect(() => {
    void reloadConnections();
  }, [t]);

  useEffect(() => {
    const refresh = () => {
      void reloadConnections();
    };
    window.addEventListener("master-key-updated", refresh);
    window.addEventListener("auth-profiles-updated", refresh);
    return () => {
      window.removeEventListener("master-key-updated", refresh);
      window.removeEventListener("auth-profiles-updated", refresh);
    };
  }, [t]);

  const refreshRunning = async () => {
    try {
      const ids = await listForwards();
      setRunningIds(new Set(ids));
    } catch {
      setRunningIds(new Set());
    }
  };

  useEffect(() => {
    void refreshRunning();
  }, []);

  const saveRules = async (next: ForwardRule[]) => {
    setRules(next);
    await writeForwardRules(next);
  };

  const openEditor = (rule?: ForwardRule) => {
    if (rule) {
      setEditingRule(rule);
      setDraft({ ...rule });
    } else {
      setEditingRule(null);
      setDraft(createDefaultRule());
    }
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
  };

  const handleSave = async () => {
    const next = draft.name.trim()
      ? draft
      : { ...draft, name: t("forwarding.defaultName") };
    if (editingRule) {
      await saveRules(rules.map((item) => (item.id === next.id ? next : item)));
    } else {
      await saveRules([next, ...rules]);
    }
    setEditorOpen(false);
  };

  const handleDelete = async (rule: ForwardRule) => {
    if (!window.confirm(t("forwarding.delete.confirm"))) return;
    if (runningIds.has(rule.id)) {
      await stopForward(rule.id).catch(() => {});
    }
    await saveRules(rules.filter((item) => item.id !== rule.id));
    await refreshRunning();
  };

  const buildConfig = (rule: ForwardRule) => {
    const conn = connections.find((item) => item.id === rule.connectionId);
    if (!conn) throw new Error(t("forwarding.error.connectionMissing"));
    if (lockedConnectionIds.has(conn.id)) {
      throw new Error(t("forwarding.error.unlockRequired"));
    }
    return {
      id: rule.id,
      kind: rule.kind,
      connection: conn,
      localBindHost: rule.localBindHost,
      localBindPort: rule.localBindPort,
      remoteBindHost: rule.remoteBindHost,
      remoteBindPort: rule.remoteBindPort,
      targetHost: rule.targetHost,
      targetPort: rule.targetPort,
    };
  };

  const handleStart = async (rule: ForwardRule) => {
    setBusyId(rule.id);
    try {
      await startForward(buildConfig(rule));
      await refreshRunning();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.dispatchEvent(
        new CustomEvent("app-message", {
          detail: {
            title: t("forwarding.error.startFailed"),
            detail: message,
            tone: "error",
            toast: true,
          },
        }),
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleStop = async (rule: ForwardRule) => {
    setBusyId(rule.id);
    try {
      await stopForward(rule.id);
      await refreshRunning();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.dispatchEvent(
        new CustomEvent("app-message", {
          detail: {
            title: t("forwarding.error.stopFailed"),
            detail: message,
            tone: "error",
            toast: true,
          },
        }),
      );
    } finally {
      setBusyId(null);
    }
  };

  const ruleSummary = (rule: ForwardRule) => {
    if (rule.kind === "dynamic") {
      return `${rule.localBindHost}:${rule.localBindPort} (SOCKS5)`;
    }
    if (rule.kind === "remote") {
      return `${rule.remoteBindHost}:${rule.remoteBindPort} → ${rule.targetHost}:${rule.targetPort}`;
    }
    return `${rule.localBindHost}:${rule.localBindPort} → ${rule.targetHost}:${rule.targetPort}`;
  };

  const connectionOptions = useMemo(
    () =>
      connections.map((conn) => ({
        value: conn.id,
        label: `${conn.name} (${conn.username}@${conn.host})`,
      })),
    [connections],
  );

  const kindOptions: Array<{ value: ForwardKind; label: string }> = [
    { value: "local", label: t("forwarding.type.local") },
    { value: "remote", label: t("forwarding.type.remote") },
    { value: "dynamic", label: t("forwarding.type.dynamic") },
  ];

  return (
    <div className="forwarding-page">
      <div className="forwarding-header">
        <div>
          <div className="forwarding-title">{t("forwarding.title")}</div>
          <div className="forwarding-subtitle">{t("forwarding.desc")}</div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => openEditor()}
        >
          <AppIcon icon="material-symbols:add-rounded" size={16} />
          {t("forwarding.action.add")}
        </button>
      </div>

      <div className="forwarding-list">
        {rules.length === 0 && (
          <div className="forwarding-empty">{t("forwarding.empty")}</div>
        )}
        {rules.map((rule) => {
          const isRunning = runningIds.has(rule.id);
          return (
            <div key={rule.id} className="forwarding-card">
              <div className="forwarding-info">
                <div className="forwarding-name">
                  {rule.name}
                  <span
                    className={`forwarding-status ${
                      isRunning ? "is-running" : "is-stopped"
                    }`}
                  >
                    {isRunning
                      ? t("forwarding.status.running")
                      : t("forwarding.status.stopped")}
                  </span>
                </div>
                <div className="forwarding-meta">
                  <span className="forwarding-kind">
                    {t(`forwarding.type.${rule.kind}`)}
                  </span>
                  <span>{ruleSummary(rule)}</span>
                </div>
                <div className="forwarding-connection">
                  {connections.find((conn) => conn.id === rule.connectionId)?.name ??
                    t("forwarding.connection.missing")}
                </div>
              </div>
              <div className="forwarding-actions">
                {isRunning ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void handleStop(rule)}
                    disabled={busyId === rule.id}
                  >
                    {t("forwarding.action.stop")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleStart(rule)}
                    disabled={busyId === rule.id}
                  >
                    {t("forwarding.action.start")}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => openEditor(rule)}
                >
                  {t("forwarding.action.edit")}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void handleDelete(rule)}
                >
                  {t("forwarding.action.delete")}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <Modal
        open={editorOpen}
        title={
          editingRule
            ? t("forwarding.form.title.edit")
            : t("forwarding.form.title.add")
        }
        onClose={closeEditor}
        width={560}
      >
        <div className="forwarding-form">
          <div className="form-group">
            <label>{t("forwarding.form.name")}</label>
            <input
              value={draft.name}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, name: event.target.value }))
              }
              placeholder={t("forwarding.form.name.placeholder")}
            />
          </div>
          <div className="form-group">
            <label>{t("forwarding.form.connection")}</label>
            <Select
              value={draft.connectionId}
              onChange={(value) =>
                setDraft((prev) => ({ ...prev, connectionId: value }))
              }
              placeholder={t("forwarding.form.connection.placeholder")}
              options={connectionOptions}
            />
          </div>
          <div className="form-group">
            <label>{t("forwarding.form.type")}</label>
            <div className="auth-type-selector">
              {kindOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`auth-type-btn ${
                    draft.kind === option.value ? "active" : ""
                  }`}
                  onClick={() =>
                    setDraft((prev) => ({ ...prev, kind: option.value }))
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {(draft.kind === "local" || draft.kind === "dynamic") && (
            <div className="form-row">
              <div className="form-group">
                <label>{t("forwarding.form.localBindHost")}</label>
                <input
                  value={draft.localBindHost}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      localBindHost: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="form-group">
                <label>{t("forwarding.form.localBindPort")}</label>
                <input
                  type="number"
                  value={draft.localBindPort}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      localBindPort: Number(event.target.value),
                    }))
                  }
                />
              </div>
            </div>
          )}

          {draft.kind === "remote" && (
            <div className="form-row">
              <div className="form-group">
                <label>{t("forwarding.form.remoteBindHost")}</label>
                <input
                  value={draft.remoteBindHost}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      remoteBindHost: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="form-group">
                <label>{t("forwarding.form.remoteBindPort")}</label>
                <input
                  type="number"
                  value={draft.remoteBindPort}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      remoteBindPort: Number(event.target.value),
                    }))
                  }
                />
              </div>
            </div>
          )}

          {(draft.kind === "local" || draft.kind === "remote") && (
            <div className="form-row">
              <div className="form-group">
                <label>{t("forwarding.form.targetHost")}</label>
                <input
                  value={draft.targetHost}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      targetHost: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="form-group">
                <label>{t("forwarding.form.targetPort")}</label>
                <input
                  type="number"
                  value={draft.targetPort}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      targetPort: Number(event.target.value),
                    }))
                  }
                />
              </div>
            </div>
          )}

          <div className="forwarding-form-actions">
            <button type="button" className="btn btn-secondary" onClick={closeEditor}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleSave()}>
              {t("common.save")}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
