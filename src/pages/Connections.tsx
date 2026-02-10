import { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Server, Play, Square, Edit2, Trash2, Search } from 'lucide-react';
import { SshConnection } from '../types/ssh';
import { sshApi } from '../api/ssh';
import { load } from '@tauri-apps/plugin-store';
import { XTerminal } from '../components/XTerminal';
import { SlidePanel } from '../components/SlidePanel';
import { Tab } from '../components/TitleBar';
import './Connections.css';

let store: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!store) {
    store = await load('connections.json');
  }
  return store;
}

interface OutletContext {
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

interface SessionTab extends Tab {
  connectionId: string;
}

export function ConnectionsPage() {
  const { activePanel, tabs, setTabs, activeTabId, setActiveTabId } = useOutletContext<OutletContext>();
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [selectedConnection, setSelectedConnection] = useState<SshConnection | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SshConnection | null>(null);
  const [connectedSessions, setConnectedSessions] = useState<Set<string>>(new Set());
  const [shellOpenedSessions, setShellOpenedSessions] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    const s = await getStore();
    const saved = await s.get<SshConnection[]>('connections');
    if (saved) {
      setConnections(saved);
    }
  };

  const saveConnections = async (conns: SshConnection[]) => {
    const s = await getStore();
    await s.set('connections', conns);
    await s.save();
    setConnections(conns);
  };

  const handleAddConnection = () => {
    const newConnection: SshConnection = {
      id: crypto.randomUUID(),
      name: '新连接',
      host: '',
      port: 22,
      username: '',
      auth_type: { type: 'Password', password: '' },
    };
    setEditingConnection(newConnection);
    setSelectedConnection(newConnection);
    setIsEditing(true);
  };

  const handleSaveConnection = async () => {
    if (!editingConnection) return;

    const existingIndex = connections.findIndex((c) => c.id === editingConnection.id);
    let updatedConnections: SshConnection[];

    if (existingIndex >= 0) {
      updatedConnections = [...connections];
      updatedConnections[existingIndex] = editingConnection;
    } else {
      updatedConnections = [...connections, editingConnection];
    }

    await saveConnections(updatedConnections);
    setSelectedConnection(editingConnection);
    setIsEditing(false);
    setEditingConnection(null);
  };

  const handleDeleteConnection = async (id: string) => {
    if (connectedSessions.has(id)) {
      await handleDisconnect(id);
    }
    const updatedConnections = connections.filter((c) => c.id !== id);
    await saveConnections(updatedConnections);
    if (selectedConnection?.id === id) {
      setSelectedConnection(null);
    }
  };

