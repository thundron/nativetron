export interface MessageArg { name: string; text: string; value: number; numeric: boolean; }
export function textArgument(name: string, text: string): MessageArg { return { name, text, value: 0, numeric: false }; }
export function numberArgument(name: string, value: number): MessageArg { return { name, text: "", value, numeric: true }; }
function find(args: MessageArg[], name: string): MessageArg {
  if (args.length > 32) throw new Error("message argument limit");
  let found = -1;
  for (let i = 0; i < args.length; i++) if (args[i]!.name === name) {
    if (found !== -1) throw new Error("duplicate message argument: " + name);
    found = i;
  }
  if (found === -1) throw new Error("missing message argument: " + name);
  return args[found]!;
}
export function numericArgument(args: MessageArg[], name: string): number {
  const arg = find(args, name);
  if (!arg.numeric || !Number.isFinite(arg.value)) throw new Error("invalid numeric message argument: " + name);
  return arg.value;
}
export function argumentText(args: MessageArg[], name: string, numericFormat: (value: number) => string): string {
  const arg = find(args, name);
  if (arg.numeric) return numericFormat(numericArgument(args, name));
  return arg.text;
}
