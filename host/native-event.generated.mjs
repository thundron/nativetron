// generated from abi/events.json by abi/generate.mjs — do not edit
export const EVENT_PROTOCOL_VERSION = 1;
export const EVENT_MESSAGE_KIND = "event";
export const NATIVE_EVENT_BRIDGE_JS = "window.__nt_event=function(slot){if(arguments.length!==1||typeof slot !== \"number\" || slot < 0 || slot > 4294967295 || Math.floor(slot) !== slot)return false;(window.__nt_send||window.__nt_ipc)(JSON.stringify({version:1,kind:\"event\",slot:slot,value:\"\",checked:-1,key:\"\",code:\"\",modifiers:0,inputType:\"\"}));return true;};window.__nt_event_value=function(slot,value){if(arguments.length!==2||typeof slot !== \"number\" || slot < 0 || slot > 4294967295 || Math.floor(slot) !== slot||typeof value !== \"string\" || value.length > 4096)return false;(window.__nt_send||window.__nt_ipc)(JSON.stringify({version:1,kind:\"event\",slot:slot,value:value,checked:-1,key:\"\",code:\"\",modifiers:0,inputType:\"\"}));return true;};window.__nt_event_rich=function(slot,value,checked,key,code,modifiers,inputType){if(arguments.length!==7||typeof slot !== \"number\" || slot < 0 || slot > 4294967295 || Math.floor(slot) !== slot||typeof value !== \"string\" || value.length > 4096||typeof checked !== \"number\" || checked < -1 || checked > 1 || Math.floor(checked) !== checked||typeof key !== \"string\" || key.length > 64||typeof code !== \"string\" || code.length > 64||typeof modifiers !== \"number\" || modifiers < 0 || modifiers > 15 || Math.floor(modifiers) !== modifiers||typeof inputType !== \"string\" || inputType.length > 32)return false;(window.__nt_send||window.__nt_ipc)(JSON.stringify({version:1,kind:\"event\",slot:slot,value:value,checked:checked,key:key,code:code,modifiers:modifiers,inputType:inputType}));return true;};";

export function decodeNativeEventMessage(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message) ||
      Object.keys(message).length !== 9 ||
      !Object.hasOwn(message, "version") ||
      !Object.hasOwn(message, "kind") ||
      !Object.hasOwn(message, "slot") ||
      !Object.hasOwn(message, "value") ||
      !Object.hasOwn(message, "checked") ||
      !Object.hasOwn(message, "key") ||
      !Object.hasOwn(message, "code") ||
      !Object.hasOwn(message, "modifiers") ||
      !Object.hasOwn(message, "inputType") ||
      message.version !== 1 ||
      message.kind !== "event" ||
      typeof message.slot !== "number" || message.slot < 0 || message.slot > 4294967295 || Math.floor(message.slot) !== message.slot ||
      typeof message.value !== "string" || message.value.length > 4096 ||
      typeof message.checked !== "number" || message.checked < -1 || message.checked > 1 || Math.floor(message.checked) !== message.checked ||
      typeof message.key !== "string" || message.key.length > 64 ||
      typeof message.code !== "string" || message.code.length > 64 ||
      typeof message.modifiers !== "number" || message.modifiers < 0 || message.modifiers > 15 || Math.floor(message.modifiers) !== message.modifiers ||
      typeof message.inputType !== "string" || message.inputType.length > 32) return null;
  return message;
}

export function parseNativeEventMessage(raw) {
  try { return decodeNativeEventMessage(JSON.parse(raw)); } catch { return null; }
}
