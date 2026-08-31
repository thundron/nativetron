import { Window } from "./index.mjs";

const w = new Window({ title: "nativetron from Node", width: 520, height: 360 });
let count = 0;
let id = 1;
const h1 = id++, h1t = id++, btn = id++, btnT = id++, out = id++, outT = id++;

w.enc.createElement(h1, "h1"); w.enc.createText(h1t, "Driven from Node"); w.enc.append(0, h1); w.enc.append(h1, h1t);
w.enc.createElement(btn, "button"); w.enc.createText(btnT, "Increment"); w.enc.append(0, btn); w.enc.append(btn, btnT);
w.enc.createElement(out, "p"); w.enc.createText(outT, "count: 0"); w.enc.append(0, out); w.enc.append(out, outT);
w.listen(btn, "click", () => { count++; w.enc.setText(outT, "count: " + count); });

w.onReady = () => {
  w.flush();
  if (process.env.NT_SELFTEST === "1") {
    setTimeout(() => {
      w.eval('var b=[].slice.call(document.querySelectorAll("button"))[0];b.click();b.click();b.click();' +
        'setTimeout(function(){(window.__nt_send||window.__nt_ipc)(JSON.stringify(' +
        '{n:0,t:"__probe",value:document.getElementById("nt-root").textContent}))},300);');
    }, 200);
  }
};

const origin = w._message.bind(w);
w._message = (raw) => {
  try {
    const ev = JSON.parse(JSON.parse(raw)[0]);
    if (ev.t === "__probe") {
      console.log("NODE_DOM=" + ev.value);
      w.close();
      return;
    }
  } catch {}
  origin(raw);
};

w.flush();
await w.run();
console.log("window closed");
