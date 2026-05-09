import type { SshConnection } from "./ssh";

export type ConnectionKind = "ssh";

export interface SshConnectionConfig extends SshConnection {
  kind: "ssh";
  osType?: "windows" | "macos" | "linux" | "unknown";
}

export type ConnectionConfig = SshConnectionConfig;
