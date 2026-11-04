import { signal } from "../framework/reactive.js";
import { catalogueMessage } from "./messages.generated.js";
import { LOCALES, UNITS, MAX_FORMATTED_BYTES } from "./contract.generated.js";
import { type MessageArg } from "./values.js";
export { textArgument, numberArgument, type MessageArg } from "./values.js";

const activeLocale = signal("en");
export const locale = { get: (): string => activeLocale.get() };
type Formatter = (value: number, locale: string, unit: string, maximumFractionDigits: number, output: Uint8Array) => number;
let formatter: Formatter = (_value: number, _locale: string, _unit: string, _digits: number, _output: Uint8Array): number => {
  throw new Error("locale formatter is not installed");
};

export function setLocale(value: string): void {
  if (!LOCALES.includes(value)) throw new Error("unsupported locale: " + value);
  activeLocale.set(value);
}

export function setLocaleFormatter(value: Formatter): void { formatter = value; }

function format(value: number, unit: string, digits: number): string {
  if (!Number.isFinite(value) || !Number.isInteger(digits) || digits < 0 || digits > 20) throw new Error("invalid number formatting options");
  const output = new Uint8Array(MAX_FORMATTED_BYTES);
  const length = formatter(value, locale.get(), unit, digits, output);
  if (!Number.isInteger(length) || length < 0 || length > output.length) throw new Error("locale formatter output overflow");
  return Buffer.from(output.subarray(0, length)).toString("utf8");
}
export function formatNumber(value: number, maximumFractionDigits: number = 3): string { return format(value, "", maximumFractionDigits); }
export function formatUnit(value: number, unit: string, maximumFractionDigits: number = 3): string {
  if (!UNITS.includes(unit)) throw new Error("unsupported unit: " + unit);
  return format(value, unit, maximumFractionDigits);
}
export function message(key: string, args: MessageArg[] = []): string {
  locale.get();
  return catalogueMessage(key, args, (value: number) => formatNumber(value));
}
