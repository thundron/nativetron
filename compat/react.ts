import { signal, effect, computed } from "../framework/reactive.js";

export type Getter<T> = () => T;
export type Setter<T> = (v: T) => void;

export function useState<T>(initial: T): [Getter<T>, Setter<T>] {
  const s = signal(initial);
  return [() => s.get(), (v: T) => s.set(v)];
}

export function useReducer<S, A>(
  reduce: (state: S, action: A) => S,
  initial: S,
): [Getter<S>, (action: A) => void] {
  const s = signal(initial);
  return [() => s.get(), (action: A) => s.set(reduce(s.get(), action))];
}

export function useEffect(fn: () => void): void {
  effect(fn);
}

export function useMemo<T>(fn: () => T): Getter<T> {
  const c = computed(fn);
  return () => c.get();
}

export function useCallback<T>(fn: T): T {
  return fn;
}

export interface Ref<T> {
  current: T;
}

export function useRef<T>(initial: T): Ref<T> {
  return { current: initial };
}
