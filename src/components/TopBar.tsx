import { X, Plus } from "lucide-react";
import "./TopBar.css";

export interface Tab {
  id: string;
  title: string;
  subtitle?: string;
}

interface TopBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
  onNewTab: () => void;
}

export function TopBar({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onNewTab,
}: TopBarProps) {
  return (
    <div className="top-bar">
      <div className="tabs-container">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${activeTabId === tab.id ? "active" : ""}`}
            onClick={() => onTabClick(tab.id)}
          >
            <div className="tab-content">
              <div className="tab-title">{tab.title}</div>
              {tab.subtitle && (
                <div className="tab-subtitle">{tab.subtitle}</div>
              )}
            </div>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab.id);
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
  );
}
