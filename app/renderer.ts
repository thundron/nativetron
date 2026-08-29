// nativetron renderer — compiled to NATIVE machine code by scriptc.
// It owns the window, renders a page, and handles UI events in native code,
// pushing DOM updates back over the bridge. No V8 runs this logic.

declare function ntInit(): void;
declare function ntSetTitle(title: string): void;
declare function ntSetSize(w: number, h: number): void;
declare function ntSetHtml(html: string): void;
declare function ntOnMessage(cb: (req: string) => void): void;
declare function ntEval(js: string): void;
declare function ntRun(): void;

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
  body{font-family:-apple-system,system-ui,sans-serif;margin:40px;color:#111}
  h1{margin:0 0 8px} .muted{color:#666} button{font-size:15px;padding:8px 14px}
  #out{font-variant-numeric:tabular-nums}
</style></head><body>
  <h1>Hello from nativetron</h1>
  <p class="muted">This page is a view. The click handler below runs as
     <b>compiled native code</b>, not in a JS engine.</p>
  <button id="b">Ping native</button>
  <p id="out">clicks: 0</p>
  <script>
    document.getElementById('b').onclick = () =>
      window.__nt_ipc(JSON.stringify({ type: 'click' }));
  </script>
</body></html>`;

let clicks = 0;

ntInit();
ntSetTitle("nativetron");
ntSetSize(520, 340);
ntSetHtml(HTML);

ntOnMessage((req: string) => {
  // webview delivers bound-call args as a JSON array: ["{...}"]
  const args = JSON.parse(req) as string[];
  const msg = JSON.parse(args[0]) as { type: string };
  if (msg.type === "click") {
    clicks++;
    const text = `clicks: ${clicks}`;
    ntEval(`document.getElementById('out').textContent = ${JSON.stringify(text)};`);
  }
});

ntRun();
