import {
  createElement,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_APP_SETTINGS,
  getAppSettingsStore,
  writeAppSetting,
  type AppSettings,
} from "../store/appSettings";

export type Locale = "zh-CN" | "en-US";

type MessageMap = Record<Locale, string>;
type Messages = Record<string, MessageMap>;
type Params = Record<string, string | number | undefined | null>;

const MESSAGES: Messages = {
  "app.lock.title": { "zh-CN": "应用已锁定", "en-US": "App Locked" },
  "app.lock.subtitle": {
    "zh-CN": "请输入 Master Key 解锁",
    "en-US": "Enter your Master Key to unlock",
  },
  "app.lock.placeholder": { "zh-CN": "Master Key", "en-US": "Master Key" },
  "app.lock.unlock": { "zh-CN": "解锁", "en-US": "Unlock" },
  "app.lock.unlocking": { "zh-CN": "验证中...", "en-US": "Verifying..." },
  "app.lock.error.empty": { "zh-CN": "请输入 Master Key", "en-US": "Please enter the Master Key" },
  "app.lock.error.invalid": { "zh-CN": "密码错误", "en-US": "Incorrect password" },
  "app.lock.error.verifyFail": { "zh-CN": "验证失败", "en-US": "Verification failed" },
  "app.lock.reset": { "zh-CN": "忘记密码", "en-US": "Forgot password" },
  "app.lock.reset.title": { "zh-CN": "重置 Master Key？", "en-US": "Reset Master Key?" },
  "app.lock.reset.desc": {
    "zh-CN": "所有服务器、密钥与脚本配置将被清空，且无法恢复。",
    "en-US": "All servers, keys, and scripts will be erased and cannot be recovered.",
  },
  "app.lock.reset.cancel": { "zh-CN": "取消", "en-US": "Cancel" },
  "app.lock.reset.confirm": { "zh-CN": "确认重置", "en-US": "Confirm reset" },
  "app.lock.reset.inProgress": { "zh-CN": "重置中...", "en-US": "Resetting..." },
  "app.lock.reset.fail": { "zh-CN": "重置失败", "en-US": "Reset failed" },
  "app.lock.reset.toast.title": { "zh-CN": "已重置 Master Key", "en-US": "Master Key reset" },
  "app.lock.reset.toast.detail": { "zh-CN": "所有配置已清空", "en-US": "All settings have been cleared" },

  "nav.connections": { "zh-CN": "连接器管理", "en-US": "Connections" },
  "nav.forwarding": { "zh-CN": "转发", "en-US": "Forwarding" },
  "nav.space": { "zh-CN": "空间", "en-US": "Space" },
  "nav.keys": { "zh-CN": "密钥管理", "en-US": "Key Management" },
  "nav.settings": { "zh-CN": "设置", "en-US": "Settings" },

  "messages.title": { "zh-CN": "消息", "en-US": "Messages" },
  "messages.clear": { "zh-CN": "清空", "en-US": "Clear" },
  "messages.close": { "zh-CN": "关闭", "en-US": "Close" },
  "messages.empty": { "zh-CN": "暂无消息", "en-US": "No messages" },

  "settings.title": { "zh-CN": "设置", "en-US": "Settings" },
  "settings.section.general": { "zh-CN": "通用设置", "en-US": "General" },
  "settings.language.label": { "zh-CN": "语言", "en-US": "Language" },
  "settings.language.desc": { "zh-CN": "切换应用显示语言", "en-US": "Switch the app language" },
  "settings.language.zh": { "zh-CN": "简体中文", "en-US": "Simplified Chinese" },
  "settings.language.en": { "zh-CN": "English", "en-US": "English" },
  "settings.theme.label": { "zh-CN": "主题配色", "en-US": "Theme" },
  "settings.theme.desc": { "zh-CN": "选择应用主色与背景", "en-US": "Choose app colors and background" },
  "settings.theme.bright": { "zh-CN": "明亮", "en-US": "Bright" },
  "settings.theme.mint": { "zh-CN": "浅绿", "en-US": "Mint" },
  "settings.theme.dark": { "zh-CN": "暗黑", "en-US": "Dark" },

  "settings.section.connection": { "zh-CN": "连接设置", "en-US": "Connections" },
  "settings.connection.autoReconnect": { "zh-CN": "自动重连", "en-US": "Auto reconnect" },
  "settings.connection.autoReconnect.desc": {
    "zh-CN": "连接断开时自动尝试重新连接",
    "en-US": "Automatically try to reconnect when disconnected",
  },
  "settings.connection.savePassword": { "zh-CN": "保存密码", "en-US": "Save password" },
  "settings.connection.savePassword.desc": {
    "zh-CN": "在本地安全存储连接密码",
    "en-US": "Securely store passwords locally",
  },
  "settings.connection.keepAlive": { "zh-CN": "保持连接", "en-US": "Keep alive" },
  "settings.connection.keepAlive.desc": {
    "zh-CN": "定期发送心跳包保持 SSH 连接活跃",
    "en-US": "Send heartbeat packets to keep SSH sessions alive",
  },
  "settings.connection.keepAliveInterval": { "zh-CN": "心跳间隔（秒）", "en-US": "Heartbeat interval (seconds)" },
  "settings.connection.keepAliveInterval.desc": {
    "zh-CN": "保持连接的心跳包发送间隔",
    "en-US": "Interval for sending keep-alive packets",
  },

  "settings.section.security": { "zh-CN": "安全设置", "en-US": "Security" },
  "settings.security.masterKey": { "zh-CN": "Master Key", "en-US": "Master Key" },
  "settings.security.masterKey.enabled": {
    "zh-CN": "已设置，用于解锁应用",
    "en-US": "Set and required to unlock the app",
  },
  "settings.security.masterKey.disabled": {
    "zh-CN": "设置后用于解锁应用",
    "en-US": "Set to unlock the app",
  },
  "settings.security.masterKey.placeholder": { "zh-CN": "输入新 Master Key", "en-US": "Enter new Master Key" },
  "settings.security.masterKey.confirm": { "zh-CN": "确认 Master Key", "en-US": "Confirm Master Key" },
  "settings.security.masterKey.save": { "zh-CN": "设置", "en-US": "Save" },
  "settings.security.masterKey.saving": { "zh-CN": "保存中...", "en-US": "Saving..." },
  "settings.security.masterKey.clear": { "zh-CN": "清除", "en-US": "Clear" },
  "settings.security.masterKey.tooShort": { "zh-CN": "至少 6 位字符", "en-US": "At least 6 characters" },
  "settings.security.masterKey.mismatch": { "zh-CN": "两次输入不一致", "en-US": "Entries do not match" },
  "settings.security.masterKey.updated": { "zh-CN": "已更新", "en-US": "Updated" },
  "settings.security.masterKey.cleared": { "zh-CN": "已清除", "en-US": "Cleared" },
  "settings.security.masterKey.failed": { "zh-CN": "设置失败", "en-US": "Failed to set" },
  "settings.security.autoLock": { "zh-CN": "自动锁定", "en-US": "Auto lock" },
  "settings.security.autoLock.desc": {
    "zh-CN": "软件空闲超过设定分钟后需要输入 Master Key",
    "en-US": "Lock after the app is idle for the selected duration",
  },
  "settings.security.lock.none": { "zh-CN": "不自动锁定", "en-US": "Never" },
  "settings.security.lock.5": { "zh-CN": "5 分钟", "en-US": "5 minutes" },
  "settings.security.lock.10": { "zh-CN": "10 分钟", "en-US": "10 minutes" },
  "settings.security.lock.15": { "zh-CN": "15 分钟", "en-US": "15 minutes" },
  "settings.security.lock.30": { "zh-CN": "30 分钟", "en-US": "30 minutes" },
  "settings.security.lock.60": { "zh-CN": "60 分钟", "en-US": "60 minutes" },
  "settings.security.lock.120": { "zh-CN": "120 分钟", "en-US": "120 minutes" },

  "settings.section.update": { "zh-CN": "软件更新", "en-US": "Updates" },
  "settings.update.current": { "zh-CN": "当前版本", "en-US": "Current version" },
  "settings.update.autoCheck": { "zh-CN": "启动时自动检查更新", "en-US": "Automatically check at startup" },
  "settings.update.status": { "zh-CN": "更新状态", "en-US": "Update status" },
  "settings.update.available": { "zh-CN": "发现新版本", "en-US": "New version available" },
  "settings.update.availableWithVersion": {
    "zh-CN": "发现新版本 v{version}{dateSuffix}",
    "en-US": "New version v{version}{dateSuffix} is available",
  },
  "settings.update.check": { "zh-CN": "检查更新", "en-US": "Check for updates" },
  "settings.update.checking": { "zh-CN": "检查中...", "en-US": "Checking..." },
  "settings.update.upToDate": { "zh-CN": "已是最新版本", "en-US": "You're up to date" },
  "settings.update.downloading": { "zh-CN": "下载中...", "en-US": "Downloading..." },
  "settings.update.download": { "zh-CN": "下载并安装", "en-US": "Download & install" },
  "settings.update.downloadingStatus": { "zh-CN": "正在下载更新...", "en-US": "Downloading update..." },
  "settings.update.checkingStatus": { "zh-CN": "正在检查更新...", "en-US": "Checking for updates..." },
  "settings.update.installed": { "zh-CN": "更新已安装，请重启应用完成更新", "en-US": "Update installed. Restart the app to finish." },
  "settings.update.error": { "zh-CN": "更新失败", "en-US": "Update failed" },
  "settings.update.lastChecked": { "zh-CN": "上次检查 {time}", "en-US": "Last checked {time}" },
  "settings.update.progress": { "zh-CN": "更新下载进度", "en-US": "Update download progress" },

  "settings.section.terminal": { "zh-CN": "终端设置", "en-US": "Terminal" },
  "settings.terminal.theme": { "zh-CN": "主题", "en-US": "Theme" },
  "settings.terminal.backgroundImage": { "zh-CN": "终端背景图", "en-US": "Terminal background" },
  "settings.terminal.backgroundImage.desc": {
    "zh-CN": "支持 PNG/JPG/WebP/GIF，最大 4MB",
    "en-US": "Supports PNG/JPG/WebP/GIF up to 4 MB",
  },
  "settings.terminal.backgroundImage.upload": { "zh-CN": "上传图片", "en-US": "Upload image" },
  "settings.terminal.backgroundImage.uploading": { "zh-CN": "上传中...", "en-US": "Uploading..." },
  "settings.terminal.backgroundImage.remove": { "zh-CN": "移除", "en-US": "Remove" },
  "settings.terminal.backgroundImage.empty": { "zh-CN": "未设置", "en-US": "Not set" },
  "settings.terminal.backgroundImage.ready": { "zh-CN": "已设置", "en-US": "Set" },
  "settings.terminal.backgroundImage.unsupported": { "zh-CN": "不支持的图片格式", "en-US": "Unsupported image format" },
  "settings.terminal.backgroundImage.tooLarge": { "zh-CN": "图片过大（最大 4MB）", "en-US": "Image too large (max 4 MB)" },
  "settings.terminal.backgroundImage.fail": { "zh-CN": "背景图设置失败", "en-US": "Failed to set background image" },
  "settings.terminal.backgroundGroup": { "zh-CN": "背景设置", "en-US": "Background settings" },
  "settings.terminal.backgroundGroup.desc": {
    "zh-CN": "上传图片并调节遮罩与模糊效果",
    "en-US": "Upload and tune overlay/blur",
  },
  "settings.terminal.backgroundOpacity": { "zh-CN": "背景遮罩", "en-US": "Background overlay" },
  "settings.terminal.backgroundBlur": { "zh-CN": "背景模糊", "en-US": "Background blur" },
  "settings.terminal.fontFamily": { "zh-CN": "字体样式", "en-US": "Font family" },
  "settings.terminal.fontWeight": { "zh-CN": "字重", "en-US": "Weight" },
  "settings.terminal.fontSize": { "zh-CN": "字号", "en-US": "Font size" },
  "settings.terminal.cursorStyle": { "zh-CN": "光标形状", "en-US": "Cursor style" },
  "settings.terminal.cursorBlink": { "zh-CN": "是否开启光标闪烁", "en-US": "Cursor blink" },
  "settings.terminal.lineHeight": { "zh-CN": "行间距", "en-US": "Line height" },
  "settings.terminal.advanced": { "zh-CN": "高级设置", "en-US": "Advanced" },
  "settings.terminal.autoCopy": { "zh-CN": "自动复制", "en-US": "Auto copy" },
  "settings.terminal.autoCopy.desc": {
    "zh-CN": "选中文本后自动复制到剪贴板",
    "en-US": "Copy selected text to clipboard automatically",
  },
  "settings.terminal.preview": { "zh-CN": "字体设置预览", "en-US": "Preview" },
  "settings.terminal.cursor.block": { "zh-CN": "块状", "en-US": "Block" },
  "settings.terminal.cursor.underline": { "zh-CN": "下划线", "en-US": "Underline" },
  "settings.terminal.cursor.bar": { "zh-CN": "竖线", "en-US": "Bar" },

  "settings.section.shortcuts": { "zh-CN": "快捷键", "en-US": "Shortcuts" },
  "settings.shortcuts.newSession": { "zh-CN": "新增会话", "en-US": "New session" },
  "settings.shortcuts.newSession.desc": { "zh-CN": "打开连接选择器", "en-US": "Open connection picker" },
  "settings.shortcuts.split": { "zh-CN": "左右分屏", "en-US": "Split" },
  "settings.shortcuts.split.desc": { "zh-CN": "为当前会话选择分屏服务器", "en-US": "Choose a split target for the current session" },
  "settings.shortcuts.switch": { "zh-CN": "切换会话", "en-US": "Switch session" },
  "settings.shortcuts.switch.desc": { "zh-CN": "在顶部标签页之间切换", "en-US": "Switch between top tabs" },
  "settings.shortcuts.connections": { "zh-CN": "连接管理器", "en-US": "Connection manager" },
  "settings.shortcuts.connections.desc": { "zh-CN": "收起或打开连接管理器", "en-US": "Toggle the connection panel" },

  "settings.section.ai": { "zh-CN": "AI 配置", "en-US": "AI" },
  "settings.ai.enabled": { "zh-CN": "启用 AI", "en-US": "Enable AI" },
  "settings.ai.enabled.desc": { "zh-CN": "开启后可在终端内使用 AI 问答", "en-US": "Enable AI assistant in terminal" },
  "settings.ai.provider": { "zh-CN": "提供商", "en-US": "Provider" },
  "settings.ai.provider.desc": { "zh-CN": "选择 AI 服务商", "en-US": "Choose an AI provider" },
  "settings.ai.apiUrl": { "zh-CN": "API 地址", "en-US": "API URL" },
  "settings.ai.apiKey": { "zh-CN": "API 密钥", "en-US": "API key" },
  "settings.ai.apiKey.desc": { "zh-CN": "用于鉴权的密钥", "en-US": "Used for authentication" },
  "settings.ai.openai.desc": { "zh-CN": "OpenAI 兼容接口地址", "en-US": "OpenAI-compatible endpoint" },
  "settings.ai.anthropic.desc": { "zh-CN": "Anthropic 接口地址", "en-US": "Anthropic endpoint" },
  "settings.ai.model": { "zh-CN": "模型", "en-US": "Model" },
  "settings.ai.model.desc": { "zh-CN": "用于对话的模型列表（可多选）", "en-US": "Models available for chat (multi-select)" },
  "settings.ai.model.current": { "zh-CN": "当前模型", "en-US": "Current model" },
  "settings.ai.model.selected": { "zh-CN": "已选模型", "en-US": "Selected models" },
  "settings.ai.model.available": { "zh-CN": "可选模型", "en-US": "Available models" },
  "settings.ai.model.placeholder": { "zh-CN": "请输入模型名称", "en-US": "Enter model name" },
  "settings.ai.model.search": { "zh-CN": "搜索模型", "en-US": "Search models" },
  "settings.ai.model.search.placeholder": {
    "zh-CN": "搜索模型（例如：bge / claude / gemini / reranker）",
    "en-US": "Search models (e.g. bge / claude / gemini / reranker)",
  },
  "settings.ai.model.search.empty": { "zh-CN": "没有匹配的模型", "en-US": "No matching models" },
  "settings.ai.model.selected.empty": { "zh-CN": "未选择模型", "en-US": "No models selected" },
  "settings.ai.model.manage": { "zh-CN": "管理", "en-US": "Manage" },
  "settings.ai.model.manage.title": { "zh-CN": "管理模型", "en-US": "Manage models" },
  "settings.ai.model.manage.subtitle": {
    "zh-CN": "选择要启用的模型与能力",
    "en-US": "Choose which models and capabilities to enable",
  },
  "settings.ai.model.selected.hint": { "zh-CN": "点击标签移除（可选）", "en-US": "Click tags to remove (optional)" },
  "settings.ai.model.available.hint": { "zh-CN": "点击选择 / 再次点击移除", "en-US": "Click to select / click again to remove" },
  "settings.ai.model.state.selected": { "zh-CN": "已选", "en-US": "Selected" },
  "settings.ai.model.state.unselected": { "zh-CN": "未选", "en-US": "Not selected" },
  "settings.ai.model.add.placeholder": {
    "zh-CN": "输入模型名称（支持粘贴完整 ID）",
    "en-US": "Enter model name (full ID supported)",
  },
  "settings.ai.model.add": { "zh-CN": "添加", "en-US": "Add" },
  "settings.ai.model.refresh": { "zh-CN": "刷新列表", "en-US": "Refresh" },
  "settings.ai.model.refreshing": { "zh-CN": "获取中...", "en-US": "Refreshing..." },
  "settings.ai.model.refresh.success": { "zh-CN": "已获取 {count} 个模型", "en-US": "{count} models loaded" },
  "settings.ai.model.refresh.empty": { "zh-CN": "未获取到模型", "en-US": "No models returned" },
  "settings.ai.model.refresh.fail": { "zh-CN": "模型列表获取失败", "en-US": "Failed to load models" },
  "settings.ai.test": { "zh-CN": "连通性测试", "en-US": "Connectivity test" },
  "settings.ai.test.desc": { "zh-CN": "验证 AI 服务是否可用", "en-US": "Verify the AI service" },
  "settings.ai.test.action": { "zh-CN": "测试连接", "en-US": "Test connection" },
  "settings.ai.test.testing": { "zh-CN": "测试中...", "en-US": "Testing..." },
  "settings.ai.test.systemPrompt": { "zh-CN": "你是连通性测试助手，只需回复 OK", "en-US": "You are a connectivity tester. Reply with OK only." },
  "settings.ai.error.disabled": { "zh-CN": "请先开启 AI", "en-US": "Enable AI first" },
  "settings.ai.error.model": { "zh-CN": "请填写模型名称", "en-US": "Please enter a model name" },
  "settings.ai.error.openaiUrl": { "zh-CN": "请填写 OpenAI API 地址", "en-US": "Please enter OpenAI API URL" },
  "settings.ai.error.openaiKey": { "zh-CN": "请填写 OpenAI API 密钥", "en-US": "Please enter OpenAI API key" },
  "settings.ai.error.anthropicUrl": { "zh-CN": "请填写 Anthropic API 地址", "en-US": "Please enter Anthropic API URL" },
  "settings.ai.error.anthropicKey": { "zh-CN": "请填写 Anthropic API 密钥", "en-US": "Please enter Anthropic API key" },
  "settings.ai.test.success": { "zh-CN": "连接成功", "en-US": "Connected" },
  "settings.ai.test.fail": { "zh-CN": "连接失败", "en-US": "Connection failed" },

  "settings.section.data": { "zh-CN": "数据管理", "en-US": "Data" },
  "settings.data.export": { "zh-CN": "导出配置", "en-US": "Export settings" },
  "settings.data.export.desc": {
    "zh-CN": "导出当前连接、密钥与设置（启用 Master Key 的敏感字段保持加密）",
    "en-US": "Export connections, keys, and settings (sensitive data stays encrypted)",
  },
  "settings.data.export.action": { "zh-CN": "导出", "en-US": "Export" },
  "settings.data.export.exporting": { "zh-CN": "导出中...", "en-US": "Exporting..." },
  "settings.data.export.success": { "zh-CN": "导出成功", "en-US": "Exported" },
  "settings.data.export.success.desc": { "zh-CN": "配置文件已保存", "en-US": "Configuration file saved" },
  "settings.data.export.fail": { "zh-CN": "导出失败", "en-US": "Export failed" },
  "settings.data.import": { "zh-CN": "导入配置", "en-US": "Import settings" },
  "settings.data.import.desc": {
    "zh-CN": "导入连接、密钥与设置（敏感信息保持本地）",
    "en-US": "Import connections, keys, and settings (sensitive data stays local)",
  },
  "settings.data.import.action": { "zh-CN": "导入", "en-US": "Import" },
  "settings.data.import.importing": { "zh-CN": "导入中...", "en-US": "Importing..." },
  "settings.data.import.success": { "zh-CN": "导入成功", "en-US": "Imported" },
  "settings.data.import.success.desc": { "zh-CN": "配置已导入", "en-US": "Configuration imported" },
  "settings.data.import.fail": { "zh-CN": "导入失败", "en-US": "Import failed" },
  "settings.data.import.invalid": { "zh-CN": "配置文件格式不正确", "en-US": "Invalid configuration file" },
  "settings.section.about": { "zh-CN": "关于", "en-US": "About" },
  "settings.about.appName": { "zh-CN": "应用名称", "en-US": "App name" },
  "settings.about.version": { "zh-CN": "版本", "en-US": "Version" },
  "settings.about.framework": { "zh-CN": "框架", "en-US": "Framework" },
  "settings.about.buildDate": { "zh-CN": "构建日期", "en-US": "Build date" },

  "settings.update.toast.title": { "zh-CN": "发现新版本", "en-US": "New version available" },
  "settings.update.toast.detail": { "zh-CN": "可在设置中更新", "en-US": "Update from Settings" },

  "common.save": { "zh-CN": "保存", "en-US": "Save" },
  "common.cancel": { "zh-CN": "取消", "en-US": "Cancel" },
  "common.close": { "zh-CN": "关闭", "en-US": "Close" },
  "common.clear": { "zh-CN": "清空", "en-US": "Clear" },
  "common.edit": { "zh-CN": "编辑", "en-US": "Edit" },
  "common.delete": { "zh-CN": "删除", "en-US": "Delete" },

  "time.justNow": { "zh-CN": "刚刚", "en-US": "Just now" },
  "time.minutesAgo": { "zh-CN": "{count} 分钟前", "en-US": "{count} min ago" },
  "time.hoursAgo": { "zh-CN": "{count} 小时前", "en-US": "{count} hr ago" },

  "tab.settings.title": { "zh-CN": "设置", "en-US": "Settings" },
  "tab.settings.subtitle": { "zh-CN": "应用配置", "en-US": "App settings" },
  "tab.keys.title": { "zh-CN": "密钥管理", "en-US": "Key management" },
  "tab.keys.subtitle": { "zh-CN": "SSH 认证", "en-US": "SSH auth" },
  "tab.forwarding.title": { "zh-CN": "转发", "en-US": "Forwarding" },
  "tab.forwarding.subtitle": { "zh-CN": "SSH 端口转发", "en-US": "SSH port forwarding" },
  "tab.space.title": { "zh-CN": "空间", "en-US": "Space" },
  "tab.space.subtitle": { "zh-CN": "脚本管理", "en-US": "Script workspace" },
  "tab.script.new": { "zh-CN": "新建脚本", "en-US": "New script" },
  "tab.script.subtitle": { "zh-CN": "脚本设置", "en-US": "Script settings" },

  "placeholder.sftp": { "zh-CN": "SFTP 文件管理 - 开发中", "en-US": "SFTP file manager - Coming soon" },
  "placeholder.profile": { "zh-CN": "用户信息 - 开发中", "en-US": "Profile - Coming soon" },

  "scriptPicker.title": { "zh-CN": "选择脚本", "en-US": "Select script" },
  "scriptPicker.search": { "zh-CN": "搜索脚本", "en-US": "Search scripts" },
  "scriptPicker.empty": { "zh-CN": "暂无脚本", "en-US": "No scripts" },

  "ai.renderer.execute": { "zh-CN": "执行", "en-US": "Run" },
  "ai.renderer.copy": { "zh-CN": "复制", "en-US": "Copy" },

  "ai.error.disabled": { "zh-CN": "AI 未启用", "en-US": "AI is not enabled" },
  "ai.error.modelMissing": { "zh-CN": "未配置模型", "en-US": "Model is not configured" },
  "ai.error.openaiUrl": { "zh-CN": "未配置 OpenAI API 地址", "en-US": "OpenAI API URL not set" },
  "ai.error.openaiKey": { "zh-CN": "未配置 OpenAI API 密钥", "en-US": "OpenAI API key not set" },
  "ai.error.openaiRequestFail": { "zh-CN": "OpenAI 请求失败", "en-US": "OpenAI request failed" },
  "ai.error.openaiEmpty": { "zh-CN": "OpenAI 返回内容为空", "en-US": "OpenAI returned empty content" },
  "ai.error.anthropicUrl": { "zh-CN": "未配置 Anthropic API 地址", "en-US": "Anthropic API URL not set" },
  "ai.error.anthropicKey": { "zh-CN": "未配置 Anthropic API 密钥", "en-US": "Anthropic API key not set" },
  "ai.error.anthropicRequestFail": { "zh-CN": "Anthropic 请求失败", "en-US": "Anthropic request failed" },
  "ai.error.anthropicEmpty": { "zh-CN": "Anthropic 返回内容为空", "en-US": "Anthropic returned empty content" },

  "space.root": { "zh-CN": "根目录", "en-US": "Root" },
  "space.alert.selectFolder": { "zh-CN": "请先选择一个文件夹", "en-US": "Please select a folder first" },
  "space.header.title": { "zh-CN": "空间", "en-US": "Space" },
  "space.header.subtitle": { "zh-CN": "脚本管理", "en-US": "Script management" },
  "space.action.newFolder": { "zh-CN": "新建文件夹", "en-US": "New folder" },
  "space.action.newScript": { "zh-CN": "新建脚本", "en-US": "New script" },
  "space.tree.expand": { "zh-CN": "展开", "en-US": "Expand" },
  "space.tree.collapse": { "zh-CN": "收起", "en-US": "Collapse" },
  "space.panel.title": { "zh-CN": "脚本与文件夹", "en-US": "Scripts & folders" },
  "space.empty": { "zh-CN": "暂无内容", "en-US": "No content" },
  "space.editor.title": { "zh-CN": "脚本设置", "en-US": "Script settings" },
  "space.editor.folder": { "zh-CN": "所属目录", "en-US": "Folder" },
  "space.editor.name": { "zh-CN": "脚本名称", "en-US": "Script name" },
  "space.editor.namePlaceholder": { "zh-CN": "例如 deploy-prod", "en-US": "e.g. deploy-prod" },
  "space.editor.content": { "zh-CN": "脚本内容（bash）", "en-US": "Script content (bash)" },
  "space.folder.modal.editTitle": { "zh-CN": "编辑文件夹", "en-US": "Edit folder" },
  "space.folder.modal.newTitle": { "zh-CN": "新建文件夹", "en-US": "New folder" },
  "space.folder.modal.nameLabel": { "zh-CN": "文件夹名称", "en-US": "Folder name" },
  "space.folder.modal.namePlaceholder": { "zh-CN": "例如 自动化", "en-US": "e.g. Automation" },

  "connections.defaultName": { "zh-CN": "新连接", "en-US": "New connection" },
  "connections.rdpDefaultName": { "zh-CN": "RDP 连接", "en-US": "RDP connection" },
  "connections.pem.empty": { "zh-CN": "请输入私钥内容", "en-US": "Please enter private key content" },
  "connections.pem.missingMarkers": { "zh-CN": "格式错误：缺少 BEGIN 或 END 标记", "en-US": "Invalid format: missing BEGIN or END markers" },
  "connections.pem.mismatchMarkers": { "zh-CN": "格式错误：BEGIN 和 END 标记不匹配", "en-US": "Invalid format: BEGIN and END markers do not match" },
  "connections.pem.noContent": { "zh-CN": "格式错误：没有私钥内容", "en-US": "Invalid format: missing key content" },
  "connections.pem.unsupported": { "zh-CN": "不支持的密钥类型：{type}", "en-US": "Unsupported key type: {type}" },
  "connections.pem.valid": { "zh-CN": "格式正确", "en-US": "Valid format" },
  "connections.authProfile.passwordName": { "zh-CN": "{username} / 密码", "en-US": "{username} / Password" },
  "connections.authProfile.keyName": { "zh-CN": "{username} / 私钥", "en-US": "{username} / Private key" },
  "connections.localTerminal": { "zh-CN": "本地终端", "en-US": "Local terminal" },
  "connections.test.success": { "zh-CN": "连接成功", "en-US": "Connection successful" },
  "connections.test.fail": { "zh-CN": "连接失败", "en-US": "Connection failed" },
  "connections.test.requireHost": { "zh-CN": "请输入主机地址", "en-US": "Please enter host" },
  "connections.test.requireUsername": { "zh-CN": "请输入用户名", "en-US": "Please enter username" },
  "connections.test.requirePassword": { "zh-CN": "请输入密码", "en-US": "Please enter password" },
  "connections.test.requireKey": { "zh-CN": "请输入私钥路径或私钥内容", "en-US": "Please enter a key path or key content" },
  "connections.test.testing": { "zh-CN": "正在测试连接...", "en-US": "Testing connection..." },
  "connections.test.action": { "zh-CN": "测试连接", "en-US": "Test connection" },
  "connections.unnamed": { "zh-CN": "未命名连接", "en-US": "Untitled connection" },
  "connections.tags.none": { "zh-CN": "无标签", "en-US": "No tags" },
  "connections.section.basic": { "zh-CN": "基础连接", "en-US": "Basic connection" },
  "connections.field.host": { "zh-CN": "服务器", "en-US": "Host" },
  "connections.field.hostPlaceholder": { "zh-CN": "请输入 IP 地址或域名", "en-US": "Enter IP address or hostname" },
  "connections.field.protocol": { "zh-CN": "连接协议", "en-US": "Protocol" },
  "connections.protocol.ssh": { "zh-CN": "终端连接（SSH）", "en-US": "Terminal (SSH)" },
  "connections.protocol.rdp": { "zh-CN": "远程桌面（RDP）", "en-US": "Remote Desktop (RDP)" },
  "connections.field.port": { "zh-CN": "连接端口", "en-US": "Port" },
  "connections.section.auth": { "zh-CN": "认证配置", "en-US": "Authentication" },
  "connections.quickAuth.label": { "zh-CN": "快速认证", "en-US": "Quick auth" },
  "connections.quickAuth.none": { "zh-CN": "不使用", "en-US": "None" },
  "connections.quickAuth.password": { "zh-CN": "密码", "en-US": "Password" },
  "connections.quickAuth.key": { "zh-CN": "私钥", "en-US": "Private key" },
  "connections.quickAuth.saveTitle": { "zh-CN": "保存当前用户名和认证方式到密钥管理，便于下次快速套用", "en-US": "Save the current username and auth method to keys for quick reuse" },
  "connections.quickAuth.save": { "zh-CN": "保存为密钥", "en-US": "Save to keys" },
  "connections.quickAuth.hint": { "zh-CN": "在“密钥管理”维护认证信息，这里可一键套用到新服务器。", "en-US": "Manage auth in Key Management and reuse it for new servers here." },
  "connections.username.optional": { "zh-CN": "用户名（可选）", "en-US": "Username (optional)" },
  "connections.username": { "zh-CN": "用户名", "en-US": "Username" },
  "connections.username.placeholderPrivateKey": { "zh-CN": "留空时自动使用本机用户名", "en-US": "Leave blank to use local username" },
  "connections.password": { "zh-CN": "密码", "en-US": "Password" },
  "connections.password.hide": { "zh-CN": "隐藏密码", "en-US": "Hide password" },
  "connections.password.show": { "zh-CN": "显示密码", "en-US": "Show password" },
  "connections.authType.label": { "zh-CN": "认证方式", "en-US": "Authentication method" },
  "connections.authType.password": { "zh-CN": "密码验证", "en-US": "Password" },
  "connections.authType.key": { "zh-CN": "密钥验证", "en-US": "Private key" },
  "connections.pkMode.path": { "zh-CN": "使用路径", "en-US": "Use path" },
  "connections.pkMode.manual": { "zh-CN": "手动输入", "en-US": "Manual" },
  "connections.pk.path": { "zh-CN": "私钥路径", "en-US": "Private key path" },
  "connections.pk.passphraseOptional": { "zh-CN": "私钥密码（可选）", "en-US": "Key passphrase (optional)" },
  "connections.pk.content": { "zh-CN": "私钥内容（PEM 格式）", "en-US": "Private key content (PEM)" },
  "connections.pk.hint.title": { "zh-CN": "注意：", "en-US": "Note: " },
  "connections.pk.hint.desc": { "zh-CN": "粘贴完整的 PEM 格式私钥内容，包括开始和结束标记。支持以下格式：", "en-US": "Paste the full PEM private key including BEGIN/END markers. Supported formats:" },
  "connections.pk.hint.opensshNew": { "zh-CN": "OpenSSH 新格式", "en-US": "OpenSSH new format" },
  "connections.pk.hint.ensureFull": { "zh-CN": "确保包含完整的密钥内容和换行符", "en-US": "Ensure the full key content and newlines are included" },
  "connections.pk.passphrasePlaceholder": { "zh-CN": "如果私钥已加密，请输入密码", "en-US": "Enter passphrase if the key is encrypted" },
  "connections.more.label": { "zh-CN": "更多配置", "en-US": "More settings" },
  "connections.field.name": { "zh-CN": "连接名称", "en-US": "Connection name" },
  "connections.field.tags": { "zh-CN": "标签", "en-US": "Tags" },
  "connections.field.tagsPlaceholder": { "zh-CN": "生产, 数据库, Linux", "en-US": "Production, Database, Linux" },
  "connections.field.color": { "zh-CN": "颜色标识", "en-US": "Color" },
  "connections.color.select": { "zh-CN": "选择颜色 {color}", "en-US": "Select color {color}" },
  "connections.color.custom": { "zh-CN": "自定义颜色", "en-US": "Custom color" },
  "connections.field.encoding": { "zh-CN": "编码格式", "en-US": "Encoding" },
  "connections.rdp.gatewayHost": { "zh-CN": "网关地址（可选）", "en-US": "Gateway host (optional)" },
  "connections.rdp.gatewayUser": { "zh-CN": "网关用户名", "en-US": "Gateway username" },
  "connections.rdp.gatewayPassword": { "zh-CN": "网关密码", "en-US": "Gateway password" },
  "connections.rdp.gatewayDomain": { "zh-CN": "网关域（可选）", "en-US": "Gateway domain (optional)" },
  "connections.rdp.certPolicy": { "zh-CN": "证书策略", "en-US": "Certificate policy" },
  "connections.rdp.certPolicy.default": { "zh-CN": "默认", "en-US": "Default" },
  "connections.rdp.certPolicy.ignore": { "zh-CN": "忽略证书", "en-US": "Ignore certificates" },
  "connections.rdp.resolutionWidth": { "zh-CN": "分辨率宽度", "en-US": "Resolution width" },
  "connections.rdp.resolutionWidthPlaceholder": { "zh-CN": "例如 1920", "en-US": "e.g. 1920" },
  "connections.rdp.resolutionHeight": { "zh-CN": "分辨率高度", "en-US": "Resolution height" },
  "connections.rdp.resolutionHeightPlaceholder": { "zh-CN": "例如 1080", "en-US": "e.g. 1080" },
  "connections.rdp.colorDepth": { "zh-CN": "色深", "en-US": "Color depth" },
  "connections.rdp.colorDepthBits": { "zh-CN": "{depth} 位", "en-US": "{depth}-bit" },
  "connections.rdp.clipboard": { "zh-CN": "剪贴板", "en-US": "Clipboard" },
  "connections.rdp.audio": { "zh-CN": "音频", "en-US": "Audio" },
  "connections.rdp.drives": { "zh-CN": "驱动器重定向", "en-US": "Drive redirection" },
  "connections.option.on": { "zh-CN": "开启", "en-US": "On" },
  "connections.option.off": { "zh-CN": "关闭", "en-US": "Off" },
  "connections.action.saveAndOpen": { "zh-CN": "打开并保存", "en-US": "Open & save" },
  "connections.action.connectAndSave": { "zh-CN": "连接并保存", "en-US": "Connect & save" },
  "connections.action.openRdp": { "zh-CN": "打开 RDP", "en-US": "Open RDP" },
  "connections.action.connect": { "zh-CN": "连接", "en-US": "Connect" },
  "connections.empty.rdp.title": { "zh-CN": "RDP 远程桌面", "en-US": "RDP Desktop" },
  "connections.empty.rdp.target": { "zh-CN": "目标：{target}", "en-US": "Target: {target}" },
  "connections.empty.readyTitle": { "zh-CN": "准备好连接服务器", "en-US": "Ready to connect" },
  "connections.empty.readyDesc": { "zh-CN": "在左侧选择服务器，然后点击“连接”按钮开始会话", "en-US": "Select a server on the left and click Connect to start a session" },
  "connections.panel.title": { "zh-CN": "连接配置", "en-US": "Connections" },
  "connections.search.placeholder": { "zh-CN": "请输入搜索内容", "en-US": "Search connections" },
  "connections.filter.tags": { "zh-CN": "标签", "en-US": "Tags" },
  "connections.filter.colors": { "zh-CN": "颜色", "en-US": "Colors" },
  "connections.filter.all": { "zh-CN": "全部", "en-US": "All" },
  "connections.filter.colorAria": { "zh-CN": "按颜色筛选 {color}", "en-US": "Filter by color {color}" },
  "connections.list.empty": { "zh-CN": "无匹配的连接", "en-US": "No matching connections" },
  "connections.menu.more": { "zh-CN": "更多操作", "en-US": "More actions" },
  "connections.modal.editTitle": { "zh-CN": "编辑服务器", "en-US": "Edit server" },
  "connections.modal.addTitle": { "zh-CN": "添加服务器", "en-US": "Add server" },
  "connections.split.vertical": { "zh-CN": "左右分屏", "en-US": "Split left/right" },
  "connections.split.horizontal": { "zh-CN": "上下分屏", "en-US": "Split top/bottom" },
  "connections.split.empty": { "zh-CN": "暂无服务器", "en-US": "No servers" },
  "connections.masterKey.title": { "zh-CN": "请先设置 Master Key", "en-US": "Set Master Key first" },
  "connections.masterKey.label": { "zh-CN": "保存敏感信息需要 Master Key", "en-US": "Master Key required to save sensitive info" },
  "connections.masterKey.desc": { "zh-CN": "请先在设置中创建 Master Key，再保存服务器配置。", "en-US": "Create a Master Key in Settings before saving server config." },
  "connections.masterKey.goSettings": { "zh-CN": "前往设置", "en-US": "Go to Settings" },
  "connections.picker.title": { "zh-CN": "选择服务器", "en-US": "Choose server" },
  "connections.picker.empty": { "zh-CN": "暂无服务器", "en-US": "No servers" },
  "connections.picker.search.placeholder": { "zh-CN": "搜索名称、主机或标签", "en-US": "Search name, host, or tags" },
  "connections.picker.noResults": { "zh-CN": "未找到匹配的服务器", "en-US": "No matching servers" },
  "forwarding.title": { "zh-CN": "转发", "en-US": "Forwarding" },
  "forwarding.desc": { "zh-CN": "统一管理全局 SSH 端口转发规则", "en-US": "Manage global SSH port forwarding rules" },
  "forwarding.action.add": { "zh-CN": "新增转发", "en-US": "Add forwarding" },
  "forwarding.action.edit": { "zh-CN": "编辑", "en-US": "Edit" },
  "forwarding.action.delete": { "zh-CN": "删除", "en-US": "Delete" },
  "forwarding.action.start": { "zh-CN": "启动", "en-US": "Start" },
  "forwarding.action.stop": { "zh-CN": "停止", "en-US": "Stop" },
  "forwarding.empty": { "zh-CN": "暂无转发规则", "en-US": "No forwarding rules" },
  "forwarding.defaultName": { "zh-CN": "未命名转发", "en-US": "Untitled forwarding" },
  "forwarding.status.running": { "zh-CN": "运行中", "en-US": "Running" },
  "forwarding.status.stopped": { "zh-CN": "已停止", "en-US": "Stopped" },
  "forwarding.connection.missing": { "zh-CN": "未找到服务器", "en-US": "Server not found" },
  "forwarding.form.title.add": { "zh-CN": "新增转发", "en-US": "New forwarding" },
  "forwarding.form.title.edit": { "zh-CN": "编辑转发", "en-US": "Edit forwarding" },
  "forwarding.form.name": { "zh-CN": "名称", "en-US": "Name" },
  "forwarding.form.name.placeholder": { "zh-CN": "例如：本地数据库", "en-US": "e.g. Local database" },
  "forwarding.form.connection": { "zh-CN": "服务器", "en-US": "Server" },
  "forwarding.form.connection.placeholder": { "zh-CN": "选择服务器", "en-US": "Select server" },
  "forwarding.form.type": { "zh-CN": "类型", "en-US": "Type" },
  "forwarding.type.local": { "zh-CN": "本地转发", "en-US": "Local" },
  "forwarding.type.remote": { "zh-CN": "远程转发", "en-US": "Remote" },
  "forwarding.type.dynamic": { "zh-CN": "动态转发", "en-US": "Dynamic" },
  "forwarding.form.localBindHost": { "zh-CN": "本地监听地址", "en-US": "Local bind host" },
  "forwarding.form.localBindPort": { "zh-CN": "本地监听端口", "en-US": "Local bind port" },
  "forwarding.form.remoteBindHost": { "zh-CN": "远程监听地址", "en-US": "Remote bind host" },
  "forwarding.form.remoteBindPort": { "zh-CN": "远程监听端口", "en-US": "Remote bind port" },
  "forwarding.form.targetHost": { "zh-CN": "目标地址", "en-US": "Target host" },
  "forwarding.form.targetPort": { "zh-CN": "目标端口", "en-US": "Target port" },
  "forwarding.delete.confirm": { "zh-CN": "确定要删除该转发规则吗？", "en-US": "Delete this forwarding rule?" },
  "forwarding.error.connectionMissing": { "zh-CN": "未找到服务器", "en-US": "Server not found" },
  "forwarding.error.startFailed": { "zh-CN": "启动失败", "en-US": "Failed to start" },
  "forwarding.error.stopFailed": { "zh-CN": "停止失败", "en-US": "Failed to stop" },
  "forwarding.error.unlockRequired": { "zh-CN": "需要先解锁主密码", "en-US": "Unlock the master key first" },

  "titleBar.newSession": { "zh-CN": "新建会话", "en-US": "New session" },

  "keys.defaultName": { "zh-CN": "新密钥", "en-US": "New key" },
  "keys.title": { "zh-CN": "密钥管理", "en-US": "Key management" },
  "keys.subtitle": { "zh-CN": "统一管理用户名 + 密码 / PEM 私钥认证", "en-US": "Manage username + password / PEM key auth" },
  "keys.search.placeholder": { "zh-CN": "搜索密钥名称 / 用户名 / 路径", "en-US": "Search name / username / path" },
  "keys.action.add": { "zh-CN": "添加密钥", "en-US": "Add key" },
  "keys.empty.title": { "zh-CN": "暂无密钥", "en-US": "No keys yet" },
  "keys.empty.desc": { "zh-CN": "添加后可在“添加服务器”时一键套用认证信息", "en-US": "Add one to reuse auth when adding servers" },
  "keys.auth.password": { "zh-CN": "密码", "en-US": "Password" },
  "keys.auth.key": { "zh-CN": "私钥（PEM）", "en-US": "Private key (PEM)" },
  "keys.modal.editTitle": { "zh-CN": "编辑密钥", "en-US": "Edit key" },
  "keys.modal.addTitle": { "zh-CN": "添加密钥", "en-US": "Add key" },
  "keys.field.name": { "zh-CN": "名称", "en-US": "Name" },
  "keys.field.namePlaceholder": {
    "zh-CN": "例如：生产环境 root 密码 / 公司跳板机私钥",
    "en-US": "e.g. Prod root password / company jump host key",
  },
  "keys.field.username": { "zh-CN": "用户名", "en-US": "Username" },
  "keys.field.authType": { "zh-CN": "认证方式", "en-US": "Authentication method" },
  "keys.pkMode.create": { "zh-CN": "在线创建", "en-US": "Generate" },
  "keys.publicKey.title": { "zh-CN": "公钥（复制到服务器）", "en-US": "Public key (copy to server)" },
  "keys.publicKey.copy": { "zh-CN": "复制公钥", "en-US": "Copy public key" },
  "keys.generate.algorithm": { "zh-CN": "算法", "en-US": "Algorithm" },
  "keys.generate.algorithm.ed25519": { "zh-CN": "ed25519（推荐）", "en-US": "ed25519 (recommended)" },
  "keys.generate.comment": { "zh-CN": "备注（Comment）", "en-US": "Comment" },
  "keys.generate.commentPlaceholder": { "zh-CN": "例如：ssh-manager", "en-US": "e.g. ssh-manager" },
  "keys.generate.passphrasePlaceholder": { "zh-CN": "为空则不加密", "en-US": "Leave blank for no encryption" },
  "keys.generate.running": { "zh-CN": "生成中…", "en-US": "Generating..." },
  "keys.generate.action": { "zh-CN": "生成密钥", "en-US": "Generate key" },
  "keys.error.nameRequired": { "zh-CN": "请先填写密钥名称", "en-US": "Please enter a key name first" },

  "security.cryptoUnavailable": { "zh-CN": "当前环境不支持加密能力", "en-US": "Cryptography is not supported in this environment" },

  "terminal.session.disconnected": { "zh-CN": "会话已断开", "en-US": "Session disconnected" },
  "terminal.write.timeout": { "zh-CN": "写入超时", "en-US": "Write timeout" },
  "terminal.write.fail": { "zh-CN": "写入失败", "en-US": "Write failed" },
  "terminal.write.issue": { "zh-CN": "{detail}，请检查连接状态", "en-US": "{detail}. Please check the connection status" },
  "terminal.sftp.timeout": { "zh-CN": "SFTP 请求超时", "en-US": "SFTP request timed out" },
  "terminal.sftp.rename.empty": { "zh-CN": "请输入新名称", "en-US": "Please enter a new name" },
  "terminal.sftp.rename.invalid": { "zh-CN": "名称不能包含 '/'", "en-US": "Name cannot include '/'" },
  "terminal.sftp.chmod.invalid": {
    "zh-CN": "请输入 3-4 位八进制权限，例如 644 或 755",
    "en-US": "Enter 3-4 digit octal permissions, e.g. 644 or 755",
  },
  "terminal.sftp.entry.folder": { "zh-CN": "文件夹", "en-US": "folder" },
  "terminal.sftp.entry.file": { "zh-CN": "文件", "en-US": "file" },
  "terminal.sftp.delete.confirm": { "zh-CN": "确定删除{label} “{name}” 吗？", "en-US": "Delete {label} “{name}”?" },
  "terminal.sftp.newFolder.empty": { "zh-CN": "请输入文件夹名称", "en-US": "Please enter a folder name" },
  "terminal.sftp.upload.inProgress": { "zh-CN": "正在上传，请稍候", "en-US": "Uploading, please wait" },
  "terminal.sftp.saveDialog.title": { "zh-CN": "保存文件", "en-US": "Save file" },
  "terminal.sftp.download.progress": { "zh-CN": "下载中: {name}", "en-US": "Downloading: {name}" },
  "terminal.sftp.download.done": { "zh-CN": "下载完成", "en-US": "Download complete" },
  "terminal.sftp.download.fail": { "zh-CN": "下载失败: {message}", "en-US": "Download failed: {message}" },
  "terminal.sftp.upload.progress": { "zh-CN": "上传中: {name}", "en-US": "Uploading: {name}" },
  "terminal.sftp.upload.done": { "zh-CN": "上传完成", "en-US": "Upload complete" },
  "terminal.sftp.upload.fail": { "zh-CN": "上传失败 {path}: {message}", "en-US": "Upload failed {path}: {message}" },
  "terminal.sftp.drop.error": { "zh-CN": "无法读取拖入文件路径，请使用上传按钮", "en-US": "Unable to read dropped file paths. Use the upload button." },
  "terminal.sftp.select.title": { "zh-CN": "选择要上传的文件", "en-US": "Select files to upload" },
  "terminal.sftp.select.fail": { "zh-CN": "选择文件失败: {message}", "en-US": "Failed to select files: {message}" },
  "terminal.ai.prompt.fix.line1": { "zh-CN": "请根据以下终端输出定位问题并给出修复建议。", "en-US": "Use the terminal output below to identify the issue and propose a fix." },
  "terminal.ai.prompt.fix.line2": { "zh-CN": "如果能提供具体命令或步骤，请直接给出。", "en-US": "If specific commands or steps apply, provide them directly." },
  "terminal.ai.prompt.ask.line1": { "zh-CN": "请解释以下终端输出或现象，并给出建议。", "en-US": "Explain the terminal output below and give advice." },
  "terminal.ai.system": { "zh-CN": "你是终端助手，回答要简洁、可执行。", "en-US": "You are a terminal assistant. Keep answers concise and actionable." },
  "terminal.ai.noContext": { "zh-CN": "未检测到终端内容，请先选择文本或产生输出", "en-US": "No terminal output detected. Select text or generate output first." },
  "terminal.endpoint.local": { "zh-CN": "本地", "en-US": "Local" },
  "terminal.status.connecting": { "zh-CN": "连接中…", "en-US": "Connecting…" },
  "terminal.status.connected": { "zh-CN": "已连接", "en-US": "Connected" },
  "terminal.status.error": { "zh-CN": "连接失败", "en-US": "Connection failed" },
  "terminal.status.idle": { "zh-CN": "未连接", "en-US": "Disconnected" },
  "terminal.split.vertical": { "zh-CN": "左右分屏", "en-US": "Split left/right" },
  "terminal.split.horizontal": { "zh-CN": "上下分屏", "en-US": "Split top/bottom" },
  "terminal.sftp.open": { "zh-CN": "打开 SFTP 文件列表", "en-US": "Open SFTP file list" },
  "terminal.ai.toggle": { "zh-CN": "AI 对话", "en-US": "AI chat" },
  "terminal.close": { "zh-CN": "关闭终端", "en-US": "Close terminal" },
  "terminal.reconnect": { "zh-CN": "重新连接", "en-US": "Reconnect" },
  "terminal.alert.copyLog": { "zh-CN": "复制日志", "en-US": "Copy logs" },
  "terminal.alert.close": { "zh-CN": "关闭", "en-US": "Close" },
  "terminal.sftp.dropHint": { "zh-CN": "拖放文件上传", "en-US": "Drop files to upload" },
  "terminal.sftp.title": { "zh-CN": "文件管理器", "en-US": "File manager" },
  "terminal.sftp.action.upload": { "zh-CN": "上传文件", "en-US": "Upload file" },
  "terminal.sftp.action.refresh": { "zh-CN": "刷新", "en-US": "Refresh" },
  "terminal.sftp.action.close": { "zh-CN": "关闭", "en-US": "Close" },
  "terminal.sftp.action.up": { "zh-CN": "返回上级目录", "en-US": "Go up" },
  "terminal.sftp.col.name": { "zh-CN": "文件名", "en-US": "Name" },
  "terminal.sftp.col.size": { "zh-CN": "大小", "en-US": "Size" },
  "terminal.sftp.loading": { "zh-CN": "加载中", "en-US": "Loading" },
  "terminal.sftp.empty": { "zh-CN": "空目录", "en-US": "Empty folder" },
  "terminal.sftp.menu.upload": { "zh-CN": "上传", "en-US": "Upload" },
  "terminal.sftp.menu.refresh": { "zh-CN": "刷新", "en-US": "Refresh" },
  "terminal.sftp.menu.rename": { "zh-CN": "重命名", "en-US": "Rename" },
  "terminal.sftp.menu.chmod": { "zh-CN": "修改权限", "en-US": "Change permissions" },
  "terminal.sftp.menu.copyPath": { "zh-CN": "复制路径", "en-US": "Copy path" },
  "terminal.sftp.menu.download": { "zh-CN": "下载", "en-US": "Download" },
  "terminal.sftp.menu.newFolder": { "zh-CN": "新建文件夹", "en-US": "New folder" },
  "terminal.sftp.newFolder.title": { "zh-CN": "新建文件夹", "en-US": "New folder" },
  "terminal.sftp.newFolder.label": { "zh-CN": "文件夹名称", "en-US": "Folder name" },
  "terminal.sftp.newFolder.placeholder": { "zh-CN": "例如 logs", "en-US": "e.g. logs" },
  "terminal.sftp.newFolder.create": { "zh-CN": "创建", "en-US": "Create" },
  "terminal.ai.title": { "zh-CN": "AI助手", "en-US": "AI Assistant" },
  "terminal.ai.title.chat": { "zh-CN": "Chat 助手", "en-US": "Chat Assistant" },
  "terminal.ai.title.agent": { "zh-CN": "Agent 助手", "en-US": "Agent Assistant" },
  "terminal.ai.empty": { "zh-CN": "暂无对话，可从右键菜单发送终端内容", "en-US": "No messages yet. Send terminal output from the context menu." },
  "terminal.ai.thinking": { "zh-CN": "思考中...", "en-US": "Thinking..." },
  "terminal.ai.quick.title": { "zh-CN": "终端快捷指令", "en-US": "Terminal shortcuts" },
  "terminal.ai.quick.detected": { "zh-CN": "检测到：{command}", "en-US": "Detected: {command}" },
  "terminal.ai.quick.tip": { "zh-CN": "在终端输入后回车即可触发；对话会自动显示在右侧。", "en-US": "Run by pressing Enter in terminal; conversation will open in this panel." },
  "terminal.ai.quick.command.ai": { "zh-CN": "直接提问，AI 会返回可执行命令", "en-US": "Ask directly and get executable commands" },
  "terminal.ai.quick.command.fix": { "zh-CN": "结合最近终端输出做故障排查", "en-US": "Troubleshoot using recent terminal output" },
  "terminal.ai.quick.command.help": { "zh-CN": "显示可用快捷指令", "en-US": "Show available shortcuts" },
  "terminal.quick.overlay.tip": { "zh-CN": "按回车触发，或点击上方命令快速填充。", "en-US": "Press Enter to run, or click a command above to fill it." },
  "terminal.ai.quick.help.title": { "zh-CN": "可用终端快捷指令：", "en-US": "Available terminal shortcuts:" },
  "terminal.ai.quick.unsupported": { "zh-CN": "不支持的快捷指令：{command}。可使用 #help 查看列表。", "en-US": "Unsupported shortcut: {command}. Use #help to list commands." },
  "terminal.ai.quick.aiEmpty": { "zh-CN": "请在 #ai 后输入问题，例如：#ai 如何查看当前目录列表", "en-US": "Please add a question after #ai, e.g. #ai how to list current directory" },
  "terminal.ai.quick.busy": { "zh-CN": "AI 正在处理中，请稍候再试", "en-US": "AI is busy. Please try again shortly." },
  "terminal.ai.quick.followup.commandsOnly": { "zh-CN": "你上一条没有给出可执行命令。请现在直接给出下一步命令，必须包含 bash 代码块。", "en-US": "Your previous response did not include executable commands. Provide the next commands now, and include a bash code block." },
  "terminal.ai.quick.fix.prefix": { "zh-CN": "附加问题：{query}", "en-US": "Additional issue: {query}" },
  "terminal.ai.quick.fix.prefixEmpty": { "zh-CN": "请结合以下终端输出进行排障并给出可执行命令。", "en-US": "Troubleshoot based on terminal output below and provide executable commands." },
  "terminal.ai.input.placeholder": { "zh-CN": "输入你的问题，{modifier}+Enter 发送", "en-US": "Type your question, {modifier}+Enter to send" },
  "terminal.ai.model.placeholder": { "zh-CN": "选择模型", "en-US": "Select model" },
  "terminal.ai.send": { "zh-CN": "发送", "en-US": "Send" },
  "terminal.ai.stop": { "zh-CN": "终止对话", "en-US": "Stop" },
  "terminal.ai.interrupted": { "zh-CN": "已终止本次对话", "en-US": "Conversation interrupted" },
  "terminal.ai.clearContext": { "zh-CN": "清除上下文", "en-US": "Clear context" },
  "terminal.ai.smartTable.title": { "zh-CN": "结构化输出", "en-US": "Structured output" },
  "terminal.ai.smartTable.command": { "zh-CN": "命令：{command}", "en-US": "Command: {command}" },
  "terminal.ai.table.docker.name": { "zh-CN": "容器", "en-US": "Container" },
  "terminal.ai.table.docker.image": { "zh-CN": "镜像", "en-US": "Image" },
  "terminal.ai.table.docker.status": { "zh-CN": "状态", "en-US": "Status" },
  "terminal.ai.table.docker.ports": { "zh-CN": "端口", "en-US": "Ports" },
  "terminal.ai.table.ls.name": { "zh-CN": "文件名", "en-US": "Name" },
  "terminal.ai.table.ls.mode": { "zh-CN": "权限", "en-US": "Mode" },
  "terminal.ai.table.ls.size": { "zh-CN": "大小", "en-US": "Size" },
  "terminal.ai.table.ls.modified": { "zh-CN": "修改时间", "en-US": "Modified" },
  "terminal.ai.smartMenu.stopContainer": { "zh-CN": "停止容器", "en-US": "Stop container" },
  "terminal.ai.smartMenu.copyContainerId": { "zh-CN": "复制容器 ID", "en-US": "Copy container ID" },
  "terminal.ai.smartMenu.enterDir": { "zh-CN": "进入目录", "en-US": "Enter directory" },
  "terminal.ai.smartMenu.editFile": { "zh-CN": "编辑文件", "en-US": "Edit file" },
  "terminal.ai.smartMenu.copyFileName": { "zh-CN": "复制文件名", "en-US": "Copy file name" },
  "terminal.ai.logSummary.title": { "zh-CN": "流式日志摘要（过去 1 分钟）", "en-US": "Streaming summary (last 1 minute)" },
  "terminal.ai.logSummary.line": {
    "zh-CN": "登录失败 {loginFailed} 次，数据库超时 {dbTimeout} 次，其它错误 {errorCount} 次",
    "en-US": "{loginFailed} login failures, {dbTimeout} DB timeouts, {errorCount} other errors",
  },
  "terminal.agent.mode.suggest": { "zh-CN": "Chat", "en-US": "Chat" },
  "terminal.agent.mode.confirm": { "zh-CN": "Agent", "en-US": "Agent" },
  "terminal.agent.plan.generated": {
    "zh-CN": "已生成可执行计划，确认后将自动连续执行并汇报结果。",
    "en-US": "Plan generated. Confirm once to run continuously and get a final report.",
  },
  "terminal.agent.plan.parseFailed": {
    "zh-CN": "计划解析失败：AI 返回内容不符合协议",
    "en-US": "Plan parsing failed: response does not match protocol.",
  },
  "terminal.agent.card.title": { "zh-CN": "待执行计划", "en-US": "Execution plan" },
  "terminal.agent.card.summary": { "zh-CN": "摘要：{summary}", "en-US": "Summary: {summary}" },
  "terminal.agent.card.session": { "zh-CN": "会话：{sessionId}", "en-US": "Session: {sessionId}" },
  "terminal.agent.card.empty": { "zh-CN": "当前计划没有可执行动作", "en-US": "No executable actions in this plan" },
  "terminal.agent.action.reason": { "zh-CN": "原因：{value}", "en-US": "Reason: {value}" },
  "terminal.agent.action.expected": { "zh-CN": "预期影响：{value}", "en-US": "Expected effect: {value}" },
  "terminal.agent.action.timeout": { "zh-CN": "超时：{value}s", "en-US": "Timeout: {value}s" },
  "terminal.agent.action.policy": { "zh-CN": "策略：{value}", "en-US": "Policy: {value}" },
  "terminal.agent.action.editPlaceholder": {
    "zh-CN": "可编辑命令后再执行",
    "en-US": "Edit command before execution",
  },
  "terminal.agent.action.copy": { "zh-CN": "复制命令", "en-US": "Copy command" },
  "terminal.agent.action.confirm": { "zh-CN": "确认执行", "en-US": "Execute" },
  "terminal.agent.action.reject": { "zh-CN": "拒绝", "en-US": "Reject" },
  "terminal.agent.action.confirmStrongHint": {
    "zh-CN": "该动作需强确认，请输入 CONFIRM",
    "en-US": "Strong confirmation required, type CONFIRM",
  },
  "terminal.agent.action.confirmStrongPlaceholder": {
    "zh-CN": "输入 CONFIRM",
    "en-US": "Type CONFIRM",
  },
  "terminal.agent.status.pending": { "zh-CN": "待执行", "en-US": "Queued" },
  "terminal.agent.status.approved": { "zh-CN": "已批准", "en-US": "Approved" },
  "terminal.agent.status.running": { "zh-CN": "执行中", "en-US": "Running" },
  "terminal.agent.status.success": { "zh-CN": "成功", "en-US": "Success" },
  "terminal.agent.status.failed": { "zh-CN": "失败", "en-US": "Failed" },
  "terminal.agent.status.blocked": { "zh-CN": "已拦截", "en-US": "Blocked" },
  "terminal.agent.status.rejected": { "zh-CN": "已拒绝", "en-US": "Rejected" },
  "terminal.agent.status.skipped": { "zh-CN": "已跳过", "en-US": "Skipped" },
  "terminal.agent.risk.low": { "zh-CN": "低风险", "en-US": "Low" },
  "terminal.agent.risk.medium": { "zh-CN": "中风险", "en-US": "Medium" },
  "terminal.agent.risk.high": { "zh-CN": "高风险", "en-US": "High" },
  "terminal.agent.risk.critical": { "zh-CN": "严重风险", "en-US": "Critical" },
  "terminal.agent.policy.allowed": { "zh-CN": "允许", "en-US": "Allowed" },
  "terminal.agent.policy.blocked": { "zh-CN": "拦截", "en-US": "Blocked" },
  "terminal.agent.policy.needs_strong_confirmation": {
    "zh-CN": "需强确认",
    "en-US": "Needs strong confirmation",
  },
  "terminal.agent.plan.executeRemaining": { "zh-CN": "确认并执行全部", "en-US": "Confirm and run all" },
  "terminal.agent.plan.force.title": { "zh-CN": "强制执行拦截命令", "en-US": "Force blocked actions" },
  "terminal.agent.plan.force.desc": {
    "zh-CN": "当前计划有 {count} 条命令被策略拦截。输入“{keyword}”后可强制执行全部步骤。",
    "en-US": "{count} actions are blocked by policy. Type \"{keyword}\" to force run all steps.",
  },
  "terminal.agent.plan.force.keyword": { "zh-CN": "确定", "en-US": "CONFIRM" },
  "terminal.agent.plan.force.placeholder": { "zh-CN": "请输入：{keyword}", "en-US": "Type: {keyword}" },
  "terminal.agent.plan.force.confirm": { "zh-CN": "强制执行全部", "en-US": "Force run all" },
  "terminal.agent.plan.force.invalid": {
    "zh-CN": "请输入“{keyword}”后再继续",
    "en-US": "Please type \"{keyword}\" to continue.",
  },
  "terminal.agent.plan.stopRemaining": { "zh-CN": "停止后续步骤", "en-US": "Stop remaining steps" },
  "terminal.agent.activity.title": { "zh-CN": "执行过程", "en-US": "Execution activity" },
  "terminal.agent.activity.thinkingStatus": {
    "zh-CN": "Agent 正在思考并更新计划...",
    "en-US": "Agent is thinking and adjusting the plan...",
  },
  "terminal.agent.activity.planReady": {
    "zh-CN": "计划已生成，等待执行",
    "en-US": "Plan ready. Waiting to run.",
  },
  "terminal.agent.activity.planStart": {
    "zh-CN": "开始执行计划，共 {count} 步",
    "en-US": "Plan started with {count} steps.",
  },
  "terminal.agent.activity.userStopped": {
    "zh-CN": "用户已停止后续步骤",
    "en-US": "User stopped the remaining steps.",
  },
  "terminal.agent.activity.stepStart": {
    "zh-CN": "步骤 {index} 开始：{command}",
    "en-US": "Step {index} started: {command}",
  },
  "terminal.agent.activity.stepSuccess": {
    "zh-CN": "步骤 {index} 执行成功",
    "en-US": "Step {index} completed successfully.",
  },
  "terminal.agent.activity.stepFailed": {
    "zh-CN": "步骤 {index} 执行失败",
    "en-US": "Step {index} failed.",
  },
  "terminal.agent.activity.stepBlocked": {
    "zh-CN": "步骤 {index} 被策略拦截",
    "en-US": "Step {index} was blocked by policy.",
  },
  "terminal.agent.activity.thinkingDecision": {
    "zh-CN": "正在分析步骤结果并决策下一步",
    "en-US": "Analyzing step result and deciding next action.",
  },
  "terminal.agent.activity.decisionNote": {
    "zh-CN": "Agent 判断：{note}",
    "en-US": "Agent note: {note}",
  },
  "terminal.agent.activity.replanStart": {
    "zh-CN": "当前计划需要调整，开始重规划",
    "en-US": "Plan needs adjustment. Re-planning started.",
  },
  "terminal.agent.activity.replanDone": {
    "zh-CN": "重规划完成，新增 {count} 个后续步骤",
    "en-US": "Re-plan complete with {count} new steps.",
  },
  "terminal.agent.activity.planStoppedByAgent": {
    "zh-CN": "Agent 决定停止后续执行",
    "en-US": "Agent decided to stop the run.",
  },
  "terminal.agent.activity.thinkingFinalReport": {
    "zh-CN": "正在整理最终执行总结",
    "en-US": "Preparing final execution report.",
  },
  "terminal.agent.activity.finalReportReady": {
    "zh-CN": "最终总结已生成",
    "en-US": "Final report is ready.",
  },
  "terminal.agent.result.exitCode": { "zh-CN": "退出码：{code}", "en-US": "Exit code: {code}" },
  "terminal.agent.result.duration": { "zh-CN": "耗时：{ms}ms", "en-US": "Duration: {ms}ms" },
  "terminal.agent.result.stdout": { "zh-CN": "标准输出", "en-US": "Stdout" },
  "terminal.agent.result.stderr": { "zh-CN": "错误输出", "en-US": "Stderr" },
  "terminal.agent.mode.suggestBlock": {
    "zh-CN": "当前为仅建议模式，请切换为“确认后执行”",
    "en-US": "Suggest-only mode. Switch to confirm mode to execute.",
  },
  "terminal.toolbar.latency": { "zh-CN": "延迟", "en-US": "Latency" },
  "terminal.toolbar.endpoint": { "zh-CN": "服务器 IP", "en-US": "Server IP" },
  "terminal.toolbar.endpoint.copy": { "zh-CN": "点击复制 IP", "en-US": "Click to copy IP" },
  "terminal.toolbar.endpoint.copied": { "zh-CN": "已复制", "en-US": "Copied" },
  "terminal.toolbar.endpoint.toast.title": { "zh-CN": "IP 已复制", "en-US": "IP copied" },
  "terminal.toolbar.endpoint.toast.detail": { "zh-CN": "已复制到剪贴板：{ip}", "en-US": "Copied to clipboard: {ip}" },
  "terminal.toolbar.script": { "zh-CN": "脚本", "en-US": "Scripts" },
  "terminal.toolbar.quickActions": { "zh-CN": "快捷操作", "en-US": "Quick actions" },
  "terminal.script.library": { "zh-CN": "脚本库", "en-US": "Script library" },
  "terminal.script.clear": { "zh-CN": "清空", "en-US": "Clear" },
  "terminal.script.sendTo": { "zh-CN": "发送给:", "en-US": "Send to:" },
  "terminal.script.target.current": { "zh-CN": "当前会话", "en-US": "Current session" },
  "terminal.script.target.all": { "zh-CN": "所有会话", "en-US": "All sessions" },
  "terminal.script.placeholder": { "zh-CN": "输入命令，Enter 换行，{modifier}+Enter 执行", "en-US": "Type a command, Enter for newline, {modifier}+Enter to run" },
  "terminal.script.run": { "zh-CN": "执行", "en-US": "Run" },
  "terminal.transfer.title": { "zh-CN": "下载管理", "en-US": "Transfers" },
  "terminal.transfer.summary": { "zh-CN": "进行中 {running} · 失败 {failed}", "en-US": "Running {running} · Failed {failed}" },
  "terminal.transfer.clear": { "zh-CN": "清理记录", "en-US": "Clear history" },
  "terminal.transfer.empty": { "zh-CN": "暂无上传或下载任务", "en-US": "No upload or download tasks" },
  "terminal.transfer.status.running": { "zh-CN": "传输中", "en-US": "In progress" },
  "terminal.transfer.status.success": { "zh-CN": "已完成", "en-US": "Completed" },
  "terminal.transfer.status.failed": { "zh-CN": "失败", "en-US": "Failed" },
  "terminal.transfer.direction.upload": { "zh-CN": "上传", "en-US": "Upload" },
  "terminal.transfer.direction.download": { "zh-CN": "下载", "en-US": "Download" },
  "terminal.transfer.meta": { "zh-CN": "{direction} · 开始于 {start}{endSuffix}", "en-US": "{direction} · Started {start}{endSuffix}" },
  "terminal.transfer.finishedAt": { "zh-CN": " · 结束于 {time}", "en-US": " · Finished {time}" },
  "terminal.transfer.source": { "zh-CN": "源：{path}", "en-US": "Source: {path}" },
  "terminal.transfer.target": { "zh-CN": "目标：{path}", "en-US": "Target: {path}" },
  "terminal.menu.copy": { "zh-CN": "复制", "en-US": "Copy" },
  "terminal.menu.paste": { "zh-CN": "粘贴", "en-US": "Paste" },
  "terminal.menu.clear": { "zh-CN": "清屏", "en-US": "Clear screen" },
  "terminal.menu.ai.fix": { "zh-CN": "发送给 AI（修复）", "en-US": "Send to AI (fix)" },
  "terminal.menu.ai.ask": { "zh-CN": "发送给 AI（提问）", "en-US": "Send to AI (ask)" },
  "terminal.sftp.rename.title": { "zh-CN": "重命名", "en-US": "Rename" },
  "terminal.sftp.rename.titleWithName": { "zh-CN": "重命名：{name}", "en-US": "Rename: {name}" },
  "terminal.sftp.rename.label": { "zh-CN": "新名称", "en-US": "New name" },
  "terminal.sftp.rename.placeholder": { "zh-CN": "请输入新名称", "en-US": "Enter a new name" },
  "terminal.sftp.chmod.title": { "zh-CN": "修改权限", "en-US": "Change permissions" },
  "terminal.sftp.chmod.titleWithName": { "zh-CN": "修改权限：{name}", "en-US": "Change permissions: {name}" },
  "terminal.sftp.chmod.label": { "zh-CN": "权限（八进制）", "en-US": "Permissions (octal)" },
  "terminal.sftp.chmod.placeholder": { "zh-CN": "例如 644 或 755", "en-US": "e.g. 644 or 755" },
  "terminal.sftp.chmod.hint": { "zh-CN": "格式：三位或四位八进制（如 644、755、0755）", "en-US": "Format: 3 or 4 digit octal (e.g. 644, 755, 0755)" },
};

