import type { SshConnection } from "./ssh";

export type ConnectionKind = "ssh" | "telnet";

export interface SshConnectionConfig extends SshConnection {
  kind: "ssh";
  osType?: "windows" | "macos" | "linux" | "unknown";
}

export interface TelnetConnectionConfig {
  kind: "telnet";
  id: string;
  name: string;
  tags?: string[];
  color?: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  encoding?: string;
  osType?: "windows" | "macos" | "linux" | "unknown";
}

export type ConnectionConfig = SshConnectionConfig | TelnetConnectionConfig;
