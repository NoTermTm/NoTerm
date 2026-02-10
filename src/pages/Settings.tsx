import { useEffect, useState } from "react";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  writeAppSetting,
  getAppSettingsStore,
  DEFAULT_TERMINAL_FONT_FAMILY,
} from "../store/appSettings";
import { TERMINAL_THEME_OPTIONS } from "../terminal/xtermThemes";
import './Settings.css';

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);

  useEffect(() => {
    let disposed = false;
    const run = async () => {
      const store = await getAppSettingsStore();
      const next: AppSettings = {
        "connection.autoConnect":
          (await store.get<boolean>("connection.autoConnect")) ??
          DEFAULT_APP_SETTINGS["connection.autoConnect"],
        "connection.savePassword":
          (await store.get<boolean>("connection.savePassword")) ??
          DEFAULT_APP_SETTINGS["connection.savePassword"],
        "connection.keepAlive":
          (await store.get<boolean>("connection.keepAlive")) ??
          DEFAULT_APP_SETTINGS["connection.keepAlive"],
        "connection.keepAliveInterval":
          (await store.get<number>("connection.keepAliveInterval")) ??
          DEFAULT_APP_SETTINGS["connection.keepAliveInterval"],
        "terminal.theme":
          (await store.get<AppSettings["terminal.theme"]>("terminal.theme")) ??
          DEFAULT_APP_SETTINGS["terminal.theme"],
        "terminal.fontSize":
          (await store.get<number>("terminal.fontSize")) ??
          DEFAULT_APP_SETTINGS["terminal.fontSize"],
        "terminal.fontFamily":
          (await store.get<string>("terminal.fontFamily")) ??
          DEFAULT_APP_SETTINGS["terminal.fontFamily"],
      };
      if (!disposed) setSettings(next);
    };

    void run();
    return () => {
      disposed = true;
    };
  }, []);

  const toggleSetting = <K extends keyof AppSettings>(key: K) => {
    setSettings((prev) => {
      const next = (!prev[key]) as AppSettings[K];
      void writeAppSetting(key, next);
      return { ...prev, [key]: next };
    });
  };

  const updateSetting = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => {
    setSettings((prev) => {
      void writeAppSetting(key, value);
      return { ...prev, [key]: value };
    });
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
              className={`toggle-switch ${settings["connection.autoConnect"] ? "active" : ""}`}
              onClick={() => toggleSetting("connection.autoConnect")}
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
              className={`toggle-switch ${settings["connection.savePassword"] ? "active" : ""}`}
              onClick={() => toggleSetting("connection.savePassword")}
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
              className={`toggle-switch ${settings["connection.keepAlive"] ? "active" : ""}`}
              onClick={() => toggleSetting("connection.keepAlive")}
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
              value={settings["connection.keepAliveInterval"]}
              onChange={(e) =>
                updateSetting(
                  "connection.keepAliveInterval",
                  Math.max(1, parseInt(e.target.value || "0", 10) || 0),
                )
              }
              disabled={!settings["connection.keepAlive"]}
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
              value={settings["terminal.theme"]}
              onChange={(e) =>
                updateSetting("terminal.theme", e.target.value as AppSettings["terminal.theme"])
              }
            >
              {TERMINAL_THEME_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
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
              value={String(settings["terminal.fontSize"])}
              onChange={(e) =>
                updateSetting(
                  "terminal.fontSize",
                  Math.max(9, parseInt(e.target.value, 10) || DEFAULT_APP_SETTINGS["terminal.fontSize"]),
                )
              }
            >
              <option value="11">11px</option>
              <option value="12">12px</option>
              <option value="13">13px</option>
              <option value="14">14px</option>
              <option value="15">15px</option>
              <option value="16">16px</option>
              <option value="18">18px</option>
            </select>
          </div>
        </div>

        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">字体</div>
            <div className="settings-item-description">
              终端字体（font-family），例如：SF Mono, JetBrains Mono, Fira Code
            </div>
          </div>
          <div className="settings-item-control">
            <input
              type="text"
              className="settings-input"
              value={settings["terminal.fontFamily"]}
              placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
              onChange={(e) =>
                updateSetting(
                  "terminal.fontFamily",
                  e.target.value.trim() || DEFAULT_TERMINAL_FONT_FAMILY,
                )
              }
            />
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h2>关于</h2>
        <div className="app-info">
          <div className="app-info-row">
            <span className="app-info-label">应用名称</span>
            <span>NoTerm</span>
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
