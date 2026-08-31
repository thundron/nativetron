import type { El } from "../../framework/ui.js";

declare global {
  namespace JSX {
    type Element = El;
    interface IntrinsicElements {
      [name: string]: unknown;
    }
  }
}

export {};
