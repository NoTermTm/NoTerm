import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PointerEvent } from "react";
import { AppIcon } from "./AppIcon";
import "./TitleBar.css";

export interface Tab {
  id: string;
  title: string;
  subtitle?: string;
}

interface TitleBarProps {
  tabs?: Tab[];
  activeTabId?: string | null;
  onTabClick?: (id: string) => void;
  onTabClose?: (id: string) => void;
  onNewTab?: () => void;
}

// 用于标识特殊的页面标签（如设置、密钥管理等）
const SETTINGS_TAB_ID = "__settings__";
const KEYS_TAB_ID = "__keys__";

export function TitleBar({
  tabs = [],
  activeTabId,
  onTabClick,
  onTabClose,
  onNewTab,
}: TitleBarProps) {
  const appWindow = getCurrentWindow();

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Only start dragging on primary button.
    if (event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (!target) return;

    // Avoid hijacking interactions (buttons, tabs, form elements, links).
    if (
      target.closest(
        "button, a, input, textarea, select, option, [role='button'], .tab",
      )
    ) {
      return;
    }

    event.preventDefault();
    void appWindow.startDragging();
  };

  const handleMinimize = () => {
    appWindow.minimize();
  };

  const handleMaximize = () => {
    appWindow.toggleMaximize();
  };

  const handleClose = () => {
    appWindow.close();
  };

  return (
    <div className="title-bar" onPointerDown={handlePointerDown}>
      <div className="title-bar-left">
        <div className="traffic-lights">
          <button
            className="traffic-light close"
            onClick={handleClose}
            aria-label="Close"
          >
            <AppIcon icon="material-symbols:close-rounded" size={10} />
          </button>
          <button
            className="traffic-light minimize"
            onClick={handleMinimize}
            aria-label="Minimize"
          >
            <AppIcon icon="material-symbols:minimize-rounded" size={10} />
          </button>
          <button
            className="traffic-light maximize"
            onClick={handleMaximize}
            aria-label="Maximize"
          >
            <AppIcon icon="material-symbolsNoTermll-rounded" size={10} />
          </button>
        </div>
        {tabs.length === 0 && (
          <div className="title-bar-title">SSH Manager</div>
        )}
      </div>

      {tabs.length > 0 && (
        <div className="title-bar-center">
          <div className="title-bar-tabs">
            {tabs.map((tab, index) => (
              <div
                key={tab.id}
                className={`tab ${activeTabId === tab.id ? "active" : ""}`}
                onClick={() => onTabClick?.(tab.id)}
              >
                <div className="tab-content">
                  <div className="tab-title">{tab.title}</div>
                  {/*{tab.subtitle && <div className="tab-subtitle">{tab.subtitle}</div>}*/}
                </div>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose?.(tab.id);
                  }}
                >
                  <AppIcon icon="material-symbols:close-rounded" size={12} />
                </button>
              </div>
            ))}
            <button className="new-tab-btn" onClick={onNewTab} title="新建会话">
              <AppIcon icon="material-symbols:add-rounded" size={16} />
            </button>
          </div>
        </div>
      )}

      <div className="title-bar-right">{/* 可以在这里添加其他控件 */}</div>
    </div>
  );
}
