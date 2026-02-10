import type { ITheme } from "@xterm/xterm";
import type { TerminalThemeName } from "../store/appSettings";

// Keep theme palettes in one place so Settings and terminal stay in sync.
export const TERMINAL_THEME_OPTIONS: Array<{
  value: TerminalThemeName;
  label: string;
}> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "monokai", label: "Monokai" },
  { value: "solarized", label: "Solarized" },
];

export function getXtermTheme(name: TerminalThemeName): ITheme {
  switch (name) {
    case "dark":
      return {
        background: "#0f111a",
        foreground: "#d6deeb",
        cursor: "#ffd166",
        cursorAccent: "#0f111a",
        selectionBackground: "rgba(255, 209, 102, 0.25)",
        black: "#1f2330",
        red: "#ff5c57",
        green: "#4cc38a",
        yellow: "#ffd166",
        blue: "#5cc8ff",
        magenta: "#c792ea",
        cyan: "#5fdbff",
        white: "#d6deeb",
        brightBlack: "#3a3f4b",
        brightRed: "#ff7b72",
        brightGreen: "#6ee7b7",
        brightYellow: "#ffe08a",
        brightBlue: "#7dd3fc",
        brightMagenta: "#e9d5ff",
        brightCyan: "#99f6e4",
        brightWhite: "#ffffff",
      };
    case "monokai":
      return {
        background: "#272822",
        foreground: "#f8f8f2",
        cursor: "#ffd866",
        cursorAccent: "#272822",
        selectionBackground: "rgba(248, 248, 242, 0.18)",
        black: "#272822",
        red: "#ff6188",
        green: "#a9dc76",
        yellow: "#ffd866",
        blue: "#78dce8",
        magenta: "#ab9df2",
        cyan: "#78dce8",
        white: "#f8f8f2",
        brightBlack: "#75715e",
        brightRed: "#ff6188",
        brightGreen: "#a9dc76",
        brightYellow: "#ffd866",
        brightBlue: "#78dce8",
        brightMagenta: "#ab9df2",
        brightCyan: "#78dce8",
        brightWhite: "#ffffff",
      };
    case "solarized":
      // Solarized Dark
      return {
        background: "#002b36",
        foreground: "#93a1a1",
        cursor: "#b58900",
        cursorAccent: "#002b36",
        selectionBackground: "rgba(147, 161, 161, 0.22)",
        black: "#073642",
        red: "#dc322f",
        green: "#859900",
        yellow: "#b58900",
        blue: "#268bd2",
        magenta: "#d33682",
        cyan: "#2aa198",
        white: "#eee8d5",
        brightBlack: "#586e75",
        brightRed: "#cb4b16",
        brightGreen: "#586e75",
        brightYellow: "#657b83",
        brightBlue: "#839496",
        brightMagenta: "#6c71c4",
        brightCyan: "#93a1a1",
        brightWhite: "#fdf6e3",
      };
    case "light":
    default:
      // Friendly light theme aligned with app tokens.
      return {
        background: "#f1f2f5",
        foreground: "#2c2c2c",
        cursor: "#0f8fff",
        cursorAccent: "#ffffff",
        selectionBackground: "rgba(15, 143, 255, 0.18)",
        black: "#2c2c2c",
        red: "#e51400",
        green: "#16825d",
        yellow: "#ca5010",
        blue: "#0f8fff",
        magenta: "#881798",
        cyan: "#3a96dd",
        white: "#e5e5e5",
        brightBlack: "#6b6b6b",
        brightRed: "#ff6347",
        brightGreen: "#4ec9b0",
        brightYellow: "#f9a825",
        brightBlue: "#3b8eea",
        brightMagenta: "#d670d6",
        brightCyan: "#29b8db",
        brightWhite: "#f5f5f5",
      };
  }
}

