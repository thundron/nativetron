import { createRoot } from "react-dom/client";
import { useState } from "react";

function App() {
  const [count, setCount] = useState(0);
  return (
    <>
      <h1>Hello from nativetron (wasm)</h1>
      <p>This UI is driven by TypeScript compiled to WebAssembly.</p>
      <button style={{ fontSize: 15, padding: "8px 14px" }} onClick={() => setCount(count + 1)}>
        Increment
      </button>
      <p>count: {count}</p>
    </>
  );
}
createRoot(document.getElementById("nt-root")).render(<App />);
