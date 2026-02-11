import { Store } from "@tauri-apps/plugin-store";

type ScriptFolder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
};

type ScriptItem = {
  id: string;
  name: string;
  content: string;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
};

type ScriptsData = {
  folders: ScriptFolder[];
  scripts: ScriptItem[];
};

const STORE_PATH = "scripts.json";
const STORE_KEY = "data";

const DEFAULT_DATA: ScriptsData = {
  folders: [],
  scripts: [],
};

let storePromise: Promise<Store> | null = null;

export type { ScriptFolder, ScriptItem, ScriptsData };

export function getScriptsStore() {
  if (!storePromise) {
    storePromise = Store.load(STORE_PATH, {
      defaults: { [STORE_KEY]: DEFAULT_DATA },
      autoSave: 200,
    });
  }
  return storePromise;
}

export async function readScriptsData(): Promise<ScriptsData> {
  const store = await getScriptsStore();
  const data = await store.get<ScriptsData>(STORE_KEY);
  return data ?? { ...DEFAULT_DATA };
}

export async function writeScriptsData(next: ScriptsData) {
  const store = await getScriptsStore();
  await store.set(STORE_KEY, next);
  await store.save();
}
