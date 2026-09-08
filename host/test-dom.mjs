export function makeTestNode(kind, tag) {
  return {
    kind,
    tag,
    namespace: "html",
    children: [],
    attrs: {},
    listeners: {},
    parentNode: null,
    _text: "",
    focusCount: 0,
    set textContent(value) {
      this._text = String(value);
      if (this.kind !== "element") return;
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      if (value === "") return;
      const text = makeTestNode("text", null);
      text._text = String(value);
      text.parentNode = this;
      this.children.push(text);
    },
    get textContent() {
      return this.kind === "text"
        ? this._text
        : this.children.map((child) => child.textContent).join("");
    },
    get firstChild() { return this.children[0] ?? null; },
    get nextSibling() {
      if (!this.parentNode) return null;
      const index = this.parentNode.children.indexOf(this);
      return this.parentNode.children[index + 1] ?? null;
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    appendChild(child) {
      if (child.kind === "fragment") {
        for (const nested of child.children.slice()) this.appendChild(nested);
        child.children = [];
        return child;
      }
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, reference) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      const index = this.children.indexOf(reference);
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    removeEventListener(type, handler) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((candidate) => candidate !== handler);
    },
    focus(options) {
      this.focusCount++;
      this.focusOptions = options;
    },
  };
}

export function createTestDocument(initialRoot = makeTestNode("element", "div")) {
  let root = initialRoot;
  const head = makeTestNode("element", "head");
  const body = makeTestNode("element", "body");
  body.appendChild(root);
  return {
    document: {
      readyState: "complete",
      head,
      body,
      getElementById: (id) => id === "nt-root" ? root : null,
      querySelector: (selector) => {
        if (selector === "meta[charset]") {
          return head.children.find((node) => Object.hasOwn(node.attrs, "charset")) ?? null;
        }
        if (selector === 'meta[name="viewport"]') {
          return head.children.find((node) => node.attrs.name === "viewport") ?? null;
        }
        return null;
      },
      createElement: (tag) => makeTestNode("element", tag),
      createElementNS: (namespace, tag) => {
        const node = makeTestNode("element", tag);
        node.namespace = namespace;
        return node;
      },
      createTextNode: (value) => {
        const node = makeTestNode("text", null);
        node._text = String(value);
        return node;
      },
      createDocumentFragment: () => makeTestNode("fragment", null),
      addEventListener() {},
    },
    root: () => root,
    setRoot(next) {
      if (root.parentNode) root.parentNode.removeChild(root);
      root = next;
      body.appendChild(root);
    },
  };
}
