import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { AppIcon } from "./AppIcon";
import { useI18n } from "../i18n";
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
  useNativeWindowControls?: boolean;
  hideCustomWindowControls?: boolean;
  showWindowsWindowControls?: boolean;
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
  useNativeWindowControls = false,
  hideCustomWindowControls = false,
  showWindowsWindowControls = false,
}: TitleBarProps) {
  const appWindow = getCurrentWindow();
  const { t } = useI18n();
  const tabsScrollRef = useRef<HTMLDivElement | null>(null);
  const [showTabScrollLeft, setShowTabScrollLeft] = useState(false);
  const [showTabScrollRight, setShowTabScrollRight] = useState(false);

  useEffect(() => {
    const el = tabsScrollRef.current;
    if (!el) return;

    const updateScrollHint = () => {
      const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
      setShowTabScrollLeft(el.scrollLeft > 2);
      setShowTabScrollRight(maxScrollLeft - el.scrollLeft > 2);
    };

    updateScrollHint();
    el.addEventListener("scroll", updateScrollHint, { passive: true });
    window.addEventListener("resize", updateScrollHint);
    return () => {
      el.removeEventListener("scroll", updateScrollHint);
      window.removeEventListener("resize", updateScrollHint);
    };
  }, [tabs, activeTabId]);

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

  const handleMaximize = async () => {
    try {
      const isFullscreen = await appWindow.isFullscreen();
      await appWindow.setFullscreen(!isFullscreen);
      return;
    } catch {
      // fallback to maximize when fullscreen API is unavailable
    }
    appWindow.toggleMaximize();
  };

  const handleClose = () => {
    appWindow.close();
  };

  return (
    <div
      className={`title-bar ${useNativeWindowControls ? "title-bar--native-controls" : ""}`}
      onPointerDown={handlePointerDown}
      data-tauri-drag-region
    >
      <div className="title-bar-left">
        {!hideCustomWindowControls && (
          <div className="traffic-lights">
            <button
              className="traffic-light close"
              onClick={handleClose}
              aria-label="Close"
            >
              <svg
                className="traffic-light-icon"
                width="7"
                height="7"
                viewBox="0 0 7 7"
                aria-hidden="true"
              >
                <path d="M1 1 L6 6 M6 1 L1 6" />
              </svg>
            </button>
            <button
              className="traffic-light minimize"
              onClick={handleMinimize}
              aria-label="Minimize"
            >
              <svg
                className="traffic-light-icon"
                width="7"
                height="7"
                viewBox="0 0 7 7"
                aria-hidden="true"
              >
                <path d="M1 3.5 L6 3.5" />
              </svg>
            </button>
            <button
              className="traffic-light maximize"
              onClick={handleMaximize}
              aria-label="Maximize"
            >
              <svg
                className="traffic-light-icon"
                width="7"
                height="7"
                viewBox="0 0 7 7"
                aria-hidden="true"
              >
                <path d="M3.5 1 L3.5 6 M1 3.5 L6 3.5" />
              </svg>
            </button>
          </div>
        )}
        {tabs.length === 0 && (
          <div className="title-bar-title">SSH Manager</div>
        )}
      </div>

      {tabs.length > 0 && (
        <div className="title-bar-center">
          <div className="title-bar-tabs-wrap">
            <div className="title-bar-tabs-shell">
              <span
                className={`title-bar-tabs-arrow title-bar-tabs-arrow--left ${showTabScrollLeft ? "is-visible" : ""}`}
                aria-hidden="true"
              >
                <AppIcon icon="material-symbols:chevron-left-rounded" size={14} />
              </span>
              <div className="title-bar-tabs" ref={tabsScrollRef}>
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
              </div>
              <span
                className={`title-bar-tabs-arrow title-bar-tabs-arrow--right ${showTabScrollRight ? "is-visible" : ""}`}
                aria-hidden="true"
              >
                <AppIcon icon="material-symbols:chevron-right-rounded" size={14} />
              </span>
            </div>
            <button
              className="new-tab-btn"
              onClick={onNewTab}
              title={t("titleBar.newSession")}
            >
              <AppIcon icon="material-symbols:add-rounded" size={16} />
            </button>
          </div>
        </div>
      )}

      <div className="title-bar-right">
        {showWindowsWindowControls && (
          <div className="title-bar-win-controls">
            <button
              className="title-bar-win-btn"
              onClick={handleMinimize}
              aria-label="Minimize"
              title={t("titleBar.minimize")}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M1 5.5H9" />
              </svg>
            </button>
            <button
              className="title-bar-win-btn"
              onClick={() => appWindow.toggleMaximize()}
              aria-label="Maximize"
              title={t("titleBar.maximize")}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M1.5 1.5H8.5V8.5H1.5Z" />
              </svg>
            </button>
            <button
              className="title-bar-win-btn title-bar-win-btn--close"
              onClick={handleClose}
              aria-label="Close"
              title={t("titleBar.close")}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2 2L8 8M8 2L2 8" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
