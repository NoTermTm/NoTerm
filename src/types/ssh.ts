export interface SshConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
}

export type AuthType =
  | { type: 'Password'; password: string }
  | { type: 'PrivateKey'; key_path: string; passphrase?: string };

export interface SshSession {
  connection_id: string;
  connected: boolean;
}
