import { useState, useEffect, useMemo, useRef } from "react";
import { AppIcon } from "../components/AppIcon";
import { SshConnection } from "../types/ssh";
import { sshApi } from "../api/ssh";
import { load } from "@tauri-apps/plugin-store";
import { XTerminal } from "../components/XTerminal";
import { SlidePanel } from "../components/SlidePanel";
import { Modal } from "../components/Modal";
import { Tab } from "../components/TitleBar";
import type { AuthProfile } from "../types/auth";
import "./Connections.css";

// 验证 PEM 私钥格式
function validatePemKey(content: string): { valid: boolean; message: string } {
  if (!content || !content.trim()) {
    return { valid: false, message: "请输入私钥内容" };
  }

  const trimmed = content.trim();
  
  const hasBegin = /-----BEGIN\s+[A-Z\s]+PRIVATE KEY-----/.test(trimmed);
  const hasEnd = /-----END\s+[A-Z\s]+PRIVATE KEY-----/.test(trimmed);
  
  if (!hasBegin || !hasEnd) {
    return { 
      valid: false, 
      message: "格式错误：缺少 BEGIN 或 END 标记" 
    };
  }
  
  const beginMatch = trimmed.match(/-----BEGIN\s+([A-Z\s]+PRIVATE KEY)-----/);
  const endMatch = trimmed.match(/-----END\s+([A-Z\s]+PRIVATE KEY)-----/);
  
  if (beginMatch && endMatch && beginMatch[1] !== endMatch[1]) {
    return { 
      valid: false, 
      message: "格式错误：BEGIN 和 END 标记不匹配" 
    };
  }
  
  const lines = trimmed.split('\n');
  const contentLines = lines.filter(line => 
    !line.includes('-----BEGIN') && 
    !line.includes('-----END') &&
    line.trim() !== ''
  );
  
  if (contentLines.length === 0) {
    return { 
      valid: false, 
      message: "格式错误：没有私钥内容" 
    };
  }
  
  const supportedFormats = [
    'RSA PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
    'EC PRIVATE KEY',
    'DSA PRIVATE KEY',
    'PRIVATE KEY'
  ];
  
  const keyType = beginMatch ? beginMatch[1] : '';
  const isSupported = supportedFormats.some(format => keyType.includes(format));
  
  if (!isSupported) {
    return { 
      valid: false, 
      message: `不支持的密钥类型：${keyType}` 
    };
  }
  
  return { valid: true, message: "格式正确" };
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
  connection: SshConnection;
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
  const localSessionIdRef = useRef<string | null>(null);
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [selectedConnection, setSelectedConnection] =
    useState<SshConnection | null>(null);
  const [editingConnection, setEditingConnection] =
    useState<SshConnection | null>(null);
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
  const [pemValidation, setPemValidation] = useState<{ valid: boolean; message: string } | null>(null);
  const [splitLayouts, setSplitLayouts] = useState<Map<string, SplitLayout>>(new Map());
  const [splitPickerOpen, setSplitPickerOpen] = useState(false);
  const [splitPickerDirection, setSplitPickerDirection] =
    useState<SplitLayout["direction"]>("vertical");
  const [splitPickerBaseSessionId, setSplitPickerBaseSessionId] =
    useState<string | null>(null);
  const [connectPickerOpen, setConnectPickerOpen] = useState(false);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);

  useEffect(() => {
    loadConnections();
    loadAuthProfiles();
  }, []);

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
    const onOpenSplit = (event: Event) => {
      const detail = (event as CustomEvent<{
        sessionId?: string;
        direction?: SplitLayout["direction"];
      }>).detail;
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
    const saved = await s.get<SshConnection[]>("connections");
    if (saved) {
      setConnections(saved);
    }
  };

  const loadAuthProfiles = async () => {
    const s = await getKeyStore();
    const saved = await s.get<AuthProfile[]>("profiles");
    if (saved) setAuthProfiles(saved);
  };

  const saveConnections = async (conns: SshConnection[]) => {
    const s = await getStore();
    await s.set("connections", conns);
    await s.save();
    setConnections(conns);
  };

  const saveAuthProfiles = async (next: AuthProfile[]) => {
    const s = await getKeyStore();
    await s.set("profiles", next);
    await s.save();
    setAuthProfiles(next);
  };

  const handleAddConnection = () => {
    const newConnection: SshConnection = {
      id: crypto.randomUUID(),
      name: "新连接",
      host: "",
      port: 22,
      username: "",
      auth_type: { type: "Password", password: "" },
    };
    setEditingConnection(newConnection);
    setAuthProfileId("");
    setPkMode("path"); // 重置为默认模式
    setIsEditModalOpen(true);
  };

  const handlePanelClose = () => {
    setActivePanel(null);
  };

  const handleSaveConnection = async () => {
    if (!editingConnection) return;

    const existingIndex = connections.findIndex(
      (c) => c.id === editingConnection.id,
    );
    let updatedConnections: SshConnection[];

    if (existingIndex >= 0) {
      updatedConnections = [...connections];
      updatedConnections[existingIndex] = editingConnection;
    } else {
      updatedConnections = [...connections, editingConnection];
    }

    await saveConnections(updatedConnections);
    setSelectedConnection(editingConnection);
    setEditingConnection(null);
    setIsEditModalOpen(false);
  };

  const activeAuthProfile = useMemo(() => {
    if (!authProfileId) return null;
    return authProfiles.find((p) => p.id === authProfileId) ?? null;
  }, [authProfiles, authProfileId]);

  useEffect(() => {
    if (!editingConnection) return;
    if (!activeAuthProfile) return;
    setEditingConnection((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        username: activeAuthProfile.username,
        auth_type: activeAuthProfile.auth_type,
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

  const canSaveAuthProfileFromEditing = useMemo(() => {
    if (!editingConnection) return false;
    if (!editingConnection.username.trim()) return false;
    if (editingConnection.auth_type.type === "Password") {
      return !!editingConnection.auth_type.password;
    }
    // 私钥模式：需要有 key_path 或 key_content
    return !!editingConnection.auth_type.key_path || !!editingConnection.auth_type.key_content;
  }, [editingConnection]);

  const saveEditingAuthToProfiles = async () => {
    if (!editingConnection) return;
    if (!canSaveAuthProfileFromEditing) return;

    const nextProfile: AuthProfile = {
      id: crypto.randomUUID(),
      name:
        editingConnection.auth_type.type === "Password"
          ? `${editingConnection.username} / 密码`
          : `${editingConnection.username} / 私钥`,
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
    connection: SshConnection,
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
        subtitle: `${connection.username}@${connection.host}`,
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

  const handleConnect = async (connection: SshConnection) => {
    createSession(connection, true, true);
  };

  useEffect(() => {
    if (localSessionIdRef.current) return;
    const localConnection: SshConnection = {
      id: "local",
      name: "本地终端",
      host: "local",
      port: 0,
      username: "local",
      auth_type: { type: "Password", password: "" },
    };
    const sessionId = createSession(localConnection, true, true, "local");
    localSessionIdRef.current = sessionId;
  }, []);

  const openSplitPicker = (baseSessionId: string, direction: SplitLayout["direction"]) => {
    setSplitPickerBaseSessionId(baseSessionId);
    setSplitPickerDirection(direction);
    setSplitPickerOpen(true);
  };

  const handleCreateSplit = async (connection: SshConnection) => {
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
    if (!editingConnection) return;

    const trimmedHost = editingConnection.host.trim();
    const trimmedUser = editingConnection.username.trim();
    const port = Number.isFinite(editingConnection.port)
      ? editingConnection.port
      : 22;

    if (!trimmedHost) {
      setTestStatus("error");
      setTestMessage("请输入主机地址");
      return;
    }

    if (!trimmedUser) {
      setTestStatus("error");
      setTestMessage("请输入用户名");
      return;
    }

    if (editingConnection.auth_type.type === "Password") {
      const password = (editingConnection.auth_type as any).password?.trim();
      if (!password) {
        setTestStatus("error");
        setTestMessage("请输入密码");
        return;
      }
    }

    if (editingConnection.auth_type.type === "PrivateKey") {
      const keyContent = (editingConnection.auth_type as any).key_content?.trim();
      const keyPath = (editingConnection.auth_type as any).key_path?.trim();

      if (keyContent) {
        const validation = validatePemKey(keyContent);
        if (!validation.valid) {
          setTestStatus("error");
          setTestMessage(validation.message);
          return;
        }
      } else if (!keyPath) {
        setTestStatus("error");
        setTestMessage("请输入私钥路径或私钥内容");
        return;
      }
    }

    setTestStatus("testing");
    setTestMessage("正在测试连接...");

    const testConnection: SshConnection = {
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
      setTestMessage("连接成功");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTestStatus("error");
      setTestMessage(message || "连接失败");
    }
  };

  const renderConnectionForm = () => {
    if (!editingConnection) return null;

    const authType = editingConnection.auth_type.type;

    // 初始化 pkMode：如果有 key_content 则为 manual，否则为 path
    const currentPkMode = editingConnection.auth_type.type === "PrivateKey" && editingConnection.auth_type.key_content 
      ? "manual" 
      : pkMode;

    return (
      <div className="connection-form">
        <div className="form-group">
          <label>快速认证</label>
          <div className="quick-auth-row">
            <select
              className="quick-auth-select"
              value={authProfileId}
              onChange={(e) => setAuthProfileId(e.target.value)}
            >
              <option value="">不使用</option>
              {authProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.username} / {p.auth_type.type === "Password" ? "密码" : "私钥"}）
                </option>
              ))}
            </select>
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => void saveEditingAuthToProfiles()}
              disabled={!canSaveAuthProfileFromEditing}
              title="保存当前用户名和认证方式到密钥管理，便于下次快速套用"
            >
              <AppIcon icon="material-symbols:save-rounded" size={16} />
              保存为密钥
            </button>
          </div>
          <div className="quick-auth-hint">
            在“密钥管理”维护认证信息，这里可一键套用到新服务器。
          </div>
        </div>

        <div className="form-group">
          <label>连接名称</label>
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

        <div className="form-row">
          <div className="form-group">
            <label>主机地址</label>
            <input
              type="text"
              value={editingConnection.host}
              onChange={(e) =>
                setEditingConnection({
                  ...editingConnection,
                  host: e.target.value,
                })
              }
              placeholder="192.168.1.100 或 example.com"
            />
          </div>
          <div className="form-group">
            <label>端口</label>
            <input
              type="number"
              value={editingConnection.port}
              onChange={(e) =>
                setEditingConnection({
                  ...editingConnection,
                  port: parseInt(e.target.value),
                })
              }
            />
          </div>
        </div>

        <div className="form-group">
          <label>用户名</label>
          <input
            type="text"
            value={editingConnection.username}
            onChange={(e) =>
              setEditingConnection({
                ...editingConnection,
                username: e.target.value,
              })
            }
            placeholder="root"
          />
        </div>

        <div className="form-group">
          <label>认证方式</label>
          <div className="auth-type-selector">
            <button
              className={`auth-type-btn ${authType === "Password" ? "active" : ""}`}
              onClick={() =>
                setEditingConnection({
                  ...editingConnection,
                  auth_type: { type: "Password", password: "" },
                })
              }
            >
              密码
            </button>
            <button
              className={`auth-type-btn ${authType === "PrivateKey" ? "active" : ""}`}
              onClick={() =>
                setEditingConnection({
                  ...editingConnection,
                  auth_type: {
                    type: "PrivateKey",
                    key_path: "",
                    passphrase: "",
                  },
                })
              }
            >
              私钥
            </button>
          </div>
        </div>

        {authType === "Password" && (
          <div className="form-group">
            <label>密码</label>
            <div className="password-input-wrapper">
              <input
                type={showPassword ? "text" : "password"}
                value={(editingConnection.auth_type as any).password || ""}
                onChange={(e) =>
                  setEditingConnection({
                    ...editingConnection,
                    auth_type: { type: "Password", password: e.target.value },
                  })
                }
              />
              <button
                type="button"
                className="password-toggle-btn"
                onClick={() => setShowPassword(!showPassword)}
                title={showPassword ? "隐藏密码" : "显示密码"}
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
                className={`keys-pk-mode-btn ${currentPkMode === "path" ? "active" : ""}`}
                onClick={() => setPkMode("path")}
              >
                使用路径
              </button>
              <button
                type="button"
                className={`keys-pk-mode-btn ${currentPkMode === "manual" ? "active" : ""}`}
                onClick={() => setPkMode("manual")}
              >
                手动输入
              </button>
            </div>

            {currentPkMode === "path" && (
              <>
                <div className="form-group">
                  <label>私钥路径</label>
                  <input
                    type="text"
                    value={(editingConnection.auth_type as any).key_path || ""}
                    onChange={(e) =>
                      setEditingConnection({
                        ...editingConnection,
                        auth_type: {
                          ...(editingConnection.auth_type as any),
                          type: "PrivateKey",
                          key_path: e.target.value,
                          key_content: undefined, // 清空 content
                        },
                      })
                    }
                    placeholder="/home/user/.ssh/id_rsa"
                  />
                </div>
                <div className="form-group">
                  <label>私钥密码（可选）</label>
                  <div className="password-input-wrapper">
                    <input
                      type={showPassphrase ? "text" : "password"}
                      value={(editingConnection.auth_type as any).passphrase || ""}
                      onChange={(e) =>
                        setEditingConnection({
                          ...editingConnection,
                          auth_type: {
                            ...(editingConnection.auth_type as any),
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
                      title={showPassphrase ? "隐藏密码" : "显示密码"}
                    >
                      <AppIcon
                        icon={showPassphrase ? "material-symbols:visibility-off-rounded" : "material-symbols:visibility-rounded"}
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
                  <label>私钥内容（PEM 格式）</label>
                  <textarea
                    className="keys-pem-textarea"
                    value={(editingConnection.auth_type as any).key_content || ""}
                    onChange={(e) => {
                      const content = e.target.value;
                      setEditingConnection({
                        ...editingConnection,
                        auth_type: {
                          ...(editingConnection.auth_type as any),
                          type: "PrivateKey",
                          key_path: "", // 清空 path
                          key_content: content,
                        },
                      });
                      // 实时验证
                      if (content.trim()) {
                        setPemValidation(validatePemKey(content));
                      } else {
                        setPemValidation(null);
                      }
                    }}
                    onBlur={(e) => {
                      const content = e.target.value;
                      if (content.trim()) {
                        setPemValidation(validatePemKey(content));
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
                    <strong>注意：</strong>粘贴完整的 PEM 格式私钥内容，包括开始和结束标记。支持以下格式：<br/>
                    • <code>-----BEGIN RSA PRIVATE KEY-----</code> (OpenSSH RSA)<br/>
                    • <code>-----BEGIN OPENSSH PRIVATE KEY-----</code> (OpenSSH 新格式)<br/>
                    • <code>-----BEGIN EC PRIVATE KEY-----</code> (ECDSA)<br/>
                    • 确保包含完整的密钥内容和换行符
                  </div>
                </div>

                <div className="form-group">
                  <label>私钥密码（可选）</label>
                  <div className="password-input-wrapper">
                    <input
                      type={showPassphrase ? "text" : "password"}
                      value={(editingConnection.auth_type as any).passphrase || ""}
                      onChange={(e) =>
                        setEditingConnection({
                          ...editingConnection,
                          auth_type: {
                            ...(editingConnection.auth_type as any),
                            type: "PrivateKey",
                            passphrase: e.target.value,
                          },
                        })
                      }
                      placeholder="如果私钥已加密，请输入密码"
                    />
                    <button
                      type="button"
                      className="password-toggle-btn"
                      onClick={() => setShowPassphrase(!showPassphrase)}
                      title={showPassphrase ? "隐藏密码" : "显示密码"}
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

        <div className="connection-detail-actions">
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => void handleTestConnection()}
            disabled={testStatus === "testing"}
          >
            {testStatus === "testing" ? "测试中..." : "测试连接"}
          </button>
          <button className="btn btn-primary" onClick={handleSaveConnection}>
            保存
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              setEditingConnection(null);
              setIsEditModalOpen(false);
            }}
          >
            取消
          </button>
          {testMessage && (
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
      };

      return (
        <XTerminal
          sessionId={sessionId}
          host={session.connection.host}
          port={session.connection.port}
          isLocal={session.kind === "local"}
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

    return (
      <div className="empty-state">
        <span className="empty-state-icon" aria-hidden="true">
          <AppIcon icon="material-symbols:terminal-rounded" size={64} />
        </span>
        <div>
          <h3>准备好连接服务器</h3>
          <p style={{ marginTop: 20 }}>在左侧选择服务器，然后点击“连接”按钮开始会话</p>
        </div>
      </div>
    );
  };

  const filteredConnections = connections.filter(
    (conn) =>
      conn.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      conn.host.toLowerCase().includes(searchQuery.toLowerCase()) ||
      conn.username.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <>
      <div
        className={`connections-page ${activePanel === "connections" ? "connections-page--panel-open" : ""}`}
      >
        <SlidePanel
          isOpen={activePanel === "connections"}
          title="连接配置"
          onAdd={handleAddConnection}
          closePanel={handlePanelClose}
          dockToWindow
        >
          <div className="connecting-header">
            <div className="search-box">
              <input
                type="text"
                placeholder="请输入搜索内容"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="search-input"
              />
              <span className="search-icon" aria-hidden="true">
                <AppIcon icon="material-symbols:search-rounded" size={18} />
              </span>
            </div>
          </div>
          <div className="connections-list-items">
            {filteredConnections.map((conn) => (
              <div
                key={conn.id}
                className={`connection-item ${selectedConnection?.id === conn.id ? "active" : ""}`}
                onClick={() => {
                  setSelectedConnection(conn);
                }}
              >
                <span className="connection-icon" aria-hidden="true">
                  <AppIcon icon="material-symbols:dns" size={16} />
                </span>
                <div className="connection-info">
                  <div className="connection-name">{conn.name}</div>
                  <div className="connection-details">
                    {conn.username}@{conn.host}
                  </div>
                </div>
                <div className="connection-actions">
                  <button
                    className="connection-action-btn connection-connect-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleConnect(conn);
                    }}
                    title="连接"
                  >
                    <AppIcon
                      icon="material-symbols:play-arrow-rounded"
                      size={18}
                    />
                  </button>
                  <button
                    className="connection-action-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedConnection(conn);
                      setEditingConnection(conn);
                      // 根据连接的 auth_type 设置 pkMode
                      if (conn.auth_type.type === "PrivateKey") {
                        if (conn.auth_type.key_content) {
                          setPkMode("manual");
                        } else {
                          setPkMode("path");
                        }
                      }
                      setIsEditModalOpen(true);
                    }}
                    title="编辑"
                  >
                    <AppIcon icon="material-symbols:edit-rounded" size={14} />
                  </button>
                  <button
                    className="connection-action-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteConnection(conn.id);
                    }}
                    title="删除"
                  >
                    <AppIcon icon="material-symbols:delete-rounded" size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </SlidePanel>

        <div className="connection-detail">{renderConnectionDetail()}</div>
      </div>

      <Modal
        open={isEditModalOpen}
        title={
          editingConnection && connections.some((c) => c.id === editingConnection.id)
            ? "编辑服务器"
            : "添加服务器"
        }
        onClose={() => {
          setIsEditModalOpen(false);
          setEditingConnection(null);
          setAuthProfileId("");
        }}
        width={720}
      >
        {renderConnectionForm()}
      </Modal>

      <Modal
        open={splitPickerOpen}
        title={splitPickerDirection === "vertical" ? "左右分屏" : "上下分屏"}
        onClose={() => {
          setSplitPickerOpen(false);
          setSplitPickerBaseSessionId(null);
        }}
        width={520}
      >
        <div className="split-picker">
          {connections.length === 0 && (
            <div className="split-picker-empty">暂无服务器</div>
          )}
          {connections.map((conn) => (
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
        open={connectPickerOpen}
        title="选择服务器"
        onClose={() => setConnectPickerOpen(false)}
        width={520}
      >
        <div className="connect-picker">
          {connections.length === 0 && (
            <div className="connect-picker-empty">暂无服务器</div>
          )}
          {connections.map((conn) => (
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
      </Modal>
    </>
  );
}
