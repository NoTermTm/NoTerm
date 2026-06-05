// @vitest-environment jsdom
/**
 * Bug Condition Exploration Test
 *
 * Property 1: Bug Condition - 围栏代码块在父级 flex column 中被挤压成细线
 *
 * This test is EXPECTED TO FAIL on unfixed code. Failure proves the bug exists.
 * DO NOT fix the code or the test when it fails.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5
 * Validates: design.md Property 1
 */
import { describe, it, expect, afterAll } from "vitest";
import * as fc from "fast-check";

// --- CSS rules extracted from src/components/XTerminal.css (unfixed) ---
const INJECTED_CSS = `
.xterminal-ai-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-md, 8px);
    padding: var(--space-lg, 12px) var(--space-xl, 16px);
}

.xterminal-ai-history {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 0 0 10px;
}

.xterminal-ai-message {
    padding: 4px 2px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: white;
}
.xterminal-ai-message--assistant {
    align-items: flex-start;
    align-self: flex-start;
}

.ai-renderer {
    font-size: 13px;
    line-height: 1.5;
    color: #e0e0e0;
    min-width: 0;
    width: 100%;
    max-width: 100%;
    overflow-wrap: anywhere;
    word-break: break-word;
}
.ai-renderer > * {
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
}
.ai-renderer p {
    line-height: 1.5;
    margin: 0.5em 0;
}
.ai-renderer ul,
.ai-renderer ol {
    padding-left: 18px;
}
.ai-renderer li {
    margin: 10px 0;
}
.ai-renderer pre {
    background: transparent;
    margin: 2px 0;
    max-width: 100%;
    overflow-x: auto;
}

.ai-code-block {
    margin: 10px 0;
    position: relative;
    border-radius: 8px;
    overflow: hidden;
    background: #1e1e2e;
    box-sizing: border-box;
    border: 1px solid #333;
    display: flex;
    flex-direction: column;
    min-width: 0;
    max-width: 100%;
}
.ai-code-block pre {
    margin: 0;
    padding: 30px 10px 8px;
    min-width: 0;
    max-width: 100%;
    overflow-x: auto;
}
.ai-code-block pre code.hljs,
.ai-code-block pre .hljs {
    padding: 0;
    margin: 0;
    background: transparent;
    display: block;
    color: #e0e0e0;
    min-width: 0;
    max-width: 100%;
    font-family: monospace;
    font-size: 13px;
    line-height: 1.5;
}
.ai-code-toolbar {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    opacity: 1;
    transform: none;
    padding: 5px 10px;
    background-color: #2a2a3e;
    border-bottom: 1px solid #333;
}
`;

/**
 * Helper: Build the DOM structure that mimics the AI panel rendering context.
 * Returns the container element with injected CSS and the given inner HTML
 * placed inside .xterminal-ai-body > .xterminal-ai-history > .xterminal-ai-message--assistant > .ai-renderer
 */
function buildAiPanel(messagesHtml: string[]): HTMLElement {
  const container = document.createElement("div");
  container.style.width = "360px";
  container.style.height = "320px";
  container.style.display = "flex";
  container.style.flexDirection = "column";

  const style = document.createElement("style");
  style.textContent = INJECTED_CSS;
  container.appendChild(style);

  const body = document.createElement("div");
  body.className = "xterminal-ai-body";

  const history = document.createElement("div");
  history.className = "xterminal-ai-history";
  // Constrain height to simulate the real panel
  history.style.height = "320px";
  history.style.maxHeight = "320px";

  for (const html of messagesHtml) {
    const message = document.createElement("div");
    message.className = "xterminal-ai-message xterminal-ai-message--assistant";

    const renderer = document.createElement("div");
    renderer.className = "ai-renderer";
    renderer.innerHTML = html;

    message.appendChild(renderer);
    history.appendChild(message);
  }

  body.appendChild(history);
  container.appendChild(body);
  document.body.appendChild(container);

  return container;
}

/**
 * Helper: Generate the HTML that AiRenderer2's renderer.code would produce
 * for a given code string and language.
 */
