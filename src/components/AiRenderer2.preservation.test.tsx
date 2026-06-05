// @vitest-environment jsdom
/**
 * Preservation Property Tests for AiRenderer2
 * These tests verify that existing rendering behavior is preserved.
 * All tests MUST PASS on the current unfixed code.
 *
 * Validates: design.md Property 2
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js";

// ─── Helpers ───

function escapeAttr(s: string) {
  return encodeURIComponent(s);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type StringArbitraryOptions = {
  minLength: number;
  maxLength: number;
};

/**
 * fast-check v4 removed char/stringOf, so we model the same intent with
 * string({ unit }) to keep these preservation tests close to their originals.
 */
function stringFromUnits(units: fc.Arbitrary<string>, options: StringArbitraryOptions): fc.Arbitrary<string> {
  return fc.string({ unit: units, ...options });
}

/**
 * Renders markdown content using the same logic as AiRenderer2.tsx
 */
function renderAiContent(content: string, role: "assistant" | "user" | "system" = "assistant"): string {
  const renderer = new marked.Renderer();
  renderer.code = (code: string, infostring?: string) => {
    const lang = (infostring || "").split(/\s+/)[0];
    const encoded = escapeAttr(code);
    const showSend = role === "assistant";
    const sendIcon =
      '<svg class="ai-btn-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
    const copyIcon =
      '<svg class="ai-btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';
    const sendButton = showSend
      ? `<button type="button" class="ai-send-btn" data-action="send" data-code="${encoded}" title="Execute" aria-label="Execute">${sendIcon}</button>`
      : "";

    let highlighted = escapeHtml(code);
    if (lang) {
      try {
        highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        try { highlighted = hljs.highlightAuto(code).value; } catch { /* */ }
      }
    } else {
      try { highlighted = hljs.highlightAuto(code).value; } catch { /* */ }
    }

    return `\n<div class="ai-code-block">\n<div class="ai-code-toolbar">\n    ${sendButton}\n    <button type="button" class="ai-copy-btn" data-action="copy" data-code="${encoded}" title="Copy" aria-label="Copy">${copyIcon}</button>\n  </div>\n<pre><code class="language-${lang} hljs">${highlighted}</code></pre>\n </div>\n`;
  };

  const raw = marked.parse(content || "", { renderer });
  return DOMPurify.sanitize(raw, {
    SAFE_FOR_TEMPLATES: true,
    ADD_TAGS: ["button"],
    ADD_ATTR: ["data-code", "data-action"],
  });
}


/**
 * Injects relevant CSS rules into the document for testing computed styles.
 */
function injectStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `
    /* Global font */
    code, kbd, pre, samp {
      font-family: "SF Mono", monospace;
      font-variant-ligatures: none;
    }

    /* .ai-renderer rules from XTerminal.css */
    .ai-renderer {
      font-size: 13px;
      line-height: 1.5;
      color: #333;
      min-width: 0;
      width: 100%;
      max-width: 100%;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .ai-renderer p {
      line-height: 1.5;
    }
    .ai-renderer ul, .ai-renderer ol {
      padding-left: 18px;
    }
    .ai-renderer li {
      margin: 10px 0;
    }
    .ai-renderer > * {
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }
    .ai-renderer a, .ai-renderer code, .ai-renderer strong, .ai-renderer em, .ai-renderer span {
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .ai-renderer pre {
      background: transparent;
      margin: 2px 0;
      max-width: 100%;
      overflow-x: auto;
    }

    /* .ai-code-block rules from XTerminal.css (UNFIXED) */
    .ai-code-block {
      margin: 10px 0;
      position: relative;
      border-radius: 8px;
      overflow: hidden;
      background: #f5f5f5;
      box-sizing: border-box;
      border: 1px solid #e0e0e0;
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
    .ai-code-block pre code.hljs, .ai-code-block pre .hljs {
      padding: 0;
      margin: 0;
      background: transparent;
      display: block;
      color: #333;
      min-width: 0;
      max-width: 100%;
      font-family: "SF Mono", monospace;
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
      background-color: #eee;
      border-bottom: 1px solid #e0e0e0;
    }
    .ai-code-toolbar button {
      border: 1px solid #e0e0e0;
      background: #f9f9f9;
      color: #666;
      padding: 0 10px;
      border-radius: 999px;
      font-size: 13px;
      line-height: 1.2;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 28px;
      gap: 10px;
    }

    /* xterminal-ai-message rules */
    .xterminal-ai-message {
      border-radius: 12px;
      padding: 10px 12px;
      background: #f0f0f0;
      border: 1px solid #e0e0e0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
      max-width: 94%;
    }
    .xterminal-ai-message--assistant {
      background: #f8f8f8;
      align-items: flex-start;
      align-self: flex-start;
    }
    .xterminal-ai-message--user {
      background: linear-gradient(135deg, #667eea, #764ba2);
      border-color: transparent;
      align-items: flex-end;
      align-self: flex-end;
      color: white;
    }
    .xterminal-ai-message--user .ai-renderer {
      color: white !important;
    }
    .xterminal-ai-message--system {
      background: #e8f0fe;
      border-color: transparent;
      align-items: center;
      text-align: center;
      align-self: center;
    }

    /* AgentStreamView rules */
    .agent-stream { display: flex; flex-direction: column; height: 100%; }
    .agent-stream__container { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .agent-block { max-width: 88%; align-self: flex-start; border-radius: 8px; padding: 12px 16px; font-size: 13px; line-height: 1.5; }
    .agent-block--user { align-self: flex-end; background-color: #667eea; border: none; color: #fff; border-radius: 14px 14px 4px 14px; padding: 8px 12px; }
    .agent-block--user .agent-block__content { word-break: break-word; color: #fff; }
    .agent-block--error { background-color: #fef2f2; border: 1px solid #fecaca; color: #333; }
    .agent-block--error .agent-block__header { color: #ef4444; }
    .agent-block--thinking { background-color: #f8f8f8; border: 1px solid #e0e0e0; border-radius: 14px 14px 14px 4px; }
    .agent-block--done { background-color: #f0fdf4; border: 1px solid #bbf7d0; }
    .agent-block__markdown { font-family: sans-serif; word-break: break-word; }
    .agent-block__markdown pre { background: #f5f5f5; padding: 8px 12px; border-radius: 8px; overflow-x: auto; margin: 4px 0; }
    .agent-block__markdown pre code { background: none; padding: 0; }
    .agent-block--command, .agent-block--command-output { max-width: 100%; align-self: stretch; padding: 0; overflow: hidden; background-color: #f9f9f9; border: 1px solid #e0e0e0; border-radius: 10px 10px 0 0; }
    .agent-command__cmd { margin: 0; font-family: "SF Mono", monospace; font-size: 12px; line-height: 1.6; color: #333; white-space: pre-wrap; word-break: break-all; }
    .agent-command__output { margin: 0; font-family: "SF Mono", monospace; font-size: 12px; line-height: 1.6; color: #333; white-space: pre-wrap; word-break: break-all; }
  `;
  document.head.appendChild(style);
  return style;
}


// ─── fast-check Arbitraries ───

/** Generate random paragraph text */
const paragraphArb = stringFromUnits(
  fc.constantFrom(...("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ ,.".split(""))),
  { minLength: 5, maxLength: 80 }
).map((s: string) => s.trim() || "hello");

/** Generate random heading (h1-h6) */
const headingArb = fc.tuple(
  fc.integer({ min: 1, max: 6 }),
  stringFromUnits(
    fc.constantFrom(...("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ ".split(""))),
    { minLength: 3, maxLength: 30 }
  ).map((s: string) => s.trim() || "Title")
).map(([level, text]) => `${"#".repeat(level)} ${text}`);

/** Generate random link */
const linkArb = fc.tuple(
  stringFromUnits(
    fc.constantFrom(...("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ ".split(""))),
    { minLength: 2, maxLength: 20 }
  ).map((s: string) => s.trim() || "link"),
  fc.webUrl()
).map(([text, url]) => `[${text}](${url})`);

