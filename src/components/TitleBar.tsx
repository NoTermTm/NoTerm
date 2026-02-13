import { getCurrentWindow } from "@tauri-apps/api/window";
import type { CSSProperties, PointerEvent } from "react";
import { AppIcon } from "./AppIcon";
import "./TitleBar.css";

export interface Tab {
  id: string;
  title: string;
  subtitle?: string;
  color?: string;
}

interface TitleBarProps {
  tabs?: Tab[];
  activeTabId?: string | null;
  onTabClick?: (id: string) => void;
  onTabClose?: (id: string) => void;
  onNewTab?: () => void;
}

const parseColorToRgb = (color: string): [number, number, number] | null => {
  const normalized = color.trim();
  const shortHex = normalized.match(/^#([0-9a-fA-F]{3})$/);
  if (shortHex) {
    const chars = shortHex[1];
    return [
      parseInt(chars[0] + chars[0], 16),
      parseInt(chars[1] + chars[1], 16),
      parseInt(chars[2] + chars[2], 16),
    ];
  }

  const longHex = normalized.match(/^#([0-9a-fA-F]{6})$/);
  if (longHex) {
    const hex = longHex[1];
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }

  const rgb = normalized.match(
    /^rgb\(\s*([01]?\d?\d|2[0-4]\d|25[0-5])\s*,\s*([01]?\d?\d|2[0-4]\d|25[0-5])\s*,\s*([01]?\d?\d|2[0-4]\d|25[0-5])\s*\)$/,
  );
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }

  return null;
};

const buildTabColorStyle = (
  color: string | undefined,
  isActive: boolean,
): CSSProperties | undefined => {
  if (!color) return undefined;
  const rgb = parseColorToRgb(color);
  if (!rgb) return undefined;
  const [r, g, b] = rgb;

  return {
    "--tab-color-bg": `rgba(${r}, ${g}, ${b}, ${isActive ? 0.24 : 0.14})`,
    "--tab-color-bg-hover": `rgba(${r}, ${g}, ${b}, ${isActive ? 0.28 : 0.19})`,
    "--tab-color-border": `rgba(${r}, ${g}, ${b}, ${isActive ? 0.64 : 0.4})`,
  } as CSSProperties;
};

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
            <AppIcon icon="material-symbols:check-indeterminate-small-rounded" size={10} />
          </button>
          <button
            className="traffic-light maximize"
            onClick={handleMaximize}
            aria-label="Maximize"
          >
            <AppIcon icon="material-symbols:collapse-content-rounded" size={10} />
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
                className={`tab ${activeTabId === tab.id ? "active" : ""} ${tab.color ? "tab--colored" : ""}`}
                style={buildTabColorStyle(tab.color, activeTabId === tab.id)}
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
