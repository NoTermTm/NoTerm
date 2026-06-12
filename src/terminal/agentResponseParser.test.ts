import { describe, it, expect } from "vitest";
import { parseAgentResponse, extractStreamingThinking } from "./agentResponseParser";

describe("parseAgentResponse", () => {
  it("parses thinking + action response", () => {
    const raw = `<thinking>
分析用户请求...决定需要执行什么命令...
</thinking>

<action>
{"command": "ls -la /etc", "risk": "low", "reason": "查看目录内容"}
</action>`;

    const result = parseAgentResponse(raw);

    expect(result.thinking).toBe("分析用户请求...决定需要执行什么命令...");
    expect(result.action).not.toBeNull();
    expect(result.action!.command).toBe("ls -la /etc");
    expect(result.action!.risk).toBe("low");
    expect(result.action!.reason).toBe("查看目录内容");
    expect(result.action!.id).toBeTruthy();
    expect(result.done).toBe(false);
  });

  it("parses thinking + done response", () => {
    const raw = `<thinking>
这个问题不需要执行命令，先整理信息...
</thinking>

<done>
这台服务器适合轻量服务、开发测试和小型自动化任务，不建议承载高并发业务。
</done>`;

    const result = parseAgentResponse(raw);

    expect(result.thinking).toBe("这个问题不需要执行命令，先整理信息...");
    expect(result.action).toBeNull();
    expect(result.done).toBe(true);
    expect(result.finalAnswer).toBe("这台服务器适合轻量服务、开发测试和小型自动化任务，不建议承载高并发业务。");
  });

  it("parses thinking-only response (no action, no done) as done", () => {
    const raw = `<thinking>
这是一个纯思考回答。
</thinking>`;

    const result = parseAgentResponse(raw);

    expect(result.thinking).toBe("这是一个纯思考回答。");
    expect(result.action).toBeNull();
    expect(result.done).toBe(true);
    expect(result.finalAnswer).toBe("");
  });

  it("handles empty thinking content", () => {
    const raw = `<thinking></thinking>\n<done/>`;

    const result = parseAgentResponse(raw);

    expect(result.thinking).toBe("");
    expect(result.action).toBeNull();
    expect(result.done).toBe(true);
    expect(result.finalAnswer).toBe("");
  });

  it("handles missing thinking tag", () => {
    const raw = `Some random text without tags`;

    const result = parseAgentResponse(raw);

    expect(result.thinking).toBe("");
    expect(result.action).toBeNull();
    expect(result.done).toBe(true);
  });

  it("handles malformed action JSON", () => {
    const raw = `<thinking>Trying something</thinking>\n<action>not valid json</action>`;

    const result = parseAgentResponse(raw);

    expect(result.thinking).toBe("Trying something");
    expect(result.action).toBeNull();
    expect(result.done).toBe(true);
  });

  it("handles action with missing command field", () => {
    const raw = `<thinking>Test</thinking>\n<action>{"risk": "low", "reason": "test"}</action>`;

    const result = parseAgentResponse(raw);

    expect(result.action).toBeNull();
    expect(result.done).toBe(true);
  });

  it("handles action with invalid risk level (defaults to medium)", () => {
    const raw = `<thinking>Test</thinking>\n<action>{"command": "echo hi", "risk": "unknown", "reason": "test"}</action>`;

    const result = parseAgentResponse(raw);

    expect(result.action).not.toBeNull();
    expect(result.action!.risk).toBe("medium");
  });

  it("handles action with missing reason (defaults to empty string)", () => {
    const raw = `<thinking>Test</thinking>\n<action>{"command": "echo hi", "risk": "high"}</action>`;

    const result = parseAgentResponse(raw);

    expect(result.action).not.toBeNull();
    expect(result.action!.reason).toBe("");
  });

  it("handles <done /> with space", () => {
    const raw = `<thinking>Done</thinking>\n<done />`;

    const result = parseAgentResponse(raw);

    expect(result.done).toBe(true);
    expect(result.action).toBeNull();
    expect(result.finalAnswer).toBe("");
  });

  it("does not fall back to thinking when malformed action makes the response done", () => {
    const raw = `<thinking>内部推理\n## 最终答复\n- 第一项\n- 第二项</thinking>\n<action>not valid json</action>`;

    const result = parseAgentResponse(raw);

    expect(result.done).toBe(true);
    expect(result.action).toBeNull();
    expect(result.finalAnswer).toBe("");
  });

  it("prefers explicit done content over thinking for final answer", () => {
    const raw = `<thinking>内部分析，不直接展示给用户。</thinking>
<done>最终建议：先部署监控和日志，再放业务。</done>`;

    const result = parseAgentResponse(raw);

    expect(result.done).toBe(true);
    expect(result.finalAnswer).toBe("最终建议：先部署监控和日志，再放业务。");
  });

  it("handles action without closing tag (malformed)", () => {
    const raw = `<thinking>Test</thinking>\n<action>{"command": "ls"}`;

    const result = parseAgentResponse(raw);

    expect(result.action).toBeNull();
    expect(result.done).toBe(true);
  });

  it("generates unique IDs for each action", () => {
    const raw = `<thinking>Test</thinking>\n<action>{"command": "ls", "risk": "low", "reason": "list"}</action>`;

    const result1 = parseAgentResponse(raw);
    const result2 = parseAgentResponse(raw);

    expect(result1.action!.id).not.toBe(result2.action!.id);
  });

  it("handles all valid risk levels", () => {
    const risks = ["low", "medium", "high", "critical"] as const;

    for (const risk of risks) {
      const raw = `<thinking>Test</thinking>\n<action>{"command": "echo", "risk": "${risk}", "reason": "test"}</action>`;
      const result = parseAgentResponse(raw);
      expect(result.action!.risk).toBe(risk);
    }
  });
});

describe("extractStreamingThinking", () => {
  it("extracts complete thinking content", () => {
    const text = `<thinking>Hello world</thinking>`;
    expect(extractStreamingThinking(text)).toBe("Hello world");
  });

  it("extracts partial thinking content (no closing tag yet)", () => {
    const text = `<thinking>Partial content being streamed...`;
    expect(extractStreamingThinking(text)).toBe("Partial content being streamed...");
  });

  it("returns empty string when no thinking tag present", () => {
    const text = `Some random text`;
    expect(extractStreamingThinking(text)).toBe("");
  });

  it("handles empty partial thinking", () => {
    const text = `<thinking>`;
    expect(extractStreamingThinking(text)).toBe("");
  });

  it("handles multiline streaming thinking", () => {
    const text = `<thinking>
Line 1
Line 2
Still streaming...`;

    const result = extractStreamingThinking(text);
    expect(result).toContain("Line 1");
    expect(result).toContain("Line 2");
    expect(result).toContain("Still streaming...");
  });

  it("stops at closing tag when present", () => {
    const text = `<thinking>Only this</thinking><action>{"command":"ls"}</action>`;
    expect(extractStreamingThinking(text)).toBe("Only this");
  });
});
