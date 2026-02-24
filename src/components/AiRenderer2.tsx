import React, { useEffect, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js";
import "highlight.js/styles/github.css";
import { sshApi } from "../api/ssh";
import { useI18n } from "../i18n";

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
  const { t } = useI18n();
  const executeLabel = t("ai.renderer.execute");
  const copyLabel = t("ai.renderer.copy");

  const renderer = new marked.Renderer();
  renderer.code = (code: string, infostring?: string) => {
    const lang = (infostring || "").split(/\s+/)[0];
    const encoded = escapeAttr(code);
    const showSend = role === "assistant";
    const sendIcon =
      "<svg class=\"ai-btn-icon\"  viewBox=\"0 0 24 24\"><path fill=\"currentColor\" d=\"M8 5v14l11-7z\"/></svg>";
    const copyIcon =
      "<svg class=\"ai-btn-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z\"/></svg>";
    const sendButton = showSend
      ? `<button type=\"button\" class=\"ai-send-btn\" data-action=\"send\" data-code=\"${encoded}\" title=\"${executeLabel}\" aria-label=\"${executeLabel}\">${sendIcon}</button>`
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
    
    return `\n<div class="ai-code-block">\n<div class="ai-code-toolbar">\n    ${sendButton}\n    <button type=\"button\" class=\"ai-copy-btn\" data-action=\"copy\" data-code=\"${encoded}\" title=\"${copyLabel}\" aria-label=\"${copyLabel}\">${copyIcon}</button>\n  </div>\n<pre><code class="language-${lang} hljs">${highlighted}</code></pre>\n </div>\n`;
  };

  useEffect(() => {
    const raw = marked.parse(content || "", { renderer });
    const clean = DOMPurify.sanitize(raw, {
      SAFE_FOR_TEMPLATES: true,
      ADD_TAGS: ["button"],
      ADD_ATTR: ["data-code", "data-action"],
    });
    const el = containerRef.current;
    if (!el) return;
    el.innerHTML = clean;
    const handleClick = async (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const button = target.closest<HTMLButtonElement>(".ai-send-btn, .ai-copy-btn");
      if (!button) return;
      const code = decodeURIComponent(button.dataset.code || "");
      if (!code) return;

      if (button.dataset.action === "copy") {
        try {
          await navigator.clipboard.writeText(code);
        } catch (e) {
          console.error("copy failed", e);
        }
        return;
      }

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

    el.addEventListener("click", handleClick);
    return () => {
      el.removeEventListener("click", handleClick);
    };
  }, [content, sessionId, useLocal, role, executeLabel, copyLabel]);

  return <div ref={containerRef} className="ai-renderer" />;
};

export default AiRenderer2;
