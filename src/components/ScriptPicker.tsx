import { useEffect, useMemo, useState } from "react";
import type { ScriptItem } from "../store/scripts";
import { readScriptsData } from "../store/scripts";
import { AppIcon } from "./AppIcon";
import { Modal } from "./Modal";
import "./ScriptPicker.css";

type ScriptPickerProps = {
  open: boolean;
  onClose: () => void;
  onSelect: (script: ScriptItem) => void;
};

export function ScriptPicker({ open, onClose, onSelect }: ScriptPickerProps) {
  const [scripts, setScripts] = useState<ScriptItem[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const load = async () => {
      const data = await readScriptsData();
      if (!disposed) setScripts(data.scripts);
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scripts;
    return scripts.filter((s) => s.name.toLowerCase().includes(q));
  }, [scripts, search]);

  return (
    <Modal open={open} title="选择脚本" onClose={onClose} width={520}>
      <div className="script-picker">
        <div className="script-picker-search">
          <AppIcon icon="material-symbols:search-rounded" size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索脚本"
          />
        </div>
        <div className="script-picker-list">
          {filtered.length === 0 && <div className="script-picker-empty">暂无脚本</div>}
          {filtered.map((script) => (
            <button
              key={script.id}
              type="button"
              className="script-picker-item"
              onClick={() => {
                onSelect(script);
                onClose();
              }}
            >
              <span className="script-picker-name">{script.name}</span>
              <span className="script-picker-meta">bash</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
