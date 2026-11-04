// generated from commands/keys.json by commands/generate.mjs — do not edit
export const PALETTE_SHORTCUTS = ["Meta+k","Control+k"];
export function parseShortcut(value) {
  const parts = value.split("+");
  let modifiers = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    let bit = 0;
    if (part === "Alt") bit = 1;
    if (part === "Control") bit = 2;
    if (part === "Meta") bit = 4;
    if (part === "Shift") bit = 8;
    if (!bit || (modifiers & bit)) throw new Error("invalid shortcut modifier: " + value);
    modifiers |= bit;
  }
  const key = parts[parts.length - 1];
  if (!/^[a-zA-Z0-9]$/.test(key) && !["Enter","Escape","ArrowUp","ArrowDown","Delete","Backspace","Tab","F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"].includes(key)) throw new Error("invalid shortcut key: " + value);
  return { key: key.toLowerCase(), modifiers };
}
