import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { sshApi } from "../api/ssh";
import type { SftpEntry } from "../types/ssh";
import "@xterm/xterm/css/xterm.css";
import "./XTerminal.css";
import { AppIcon } from "./AppIcon";
import {
  DEFAULT_APP_SETTINGS,
  getAppSettingsStore,
  type TerminalThemeName,
} from "../store/appSettings";
import { getXtermTheme } from "../terminal/xtermThemes";

interface XTerminalProps {
  sessionId: string;
  host: string;
  port: number;
  onConnect?: () => Promise<void>;
}

type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

export function XTerminal({
  sessionId,
  host,
  port,
  onConnect,
}: XTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const onConnectRef = useRef<XTerminalProps["onConnect"]>(onConnect);
  const mountedRef = useRef(true);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>("idle");
  const [connError, setConnError] = useState<string | null>(null);
  const [endpointIp, setEndpointIp] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [xtermBg, setXtermBg] = useState<string | undefined>(undefined);
  const [sftpOpen, setSftpOpen] = useState(false);
  const [sftpPath, setSftpPath] = useState("/");
  const [sftpEntries, setSftpEntries] = useState<SftpEntry[]>([]);
  const [sftpLoading, setSftpLoading] = useState(false);
  const [sftpError, setSftpError] = useState<string | null>(null);

  useEffect(() => {
    onConnectRef.current = onConnect;
  }, [onConnect]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const formatError = (error: unknown) => {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  };

  const endpointLabel = useMemo(() => {
    if (!endpointIp) return "--";
    return endpointIp;
  }, [endpointIp]);

  const latencyTone = useMemo(() => {
    if (latencyMs === null) return "unknown";
    if (latencyMs < 120) return "ok";
    if (latencyMs < 250) return "warn";
    return "bad";
  }, [latencyMs]);

  const connectNow = async () => {
    const doConnect = onConnectRef.current;
    if (!doConnect) return;

    setConnStatus("connecting");
    setConnError(null);

    // Best-effort reset before reconnect.
    await sshApi.disconnect(sessionId).catch(() => {});

    try {
      await doConnect();
      if (!mountedRef.current) return;
      setConnStatus("connected");
    } catch (error) {
      if (!mountedRef.current) return;
      const message = formatError(error);
      setConnStatus("error");
      setConnError(message);
    }
  };

  const loadSftpEntries = async (path = sftpPath) => {
    setSftpLoading(true);
    setSftpError(null);
    try {
      const timeoutMs = 5000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error("SFTP 请求超时")), timeoutMs);
      });
      const entries = (await Promise.race([
        sshApi.listSftpDir(sessionId, path),
        timeoutPromise,
      ])) as SftpEntry[];
      setSftpEntries(entries);
    } catch (error) {
      const message = formatError(error);
      setSftpError(message);
    } finally {
      setSftpLoading(false);
    }
  };

  useEffect(() => {
    if (!terminalRef.current) return;

    let disposed = false;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let unlistenOutput: (() => void) | null = null;
    let unlistenTheme: (() => void) | null = null;
    let unlistenFontSize: (() => void) | null = null;
    let unlistenFontFamily: (() => void) | null = null;
    let disposable: { dispose: () => void } | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let removeContextMenu: (() => void) | null = null;

    const fitAndResize = () => {
      if (!term || !fit) return;
      if (!paneRef.current) return;
      if (paneRef.current.offsetParent === null) return; // hidden (e.g. inactive tab)
      fit.fit();
      sshApi.resizePty(sessionId, term.cols, term.rows).catch(() => {});
    };

    const clipboardWrite = async (text: string) => {
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fallback for restricted clipboard environments.
      }

      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "true");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // ignore
      } finally {
        document.body.removeChild(ta);
      }
    };

    const clipboardRead = async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return "";
      }
    };

    const init = async () => {
      const store = await getAppSettingsStore();
      const themeName =
        (await store.get<TerminalThemeName>("terminal.theme")) ??
        DEFAULT_APP_SETTINGS["terminal.theme"];
      const fontSize =
        (await store.get<number>("terminal.fontSize")) ??
        DEFAULT_APP_SETTINGS["terminal.fontSize"];
      const fontFamily =
        (await store.get<string>("terminal.fontFamily")) ??
        DEFAULT_APP_SETTINGS["terminal.fontFamily"];

      if (disposed || !terminalRef.current) return;

      const xtermTheme = getXtermTheme(themeName);
      setXtermBg(xtermTheme.background);

      term = new Terminal({
        cursorBlink: true,
        fontSize,
        fontFamily,
        theme: xtermTheme,
        allowProposedApi: true,
        scrollback: 10000,
      });

      fit = new FitAddon();
      const webLinks = new WebLinksAddon();

      term.loadAddon(fit);
      term.loadAddon(webLinks);

      term.open(terminalRef.current);
      fit.fit();

      terminalInstance.current = term;
      fitAddon.current = fit;

      // Copy/paste integration:
      // - Cmd+C copies selection; otherwise it remains Ctrl+C (interrupt).
      // - Ctrl+Shift+C copies selection (Windows/Linux convention).
      // - Cmd+V / Ctrl+Shift+V pastes.
      term.attachCustomKeyEventHandler((ev) => {
        if (!term) return true;
        if (ev.type !== "keydown") return true;

        const key = ev.key.toLowerCase();
        const isCopy =
          (ev.ctrlKey && ev.shiftKey && key === "c") ||
          (ev.metaKey && !ev.shiftKey && key === "c");
        const isPaste =
          (ev.ctrlKey && ev.shiftKey && key === "v") ||
          (ev.metaKey && !ev.shiftKey && key === "v");

        if (isCopy) {
          if (!term.hasSelection()) return true;
          ev.preventDefault();
          ev.stopPropagation();
          void clipboardWrite(term.getSelection());
          return false;
        }

        if (isPaste) {
          ev.preventDefault();
          ev.stopPropagation();
          void clipboardRead().then((text) => {
            if (!term || disposed) return;
            if (!text) return;
            term.paste(text);
          });
          return false;
        }

        return true;
      });

      // Right click: copy if selection exists, otherwise paste.
      if (term.element) {
        const el = term.element;
        const onContextMenu = (ev: MouseEvent) => {
          if (!term) return;
          ev.preventDefault();
          ev.stopPropagation();

          if (term.hasSelection()) {
            void clipboardWrite(term.getSelection());
            return;
          }

          void clipboardRead().then((text) => {
            if (!term || disposed) return;
            if (!text) return;
            term.paste(text);
          });
        };

        el.addEventListener("contextmenu", onContextMenu);
        removeContextMenu = () => el.removeEventListener("contextmenu", onContextMenu);
      }

      void connectNow();

      // Listen for terminal output from backend
      const unlisten = await listen<{ session_id: string; data: string }>(
        "terminal-output",
        (event) => {
          if (!term) return;
          if (event.payload.session_id === sessionId) {
            term.write(event.payload.data);
          }
        },
      );
      unlistenOutput = unlisten;

      // Handle user input
      disposable = term.onData((data) => {
        sshApi.writeToShell(sessionId, data).catch((err) => {
          console.error("Error writing to shell:", err);
        });
      });

      // Handle terminal resize
      const handleResize = () => {
        fitAndResize();
      };
      window.addEventListener("resize", handleResize);

      resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        // Next tick: let layout settle before fitting.
        setTimeout(() => {
          fitAndResize();
        }, 0);
      });
      if (paneRef.current) {
        resizeObserver.observe(paneRef.current);
      }

      // Live-update appearance without reconnecting.
      unlistenTheme = await store.onKeyChange<TerminalThemeName>(
        "terminal.theme",
        (v) => {
          if (!term || disposed) return;
          const next = v ?? DEFAULT_APP_SETTINGS["terminal.theme"];
          const t = getXtermTheme(next);
          setXtermBg(t.background);
          term.options.theme = t;
          term.refresh(0, Math.max(0, term.rows - 1));
        },
      );
      unlistenFontSize = await store.onKeyChange<number>(
        "terminal.fontSize",
        (v) => {
          if (!term || disposed) return;
          const next = v ?? DEFAULT_APP_SETTINGS["terminal.fontSize"];
          term.options.fontSize = next;
          requestAnimationFrame(() => {
            fitAndResize();
          });
        },
      );
      unlistenFontFamily = await store.onKeyChange<string>(
        "terminal.fontFamily",
        (v) => {
          if (!term || disposed) return;
          const next = v ?? DEFAULT_APP_SETTINGS["terminal.fontFamily"];
          term.options.fontFamily = next;
          requestAnimationFrame(() => {
            fitAndResize();
          });
        },
      );

      // Initial resize (after fonts are applied)
      setTimeout(() => {
        fitAndResize();
      }, 100);

      return () => {
        window.removeEventListener("resize", handleResize);
      };
    };

    let cleanupResizeListener: (() => void) | undefined;
    void init().then((cleanup) => {
      cleanupResizeListener = cleanup;
    });

    // Cleanup
    return () => {
      disposed = true;
      cleanupResizeListener?.();
      resizeObserver?.disconnect();
      disposable?.dispose();
      unlistenTheme?.();
      unlistenFontSize?.();
      unlistenFontFamily?.();
      unlistenOutput?.();
      removeContextMenu?.();
      term?.dispose();
    };
  }, [sessionId]);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;

    const run = async () => {
      try {
        const info = await sshApi.checkEndpoint(host, port);
        if (disposed) return;
        setEndpointIp(info.ip);
        setLatencyMs(info.latency_ms);
      } catch {
        if (disposed) return;
        setLatencyMs(null);
      } finally {
        if (disposed) return;
        timer = window.setTimeout(run, 5000);
      }
    };

    run();

    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [host, port]);

  const statusIcon = useMemo(() => {
    if (connStatus === "connecting") return "material-symbols:sync-rounded";
    if (connStatus === "connected")
      return "material-symbols:check-circle-rounded";
    if (connStatus === "error") return "material-symbols:error-rounded";
    return "material-symbols:cloud-off-rounded";
  }, [connStatus]);

  const statusText = useMemo(() => {
    if (connStatus === "connecting") return "连接中…";
    if (connStatus === "connected") return "已连接";
    if (connStatus === "error") return "连接失败";
    return "未连接";
  }, [connStatus]);

  return (
    <div
      className="xterminal"
      style={
        xtermBg
          ? ({
              ["--xterminal-xterm-bg"]: xtermBg,
            } as CSSProperties)
          : undefined
      }
    >
      <div className="xterminal-topbar">
        <div className="xterminal-topbar-left" title={connError ?? undefined}>
          <span
            className={[
              "xterminal-topbar-status",
              connStatus === "connecting"
                ? "xterminal-topbar-status--spin"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-hidden="true"
          >
            <AppIcon icon={statusIcon} size={18} />
          </span>
          <span className="xterminal-topbar-text">
            {statusText}
            {connStatus === "error" && connError ? `：${connError}` : ""}
          </span>
        </div>

        <div className="xterminal-topbar-right">
          <span className="xterminal-topbar-meta">
            {host}:{port}
          </span>
          <button
            className={`xterminal-topbar-btn ${sftpOpen ? "xterminal-topbar-btn--active" : ""}`}
            type="button"
            onClick={() => {
              const nextOpen = !sftpOpen;
              setSftpOpen(nextOpen);
              if (nextOpen) {
                void loadSftpEntries();
              }
            }}
            title="打开 SFTP 文件列表"
          >
            <AppIcon icon="material-symbols:folder-open-rounded" size={18} />
            SFTP
          </button>
          {connStatus === "error" && (
            <button
              className="xterminal-topbar-btn"
              type="button"
              onClick={() => {
                void connectNow();
              }}
            >
              <AppIcon icon="material-symbols:refresh-rounded" size={18} />
              重新连接
            </button>
          )}
        </div>
      </div>

      <div className="xterminal-body">
        <div className="xterminal-pane" ref={paneRef}>
          <div className="xterminal-pad">
            <div className="xterminal-mount" ref={terminalRef} />
          </div>
          {sftpOpen && (
            <div className="xterminal-sftp">
              <div className="xterminal-sftp-header">
                <div className="xterminal-sftp-title">SFTP</div>
                <button
                  type="button"
                  className="xterminal-sftp-refresh"
                  onClick={() => void loadSftpEntries()}
                  disabled={sftpLoading}
                  title="刷新"
                >
                  <AppIcon icon="material-symbols:refresh-rounded" size={16} />
                </button>
              </div>
              <div className="xterminal-sftp-path">
                <input
                  type="text"
                  value={sftpPath}
                  onChange={(event) => setSftpPath(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void loadSftpEntries();
                    }
                  }}
                  placeholder="路径，例如 /var/log"
                />
              </div>
              <div className="xterminal-sftp-body">
                {sftpLoading && (
                  <div className="xterminal-sftp-state">加载中…</div>
                )}
                {!sftpLoading && sftpError && (
                  <div className="xterminal-sftp-state xterminal-sftp-state--error">
                    {sftpError}
                  </div>
                )}
                {!sftpLoading && !sftpError && sftpEntries.length === 0 && (
                  <div className="xterminal-sftp-state">空目录</div>
                )}
                {!sftpLoading && !sftpError && sftpEntries.length > 0 && (
                  <ul className="xterminal-sftp-list">
                    {sftpEntries.map((entry) => (
                      <li key={entry.name} className="xterminal-sftp-item">
                        <span className="xterminal-sftp-icon" aria-hidden="true">
                          <AppIcon
                            icon={
                              entry.is_dir
                                ? "material-symbols:folder-rounded"
                                : "material-symbols:description-rounded"
                            }
                            size={16}
                          />
                        </span>
                        <span className="xterminal-sftp-name">{entry.name}</span>
                        {typeof entry.size === "number" && !entry.is_dir && (
                          <span className="xterminal-sftp-meta">
                            {entry.size.toLocaleString()} B
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="xterminal-toolbar">
          <div className="xterminal-toolbar-item">
            <AppIcon icon="material-symbols:speed-rounded" size={16} />
            <span className="xterminal-toolbar-label">延迟</span>
            <span
              className={`xterminal-toolbar-value xterminal-latency xterminal-latency--${latencyTone}`}
            >
              {latencyMs === null ? "--" : `${latencyMs} ms`}
            </span>
          </div>

          <span className="xterminal-toolbar-dot" aria-hidden="true" />

          <div
            className="xterminal-toolbar-item"
            style={{ flex: 1, minWidth: 0 }}
          >
            <AppIcon icon="material-symbols:lan" size={16} />
            <span className="xterminal-toolbar-label">服务器 IP</span>
            <span className="xterminal-toolbar-value">{endpointLabel}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
