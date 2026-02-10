import { X, Plus } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

export function TitleBar({
  tabs = [],
  activeTabId,
  onTabClick,
  onTabClose,
  onNewTab,
}: TitleBarProps) {
  const appWindow = getCurrentWindow();

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
    <div className="title-bar" data-tauri-drag-region>
      <div className="title-bar-left">
        <div className="traffic-lights">
          <button
            className="traffic-light close"
            onClick={handleClose}
            aria-label="Close"
          >
            <X size={10} strokeWidth={3} />
          </button>
          <button
            className="traffic-light minimize"
            onClick={handleMinimize}
            aria-label="Minimize"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <line
                x1="2"
                y1="5"
                x2="8"
                y2="5"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </button>
          <button
            className="traffic-light maximize"
            onClick={handleMaximize}
            aria-label="Maximize"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path
                d="M3 3 L7 7 M7 3 L3 7"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </button>
        </div>
        {tabs.length === 0 && (
          <div className="title-bar-title">SSH Manager</div>
        )}
      </div>

      {tabs.length > 0 && (
        <div className="title-bar-center">
          <div className="title-bar-tabs">
            {tabs.map((tab) => (
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
                  <X size={12} />
                </button>
              </div>
            ))}
            <button className="new-tab-btn" onClick={onNewTab} title="新建会话">
              <Plus size={16} />
            </button>
          </div>
        </div>
      )}

      <div className="title-bar-right">{/* 可以在这里添加其他控件 */}</div>
    </div>
  );
}
