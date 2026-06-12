import { describe, it, expect } from "vitest";
import { extractDisplayableAnswerFromThinking, shouldRetryProtocolResponse } from "./agentLoop";
import type { ParsedAgentResponse } from "./agentResponseParser";

describe("extractDisplayableAnswerFromThinking", () => {
  it("prefers the final-answer section over earlier reasoning lists", () => {
    const thinking = `我已经收集了足够的信息来给出全面的诊断。
已排查项：
1. 磁盘空间：充足，无影响。
2. tc qdisc：只有常规 fq_codel，没有限速。

总结给用户：
## 网络诊断结论
- 主因是 WiFi 接口存在大量接收错误。
- CPU 负载低，不是瓶颈。
格式要求：
- 使用 markdown 标签。
- 不要重复 thinking。`;

    expect(extractDisplayableAnswerFromThinking(thinking)).toBe(
      "## 网络诊断结论\n- 主因是 WiFi 接口存在大量接收错误。\n- CPU 负载低，不是瓶颈。",
    );
  });

  it("filters obvious meta lines when no explicit final-answer cue exists", () => {
    const thinking = `我应该先给出回答
## 空间分析
- overlay 还有 1.1G 可用
- 目前不是磁盘瓶颈
格式要求：
- 直接给用户看`;

    expect(extractDisplayableAnswerFromThinking(thinking)).toBe(
      "## 空间分析\n- overlay 还有 1.1G 可用\n- 目前不是磁盘瓶颈",
    );
  });
});

describe("shouldRetryProtocolResponse", () => {
  it("retries when thinking leaks protocol meta without explicit done content", () => {
    const parsed: ParsedAgentResponse = {
      thinking: "我应该给用户总结。\n格式要求：\n- 不要重复 thinking。",
      action: null,
      done: true,
      finalAnswer: "",
    };

    expect(shouldRetryProtocolResponse(parsed)).toBe(true);
  });

  it("does not retry a normal explicit final answer", () => {
    const parsed: ParsedAgentResponse = {
      thinking: "内部推理",
      action: null,
      done: true,
      finalAnswer: "## 结论\n- 一切正常",
    };

    expect(shouldRetryProtocolResponse(parsed)).toBe(false);
  });
});
