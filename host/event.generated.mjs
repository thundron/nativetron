// generated from abi/events.json by abi/generate.mjs — do not edit
export function bindEventCallbacks(target, resolve, symbolPrefix) {
  if (target === null || typeof target !== "object" || typeof resolve !== "function" ||
      typeof symbolPrefix !== "string" || !/^[a-z][a-z0-9]*$/.test(symbolPrefix)) {
    throw new Error("invalid generated event binding");
  }
  var prefix = symbolPrefix + "_";
  var defaultSymbol = prefix + "on_event";
  var primarySymbol = prefix + "on_event_value";
  var richSymbol = prefix + "on_event_rich";
  var defaultBridge = function(slot) {
    if (arguments.length !== 1 ||
        typeof slot !== "number" || slot < 0 || slot > 4294967295 || Math.floor(slot) !== slot) return false;
    var api = resolve();
    var callback = api && api[defaultSymbol];
    if (typeof callback !== "function") return false;
    callback(slot);
    return true;
  };
  target["__nt_event"] = defaultBridge;
  var primaryBridge = function(slot,value) {
    if (arguments.length !== 2 ||
        typeof slot !== "number" || slot < 0 || slot > 4294967295 || Math.floor(slot) !== slot ||
        typeof value !== "string" || value.length > 4096) return false;
    var api = resolve();
    var callback = api && api[primarySymbol];
    if (typeof callback !== "function") return false;
    callback(slot,value);
    return true;
  };
  target["__nt_event_value"] = primaryBridge;
  var richBridge = function(slot,value,checked,key,code,modifiers,inputType) {
    if (arguments.length !== 7 ||
        typeof slot !== "number" || slot < 0 || slot > 4294967295 || Math.floor(slot) !== slot ||
        typeof value !== "string" || value.length > 4096 ||
        typeof checked !== "number" || checked < -1 || checked > 1 || Math.floor(checked) !== checked ||
        typeof key !== "string" || key.length > 64 ||
        typeof code !== "string" || code.length > 64 ||
        typeof modifiers !== "number" || modifiers < 0 || modifiers > 15 || Math.floor(modifiers) !== modifiers ||
        typeof inputType !== "string" || inputType.length > 32) return false;
    var api = resolve();
    var callback = api && api[richSymbol];
    if (typeof callback !== "function") return false;
    callback(slot,value,checked,key,code,modifiers,inputType);
    return true;
  };
  target["__nt_event_rich"] = richBridge;
  return function () {
    if (target["__nt_event"] === defaultBridge) delete target["__nt_event"];
    if (target["__nt_event_value"] === primaryBridge) delete target["__nt_event_value"];
    if (target["__nt_event_rich"] === richBridge) delete target["__nt_event_rich"];
  };
}
