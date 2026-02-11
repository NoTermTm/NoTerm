import React, { useEffect, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js";
import "highlight.js/styles/github.css";
import { sshApi } from "../api/ssh";

export interface AiRendererProps {
  content: string;
  sessionId?: string;
  useLocal?: boolean;
  role?: "system" | "user" | "assistant";
}

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

const AiRenderer2: React.FC<AiRendererProps> = ({ content, sessionId, useLocal, role }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const renderer = new marked.Renderer();
  renderer.code = (code: string, infostring?: string) => {
    const lang = (infostring || "").split(/\s+/)[0];
    const encoded = escapeAttr(code);
    const showSend = role === "assistant";
    const sendIcon =
      "<svg class=\"ai-btn-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M2 21l21-9L2 3v7l15 2-15 2z\"/></svg>";
    const copyIcon =
      "<svg class=\"ai-btn-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z\"/></svg>";
    const sendButton = showSend
      ? `<button class=\"ai-send-btn\" data-code=\"${encoded}\" title=\"发送到终端\" aria-label=\"发送到终端\">${sendIcon}</button>`
      : "";
    
    // 使用 highlight.js 进行语法高亮
    let highlighted = escapeHtml(code);
    if (lang) {
      try {
        highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch (e) {
        // 如果指定语言失败，尝试自动检测
        try {
          highlighted = hljs.highlightAuto(code).value;
        } catch (e2) {
          // 自动检测也失败，使用原始转义的代码
          highlighted = escapeHtml(code);
        }
      }
    } else {
      // 没有指定语言时自动检测
      try {
        highlighted = hljs.highlightAuto(code).value;
      } catch (e) {
        highlighted = escapeHtml(code);
      }
    }
    
    return `\n<div class="ai-code-block">\n  <div class="ai-code-toolbar">\n    ${sendButton}\n    <button class=\"ai-copy-btn\" data-code=\"${encoded}\" title=\"复制\" aria-label=\"复制\">${copyIcon}</button>\n  </div>\n  <pre><code class="language-${lang} hljs">${highlighted}</code></pre>\n</div>\n`;
  };

  useEffect(() => {
    const raw = marked.parse(content || "", { renderer });
    const clean = DOMPurify.sanitize(raw, { SAFE_FOR_TEMPLATES: true });
    const el = containerRef.current;
    if (!el) return;
    el.innerHTML = clean;

    const sendButtons = el.querySelectorAll<HTMLButtonElement>(".ai-send-btn");
    sendButtons.forEach((btn) => {
      btn.onclick = async () => {
        const code = decodeURIComponent(btn.dataset.code || "");
        if (!code) return;
        if (!sessionId) {
          try {
            await navigator.clipboard.writeText(code);
          } catch (e) {
            /* ignore */
          }
          return;
        }
        try {
          if (useLocal) {
            await sshApi.localWriteToShell(sessionId, code + "\n");
          } else {
            await sshApi.writeToShell(sessionId, code + "\n");
          }
        } catch (e) {
          console.error("send to terminal failed", e);
        }
      };
    });

    const copyButtons = el.querySelectorAll<HTMLButtonElement>(".ai-copy-btn");
    copyButtons.forEach((btn) => {
      btn.onclick = async () => {
        const code = decodeURIComponent(btn.dataset.code || "");
        if (!code) return;
        try {
          await navigator.clipboard.writeText(code);
        } catch (e) {
          console.error("copy failed", e);
        }
      };
    });
  }, [content, sessionId, useLocal, role]);

  return <div ref={containerRef} className="ai-renderer" />;
};

export default AiRenderer2;
