import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { TitleBar, Tab } from "./TitleBar";
import { AppIcon } from "./AppIcon";
import { ConnectionsPage } from "../pages/Connections";
import { KeysPage } from "../pages/Keys";
import { SettingsPage } from "../pages/Settings";
import { SpacePage } from "../pages/Space";
import "./Layout.css";

export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [activePanel, setActivePanel] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  
  // 用于标识特殊的页面标签（如设置、密钥管理等）
  const SETTINGS_TAB_ID = "__settings__";
  const KEYS_TAB_ID = "__keys__";

  useEffect(() => {
    if (location.pathname === "/") {
      navigate("/connections", { replace: true });
    }
  }, [location.pathname, navigate]);

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

      if (isNewSessionShortcut) {
        event.preventDefault();
        event.stopPropagation();
        handleNewTab();
        return;
      }

      if (isSplitShortcut) {
        event.preventDefault();
        event.stopPropagation();
        if (activeTabId && activeTabId !== SETTINGS_TAB_ID && activeTabId !== KEYS_TAB_ID) {
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
  }, [activeTabId, activePanel, navigate]);

  const navItems = [
    {
      path: "/connections",
      icon: "material-symbols:settop-component-outline-rounded",
      label: "连接器管理",
      panelId: "connections",
    },
    {
      path: "/space",
      icon: "material-symbols:folder-special-outline-rounded",
      label: "空间",
      panelId: null,
    },
    {
      path: "/keys",
      icon: "material-symbols:key-rounded",
      label: "密钥管理",
      panelId: null,
    },
  ];

  const bottomItems = [
    {
      path: "/profile",
      icon: "material-symbols:account-circle",
      label: "用户",
      panelId: null,
    },
    {
      path: "/settings",
      icon: "material-symbols:settings-rounded",
      label: "设置",
      panelId: null,
    },
  ];

  const handleNavClick = (path: string, panelId: string | null) => {
    // 处理连接器管理
    if (panelId === "connections") {
      // 检查是否有现存的连接终端 tabs（排除特殊页面）
      const connectionTabs = tabs.filter(
        (tab) => tab.id !== SETTINGS_TAB_ID && tab.id !== KEYS_TAB_ID
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
          title: "设置",
          subtitle: "应用配置",
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
          title: "密钥管理",
          subtitle: "SSH 认证",
        };
        setTabs((prev) => [...prev, keysTab]);
      }
      
      setActiveTabId(KEYS_TAB_ID);
      setActivePanel(null);
      navigate(path);
      return;
    }

    if (path === "/space") {
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
            <SpacePage />
          </div>
          {location.pathname === "/files" && (
            <div style={{ padding: "24px" }}>SFTP 文件管理 - 开发中</div>
          )}
          {location.pathname === "/profile" && (
            <div style={{ padding: "24px" }}>用户信息 - 开发中</div>
          )}
        </div>
      </div>
    </div>
  );
}
