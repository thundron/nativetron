// generated from canvas/ops.json by canvas/generate.mjs — do not edit
import { f32, u32, str, iref, u8 } from "./encode.js";

export function save(): void {
  u8(1); 
}
export function restore(): void {
  u8(2); 
}
export function translate(x: number, y: number): void {
  u8(3); f32(x); f32(y);
}
export function rotate(angle: number): void {
  u8(4); f32(angle);
}
export function scale(x: number, y: number): void {
  u8(5); f32(x); f32(y);
}
export function fillRect(x: number, y: number, w: number, h: number): void {
  u8(6); f32(x); f32(y); f32(w); f32(h);
}
export function strokeRect(x: number, y: number, w: number, h: number): void {
  u8(7); f32(x); f32(y); f32(w); f32(h);
}
export function clearRect(x: number, y: number, w: number, h: number): void {
  u8(8); f32(x); f32(y); f32(w); f32(h);
}
export function beginPath(): void {
  u8(9); 
}
export function moveTo(x: number, y: number): void {
  u8(10); f32(x); f32(y);
}
export function lineTo(x: number, y: number): void {
  u8(11); f32(x); f32(y);
}
export function arc(x: number, y: number, r: number, a0: number, a1: number): void {
  u8(12); f32(x); f32(y); f32(r); f32(a0); f32(a1);
}
export function closePath(): void {
  u8(13); 
}
export function fill(): void {
  u8(14); 
}
export function stroke(): void {
  u8(15); 
}
export function fillStyle(style: string): void {
  const i_style = iref(style);
  u8(16); u32(i_style);
}
export function strokeStyle(style: string): void {
  const i_style = iref(style);
  u8(17); u32(i_style);
}
export function lineWidth(w: number): void {
  u8(18); f32(w);
}
export function font(font: string): void {
  const i_font = iref(font);
  u8(19); u32(i_font);
}
export function fillText(text: string, x: number, y: number): void {
  u8(20); str(text); f32(x); f32(y);
}
export function globalAlpha(a: number): void {
  u8(21); f32(a);
}
