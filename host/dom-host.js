// nativetron DOM host runtime (DOM Host ABI v0).
// Environment-agnostic: injected into the webview today; loaded as-is by the
// browser-wasm host in Phase 3. It owns the real DOM, applies command batches,
// and posts events back to the reconciler.
//
// Transport hooks (provided by the embedding host):
//   window.__nt_send(jsonString)   reconciler <- host   (events)
//   window.__nt.apply(batch)       reconciler -> host   (commands)
// For the webview host, __nt_send is wired to the bound __nt_ipc below.
(function () {
  var nodes = {};
  var handlers = {};
  var interned = [];

  function root() {
    return document.getElementById("nt-root") || document.body;
  }
  function node(id) {
    return id === 0 ? root() : nodes[id];
  }
  function send(obj) {
    (window.__nt_send || window.__nt_ipc)(JSON.stringify(obj));
  }

  function attach(id, type) {
    var key = id + ":" + type;
    if (handlers[key]) return;
    var h = function (ev) {
      var p = { n: id, t: type };
      if (ev && ev.target && "value" in ev.target) p.value = ev.target.value;
      send(p);
    };
    handlers[key] = h;
    node(id).addEventListener(type, h);
  }
  function detach(id, type) {
    var key = id + ":" + type;
    var h = handlers[key];
    if (h) {
      node(id).removeEventListener(type, h);
      delete handlers[key];
    }
  }

  function apply(batch) {
    for (var i = 0; i < batch.length; i++) {
      var op = batch[i];
      switch (op[0]) {
        case 1: nodes[op[1]] = document.createElement(op[2]); break;
        case 2: nodes[op[1]] = document.createTextNode(op[2]); break;
        case 3: node(op[1]).textContent = op[2]; break;
        case 4: node(op[1]).setAttribute(op[2], op[3]); break;
        case 5: node(op[1]).removeAttribute(op[2]); break;
        case 6: node(op[1]).appendChild(nodes[op[2]]); break;
        case 7: node(op[1]).insertBefore(nodes[op[2]], nodes[op[3]]); break;
        case 8: {
          var n = nodes[op[1]];
          if (n && n.parentNode) n.parentNode.removeChild(n);
          delete nodes[op[1]];
          break;
        }
        case 9: attach(op[1], op[2]); break;
        case 10: detach(op[1], op[2]); break;
        case 11: node(op[1])[op[2]] = op[3]; break;
      }
    }
  }

  var td = new TextDecoder();

  function attachSlot(id, type, slot) {
    var key = id + ":" + type;
    if (handlers[key]) return;
    var h = function (ev) {
      var v = ev && ev.target && "value" in ev.target ? ev.target.value : "";
      window.__nt_event(slot, v);
    };
    handlers[key] = h;
    node(id).addEventListener(type, h);
  }

  function applyBin(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var o = 0;
    var u32 = function () { var v = dv.getUint32(o, true); o += 4; return v; };
    var s = function () {
      var n = u32();
      var end = o + n, r;
      if (n < 64) {
        r = "";
        var ascii = true;
        for (var q = o; q < end; q++) { var c = bytes[q]; if (c > 127) { ascii = false; break; } r += String.fromCharCode(c); }
        if (ascii) { o = end; return r; }
      }
      r = td.decode(bytes.subarray(o, end));
      o = end;
      return r;
    };
    var iv = function () { return interned[u32()]; };
    while (o < bytes.byteLength) {
      var code = dv.getUint8(o); o += 1;
      switch (code) {
        case 1: { var id = u32(); nodes[id] = document.createElement(iv()); break; }
        case 2: { var id2 = u32(); nodes[id2] = document.createTextNode(s()); break; }
        case 3: { var id3 = u32(); node(id3).textContent = s(); break; }
        case 4: { var id4 = u32(); node(id4).setAttribute(iv(), s()); break; }
        case 6: { var p = u32(); node(p).appendChild(nodes[u32()]); break; }
        case 7: { var pp = u32(); var cc = u32(); var rr = u32(); node(pp).insertBefore(nodes[cc], nodes[rr]); break; }
        case 8: { var rid = u32(); var rn = nodes[rid]; if (rn && rn.parentNode) rn.parentNode.removeChild(rn); delete nodes[rid]; break; }
        case 9: { var id5 = u32(); attachSlot(id5, iv(), u32()); break; }
        case 11: { var id6 = u32(); node(id6)[iv()] = s(); break; }
        case 12: { var sid = u32(); interned[sid] = s(); break; }
      }
    }
  }

  window.__nt = { apply: apply, applyBin: applyBin };

  function ready() {
    send({ n: 0, t: "__ready" });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready);
  } else {
    ready();
  }
})();
