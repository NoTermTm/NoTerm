import { invoke } from '@tauri-apps/api/core';
import { SshConnection, SftpEntry } from '../types/ssh';

export interface EndpointCheck {
  ip: string;
  port: number;
  latency_ms: number;
}

export interface ControlledCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export const sshApi = {
  connect: async (connection: SshConnection): Promise<string> => {
    return await invoke('ssh_connect', { connection });
  },

  checkEndpoint: async (host: string, port: number): Promise<EndpointCheck> => {
    return await invoke('ssh_check_endpoint', { host, port });
  },

  openShell: async (sessionId: string): Promise<void> => {
    return await invoke('ssh_open_shell', { sessionId });
  },

  localOpenShell: async (sessionId: string, shell?: string): Promise<void> => {
    return await invoke('local_open_shell', { sessionId, shell });
  },

  writeToShell: async (sessionId: string, data: string): Promise<void> => {
    return await invoke('ssh_write_to_shell', { sessionId, data });
  },

  localWriteToShell: async (sessionId: string, data: string): Promise<void> => {
    return await invoke('local_write_to_shell', { sessionId, data });
  },

  resizePty: async (sessionId: string, cols: number, rows: number): Promise<void> => {
    return await invoke('ssh_resize_pty', { sessionId, cols, rows });
  },

  localResizePty: async (sessionId: string, cols: number, rows: number): Promise<void> => {
    return await invoke('local_resize_pty', { sessionId, cols, rows });
  },

  disconnect: async (sessionId: string): Promise<void> => {
    return await invoke('ssh_disconnect', { sessionId });
  },

  localDisconnect: async (sessionId: string): Promise<void> => {
    return await invoke('local_disconnect', { sessionId });
  },

  executeCommand: async (sessionId: string, command: string): Promise<string> => {
    return await invoke('ssh_execute_command', { sessionId, command });
  },

  executeControlledCommand: async (
    sessionId: string,
    command: string,
    timeoutSec: number,
  ): Promise<ControlledCommandResult> => {
    return await invoke('ssh_execute_command_controlled', { sessionId, command, timeoutSec });
  },

  localExecuteControlledCommand: async (
    sessionId: string,
    command: string,
    timeoutSec: number,
  ): Promise<ControlledCommandResult> => {
    return await invoke('local_execute_command_controlled', { sessionId, command, timeoutSec });
  },

  isConnected: async (sessionId: string): Promise<boolean> => {
    return await invoke('ssh_is_connected', { sessionId });
  },

  listSessions: async (): Promise<string[]> => {
    return await invoke('ssh_list_sessions');
  },

  listSftpDir: async (sessionId: string, path: string): Promise<SftpEntry[]> => {
    return await invoke('ssh_sftp_list_dir', { sessionId, path });
  },

  downloadFile: async (sessionId: string, remotePath: string, localPath: string): Promise<void> => {
    return await invoke('ssh_sftp_download_file', { sessionId, remotePath, localPath });
  },

  uploadFile: async (sessionId: string, localPath: string, remotePath: string): Promise<void> => {
    return await invoke('ssh_sftp_upload_file', { sessionId, localPath, remotePath });
  },

  renameSftpEntry: async (sessionId: string, fromPath: string, toPath: string): Promise<void> => {
    return await invoke('ssh_sftp_rename', { sessionId, fromPath, toPath });
  },

  chmodSftpEntry: async (sessionId: string, path: string, mode: number): Promise<void> => {
    return await invoke('ssh_sftp_chmod', { sessionId, path, mode });
  },

  deleteSftpEntry: async (sessionId: string, path: string, isDir: boolean): Promise<void> => {
    return await invoke('ssh_sftp_delete', { sessionId, path, isDir });
  },

  mkdirSftpEntry: async (sessionId: string, path: string): Promise<void> => {
    return await invoke('ssh_sftp_mkdir', { sessionId, path });
  },
};
