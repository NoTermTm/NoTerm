import type { AgentAction, AgentPolicyDecision, AgentRisk } from "../types/agent";

const RISK_LEVEL: Record<AgentRisk, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const READ_ONLY_PREFIXES = [
  "ls",
  "pwd",
  "whoami",
  "id",
  "uname",
  "date",
  "uptime",
  "ps",
  "top",
  "htop",
  "df",
  "du",
  "free",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "egrep",
  "fgrep",
  "find",
  "which",
  "whereis",
  "docker ps",
  "docker logs",
  "journalctl",
  "systemctl status",
  "kubectl get",
  "kubectl describe",
  "netstat",
  "ss",
  "ip a",
  "ifconfig",
];

const MEDIUM_PREFIXES = [
  "systemctl restart",
  "systemctl start",
  "systemctl stop",
  "service restart",
  "service start",
  "service stop",
  "docker restart",
  "docker start",
  "docker stop",
  "kubectl rollout restart",
  "kubectl scale",
];

const HIGH_PREFIXES = [
  "rm ",
  "mv ",
  "cp ",
  "chmod ",
  "chown ",
  "sed -i",
  "tee ",
  "truncate ",
  "dd ",
  "mkfs",
  "mount ",
  "umount ",
  "useradd",
  "usermod",
  "userdel",
  "groupadd",
  "groupdel",
  "crontab",
  "iptables",
  "ufw ",
];

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+-rf\s+\/($|\s)/i,
    reason: "检测到高危删除命令 rm -rf /",
  },
  {
    pattern: /\bmkfs(\.[a-z0-9]+)?\b/i,
    reason: "检测到磁盘格式化命令",
  },
  {
    pattern: /\bdd\b[^\n]*\bof\s*=\s*\/dev\//i,
    reason: "检测到潜在破坏性 dd 写盘命令",
  },
  {
    pattern: /\bcurl\b[^\n]*\|\s*(bash|sh)\b/i,
    reason: "检测到远程脚本管道执行",
  },
  {
    pattern: /\bwget\b[^\n]*\|\s*(bash|sh)\b/i,
    reason: "检测到远程脚本管道执行",
  },
  {
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/,
    reason: "检测到 fork bomb 模式",
  },
];

const normalizeRisk = (value: string | undefined | null): AgentRisk => {
  const risk = (value || "").trim().toLowerCase();
  if (risk === "low" || risk === "medium" || risk === "high" || risk === "critical") {
    return risk;
  }
  return "medium";
};

const normalizeCommand = (command: string) => command.replace(/\s+/g, " ").trim();

const hasCommandChaining = (command: string) => /(;|&&|\|\||\|)/.test(command);

const inferCommandRisk = (
  command: string,
): { risk: AgentRisk; unknown: boolean } => {
  const cmd = command.toLowerCase();

  if (READ_ONLY_PREFIXES.some((prefix) => cmd === prefix || cmd.startsWith(`${prefix} `))) {
    return { risk: "low", unknown: false };
  }

  if (MEDIUM_PREFIXES.some((prefix) => cmd === prefix || cmd.startsWith(`${prefix} `))) {
    return { risk: "medium", unknown: false };
  }

  if (HIGH_PREFIXES.some((prefix) => cmd.startsWith(prefix))) {
    return { risk: "high", unknown: false };
  }

  return { risk: "medium", unknown: true };
};

const mergeRisk = (a: AgentRisk, b: AgentRisk): AgentRisk => {
  return RISK_LEVEL[a] >= RISK_LEVEL[b] ? a : b;
};

export const evaluateAgentActionPolicy = (
  action: Pick<AgentAction, "command" | "risk" | "session_id">,
  currentSessionId: string,
): AgentPolicyDecision => {
  const normalizedCommand = normalizeCommand(action.command || "");
  const modelRisk = normalizeRisk(action.risk);

  if (!normalizedCommand) {
    return {
      status: "blocked",
      reason: "命令为空",
      normalized_command: "",
      normalized_risk: "critical",
    };
  }

  if ((action.session_id || "").trim() !== currentSessionId.trim()) {
    return {
      status: "blocked",
      reason: "MVP 仅允许当前会话执行",
      normalized_command: normalizedCommand,
      normalized_risk: "critical",
    };
  }

  if (/\r|\n/.test(normalizedCommand)) {
    return {
      status: "blocked",
      reason: "不允许多行命令",
      normalized_command: normalizedCommand,
      normalized_risk: "critical",
    };
  }

  if (hasCommandChaining(normalizedCommand)) {
    return {
      status: "blocked",
      reason: "不允许命令拼接（; / && / || / |）",
      normalized_command: normalizedCommand,
      normalized_risk: "critical",
    };
  }

  for (const item of BLOCKED_PATTERNS) {
    if (item.pattern.test(normalizedCommand)) {
      return {
        status: "blocked",
        reason: item.reason,
        normalized_command: normalizedCommand,
        normalized_risk: "critical",
      };
    }
  }

  const inferred = inferCommandRisk(normalizedCommand);
  const normalizedRisk = mergeRisk(modelRisk, inferred.risk);

  if (normalizedRisk === "high" || normalizedRisk === "critical") {
    return {
      status: "needs_strong_confirmation",
      reason: "高风险命令，需二次确认",
      normalized_command: normalizedCommand,
      normalized_risk: normalizedRisk,
    };
  }

  if (inferred.unknown) {
    return {
      status: "needs_strong_confirmation",
      reason: "未知命令类型，需二次确认",
      normalized_command: normalizedCommand,
      normalized_risk: normalizedRisk,
    };
  }

  return {
    status: "allowed",
    reason: "策略检查通过",
    normalized_command: normalizedCommand,
    normalized_risk: normalizedRisk,
  };
};
