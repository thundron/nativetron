import ReactReconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants.js";

const TEXT = Symbol("text");
const isText = (c) => typeof c === "string" || typeof c === "number";

export function createRenderer(win) {
  let nextId = 1;
  const alloc = () => nextId++;

  const setProps = (inst, props, prev) => {
    for (const key of Object.keys(props)) {
      if (key === "children" || key === "ref" || key === "key") continue;
      const value = props[key];
      if (key.startsWith("on") && typeof value === "function") {
        const type = key.slice(2).toLowerCase();
        const slot = inst.slots.get(type);
        if (slot === undefined) win.listen(inst.id, type, (v) => inst.handlers.get(type)?.(v));
        inst.slots.set(type, true);
        inst.handlers.set(type, value);
        continue;
      }
      if (prev && prev[key] === value) continue;
      if (key === "style" && value && typeof value === "object") {
        win.enc.setAttr(inst.id, "style", styleString(value));
        continue;
      }
      if (value === false || value === null || value === undefined) {
        win.enc.removeAttr(inst.id, attrName(key));
        continue;
      }
      win.enc.setAttr(inst.id, attrName(key), value === true ? "" : String(value));
    }
    if (prev) {
      for (const key of Object.keys(prev)) {
        if (key === "children" || key === "ref" || key === "key") continue;
        if (key in props) continue;
        if (key.startsWith("on")) { inst.handlers.delete(key.slice(2).toLowerCase()); continue; }
        win.enc.removeAttr(inst.id, attrName(key));
      }
    }
  };

  const attrName = (k) => (k === "className" ? "class" : k === "htmlFor" ? "for" : k);
  const dashed = (k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  const styleString = (o) =>
    Object.keys(o)
      .map((k) => `${dashed(k)}:${typeof o[k] === "number" && !UNITLESS.has(k) ? o[k] + "px" : o[k]}`)
      .join(";");

  const config = {
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    isPrimaryRenderer: true,
    noTimeout: -1,
    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,

    createInstance(type, props) {
      const id = alloc();
      const inst = { id, type, kind: "element", slots: new Map(), handlers: new Map() };
      win.enc.createElement(id, type);
      setProps(inst, props, null);
      if (isText(props.children)) win.enc.setText(id, String(props.children));
      return inst;
    },

    createTextInstance(text) {
      const id = alloc();
      win.enc.createText(id, text);
      return { id, kind: TEXT };
    },

    appendInitialChild(parent, child) { win.enc.append(parent.id, child.id); },
    appendChild(parent, child) { win.enc.append(parent.id, child.id); },
    appendChildToContainer(container, child) { win.enc.append(container.id, child.id); },
    insertBefore(parent, child, before) { win.enc.insertBefore(parent.id, child.id, before.id); },
    insertInContainerBefore(container, child, before) { win.enc.insertBefore(container.id, child.id, before.id); },
    removeChild(parent, child) { win.enc.remove(child.id); },
    removeChildFromContainer(container, child) { win.enc.remove(child.id); },

    commitTextUpdate(inst, oldText, newText) { if (oldText !== newText) win.enc.setText(inst.id, newText); },
    commitUpdate(inst, type, prev, next) {
      setProps(inst, next, prev);
      if (isText(next.children) && next.children !== prev.children) {
        win.enc.setText(inst.id, String(next.children));
      }
    },

    finalizeInitialChildren() { return false; },
    prepareUpdate() { return true; },
    shouldSetTextContent(type, props) { return isText(props.children); },
    getRootHostContext() { return {}; },
    getChildHostContext(parent) { return parent; },
    getPublicInstance(inst) { return inst; },
    prepareForCommit() { return null; },
    resetAfterCommit() { win.flush(); },
    preparePortalMount() {},
    clearContainer() {},
    detachDeletedInstance() {},
    maySuspendCommit() { return false; },

    getCurrentUpdatePriority() { return DefaultEventPriority; },
    setCurrentUpdatePriority() {},
    resolveUpdatePriority() { return DefaultEventPriority; },
    getInstanceFromNode() { return null; },
    beforeActiveInstanceBlur() {},
    afterActiveInstanceBlur() {},
    prepareScopeUpdate() {},
    getInstanceFromScope() { return null; },
    shouldAttemptEagerTransition() { return false; },
    requestPostPaintCallback() {},
    trackSchedulerEvent() {},
    resolveEventType() { return null; },
    resolveEventTimeStamp() { return -1.1; },
  };

  const reconciler = ReactReconciler(config);
  const container = reconciler.createContainer({ id: 0 }, 0, null, false, null, "nt", () => {}, null);
  return {
    render(element) { reconciler.updateContainer(element, container, null, null); },
    renderSync(element) {
      reconciler.updateContainerSync(element, container, null, null);
      reconciler.flushSyncWork();
    },
  };
}

const UNITLESS = new Set([
  "opacity", "zIndex", "flex", "flexGrow", "flexShrink", "order", "lineHeight",
  "fontWeight", "zoom", "gridRow", "gridColumn",
]);
