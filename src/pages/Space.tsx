import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { AppIcon } from "../components/AppIcon";
import { Modal } from "../components/Modal";
import type { Tab } from "../components/TitleBar";
import { useI18n } from "../i18n";
import { readScriptsData, writeScriptsData } from "../store/scripts";
import type { ScriptFolder, ScriptItem } from "../store/scripts";
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

type ExplorerEntry =
  | { kind: "folder"; folder: ScriptFolder }
  | { kind: "script"; script: ScriptItem };

function nowTs() {
  return Date.now();
}

function sortByName<T extends { name: string }>(items: T[]) {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

function formatUpdatedAt(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

interface SpacePageProps {
  tabs: Tab[];
  setTabs: (tabs: Tab[] | ((prev: Tab[]) => Tab[])) => void;
  activeTabId: string | null;
  onOpenScriptTab: (script: ScriptItem | null) => string;
  onCloseTab: (id: string) => void;
}

export function SpacePage(_props: SpacePageProps) {
  const { t } = useI18n();
  const [folders, setFolders] = useState<ScriptFolder[]>([]);
  const [scripts, setScripts] = useState<ScriptItem[]>([]);
  const [view, setView] = useState<WorkspaceView>({
    selectedFolderId: null,
    selectedScriptId: null,
  });
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [activeScriptForm, setActiveScriptForm] = useState<ScriptFormState | null>(null);
  const [pendingDeleteScript, setPendingDeleteScript] = useState<ScriptItem | null>(null);
  const [pendingDeleteFolder, setPendingDeleteFolder] = useState<ScriptFolder | null>(null);
  const [draggingScriptId, setDraggingScriptId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [folderForm, setFolderForm] = useState<FolderFormState>({
    id: null,
    name: "",
    parentId: null,
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
    folders.forEach((folder) => map.set(folder.id, folder));
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

  const currentFolders = folderChildren.get(view.selectedFolderId) ?? [];
  const currentScripts = scriptsByFolder.get(view.selectedFolderId) ?? [];
  const currentEntries = useMemo<ExplorerEntry[]>(
    () => [
      ...currentFolders.map((folder) => ({ kind: "folder" as const, folder })),
      ...currentScripts.map((script) => ({ kind: "script" as const, script })),
    ],
    [currentFolders, currentScripts],
  );
  const scriptEditorExtensions = useMemo(
    () => [StreamLanguage.define(shell)],
    [],
  );

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

  const openFolder = (folderId: string | null) => {
    setView({ selectedFolderId: folderId, selectedScriptId: null });
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
    setActiveScriptForm({
      id: null,
      name: "",
      content: "",
      folderId: view.selectedFolderId,
    });
  };

  const openCreateScriptForFolder = (folderId: string | null) => {
    if (!folderId) {
      openCreateScript();
      return;
    }
    setActiveScriptForm({
      id: null,
      name: "",
      content: "",
      folderId,
    });
  };

  const openEditScript = (script: ScriptItem) => {
    setActiveScriptForm({
      id: script.id,
      name: script.name,
      content: script.content,
      folderId: script.folderId,
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

  const collectFolderTreeIds = (rootId: string) => {
    const idSet = new Set<string>([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of folders) {
        if (!idSet.has(folder.id) && folder.parentId && idSet.has(folder.parentId)) {
          idSet.add(folder.id);
          changed = true;
        }
      }
    }
    return idSet;
  };

  const getFolderDeleteImpact = (folder: ScriptFolder) => {
    const folderIds = collectFolderTreeIds(folder.id);
    const folderCount = folderIds.size;
    const scriptCount = scripts.filter(
      (script) => script.folderId && folderIds.has(script.folderId),
    ).length;
    return { folderCount, scriptCount, folderIds };
  };

  const handleDeleteFolder = async (folder: ScriptFolder) => {
    const impact = getFolderDeleteImpact(folder);
    const remainingFolders = folders.filter((item) => !impact.folderIds.has(item.id));
    const remainingScripts = scripts.filter(
      (script) => !(script.folderId && impact.folderIds.has(script.folderId)),
    );
    await persist(remainingFolders, remainingScripts);
    if (view.selectedFolderId && impact.folderIds.has(view.selectedFolderId)) {
      setView({ selectedFolderId: folder.parentId, selectedScriptId: null });
    }
    if (activeScriptForm?.folderId && impact.folderIds.has(activeScriptForm.folderId)) {
      setActiveScriptForm(null);
    }
  };

  const requestDeleteFolder = (folder: ScriptFolder) => {
    setPendingDeleteFolder(folder);
  };

  const confirmDeleteFolder = async () => {
    if (!pendingDeleteFolder) return;
    const target = pendingDeleteFolder;
    setPendingDeleteFolder(null);
    await handleDeleteFolder(target);
  };

  const handleSaveScript = async () => {
    if (!activeScriptForm) return;
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
      setView((prev) => ({ ...prev, selectedScriptId: activeScriptForm.id }));
      setActiveScriptForm(null);
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
      setView({ selectedFolderId: nextScript.folderId, selectedScriptId: nextScript.id });
      setActiveScriptForm(null);
    }
  };

  const handleDeleteScript = async (script: ScriptItem) => {
    const nextScripts = scripts.filter((item) => item.id !== script.id);
    await persist(folders, nextScripts);
    if (view.selectedScriptId === script.id) {
      setView((prev) => ({ ...prev, selectedScriptId: null }));
    }
    if (activeScriptForm?.id === script.id) {
      setActiveScriptForm(null);
    }
  };

  const requestDeleteScript = (script: ScriptItem) => {
    setPendingDeleteScript(script);
  };

  const confirmDeleteScript = async () => {
    if (!pendingDeleteScript) return;
    const target = pendingDeleteScript;
    setPendingDeleteScript(null);
    await handleDeleteScript(target);
  };

  const moveScriptToFolder = async (scriptId: string, folderId: string | null) => {
    const target = scripts.find((script) => script.id === scriptId);
    if (!target) return;
    if (target.folderId === folderId) return;
    const nextScripts = scripts.map((script) =>
      script.id === scriptId ? { ...script, folderId, updatedAt: nowTs() } : script,
    );
    await persist(folders, nextScripts);
    setView((prev) =>
      prev.selectedScriptId === scriptId ? { ...prev, selectedScriptId: scriptId } : prev,
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
          <button className="btn btn-primary" type="button" onClick={() => openCreateScriptForFolder(view.selectedFolderId)}>
            <AppIcon icon="material-symbols:note-add-rounded" size={16} />
            {t("space.action.newScript")}
          </button>
        </div>
      </div>

      <div className="space-content space-content--main">
        <div className="space-panel">
          <div className="space-toolbar">
            <button
              type="button"
              className="space-nav-button"
              onClick={() => openFolder(view.selectedFolderId ? folderMap.get(view.selectedFolderId)?.parentId ?? null : null)}
              disabled={view.selectedFolderId === null}
            >
              <AppIcon icon="material-symbols:arrow-back-rounded" size={16} />
            </button>
            <div className="space-breadcrumbs">
              <button type="button" className="space-breadcrumb" onClick={() => openFolder(null)}>
                {t("space.root")}
              </button>
              {breadcrumb.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  className="space-breadcrumb"
                  onClick={() => openFolder(folder.id)}
                >
                  / {folder.name}
                </button>
              ))}
            </div>
          </div>

          <div className="space-list-header">
            <span>{t("space.list.name")}</span>
            <span>{t("space.list.location")}</span>
            <span>{t("space.list.updated")}</span>
          </div>
          <div
            className="space-panel-body space-list-body"
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (!draggingScriptId) return;
              void moveScriptToFolder(draggingScriptId, view.selectedFolderId);
              setDragOverFolderId(null);
              setDraggingScriptId(null);
            }}
          >
            {currentEntries.length === 0 ? <div className="space-empty">{t("space.empty")}</div> : null}

            {currentEntries.map((entry) => {
              if (entry.kind === "folder") {
                const folder = entry.folder;
                return (
                  <div
                    key={folder.id}
                    className={`space-entry ${dragOverFolderId === folder.id ? "space-entry--drop" : ""}`}
                    onClick={() => openFolder(folder.id)}
                    onDoubleClick={() => openFolder(folder.id)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragOverFolderId(folder.id);
                    }}
                    onDragLeave={() => setDragOverFolderId((prev) => (prev === folder.id ? null : prev))}
                    onDrop={() => {
                      if (!draggingScriptId) return;
                      void moveScriptToFolder(draggingScriptId, folder.id);
                      setDragOverFolderId(null);
                      setDraggingScriptId(null);
                    }}
                  >
                    <div className="space-entry-name">
                      <AppIcon icon="material-symbols:folder-rounded" size={18} />
                      <span>{folder.name}</span>
                    </div>
                    <span className="space-entry-meta">{getFolderPath(folder.parentId)}</span>
                    <span className="space-entry-meta">{formatUpdatedAt(folder.updatedAt)}</span>
                    <div className="space-entry-actions">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          openCreateScriptForFolder(folder.id);
                        }}
                      >
                        <AppIcon icon="material-symbols:note-add-rounded" size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          openEditFolder(folder);
                        }}
                      >
                        <AppIcon icon="material-symbols:edit-rounded" size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          requestDeleteFolder(folder);
                        }}
                      >
                        <AppIcon icon="material-symbols:delete-rounded" size={14} />
                      </button>
                    </div>
                  </div>
                );
              }

              const script = entry.script;
              return (
                <div
                  key={script.id}
                  className={`space-entry ${draggingScriptId === script.id ? "space-entry--dragging" : ""}`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", script.id);
                    setDraggingScriptId(script.id);
                  }}
                  onDragEnd={() => {
                    setDraggingScriptId(null);
                    setDragOverFolderId(null);
                  }}
                  onClick={() => openEditScript(script)}
                >
                  <div className="space-entry-name">
                    <AppIcon icon="material-symbols:terminal-rounded" size={18} />
                    <span>{script.name}</span>
                  </div>
                  <span className="space-entry-meta">{getFolderPath(script.folderId)}</span>
                  <span className="space-entry-meta">{formatUpdatedAt(script.updatedAt)}</span>
                  <div className="space-entry-actions">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        openEditScript(script);
                      }}
                    >
                      <AppIcon icon="material-symbols:edit-rounded" size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        requestDeleteScript(script);
                      }}
                    >
                      <AppIcon icon="material-symbols:delete-rounded" size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

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

      <Modal
        open={Boolean(activeScriptForm)}
        title={t("space.editor.title")}
        onClose={() => setActiveScriptForm(null)}
        width={840}
      >
        {activeScriptForm ? (
          <div className="space-modal space-editor-body">
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
                  setActiveScriptForm((prev) =>
                    prev ? { ...prev, name: event.target.value } : prev,
                  )
                }
                placeholder={t("space.editor.namePlaceholder")}
              />
            </div>
            <div className="form-group">
              <label>{t("space.editor.content")}</label>
              <CodeMirror
                value={activeScriptForm.content}
                height="340px"
                extensions={scriptEditorExtensions}
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: true,
                  highlightActiveLineGutter: true,
                  highlightSpecialChars: true,
                  history: true,
                  drawSelection: true,
                }}
                onChange={(value) =>
                  setActiveScriptForm((prev) =>
                    prev ? { ...prev, content: value } : prev,
                  )
                }
                className="space-code-editor"
              />
            </div>
            <div className="space-editor-actions">
              <button className="btn btn-primary" type="button" onClick={() => void handleSaveScript()}>
                {t("common.save")}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setActiveScriptForm(null)}
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(pendingDeleteScript)}
        title={t("common.delete")}
        onClose={() => setPendingDeleteScript(null)}
        width={420}
      >
        {pendingDeleteScript ? (
          <div className="space-modal">
            <div>{t("space.script.delete.confirm", { name: pendingDeleteScript.name })}</div>
            <div className="space-modal-actions">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setPendingDeleteScript(null)}
              >
                {t("common.cancel")}
              </button>
              <button className="btn btn-danger" type="button" onClick={() => void confirmDeleteScript()}>
                {t("common.delete")}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(pendingDeleteFolder)}
        title={t("common.delete")}
        onClose={() => setPendingDeleteFolder(null)}
        width={460}
      >
        {pendingDeleteFolder ? (
          <div className="space-modal">
            <div>
              {(() => {
                const impact = getFolderDeleteImpact(pendingDeleteFolder);
                return t("space.folder.delete.confirm", {
                  name: pendingDeleteFolder.name,
                  folderCount: String(impact.folderCount),
                  scriptCount: String(impact.scriptCount),
                });
              })()}
            </div>
            <div className="space-modal-warning">
              {t("space.folder.delete.warning")}
            </div>
            <div className="space-modal-actions">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setPendingDeleteFolder(null)}
              >
                {t("common.cancel")}
              </button>
              <button className="btn btn-danger" type="button" onClick={() => void confirmDeleteFolder()}>
                {t("common.delete")}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
