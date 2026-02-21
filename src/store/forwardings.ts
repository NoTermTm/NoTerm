import { Store } from "@tauri-apps/plugin-store";

export type ForwardKind = "local" | "remote" | "dynamic";

export type ForwardRule = {
  id: string;
  name: string;
  kind: ForwardKind;
  connectionId: string;
  localBindHost: string;
  localBindPort: number;
  remoteBindHost: string;
  remoteBindPort: number;
  targetHost: string;
  targetPort: number;
};

export type ForwardRulesData = {
  rules: ForwardRule[];
};

const STORE_NAME = "forwardings.json";
const STORE_KEY = "forwardings";

let store: Store | null = null;

async function getStore() {
  if (!store) {
    store = await Store.load(STORE_NAME);
  }
  return store;
}

export async function readForwardRules(): Promise<ForwardRule[]> {
  const s = await getStore();
  const data = await s.get<ForwardRulesData>(STORE_KEY);
  if (!data?.rules) return [];
  return data.rules.filter((item) => item && item.id && item.name);
}

export async function writeForwardRules(rules: ForwardRule[]) {
  const s = await getStore();
  await s.set(STORE_KEY, { rules });
  await s.save();
}
