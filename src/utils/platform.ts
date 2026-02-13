export const isMacPlatform = () => {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
};

export const getModifierKeyLabel = () => (isMacPlatform() ? "⌘" : "Ctrl");

export const getModifierKeyName = () => (isMacPlatform() ? "Command" : "Ctrl");

export const getModifierKeyAbbr = () => (isMacPlatform() ? "Cmd" : "Ctrl");
