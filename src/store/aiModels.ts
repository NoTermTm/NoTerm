import { Store } from "@tauri-apps/plugin-store";
import type { AiProvider } from "../api/ai";

export type AiModelsCache = Record<AiProvider, string[]>;

export const DEFAULT_AI_MODELS: AiModelsCache = {
  openai: [],
  anthropic: [],
};

const STORE_PATH = "ai-models.json";

let storePromise: Promise<Store> | null = null;

export function getAiModelsStore() {
  if (!storePromise) {
    storePromise = Store.load(STORE_PATH, {
      defaults: DEFAULT_AI_MODELS,
      autoSave: 200,
    });
  }
  return storePromise;
}

export async function readAiModels(provider: AiProvider) {
  const store = await getAiModelsStore();
  const list = await store.get<string[]>(provider);
  return Array.isArray(list) ? list : DEFAULT_AI_MODELS[provider];
}

export async function readAllAiModels() {
  const store = await getAiModelsStore();
  const openai = (await store.get<string[]>("openai")) ?? DEFAULT_AI_MODELS.openai;
  const anthropic =
    (await store.get<string[]>("anthropic")) ?? DEFAULT_AI_MODELS.anthropic;
  return {
    openai: Array.isArray(openai) ? openai : DEFAULT_AI_MODELS.openai,
    anthropic: Array.isArray(anthropic) ? anthropic : DEFAULT_AI_MODELS.anthropic,
  } as AiModelsCache;
}

export async function writeAiModels(provider: AiProvider, models: string[]) {
  const store = await getAiModelsStore();
  await store.set(provider, models);
}
