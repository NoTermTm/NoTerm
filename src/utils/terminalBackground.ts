import { appLocalDataDir, join, BaseDirectory } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";

export const TERMINAL_BG_DIR = "terminal-bg";

const DATA_PREFIXES = ["data:", "blob:", "http:", "https:"];
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const isDataLike = (value: string) =>
  DATA_PREFIXES.some((prefix) => value.startsWith(prefix));

export async function resolveTerminalBackgroundUrl(value: string) {
  if (!value) return "";
  if (isDataLike(value)) return value;
  try {
    const baseDir = await appLocalDataDir();
    const absPath = await join(baseDir, value);
    return convertFileSrc(absPath);
  } catch {
    return value;
  }
}

export async function loadTerminalBackgroundUrl(value: string) {
  if (!value) return "";
  if (isDataLike(value)) return value;
  const ext = value.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME_BY_EXT[ext] ?? "image/png";
  try {
    const bytes = await readFile(value, { baseDir: BaseDirectory.AppLocalData });
    const blob = new Blob([bytes], { type: mime });
    return URL.createObjectURL(blob);
  } catch {
    try {
      const baseDir = await appLocalDataDir();
      const absPath = await join(baseDir, value);
      const bytes = await readFile(absPath);
      const blob = new Blob([bytes], { type: mime });
      return URL.createObjectURL(blob);
    } catch {
      return resolveTerminalBackgroundUrl(value);
    }
  }
}
