// generated from i18n/catalogue.json and its locale catalogues by i18n/generate.mjs — do not edit
import { argumentText, numericArgument, type MessageArg } from "./values.js";
import { digitsMod, pluralOperands, type PluralOperands } from "./plural.js";

type NumericFormat = (value: number) => string;

function rule_english_cardinal(o: PluralOperands): string {
  if (o.i === 1 && o.v === 0) return "one";
  return "other";
}

function rule_french_cardinal(o: PluralOperands): string {
  if ((o.i === 0 || o.i === 1)) return "one";
  if (!(o.i === 0) && digitsMod(o.iDigits, 1000000) === 0 && o.v === 0) return "many";
  return "other";
}

function rule_polish_cardinal(o: PluralOperands): string {
  if (o.i === 1 && o.v === 0) return "one";
  if (o.v === 0 && (digitsMod(o.iDigits, 10) >= 2 && digitsMod(o.iDigits, 10) <= 4) && !((digitsMod(o.iDigits, 100) >= 12 && digitsMod(o.iDigits, 100) <= 14))) return "few";
  if ((o.v === 0 && !(o.i === 1) && (digitsMod(o.iDigits, 10) >= 0 && digitsMod(o.iDigits, 10) <= 1)) || (o.v === 0 && (digitsMod(o.iDigits, 10) >= 5 && digitsMod(o.iDigits, 10) <= 9)) || (o.v === 0 && (digitsMod(o.iDigits, 100) >= 12 && digitsMod(o.iDigits, 100) <= 14))) return "many";
  return "other";
}

export function pluralCategory(locale: string, value: number): string {
  if (locale === "en") return rule_english_cardinal(pluralOperands(value, 3));
  if (locale === "fr") return rule_french_cardinal(pluralOperands(value, 3));
  if (locale === "pl") return rule_polish_cardinal(pluralOperands(value, 3));
  throw new Error("unsupported locale: " + locale);
}

function en_plural1(args: MessageArg[], numericFormat: NumericFormat): string {
  const count1 = numericArgument(args, "count");
  if (count1 === 0) return "No items";
  const category1 = rule_english_cardinal(pluralOperands(count1, 3));
  if (category1 === "one") return "" + numericFormat(count1) + " item";
  return "" + numericFormat(count1) + " items";
}

function fr_plural1(args: MessageArg[], numericFormat: NumericFormat): string {
  const count1 = numericArgument(args, "count");
  if (count1 === 0) return "Aucun élément";
  const category1 = rule_french_cardinal(pluralOperands(count1, 3));
  if (category1 === "one") return "" + numericFormat(count1) + " élément";
  if (category1 === "many") return "" + numericFormat(count1) + " d’éléments";
  return "" + numericFormat(count1) + " éléments";
}

function pl_plural1(args: MessageArg[], numericFormat: NumericFormat): string {
  const count1 = numericArgument(args, "count");
  if (count1 === 0) return "Brak elementów";
  const category1 = rule_polish_cardinal(pluralOperands(count1, 3));
  if (category1 === "one") return "" + numericFormat(count1) + " element";
  if (category1 === "few") return "" + numericFormat(count1) + " elementy";
  if (category1 === "many") return "" + numericFormat(count1) + " elementów";
  return "" + numericFormat(count1) + " elementu";
}

function messages_en(key: string, args: MessageArg[], numericFormat: NumericFormat): string {
  if (key === "commands.close") return "Close";
  if (key === "commands.empty") return "No enabled commands";
  if (key === "commands.search") return "Search commands";
  if (key === "commands.title") return "Commands";
  if (key === "greeting") return "Hello, " + argumentText(args, "name", numericFormat);
  if (key === "items.count") return en_plural1(args, numericFormat);
  throw new Error("missing message key: " + key);
}

function messages_fr(key: string, args: MessageArg[], numericFormat: NumericFormat): string {
  if (key === "commands.close") return "Fermer";
  if (key === "commands.empty") return "Aucune commande activée";
  if (key === "commands.search") return "Rechercher des commandes";
  if (key === "commands.title") return "Commandes";
  if (key === "greeting") return "Bonjour, " + argumentText(args, "name", numericFormat);
  if (key === "items.count") return fr_plural1(args, numericFormat);
  throw new Error("missing message key: " + key);
}

function messages_pl(key: string, args: MessageArg[], numericFormat: NumericFormat): string {
  if (key === "commands.close") return "Zamknij";
  if (key === "commands.empty") return "Brak włączonych poleceń";
  if (key === "commands.search") return "Szukaj poleceń";
  if (key === "commands.title") return "Polecenia";
  if (key === "greeting") return "Witaj, " + argumentText(args, "name", numericFormat);
  if (key === "items.count") return pl_plural1(args, numericFormat);
  throw new Error("missing message key: " + key);
}

export function catalogueHas(key: string): boolean {
  if (key === "commands.close") return true;
  if (key === "commands.empty") return true;
  if (key === "commands.search") return true;
  if (key === "commands.title") return true;
  if (key === "greeting") return true;
  if (key === "items.count") return true;
  return false;
}

export function catalogueMessage(locale: string, key: string, args: MessageArg[], numericFormat: NumericFormat): string {
  if (locale === "en") return messages_en(key, args, numericFormat);
  if (locale === "fr") return messages_fr(key, args, numericFormat);
  if (locale === "pl") return messages_pl(key, args, numericFormat);
  throw new Error("unsupported locale: " + locale);
}
