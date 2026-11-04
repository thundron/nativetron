// generated from locales/en.json and i18n/catalogue.json — do not edit
import { argumentText, numericArgument, type MessageArg } from "./values.js";

function plural1(args: MessageArg[], numericFormat: (value: number) => string): string {
  const count1 = numericArgument(args, "count");
  if (count1 === 0) return "No items";
  if (Math.abs(count1) === 1) return "" + numericFormat(count1) + " item";
  return "" + numericFormat(count1) + " items";
}

export function catalogueMessage(key: string, args: MessageArg[], numericFormat: (value: number) => string): string {
  if (key === "commands.close") return "Close";
  if (key === "commands.empty") return "No enabled commands";
  if (key === "commands.search") return "Search commands";
  if (key === "commands.title") return "Commands";
  if (key === "greeting") return "Hello, " + argumentText(args, "name", numericFormat);
  if (key === "items.count") return plural1(args, numericFormat);
  throw new Error("missing message key: " + key);
}
