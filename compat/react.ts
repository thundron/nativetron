import { signal, effect, computed } from "../framework/reactive.js";
import type { El } from "../framework/ui.js";

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

export interface ContextProviderProps<T> {
  value: T;
  children?: El[];
}

export interface Context<T> {
  defaultValue: T;
  stack: Getter<T>[];
  Provider: (props: ContextProviderProps<T>) => El;
}

function providerMustBeJsx<T>(_props: ContextProviderProps<T>): El {
  throw new Error("Context.Provider must be used through compiled JSX");
}

export function createContext<T>(defaultValue: T): Context<T> {
  return { defaultValue, stack: [], Provider: providerMustBeJsx<T> };
}

export function useContext<T>(context: Context<T>): Getter<T> {
  const n = context.stack.length;
  if (n === 0) return () => context.defaultValue;
  return context.stack[n - 1]!;
}

export function provide<T>(context: Context<T>, value: Getter<T>, build: () => El): El {
  context.stack.push(value);
  try {
    return build();
  } finally {
    context.stack.pop();
  }
}