function renderCodeBlock(code: string, lang: string = "bash"): string {
  const encoded = encodeURIComponent(code);
  const escaped = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  return `<div class="ai-code-block">
<div class="ai-code-toolbar">
    <button type="button" class="ai-send-btn" data-action="send" data-code="${encoded}">Run</button>
    <button type="button" class="ai-copy-btn" data-action="copy" data-code="${encoded}">Copy</button>
</div>
<pre><code class="language-${lang} hljs">${escaped}</code></pre>
</div>`;
}

/**
 * Helper: Generate N lines of code
 */
function generateCodeLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `echo "line ${i + 1}"`).join("\n");
}

// Constants for height calculation
const LINE_HEIGHT = 1.5 * 13; // line-height: 1.5, font-size: 13px = 19.5px
const PADDING_TOP = 30; // padding: 30px 10px 8px
const PADDING_BOTTOM = 8;
const TOOLBAR_HEIGHT = 30; // approximate: padding 5px top+bottom + line content
const TOLERANCE = 5; // px tolerance for rounding

describe("Bug Condition Exploration: .ai-code-block flex squeeze", () => {
  let containers: HTMLElement[] = [];

  afterAll(() => {
    containers.forEach((c) => c.remove());
  });

  /**
   * Scenario A: single message = 2 paragraphs + 10-line bash code block + 3-item unordered list
   * (corresponds to design.md Bug Details · Examples #1)
   *
   * **Validates: Requirements 1.1, 1.4, 2.1, 2.5**
   */
  it("Scenario A: single message with paragraphs + 10-line code block + list - code block should not be squeezed", () => {
    const codeLines = 10;
    const code = generateCodeLines(codeLines);
    const messageHtml = `
      <p>This is the first paragraph explaining what the script does. It provides context for the code below.</p>
      <p>This is the second paragraph with additional details about the configuration requirements.</p>
      ${renderCodeBlock(code, "bash")}
      <ul>
        <li>Step 1: Run the script</li>
        <li>Step 2: Verify the output</li>
        <li>Step 3: Check the logs</li>
      </ul>
    `;

    const container = buildAiPanel([messageHtml]);
    containers.push(container);

    const block = container.querySelector(".ai-code-block") as HTMLElement;
    const pre = block.querySelector("pre") as HTMLElement;

    expect(block).not.toBeNull();
    expect(pre).not.toBeNull();

    // Assert flex-shrink on .ai-code-block is '0' (will fail on unfixed code - default is '1')
    const blockStyle = getComputedStyle(block);
    expect(blockStyle.flexShrink).toBe("0");

    // Assert flex-shrink on pre is 0 (will fail on unfixed code - default is '1')
    const preStyle = getComputedStyle(pre);
    expect(parseFloat(preStyle.flexShrink)).toBe(0);

    // Assert white-space on pre is 'pre' (may fail if not explicitly set)
    expect(preStyle.whiteSpace).toBe("pre");

    // Assert block height is sufficient for content
    const expectedMinHeight =
      codeLines * LINE_HEIGHT + PADDING_TOP + PADDING_BOTTOM + TOOLBAR_HEIGHT - TOLERANCE;
    expect(block.clientHeight).toBeGreaterThanOrEqual(expectedMinHeight);
  });

  /**
   * Scenario B: single message with two 6-line code blocks
   * (corresponds to design.md Bug Details · Examples #2)
   *
   * **Validates: Requirements 1.1, 1.4, 2.1, 2.5**
   */
  it("Scenario B: single message with two 6-line code blocks - both should maintain height", () => {
    const codeLines = 6;
    const code1 = generateCodeLines(codeLines);
    const code2 = Array.from({ length: codeLines }, (_, i) => `curl -X POST http://api/item/${i}`).join("\n");

    const messageHtml = `
      <p>Here are two code examples:</p>
      ${renderCodeBlock(code1, "bash")}
      <p>And another approach:</p>
      ${renderCodeBlock(code2, "bash")}
    `;

    const container = buildAiPanel([messageHtml]);
    containers.push(container);

    const blocks = container.querySelectorAll(".ai-code-block") as NodeListOf<HTMLElement>;
    expect(blocks.length).toBe(2);

    for (const block of blocks) {
      const pre = block.querySelector("pre") as HTMLElement;

      // Assert flex-shrink on .ai-code-block is '0'
      const blockStyle = getComputedStyle(block);
      expect(blockStyle.flexShrink).toBe("0");

      // Assert flex-shrink on pre is 0
      const preStyle = getComputedStyle(pre);
      expect(parseFloat(preStyle.flexShrink)).toBe(0);

      // Assert white-space on pre is 'pre'
      expect(preStyle.whiteSpace).toBe("pre");

      // Assert block height is sufficient
      const expectedMinHeight =
        codeLines * LINE_HEIGHT + PADDING_TOP + PADDING_BOTTOM + TOOLBAR_HEIGHT - TOLERANCE;
      expect(block.clientHeight).toBeGreaterThanOrEqual(expectedMinHeight);
    }
  });

  /**
   * Scenario C: 5 consecutive assistant messages each with an 8-line code block,
   * observe first message's code block
   * (corresponds to design.md Bug Details · Examples #3)
   *
   * **Validates: Requirements 1.4, 2.5**
   */
  it("Scenario C: 5 messages with code blocks - first message code block should not shrink", () => {
    const codeLines = 8;
    const messages = Array.from({ length: 5 }, (_, i) => {
      const code = Array.from({ length: codeLines }, (_, j) => `command_${i}_step_${j}`).join("\n");
      return `
        <p>Message ${i + 1} explanation text.</p>
        ${renderCodeBlock(code, "bash")}
      `;
    });

    const container = buildAiPanel(messages);
    containers.push(container);

    // Get the first message's code block
    const firstMessage = container.querySelector(".xterminal-ai-message") as HTMLElement;
    const block = firstMessage.querySelector(".ai-code-block") as HTMLElement;
    const pre = block.querySelector("pre") as HTMLElement;

    expect(block).not.toBeNull();

    // Assert flex-shrink on .ai-code-block is '0'
    const blockStyle = getComputedStyle(block);
    expect(blockStyle.flexShrink).toBe("0");

    // Assert flex-shrink on pre is 0
    const preStyle = getComputedStyle(pre);
    expect(parseFloat(preStyle.flexShrink)).toBe(0);

    // Assert white-space on pre is 'pre'
    expect(preStyle.whiteSpace).toBe("pre");

    // Assert block height is sufficient for 8 lines
    const expectedMinHeight =
      codeLines * LINE_HEIGHT + PADDING_TOP + PADDING_BOTTOM + TOOLBAR_HEIGHT - TOLERANCE;
    expect(block.clientHeight).toBeGreaterThanOrEqual(expectedMinHeight);
  });

  /**
   * Property-based test: for any code block with N lines (3-20) placed alongside
   * varying amounts of surrounding content, the code block should not be squeezed.
   *
   * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5**
   */
  it("Property: code blocks with N lines maintain flex-shrink: 0 regardless of surrounding content", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 20 }), // code line count
        fc.integer({ min: 1, max: 5 }),   // number of paragraphs before
        fc.integer({ min: 0, max: 3 }),   // number of list items after
        (codeLines, paragraphCount, listItemCount) => {
          const paragraphs = Array.from(
            { length: paragraphCount },
            (_, i) => `<p>Paragraph ${i + 1} with some explanation text that takes up space.</p>`
          ).join("\n");

          const listItems = listItemCount > 0
            ? `<ul>${Array.from({ length: listItemCount }, (_, i) => `<li>Item ${i + 1}</li>`).join("")}</ul>`
            : "";

          const code = generateCodeLines(codeLines);
          const messageHtml = `${paragraphs}\n${renderCodeBlock(code, "bash")}\n${listItems}`;

          const container = buildAiPanel([messageHtml]);

          try {
            const block = container.querySelector(".ai-code-block") as HTMLElement;
            const pre = block.querySelector("pre") as HTMLElement;

            const blockStyle = getComputedStyle(block);
            const preStyle = getComputedStyle(pre);

            // flex-shrink must be 0 to prevent squeeze
            if (blockStyle.flexShrink !== "0") return false;
            if (parseFloat(preStyle.flexShrink) !== 0) return false;
            if (preStyle.whiteSpace !== "pre") return false;

            return true;
          } finally {
            container.remove();
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
