export type AgentRisk = "low" | "medium" | "high" | "critical";

export type AgentMode = "suggest_only" | "confirm_then_execute";

export type AgentPolicyStatus =
  | "allowed"
  | "blocked"
  | "needs_strong_confirmation";

export type AgentActionStatus =
  | "pending"
  | "approved"
  | "running"
  | "success"
  | "failed"
  | "blocked"
  | "rejected"
  | "skipped";

export type AgentPlanStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export type AgentPlanActivityTone = "info" | "success" | "warn" | "error";

export interface AgentAction {
  id: string;
  session_id: string;
  command: string;
  risk: AgentRisk;
  reason: string;
  expected_effect: string;
  timeout_sec: number;
}

export interface AgentPlan {
  id: string;
  session_id: string;
  summary?: string;
  actions: AgentAction[];
}

export interface AgentPlanParseResult {
  plan: AgentPlan | null;
  note: string;
  raw_json?: string;
  error?: string;
}

export interface AgentPolicyDecision {
  status: AgentPolicyStatus;
  reason: string;
  normalized_command: string;
  normalized_risk: AgentRisk;
}

export interface AgentCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
}

export interface AgentActionRuntime extends AgentAction {
  edited_command: string;
  policy: AgentPolicyDecision;
  status: AgentActionStatus;
  strong_confirm_input: string;
  result?: AgentCommandResult;
  error?: string;
  execution_note?: string;
  confirmed_at?: number;
  finished_at?: number;
}

export interface AgentPlanRuntime {
  id: string;
  session_id: string;
  summary: string;
  actions: AgentActionRuntime[];
  status: AgentPlanStatus;
  mode: AgentMode;
  created_at: number;
  user_request: string;
  parse_error?: string;
  stop_requested?: boolean;
  thinking?: boolean;
  final_report_ready?: boolean;
  activities?: Array<{
    id: string;
    ts: number;
    text: string;
    tone: AgentPlanActivityTone;
  }>;
}
