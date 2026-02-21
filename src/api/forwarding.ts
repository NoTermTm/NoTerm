import { invoke } from "@tauri-apps/api/core";
import type { ForwardRule } from "../store/forwardings";
import type { SshConnection } from "../types/ssh";

export type ForwardConfig = {
  id: string;
  kind: ForwardRule["kind"];
  connection: SshConnection;
  localBindHost?: string;
  localBindPort?: number;
  remoteBindHost?: string;
  remoteBindPort?: number;
  targetHost?: string;
  targetPort?: number;
};

export async function startForward(config: ForwardConfig): Promise<void> {
  await invoke("ssh_forward_start", { config });
}

export async function stopForward(id: string): Promise<void> {
  await invoke("ssh_forward_stop", { id });
}

export async function listForwards(): Promise<string[]> {
  return await invoke<string[]>("ssh_forward_list");
}
