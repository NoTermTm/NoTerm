// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import AgentStreamView from "./AgentStreamView";
import type { AgentBlock } from "../types/agent";

describe("AgentStreamView", () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("expands the latest thinking content by default", () => {
    const blocks: AgentBlock[] = [
      {
        id: "thinking-1",
        type: "thinking",
        content: "First line\nSecond line",
        timestamp: Date.now(),
      },
    ];

    render(
      <AgentStreamView
        blocks={blocks}
        isRunning={false}
        pendingConfirmation={null}
        onConfirm={() => {}}
        onReject={() => {}}
        onCopy={() => {}}
      />,
    );

    const toggle = screen.getByRole("button", { name: /thinking/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const content = document.getElementById("thinking-content-thinking-1");
    expect(content?.textContent).toContain("First line");
    expect(content?.textContent).toContain("Second line");
  });

  it("keeps older thinking collapsed while expanding the latest one", () => {
    const blocks: AgentBlock[] = [
      {
        id: "thinking-old",
        type: "thinking",
        content: "Old thinking",
        timestamp: Date.now(),
      },
      {
        id: "thinking-new",
        type: "thinking",
        content: "Latest thinking",
        timestamp: Date.now() + 1,
      },
    ];

    render(
      <AgentStreamView
        blocks={blocks}
        isRunning={false}
        pendingConfirmation={null}
        onConfirm={() => {}}
        onReject={() => {}}
        onCopy={() => {}}
      />,
    );

    const toggles = screen.getAllByRole("button", { name: /thinking/i });
    expect(toggles[0].getAttribute("aria-expanded")).toBe("false");
    expect(toggles[1].getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByText("Old thinking")).toBeNull();
    expect(document.getElementById("thinking-content-thinking-new")?.textContent).toContain("Latest thinking");
  });

  it("collapses command output by default and expands on toggle", () => {
    const blocks: AgentBlock[] = [
      {
        id: "output-1",
        type: "output",
        content: "stdout line",
        stderr: "stderr line",
        exitCode: 1,
        timestamp: Date.now(),
      },
    ];

    render(
      <AgentStreamView
        blocks={blocks}
        isRunning={false}
        pendingConfirmation={null}
        onConfirm={() => {}}
        onReject={() => {}}
        onCopy={() => {}}
      />,
    );

    expect(screen.queryByText("stdout line")).toBeNull();
    expect(screen.queryByText("stderr line")).toBeNull();

    const toggleButtons = screen.getAllByRole("button");
    fireEvent.click(toggleButtons[0]);

    expect(screen.getByText("stdout line")).toBeTruthy();
    expect(screen.getByText("stderr line")).toBeTruthy();
  });
});
