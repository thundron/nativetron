(function () {
  var NODE_ARRAY_LIMIT = 65536;
  var nodes = [];
  var overflowNodes = new Map();
  var nodeIdKey = Symbol("nativetronNodeId");
  var handlers = {};
  var handlerTypes = new Map();
  var interned = [];

  function root() {
    return document.getElementById("nt-root") || document.body;
  }
  function node(id) {
    if (id === 0) return root();
    return id < NODE_ARRAY_LIMIT ? nodes[id] : overflowNodes.get(id);
  }
  function remember(id, n) {
    if (id < NODE_ARRAY_LIMIT) nodes[id] = n;
    else overflowNodes.set(id, n);
    n[nodeIdKey] = id;
  }
  function forget(id) {
    if (id < NODE_ARRAY_LIMIT) nodes[id] = undefined;
    else overflowNodes.delete(id);
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
    var types = handlerTypes.get(id) || [];
    types.push(type);
    handlerTypes.set(id, types);
    node(id).addEventListener(type, h);
  }
  function detach(id, type) {
    var key = id + ":" + type;
    var h = handlers[key];
    if (h) {
      var n = node(id);
      if (n) n.removeEventListener(type, h);
      delete handlers[key];
      var types = handlerTypes.get(id) || [];
      var at = types.indexOf(type);
      if (at >= 0) types.splice(at, 1);
      if (types.length === 0) handlerTypes.delete(id);
    }
  }

  function drop(rootNode) {
    var stack = [rootNode];
    while (stack.length) {
      var n = stack.pop();
      for (var child = n.firstChild; child; child = child.nextSibling) stack.push(child);
      var id = n[nodeIdKey];
      if (id === undefined) continue;
      var types = (handlerTypes.get(id) || []).slice();
      for (var i = 0; i < types.length; i++) detach(id, types[i]);
      handlerTypes.delete(id);
      forget(id);
      delete n[nodeIdKey];
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
    var types = handlerTypes.get(id) || [];
    types.push(type);
    handlerTypes.set(id, types);
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
    var fragParent = -1, frag = null;
    var flushFrag = function () {
      if (frag !== null) { node(fragParent).appendChild(frag); frag = null; fragParent = -1; }
    };
    var appendTo = function (p, child) {
      if (p !== fragParent) { flushFrag(); fragParent = p; frag = document.createDocumentFragment(); }
      frag.appendChild(child);
    };
    while (o < bytes.byteLength) {
      var code = dv.getUint8(o); o += 1;
      switch (code) {
        case 1: { var id = u32(); var el = document.createElement(iv()); remember(id, el); break; }
        case 2: { var id2 = u32(); var tx = document.createTextNode(s()); remember(id2, tx); break; }
        case 3: {
          var id3 = u32(); var sn = node(id3);
          for (var sc = sn.firstChild; sc; sc = sc.nextSibling) drop(sc);
          sn.textContent = s();
          break;
        }
        case 4: { var id4 = u32(); node(id4).setAttribute(iv(), s()); break; }
        case 5: { var id8 = u32(); node(id8).removeAttribute(iv()); break; }
        case 6: { var p = u32(); appendTo(p, node(u32())); break; }
        case 7: { flushFrag(); var pp = u32(); var cc = u32(); var rr = u32(); node(pp).insertBefore(node(cc), node(rr)); break; }
        case 8: { flushFrag(); var rid = u32(); var rn = node(rid); if (rn && rn.parentNode) rn.parentNode.removeChild(rn); if (rn) drop(rn); break; }
        case 9: { var id5 = u32(); attachSlot(id5, iv(), u32()); break; }
        case 10: { var id7 = u32(); detach(id7, iv()); break; }
        case 11: { var id6 = u32(); node(id6)[iv()] = s(); break; }
        case 12: { var sid = u32(); interned[sid] = s(); break; }
        case 13: {
          var rp = u32(), re = u32(), rt = iv(), rtx = u32();
          var e = document.createElement(rt), text = document.createTextNode(s());
          e.appendChild(text);
          remember(re, e); remember(rtx, text);
          appendTo(rp, e);
          break;
        }
      }
    }
    flushFrag();
  }

  function applyB64(b64) {
    var raw = atob(b64);
    var n = raw.length;
    var bytes = new Uint8Array(n);
    for (var i = 0; i < n; i++) bytes[i] = raw.charCodeAt(i);
    applyBin(bytes);
  }
  window.__nt = { applyBin: applyBin, applyB64: applyB64 };

  function ready() {
    send({ n: 0, t: "__ready" });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready);
  } else {
    ready();
  }
})();
