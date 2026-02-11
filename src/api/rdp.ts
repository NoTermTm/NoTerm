import { invoke } from "@tauri-apps/api/core";
import type { RdpConnectionConfig } from "../types/connection";

export const rdpApi = {
  open: async (connection: RdpConnectionConfig): Promise<void> => {
    await invoke("rdp_open", { connection });
  },
};
