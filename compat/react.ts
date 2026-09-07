import { signal, effect, computed, onScopeCleanup, type EffectBody } from "../framework/reactive.js";
import { frag, type El } from "../framework/ui.js";

export type Getter<T> = () => T;
export type Setter<T> = (v: T) => void;
export type DependencyList<T = never> = T[];

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

export function useEffect<D = never>(fn: EffectBody, _deps?: DependencyList<D>): void {
  effect(fn);
}

export function useLayoutEffect<D = never>(fn: EffectBody, _deps?: DependencyList<D>): void {
  effect(fn);
}

export function useInsertionEffect<D = never>(fn: EffectBody, _deps?: DependencyList<D>): void {
  effect(fn);
}

export function useMemo<T, D = never>(fn: () => T, _deps?: DependencyList<D>): Getter<T> {
  const c = computed(fn);
  return () => c.get();
}

export function useCallback<T, D = never>(fn: T, _deps?: DependencyList<D>): T {
  return fn;
}

let nextId = 0;

export function useId(): string {
  const id = nextId;
  nextId++;
  return "nt-" + id;
}

export function useDebugValue<T>(_value: T): void {}

export function useDeferredValue<T>(value: T): T { return value; }

export type TransitionStart = (fn: () => void) => void;

export function startTransition(fn: () => void): void { fn(); }

export function useTransition(): [boolean, TransitionStart] {
  return [false, startTransition];
}

export interface Ref<T> {
  current: T;
}

export function useRef<T>(initial: T): Ref<T> {
  return { current: initial };
}

export function createRef<T>(): Ref<T | null> {
  return { current: null };
}

export function useImperativeHandle<T, D = never>(
  ref: Ref<T | null> | null,
  create: () => T,
  _deps?: DependencyList<D>,
): void {
  if (ref !== null) {
    ref.current = create();
    onScopeCleanup(() => { ref.current = null; });
  }
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

export interface ChildrenProps {
  children?: El[];
}

export function Fragment(props: ChildrenProps): El {
  return frag(props.children ?? []);
}

export function StrictMode(props: ChildrenProps): El {
  return frag(props.children ?? []);
}

export function memo<P>(component: (props: P) => El): (props: P) => El {
  return component;
}

export interface RefProp<T> {
  ref: Ref<T | null> | null;
}

export function forwardRef<T, P extends RefProp<T>>(
  render: (props: P, ref: Ref<T | null> | null) => El,
): (props: P) => El {
  return (props: P) => render(props, props.ref);
}
