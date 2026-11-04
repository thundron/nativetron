// generated from engine/assets.json by engine/generate-assets.mjs — do not edit
package dev.nativetron.app;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
final class BundledAssets {
  static final String ENTRY = "engine/page.html";
  static final Map<String, String> FILES;
  static {
    Map<String, String> files = new HashMap<>();
    files.put("engine/page.html", "text/html");
    files.put("engine/host.js", "text/javascript");
    files.put("engine/worker.js", "text/javascript");
    files.put("engine/reactor.js", "text/javascript");
    files.put("engine/.scriptc/ui.mjs", "text/javascript");
    files.put("engine/.scriptc/ui.wasm", "application/wasm");
    files.put("gpu/.scriptc/demo.mjs", "text/javascript");
    files.put("gpu/.scriptc/demo.wasm", "application/wasm");
    files.put("gpu/host.js", "text/javascript");
    files.put("gpu/gpu-host.generated.js", "text/javascript");
    files.put("host/dom-host.js", "text/javascript");
    files.put("host/event.generated.mjs", "text/javascript");
    files.put("ipc/engine.generated.mjs", "text/javascript");
    files.put("ipc/engine-bridge.generated.mjs", "text/javascript");
    FILES = Collections.unmodifiableMap(files);
  }
}
