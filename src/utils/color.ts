const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const parseHexChannel = (value: string) => Number.parseInt(value, 16);

const normalizeHex = (input: string) => {
  const hex = input.trim().replace("#", "");
  if (hex.length === 3) {
    return hex
      .split("")
      .map((ch) => `${ch}${ch}`)
      .join("");
  }
  if (hex.length === 6) {
    return hex;
  }
  return null;
};

export function toRgba(color: string, alpha: number) {
  const safeAlpha = clamp(alpha);
  if (!color) return `rgba(0, 0, 0, ${safeAlpha})`;

  const hex = normalizeHex(color);
  if (hex) {
    const r = parseHexChannel(hex.slice(0, 2));
    const g = parseHexChannel(hex.slice(2, 4));
    const b = parseHexChannel(hex.slice(4, 6));
    return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
  }

  const rgbMatch = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(",").map((part) => part.trim());
    if (parts.length >= 3) {
      const r = Number.parseFloat(parts[0]);
      const g = Number.parseFloat(parts[1]);
      const b = Number.parseFloat(parts[2]);
      if ([r, g, b].every((v) => Number.isFinite(v))) {
        return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
      }
    }
  }

  return `rgba(0, 0, 0, ${safeAlpha})`;
}
