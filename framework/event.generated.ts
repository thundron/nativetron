// generated from abi/events.json by abi/generate.mjs — do not edit
export const EVENT_VALUE_LIMIT = 4096;
export const EVENT_KEY_LIMIT = 64;
export const EVENT_CODE_LIMIT = 64;
export const EVENT_INPUT_TYPE_LIMIT = 32;

export interface DecodedHostEvent {
  n: number;
  t: string;
  value: string;
  checked?: boolean;
  key?: string;
  code?: string;
  modifiers?: number;
  inputType?: string;
}

export function decodeDefaultHostEvent(nodeId: number, eventType: string): DecodedHostEvent | null {
  const value: string = "";
  const checked: number = -1;
  const key: string = "";
  const code: string = "";
  const modifiers: number = 0;
  const inputType: string = "";
  const out: DecodedHostEvent = { n: nodeId, t: eventType, value };
  if (checked === 0) out.checked = false;
  else if (checked === 1) out.checked = true;
  if (key.length > 0) out.key = key;
  if (code.length > 0) out.code = code;
  out.modifiers = modifiers;
  if (inputType.length > 0) out.inputType = inputType;
  return out;
}

export function decodePrimaryHostEvent(nodeId: number, eventType: string, value: string): DecodedHostEvent | null {
  const checked: number = -1;
  const key: string = "";
  const code: string = "";
  const modifiers: number = 0;
  const inputType: string = "";
  if (value.length > EVENT_VALUE_LIMIT) return null;
  const out: DecodedHostEvent = { n: nodeId, t: eventType, value };
  if (checked === 0) out.checked = false;
  else if (checked === 1) out.checked = true;
  if (key.length > 0) out.key = key;
  if (code.length > 0) out.code = code;
  out.modifiers = modifiers;
  if (inputType.length > 0) out.inputType = inputType;
  return out;
}

export function decodeHostEvent(nodeId: number, eventType: string, value: string, checked: number, key: string, code: string, modifiers: number, inputType: string): DecodedHostEvent | null {
  if (value.length > EVENT_VALUE_LIMIT ||
      checked < -1 || checked > 1 || Math.floor(checked) !== checked ||
      key.length > EVENT_KEY_LIMIT ||
      code.length > EVENT_CODE_LIMIT ||
      modifiers < 0 || modifiers > 15 || Math.floor(modifiers) !== modifiers ||
      inputType.length > EVENT_INPUT_TYPE_LIMIT) return null;
  const out: DecodedHostEvent = { n: nodeId, t: eventType, value };
  if (checked === 0) out.checked = false;
  else if (checked === 1) out.checked = true;
  if (key.length > 0) out.key = key;
  if (code.length > 0) out.code = code;
  out.modifiers = modifiers;
  if (inputType.length > 0) out.inputType = inputType;
  return out;
}
