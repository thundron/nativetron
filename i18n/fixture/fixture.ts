// Compiled i18n fixture for Wasm reactor and native static-library builds (library mode: no promises,
// timers or outbound FFI; formatting arrives through the scalar pull callbacks).
import { effect, signal } from "../../framework/reactive.js";
import { message, numberArgument, textArgument, locale, setLocale, setLocaleFormatter, pullLocaleFormatter, formatNumber, formatUnit, hasMessage, pluralCategoryOf, supportedLocales } from "../index.js";

declare function rendered(text: string): void;
declare function reply(text: string): void;
declare function localeFormatBegin(value: number, locale: string, unit: string, digits: number, capacity: number): number;
declare function localeFormatByte(index: number): number;

const count = signal(1);
let stop: (() => void) | null = null;

function errorText(error: unknown): string {
  return "error: " + (error instanceof Error ? error.message : "unknown");
}

export function start(): number {
  setLocaleFormatter(pullLocaleFormatter(
    (value: number, tag: string, unit: string, digits: number, capacity: number) => localeFormatBegin(value, tag, unit, digits, capacity),
    (index: number) => localeFormatByte(index),
  ));
  if (stop !== null) return 0;
  stop = effect(() => {
    rendered(locale.get() + " | " + message("commands.title") + " | " + message("items.count", [numberArgument("count", count.get())]) + " | " + message("greeting", [textArgument("name", "Ada")]) + " | " + formatUnit(1234.5, "meter", 1));
  });
  return supportedLocales().length;
}

export function stopRendering(): number {
  if (stop === null) return 0;
  stop();
  stop = null;
  return 1;
}

export function switchLocale(tag: string): number {
  reply(answerSwitchLocale(tag));
  return 1;
}

function answerSwitchLocale(tag: string): string {
  try { setLocale(tag); return "ok " + locale.get(); } catch (error) { return errorText(error); }
}

export function setCount(value: number): number {
  count.set(value);
  return value;
}

export function plural(value: number): number {
  reply(answerPlural(value));
  return 1;
}

function answerPlural(value: number): string {
  try { return pluralCategoryOf(value); } catch (error) { return errorText(error); }
}

export function itemCount(value: number): number {
  reply(answerItemCount(value));
  return 1;
}

function answerItemCount(value: number): string {
  try { return message("items.count", [numberArgument("count", value)]); } catch (error) { return errorText(error); }
}

export function lookup(key: string): number {
  reply(answerLookup(key));
  return 1;
}

function answerLookup(key: string): string {
  try { return hasMessage(key) ? message(key) : "absent"; } catch (error) { return errorText(error); }
}

export function wrongArgument(): number {
  reply(answerWrongArgument());
  return 1;
}

function answerWrongArgument(): string {
  try { return message("items.count", [textArgument("count", "3")]); } catch (error) { return errorText(error); }
}

export function format(value: number, unit: string, digits: number): number {
  reply(answerFormat(value, unit, digits));
  return 1;
}

function answerFormat(value: number, unit: string, digits: number): string {
  try { return unit === "" ? formatNumber(value, digits) : formatUnit(value, unit, digits); } catch (error) { return errorText(error); }
}
