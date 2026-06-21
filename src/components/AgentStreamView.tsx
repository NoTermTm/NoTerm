import React, { useEffect, useRef, useState, useCallback } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openPath } from "@tauri-apps/plugin-opener";
import { useI18n } from "../i18n";
import { AppIcon } from "./AppIcon";
import type { AgentBlock, AgentRisk } from "../types/agent";
import "./AgentStreamView.css";

interface AgentStreamViewProps {
  blocks: AgentBlock[];
  isRunning: boolean;
  pendingConfirmation: {
    actionId: string;
    command: string;
    risk: AgentRisk;
    reason: string;
  } | null;
  onConfirm: (actionId: string) => void;
  onReject: (actionId: string) => void;
  onCopy: (text: string) => void | Promise<void>;
}

/* ─── Helpers ─── */

function renderMarkdown(content: string, options?: { breaks?: boolean }): string {
  const raw = marked.parse(content || "", {
    gfm: true,
    breaks: options?.breaks ?? false,
  });
  return DOMPurify.sanitize(raw, { SAFE_FOR_TEMPLATES: true });
}

function riskColor(risk: AgentRisk): string {
  switch (risk) {
    case "low":
      return "#22c55e";
    case "medium":
      return "#f59e0b";
    case "high":
      return "#ef4444";
    case "critical":
      return "#dc2626";
    default:
      return "#6b7280";
  }
}

function riskLabel(risk: AgentRisk): string {
  switch (risk) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "critical":
      return "Critical";
    default:
      return risk;
  }
}

function statusIcon(status?: string): { icon: string; className: string } {
  switch (status) {
    case "pending":
      return { icon: "material-symbols:hourglass-top", className: "agent-status--pending" };
    case "running":
      return { icon: "material-symbols:play-circle-outline", className: "agent-status--running" };
    case "success":
      return { icon: "material-symbols:check-circle-outline", className: "agent-status--success" };
    case "failed":
      return { icon: "material-symbols:cancel-outline", className: "agent-status--failed" };
    case "blocked":
      return { icon: "material-symbols:block", className: "agent-status--blocked" };
    case "rejected":
      return { icon: "material-symbols:close", className: "agent-status--rejected" };
    default:
      return { icon: "material-symbols:circle", className: "" };
  }
}

/* ─── Sub-components ─── */

