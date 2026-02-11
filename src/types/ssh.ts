export interface SshConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  encoding?: string;
}

export type AuthType =
  | { type: 'Password'; password: string }
  | { type: 'PrivateKey'; key_path: string; key_content?: string; passphrase?: string };

export interface SftpEntry {
  name: string;
  is_dir: boolean;
  size?: number;
  modified?: number;
  perm?: number;
}

export interface SshSession {
  connection_id: string;
  connected: boolean;
}
