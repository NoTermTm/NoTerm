import { isTauri } from "@tauri-apps/api/core";
import {
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from "@tauri-apps/api/menu";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import {
  availableMonitors,
  getCurrentWindow,
  primaryMonitor,
} from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isMacPlatform } from "./platform";

const WINDOW_STATE_KEY = "noterm.window-state.v1";

type SavedWindowState = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const dispatchDesktopCommand = (name: string) => {
  window.dispatchEvent(new CustomEvent(`noterm:${name}`));
};

export async function openNativeSettingsWindow() {
  const existing = await WebviewWindow.getByLabel("settings");
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }

  new WebviewWindow("settings", {
    url: "?view=settings",
    title: navigator.language.toLowerCase().startsWith("zh") ? "设置" : "Settings",
    width: 760,
    height: 720,
    minWidth: 640,
    minHeight: 520,
    center: true,
    decorations: true,
    titleBarStyle: "visible",
  });
}

async function installMacMenu() {
  if (!isMacPlatform()) return;

  const isChinese = navigator.language.toLowerCase().startsWith("zh");

  const separator = () =>
    PredefinedMenuItem.new({ item: "Separator" });
  const appMenu = await Submenu.new({
    text: "NoTerm",
    items: [
      await PredefinedMenuItem.new({ item: { About: null }, text: "About NoTerm" }),
      await separator(),
      await MenuItem.new({
        id: "settings",
        text: isChinese ? "设置…" : "Settings…",
        accelerator: "CmdOrCtrl+,",
        action: () => void openNativeSettingsWindow(),
      }),
      await separator(),
      await PredefinedMenuItem.new({ item: "Services" }),
      await separator(),
      await PredefinedMenuItem.new({ item: "Hide", text: "Hide NoTerm" }),
      await PredefinedMenuItem.new({ item: "HideOthers" }),
      await PredefinedMenuItem.new({ item: "ShowAll" }),
      await separator(),
      await PredefinedMenuItem.new({ item: "Quit", text: "Quit NoTerm" }),
    ],
  });

  const fileMenu = await Submenu.new({
    text: isChinese ? "文件" : "File",
    items: [
      await MenuItem.new({
        id: "new-session",
        text: isChinese ? "新建会话" : "New Session",
        accelerator: "CmdOrCtrl+T",
        action: () => dispatchDesktopCommand("new-session"),
      }),
      await PredefinedMenuItem.new({ item: "CloseWindow" }),
    ],
  });

  const editMenu = await Submenu.new({
    text: isChinese ? "编辑" : "Edit",
    items: [
      await PredefinedMenuItem.new({ item: "Undo" }),
      await PredefinedMenuItem.new({ item: "Redo" }),
      await separator(),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
      await PredefinedMenuItem.new({ item: "Paste" }),
      await PredefinedMenuItem.new({ item: "SelectAll" }),
    ],
  });

  const windowMenu = await Submenu.new({
    text: isChinese ? "窗口" : "Window",
    items: [
      await PredefinedMenuItem.new({ item: "Minimize" }),
      await PredefinedMenuItem.new({ item: "Maximize", text: "Zoom" }),
      await PredefinedMenuItem.new({ item: "Fullscreen", text: "Enter Full Screen" }),
    ],
  });

  await windowMenu.setAsWindowsMenuForNSApp();
  const menu = await Menu.new({ items: [appMenu, fileMenu, editMenu, windowMenu] });
  await menu.setAsAppMenu();
}

function readWindowState(): SavedWindowState | null {
  try {
    const raw = localStorage.getItem(WINDOW_STATE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SavedWindowState>;
    if (![value.x, value.y, value.width, value.height].every(Number.isFinite)) return null;
    return value as SavedWindowState;
  } catch {
    return null;
  }
}

async function installWindowStatePersistence() {
  const appWindow = getCurrentWindow();
  const saved = readWindowState();

  if (saved) {
    const monitors = await availableMonitors();
    const fallback = (await primaryMonitor()) ?? monitors[0];
    const centerX = saved.x + saved.width / 2;
    const centerY = saved.y + saved.height / 2;
    const monitor =
      monitors.find(({ position, size }) =>
        centerX >= position.x &&
        centerX < position.x + size.width &&
        centerY >= position.y &&
        centerY < position.y + size.height,
      ) ?? fallback;

    if (monitor) {
      const { position, size } = monitor.workArea;
      const width = Math.min(Math.max(saved.width, 600), size.width);
      const height = Math.min(Math.max(saved.height, 600), size.height);
      const x = Math.min(
        Math.max(saved.x, position.x),
        position.x + size.width - width,
      );
      const y = Math.min(
        Math.max(saved.y, position.y),
        position.y + size.height - height,
      );
      await appWindow.setSize(new PhysicalSize(width, height));
      await appWindow.setPosition(new PhysicalPosition(x, y));
    }
  }

  let timer: number | undefined;
  const persist = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      if ((await appWindow.isFullscreen()) || (await appWindow.isMaximized())) return;
      const [position, size] = await Promise.all([
        appWindow.outerPosition(),
        appWindow.outerSize(),
      ]);
      localStorage.setItem(
        WINDOW_STATE_KEY,
        JSON.stringify({ x: position.x, y: position.y, width: size.width, height: size.height }),
      );
    }, 180);
  };

  await Promise.all([appWindow.onMoved(persist), appWindow.onResized(persist)]);
}

export function installNativeDesktopIntegration() {
  document.documentElement.dataset.platform = isMacPlatform() ? "macos" : "other";
  if (!isTauri()) return;
  if (getCurrentWindow().label !== "main") return;

  void installMacMenu().catch((error) => {
    console.error("Failed to install the native application menu", error);
  });
  void installWindowStatePersistence().catch((error) => {
    console.error("Failed to restore window state", error);
  });
}
