(function () {
  var NODE_ARRAY_LIMIT = 65536;
  var INTERN_ID_LIMIT = 65536;
  var BATCH_BYTE_LIMIT = 16777216;
  /* generated:operation-constants */
  var OP_CREATE_ELEMENT = 1;
  var OP_CREATE_TEXT = 2;
  var OP_SET_TEXT = 3;
  var OP_SET_ATTR = 4;
  var OP_REMOVE_ATTR = 5;
  var OP_APPEND = 6;
  var OP_INSERT_BEFORE = 7;
  var OP_REMOVE = 8;
  var OP_LISTEN = 9;
  var OP_UNLISTEN = 10;
  var OP_SET_PROP = 11;
  var OP_INTERN = 12;
  var OP_ELEMENT_WITH_TEXT = 13;
  var OP_CREATE_SVG_ELEMENT = 14;
  var OP_FOCUS = 15;
  var OP_ELEMENT_TEXT_BATCH = 16;
/* /generated:operation-constants */
  /* generated:event-constants */
  var EVENT_VALUE_LIMIT = 4096;
  var EVENT_KEY_LIMIT = 64;
  var EVENT_CODE_LIMIT = 64;
  var EVENT_MODIFIERS_LIMIT = 15;
  var EVENT_INPUT_TYPE_LIMIT = 32;
  var EVENT_SCROLL_TOP_LIMIT = 1073741824;
  var EVENT_CLIENT_HEIGHT_LIMIT = 1073741824;
  var SAFE_EVENTS = { click: 1, input: 1, change: 1, keydown: 1, keyup: 1, focus: 1, blur: 1, submit: 1, pointerdown: 1, pointerup: 1, scroll: 1, resize: 1 };
/* /generated:event-constants */
  /* generated:property-contract */
  var SAFE_PROPERTIES = {
  "value": {
    "kind": "string",
    "maximum": 4096
  },
  "checked": {
    "kind": "boolean"
  },
  "disabled": {
    "kind": "boolean"
  },
  "selected": {
    "kind": "boolean"
  },
  "indeterminate": {
    "kind": "boolean"
  },
  "readOnly": {
    "kind": "boolean"
  },
  "selectedIndex": {
    "kind": "index",
    "minimum": -999999,
    "maximum": 999999
  },
  "scrollTop": {
    "kind": "number",
    "minimum": 0,
    "maximum": 1073741824,
    "deferred": true
  }
};
/* /generated:property-contract */
  var SAFE_SVG_TAGS = {
    svg: 1, g: 1, path: 1, circle: 1, rect: 1, line: 1,
    polyline: 1, polygon: 1, ellipse: 1, title: 1
  };
  var nodes = [];
  var overflowNodes = new Map();
  var nodeIdKey = Symbol("nativetronNodeId");
  var handlers = {};
  var resizeObservers = {};
  var handlerTypes = new Map();
  var interned = [];
  var paintScheduled = false;

  function root() {
    var mount = document.getElementById("nt-root");
    if (!mount) throw new Error("nativetron mount root is missing");
    return mount;
  }
  function node(id) {
    if (id === 0) return root();
    return id < NODE_ARRAY_LIMIT ? nodes[id] : overflowNodes.get(id);
  }
  function remember(id, n) {
    if (id === 0 || node(id)) throw new Error("node id already exists: " + id);
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

  function detach(id, type) {
    var key = id + ":" + type;
    var h = handlers[key];
    if (h) {
      var n = node(id);
      if (n) n.removeEventListener(type, h);
      if (resizeObservers[key]) { resizeObservers[key].disconnect(); delete resizeObservers[key]; }
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

  function boundedText(value, limit) {
    var text = value === undefined || value === null ? "" : String(value);
    return text.length > limit ? text.slice(0, limit) : text;
  }

  function dispatchEvent(slot, ev) {
    /* generated:event-projection */
    var target = ev && ev.target;
    var value = target && "value" in target ? boundedText(target.value, EVENT_VALUE_LIMIT) : "";
    var checked = target && typeof target.checked === "boolean" ? (target.checked ? 1 : 0) : -1;
    var key = ev && typeof ev.key === "string" ? boundedText(ev.key, EVENT_KEY_LIMIT) : "";
    var code = ev && typeof ev.code === "string" ? boundedText(ev.code, EVENT_CODE_LIMIT) : "";
    var modifiers = ev ? (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0) : 0;
    var inputType = ev && typeof ev.inputType === "string" ? boundedText(ev.inputType, EVENT_INPUT_TYPE_LIMIT) : "";
    var scrollTop = ev && ev.type === "scroll" && target && Number.isFinite(target.scrollTop) ? Math.max(0, Math.min(1073741824, target.scrollTop)) : 0;
    var clientHeight = ev && ev.type === "resize" && target && Number.isFinite(target.clientHeight) ? Math.max(0, Math.min(1073741824, target.clientHeight)) : 0;
    if (value === "" && checked === -1 && key === "" && code === "" && modifiers === 0 && inputType === "" && scrollTop === 0 && clientHeight === 0) { window.__nt_event(slot); return; }
    if (checked === -1 && key === "" && code === "" && modifiers === 0 && inputType === "" && scrollTop === 0 && clientHeight === 0) { window.__nt_event_value(slot, value); return; }
    window.__nt_event_rich(slot, value, checked, key, code, modifiers, inputType, scrollTop, clientHeight);
/* /generated:event-projection */
  }

  function attachSlot(id, type, slot) {
    if (SAFE_EVENTS[type] !== 1) throw new Error("unsupported event type: " + type);
    var key = id + ":" + type;
    if (handlers[key]) return;
    var n = node(id);
    if (!n) throw new Error("unknown listener node");
    if (type === "resize" && typeof ResizeObserver !== "function") throw new Error("ResizeObserver unavailable");
    var h = function (ev) { if (node(id) === n && handlers[key] === h) dispatchEvent(slot, ev); };
    handlers[key] = h;
    var types = handlerTypes.get(id) || [];
    types.push(type);
    handlerTypes.set(id, types);
    if (type === "resize") {
      var observer = new ResizeObserver(function () { h({ type: "resize", target: n }); });
      resizeObservers[key] = observer;
      observer.observe(n);
    } else n.addEventListener(type, h);
  }

  function setSafeProperty(target, name, value, deferred) {
    if (!Object.prototype.hasOwnProperty.call(SAFE_PROPERTIES, name)) throw new Error("unsupported property: " + name);
    var contract = SAFE_PROPERTIES[name];
    if (contract.kind === "boolean") {
      if (value !== "true" && value !== "false") throw new Error("invalid boolean property");
      target[name] = value === "true"; return;
    }
    if (contract.kind === "index" || contract.kind === "number") {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) throw new Error("invalid numeric property");
      var numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < contract.minimum || numeric > contract.maximum || (contract.kind === "index" && !Number.isInteger(numeric))) throw new Error("numeric property out of bounds");
      if (contract.deferred) deferred.push({ target: target, name: name, value: numeric });
      else target[name] = numeric;
      return;
    }
    if (value.length > contract.maximum) throw new Error("property string limit exceeded");
    target[name] = value;
  }

  function applyBin(bytes) {
    if (!bytes || typeof bytes.byteLength !== "number" || typeof bytes.subarray !== "function" || !bytes.buffer) {
      throw new Error("DOM operation batch must be a byte view");
    }
    if (bytes.byteLength > BATCH_BYTE_LIMIT) throw new Error("DOM operation batch exceeds limit");
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var offset = 0;
    var deferredProperties = [];
    var readU32 = function () {
      if (offset + 4 > bytes.byteLength) throw new Error("truncated u32 operand");
      var value = view.getUint32(offset, true);
      offset += 4;
      return value;
    };
    var readString = function () {
      var length = readU32();
      if (length > bytes.byteLength - offset) throw new Error("truncated string operand");
      var end = offset + length, result;
      if (length < 64) {
        result = "";
        var ascii = true;
        for (var cursor = offset; cursor < end; cursor++) {
          var unit = bytes[cursor];
          if (unit > 127) { ascii = false; break; }
          result += String.fromCharCode(unit);
        }
        if (ascii) { offset = end; return result; }
      }
      result = td.decode(bytes.subarray(offset, end));
      offset = end;
      return result;
    };
    var readInterned = function () {
      var internId = readU32();
      if (internId >= INTERN_ID_LIMIT || typeof interned[internId] !== "string") {
        throw new Error("unknown intern id: " + internId);
      }
      return interned[internId];
    };
    var requireNode = function (id) {
      var found = node(id);
      if (!found) throw new Error("unknown node id: " + id);
      return found;
    };
    var fragmentParent = -1, fragment = null;
    var flushFragment = function () {
      if (fragment === null) return;
      requireNode(fragmentParent).appendChild(fragment);
      fragment = null;
      fragmentParent = -1;
    };
    var appendTo = function (parentId, child) {
      if (!child) throw new Error("cannot append an unknown node");
      if (parentId !== fragmentParent) {
        flushFragment();
        requireNode(parentId);
        fragmentParent = parentId;
        fragment = document.createDocumentFragment();
      }
      fragment.appendChild(child);
    };
    while (offset < bytes.byteLength) {
      var opcode = view.getUint8(offset);
      offset += 1;
      switch (opcode) {
        case OP_CREATE_ELEMENT: {
          var elementId = readU32();
          var element = document.createElement(readInterned());
          remember(elementId, element);
          break;
        }
        case OP_CREATE_TEXT: {
          var textId = readU32();
          var textNode = document.createTextNode(readString());
          remember(textId, textNode);
          break;
        }
        case OP_SET_TEXT: {
          var textTargetId = readU32();
          var textTarget = requireNode(textTargetId);
          for (var descendant = textTarget.firstChild; descendant; descendant = descendant.nextSibling) drop(descendant);
          textTarget.textContent = readString();
          break;
        }
        case OP_SET_ATTR: {
          var attributeTargetId = readU32();
          requireNode(attributeTargetId).setAttribute(readInterned(), readString());
          break;
        }
        case OP_REMOVE_ATTR: {
          var removeAttributeTargetId = readU32();
          requireNode(removeAttributeTargetId).removeAttribute(readInterned());
          break;
        }
        case OP_APPEND: {
          var appendParentId = readU32();
          var appendChildId = readU32();
          appendTo(appendParentId, requireNode(appendChildId));
          break;
        }
        case OP_INSERT_BEFORE: {
          flushFragment();
          var insertParentId = readU32();
          var insertChildId = readU32();
          var referenceId = readU32();
          requireNode(insertParentId).insertBefore(requireNode(insertChildId), requireNode(referenceId));
          break;
        }
        case OP_REMOVE: {
          flushFragment();
          var removeId = readU32();
          var removedNode = node(removeId);
          if (removedNode && removedNode.parentNode) removedNode.parentNode.removeChild(removedNode);
          if (removedNode) drop(removedNode);
          break;
        }
        case OP_LISTEN: {
          var listenTargetId = readU32();
          attachSlot(listenTargetId, readInterned(), readU32());
          break;
        }
        case OP_UNLISTEN: {
          var unlistenTargetId = readU32();
          detach(unlistenTargetId, readInterned());
          break;
        }
        case OP_SET_PROP: {
          var propertyTargetId = readU32();
          setSafeProperty(requireNode(propertyTargetId), readInterned(), readString(), deferredProperties);
          break;
        }
        case OP_INTERN: {
          var newInternId = readU32();
          if (newInternId === 0 || newInternId >= INTERN_ID_LIMIT) throw new Error("intern id exceeds limit");
          if (interned[newInternId] !== undefined) throw new Error("intern id already defined");
          interned[newInternId] = readString();
          break;
        }
        case OP_ELEMENT_WITH_TEXT: {
          var compoundParentId = readU32();
          var compoundElementId = readU32();
          var compoundTag = readInterned();
          var compoundTextId = readU32();
          var compoundElement = document.createElement(compoundTag);
          var compoundValue = readString();
          var compoundText;
          if (compoundValue.length === 0) {
            compoundText = document.createTextNode("");
            compoundElement.appendChild(compoundText);
          } else {
            compoundElement.textContent = compoundValue;
            compoundText = compoundElement.firstChild;
          }
          remember(compoundElementId, compoundElement);
          remember(compoundTextId, compoundText);
          appendTo(compoundParentId, compoundElement);
          break;
        }
        case OP_ELEMENT_TEXT_BATCH: {
          flushFragment();
          var batchParent = requireNode(readU32());
          var batchTag = readInterned();
          var batchCount = readU32();
          if (batchCount === 0 || batchCount > 65535) throw new Error("element text batch count exceeds limit");
          var batchFragment = document.createDocumentFragment();
          for (var batchIndex = 0; batchIndex < batchCount; batchIndex++) {
            var batchElementId = readU32();
            var batchTextId = readU32();
            var batchElement = document.createElement(batchTag);
            var batchValue = readString();
            var batchText;
            if (batchValue.length === 0) {
              batchText = document.createTextNode("");
              batchElement.appendChild(batchText);
            } else {
              batchElement.textContent = batchValue;
              batchText = batchElement.firstChild;
            }
            remember(batchElementId, batchElement);
            remember(batchTextId, batchText);
            batchFragment.appendChild(batchElement);
          }
          batchParent.appendChild(batchFragment);
          break;
        }
        case OP_CREATE_SVG_ELEMENT: {
          var svgId = readU32();
          var svgTag = readInterned();
          if (SAFE_SVG_TAGS[svgTag] !== 1) throw new Error("unsupported SVG tag: " + svgTag);
          var svgNode = document.createElementNS("http://www.w3.org/2000/svg", svgTag);
          remember(svgId, svgNode);
          break;
        }
        case OP_FOCUS: {
          flushFragment();
          var focusNode = node(readU32());
          if (!focusNode || typeof focusNode.focus !== "function") throw new Error("node is not focusable");
          focusNode.focus({ preventScroll: true });
          break;
        }
        default: throw new Error("unsupported DOM opcode: " + opcode);
      }
    }
    flushFragment();
    for (var propertyIndex = 0; propertyIndex < deferredProperties.length; propertyIndex++) {
      var assignment = deferredProperties[propertyIndex];
      if (assignment.target.isConnected !== false && assignment.target[assignment.name] !== assignment.value) assignment.target[assignment.name] = assignment.value;
    }
  }

  function applyB64(b64) {
    if (typeof b64 !== "string" || b64.length > 22369628) throw new Error("base64 DOM batch exceeds limit");
    try {
      var raw = atob(b64);
      var length = raw.length;
      var bytes = new Uint8Array(length);
      for (var index = 0; index < length; index++) bytes[index] = raw.charCodeAt(index);
      applyBin(bytes);
      if (window.__nt_native === true && !paintScheduled) {
        paintScheduled = true;
        var appliedAt = Date.now();
        requestAnimationFrame(function () {
          var firstFrameAt = Date.now();
          requestAnimationFrame(function () {
            if (window.__nt_bench === true) {
              var fcp = 0;
              var paints = performance.getEntriesByType("paint");
              for (var p = 0; p < paints.length; p++) {
                if (paints[p].name === "first-contentful-paint") {
                  fcp = Math.round(performance.timeOrigin + paints[p].startTime);
                }
              }
              send({ n: 0, t: "__paint", value: appliedAt + "," + firstFrameAt + "," + Date.now() + "," + fcp });
            } else {
              send({ n: 0, t: "__settled" });
            }
          });
        });
      }
    } catch (error) {
      window.__nt_last_error = String(error).slice(0, 512);
      throw error;
    }
  }
  window.__nt = { applyBin: applyBin, applyB64: applyB64 };

  function prepareDocument() {
    if (!document.querySelector('meta[charset]')) {
      var charset = document.createElement("meta");
      charset.setAttribute("charset", "utf-8");
      document.head.appendChild(charset);
    }
    if (!document.querySelector('meta[name="viewport"]')) {
      var viewport = document.createElement("meta");
      viewport.setAttribute("name", "viewport");
      viewport.setAttribute("content", "width=device-width,initial-scale=1");
      document.head.appendChild(viewport);
    }
    if (typeof window.__nt_css === "string") {
      var style = document.createElement("style");
      style.textContent = window.__nt_css;
      document.head.appendChild(style);
    }
    if (!document.getElementById("nt-root")) {
      var mount = document.createElement("div");
      mount.id = "nt-root";
      document.body.appendChild(mount);
    }
  }
  function ready() {
    prepareDocument();
    send({ n: 0, t: "__ready" });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready);
  } else {
    ready();
  }
})();
