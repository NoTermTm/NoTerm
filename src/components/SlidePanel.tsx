import { ReactNode } from "react";
import { AppIcon } from "./AppIcon";
import "./SlidePanel.css";

interface SlidePanelProps {
  isOpen: boolean;
  title: string;
  children: ReactNode;
  onAdd?: () => void;
  closePanel?: () => void;
  dockToWindow?: boolean;
}

export function SlidePanel({
  isOpen,
  title,
  children,
  onAdd,
  dockToWindow,
}: SlidePanelProps) {
  return (
    <div
      className={[
        "slide-panel",
        isOpen ? "open" : "",
        dockToWindow ? "slide-panel--dock-window" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="slide-panel-header">
        <h2 className="slide-panel-title">{title}</h2>
        <div className="slide-panel-bar">
          {onAdd && (
            <button
              className="slide-panel-add-btn"
              onClick={onAdd}
              title="Add new"
            >
              <AppIcon icon="proicons:add" size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="slide-panel-content">{children}</div>
    </div>
  );
}
