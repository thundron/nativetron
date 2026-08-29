import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useReducer } from "react";

const labels = [];
const vals = [];
const idx = [];

export function initData(n) {
  for (let i = 0; i < n; i++) {
    labels.push("row " + i);
    vals.push((i * 7919) % 100000);
    idx.push(i);
  }
}

function compute() {
  const n = vals.length;
  for (let i = 0; i < n; i++) vals[i] = (vals[i] * 31 + 7) % 100000;
  idx.sort((a, b) => vals[a] - vals[b]);
}

function App() {
  const [, force] = useReducer((x) => x + 1, 0);
  window.__forceUpdate = () => { compute(); flushSync(() => force()); };
  return <>{idx.map((i, k) => <div key={k}>{labels[i] + " " + vals[i]}</div>)}</>;
}

window.__mount = (n) => {
  initData(n);
  const root = createRoot(document.getElementById("nt-root"));
  flushSync(() => root.render(<App />));
};