/** Generate random unordered list */
const ulArb = fc.array(
  stringFromUnits(
    fc.constantFrom(...("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ ".split(""))),
    { minLength: 3, maxLength: 40 }
  ).map((s: string) => s.trim() || "item"),
  { minLength: 1, maxLength: 5 }
).map(items => items.map(i => `- ${i}`).join("\n"));

/** Generate random ordered list */
const olArb = fc.array(
  stringFromUnits(
    fc.constantFrom(...("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ ".split(""))),
    { minLength: 3, maxLength: 40 }
  ).map((s: string) => s.trim() || "item"),
  { minLength: 1, maxLength: 5 }
).map(items => items.map((i, idx) => `${idx + 1}. ${i}`).join("\n"));

/** Generate markdown without fenced code blocks (for preservation) */
const nonCodeMarkdownArb = fc.array(
  fc.oneof(
    paragraphArb,
    headingArb,
    linkArb,
    ulArb,
    olArb
  ),
  { minLength: 1, maxLength: 4 }
).map(parts => parts.join("\n\n"));

/** Generate random inline code content */
const inlineCodeArb = stringFromUnits(
  fc.constantFrom(...("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.".split(""))),
  { minLength: 1, maxLength: 30 }
).map((s: string) => s.trim() || "code");

/** Generate random code content for fenced code blocks */
const codeContentArb = fc.array(
  stringFromUnits(
    fc.constantFrom(...("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 =".split(""))),
    { minLength: 1, maxLength: 60 }
  ).map((s: string) => s.trim() || "x = 1"),
  { minLength: 1, maxLength: 10 }
).map(lines => lines.join("\n"));

/** Generate random language identifier */
const langArb = fc.oneof(
  fc.constant("bash"),
  fc.constant("typescript"),
  fc.constant("javascript"),
  fc.constant("python"),
  fc.constant("json"),
  fc.constant("")
);

// ─── Test Suite ───

let styleEl: HTMLStyleElement;

beforeEach(() => {
  styleEl = injectStyles();
});

afterEach(() => {
  styleEl.remove();
  document.body.innerHTML = "";
});