const ThinkingBlock: React.FC<{ block: AgentBlock; defaultExpanded: boolean }> = ({
  block,
  defaultExpanded,
}) => {
  const [collapsed, setCollapsed] = useState(!defaultExpanded);
  const html = renderMarkdown(block.content, { breaks: true });
  const contentId = `thinking-content-${block.id}`;

  useEffect(() => {
    setCollapsed(!defaultExpanded);
  }, [block.id, defaultExpanded]);

  return (
    <div className={`agent-block agent-block--thinking ${collapsed ? "agent-block--collapsed" : ""}`}>
      <button
        type="button"
        className="agent-block__toggle"
        aria-expanded={!collapsed}
        aria-controls={contentId}
        onClick={() => setCollapsed((prev) => !prev)}
      >
        <span className="agent-block__header">
          <AppIcon icon="material-symbols:psychology" size={16} />
          <span className="agent-block__label">Thinking</span>
        </span>
        <AppIcon icon={collapsed ? "material-symbols:chevron-right" : "material-symbols:expand-more"} size={18} />
      </button>
      {!collapsed && (
        <div
          id={contentId}
          className="agent-block__content agent-block__markdown"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
};

const ActionBlock: React.FC<{ block: AgentBlock }> = ({ block }) => {
  const { icon, className } = statusIcon(block.status);
  const isError = block.status === "failed" || block.status === "blocked";
  return (
    <div className={`agent-block agent-block--command ${isError ? "agent-block--command-error" : ""}`}>
      <div className="agent-command__header">
        <span className="agent-command__header-left">
          {isError
            ? <AppIcon icon="material-symbols:warning" size={14} />
            : <AppIcon icon="material-symbols:terminal" size={14} />
          }
          <span className="agent-command__title">Command</span>
        </span>
        <span className="agent-command__header-right">
          <span className={`agent-block__status ${className}`}>
            <AppIcon icon={icon} size={14} />
          </span>
        </span>
      </div>
      <div className="agent-command__body">
        <pre className="agent-command__cmd"><code>{block.command || block.content || ""}</code></pre>
      </div>
      {block.content && block.command && (
        <div className="agent-command__reason">{block.content}</div>
      )}
    </div>
  );
};

const OutputBlock: React.FC<{ block: AgentBlock }> = ({ block }) => {
  const exitCode = block.exitCode ?? 0;
  const isError = exitCode !== 0;
  const [collapsed, setCollapsed] = useState(true);
  const outputContent = block.content || "";
  const stderrContent = block.stderr || "";
  const hasContent = !!(outputContent || stderrContent);

  return (
    <div className={`agent-block agent-block--command-output ${isError ? "agent-block--command-output-error" : ""}`}>
      {hasContent && !collapsed && (
        <div className="agent-command__output-body">
          {outputContent && (
            <pre className="agent-command__output"><code>{outputContent}</code></pre>
          )}
          {stderrContent && (
            <pre className="agent-command__output agent-command__output--stderr"><code>{stderrContent}</code></pre>
          )}
        </div>
      )}
      <div className="agent-command__footer">
        <span className={`agent-command__exit ${isError ? "agent-command__exit--error" : ""}`}>
          exit: {exitCode}
        </span>
        {hasContent && (
          <button
            className="agent-command__toggle"
            onClick={() => setCollapsed(!collapsed)}
            type="button"
          >
            <AppIcon icon={collapsed ? "material-symbols:expand-more" : "material-symbols:expand-less"} size={14} />
          </button>
        )}
      </div>
    </div>
  );
};

const ErrorBlock: React.FC<{ block: AgentBlock }> = ({ block }) => (
  <div className="agent-block agent-block--error">
    <div className="agent-block__header">
      <AppIcon icon="material-symbols:error-outline" size={16} />
      <span className="agent-block__label">Error</span>
    </div>
    <div className="agent-block__content">{block.content}</div>
  </div>
);

const NoticeBlock: React.FC<{ block: AgentBlock }> = ({ block }) => (
  <div className="agent-block agent-block--notice">
    <div className="agent-block__header">
      <AppIcon icon="material-symbols:info-outline" size={16} />
      <span className="agent-block__label">Notice</span>
    </div>
    <div
      className="agent-block__content agent-block__markdown"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(block.content, { breaks: true }) }}
    />
  </div>
);

const UserBlock: React.FC<{ block: AgentBlock }> = ({ block }) => (
  <div className="agent-block agent-block--user">
    <div className="agent-block__header">
      <AppIcon icon="material-symbols:person" size={16} />
      <span className="agent-block__label">You</span>
    </div>
    <div
      className="agent-block__content agent-block__markdown"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(block.content, { breaks: true }) }}
    />
  </div>
);

const StatusBlock: React.FC<{ block: AgentBlock }> = ({ block }) => {
  const { t } = useI18n();
  const label =
    block.phase === "analyzing_output"
      ? (t("agent.status.analyzingOutput") || "Analyzing command output...")
      : (t("agent.status.thinking") || "Thinking...");

  return (
    <div className="agent-block agent-block--status">
      <div className="agent-block__header">
        <div className="agent-stream__loading-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span className="agent-block__label">{label}</span>
      </div>
    </div>
  );
};

const DoneBlock: React.FC<{ block: AgentBlock; onCopy: (text: string) => void | Promise<void> }> = ({
  block,
  onCopy,
}) => (
  <div className="agent-block agent-block--done">
    {block.content && (
      <>
        <div
          className="agent-block__content agent-block__markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(block.content, { breaks: true }) }}
        />
        <div className="agent-block__footer">
          <button
            type="button"
            className="agent-block__copy-btn"
            onClick={() => void onCopy(block.content)}
            aria-label="Copy final response"
            title="Copy final response"
          >
            <AppIcon icon="material-symbols:content-copy-outline-rounded" size={15} />
          </button>
        </div>
      </>
    )}
  </div>
);

/* ─── Main Component ─── */

