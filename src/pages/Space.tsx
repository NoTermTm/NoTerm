import { useEffect, useMemo, useState } from "react";
import { AppIcon } from "../components/AppIcon";
import { Modal } from "../components/Modal";
import type { ScriptFolder, ScriptItem } from "../store/scripts";
import { readScriptsData, writeScriptsData } from "../store/scripts";
import type { Tab } from "../components/TitleBar";
import { useI18n } from "../i18n";
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

interface SpacePageProps {
  tabs: Tab[];
  setTabs: (tabs: Tab[] | ((prev: Tab[]) => Tab[])) => void;
  activeTabId: string | null;
  onOpenScriptTab: (script: ScriptItem | null) => string;
  onCloseTab: (id: string) => void;
}

const SCRIPT_TAB_PREFIX = "__space_script__:";

export function SpacePage({
  tabs,
  setTabs,
  activeTabId,
  onOpenScriptTab,
  onCloseTab,
}: SpacePageProps) {
  const { t } = useI18n();
  const [folders, setFolders] = useState<ScriptFolder[]>([]);
  const [scripts, setScripts] = useState<ScriptItem[]>([]);
  const [view, setView] = useState<WorkspaceView>({
    selectedFolderId: null,
    selectedScriptId: null,
  });
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [scriptEditors, setScriptEditors] = useState<Record<string, ScriptFormState>>({});
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
  const activeScriptTabId = activeTabId?.startsWith(SCRIPT_TAB_PREFIX)
    ? activeTabId
    : null;
  const activeScriptForm = activeScriptTabId
    ? scriptEditors[activeScriptTabId]
    : null;

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

  useEffect(() => {
    if (!activeScriptTabId) return;
    if (scriptEditors[activeScriptTabId]) return;
    const rawId = activeScriptTabId.slice(SCRIPT_TAB_PREFIX.length);
    const script =
      rawId.startsWith("new-") ? null : scripts.find((item) => item.id === rawId) ?? null;
    const nextForm: ScriptFormState = script
      ? {
          id: script.id,
          name: script.name,
          content: script.content,
          folderId: script.folderId,
        }
      : {
          id: null,
          name: "",
          content: "",
          folderId: view.selectedFolderId,
        };
    setScriptEditors((prev) => ({ ...prev, [activeScriptTabId]: nextForm }));
  }, [activeScriptTabId, scriptEditors, scripts, view.selectedFolderId]);

  useEffect(() => {
    const tabIds = new Set(tabs.map((tab) => tab.id));
    setScriptEditors((prev) => {
      let changed = false;
      const next: Record<string, ScriptFormState> = {};
      for (const [id, editor] of Object.entries(prev)) {
        if (tabIds.has(id)) {
          next[id] = editor;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tabs]);

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
    if (!folderId) return t("space.root");
    const chain: string[] = [];
    let currentId: string | null = folderId;
    while (currentId) {
      const folder = folderMap.get(currentId);
      if (!folder) break;
      chain.unshift(folder.name);
      currentId = folder.parentId;
    }
    return chain.length > 0 ? `/${chain.join("/")}` : t("space.root");
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
      window.alert(t("space.alert.selectFolder"));
      return;
    }
    const tabId = onOpenScriptTab(null);
    setScriptEditors((prev) => {
      if (prev[tabId]) return prev;
      return {
        ...prev,
        [tabId]: {
          id: null,
          name: "",
          content: "",
          folderId: view.selectedFolderId,
        },
      };
    });
  };

  const openCreateScriptForFolder = (folderId: string) => {
    const tabId = onOpenScriptTab(null);
    setScriptEditors((prev) => {
      if (prev[tabId]) return prev;
      return {
        ...prev,
        [tabId]: {
          id: null,
          name: "",
          content: "",
          folderId,
        },
      };
    });
  };

  const openEditScript = (script: ScriptItem) => {
    const tabId = onOpenScriptTab(script);
    setScriptEditors((prev) => {
      if (prev[tabId]) return prev;
      return {
        ...prev,
        [tabId]: {
          id: script.id,
          name: script.name,
          content: script.content,
          folderId: script.folderId,
        },
      };
    });
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
    if (!activeScriptTabId || !activeScriptForm) return;
    const name = activeScriptForm.name.trim();
    if (!name) return;
    if (!activeScriptForm.folderId) return;

    const ts = nowTs();
    if (activeScriptForm.id) {
      const nextScripts = scripts.map((script) =>
        script.id === activeScriptForm.id
          ? {
              ...script,
              name,
              content: activeScriptForm.content,
              folderId: activeScriptForm.folderId,
              updatedAt: ts,
            }
          : script,
      );
      await persist(folders, nextScripts);
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeScriptTabId ? { ...tab, title: name } : tab,
        ),
      );
    } else {
      const nextScript: ScriptItem = {
        id: crypto.randomUUID(),
        name,
        content: activeScriptForm.content,
        folderId: activeScriptForm.folderId,
        createdAt: ts,
        updatedAt: ts,
      };
      await persist(folders, [...scripts, nextScript]);
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeScriptTabId ? { ...tab, title: name } : tab,
        ),
      );
      setScriptEditors((prev) => ({
        ...prev,
        [activeScriptTabId]: {
          ...activeScriptForm,
          id: nextScript.id,
          name,
        },
      }));
    }
  };

  const handleDeleteScript = async (script: ScriptItem) => {
    const nextScripts = scripts.filter((s) => s.id !== script.id);
    await persist(folders, nextScripts);
    if (view.selectedScriptId === script.id) {
      setView((prev) => ({ ...prev, selectedScriptId: null }));
    }
    if (activeScriptForm?.id === script.id && activeScriptTabId) {
      onCloseTab(activeScriptTabId);
    }
    setScriptEditors((prev) => {
      const next: Record<string, ScriptFormState> = {};
      for (const [id, editor] of Object.entries(prev)) {
        if (editor.id !== script.id) next[id] = editor;
      }
      return next;
    });
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
              aria-label={isCollapsed ? t("space.tree.expand") : t("space.tree.collapse")}
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
              title={t("space.action.newScript")}
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
          <div className="space-title">{t("space.header.title")}</div>
          <div className="space-subtitle">{t("space.header.subtitle")}</div>
        </div>
        <div className="space-actions">
          <button className="btn btn-secondary" type="button" onClick={openCreateFolder}>
            <AppIcon icon="material-symbols:create-new-folder-rounded" size={16} />
            {t("space.action.newFolder")}
          </button>
          <button className="btn btn-primary" type="button" onClick={openCreateScript}>
            <AppIcon icon="material-symbols:note-add-rounded" size={16} />
            {t("space.action.newScript")}
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
          {t("space.root")}
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

      <div className={`space-content ${activeScriptForm ? "space-content--with-editor" : ""}`}>
        <div className="space-panel">
          <div className="space-panel-header">
            <span>{t("space.panel.title")}</span>
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
              <div className="space-empty">{t("space.empty")}</div>
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
        {activeScriptForm && (
          <div className="space-panel space-panel--editor">
            <div className="space-panel-header">
              <span>{t("space.editor.title")}</span>
            </div>
            <div className="space-panel-body space-editor-body">
              <div className="space-editor-meta">
                <div className="space-editor-meta-item">
                  <span className="space-editor-meta-label">{t("space.editor.folder")}</span>
                  <span>{getFolderPath(activeScriptForm.folderId)}</span>
                </div>
              </div>
              <div className="form-group">
                <label>{t("space.editor.name")}</label>
                <input
                  type="text"
                  value={activeScriptForm.name}
                  onChange={(event) =>
                    setScriptEditors((prev) => ({
                      ...prev,
                      [activeScriptTabId as string]: {
                        ...prev[activeScriptTabId as string],
                        name: event.target.value,
                      },
                    }))
                  }
                  placeholder={t("space.editor.namePlaceholder")}
                />
              </div>
              <div className="form-group">
                <label>{t("space.editor.content")}</label>
                <textarea
                  value={activeScriptForm.content}
                  onChange={(event) =>
                    setScriptEditors((prev) => ({
                      ...prev,
                      [activeScriptTabId as string]: {
                        ...prev[activeScriptTabId as string],
                        content: event.target.value,
                      },
                    }))
                  }
                  placeholder="#!/usr/bin/env bash\nset -e\n"
                  rows={12}
                />
              </div>
              <div className="space-editor-actions">
                <button className="btn btn-primary" type="button" onClick={() => void handleSaveScript()}>
                  {t("common.save")}
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => {
                    if (activeScriptTabId) {
                      onCloseTab(activeScriptTabId);
                    }
                  }}
                >
                  {t("common.close")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <Modal
        open={folderModalOpen}
        title={folderForm.id ? t("space.folder.modal.editTitle") : t("space.folder.modal.newTitle")}
        onClose={() => setFolderModalOpen(false)}
        width={420}
      >
        <div className="space-modal">
          <div className="form-group">
            <label>{t("space.folder.modal.nameLabel")}</label>
            <input
              type="text"
              value={folderForm.name}
              onChange={(event) => setFolderForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder={t("space.folder.modal.namePlaceholder")}
            />
          </div>
          <div className="space-modal-actions">
            <button className="btn btn-primary" type="button" onClick={() => void handleSaveFolder()}>
              {t("common.save")}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setFolderModalOpen(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </Modal>

    </div>
  );
}