describe("Preservation Property Tests", () => {
  /**
   * Prop 2.1 (bugfix.md 3.1): paragraphs, lists, headings, links render correctly
   * Validates: Requirements 3.1
   */
  describe("Prop 2.1: Non-code markdown elements render correctly", () => {
    it("paragraphs, lists, headings, links produce expected DOM structure", () => {
      fc.assert(
        fc.property(nonCodeMarkdownArb, (markdown) => {
          const container = document.createElement("div");
          container.className = "ai-renderer";
          container.innerHTML = renderAiContent(markdown, "assistant");
          document.body.appendChild(container);

          // Paragraphs should exist as <p> elements
          const paragraphs = container.querySelectorAll("p");
          // Lists should be <ul> or <ol>
          const lists = container.querySelectorAll("ul, ol");
          // Headings should be h1-h6
          // At least some content should be rendered
          expect(container.innerHTML.length).toBeGreaterThan(0);

          // No .ai-code-block should exist (we didn't generate fenced code blocks)
          const codeBlocks = container.querySelectorAll(".ai-code-block");
          expect(codeBlocks.length).toBe(0);

          // Verify computed styles on rendered elements
          if (paragraphs.length > 0) {
            const pStyle = window.getComputedStyle(paragraphs[0]);
            expect(pStyle.lineHeight).toBe("1.5");
          }
          if (lists.length > 0) {
            const listStyle = window.getComputedStyle(lists[0]);
            expect(listStyle.paddingLeft).toBe("18px");
          }

          document.body.removeChild(container);
        }),
        { numRuns: 30 }
      );
    });
  });

  /**
   * Prop 2.2 (bugfix.md 3.2): inline `code` stays inline (not wrapped in .ai-code-block)
   * Validates: Requirements 3.2
   */
  describe("Prop 2.2: Inline code stays inline", () => {
    it("inline code elements are not wrapped in .ai-code-block", () => {
      fc.assert(
        fc.property(inlineCodeArb, (codeText) => {
          const markdown = `Here is some \`${codeText}\` inline code in a paragraph.`;
          const container = document.createElement("div");
          container.className = "ai-renderer";
          container.innerHTML = renderAiContent(markdown, "assistant");
          document.body.appendChild(container);

          // Find all <code> elements
          const codeElements = container.querySelectorAll("code");
          expect(codeElements.length).toBeGreaterThan(0);

          // None of them should be inside .ai-code-block
          for (const codeEl of codeElements) {
            const closestBlock = codeEl.closest(".ai-code-block");
            expect(closestBlock).toBeNull();
          }

          // Inline code should not have display: block
          for (const codeEl of codeElements) {
            const style = window.getComputedStyle(codeEl);
            expect(style.display).not.toBe("block");
          }

          document.body.removeChild(container);
        }),
        { numRuns: 30 }
      );
    });
  });


  /**
   * Prop 2.3 (bugfix.md 3.3): assistant role code blocks have both .ai-send-btn and .ai-copy-btn
   * Validates: Requirements 3.3
   */
  describe("Prop 2.3: Assistant code blocks have send + copy buttons", () => {
    it("assistant role code blocks contain both .ai-send-btn and .ai-copy-btn with correct attributes", () => {
      fc.assert(
        fc.property(codeContentArb, langArb, (code, lang) => {
          const markdown = "```" + lang + "\n" + code + "\n```";
          const container = document.createElement("div");
          container.className = "ai-renderer";
          container.innerHTML = renderAiContent(markdown, "assistant");
          document.body.appendChild(container);

          const codeBlocks = container.querySelectorAll(".ai-code-block");
          expect(codeBlocks.length).toBe(1);

          const block = codeBlocks[0];
          const sendBtn = block.querySelector(".ai-send-btn");
          const copyBtn = block.querySelector(".ai-copy-btn");

          // Both buttons must exist for assistant role
          expect(sendBtn).not.toBeNull();
          expect(copyBtn).not.toBeNull();

          // Check data-action attributes
          expect(sendBtn!.getAttribute("data-action")).toBe("send");
          expect(copyBtn!.getAttribute("data-action")).toBe("copy");

          // Check data-code decodes to original code
          const sendCode = decodeURIComponent(sendBtn!.getAttribute("data-code") || "");
          const copyCode = decodeURIComponent(copyBtn!.getAttribute("data-code") || "");
          expect(sendCode).toBe(code);
          expect(copyCode).toBe(code);

          document.body.removeChild(container);
        }),
        { numRuns: 30 }
      );
    });
  });

  /**
   * Prop 2.4 (bugfix.md 3.4): user/system role code blocks only have .ai-copy-btn (no .ai-send-btn)
   * Validates: Requirements 3.4
   */
  describe("Prop 2.4: Non-assistant code blocks only have copy button", () => {
    it("user/system role code blocks have only .ai-copy-btn, no .ai-send-btn", () => {
      fc.assert(
        fc.property(
          codeContentArb,
          langArb,
          fc.oneof(fc.constant("user" as const), fc.constant("system" as const)),
          (code, lang, role) => {
            const markdown = "```" + lang + "\n" + code + "\n```";
            const container = document.createElement("div");
            container.className = "ai-renderer";
            container.innerHTML = renderAiContent(markdown, role);
            document.body.appendChild(container);

            const codeBlocks = container.querySelectorAll(".ai-code-block");
            expect(codeBlocks.length).toBe(1);

            const block = codeBlocks[0];
            const sendBtn = block.querySelector(".ai-send-btn");
            const copyBtn = block.querySelector(".ai-copy-btn");

            // Only copy button should exist
            expect(sendBtn).toBeNull();
            expect(copyBtn).not.toBeNull();

            // Check data-action and data-code
            expect(copyBtn!.getAttribute("data-action")).toBe("copy");
            const copyCode = decodeURIComponent(copyBtn!.getAttribute("data-code") || "");
            expect(copyCode).toBe(code);

            document.body.removeChild(container);
          }
        ),
        { numRuns: 30 }
      );
    });
  });


  /**
   * Prop 2.5 (bugfix.md 3.5): AgentStreamView thinking/done blocks render with existing styles
   * Validates: Requirements 3.5
   */
  describe("Prop 2.5: AgentStreamView thinking/done blocks maintain styles", () => {
    function renderAgentMarkdown(content: string): string {
      const raw = marked.parse(content || "");
      return DOMPurify.sanitize(raw, { SAFE_FOR_TEMPLATES: true });
    }

    it("thinking block markdown pre elements have expected styles", () => {
      fc.assert(
        fc.property(codeContentArb, (code) => {
          const markdownWithCode = "Some thinking:\n\n```\n" + code + "\n```";
          const html = renderAgentMarkdown(markdownWithCode);

          const block = document.createElement("div");
          block.className = "agent-block agent-block--thinking";
          block.innerHTML = `
            <div class="agent-block__header"><span class="agent-block__label">Thinking</span></div>
            <div class="agent-block__content agent-block__markdown">${html}</div>
          `;
          document.body.appendChild(block);

          const preElements = block.querySelectorAll(".agent-block__markdown pre");
          for (const pre of preElements) {
            const style = window.getComputedStyle(pre);
            // AgentStreamView.css: .agent-block__markdown pre has overflow-x: auto
            expect(style.overflowX).toBe("auto");
            // padding should be set
            expect(style.padding).toBe("8px 12px");
            // border-radius
            expect(style.borderRadius).toBe("8px");
          }

          document.body.removeChild(block);
        }),
        { numRuns: 20 }
      );
    });

    it("done block markdown pre elements have expected styles", () => {
      fc.assert(
        fc.property(codeContentArb, (code) => {
          const markdownWithCode = "Completed:\n\n```\n" + code + "\n```";
          const html = renderAgentMarkdown(markdownWithCode);

          const block = document.createElement("div");
          block.className = "agent-block agent-block--done";
          block.innerHTML = `
            <div class="agent-block__header"><span class="agent-block__label">Done</span></div>
            <div class="agent-block__content agent-block__markdown">${html}</div>
          `;
          document.body.appendChild(block);

          const preElements = block.querySelectorAll(".agent-block__markdown pre");
          for (const pre of preElements) {
            const style = window.getComputedStyle(pre);
            expect(style.overflowX).toBe("auto");
            expect(style.padding).toBe("8px 12px");
            expect(style.borderRadius).toBe("8px");
          }

          document.body.removeChild(block);
        }),
        { numRuns: 20 }
      );
    });
  });

  /**
   * Prop 2.6 (bugfix.md 3.6): terminal command blocks maintain white-space: pre-wrap
   * Validates: Requirements 3.6
   */
  describe("Prop 2.6: Terminal command blocks maintain white-space: pre-wrap", () => {
    it("agent-command__cmd has white-space: pre-wrap", () => {
      fc.assert(
        fc.property(
          stringFromUnits(
            fc.constantFrom(...("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_\n".split(""))),
            { minLength: 3, maxLength: 100 }
          ).map((s: string) => s.trim() || "ls -la"),
          (command) => {
            const block = document.createElement("div");
            block.className = "agent-block agent-block--command";
            block.innerHTML = `
              <div class="agent-command__header">
                <span class="agent-command__header-left"><span class="agent-command__title">Command</span></span>
              </div>
              <div class="agent-command__body">
                <pre class="agent-command__cmd"><code>${escapeHtml(command)}</code></pre>
              </div>
            `;
            document.body.appendChild(block);

            const cmd = block.querySelector(".agent-command__cmd");
            expect(cmd).not.toBeNull();
            const style = window.getComputedStyle(cmd!);
            expect(style.whiteSpace).toBe("pre-wrap");

            document.body.removeChild(block);
          }
        ),
        { numRuns: 20 }
      );
    });

    it("agent-command__output has white-space: pre-wrap", () => {
      fc.assert(
        fc.property(
          stringFromUnits(
            fc.constantFrom(...("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_\n".split(""))),
            { minLength: 3, maxLength: 100 }
          ).map((s: string) => s.trim() || "output"),
          (output) => {
            const block = document.createElement("div");
            block.className = "agent-block agent-block--command-output";
            block.innerHTML = `
              <div class="agent-command__output-body">
                <pre class="agent-command__output"><code>${escapeHtml(output)}</code></pre>
              </div>
            `;
            document.body.appendChild(block);

            const outputEl = block.querySelector(".agent-command__output");
            expect(outputEl).not.toBeNull();
            const style = window.getComputedStyle(outputEl!);
            expect(style.whiteSpace).toBe("pre-wrap");

            document.body.removeChild(block);
          }
        ),
        { numRuns: 20 }
      );
    });
  });


  /**
   * Prop 2.7 (bugfix.md 3.7): user message blocks and error blocks maintain existing alignment/colors
   * Validates: Requirements 3.7
   */
  describe("Prop 2.7: User and error blocks maintain alignment and colors", () => {
    it("agent-block--user has correct alignment and color", () => {
      fc.assert(
        fc.property(
          stringFromUnits(
            fc.constantFrom(...("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ ".split(""))),
            { minLength: 3, maxLength: 60 }
          ).map((s: string) => s.trim() || "hello"),
          (text) => {
            const container = document.createElement("div");
            container.className = "agent-stream__container";
            const block = document.createElement("div");
            block.className = "agent-block agent-block--user";
            block.innerHTML = `
              <div class="agent-block__header"><span class="agent-block__label">You</span></div>
              <div class="agent-block__content">${escapeHtml(text)}</div>
            `;
            container.appendChild(block);
            document.body.appendChild(container);

            const style = window.getComputedStyle(block);
            expect(style.alignSelf).toBe("flex-end");
            expect(style.color).toBe("rgb(255, 255, 255)");

            const content = block.querySelector(".agent-block__content") as HTMLElement;
            const contentStyle = window.getComputedStyle(content);
            expect(contentStyle.whiteSpace).toBe("pre-wrap");
            expect(contentStyle.wordBreak).toBe("break-word");
            expect(contentStyle.color).toBe("rgb(255, 255, 255)");

            document.body.removeChild(container);
          }
        ),
        { numRuns: 20 }
      );
    });

    it("agent-block--error has correct styling", () => {
      fc.assert(
        fc.property(
          stringFromUnits(
            fc.constantFrom(...("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ ".split(""))),
            { minLength: 3, maxLength: 60 }
          ).map((s: string) => s.trim() || "error"),
          (text) => {
            const block = document.createElement("div");
            block.className = "agent-block agent-block--error";
            block.innerHTML = `
              <div class="agent-block__header"><span class="agent-block__label">Error</span></div>
              <div class="agent-block__content">${escapeHtml(text)}</div>
            `;
            document.body.appendChild(block);

            const header = block.querySelector(".agent-block__header") as HTMLElement;
            const headerStyle = window.getComputedStyle(header);
            expect(headerStyle.color).toBe("rgb(239, 68, 68)");

            document.body.removeChild(block);
          }
        ),
        { numRuns: 20 }
      );
    });

    it("xterminal-ai-message--user has correct alignment", () => {
      fc.assert(
        fc.property(
          stringFromUnits(
            fc.constantFrom(...("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ ".split(""))),
            { minLength: 3, maxLength: 60 }
          ).map((s: string) => s.trim() || "hello"),
          (text) => {
            const history = document.createElement("div");
            history.className = "xterminal-ai-history";
            history.style.display = "flex";
            history.style.flexDirection = "column";

            const msg = document.createElement("div");
            msg.className = "xterminal-ai-message xterminal-ai-message--user";
            msg.innerHTML = `<div class="ai-renderer">${escapeHtml(text)}</div>`;
            history.appendChild(msg);
            document.body.appendChild(history);

            const style = window.getComputedStyle(msg);
            expect(style.alignSelf).toBe("flex-end");

            const renderer = msg.querySelector(".ai-renderer") as HTMLElement;
            const rendererStyle = window.getComputedStyle(renderer);
            expect(rendererStyle.color).toBe("rgb(255, 255, 255)");

            document.body.removeChild(history);
          }
        ),
        { numRuns: 20 }
      );
    });
  });
});
