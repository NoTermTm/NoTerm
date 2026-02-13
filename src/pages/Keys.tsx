import { useEffect, useMemo, useState } from "react";
import { load } from "@tauri-apps/plugin-store";
import { AppIcon } from "../components/AppIcon";
import { Select } from "../components/Select";
import { Modal } from "../components/Modal";
import { generateKeypair, type GenerateKeyAlgorithm } from "../api/keys";
import { readAppSetting } from "../store/appSettings";
import {
  decryptString,
  encryptString,
  isEncryptedPayload,
  type EncryptedPayload,
} from "../utils/security";
import { getMasterKeySession } from "../utils/securitySession";
import type { AuthProfile } from "../types/auth";
import type { AuthType } from "../types/ssh";
import { useI18n } from "../i18n";
import "./Keys.css";

let store: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!store) {
    store = await load("keys.json");
  }
  return store;
}

type SecurityContext = {
  masterKey: string | null;
  encSalt: string;
  savePassword: boolean;
};

async function getSecurityContext(): Promise<SecurityContext> {
  const masterKey = getMasterKeySession();
  const encSalt = await readAppSetting("security.masterKeyEncSalt");
  const savePassword = await readAppSetting("connection.savePassword");
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

function createEmptyProfile(name: string): AuthProfile {
  return {
    id: crypto.randomUUID(),
    name,
    username: "root",
    auth_type: { type: "Password", password: "" },
  };
}

function formatAuthType(
  auth: AuthType,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  if (auth.type === "Password") return t("keys.auth.password");
  return t("keys.auth.key");
}

// 验证 PEM 私钥格式
function validatePemKey(
  content: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): { valid: boolean; message: string } {
  if (!content || !content.trim()) {
    return { valid: false, message: t("connections.pem.empty") };
  }

  const trimmed = content.trim();
  
  // 检查是否包含 BEGIN 和 END 标记
  const hasBegin = /-----BEGIN\s+[A-Z\s]+PRIVATE KEY-----/.test(trimmed);
  const hasEnd = /-----END\s+[A-Z\s]+PRIVATE KEY-----/.test(trimmed);
  
  if (!hasBegin || !hasEnd) {
    return {
      valid: false,
      message: t("connections.pem.missingMarkers"),
    };
  }
  
  // 检查 BEGIN 和 END 是否匹配
  const beginMatch = trimmed.match(/-----BEGIN\s+([A-Z\s]+PRIVATE KEY)-----/);
  const endMatch = trimmed.match(/-----END\s+([A-Z\s]+PRIVATE KEY)-----/);
  
  if (beginMatch && endMatch && beginMatch[1] !== endMatch[1]) {
    return {
      valid: false,
      message: t("connections.pem.mismatchMarkers"),
    };
  }
  
  // 检查是否有内容
  const lines = trimmed.split('\n');
  const contentLines = lines.filter(line => 
    !line.includes('-----BEGIN') && 
    !line.includes('-----END') &&
    line.trim() !== ''
  );
  
  if (contentLines.length === 0) {
    return {
      valid: false,
      message: t("connections.pem.noContent"),
    };
  }
  
  // 检查支持的格式
  const supportedFormats = [
    'RSA PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
    'EC PRIVATE KEY',
    'DSA PRIVATE KEY',
    'PRIVATE KEY' // PKCS#8
  ];
  
  const keyType = beginMatch ? beginMatch[1] : '';
  const isSupported = supportedFormats.some(format => keyType.includes(format));
  
  if (!isSupported) {
    return {
      valid: false,
      message: t("connections.pem.unsupported", { type: keyType }),
    };
  }
  
  return { valid: true, message: t("connections.pem.valid") };
}

export function KeysPage() {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<AuthProfile[]>([]);
  const [editing, setEditing] = useState<AuthProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pkMode, setPkMode] = useState<"path" | "create" | "manual">("path");
  const [genAlg, setGenAlg] = useState<GenerateKeyAlgorithm>("ed25519");
  const [genPassphrase, setGenPassphrase] = useState("");
  const [genComment, setGenComment] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [showGenPassphrase, setShowGenPassphrase] = useState(false);
  const [pemValidation, setPemValidation] = useState<{ valid: boolean; message: string } | null>(null);

  useEffect(() => {
    const run = async () => {
      const s = await getStore();
      const saved = await s.get<AuthProfile[]>("profiles");
      if (saved) {
        const ctx = await getSecurityContext();
        const next = await Promise.all(saved.map((p) => deserializeProfile(p, ctx)));
        setProfiles(next);
      }
    };
    void run();
  }, []);

  useEffect(() => {
    const refresh = () => {
      void (async () => {
        const s = await getStore();
        const saved = await s.get<AuthProfile[]>("profiles");
        if (!saved) return;
        const ctx = await getSecurityContext();
        const next = await Promise.all(saved.map((p) => deserializeProfile(p, ctx)));
        setProfiles(next);
      })();
    };
    window.addEventListener("master-key-updated", refresh);
    return () => {
      window.removeEventListener("master-key-updated", refresh);
    };
  }, []);

  const saveProfiles = async (next: AuthProfile[]) => {
    const s = await getStore();
    const ctx = await getSecurityContext();
    const persisted = await Promise.all(
      next.map((profile) => serializeProfile(profile, ctx)),
    );
    await s.set("profiles", persisted);
    await s.save();
    setProfiles(next);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("auth-profiles-updated"));
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) => {
      if (p.name.toLowerCase().includes(q)) return true;
      if (p.username.toLowerCase().includes(q)) return true;
      if (p.auth_type.type === "PrivateKey") {
        return (p.auth_type.key_path || "").toLowerCase().includes(q);
      }
      return false;
    });
  }, [profiles, query]);

  const authType = editing?.auth_type.type ?? "Password";

  useEffect(() => {
    if (!open || !editing) return;
    if (editing.auth_type.type !== "PrivateKey") return;
    // 判断初始模式：如果有 key_content 则是 manual，如果有 key_path 则是 path，否则是 create
    if (editing.auth_type.key_content) {
      setPkMode("manual");
    } else if (editing.auth_type.key_path) {
      setPkMode("path");
    } else {
      setPkMode("create");
    }
    setGenComment(editing.name || "");
    setGenPassphrase(editing.auth_type.passphrase ?? "");
    setGenError(null);
  }, [open, editing]);

  const canSave = useMemo(() => {
    if (!editing) return false;
    if (!editing.name.trim()) return false;
    if (!editing.username.trim()) return false;
    if (editing.auth_type.type === "Password") {
      return !!editing.auth_type.password;
    }
    // 私钥模式：需要有 key_path 或 key_content
    return !!editing.auth_type.key_path || !!editing.auth_type.key_content;
  }, [editing]);

  const onAdd = () => {
    setEditing(createEmptyProfile(t("keys.defaultName")));
    setOpen(true);
  };

  const onEdit = (p: AuthProfile) => {
    setEditing(p);
    setOpen(true);
  };

  const onDelete = async (id: string) => {
    const next = profiles.filter((p) => p.id !== id);
    await saveProfiles(next);
  };

  const onSave = async () => {
    if (!editing) return;
    const exists = profiles.some((p) => p.id === editing.id);
    const next = exists
      ? profiles.map((p) => (p.id === editing.id ? editing : p))
      : [...profiles, editing];
    await saveProfiles(next);
    setOpen(false);
    setEditing(null);
  };

  const copyText = async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  };

  const onGenerateKey = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      setGenError(t("keys.error.nameRequired"));
      return;
    }

    setGenBusy(true);
    setGenError(null);
    try {
      const res = await generateKeypair({
        algorithm: genAlg,
        name: editing.name.trim(),
        passphrase: genPassphrase || undefined,
        comment: genComment || editing.name.trim(),
      });

      setEditing((prev) => {
        if (!prev) return prev;
        if (prev.auth_type.type !== "PrivateKey") return prev;
        return {
          ...prev,
          auth_type: {
            ...prev.auth_type,
            key_path: res.key_path,
            passphrase: genPassphrase || prev.auth_type.passphrase,
          },
          public_key: res.public_key,
        };
      });
      setPkMode("path");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setGenError(msg);
    } finally {
      setGenBusy(false);
    }
  };

  return (
    <div className="keys-page">
      <div className="keys-header">
        <div className="keys-header-left">
          <h1>{t("keys.title")}</h1>
          <div className="keys-subtitle">{t("keys.subtitle")}</div>
        </div>
        <div className="keys-header-right">
          <div className="keys-search">
            <span className="keys-search-icon" aria-hidden="true">
              <AppIcon icon="material-symbols:search-rounded" size={18} />
            </span>
            <input
              className="keys-search-input"
              type="text"
              placeholder={t("keys.search.placeholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" type="button" onClick={onAdd}>
            <AppIcon icon="material-symbols:add-rounded" size={18} />
            {t("keys.action.add")}
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon" aria-hidden="true">
            <AppIcon icon="material-symbols:key-rounded" size={64} />
          </span>
          <div>
            <h3>{t("keys.empty.title")}</h3>
            <p>{t("keys.empty.desc")}</p>
          </div>
        </div>
      ) : (
        <div className="keys-list">
          {filtered.map((p) => (
            <div key={p.id} className="keys-item">
              <div className="keys-item-main">
                <div className="keys-item-title">
                  <span className="keys-item-name">{p.name}</span>
                  <span className="keys-item-badge">
                    {formatAuthType(p.auth_type, t)}
                  </span>
                </div>
                <div className="keys-item-meta">
                  <span className="keys-item-meta-chip">
                    <AppIcon icon="material-symbols:person-rounded" size={16} />
                    {p.username}
                  </span>
                  {p.auth_type.type === "PrivateKey" && (
                    <span className="keys-item-meta-chip" title={p.auth_type.key_path}>
                      <AppIcon icon="material-symbols:description-rounded" size={16} />
                      <span className="keys-item-path">{p.auth_type.key_path}</span>
                    </span>
                  )}
                </div>
              </div>
              <div className="keys-item-actions">
                <button className="btn btn-secondary btn-sm" onClick={() => onEdit(p)}>
                  <AppIcon icon="material-symbols:edit-rounded" size={16} />
                  {t("common.edit")}
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => void onDelete(p.id)}>
                  <AppIcon icon="material-symbols:delete-rounded" size={16} />
                  {t("common.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={open}
        title={
          editing && profiles.some((p) => p.id === editing.id)
            ? t("keys.modal.editTitle")
            : t("keys.modal.addTitle")
        }
        onClose={() => {
          setOpen(false);
          setEditing(null);
        }}
        width={720}
      >
        {editing && (
          <div className="keys-form">
            <div className="form-group">
              <label>{t("keys.field.name")}</label>
              <input
                type="text"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder={t("keys.field.namePlaceholder")}
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>{t("keys.field.username")}</label>
                <input
                  type="text"
                  value={editing.username}
                  onChange={(e) =>
                    setEditing({ ...editing, username: e.target.value })
                  }
                  placeholder="root"
                />
              </div>

              <div className="form-group">
                <label>{t("keys.field.authType")}</label>
                <div className="auth-type-selector">
                  <button
                    className={`auth-type-btn ${authType === "Password" ? "active" : ""}`}
                    onClick={() =>
                      setEditing({
                        ...editing,
                        auth_type: { type: "Password", password: "" },
                      })
                    }
                  >
                    {t("keys.auth.password")}
                  </button>
                  <button
                    className={`auth-type-btn ${authType === "PrivateKey" ? "active" : ""}`}
                    onClick={() =>
                      setEditing({
                        ...editing,
                        auth_type: { type: "PrivateKey", key_path: "", passphrase: "" },
                        public_key: undefined,
                      })
                    }
                  >
                    {t("keys.auth.key")}
                  </button>
                </div>
              </div>
            </div>

            {authType === "Password" && (
              <div className="form-group">
                <label>{t("connections.password")}</label>
                <div className="password-input-wrapper">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={(editing.auth_type as any).password || ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        auth_type: { type: "Password", password: e.target.value },
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
                      icon={showPassword ? "material-symbols:visibility-off-rounded" : "material-symbols:visibility-rounded"}
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
                    className={`keys-pk-mode-btn ${pkMode === "path" ? "active" : ""}`}
                    onClick={() => setPkMode("path")}
                  >
                    {t("connections.pkMode.path")}
                  </button>
                  <button
                    type="button"
                    className={`keys-pk-mode-btn ${pkMode === "manual" ? "active" : ""}`}
                    onClick={() => setPkMode("manual")}
                  >
                    {t("connections.pkMode.manual")}
                  </button>
                  <button
                    type="button"
                    className={`keys-pk-mode-btn ${pkMode === "create" ? "active" : ""}`}
                    onClick={() => setPkMode("create")}
                  >
                    {t("keys.pkMode.create")}
                  </button>
                </div>

                {pkMode === "path" && (
                  <>
                    <div className="form-group">
                      <label>{t("connections.pk.path")}</label>
                      <input
                        type="text"
                        value={(editing.auth_type as any).key_path || ""}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            auth_type: {
                              ...(editing.auth_type as any),
                              type: "PrivateKey",
                              key_path: e.target.value,
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
                          value={(editing.auth_type as any).passphrase || ""}
                          onChange={(e) =>
                            setEditing({
                              ...editing,
                              auth_type: {
                                ...(editing.auth_type as any),
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
                            icon={showPassphrase ? "material-symbols:visibility-off-rounded" : "material-symbols:visibility-rounded"}
                            size={20}
                          />
                        </button>
                      </div>
                    </div>

                    {editing.public_key && (
                      <div className="keys-pubkey">
                        <div className="keys-pubkey-header">
                          <div className="keys-pubkey-title">
                            {t("keys.publicKey.title")}
                          </div>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => void copyText(editing.public_key || "")}
                          >
                            <AppIcon icon="material-symbols:content-copy-rounded" size={16} />
                            {t("keys.publicKey.copy")}
                          </button>
                        </div>
                        <textarea
                          className="keys-pubkey-textarea"
                          readOnly
                          value={editing.public_key}
                        />
                      </div>
                    )}
                  </>
                )}

                {pkMode === "create" && (
                  <div className="keys-generate">
                    <div className="form-row">
                      <div className="form-group">
                        <label>{t("keys.generate.algorithm")}</label>
                        <Select
                          value={genAlg}
                          onChange={(nextValue) =>
                            setGenAlg(nextValue as GenerateKeyAlgorithm)
                          }
                          options={[
                            {
                              value: "ed25519",
                              label: t("keys.generate.algorithm.ed25519"),
                            },
                            { value: "rsa4096", label: "rsa 4096" },
                          ]}
                        />
                      </div>
                      <div className="form-group">
                        <label>{t("keys.generate.comment")}</label>
                        <input
                          type="text"
                          value={genComment}
                          onChange={(e) => setGenComment(e.target.value)}
                          placeholder={t("keys.generate.commentPlaceholder")}
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label>{t("connections.pk.passphraseOptional")}</label>
                      <div className="password-input-wrapper">
                        <input
                          type={showGenPassphrase ? "text" : "password"}
                          value={genPassphrase}
                          onChange={(e) => setGenPassphrase(e.target.value)}
                          placeholder={t("keys.generate.passphrasePlaceholder")}
                        />
                        <button
                          type="button"
                          className="password-toggle-btn"
                          onClick={() => setShowGenPassphrase(!showGenPassphrase)}
                          title={
                            showGenPassphrase
                              ? t("connections.password.hide")
                              : t("connections.password.show")
                          }
                        >
                          <AppIcon
                            icon={showGenPassphrase ? "material-symbols:visibility-off-rounded" : "material-symbols:visibility-rounded"}
                            size={20}
                          />
                        </button>
                      </div>
                    </div>

                    {genError && <div className="keys-error">{genError}</div>}

                    <div className="keys-generate-actions">
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void onGenerateKey()}
                        disabled={genBusy}
                      >
                        <AppIcon icon="material-symbols:key-vertical-rounded" size={18} />
                        {genBusy
                          ? t("keys.generate.running")
                          : t("keys.generate.action")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setPkMode("path")}
                        disabled={genBusy}
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  </div>
                )}

                {pkMode === "manual" && (
                  <div className="keys-manual">
                    <div className="form-group">
                      <label>{t("connections.pk.content")}</label>
                      <textarea
                        className="keys-pem-textarea"
                        value={(editing.auth_type as any).key_content || ""}
                        onChange={(e) => {
                          const content = e.target.value;
                          setEditing({
                            ...editing,
                            auth_type: {
                              ...(editing.auth_type as any),
                              type: "PrivateKey",
                              key_path: "", // 清空 path，因为使用的是 content
                              key_content: content,
                            },
                          });
                          // 实时验证
                          if (content.trim()) {
                            setPemValidation(validatePemKey(content, t));
                          } else {
                            setPemValidation(null);
                          }
                        }}
                        onBlur={(e) => {
                          // 失去焦点时验证
                          const content = e.target.value;
                          if (content.trim()) {
                            setPemValidation(validatePemKey(content, t));
                          }
                        }}
                        placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;MIIEpAIBAAKCAQEA...&#10;-----END RSA PRIVATE KEY-----"
                        rows={12}
                      />
                      {pemValidation && (
                        <div className={`keys-validation ${pemValidation.valid ? 'valid' : 'invalid'}`}>
                          <AppIcon 
                            icon={pemValidation.valid ? "material-symbols:check-circle-rounded" : "material-symbols:error-rounded"} 
                            size={16} 
                          />
                          {pemValidation.message}
                        </div>
                      )}
                      <div className="keys-hint">
                        <strong>{t("connections.pk.hint.title")}</strong>
                        {t("connections.pk.hint.desc")}
                        <br />
                        • <code>-----BEGIN RSA PRIVATE KEY-----</code> (OpenSSH RSA)
                        <br />
                        • <code>-----BEGIN OPENSSH PRIVATE KEY-----</code> (
                        {t("connections.pk.hint.opensshNew")})
                        <br />
                        • <code>-----BEGIN EC PRIVATE KEY-----</code> (ECDSA)
                        <br />• {t("connections.pk.hint.ensureFull")}
                      </div>
                    </div>

                    <div className="form-group">
                      <label>{t("connections.pk.passphraseOptional")}</label>
                      <div className="password-input-wrapper">
                        <input
                          type={showPassphrase ? "text" : "password"}
                          value={(editing.auth_type as any).passphrase || ""}
                          onChange={(e) =>
                            setEditing({
                              ...editing,
                              auth_type: {
                                ...(editing.auth_type as any),
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
                            icon={showPassphrase ? "material-symbols:visibility-off-rounded" : "material-symbols:visibility-rounded"}
                            size={20}
                          />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="keys-form-actions">
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => void onSave()}
                disabled={!canSave}
              >
                {t("common.save")}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  setOpen(false);
                  setEditing(null);
                }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
