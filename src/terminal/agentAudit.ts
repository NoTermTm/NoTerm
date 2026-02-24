import { getAppSettingsStore } from "../store/appSettings";
import type { AgentMode, AgentPlan, AgentRisk } from "../types/agent";

const AUDIT_LOG_KEY = "agent.audit.logs";
const AUDIT_MAX_RECORDS = 500;

export type AgentAuditEvent =
  | "plan_created"
  | "plan_parse_failed"
  | "action_confirmed"
  | "action_rejected"
  | "action_started"
  | "action_finished"
  | "plan_stopped";

export interface AgentAuditRecord {
  id: string;
  ts: number;
  event: AgentAuditEvent;
  session_id: string;
  mode: AgentMode;
  user_request?: string;
  plan?: AgentPlan;
  action_id?: string;
  command?: string;
  risk?: AgentRisk;
  reason?: string;
  result?: {
    exitCode?: number;
    durationMs?: number;
    timedOut?: boolean;
    stderr?: string;
    stdout?: string;
  };
}

const redactSensitiveText = (input: string): string => {
  let output = input;

  output = output.replace(
    /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/gi,
    "[REDACTED_PRIVATE_KEY]",
  );

  output = output.replace(
    /\b(password|passwd|token|api[_-]?key|secret)\b\s*[:=]\s*[^\s'\"]+/gi,
    "$1=[REDACTED]",
  );

  output = output.replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]");

  return output;
};

const sanitizeValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      next[k] = sanitizeValue(v);
    }
    return next;
  }

  return value;
};

const createAuditId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export async function appendAgentAuditRecord(
  input: Omit<AgentAuditRecord, "id" | "ts"> & Partial<Pick<AgentAuditRecord, "id" | "ts">>,
) {
  const record: AgentAuditRecord = {
    id: input.id || createAuditId(),
    ts: input.ts || Date.now(),
    event: input.event,
    session_id: input.session_id,
    mode: input.mode,
    user_request: input.user_request,
    plan: input.plan,
    action_id: input.action_id,
    command: input.command,
    risk: input.risk,
    reason: input.reason,
    result: input.result,
  };

  const sanitized = sanitizeValue(record) as AgentAuditRecord;
  const store = await getAppSettingsStore();
  const current =
    (await store.get<AgentAuditRecord[]>(AUDIT_LOG_KEY))?.filter(Boolean) || [];
  const next = [...current, sanitized];
  if (next.length > AUDIT_MAX_RECORDS) {
    next.splice(0, next.length - AUDIT_MAX_RECORDS);
  }
  await store.set(AUDIT_LOG_KEY, next);
}

export async function readAgentAuditRecords(limit = 100): Promise<AgentAuditRecord[]> {
  const store = await getAppSettingsStore();
  const current =
    (await store.get<AgentAuditRecord[]>(AUDIT_LOG_KEY))?.filter(Boolean) || [];
  if (limit <= 0) return [];
  return current.slice(-limit);
}
