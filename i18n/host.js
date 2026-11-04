const encoder = new TextEncoder();
const cache = new Map();
export function formatLocaleNumber(value, locale, unit, maximumFractionDigits, output) {
  const key = `${locale}/${unit}/${maximumFractionDigits}`;
  let formatter = cache.get(key);
  if (!formatter) {
    const options = { maximumFractionDigits };
    if (unit) Object.assign(options, { style: "unit", unit, unitDisplay: "short" });
    formatter = new Intl.NumberFormat(locale, options);
    if (cache.size >= 128) cache.clear();
    cache.set(key, formatter);
  }
  const text = formatter.format(value);
  const result = encoder.encodeInto(text, output);
  if (result.read !== text.length) return -1;
  return result.written;
}
