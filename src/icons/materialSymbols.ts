import { addCollection } from "@iconify/react";
import materialSymbols from "@iconify-json/material-symbols/icons.json";
import simpleIcons from "@iconify-json/simple-icons/icons.json";

const pickIcons = (
  collection: {
    icons: Record<string, unknown>;
    prefix: string;
    width?: number;
    height?: number;
    aliases?: Record<string, unknown>;
  },
  names: string[],
) => ({
  prefix: collection.prefix,
  width: collection.width,
  height: collection.height,
  icons: Object.fromEntries(
    names
      .map((name) => [name, collection.icons[name]] as const)
      .filter((entry) => Boolean(entry[1])),
  ),
  aliases: collection.aliases,
});

addCollection(
  pickIcons(materialSymbols as any, [
    "add-rounded",
    "analytics-rounded",
    "arrow-back-rounded",
    "article-outline-rounded",
    "check-circle-outline-rounded",
    "check-circle-rounded",
    "chevron-left-rounded",
    "chevron-right-rounded",
    "close-rounded",
    "close-small-rounded",
    "code-rounded",
    "content-copy-outline-rounded",
    "content-copy-rounded",
    "create-new-folder-outline-rounded",
    "create-new-folder-rounded",
    "delete-outline-rounded",
    "delete-rounded",
    "description-rounded",
    "dns",
    "download-rounded",
    "edit-outline-rounded",
    "edit-rounded",
    "edit-square-outline-rounded",
    "error-outline-rounded",
    "error-rounded",
    "expand-less-rounded",
    "expand-more-rounded",
    "folder-open-rounded",
    "folder-rounded",
    "folder-special-outline-rounded",
    "forward-rounded",
    "info-outline-rounded",
    "key-rounded",
    "key-vertical-rounded",
    "keyboard-arrow-down-rounded",
    "keyboard-arrow-up-rounded",
    "keyboard-return-rounded",
    "lock-person-outline-rounded",
    "more-horiz",
    "note-add-rounded",
    "notifications-rounded",
    "open-in-new-rounded",
    "pause-rounded",
    "play-arrow-rounded",
    "refresh",
    "refresh-rounded",
    "save-rounded",
    "search-rounded",
    "security",
    "settings-rounded",
    "settop-component-outline-rounded",
    "smart-toy-rounded",
    "stop-circle-outline-rounded",
    "tab-rounded",
    "table-view-rounded",
    "terminal-rounded",
    "tips-and-updates-outline-rounded",
    "upload-rounded",
    "visibility-off-rounded",
    "visibility-rounded",
  ]) as any,
);

addCollection(
  pickIcons(simpleIcons as any, ["linux", "macos", "windows"]) as any,
);
