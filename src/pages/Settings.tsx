import { useEffect, useState } from "react";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  writeAppSetting,
  getAppSettingsStore,
  DEFAULT_TERMINAL_FONT_FAMILY,
} from "../store/appSettings";
import { TERMINAL_THEME_OPTIONS, getXtermTheme } from "../terminal/xtermThemes";
import './Settings.css';

const TERMINAL_FONT_OPTIONS = [
  { label: "SF Mono", value: '"SF Mono", Monaco, Menlo, "Ubuntu Mono", monospace' },
  { label: "JetBrains Mono", value: '"JetBrains Mono", "SF Mono", Menlo, monospace' },
  { label: "Fira Code", value: '"Fira Code", "SF Mono", Menlo, monospace' },
  { label: "Hack", value: 'Hack, "SF Mono", Menlo, monospace' },
  { label: "Source Code Pro", value: '"Source Code Pro", "SF Mono", Menlo, monospace' },
  { label: "Ubuntu Mono", value: '"Ubuntu Mono", "SF Mono", Menlo, monospace' },
  { label: "Menlo", value: 'Menlo, "SF Mono", monospace' },
];

const TERMINAL_FONT_WEIGHT_OPTIONS = [
  { label: "Regular", value: 400 },
  { label: "Medium", value: 500 },
  { label: "Semibold", value: 600 },
  { label: "Bold", value: 700 },
];

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const previewTheme = getXtermTheme(settings["terminal.theme"]);
  const previewSelection = previewTheme.selectionBackground ?? "rgba(15, 143, 255, 0.18)";

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
        "terminal.fontWeight":
          (await store.get<number>("terminal.fontWeight")) ??
          DEFAULT_APP_SETTINGS["terminal.fontWeight"],
        "terminal.cursorStyle":
          (await store.get<AppSettings["terminal.cursorStyle"]>("terminal.cursorStyle")) ??
          DEFAULT_APP_SETTINGS["terminal.cursorStyle"],
        "terminal.cursorBlink":
          (await store.get<boolean>("terminal.cursorBlink")) ??
          DEFAULT_APP_SETTINGS["terminal.cursorBlink"],
        "terminal.lineHeight":
          (await store.get<number>("terminal.lineHeight")) ??
          DEFAULT_APP_SETTINGS["terminal.lineHeight"],
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
        <div className="settings-card">
          <div className="settings-card-body">
            <div className="settings-card-controls">
              <div className="settings-row settings-row--single">
                <div className="settings-field">
                  <label className="settings-field-label">主题</label>
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
              <div className="settings-row settings-row--three">
                <div className="settings-field">
                  <label className="settings-field-label">字体样式</label>
                  <select
                    className="settings-select"
                    value={settings["terminal.fontFamily"]}
                    onChange={(e) =>
                      updateSetting(
                        "terminal.fontFamily",
                        e.target.value || DEFAULT_TERMINAL_FONT_FAMILY,
                      )
                    }
                  >
                    {TERMINAL_FONT_OPTIONS.map((opt) => (
                      <option key={opt.label} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">字重</label>
                  <select
                    className="settings-select"
                    value={String(settings["terminal.fontWeight"])}
                    onChange={(e) =>
                      updateSetting(
                        "terminal.fontWeight",
                        parseInt(e.target.value, 10) || DEFAULT_APP_SETTINGS["terminal.fontWeight"],
                      )
                    }
                  >
                    {TERMINAL_FONT_WEIGHT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">字号</label>
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
                    <option value="11">11</option>
                    <option value="12">12</option>
                    <option value="13">13</option>
                    <option value="14">14</option>
                    <option value="15">15</option>
                    <option value="16">16</option>
                    <option value="18">18</option>
                  </select>
                </div>
              </div>
              <div className="settings-row settings-row--two">
                <div className="settings-field">
                  <label className="settings-field-label">光标形状</label>
                  <select
                    className="settings-select"
                    value={settings["terminal.cursorStyle"]}
                    onChange={(e) =>
                      updateSetting(
                        "terminal.cursorStyle",
                        e.target.value as AppSettings["terminal.cursorStyle"],
                      )
                    }
                  >
                    <option value="block">块状</option>
                    <option value="underline">下划线</option>
                    <option value="bar">竖线</option>
                  </select>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">是否开启光标闪烁</label>
                  <div
                    className={`toggle-switch ${settings["terminal.cursorBlink"] ? "active" : ""}`}
                    onClick={() => updateSetting("terminal.cursorBlink", !settings["terminal.cursorBlink"])}
                  >
                    <div className="toggle-switch-handle" />
                  </div>
                </div>
              </div>
              <div className="settings-row settings-row--single">
                <div className="settings-field">
                  <label className="settings-field-label">行间距</label>
                  <select
                    className="settings-select"
                    value={String(settings["terminal.lineHeight"])}
                    onChange={(e) =>
                      updateSetting(
                        "terminal.lineHeight",
                        Math.max(1, Math.min(2, parseFloat(e.target.value) || DEFAULT_APP_SETTINGS["terminal.lineHeight"])),
                      )
                    }
                  >
                    <option value="1">1.0</option>
                    <option value="1.2">1.2</option>
                    <option value="1.4">1.4</option>
                    <option value="1.6">1.6</option>
                    <option value="1.8">1.8</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="settings-card-preview">
              <div className="settings-preview-header">字体设置预览</div>
              <div className="settings-preview-window">
                <div className="settings-preview-titlebar">
                  <span className="settings-preview-dot settings-preview-dot--red" />
                  <span className="settings-preview-dot settings-preview-dot--yellow" />
                  <span className="settings-preview-dot settings-preview-dot--green" />
                </div>
                <pre
                  className="settings-preview-content"
                  style={{
                    fontFamily: settings["terminal.fontFamily"],
                    fontSize: settings["terminal.fontSize"],
                    fontWeight: settings["terminal.fontWeight"],
                    background: previewTheme.background,
                    color: previewTheme.foreground,
                    lineHeight: settings["terminal.lineHeight"],
                  }}
                >
                  <span style={{ color: previewTheme.green }}>orcatem</span>{" "}
                  <span style={{ color: previewTheme.blue }}>OpenCloudOS</span>$ ls
                  {"\n"}-drwxr-xr-x 1 root  <span style={{ color: previewTheme.yellow }}>Document</span>
                  {"\n"}-drwxr-xr-x 1 root  <span style={{ background: previewTheme.green, color: previewTheme.background, padding: "0 4px", borderRadius: 3 }}>Downloads</span>
                  {"\n"}-drwxr-xr-x 1 root  <span style={{ background: previewSelection, color: previewTheme.foreground, padding: "0 4px", borderRadius: 3 }}>Pictures</span>
                  {"\n"}-drwxr-xr-x 1 root
                </pre>
              </div>
            </div>
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
