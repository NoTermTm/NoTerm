import { ReactNode } from 'react';
import './SlidePanel.css';

interface SlidePanelProps {
  isOpen: boolean;
  title: string;
  children: ReactNode;
  onAdd?: () => void;
}

export function SlidePanel({ isOpen, title, children, onAdd }: SlidePanelProps) {
  return (
    <div className={`slide-panel ${isOpen ? 'open' : ''}`}>
      <div className="slide-panel-header">
        <h2 className="slide-panel-title">{title}</h2>
        {onAdd && (
          <button className="slide-panel-add-btn" onClick={onAdd} title="Add new">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        )}
      </div>
      <div className="slide-panel-content">
        {children}
      </div>
    </div>
  );
}
