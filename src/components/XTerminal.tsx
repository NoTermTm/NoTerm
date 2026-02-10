import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { listen } from '@tauri-apps/api/event';
import { sshApi } from '../api/ssh';
import '@xterm/xterm/css/xterm.css';

interface XTerminalProps {
  sessionId: string;
}

export function XTerminal({ sessionId }: XTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Initialize terminal
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SF Mono", Monaco, Menlo, "Ubuntu Mono", monospace',
      theme: {
        background: '#ffffff',
        foreground: '#2c2c2c',
        cursor: '#007acc',
        cursorAccent: '#ffffff',
        black: '#2c2c2c',
        red: '#e51400',
        green: '#16825d',
        yellow: '#ca5010',
        blue: '#007acc',
        magenta: '#881798',
        cyan: '#3a96dd',
        white: '#e5e5e5',
        brightBlack: '#6b6b6b',
        brightRed: '#ff6347',
        brightGreen: '#4ec9b0',
        brightYellow: '#f9a825',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#f5f5f5',
      },
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    const webLinks = new WebLinksAddon();

    term.loadAddon(fit);
    term.loadAddon(webLinks);

    term.open(terminalRef.current);
    fit.fit();

    terminalInstance.current = term;
    fitAddon.current = fit;

    // Listen for terminal output from backend
    const unlistenPromise = listen<{ session_id: string; data: string }>(
      'terminal-output',
      (event) => {
        if (event.payload.session_id === sessionId) {
          term.write(event.payload.data);
        }
      }
    );

    // Handle user input
    const disposable = term.onData((data) => {
      sshApi.writeToShell(sessionId, data).catch((err) => {
        console.error('Error writing to shell:', err);
      });
    });

    // Handle terminal resize
    const handleResize = () => {
      fit.fit();
      sshApi.resizePty(sessionId, term.cols, term.rows).catch((err) => {
        console.error('Error resizing PTY:', err);
      });
    };

    window.addEventListener('resize', handleResize);

    // Initial resize
    setTimeout(() => {
      fit.fit();
      sshApi.resizePty(sessionId, term.cols, term.rows).catch(() => {});
    }, 100);

    // Cleanup
    return () => {
      window.removeEventListener('resize', handleResize);
      disposable.dispose();
      unlistenPromise.then((unlisten) => unlisten());
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: '#ffffff',
      }}
    >
      <div
        ref={terminalRef}
        style={{
          width: '100%',
          height: '100%',
          padding: '12px',
        }}
      />
    </div>
  );
}
