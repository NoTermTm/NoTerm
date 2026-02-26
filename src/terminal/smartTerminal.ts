export type SmartCommandKind = "ls" | "docker-ps" | "tail-follow";

export type LogCategory = "login_failed" | "db_timeout" | "error";

export type SmartCommandInfo = {
  kind: SmartCommandKind;
  command: string;
};

export type LsTableRow = {
  id: string;
  mode: string;
  size: string;
  modified: string;
  name: string;
  entryType: "file" | "dir" | "link";
};

export type DockerPsRow = {
  id: string;
  containerId: string;
  image: string;
  command: string;
  created: string;
  status: string;
  ports: string;
  name: string;
};

const OSC_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const splitTableColumns = (line: string) =>
  line
    .split(/\s{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

const dropSudoPrefix = (value: string) => value.replace(/^\s*sudo\s+/i, "").trim();

export const sanitizeTerminalChunk = (chunk: string) =>
  chunk
    .replace(OSC_PATTERN, "")
    .replace(ANSI_PATTERN, "")
    .replace(/\r/g, "");

export const detectSmartCommand = (rawCommand: string): SmartCommandInfo | null => {
  const trimmed = rawCommand.trim();
  if (!trimmed) return null;

  const noSudo = dropSudoPrefix(trimmed);
  const firstSegment = noSudo.split(/&&|\|\||;|\|/)[0]?.trim() ?? noSudo;

  if (/^ls(?:\s|$)/i.test(firstSegment)) {
    return { kind: "ls", command: trimmed };
  }

  if (
    /^docker\s+ps(?:\s|$)/i.test(firstSegment) ||
    /^docker\s+container\s+ls(?:\s|$)/i.test(firstSegment)
  ) {
    return { kind: "docker-ps", command: trimmed };
  }

  const isTail = /^tail(?:\s|$)/i.test(firstSegment);
  const hasFollowFlag =
    /(?:^|\s)-[^\s]*f[^\s]*(?:\s|$)/i.test(firstSegment) ||
    /(?:^|\s)--follow(?:=\S+)?(?:\s|$)/i.test(firstSegment);

  if (isTail && hasFollowFlag) {
    return { kind: "tail-follow", command: trimmed };
  }

  return null;
};

export const parseLsOutput = (rawOutput: string): LsTableRow[] => {
  const lines = rawOutput.split(/\n/);
  const rows: LsTableRow[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line || line.startsWith("total ")) continue;
    if (!/^[bcdlps-][rwxStTs-]{9}[+@.]?\s+/.test(line)) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;

    const mode = parts[0];
    const size = parts[4] ?? "";
    const modified = parts.slice(5, 8).join(" ");
    const name = parts.slice(8).join(" ");
    const entryType: LsTableRow["entryType"] = mode.startsWith("d")
      ? "dir"
      : mode.startsWith("l")
        ? "link"
        : "file";

    rows.push({
      id: `ls-${index}-${name}`,
      mode,
      size,
      modified,
      name,
      entryType,
    });
  }

  return rows;
};

export const parseDockerPsOutput = (rawOutput: string): DockerPsRow[] => {
  const lines = rawOutput
    .split(/\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const headerIndex = lines.findIndex(
    (line) =>
      line.includes("CONTAINER ID") && line.includes("IMAGE") && line.includes("NAMES"),
  );

  if (headerIndex < 0) return [];

  const headers = splitTableColumns(lines[headerIndex]);
  const rows: DockerPsRow[] = [];

  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = splitTableColumns(line);
    if (cells.length < 2) continue;

    const rowByHeader: Record<string, string> = {};
    headers.forEach((header, idx) => {
      rowByHeader[header] = cells[idx] ?? "";
    });

    const containerId = rowByHeader["CONTAINER ID"] || cells[0] || "";
    if (!containerId) continue;

    rows.push({
      id: `docker-${containerId}-${i}`,
      containerId,
      image: rowByHeader.IMAGE || cells[1] || "",
      command: rowByHeader.COMMAND || "",
      created: rowByHeader.CREATED || "",
      status: rowByHeader.STATUS || "",
      ports: rowByHeader.PORTS || "",
      name: rowByHeader.NAMES || cells[cells.length - 1] || "",
    });
  }

  return rows;
};

export const categorizeLogLine = (line: string): LogCategory | null => {
  const text = line.toLowerCase();

  if (
    /failed password|login failed|authentication failed|invalid user|登录失败|密码错误/.test(text)
  ) {
    return "login_failed";
  }

  if (
    /database.*timeout|db.*timeout|query timeout|connection timed out|数据库.*超时|sqlstate.*timeout/.test(
      text,
    )
  ) {
    return "db_timeout";
  }

  if (/\berror\b|exception|fatal|panic|traceback/.test(text)) {
    return "error";
  }

  return null;
};

export const stripSymlinkSuffix = (name: string) => {
  const marker = " -> ";
  const idx = name.indexOf(marker);
  if (idx < 0) return name;
  return name.slice(0, idx);
};

export const shellEscapeArg = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
