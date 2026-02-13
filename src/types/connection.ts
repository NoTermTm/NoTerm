import type { SshConnection } from "./ssh";

export type ConnectionKind = "ssh" | "rdp";

export interface SshConnectionConfig extends SshConnection {
  kind: "ssh";
}

export interface RdpConnectionConfig {
  kind: "rdp";
  id: string;
  name: string;
  tags?: string[];
  color?: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  gatewayHost?: string;
  gatewayUsername?: string;
  gatewayPassword?: string;
  gatewayDomain?: string;
  resolutionWidth?: number;
  resolutionHeight?: number;
  colorDepth?: 16 | 24 | 32;
  certPolicy?: "default" | "ignore";
  redirectClipboard?: boolean;
  redirectAudio?: boolean;
  redirectDrives?: boolean;
}

export type ConnectionConfig = SshConnectionConfig | RdpConnectionConfig;