  const handleConnect = async (connection: SshConnection) => {
    try {
      console.log('Connecting to:', connection);
      const sessionId = await sshApi.connect(connection);
      console.log('Connected, session ID:', sessionId);
      
      // 打开 shell
      await sshApi.openShell(sessionId);
      console.log('Shell opened for session:', sessionId);
      
      setConnectedSessions((prev) => new Set(prev).add(connection.id));
      setShellOpenedSessions((prev) => new Set(prev).add(connection.id));
      
      // 创建新的标签页
      const newTab: Tab = {
        id: connection.id,
        title: connection.name,
        subtitle: `${connection.username}@${connection.host}`,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(connection.id);
      setSelectedConnection(connection);
    } catch (error) {
      console.error('Connection error:', error);
      alert(`连接失败: ${error}`);
    }
  };

  const handleDisconnect = async (sessionId: string) => {
    try {
      await sshApi.disconnect(sessionId);
      setConnectedSessions((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      setShellOpenedSessions((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      
      // 移除标签页
      setTabs((prev) => prev.filter((tab) => tab.id !== sessionId));
      if (activeTabId === sessionId) {
        setActiveTabId(null);
        setSelectedConnection(null);
      }
    } catch (error) {
      console.error('Disconnect error:', error);
    }
  };

  const handleTabClick = (tabId: string) => {
    setActiveTabId(tabId);
    const conn = connections.find((c) => c.id === tabId);
    if (conn) {
      setSelectedConnection(conn);
      setIsEditing(false);
    }
  };

  const handleTabClose = async (tabId: string) => {
    await handleDisconnect(tabId);
  };

  const handleNewTab = () => {
    // 打开连接面板
    setIsEditing(false);
    setSelectedConnection(null);
  };

  const renderConnectionForm = () => {
    if (!editingConnection) return null;

    const authType = editingConnection.auth_type.type;

    return (
      <div className="connection-form">
        <div className="form-group">
          <label>连接名称</label>
          <input
            type="text"
            value={editingConnection.name}
            onChange={(e) =>
              setEditingConnection({ ...editingConnection, name: e.target.value })
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
                setEditingConnection({ ...editingConnection, host: e.target.value })
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
                setEditingConnection({ ...editingConnection, port: parseInt(e.target.value) })
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
              setEditingConnection({ ...editingConnection, username: e.target.value })
            }
            placeholder="root"
          />
        </div>

        <div className="form-group">
          <label>认证方式</label>
          <div className="auth-type-selector">
            <button
              className={`auth-type-btn ${authType === 'Password' ? 'active' : ''}`}
              onClick={() =>
                setEditingConnection({
                  ...editingConnection,
                  auth_type: { type: 'Password', password: '' },
                })
              }
            >
              密码
            </button>
            <button
              className={`auth-type-btn ${authType === 'PrivateKey' ? 'active' : ''}`}
              onClick={() =>
                setEditingConnection({
                  ...editingConnection,
                  auth_type: { type: 'PrivateKey', key_path: '', passphrase: '' },
                })
              }
            >
              私钥
            </button>
          </div>
        </div>

        {authType === 'Password' && (
          <div className="form-group">
            <label>密码</label>
            <input
              type="password"
              value={(editingConnection.auth_type as any).password || ''}
              onChange={(e) =>
                setEditingConnection({
                  ...editingConnection,
                  auth_type: { type: 'Password', password: e.target.value },
                })
              }
            />
          </div>
        )}

        {authType === 'PrivateKey' && (
          <>
            <div className="form-group">
              <label>私钥路径</label>
              <input
                type="text"
                value={(editingConnection.auth_type as any).key_path || ''}
                onChange={(e) =>
                  setEditingConnection({
                    ...editingConnection,
                    auth_type: {
                      ...(editingConnection.auth_type as any),
                      type: 'PrivateKey',
                      key_path: e.target.value,
                    },
                  })
                }
                placeholder="/home/user/.ssh/id_rsa"
              />
            </div>
            <div className="form-group">
              <label>私钥密码（可选）</label>
              <input
                type="password"
                value={(editingConnection.auth_type as any).passphrase || ''}
                onChange={(e) =>
                  setEditingConnection({
                    ...editingConnection,
                    auth_type: {
                      ...(editingConnection.auth_type as any),
                      type: 'PrivateKey',
                      passphrase: e.target.value,
                    },
                  })
                }
              />
            </div>
          </>
        )}

        <div className="connection-detail-actions">
          <button className="btn btn-primary" onClick={handleSaveConnection}>
            保存
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              setIsEditing(false);
              setEditingConnection(null);
            }}
          >
            取消
          </button>
        </div>
      </div>
    );
  };

  const renderConnectionDetail = () => {
    // 如果有活跃的标签页，显示对应的终端
    if (activeTabId && connectedSessions.has(activeTabId) && shellOpenedSessions.has(activeTabId)) {
      const conn = connections.find(c => c.id === activeTabId);
      if (conn) {
        return (
          <div className="terminal-fullscreen">
            <div className="terminal-container">
              <XTerminal sessionId={conn.id} />
            </div>
          </div>
        );
      }
    }

    if (!selectedConnection && !isEditing) {
      return (
        <div className="empty-state">
          <Server size={64} className="empty-state-icon" />
          <div>
            <h3>未选择连接</h3>
            <p>从左侧选择一个连接，或创建新的 SSH 连接</p>
          </div>
        </div>
      );
    }

    if (isEditing) {
      return (
        <div className="connection-edit-container">
          {renderConnectionForm()}
        </div>
      );
    }

    if (!selectedConnection) {
      return null;
    }

    const isConnected = connectedSessions.has(selectedConnection.id);

    // 如果已连接，显示在标签页中，这里不再重复显示
    if (isConnected) {
      return null;
    }

    // 未连接时显示连接信息
    return (
      <>
        <div className="connection-detail-header">
          <div>
            <h1 className="connection-detail-title">{selectedConnection.name}</h1>
            <div style={{ marginTop: '8px' }}>
              <span className={`connection-status disconnected`}>
                <span className="status-dot" />
                未连接
              </span>
            </div>
          </div>
          <div className="connection-detail-actions">
            <button className="btn btn-primary" onClick={() => handleConnect(selectedConnection)}>
              <Play size={16} />
              连接
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setEditingConnection(selectedConnection);
                setIsEditing(true);
              }}
            >
              <Edit2 size={16} />
              编辑
            </button>
          </div>
        </div>

        <div className="connection-form">
          <div className="form-group">
            <label>主机信息</label>
            <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
              {selectedConnection.username}@{selectedConnection.host}:{selectedConnection.port}
            </div>
          </div>

          <div className="form-group">
            <label>认证方式</label>
            <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
              {selectedConnection.auth_type.type === 'Password' ? '密码认证' : '私钥认证'}
            </div>
          </div>
        </div>
      </>
    );
  };

  const filteredConnections = connections.filter(conn =>
    conn.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    conn.host.toLowerCase().includes(searchQuery.toLowerCase()) ||
    conn.username.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <>
      <div className="connections-page">
        <SlidePanel 
          isOpen={activePanel === 'connections'} 
          title="CONNECTIONS"
          onAdd={handleAddConnection}
        >
        <div className="search-box">
          <Search size={14} className="search-icon" />
          <input
            type="text"
            placeholder="Quick find..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
        </div>
        <div className="connections-list-items">
          {filteredConnections.map((conn) => (
            <div
              key={conn.id}
              className={`connection-item ${selectedConnection?.id === conn.id ? 'active' : ''} ${
                connectedSessions.has(conn.id) ? 'connected' : ''
              }`}
              onClick={() => {
                setSelectedConnection(conn);
                setIsEditing(false);
              }}
            >
              <Server size={16} className="connection-icon" />
              <div className="connection-info">
                <div className="connection-name">{conn.name}</div>
                <div className="connection-details">
                  {conn.username}@{conn.host}
                </div>
              </div>
              <div className="connection-actions">
                {!connectedSessions.has(conn.id) ? (
                  <button
                    className="connection-action-btn connection-connect-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleConnect(conn);
                    }}
                    title="连接"
                  >
                    <Play size={12} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    className="connection-action-btn connection-disconnect-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDisconnect(conn.id);
                    }}
                    title="断开"
                  >
                    <Square size={12} fill="currentColor" />
                  </button>
                )}
                <button
                  className="connection-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedConnection(conn);
                    setEditingConnection(conn);
                    setIsEditing(true);
                  }}
                  title="编辑"
                >
                  <Edit2 size={12} />
                </button>
                <button
                  className="connection-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteConnection(conn.id);
                  }}
                  title="删除"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </SlidePanel>
      
      <div className="connection-detail">
        {renderConnectionDetail()}
      </div>
      </div>
    </>
  );
};
