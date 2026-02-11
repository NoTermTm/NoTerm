import { useEffect, useState } from "react";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  writeAppSetting,
  getAppSettingsStore,
  DEFAULT_TERMINAL_FONT_FAMILY,
} from "../store/appSettings";
import { TERMINAL_THEME_OPTIONS, getXtermTheme } from "../terminal/xtermThemes";
import { sendAiChat, type AiMessage } from "../api/ai";
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

const OPENAI_MODEL_OPTIONS = [
  { label: "gpt-4o", value: "gpt-4o" },
  { label: "gpt-4o-mini", value: "gpt-4o-mini" },
  { label: "gpt-4.1", value: "gpt-4.1" },
  { label: "gpt-4.1-mini", value: "gpt-4.1-mini" },
  { label: "gpt-4.1-nano", value: "gpt-4.1-nano" },
];

const ANTHROPIC_MODEL_OPTIONS = [
  { label: "claude-sonnet-4-5-20250929", value: "claude-sonnet-4-5-20250929" },
  { label: "claude-opus-4-20250514", value: "claude-opus-4-20250514" },
  { label: "claude-3-5-sonnet-20240620", value: "claude-3-5-sonnet-20240620" },
  { label: "claude-3-5-haiku-20241022", value: "claude-3-5-haiku-20241022" },
];

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const previewTheme = getXtermTheme(settings["terminal.theme"]);
  const previewSelection = previewTheme.selectionBackground ?? "rgba(15, 143, 255, 0.18)";
  const [aiTestStatus, setAiTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [aiTestMessage, setAiTestMessage] = useState<string | null>(null);

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
        "ai.enabled":
          (await store.get<boolean>("ai.enabled")) ??
          DEFAULT_APP_SETTINGS["ai.enabled"],
        "ai.provider":
          (await store.get<AppSettings["ai.provider"]>("ai.provider")) ??
          DEFAULT_APP_SETTINGS["ai.provider"],
        "ai.openai.baseUrl":
          (await store.get<string>("ai.openai.baseUrl")) ??
          DEFAULT_APP_SETTINGS["ai.openai.baseUrl"],
        "ai.openai.apiKey":
          (await store.get<string>("ai.openai.apiKey")) ??
          DEFAULT_APP_SETTINGS["ai.openai.apiKey"],
        "ai.anthropic.baseUrl":
          (await store.get<string>("ai.anthropic.baseUrl")) ??
          DEFAULT_APP_SETTINGS["ai.anthropic.baseUrl"],
        "ai.anthropic.apiKey":
          (await store.get<string>("ai.anthropic.apiKey")) ??
          DEFAULT_APP_SETTINGS["ai.anthropic.apiKey"],
        "ai.model":
          (await store.get<string>("ai.model")) ??
          DEFAULT_APP_SETTINGS["ai.model"],
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

  useEffect(() => {
    setAiTestStatus("idle");
    setAiTestMessage(null);
  }, [
    settings["ai.enabled"],
    settings["ai.provider"],
    settings["ai.openai.baseUrl"],
    settings["ai.openai.apiKey"],
    settings["ai.anthropic.baseUrl"],
    settings["ai.anthropic.apiKey"],
    settings["ai.model"],
  ]);

  const handleAiTest = async () => {
    if (!settings["ai.enabled"]) {
      setAiTestStatus("error");
      setAiTestMessage("请先开启 AI");
      return;
    }

    if (!settings["ai.model"].trim()) {
      setAiTestStatus("error");
      setAiTestMessage("请填写模型名称");
      return;
    }

    if (settings["ai.provider"] === "openai") {
      if (!settings["ai.openai.baseUrl"].trim()) {
        setAiTestStatus("error");
        setAiTestMessage("请填写 OpenAI API 地址");
        return;
      }
      if (!settings["ai.openai.apiKey"].trim()) {
        setAiTestStatus("error");
        setAiTestMessage("请填写 OpenAI API 密钥");
        return;
      }
    } else {
      if (!settings["ai.anthropic.baseUrl"].trim()) {
        setAiTestStatus("error");
        setAiTestMessage("请填写 Anthropic API 地址");
        return;
      }
      if (!settings["ai.anthropic.apiKey"].trim()) {
        setAiTestStatus("error");
        setAiTestMessage("请填写 Anthropic API 密钥");
        return;
      }
    }

    setAiTestStatus("testing");
    setAiTestMessage("正在测试...");

    const messages: AiMessage[] = [
      { role: "system", content: "你是连通性测试助手，只需回复 OK" },
      { role: "user", content: "OK" },
    ];

    try {
      await sendAiChat(
        {
          enabled: settings["ai.enabled"],
          provider: settings["ai.provider"],
          model: settings["ai.model"],
          openai: {
            baseUrl: settings["ai.openai.baseUrl"],
            apiKey: settings["ai.openai.apiKey"],
          },
          anthropic: {
            baseUrl: settings["ai.anthropic.baseUrl"],
            apiKey: settings["ai.anthropic.apiKey"],
          },
        },
        messages,
      );
      setAiTestStatus("success");
      setAiTestMessage("连接成功");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAiTestStatus("error");
      setAiTestMessage(message || "连接失败");
    }
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
        <h2>快捷键</h2>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">新增会话</div>
            <div className="settings-item-description">打开连接选择器</div>
          </div>
          <div className="settings-item-control">
            <div className="shortcut-keys">
              <span className="shortcut-key">Ctrl/Command</span>
              <span className="shortcut-key">T</span>
            </div>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">左右分屏</div>
            <div className="settings-item-description">为当前会话选择分屏服务器</div>
          </div>
          <div className="settings-item-control">
            <div className="shortcut-keys">
              <span className="shortcut-key">Ctrl/Command</span>
              <span className="shortcut-key">D</span>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h2>AI 配置</h2>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">启用 AI</div>
            <div className="settings-item-description">开启后可在终端内使用 AI 问答</div>
          </div>
          <div className="settings-item-control">
            <div
              className={`toggle-switch ${settings["ai.enabled"] ? "active" : ""}`}
              onClick={() => toggleSetting("ai.enabled")}
            >
              <div className="toggle-switch-handle" />
            </div>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">提供商</div>
            <div className="settings-item-description">选择 AI 服务商</div>
          </div>
          <div className="settings-item-control">
            <select
              className="settings-select"
              value={settings["ai.provider"]}
              onChange={(e) =>
                updateSetting("ai.provider", e.target.value as AppSettings["ai.provider"])
              }
              disabled={!settings["ai.enabled"]}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>
        </div>
        {settings["ai.provider"] === "openai" ? (
          <>
            <div className="settings-item">
              <div className="settings-item-info">
                <div className="settings-item-label">API 地址</div>
                <div className="settings-item-description">OpenAI 兼容接口地址</div>
              </div>
              <div className="settings-item-control">
                <input
                  type="text"
                  className="settings-input"
                  value={settings["ai.openai.baseUrl"]}
                  onChange={(e) => updateSetting("ai.openai.baseUrl", e.target.value)}
                  disabled={!settings["ai.enabled"]}
                />
              </div>
            </div>
            <div className="settings-item">
              <div className="settings-item-info">
                <div className="settings-item-label">API 密钥</div>
                <div className="settings-item-description">用于鉴权的密钥</div>
              </div>
              <div className="settings-item-control">
                <input
                  type="password"
                  className="settings-input"
                  value={settings["ai.openai.apiKey"]}
                  onChange={(e) => updateSetting("ai.openai.apiKey", e.target.value)}
                  disabled={!settings["ai.enabled"]}
                />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="settings-item">
              <div className="settings-item-info">
                <div className="settings-item-label">API 地址</div>
                <div className="settings-item-description">Anthropic 接口地址</div>
              </div>
              <div className="settings-item-control">
                <input
                  type="text"
                  className="settings-input"
                  value={settings["ai.anthropic.baseUrl"]}
                  onChange={(e) => updateSetting("ai.anthropic.baseUrl", e.target.value)}
                  disabled={!settings["ai.enabled"]}
                />
              </div>
            </div>
            <div className="settings-item">
              <div className="settings-item-info">
                <div className="settings-item-label">API 密钥</div>
                <div className="settings-item-description">用于鉴权的密钥</div>
              </div>
              <div className="settings-item-control">
                <input
                  type="password"
                  className="settings-input"
                  value={settings["ai.anthropic.apiKey"]}
                  onChange={(e) => updateSetting("ai.anthropic.apiKey", e.target.value)}
                  disabled={!settings["ai.enabled"]}
                />
              </div>
            </div>
          </>
        )}
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">模型</div>
            <div className="settings-item-description">用于对话的模型名称</div>
          </div>
          <div className="settings-item-control">
            <select
              className="settings-select"
              value={settings["ai.model"]}
              onChange={(e) => updateSetting("ai.model", e.target.value)}
              disabled={!settings["ai.enabled"]}
            >
              {(settings["ai.provider"] === "openai"
                ? OPENAI_MODEL_OPTIONS
                : ANTHROPIC_MODEL_OPTIONS
              ).map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
              {!((settings["ai.provider"] === "openai"
                ? OPENAI_MODEL_OPTIONS
                : ANTHROPIC_MODEL_OPTIONS
              ).some((opt) => opt.value === settings["ai.model"])) && (
                <option value={settings["ai.model"]}>{settings["ai.model"]}</option>
              )}
            </select>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <div className="settings-item-label">连通性测试</div>
            <div className="settings-item-description">验证 AI 服务是否可用</div>
          </div>
          <div className="settings-item-control settings-item-control--stack">
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => void handleAiTest()}
              disabled={!settings["ai.enabled"] || aiTestStatus === "testing"}
            >
              {aiTestStatus === "testing" ? "测试中..." : "测试连接"}
            </button>
            {aiTestMessage && (
              <span className={`settings-test-status settings-test-status--${aiTestStatus}`}>
                {aiTestMessage}
              </span>
            )}
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
