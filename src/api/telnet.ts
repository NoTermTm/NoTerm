import { invoke } from "@tauri-apps/api/core";
import type { TelnetConnectionConfig } from "../types/connection";

export const telnetApi = {
  connect: async (connection: TelnetConnectionConfig): Promise<string> => {
    return await invoke("telnet_connect", { connection });
  },

  openShell: async (sessionId: string): Promise<void> => {
    return await invoke("telnet_open_shell", { sessionId });
  },

  writeToShell: async (sessionId: string, data: string): Promise<void> => {
    return await invoke("telnet_write_to_shell", { sessionId, data });
  },

  resizePty: async (sessionId: string, cols: number, rows: number): Promise<void> => {
    return await invoke("telnet_resize_pty", { sessionId, cols, rows });
  },

  disconnect: async (sessionId: string): Promise<void> => {
    return await invoke("telnet_disconnect", { sessionId });
  },

  isConnected: async (sessionId: string): Promise<boolean> => {
    return await invoke("telnet_is_connected", { sessionId });
  },

  listSessions: async (): Promise<string[]> => {
    return await invoke("telnet_list_sessions");
  },
};
