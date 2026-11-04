import { setBinarySink, flush, setLive, dispatchSlot, dispatchSlotValue, dispatchSlotRich } from "../framework/core.js";
import { el, txt, dyn, on, mountTo } from "../framework/ui.js";
import { signal } from "../framework/reactive.js";
import { encodeEngineMessage, decodeEngineMessage, ENGINE_COMMAND, LANE_UI, LANE_ENGINE } from "../ipc/engine.generated.js";

declare function uiPresent(bytes: Uint8Array): void;
declare function uiToEngine(bytes: Uint8Array): void;
const status = signal("Engine starting");

export function start(): number {
  setBinarySink((bytes: Uint8Array) => uiPresent(bytes));
  mountTo(el("section", [
    el("h1", [txt("nativetron GPU engine lane")]),
    on(el("button", [txt("Change clear colour in-page")]), "click", () => {
      uiToEngine(encodeEngineMessage(ENGINE_COMMAND, LANE_UI, LANE_ENGINE, 0, 1, new Uint8Array(0)));
    }),
    el("p", [dyn(() => status.get())]),
  ]));
  setLive(); flush();
  return 0;
}

export function message(bytes: Uint8Array): number {
  const frame = decodeEngineMessage(bytes);
  if (frame !== null && frame.target === LANE_UI && frame.source === LANE_ENGINE) {
    status.set(Buffer.from(frame.payload).toString("utf8")); flush();
  }
  return 0;
}

/* generated:event-export */
export function onEvent(
  slot: number,
): number {
  dispatchSlot(slot);
  flush();
  return 0;
}

export function onEventValue(
  slot: number,
  value: string,
): number {
  dispatchSlotValue(slot, value);
  flush();
  return 0;
}

export function onEventRich(
  slot: number,
  value: string,
  checked: number,
  key: string,
  code: string,
  modifiers: number,
  inputType: string,
  scrollTop: number,
): number {
  dispatchSlotRich(slot, value, checked, key, code, modifiers, inputType, scrollTop);
  flush();
  return 0;
}
/* /generated:event-export */
