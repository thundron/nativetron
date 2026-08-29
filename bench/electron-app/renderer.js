// Electron renderer — page JavaScript running in Chromium/V8.
// Equivalent to nativetron's native click handler, but here the counter state
// and DOM mutation happen in-engine as page JS (the standard Electron model).
let count = 0;
const out = document.getElementById("out");
document.getElementById("inc").addEventListener("click", () => {
  count++;
  out.textContent = `count: ${count}`;
});