const DEFAULT_LOCALE: Locale = DEFAULT_APP_SETTINGS["i18n.locale"];
let currentLocale: Locale = DEFAULT_LOCALE;

const normalizeLocale = (value?: string | null): Locale => {
  if (!value) return DEFAULT_LOCALE;
  const normalized = value.toLowerCase();
  if (normalized.startsWith("en")) return "en-US";
  return "zh-CN";
};

const formatMessage = (template: string, params?: Params) => {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = params[key];
    if (value === undefined || value === null) return "";
    return String(value);
  });
};

const buildTranslator = (locale: Locale) => {
  return (key: string, params?: Params) => {
    const entry = MESSAGES[key];
    if (!entry) return key;
    const message = entry[locale] ?? entry["zh-CN"] ?? key;
    return formatMessage(message, params);
  };
};

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Params) => string;
};

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: (key: string) => key,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    let disposed = false;
    const run = async () => {
      const store = await getAppSettingsStore();
      const saved = await store.get<string>("i18n.locale");
      const next = normalizeLocale(saved ?? navigator.language);
      if (!disposed) {
        currentLocale = next;
        setLocaleState(next);
      }
    };
    void run();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onUpdate = (
      event: Event,
    ) => {
      const detail = (
        event as CustomEvent<{
          key: keyof AppSettings;
          value: AppSettings[keyof AppSettings];
        }>
      ).detail;
      if (!detail || detail.key !== "i18n.locale") return;
      const next = normalizeLocale(String(detail.value));
      currentLocale = next;
      setLocaleState(next);
    };
    window.addEventListener("app-settings-updated", onUpdate);
    return () => window.removeEventListener("app-settings-updated", onUpdate);
  }, []);

  const t = useMemo(() => buildTranslator(locale), [locale]);

  const setLocale = (next: Locale) => {
    const normalized = normalizeLocale(next);
    currentLocale = normalized;
    setLocaleState(normalized);
    void writeAppSetting("i18n.locale", normalized as AppSettings["i18n.locale"]);
  };

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t,
    }),
    [locale, t],
  );

  return createElement(I18nContext.Provider, { value }, children);
}

export const useI18n = () => useContext(I18nContext);

export const getTranslator = async () => {
  const store = await getAppSettingsStore();
  const saved = await store.get<string>("i18n.locale");
  const fallback =
    typeof navigator === "undefined" ? DEFAULT_LOCALE : navigator.language;
  const locale = normalizeLocale(saved ?? fallback);
  return buildTranslator(locale);
};

export const tSync = (key: string, params?: Params) => {
  const translator = buildTranslator(currentLocale);
  return translator(key, params);
};
