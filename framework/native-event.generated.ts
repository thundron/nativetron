// generated from abi/events.json by abi/generate.mjs — do not edit
export const EVENT_PROTOCOL_VERSION = 2;
export const EVENT_MESSAGE_KIND = "event";
const EVENT_VALUE_LIMIT = 4096;
const EVENT_KEY_LIMIT = 64;
const EVENT_CODE_LIMIT = 64;
const EVENT_MODIFIERS_LIMIT = 15;
const EVENT_INPUT_TYPE_LIMIT = 32;
const EVENT_SCROLL_TOP_LIMIT = 1073741824;

export interface NativeEventMessage {
  version: number;
  kind: string;
  slot: number;
  value: string;
  checked: number;
  key: string;
  code: string;
  modifiers: number;
  inputType: string;
  scrollTop: number;
}

export type NativeEventCallback = (slot: number, value: string, checked: number, key: string, code: string, modifiers: number, inputType: string, scrollTop: number) => void;

export const NATIVE_EVENT_BRIDGE_JS = "window.__nt_event=function(slot){if(arguments.length!==1||typeof slot !== \"number\" || slot < 0 || slot > 4294967295 || Math.floor(slot) !== slot)return false;(window.__nt_send||window.__nt_ipc)(JSON.stringify({version:2,kind:\"event\",slot:slot,value:\"\",checked:-1,key:\"\",code:\"\",modifiers:0,inputType:\"\",scrollTop:0}));return true;};window.__nt_event_value=function(slot,value){if(arguments.length!==2||typeof slot !== \"number\" || slot < 0 || slot > 4294967295 || Math.floor(slot) !== slot||typeof value !== \"string\" || value.length > 4096)return false;(window.__nt_send||window.__nt_ipc)(JSON.stringify({version:2,kind:\"event\",slot:slot,value:value,checked:-1,key:\"\",code:\"\",modifiers:0,inputType:\"\",scrollTop:0}));return true;};window.__nt_event_rich=function(slot,value,checked,key,code,modifiers,inputType,scrollTop){if(arguments.length!==8||typeof slot !== \"number\" || slot < 0 || slot > 4294967295 || Math.floor(slot) !== slot||typeof value !== \"string\" || value.length > 4096||typeof checked !== \"number\" || checked < -1 || checked > 1 || Math.floor(checked) !== checked||typeof key !== \"string\" || key.length > 64||typeof code !== \"string\" || code.length > 64||typeof modifiers !== \"number\" || modifiers < 0 || modifiers > 15 || Math.floor(modifiers) !== modifiers||typeof inputType !== \"string\" || inputType.length > 32||typeof scrollTop !== \"number\" || !Number.isFinite(scrollTop) || scrollTop < 0 || scrollTop > 1073741824)return false;(window.__nt_send||window.__nt_ipc)(JSON.stringify({version:2,kind:\"event\",slot:slot,value:value,checked:checked,key:key,code:code,modifiers:modifiers,inputType:inputType,scrollTop:scrollTop}));return true;};";

export function parseNativeEventMessage(raw: string): NativeEventMessage | null {
  let input: unknown;
  try { input = JSON.parse(raw) as unknown; } catch (_error) { return null; }
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const message = input as Record<string, unknown>;
  if (Object.keys(message).length !== 10 ||
      !Object.hasOwn(message, "version") ||
      !Object.hasOwn(message, "kind") ||
      !Object.hasOwn(message, "slot") ||
      !Object.hasOwn(message, "value") ||
      !Object.hasOwn(message, "checked") ||
      !Object.hasOwn(message, "key") ||
      !Object.hasOwn(message, "code") ||
      !Object.hasOwn(message, "modifiers") ||
      !Object.hasOwn(message, "inputType") ||
      !Object.hasOwn(message, "scrollTop")) return null;
  const version = message["version"];
  const kind = message["kind"];
  const slot = message["slot"];
  const value = message["value"];
  const checked = message["checked"];
  const key = message["key"];
  const code = message["code"];
  const modifiers = message["modifiers"];
  const inputType = message["inputType"];
  const scrollTop = message["scrollTop"];
  if (version !== 2 ||
      kind !== "event" ||
      typeof slot !== "number" || slot < 0 || slot > 4294967295 || Math.floor(slot) !== slot ||
      typeof value !== "string" || value.length > EVENT_VALUE_LIMIT ||
      typeof checked !== "number" || checked < -1 || checked > 1 || Math.floor(checked) !== checked ||
      typeof key !== "string" || key.length > EVENT_KEY_LIMIT ||
      typeof code !== "string" || code.length > EVENT_CODE_LIMIT ||
      typeof modifiers !== "number" || modifiers < 0 || modifiers > 15 || Math.floor(modifiers) !== modifiers ||
      typeof inputType !== "string" || inputType.length > EVENT_INPUT_TYPE_LIMIT ||
      typeof scrollTop !== "number" || !Number.isFinite(scrollTop) || scrollTop < 0 || scrollTop > 1073741824) return null;
  return { version, kind, slot, value, checked, key, code, modifiers, inputType, scrollTop };
}

export function dispatchNativeEvent(message: NativeEventMessage, callback: NativeEventCallback): void {
  callback(message.slot, message.value, message.checked, message.key, message.code, message.modifiers, message.inputType, message.scrollTop);
}
