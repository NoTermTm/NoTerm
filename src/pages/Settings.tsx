import { useState } from 'react';
import './Settings.css';

export function SettingsPage() {
  const [settings, setSettings] = useState({
    autoConnect: false,
    savePassword: true,
    theme: 'dark',
    fontSize: '13',
    keepAlive: true,
    keepAliveInterval: '60',
  });

  const toggleSetting = (key: string) => {
    setSettings((prev) => ({
      ...prev,
      [key]: !prev[key as keyof typeof prev],
    }));
  };

  const updateSetting = (key: string, value: string) => {
    setSettings((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  return (
    <div className="settings-page">
      <h1>设置</h1>

      <div className="settings-section">
        <h2>连接设置</h2>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">自动重连</div>
            <div className="settings-item-description">连接断开时自动尝试重新连接</div>
          </div>
          <div className="settings-item-control">
            <div
              className={`toggle-switch ${settings.autoConnect ? 'active' : ''}`}
              onClick={() => toggleSetting('autoConnect')}
            >
              <div className="toggle-switch-handle" />
            </div>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">保存密码</div>
            <div className="settings-item-description">在本地安全存储连接密码</div>
          </div>
          <div className="settings-item-control">
            <div
              className={`toggle-switch ${settings.savePassword ? 'active' : ''}`}
              onClick={() => toggleSetting('savePassword')}
            >
              <div className="toggle-switch-handle" />
            </div>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">保持连接</div>
            <div className="settings-item-description">定期发送心跳包保持 SSH 连接活跃</div>
          </div>
          <div className="settings-item-control">
            <div
              className={`toggle-switch ${settings.keepAlive ? 'active' : ''}`}
              onClick={() => toggleSetting('keepAlive')}
            >
              <div className="toggle-switch-handle" />
            </div>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">心跳间隔（秒）</div>
            <div className="settings-item-description">保持连接的心跳包发送间隔</div>
          </div>
          <div className="settings-item-control">
            <input
              type="number"
              className="settings-input"
              value={settings.keepAliveInterval}
              onChange={(e) => updateSetting('keepAliveInterval', e.target.value)}
              disabled={!settings.keepAlive}
            />
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h2>终端设置</h2>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">主题</div>
            <div className="settings-item-description">终端配色方案</div>
          </div>
          <div className="settings-item-control">
            <select
              className="settings-select"
              value={settings.theme}
              onChange={(e) => updateSetting('theme', e.target.value)}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="monokai">Monokai</option>
              <option value="solarized">Solarized</option>
            </select>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">字体大小</div>
            <div className="settings-item-description">终端字体大小（像素）</div>
          </div>
          <div className="settings-item-control">
            <select
              className="settings-select"
              value={settings.fontSize}
              onChange={(e) => updateSetting('fontSize', e.target.value)}
            >
              <option value="11">11px</option>
              <option value="12">12px</option>
              <option value="13">13px</option>
              <option value="14">14px</option>
              <option value="15">15px</option>
              <option value="16">16px</option>
            </select>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h2>关于</h2>
        <div className="app-info">
          <div className="app-info-row">
            <span className="app-info-label">应用名称</span>
            <span>SSH Manager</span>
          </div>
          <div className="app-info-row">
            <span className="app-info-label">版本</span>
            <span>0.1.0</span>
          </div>
          <div className="app-info-row">
            <span className="app-info-label">框架</span>
            <span>Tauri 2 + React</span>
          </div>
          <div className="app-info-row">
            <span className="app-info-label">构建日期</span>
            <span>2026-02-09</span>
          </div>
        </div>
      </div>
    </div>
  );
}
