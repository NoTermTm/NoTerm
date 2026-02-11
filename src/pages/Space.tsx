import { useEffect, useMemo, useState } from "react";
import { AppIcon } from "../components/AppIcon";
import { Modal } from "../components/Modal";
import type { ScriptFolder, ScriptItem } from "../store/scripts";
import { readScriptsData, writeScriptsData } from "../store/scripts";
import "./Space.css";

type WorkspaceView = {
  selectedFolderId: string | null;
  selectedScriptId: string | null;
};

type FolderFormState = {
  id: string | null;
  name: string;
  parentId: string | null;
};

type ScriptFormState = {
  id: string | null;
  name: string;
  content: string;
  folderId: string | null;
};

function nowTs() {
  return Date.now();
}

function sortByName<T extends { name: string }>(items: T[]) {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

export function SpacePage() {
  const [folders, setFolders] = useState<ScriptFolder[]>([]);
  const [scripts, setScripts] = useState<ScriptItem[]>([]);
  const [view, setView] = useState<WorkspaceView>({
    selectedFolderId: null,
    selectedScriptId: null,
  });
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [scriptModalOpen, setScriptModalOpen] = useState(false);
  const [draggingScriptId, setDraggingScriptId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [folderForm, setFolderForm] = useState<FolderFormState>({
    id: null,
    name: "",
    parentId: null,
  });
  const [scriptForm, setScriptForm] = useState<ScriptFormState>({
    id: null,
    name: "",
    content: "",
    folderId: null,
  });

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const data = await readScriptsData();
      if (disposed) return;
      setFolders(data.folders);
      setScripts(data.scripts);
    };
    void load();
    return () => {
      disposed = true;
    };
  }, []);

  const persist = async (nextFolders: ScriptFolder[], nextScripts: ScriptItem[]) => {
    setFolders(nextFolders);
    setScripts(nextScripts);
    await writeScriptsData({ folders: nextFolders, scripts: nextScripts });
  };

  const folderMap = useMemo(() => {
    const map = new Map<string, ScriptFolder>();
    folders.forEach((f) => map.set(f.id, f));
    return map;
  }, [folders]);

  const folderChildren = useMemo(() => {
    const map = new Map<string | null, ScriptFolder[]>();
    folders.forEach((folder) => {
      const list = map.get(folder.parentId) ?? [];
      list.push(folder);
      map.set(folder.parentId, list);
    });
    map.forEach((list, key) => {
      map.set(key, sortByName(list));
    });
    return map;
  }, [folders]);

  const scriptsByFolder = useMemo(() => {
    const map = new Map<string | null, ScriptItem[]>();
    scripts.forEach((script) => {
      const list = map.get(script.folderId) ?? [];
      list.push(script);
      map.set(script.folderId, list);
    });
    map.forEach((list, key) => {
      map.set(key, sortByName(list));
    });
    return map;
  }, [scripts]);

  const breadcrumb = useMemo(() => {
    const chain: ScriptFolder[] = [];
    let currentId = view.selectedFolderId;
    while (currentId) {
      const folder = folderMap.get(currentId);
      if (!folder) break;
      chain.unshift(folder);
      currentId = folder.parentId;
    }
    return chain;
  }, [folderMap, view.selectedFolderId]);

  const getFolderPath = (folderId: string | null) => {
    if (!folderId) return "根目录";
    const chain: string[] = [];
    let currentId: string | null = folderId;
    while (currentId) {
      const folder = folderMap.get(currentId);
      if (!folder) break;
      chain.unshift(folder.name);
      currentId = folder.parentId;
    }
    return chain.length > 0 ? `/${chain.join("/")}` : "根目录";
  };

  const openCreateFolder = () => {
    setFolderForm({ id: null, name: "", parentId: view.selectedFolderId });
    setFolderModalOpen(true);
  };

  const openEditFolder = (folder: ScriptFolder) => {
    setFolderForm({ id: folder.id, name: folder.name, parentId: folder.parentId });
    setFolderModalOpen(true);
  };

  const openCreateScript = () => {
    if (!view.selectedFolderId) {
      window.alert("请先选择一个文件夹");
      return;
    }
    setScriptForm({ id: null, name: "", content: "", folderId: view.selectedFolderId });
    setScriptModalOpen(true);
  };

  const openCreateScriptForFolder = (folderId: string) => {
    setScriptForm({ id: null, name: "", content: "", folderId });
    setScriptModalOpen(true);
  };

  const openEditScript = (script: ScriptItem) => {
    setScriptForm({
      id: script.id,
      name: script.name,
      content: script.content,
      folderId: script.folderId,
    });
    setScriptModalOpen(true);
  };

  const handleSaveFolder = async () => {
    const name = folderForm.name.trim();
    if (!name) return;

    const ts = nowTs();
    if (folderForm.id) {
      const nextFolders = folders.map((folder) =>
        folder.id === folderForm.id
          ? { ...folder, name, parentId: folderForm.parentId, updatedAt: ts }
          : folder,
      );
      await persist(nextFolders, scripts);
    } else {
      const nextFolder: ScriptFolder = {
        id: crypto.randomUUID(),
        name,
        parentId: folderForm.parentId,
        createdAt: ts,
        updatedAt: ts,
      };
      await persist([...folders, nextFolder], scripts);
    }
    setFolderModalOpen(false);
  };

  const handleDeleteFolder = async (folder: ScriptFolder) => {
    const descendants = folders.filter((f) => f.parentId === folder.id);
    if (descendants.length > 0) return;
    const containedScripts = scripts.filter((s) => s.folderId === folder.id);
    if (containedScripts.length > 0) return;
    const remainingFolders = folders.filter((f) => f.id !== folder.id);
    const remainingScripts = scripts.filter((s) => s.folderId !== folder.id);
    await persist(remainingFolders, remainingScripts);
    if (view.selectedFolderId === folder.id) {
      setView({ selectedFolderId: folder.parentId, selectedScriptId: null });
    }
  };

  const handleSaveScript = async () => {
    const name = scriptForm.name.trim();
    if (!name) return;
    if (!scriptForm.folderId) return;

    const ts = nowTs();
    if (scriptForm.id) {
      const nextScripts = scripts.map((script) =>
        script.id === scriptForm.id
          ? {
              ...script,
              name,
              content: scriptForm.content,
              folderId: scriptForm.folderId,
              updatedAt: ts,
            }
          : script,
      );
      await persist(folders, nextScripts);
    } else {
      const nextScript: ScriptItem = {
        id: crypto.randomUUID(),
        name,
        content: scriptForm.content,
        folderId: scriptForm.folderId,
        createdAt: ts,
        updatedAt: ts,
      };
      await persist(folders, [...scripts, nextScript]);
    }
    setScriptModalOpen(false);
  };

  const handleDeleteScript = async (script: ScriptItem) => {
    const nextScripts = scripts.filter((s) => s.id !== script.id);
    await persist(folders, nextScripts);
    if (view.selectedScriptId === script.id) {
      setView((prev) => ({ ...prev, selectedScriptId: null }));
    }
  };

  const moveScriptToFolder = async (scriptId: string, folderId: string | null) => {
    const target = scripts.find((s) => s.id === scriptId);
    if (!target) return;
    if (target.folderId === folderId) return;
    const nextScripts = scripts.map((script) =>
      script.id === scriptId
        ? { ...script, folderId, updatedAt: nowTs() }
        : script,
    );
    await persist(folders, nextScripts);
  };

  const renderFolderNode = (folder: ScriptFolder, depth: number) => {
    const childFolders = folderChildren.get(folder.id) ?? [];
    const childScripts = scriptsByFolder.get(folder.id) ?? [];
    const indent = 8 + depth * 16;
    const isCollapsed = collapsedFolderIds.has(folder.id);
    const hasChildren = childFolders.length > 0 || childScripts.length > 0;

    return (
      <div key={folder.id} className="space-tree-node">
        <div
          className={`space-row space-row--folder ${dragOverFolderId === folder.id ? "space-row--drop" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOverFolderId(folder.id);
          }}
          onDragLeave={() => setDragOverFolderId(null)}
          onDrop={() => {
            if (!draggingScriptId) return;
            void moveScriptToFolder(draggingScriptId, folder.id);
            setDragOverFolderId(null);
            setDraggingScriptId(null);
          }}
        >
          <div
            className="space-row-main"
            style={{ paddingLeft: indent }}
            role="button"
            tabIndex={0}
            onClick={() => setView({ selectedFolderId: folder.id, selectedScriptId: null })}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setView({ selectedFolderId: folder.id, selectedScriptId: null });
              }
            }}
          >
            <button
              type="button"
              className={`space-tree-toggle ${hasChildren ? "" : "space-tree-toggle--disabled"}`}
              onClick={(event) => {
                event.stopPropagation();
                if (!hasChildren) return;
                setCollapsedFolderIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(folder.id)) {
                    next.delete(folder.id);
                  } else {
                    next.add(folder.id);
                  }
                  return next;
                });
              }}
              aria-label={isCollapsed ? "展开" : "收起"}
            >
              <AppIcon
                icon={
                  isCollapsed
                    ? "material-symbols:chevron-right-rounded"
                    : "material-symbols:expand-more-rounded"
                }
                size={14}
              />
            </button>
            <AppIcon icon="material-symbols:folder-rounded" size={16} />
            {folder.name}
          </div>
          <div className="space-row-actions">
            <button
              type="button"
              onClick={() => openCreateScriptForFolder(folder.id)}
              title="新建脚本"
            >
              <AppIcon icon="material-symbols:note-add-rounded" size={14} />
            </button>
            <button type="button" onClick={() => openEditFolder(folder)}>
              <AppIcon icon="material-symbols:edit-rounded" size={14} />
            </button>
            <button type="button" onClick={() => void handleDeleteFolder(folder)}>
              <AppIcon icon="material-symbols:delete-rounded" size={14} />
            </button>
          </div>
        </div>

        {!isCollapsed && (
          <div className="space-tree-children">
            {childFolders.map((child) => renderFolderNode(child, depth + 1))}

            {childScripts.map((script) => (
              <div
                key={script.id}
                className={`space-row space-row--script ${draggingScriptId === script.id ? "space-row--dragging" : ""}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/plain", script.id);
                  setDraggingScriptId(script.id);
                }}
                onDragEnd={() => {
                  setDraggingScriptId(null);
                  setDragOverFolderId(null);
                }}
              >
                <div
                  className="space-row-main"
                  style={{ paddingLeft: indent + 32 }}
                  role="button"
                  tabIndex={0}
                  onClick={() => setView((prev) => ({ ...prev, selectedScriptId: script.id }))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setView((prev) => ({ ...prev, selectedScriptId: script.id }));
                    }
                  }}
                >
                  <span className="space-tree-branch" aria-hidden="true" />
                  <AppIcon icon="material-symbols:terminal-rounded" size={16} />
                  {script.name}
                </div>
                <span className="space-row-meta">{getFolderPath(script.folderId)}</span>
                <div className="space-row-actions">
                  <button type="button" onClick={() => openEditScript(script)}>
                    <AppIcon icon="material-symbols:edit-rounded" size={14} />
                  </button>
                  <button type="button" onClick={() => void handleDeleteScript(script)}>
                    <AppIcon icon="material-symbols:delete-rounded" size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-page">
      <div className="space-header">
        <div>
          <div className="space-title">空间</div>
          <div className="space-subtitle">脚本管理</div>
        </div>
        <div className="space-actions">
          <button className="btn btn-secondary" type="button" onClick={openCreateFolder}>
            <AppIcon icon="material-symbols:create-new-folder-rounded" size={16} />
            新建文件夹
          </button>
          <button className="btn btn-primary" type="button" onClick={openCreateScript}>
            <AppIcon icon="material-symbols:note-add-rounded" size={16} />
            新建脚本
          </button>
        </div>
      </div>

      <div className="space-toolbar">
        <button
          type="button"
          className="space-breadcrumb"
          onClick={() => setView({ selectedFolderId: null, selectedScriptId: null })}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => {
            if (!draggingScriptId) return;
            void moveScriptToFolder(draggingScriptId, null);
            setDragOverFolderId(null);
            setDraggingScriptId(null);
          }}
        >
          根目录
        </button>
        {breadcrumb.map((folder) => (
          <button
            key={folder.id}
            type="button"
            className="space-breadcrumb"
            onClick={() => setView({ selectedFolderId: folder.id, selectedScriptId: null })}
          >
            / {folder.name}
          </button>
        ))}
      </div>

      <div className="space-content">
        <div className="space-panel">
          <div className="space-panel-header">
            <span>脚本与文件夹</span>
          </div>
          <div
            className="space-panel-body"
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (!draggingScriptId) return;
              void moveScriptToFolder(draggingScriptId, null);
              setDragOverFolderId(null);
              setDraggingScriptId(null);
            }}
          >
            {folders.length === 0 && scripts.length === 0 && (
              <div className="space-empty">暂无内容</div>
            )}

            {(folderChildren.get(null) ?? []).map((folder) => (
              <div key={folder.id} className="space-tree">
                {renderFolderNode(folder, 0)}
              </div>
            ))}

            {(scriptsByFolder.get(null) ?? []).map((script) => (
              <div
                key={script.id}
                className={`space-row space-row--script ${draggingScriptId === script.id ? "space-row--dragging" : ""}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/plain", script.id);
                  setDraggingScriptId(script.id);
                }}
                onDragEnd={() => {
                  setDraggingScriptId(null);
                  setDragOverFolderId(null);
                }}
                style={{ marginLeft: 8 }}
              >
                <div
                  className="space-row-main"
                  role="button"
                  tabIndex={0}
                  onClick={() => setView((prev) => ({ ...prev, selectedScriptId: script.id }))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setView((prev) => ({ ...prev, selectedScriptId: script.id }));
                    }
                  }}
                >
                  <AppIcon icon="material-symbols:terminal-rounded" size={16} />
                  {script.name}
                </div>
                <span className="space-row-meta">{getFolderPath(script.folderId)}</span>
                <div className="space-row-actions">
                  <button type="button" onClick={() => openEditScript(script)}>
                    <AppIcon icon="material-symbols:edit-rounded" size={14} />
                  </button>
                  <button type="button" onClick={() => void handleDeleteScript(script)}>
                    <AppIcon icon="material-symbols:delete-rounded" size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Modal
        open={folderModalOpen}
        title={folderForm.id ? "编辑文件夹" : "新建文件夹"}
        onClose={() => setFolderModalOpen(false)}
        width={420}
      >
        <div className="space-modal">
          <div className="form-group">
            <label>文件夹名称</label>
            <input
              type="text"
              value={folderForm.name}
              onChange={(event) => setFolderForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="例如 自动化"
            />
          </div>
          <div className="space-modal-actions">
            <button className="btn btn-primary" type="button" onClick={() => void handleSaveFolder()}>
              保存
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setFolderModalOpen(false)}>
              取消
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={scriptModalOpen}
        title={scriptForm.id ? "编辑脚本" : "新建脚本"}
        onClose={() => setScriptModalOpen(false)}
        width={640}
      >
        <div className="space-modal">
          <div className="form-group">
            <label>脚本名称</label>
            <input
              type="text"
              value={scriptForm.name}
              onChange={(event) => setScriptForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="例如 deploy-prod"
            />
          </div>
          <div className="form-group">
            <label>脚本内容（bash）</label>
            <textarea
              value={scriptForm.content}
              onChange={(event) => setScriptForm((prev) => ({ ...prev, content: event.target.value }))}
              placeholder="#!/usr/bin/env bash\nset -e\n"
              rows={10}
            />
          </div>
          <div className="space-modal-actions">
            <button className="btn btn-primary" type="button" onClick={() => void handleSaveScript()}>
              保存
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setScriptModalOpen(false)}>
              取消
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
