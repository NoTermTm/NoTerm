import { invoke } from '@tauri-apps/api/core';
import { SshConnection } from '../types/ssh';

export const sshApi = {
  connect: async (connection: SshConnection): Promise<string> => {
    return await invoke('ssh_connect', { connection });
  },

  openShell: async (sessionId: string): Promise<void> => {
    return await invoke('ssh_open_shell', { sessionId });
  },

  writeToShell: async (sessionId: string, data: string): Promise<void> => {
    return await invoke('ssh_write_to_shell', { sessionId, data });
  },

  resizePty: async (sessionId: string, cols: number, rows: number): Promise<void> => {
    return await invoke('ssh_resize_pty', { sessionId, cols, rows });
  },

  disconnect: async (sessionId: string): Promise<void> => {
    return await invoke('ssh_disconnect', { sessionId });
  },

  executeCommand: async (sessionId: string, command: string): Promise<string> => {
    return await invoke('ssh_execute_command', { sessionId, command });
  },

  isConnected: async (sessionId: string): Promise<boolean> => {
    return await invoke('ssh_is_connected', { sessionId });
  },

  listSessions: async (): Promise<string[]> => {
    return await invoke('ssh_list_sessions');
  },
};
