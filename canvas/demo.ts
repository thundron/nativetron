import { setSink, frame } from "./encode.js";
import {
  clearRect, fillStyle, fillRect, strokeStyle, lineWidth, beginPath, moveTo, lineTo,
  stroke, arc, fill, save, restore, translate, rotate, font, fillText, globalAlpha,
} from "./canvas.generated.js";

declare function present(b: Uint8Array): void;

export function draw(t: number): number {
  setSink((b: Uint8Array) => { present(b); });
  clearRect(0, 0, 640, 480);
  fillStyle("#101418");
  fillRect(0, 0, 640, 480);

  fillStyle("#3aa9ff");
  for (let i = 0; i < 24; i++) {
    const a = t * 0.01 + i * 0.26;
    const r = 60 + 90 * Math.sin(a * 0.7);
    const x = 320 + r * Math.cos(a);
    const y = 240 + r * Math.sin(a);
    fillRect(x - 4, y - 4, 8, 8);
  }

  strokeStyle("#ff6b6b");
  lineWidth(2);
  beginPath();
  moveTo(40, 440);
  for (let i = 1; i < 60; i++) {
    moveTo(40 + (i - 1) * 10, 440 - 60 * Math.sin((i - 1) * 0.2 + t * 0.02));
    lineTo(40 + i * 10, 440 - 60 * Math.sin(i * 0.2 + t * 0.02));
  }
  stroke();

  save();
  translate(320, 240);
  rotate(t * 0.02);
  globalAlpha(0.6);
  fillStyle("#ffd166");
  beginPath();
  arc(0, 0, 40, 0, Math.PI * 2);
  fill();
  restore();

  globalAlpha(1);
  fillStyle("#e6e6e6");
  font("16px monospace");
  fillText("compiled canvas", 20, 30);

  frame();
  return 1;
}

export function drawMany(n: number): number {
  setSink((b: Uint8Array) => { present(b); });
  clearRect(0, 0, 640, 480);
  fillStyle("#2b6cb0");
  for (let i = 0; i < n; i++) {
    const x = (i * 37) % 620;
    const y = (i * 53) % 460;
    fillRect(x, y, 6, 6);
  }
  frame();
  return n;
}
