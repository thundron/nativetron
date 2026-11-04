// CLDR plural operands of a number as message formatting displays it. Like ICU's number formatting, the
// decimal value is the shortest round-trip representation of the double (Number.prototype.toString), which
// is then rounded half-away-from-zero (Intl's default halfExpand) to `fractionDigits` in standard notation
// with trailing fraction zeros removed. Visible fraction digits are therefore v = w and f = t, and the compact
// exponent operands e = c = 0. `iDigits`/`fDigits` keep the exact decimal digits for modulo operations.
export interface PluralOperands { i: number; v: number; f: number; iDigits: string; fDigits: string; }

function zeros(count: number): string {
  let text = "";
  for (let k = 0; k < count; k++) text += "0";
  return text;
}

export function pluralOperands(value: number, fractionDigits: number): PluralOperands {
  if (!Number.isFinite(value)) throw new Error("plural operand must be finite");
  const text = String(Math.abs(value));
  let mantissa = text;
  let exponent = 0;
  const e = text.indexOf("e");
  if (e >= 0) {
    mantissa = text.slice(0, e);
    exponent = Number(text.slice(e + 1));
  }
  const dot = mantissa.indexOf(".");
  let digits = dot < 0 ? mantissa : mantissa.slice(0, dot) + mantissa.slice(dot + 1);
  let point = (dot < 0 ? mantissa.length : dot) + exponent; // count of integer digits in `digits`
  if (point <= 0) { digits = zeros(1 - point) + digits; point = 1; }
  if (point > digits.length) digits = digits + zeros(point - digits.length);
  const keep = point + fractionDigits;
  if (digits.length > keep) {
    const up = digits.charCodeAt(keep) >= 53; // first dropped digit >= "5": halfExpand on the decimal value
    digits = digits.slice(0, keep);
    if (up) {
      let k = digits.length - 1;
      let tail = "";
      while (k >= 0 && digits.charCodeAt(k) === 57) { tail += "0"; k--; }
      if (k < 0) { digits = "1" + tail; point++; }
      else digits = digits.slice(0, k) + String.fromCharCode(digits.charCodeAt(k) + 1) + tail;
    }
  }
  let integer = digits.slice(0, point);
  let start = 0;
  while (start < integer.length - 1 && integer.charCodeAt(start) === 48) start++;
  integer = integer.slice(start);
  let fraction = digits.slice(point);
  let end = fraction.length;
  while (end > 0 && fraction.charCodeAt(end - 1) === 48) end--;
  fraction = fraction.slice(0, end);
  return { i: Number(integer), v: end, f: end === 0 ? 0 : Number(fraction), iDigits: integer, fDigits: end === 0 ? "0" : fraction };
}

// Exact remainder of a non-negative decimal digit string by a positive integer modulus.
export function digitsMod(digits: string, modulus: number): number {
  let remainder = 0;
  for (let k = 0; k < digits.length; k++) remainder = (remainder * 10 + (digits.charCodeAt(k) - 48)) % modulus;
  return remainder;
}
