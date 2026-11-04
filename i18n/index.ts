import { signal } from "../framework/reactive.js";
import { catalogueMessage, catalogueHas, pluralCategory } from "./messages.generated.js";
import { LOCALES, SOURCE_LOCALE, UNITS, MAX_FORMATTED_BYTES } from "./contract.generated.js";
import { type MessageArg } from "./values.js";
export { textArgument, numberArgument, type MessageArg } from "./values.js";

const activeLocale = signal(SOURCE_LOCALE);
let currentLocale = SOURCE_LOCALE; // untracked mirror, so setLocale inside an effect subscribes to nothing
export const locale = { get: (): string => activeLocale.get() };

// Synchronous bounded formatter: writes UTF-8 into output[0..length) and returns length, or returns
// FORMAT_OVERFLOW / FORMAT_UNSUPPORTED. It must not call back into i18n formatting.
export type LocaleFormatter = (value: number, locale: string, unit: string, maximumFractionDigits: number, output: Uint8Array) => number;
export const FORMAT_OVERFLOW = -1;
export const FORMAT_UNSUPPORTED = -2;

let formatter: LocaleFormatter = (_value: number, _locale: string, _unit: string, _digits: number, _output: Uint8Array): number => {
  throw new Error("locale formatter is not installed");
};
let formatting = false;
const formatOutput = new Uint8Array(MAX_FORMATTED_BYTES);

export function supportedLocales(): string[] { return LOCALES.slice(); }

export function setLocale(value: string): void {
  if (!LOCALES.includes(value)) throw new Error("unsupported locale: " + value);
  if (currentLocale === value) return;
  currentLocale = value;
  activeLocale.set(value);
}

export function setLocaleFormatter(value: LocaleFormatter): void {
  if (formatting) throw new Error("locale formatter cannot be replaced while formatting");
  formatter = value;
}

// Builds a formatter from two scalar-only host callbacks, for embeddings (static libraries, Wasm reactors)
// whose callback byte parameters are read-only borrows: `begin` formats into host-owned staging storage and
// returns its byte length (or a negative FORMAT_* code); `byteAt(index)` returns each staged byte.
export function pullLocaleFormatter(
  begin: (value: number, locale: string, unit: string, maximumFractionDigits: number, capacity: number) => number,
  byteAt: (index: number) => number,
): LocaleFormatter {
  return (value: number, tag: string, unit: string, digits: number, output: Uint8Array): number => {
    const length = begin(value, tag, unit, digits, output.length);
    if (length === FORMAT_OVERFLOW || length === FORMAT_UNSUPPORTED) return length;
    if (!Number.isInteger(length) || length < 0 || length > output.length) throw new Error("locale formatter returned an invalid length");
    for (let i = 0; i < length; i++) {
      const byte = byteAt(i);
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error("locale formatter returned an invalid byte");
      output[i] = byte;
    }
    return length;
  };
}

// Strict UTF-8 validation (no overlongs, surrogates or values above U+10FFFF).
function validUtf8(bytes: Uint8Array, length: number): boolean {
  let i = 0;
  while (i < length) {
    const lead = bytes[i]!;
    if (lead < 0x80) { i++; continue; }
    let need = 0, low = 0x80, high = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) need = 1;
    else if (lead >= 0xe0 && lead <= 0xef) { need = 2; if (lead === 0xe0) low = 0xa0; if (lead === 0xed) high = 0x9f; }
    else if (lead >= 0xf0 && lead <= 0xf4) { need = 3; if (lead === 0xf0) low = 0x90; if (lead === 0xf4) high = 0x8f; }
    else return false;
    if (i + need >= length) return false;
    for (let k = 1; k <= need; k++) {
      const byte = bytes[i + k]!;
      if (byte < (k === 1 ? low : 0x80) || byte > (k === 1 ? high : 0xbf)) return false;
    }
    i += need + 1;
  }
  return true;
}

function format(value: number, unit: string, digits: number): string {
  if (!Number.isFinite(value) || !Number.isInteger(digits) || digits < 0 || digits > 20) throw new Error("invalid number formatting options");
  if (formatting) throw new Error("locale formatter reentered i18n formatting");
  formatting = true;
  let length = 0;
  try {
    length = formatter(value, locale.get(), unit, digits, formatOutput);
  } finally {
    formatting = false;
  }
  if (length === FORMAT_OVERFLOW) throw new Error("locale formatter output overflow");
  if (length === FORMAT_UNSUPPORTED) throw new Error("locale formatter does not support " + locale.get() + (unit ? " " + unit : ""));
  if (!Number.isInteger(length) || length < 0 || length > formatOutput.length) throw new Error("locale formatter returned an invalid length");
  if (!validUtf8(formatOutput, length)) throw new Error("locale formatter returned invalid UTF-8");
  return Buffer.from(formatOutput.subarray(0, length)).toString("utf8");
}
export function formatNumber(value: number, maximumFractionDigits: number = 3): string { return format(value, "", maximumFractionDigits); }
export function formatUnit(value: number, unit: string, maximumFractionDigits: number = 3): string {
  if (!UNITS.includes(unit)) throw new Error("unsupported unit: " + unit);
  return format(value, unit, maximumFractionDigits);
}
export function hasMessage(key: string): boolean { return catalogueHas(key); }
// CLDR cardinal category of value, as displayed by message formatting, for the active locale.
export function pluralCategoryOf(value: number): string { return pluralCategory(locale.get(), value); }
export function message(key: string, args: MessageArg[] = []): string {
  return catalogueMessage(locale.get(), key, args, (value: number) => formatNumber(value));
}
