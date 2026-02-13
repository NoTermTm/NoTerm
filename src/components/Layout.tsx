import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { load } from "@tauri-apps/plugin-store";
import { check as checkForUpdates } from "@tauri-apps/plugin-updater";
import { useNavigate, useLocation } from "react-router-dom";
import { TitleBar, Tab } from "./TitleBar";
import { AppIcon } from "./AppIcon";
import { ConnectionsPage } from "../pages/Connections";
import { KeysPage } from "../pages/Keys";
import { SettingsPage } from "../pages/Settings";
import { SpacePage } from "../pages/Space";
import type { ScriptItem } from "../store/scripts";
import {
  DEFAULT_APP_SETTINGS,
  getAppSettingsStore,
  writeAppSetting,
  type AppSettings,
} from "../store/appSettings";
import { writeScriptsData } from "../store/scripts";
import { verifyMasterKey } from "../utils/security";
import {
  clearMasterKeySession,
  getMasterKeySession,
  setMasterKeySession,
} from "../utils/securitySession";
import { useI18n } from "../i18n";
import "./Layout.css";

export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [activePanel, setActivePanel] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [messagePanel, setMessagePanel] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [messages, setMessages] = useState<
    Array<{
      id: string;
      title: string;
      detail?: string;
      tone?: "info" | "success" | "error";
      createdAt: number;
    }>
  >([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [toasts, setToasts] = useState<
    Array<{
      id: string;
      title: string;
      detail?: string;
      tone?: "info" | "success" | "error";
    }>
  >([]);
  const [securitySettings, setSecuritySettings] = useState({
    hash: DEFAULT_APP_SETTINGS["security.masterKeyHash"],
    salt: DEFAULT_APP_SETTINGS["security.masterKeySalt"],
    timeout: DEFAULT_APP_SETTINGS["security.lockTimeoutMinutes"],
  });
  const [securityLoaded, setSecurityLoaded] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [unlockInput, setUnlockInput] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const { t } = useI18n();
  const lastActiveAtRef = useRef(Date.now());
  const wasLockedRef = useRef(false);
  const autoUpdateCheckedRef = useRef(false);
  const appWindow = getCurrentWindow();
  const messageButtonRef = useRef<HTMLButtonElement>(null);
  const unlockInputRef = useRef<HTMLInputElement>(null);
  const toastTimersRef = useRef<Map<string, number>>(new Map());
  const SPACE_SCRIPT_TAB_PREFIX = "__space_script__:";
  
  // 用于标识特殊的页面标签（如设置、密钥管理等）
  const SETTINGS_TAB_ID = "__settings__";
  const KEYS_TAB_ID = "__keys__";
  const SPACE_TAB_ID = "__space__";
  const MESSAGE_LIMIT = 50;

  useEffect(() => {
    if (location.pathname === "/") {
      navigate("/connections", { replace: true });
    }
  }, [location.pathname, navigate]);

  useEffect(() => {
    let disposed = false;
    const run = async () => {
      const store = await getAppSettingsStore();
      const hash =
        (await store.get<string>("security.masterKeyHash")) ??
        DEFAULT_APP_SETTINGS["security.masterKeyHash"];
      const salt =
        (await store.get<string>("security.masterKeySalt")) ??
        DEFAULT_APP_SETTINGS["security.masterKeySalt"];
      const timeout =
        (await store.get<number>("security.lockTimeoutMinutes")) ??
        DEFAULT_APP_SETTINGS["security.lockTimeoutMinutes"];
      if (!disposed) {
        setSecuritySettings({ hash, salt, timeout });
        setSecurityLoaded(true);
      }
    };
    void run();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const onSettingsUpdate = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          key: keyof AppSettings;
          value: AppSettings[keyof AppSettings];
        }>
      ).detail;
      if (!detail) return;
      if (detail.key === "security.masterKeyHash") {
        setSecuritySettings((prev) => ({
          ...prev,
          hash: String(detail.value ?? ""),
        }));
      }
      if (detail.key === "security.masterKeySalt") {
        setSecuritySettings((prev) => ({
          ...prev,
          salt: String(detail.value ?? ""),
        }));
      }
      if (detail.key === "security.lockTimeoutMinutes") {
        setSecuritySettings((prev) => ({
          ...prev,
          timeout: Math.max(0, Number(detail.value) || 0),
        }));
      }
    };
    window.addEventListener("app-settings-updated", onSettingsUpdate);
    return () => {
      window.removeEventListener("app-settings-updated", onSettingsUpdate);
    };
  }, []);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select";
    };

    const isTerminalTarget = (event: Event) => {
      const path = event.composedPath?.() ?? [];
      let isSftp = false;
      let isTerminal = false;
      for (const node of path) {
        if (!(node instanceof Element)) continue;
        if (node.closest(".xterminal-sftp, .xterminal-sftp-menu")) {
          isSftp = true;
        }
        if (node.closest(".xterminal-mount, .xterm")) {
          isTerminal = true;
        }
      }
      if (isSftp) return false;
      return isTerminal;
    };

    const onContextMenu = (event: Event) => {
      if (isTerminalTarget(event)) return;
      event.preventDefault();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isLocked) return;
      const key = event.key.toLowerCase();
      const isCmdOrCtrl = event.metaKey || event.ctrlKey;

      const isReload =
        key === "f5" ||
        (isCmdOrCtrl && key === "r");

      const isBackForward =
        key === "browserback" ||
        key === "browserforward" ||
        (event.altKey && (key === "arrowleft" || key === "arrowright")) ||
        (isCmdOrCtrl && (key === "[" || key === "]"));

      const isBackspaceNav = key === "backspace" && !isEditableTarget(event.target);

      const isNewSessionShortcut = isCmdOrCtrl && key === "t";
      const isSplitShortcut = isCmdOrCtrl && key === "d";
      const isLockShortcut = isCmdOrCtrl && key === "g";
      const isToggleConnectionsShortcut = isCmdOrCtrl && key === "b";
      const isTabSwitchShortcut =
        isCmdOrCtrl &&
        (event.code === "Backquote" || key === "`" || key === "~");

      if (isNewSessionShortcut) {
        event.preventDefault();
        event.stopPropagation();
        handleNewTab();
        return;
      }

      if (isTabSwitchShortcut) {
        event.preventDefault();
        event.stopPropagation();
        if (tabs.length === 0) return;
        const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
        const startIndex = currentIndex >= 0 ? currentIndex : 0;
        const direction = event.shiftKey ? -1 : 1;
        const nextIndex = (startIndex + direction + tabs.length) % tabs.length;
        handleTabClick(tabs[nextIndex].id);
        return;
      }

      if (isToggleConnectionsShortcut) {
        event.preventDefault();
        event.stopPropagation();
        if (location.pathname === "/connections") {
          setActivePanel((prev) => (prev === "connections" ? null : "connections"));
        }
        return;
      }

      if (isSplitShortcut) {
        event.preventDefault();
        event.stopPropagation();
        if (
          activeTabId &&
          activeTabId !== SETTINGS_TAB_ID &&
          activeTabId !== KEYS_TAB_ID &&
          activeTabId !== SPACE_TAB_ID &&
          !isSpaceScriptTab(activeTabId)
        ) {
          navigate("/connections");
          setActivePanel(null);
          window.dispatchEvent(
            new CustomEvent("open-split-picker", {
              detail: {
                sessionId: activeTabId,
                direction: "vertical",
              },
            }),
          );
        }
        return;
      }

      if (isLockShortcut) {
        event.preventDefault();
        event.stopPropagation();
        forceLock();
        return;
      }

      if (isReload || isBackForward || isBackspaceNav) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      if (isTerminalTarget(event)) return;
      event.preventDefault();
    };

    window.addEventListener("contextmenu", onContextMenu, { capture: true });
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => {
      window.removeEventListener("contextmenu", onContextMenu, { capture: true });
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
    };
  }, [activeTabId, activePanel, isLocked, navigate, tabs]);

  useEffect(() => {
    if (!isLocked) return;
    const id = window.setTimeout(() => {
      unlockInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [isLocked]);

  useEffect(() => {
    const wasLocked = wasLockedRef.current;
    if (wasLocked && !isLocked) {
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent("app-reconnect-terminals"));
        window.dispatchEvent(
          new CustomEvent("app-unlocked", {
            detail: { activeTabId },
          }),
        );
      }, 0);
    }
    wasLockedRef.current = isLocked;
  }, [activeTabId, isLocked]);

  useEffect(() => {
    const emitWindowActivated = () => {
      if (isLocked) return;
      window.dispatchEvent(
        new CustomEvent("app-window-activated", {
          detail: { activeTabId },
        }),
      );
    };

    const onWindowFocus = () => {
      window.setTimeout(emitWindowActivated, 0);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      onWindowFocus();
    };

    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [activeTabId, isLocked]);

  useEffect(() => {
    const onActivity = () => {
      if (isLocked) return;
      lastActiveAtRef.current = Date.now();
    };
    const events: Array<keyof WindowEventMap> = [
      "mousemove",
      "mousedown",
      "keydown",
      "scroll",
      "touchstart",
    ];
    events.forEach((eventName) =>
      window.addEventListener(eventName, onActivity, { capture: true, passive: true }),
    );
    return () => {
      events.forEach((eventName) =>
        window.removeEventListener(eventName, onActivity, { capture: true }),
      );
    };
  }, [isLocked]);

  useEffect(() => {
    if (!securitySettings.hash || securitySettings.timeout <= 0) {
      setIsLocked(false);
      return;
    }
    const timer = window.setInterval(() => {
      if (isLocked) return;
      const idleMs = Date.now() - lastActiveAtRef.current;
      if (idleMs >= securitySettings.timeout * 60_000) {
        setIsLocked(true);
        clearMasterKeySession();
        setUnlockInput("");
        setUnlockError(null);
      }
    }, 5000);
    return () => {
      window.clearInterval(timer);
    };
  }, [isLocked, securitySettings.hash, securitySettings.timeout]);

  useEffect(() => {
    if (securitySettings.hash) return;
    setIsLocked(false);
    setUnlockInput("");
    setUnlockError(null);
  }, [securitySettings.hash]);

  useEffect(() => {
    if (!securityLoaded) return;
    if (!securitySettings.hash) return;
    if (getMasterKeySession()) return;
    setIsLocked(true);
    clearMasterKeySession();
    setUnlockInput("");
    setUnlockError(null);
  }, [securityLoaded, securitySettings.hash]);

  useEffect(() => {
    if (isLocked) {
      setMessagePanel(null);
    }
  }, [isLocked]);

  useEffect(() => {
    if (!messagePanel) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".message-popover, .sidebar-message-btn")) return;
      setMessagePanel(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMessagePanel(null);
      }
    };
    const onScroll = () => setMessagePanel(null);
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
  }, [messagePanel]);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    if (!securityLoaded || isLocked) return;
    if (autoUpdateCheckedRef.current) return;
    autoUpdateCheckedRef.current = true;

    const run = async () => {
      const checkedAt = new Date().toISOString();
      try {
        const update = await checkForUpdates();
        window.dispatchEvent(
          new CustomEvent("app-update-checked", {
            detail: { checkedAt },
          }),
        );
        if (!update?.available) return;

        window.dispatchEvent(
          new CustomEvent("app-update-available", {
            detail: {
              version: update.version,
              date: update.date,
              notes: update.body,
              checkedAt,
            },
          }),
        );
        window.dispatchEvent(
          new CustomEvent("app-message", {
            detail: {
              title: t("settings.update.toast.title"),
              detail: update.version
                ? t("settings.update.availableWithVersion", {
                    version: update.version,
                    dateSuffix: "",
                  })
                : t("settings.update.toast.detail"),
              tone: "info",
              toast: true,
              store: false,
              toastDuration: 3200,
            },
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        window.dispatchEvent(
          new CustomEvent("app-update-checked", {
            detail: { checkedAt, error: message },
          }),
        );
      }
    };

    const timer = window.setTimeout(() => {
      void run();
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [securityLoaded, isLocked]);

  useEffect(() => {
    if (!messagePanel) return;
    setUnreadCount(0);
  }, [messagePanel]);

  useEffect(() => {
    const createMessageId = () =>
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const onMessage = (
      event: Event,
    ) => {
      const detail = (
        event as CustomEvent<{
          title: string;
          detail?: string;
          tone?: "info" | "success" | "error";
          autoOpen?: boolean;
          toast?: boolean;
          toastDuration?: number;
          store?: boolean;
        }>
      ).detail;
      if (!detail?.title) return;
      if (detail.store !== false) {
        const message = {
          id: createMessageId(),
          title: detail.title,
          detail: detail.detail?.trim() || undefined,
          tone: detail.tone ?? "info",
          createdAt: Date.now(),
        };
        setMessages((prev) => [message, ...prev].slice(0, MESSAGE_LIMIT));
        setUnreadCount((prev) => prev + 1);
        if (detail.autoOpen || detail.tone === "error") {
          setMessagePanel((prev) => prev ?? buildMessagePanelPosition());
        }
      }
      if (detail.toast) {
        const toastId = createMessageId();
        const toast = {
          id: toastId,
          title: detail.title,
          detail: detail.detail?.trim() || undefined,
          tone: detail.tone ?? "info",
        };
        setToasts((prev) => [toast, ...prev]);
        const duration = Math.max(1200, detail.toastDuration ?? 2600);
        const timer = window.setTimeout(() => {
          setToasts((prev) => prev.filter((item) => item.id !== toastId));
          toastTimersRef.current.delete(toastId);
        }, duration);
        toastTimersRef.current.set(toastId, timer);
      }
    };
    window.addEventListener("app-message", onMessage);
    return () => {
      window.removeEventListener("app-message", onMessage);
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of toastTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      toastTimersRef.current.clear();
    };
  }, []);

  const navItems = [
    {
      path: "/connections",
      icon: "material-symbols:settop-component-outline-rounded",
      label: t("nav.connections"),
      panelId: "connections",
    },
    {
      path: "/space",
      icon: "material-symbols:folder-special-outline-rounded",
      label: t("nav.space"),
      panelId: null,
    },
    {
      path: "/keys",
      icon: "material-symbols:key-rounded",
      label: t("nav.keys"),
      panelId: null,
    },
  ];

  const bottomItems = [
    {
      path: "/settings",
      icon: "material-symbols:settings-rounded",
      label: t("nav.settings"),
      panelId: null,
    },
  ];

  const isSpaceScriptTab = (id: string) => id.startsWith(SPACE_SCRIPT_TAB_PREFIX);

  const buildMessagePanelPosition = () => {
    const panelWidth = 300;
    const panelHeight = 340;
    const padding = 12;
    const button = messageButtonRef.current;
    let left = 60;
    let top = window.innerHeight - padding - panelHeight;
    if (button) {
      const rect = button.getBoundingClientRect();
      left = Math.min(
        Math.max(padding, rect.right + 10),
        window.innerWidth - padding - panelWidth,
      );
      const preferredTop = rect.bottom - panelHeight + 12;
      top = Math.min(
        window.innerHeight - padding - panelHeight,
        Math.max(padding, preferredTop),
      );
    }
    return { x: left, y: top };
  };

  const formatMessageTime = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    if (diff < 60_000) return t("time.justNow");
    if (diff < 3_600_000) {
      return t("time.minutesAgo", {
        count: Math.max(1, Math.floor(diff / 60_000)),
      });
    }
    if (diff < 86_400_000) {
      return t("time.hoursAgo", { count: Math.floor(diff / 3_600_000) });
    }
    return new Date(timestamp).toLocaleDateString();
  };

  const handleNavClick = (path: string, panelId: string | null) => {
    // 处理连接器管理
    if (panelId === "connections") {
      // 检查是否有现存的连接终端 tabs（排除特殊页面）
      const connectionTabs = tabs.filter(
        (tab) =>
          tab.id !== SETTINGS_TAB_ID &&
          tab.id !== KEYS_TAB_ID &&
          tab.id !== SPACE_TAB_ID &&
          !isSpaceScriptTab(tab.id),
      );
      
      if (connectionTabs.length > 0) {
        // 如果有连接 tabs，切换到最后一个连接 tab
        const lastConnectionTab = connectionTabs[connectionTabs.length - 1];
        setActiveTabId(lastConnectionTab.id);
        navigate(path);
        // 切换面板状态
        if (activePanel === panelId) {
          setActivePanel(null);
        } else {
          setActivePanel(panelId);
        }
      } else {
        // 没有连接 tabs，打开/关闭面板
        if (activePanel === panelId) {
          setActivePanel(null);
        } else {
          setActivePanel(panelId);
        }
        navigate(path);
      }
      return;
    }
    
    // 处理设置页面
    if (path === "/settings") {
      // 检查是否已有设置 tab
      const existingSettingsTab = tabs.find((tab) => tab.id === SETTINGS_TAB_ID);
      
      if (!existingSettingsTab) {
        // 创建设置 tab
        const settingsTab: Tab = {
          id: SETTINGS_TAB_ID,
          title: t("tab.settings.title"),
          subtitle: t("tab.settings.subtitle"),
        };
        setTabs((prev) => [...prev, settingsTab]);
      }
      
      setActiveTabId(SETTINGS_TAB_ID);
      setActivePanel(null);
      navigate(path);
      return;
    }
    
    // 处理密钥管理页面
    if (path === "/keys") {
      // 检查是否已有密钥管理 tab
      const existingKeysTab = tabs.find((tab) => tab.id === KEYS_TAB_ID);
      
      if (!existingKeysTab) {
        // 创建密钥管理 tab
        const keysTab: Tab = {
          id: KEYS_TAB_ID,
          title: t("tab.keys.title"),
          subtitle: t("tab.keys.subtitle"),
        };
        setTabs((prev) => [...prev, keysTab]);
      }
      
      setActiveTabId(KEYS_TAB_ID);
      setActivePanel(null);
      navigate(path);
      return;
    }

    if (path === "/space") {
      const existingSpaceTab = tabs.find((tab) => tab.id === SPACE_TAB_ID);

      if (!existingSpaceTab) {
        const spaceTab: Tab = {
          id: SPACE_TAB_ID,
          title: t("tab.space.title"),
          subtitle: t("tab.space.subtitle"),
        };
        setTabs((prev) => [...prev, spaceTab]);
      }

      setActiveTabId(SPACE_TAB_ID);
      setActivePanel(null);
      navigate(path);
      return;
    }
    
    // 其他页面的处理
    if (panelId) {
      if (activePanel === panelId) {
        setActivePanel(null);
      } else {
        setActivePanel(panelId);
      }
    } else {
      setActivePanel(null);
    }
    navigate(path);
  };

  const handleTabClick = (id: string) => {
    setActiveTabId(id);
    
    // 处理特殊标签页的导航
    if (id === SETTINGS_TAB_ID) {
      navigate("/settings");
      setActivePanel(null);
    } else if (id === KEYS_TAB_ID) {
      navigate("/keys");
      setActivePanel(null);
    } else if (id === SPACE_TAB_ID) {
      navigate("/space");
      setActivePanel(null);
    } else if (isSpaceScriptTab(id)) {
      navigate("/space");
      setActivePanel(null);
    } else {
      // 普通连接 tab，导航到连接页面
      navigate("/connections");
    }
  };

  const handleTabClose = (id: string) => {
    // 关闭标签
    setTabs((prev) => prev.filter((tab) => tab.id !== id));
    
    // 如果关闭的是当前激活的标签
    if (activeTabId === id) {
      const remainingTabs = tabs.filter((tab) => tab.id !== id);
      
      if (remainingTabs.length > 0) {
        // 切换到最后一个标签
        const lastTab = remainingTabs[remainingTabs.length - 1];
        setActiveTabId(lastTab.id);
        
        // 根据标签类型导航
        if (lastTab.id === SETTINGS_TAB_ID) {
          navigate("/settings");
          setActivePanel(null);
        } else if (lastTab.id === KEYS_TAB_ID) {
          navigate("/keys");
          setActivePanel(null);
        } else if (lastTab.id === SPACE_TAB_ID) {
          navigate("/space");
          setActivePanel(null);
        } else if (isSpaceScriptTab(lastTab.id)) {
          navigate("/space");
          setActivePanel(null);
        } else {
          navigate("/connections");
        }
      } else {
        // 没有剩余标签
        setActiveTabId(null);
        navigate("/connections");
      }
    }
  };

  const handleNewTab = () => {
    navigate("/connections");
    setActivePanel(null);
    window.dispatchEvent(new CustomEvent("open-connection-picker"));
  };

  const handleOpenScriptTab = (script: ScriptItem | null) => {
    const tabId = script
      ? `${SPACE_SCRIPT_TAB_PREFIX}${script.id}`
      : `${SPACE_SCRIPT_TAB_PREFIX}new-${crypto.randomUUID()}`;
    const title = script?.name || t("tab.script.new");
    const subtitle = t("tab.script.subtitle");

    setTabs((prev) => {
      if (prev.some((tab) => tab.id === tabId)) return prev;
      return [...prev, { id: tabId, title, subtitle }];
    });
    setActiveTabId(tabId);
    setActivePanel(null);
    navigate("/space");
    return tabId;
  };

  const handleUnlock = async () => {
    if (unlocking || !securitySettings.hash) return;
    if (!unlockInput.trim()) {
      setUnlockError(t("app.lock.error.empty"));
      return;
    }
    setUnlocking(true);
    setUnlockError(null);
    try {
      const ok = await verifyMasterKey(
        unlockInput,
        securitySettings.salt,
        securitySettings.hash,
      );
      if (!ok) {
        setUnlockError(t("app.lock.error.invalid"));
        return;
      }
      setIsLocked(false);
      setUnlockInput("");
      setUnlockError(null);
      setMasterKeySession(unlockInput);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("master-key-updated"));
      }
      lastActiveAtRef.current = Date.now();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUnlockError(message || t("app.lock.error.verifyFail"));
    } finally {
      setUnlocking(false);
    }
  };

  const handleResetMasterKey = async () => {
    if (resetting) return;
    setResetting(true);
    setUnlockError(null);
    try {
      for (const key of Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettings>) {
        await writeAppSetting(key, DEFAULT_APP_SETTINGS[key]);
      }

      const connectionStore = await load("connections.json");
      await connectionStore.set("connections", []);
      await connectionStore.save();

      const keysStore = await load("keys.json");
      await keysStore.set("profiles", []);
      await keysStore.save();

      await writeScriptsData({ folders: [], scripts: [] });

      clearMasterKeySession();
      setSecuritySettings({
        hash: DEFAULT_APP_SETTINGS["security.masterKeyHash"],
        salt: DEFAULT_APP_SETTINGS["security.masterKeySalt"],
        timeout: DEFAULT_APP_SETTINGS["security.lockTimeoutMinutes"],
      });
      setIsLocked(false);
      setUnlockInput("");
      setUnlockError(null);
      setResetConfirmOpen(false);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("app-message", {
            detail: {
              title: t("app.lock.reset.toast.title"),
              detail: t("app.lock.reset.toast.detail"),
              tone: "info",
              toast: true,
              store: false,
            },
          }),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUnlockError(message || t("app.lock.reset.fail"));
    } finally {
      setResetting(false);
    }
  };

  const forceLock = () => {
    if (!securitySettings.hash) return;
    setIsLocked(true);
    clearMasterKeySession();
    setUnlockInput("");
    setUnlockError(null);
    lastActiveAtRef.current = Date.now();
  };

  return (
    <div className="app-container">
      <TitleBar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabClick={handleTabClick}
        onTabClose={handleTabClose}
        onNewTab={handleNewTab}
      />
      <div className="layout">
        <div className="sidebar">
          {navItems.map((item) => (
            <button
              key={item.path}
              className={`sidebar-item ${
                item.panelId
                  ? activePanel === item.panelId
                    ? "active"
                    : ""
                  : location.pathname === item.path
                    ? "active"
                    : ""
              }`}
              onClick={() => handleNavClick(item.path, item.panelId)}
              title={item.label}
            >
              <AppIcon icon={item.icon} size={20} />
            </button>
          ))}

          <div className="sidebar-spacer" />

          <button
            className={`sidebar-item sidebar-message-btn ${messagePanel ? "active" : ""}`}
            ref={messageButtonRef}
            onClick={() => {
              setMessagePanel((prev) => (prev ? null : buildMessagePanelPosition()));
            }}
            title={t("messages.title")}
          >
            <AppIcon icon="material-symbols:notifications-rounded" size={20} />
            {unreadCount > 0 && (
              <span className="sidebar-message-badge">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>

          {bottomItems.map((item) => (
            <button
              key={item.path}
              className={`sidebar-item ${location.pathname === item.path ? "active" : ""}`}
              onClick={() => handleNavClick(item.path, item.panelId)}
              title={item.label}
            >
              <AppIcon icon={item.icon} size={20} />
            </button>
          ))}
        </div>

        <div className="main-content">
          {/* 使用 display 控制显示，避免组件卸载导致状态丢失 */}
          <div style={{ display: location.pathname === "/connections" ? "block" : "none", height: "100%" }}>
            <ConnectionsPage
              activePanel={activePanel}
              setActivePanel={setActivePanel}
              tabs={tabs}
              setTabs={setTabs}
              activeTabId={activeTabId}
              setActiveTabId={setActiveTabId}
              onTabClick={handleTabClick}
              onTabClose={handleTabClose}
              onNewTab={handleNewTab}
            />
          </div>
          <div style={{ display: location.pathname === "/keys" ? "block" : "none", height: "100%" }}>
            <KeysPage />
          </div>
          <div style={{ display: location.pathname === "/settings" ? "block" : "none", height: "100%" }}>
            <SettingsPage />
          </div>
          <div style={{ display: location.pathname === "/space" ? "block" : "none", height: "100%" }}>
            <SpacePage
              tabs={tabs}
              setTabs={setTabs}
              activeTabId={activeTabId}
              onOpenScriptTab={handleOpenScriptTab}
              onCloseTab={handleTabClose}
            />
          </div>
          {location.pathname === "/files" && (
            <div style={{ padding: "24px" }}>{t("placeholder.sftp")}</div>
          )}
          {location.pathname === "/profile" && (
            <div style={{ padding: "24px" }}>{t("placeholder.profile")}</div>
          )}
        </div>
      </div>

      {messagePanel &&
        createPortal(
          <div
            className="message-popover-layer"
            onMouseDown={() => setMessagePanel(null)}
          >
            <div
              className="message-popover"
              style={{ left: messagePanel.x, top: messagePanel.y }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <div className="message-popover-header">
                <div className="message-popover-title">{t("messages.title")}</div>
                <div className="message-popover-actions">
                  {messages.length > 0 && (
                    <button
                      type="button"
                      className="message-popover-action"
                      onClick={() => {
                        setMessages([]);
                        setUnreadCount(0);
                      }}
                    >
                      {t("messages.clear")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="message-popover-action"
                    onClick={() => setMessagePanel(null)}
                  >
                    {t("messages.close")}
                  </button>
                </div>
              </div>
              <div className="message-popover-body">
                {messages.length === 0 ? (
                  <div className="message-empty">{t("messages.empty")}</div>
                ) : (
                  <div className="message-list">
                    {messages.map((message) => (
                      <div
                        key={message.id}
                        className={`message-item ${
                          message.tone ? `message-item--${message.tone}` : ""
                        }`}
                      >
                        <div className="message-item-header">
                          <div className="message-item-title">{message.title}</div>
                          <div className="message-item-time">
                            {formatMessageTime(message.createdAt)}
                          </div>
                        </div>
                        {message.detail && (
                          <div className="message-item-detail">{message.detail}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {toasts.length > 0 &&
        createPortal(
          <div className="toast-layer">
            {toasts.map((toast) => (
              <div
                key={toast.id}
                className={`toast ${toast.tone ? `toast--${toast.tone}` : ""}`}
              >
                <div className="toast-title">{toast.title}</div>
                {toast.detail && (
                  <div className="toast-detail">{toast.detail}</div>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}

      {isLocked && (
        <div className="lock-screen">
          <div
            className="lock-drag-region"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              void appWindow.startDragging();
            }}
          />
          <div className="lock-card">
            <div className="lock-icon">
              <AppIcon icon="material-symbols:security" size={50}/>
            </div>
            <div className="lock-title">{t("app.lock.title")}</div>
            <div className="lock-subtitle">{t("app.lock.subtitle")}</div>
            <input
              type="password"
              className="lock-input"
              placeholder={t("app.lock.placeholder")}
              value={unlockInput}
              ref={unlockInputRef}
              autoFocus
              onChange={(event) => setUnlockInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleUnlock();
                }
              }}
            />
            {unlockError && <div className="lock-error">{unlockError}</div>}
            <button
              type="button"
              className="btn btn-primary lock-button"
              onClick={() => void handleUnlock()}
              disabled={unlocking}
            >
              {unlocking ? t("app.lock.unlocking") : t("app.lock.unlock")}
            </button>
            <button
              type="button"
              className="lock-forgot-btn"
              onClick={() => setResetConfirmOpen(true)}
              disabled={resetting}
            >
              {t("app.lock.reset")}
            </button>
          </div>
          {resetConfirmOpen && (
            <div className="lock-reset-layer">
              <div className="lock-reset-card">
                <div className="lock-reset-title">{t("app.lock.reset.title")}</div>
                <div className="lock-reset-desc">{t("app.lock.reset.desc")}</div>
                <div className="lock-reset-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setResetConfirmOpen(false)}
                    disabled={resetting}
                  >
                    {t("app.lock.reset.cancel")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => void handleResetMasterKey()}
                    disabled={resetting}
                  >
                    {resetting ? t("app.lock.reset.inProgress") : t("app.lock.reset.confirm")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