const AgentStreamView: React.FC<AgentStreamViewProps> = ({
  blocks,
  isRunning,
  pendingConfirmation,
  onConfirm,
  onReject,
  onCopy,
}) => {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const userScrolledRef = useRef(false);

  // Auto-scroll to bottom when new blocks arrive
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "auto" });
    }
  }, [blocks, autoScroll, pendingConfirmation]);

  // Detect user scroll to pause auto-scroll
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) {
      userScrolledRef.current = false;
      setAutoScroll(true);
    } else {
      if (!userScrolledRef.current) {
        userScrolledRef.current = true;
        setAutoScroll(false);
      }
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    userScrolledRef.current = false;
    setAutoScroll(true);
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleLinkClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href")?.trim();
      if (!href) return;
      event.preventDefault();
      void openPath(href).catch(() => {});
    };

    el.addEventListener("click", handleLinkClick);
    return () => {
      el.removeEventListener("click", handleLinkClick);
    };
  }, []);

  const latestThinkingBlockId = [...blocks]
    .reverse()
    .find((block) => block.type === "thinking")?.id;

  const renderBlock = (block: AgentBlock) => {
    switch (block.type) {
      case "thinking":
        return (
          <ThinkingBlock
            key={block.id}
            block={block}
            defaultExpanded={block.id === latestThinkingBlockId}
          />
        );
      case "action":
        return <ActionBlock key={block.id} block={block} />;
      case "output":
        return <OutputBlock key={block.id} block={block} />;
      case "error":
        return <ErrorBlock key={block.id} block={block} />;
      case "notice":
        return <NoticeBlock key={block.id} block={block} />;
      case "done":
        return <DoneBlock key={block.id} block={block} onCopy={onCopy} />;
      case "user":
        return <UserBlock key={block.id} block={block} />;
      case "status":
        return <StatusBlock key={block.id} block={block} />;
      default:
        return null;
    }
  };

  return (
    <div className="agent-stream">
      <div
        className="agent-stream__container"
        ref={containerRef}
        onScroll={handleScroll}
      >
        {blocks.map(renderBlock)}

        {/* Running indicator: keep visible whenever the loop is still active but no thinking block is currently streaming */}
        {isRunning && !pendingConfirmation && (() => {
          const last = blocks[blocks.length - 1];
          const showLoading = !last || last.type !== "thinking";
          if (!showLoading) return null;

          const isExecuting =
            last?.type === "action" &&
            (last.status === "running" || last.status === "pending");

          return (
            <div className="agent-stream__loading">
              <div className="agent-stream__loading-dots">
                <span />
                <span />
                <span />
              </div>
              <span className="agent-stream__loading-text">
                {isExecuting
                  ? (t("agent.status.executing") || "Executing...")
                  : (t("agent.status.thinking") || "Thinking...")}
              </span>
            </div>
          );
        })()}

        {/* Confirmation UI */}
        {pendingConfirmation && (
          <div className={`agent-stream__confirm agent-stream__confirm--${pendingConfirmation.risk}`}>
            <div className="agent-stream__confirm-header">
              <AppIcon icon="material-symbols:shield-question" size={20} />
              <span className="agent-stream__confirm-title">
                {t("agent.confirm.title")}
              </span>
              <span
                className="agent-block__risk-badge"
                style={{ backgroundColor: riskColor(pendingConfirmation.risk) }}
              >
                {riskLabel(pendingConfirmation.risk)}
              </span>
            </div>
            <div className="agent-stream__confirm-command">
              <code>{pendingConfirmation.command}</code>
            </div>
            <div className="agent-stream__confirm-reason">
              {pendingConfirmation.reason}
            </div>
            <div className="agent-stream__confirm-actions">
              <button
                className="btn btn-primary agent-stream__confirm-btn"
                onClick={() => onConfirm(pendingConfirmation.actionId)}
              >
                <AppIcon icon="material-symbols:check" size={14} />
                {t("agent.confirm.approve")}
              </button>
              <button
                className="btn btn-danger agent-stream__confirm-btn"
                onClick={() => onReject(pendingConfirmation.actionId)}
              >
                <AppIcon icon="material-symbols:close" size={14} />
                {t("agent.confirm.reject")}
              </button>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Scroll to bottom button */}
      {!autoScroll && (
        <button
          className="agent-stream__scroll-btn"
          onClick={scrollToBottom}
          title={t("agent.scrollToBottom")}
        >
          <AppIcon icon="material-symbols:keyboard-arrow-down" size={20} />
        </button>
      )}
    </div>
  );
};

export default AgentStreamView;
