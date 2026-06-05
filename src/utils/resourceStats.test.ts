import { describe, expect, it } from "vitest";
import { getResourceStatsCommand, parseResourceStatsOutput } from "./resourceStats";

describe("resourceStats", () => {
  it("parses cpu and memory percentages", () => {
    expect(parseResourceStatsOutput("CPU=23\nMEM=61\n")).toEqual({
      cpuPercent: 23,
      memoryPercent: 61,
    });
  });

  it("rejects invalid or out-of-range output", () => {
    expect(parseResourceStatsOutput("")).toBeNull();
    expect(parseResourceStatsOutput("CPU=hello\nMEM=61\n")).toBeNull();
    expect(parseResourceStatsOutput("CPU=101\nMEM=61\n")).toBeNull();
    expect(parseResourceStatsOutput("CPU=12\nMEM=-1\n")).toBeNull();
  });

  it("builds a command that emits CPU and MEM markers", () => {
    const command = getResourceStatsCommand();
    expect(command).toContain('printf "CPU=%s\\nMEM=%s\\n"');
    expect(command).toContain('uname_s="$(uname 2>/dev/null || echo unknown)"');
  });
});
