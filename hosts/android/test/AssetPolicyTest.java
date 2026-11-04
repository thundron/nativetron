package dev.nativetron.app;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Host-JVM checks of the virtual-HTTPS bundle policy (no Android runtime). */
public final class AssetPolicyTest {
  private static int failures;
  private static void check(boolean condition, String label) { if (!condition) { failures++; System.err.println("FAIL " + label); } }
  private static AssetPolicy.Decision get(String path) { return AssetPolicy.resolve("GET", "https", AssetPolicy.HOST, -1, path, BUNDLE); }
  private static final Set<String> BUNDLE = new HashSet<>(Arrays.asList(
    "engine/page.html", "engine/host.js", "engine/worker.js", "engine/.scriptc/ui.wasm", "engine/.scriptc/ui.mjs", "gpu/.scriptc/demo.wasm",
    "ipc/engine.generated.mjs", "style/app.css", "data/table.json", "secret.bin"));

  public static void main(String[] args) {
    check(SelftestResult.failure("GPU_UNAVAILABLE no adapter").startsWith("NT_ANDROID_UNAVAILABLE"), "only unavailability is blocked");
    for (String error : new String[] { "GPU_ERROR bad shader", "GPU_ERROR device lost", "GPU_READBACK_FAILED" }) check(SelftestResult.failure(error).startsWith("NT_ANDROID_GPU_FAILED"), "GPU errors fail acceptance");
    check(SelftestResult.failure("GPU_READBACK_OK 4096") == null, "successful reports are not failures");
    AssetPolicy.Decision page = get("/engine/page.html");
    check(page.status == 200 && "text/html".equals(page.mime) && page.body && "engine/page.html".equals(page.asset), "entry page");
    check("application/wasm".equals(get("/engine/.scriptc/ui.wasm").mime), "wasm MIME");
    check("text/javascript".equals(get("/engine/.scriptc/ui.mjs").mime), "mjs MIME");
    check("text/javascript".equals(get("/engine/worker.js").mime), "worker MIME");
    check("text/css".equals(AssetPolicy.mime("style/app.css")), "css MIME");
    check(get("/style/app.css").status == 404, "unmanifested CSS refused");
    check("application/json".equals(AssetPolicy.mime("data/table.json")), "json MIME");
    check(get("/data/table.json").status == 404, "unmanifested JSON refused");
    check(get("/secret.bin").status == 404, "unknown extension not served even if bundled");
    check(get("/engine/missing.js").status == 404, "unbundled file");
    check(get("/").status == 404, "root");
    check(get("").status == 404 && get(null).status == 404, "empty path");
    for (String path : new String[] {
      "/engine/../engine/page.html", "/engine/./page.html", "/engine//page.html", "/engine/%2e%2e/page.html", "/engine%2fpage.html",
      "/engine/page.html%00", "/engine\\page.html", "/engine/page.html/", "/ENGINE/PAGE.HTML", "/engine/page.html;x", "//engine/page.html",
      "/engine/page.html?x", "/engine/pa ge.html", "/engine/\u00e9.html", "/" + "a".repeat(600) + ".js"
    }) check(get(path).status == 404, "path refused: " + path);
    check(AssetPolicy.resolve("GET", "http", AssetPolicy.HOST, -1, "/engine/page.html", BUNDLE).status == 403, "cleartext scheme");
    check(AssetPolicy.resolve("GET", "https", "example.com", -1, "/engine/page.html", BUNDLE).status == 403, "foreign host");
    check(AssetPolicy.resolve("GET", "https", "APPASSETS.androidplatform.net", -1, "/engine/page.html", BUNDLE).status == 403, "host case");
    check(AssetPolicy.resolve("GET", "https", AssetPolicy.HOST, 8443, "/engine/page.html", BUNDLE).status == 403, "foreign port");
    check(AssetPolicy.resolve("GET", "https", AssetPolicy.HOST, 443, "/engine/page.html", BUNDLE).status == 200, "explicit 443");
    check(AssetPolicy.resolve("GET", "file", null, -1, "/engine/page.html", BUNDLE).status == 403, "file scheme");
    check(AssetPolicy.resolve("GET", "data", null, -1, "text/html,x", BUNDLE).status == 403, "data scheme");
    check(AssetPolicy.resolve("POST", "https", AssetPolicy.HOST, -1, "/engine/page.html", BUNDLE).status == 405, "POST");
    check(AssetPolicy.resolve("PUT", "https", AssetPolicy.HOST, -1, "/engine/page.html", BUNDLE).status == 405, "PUT");
    AssetPolicy.Decision head = AssetPolicy.resolve("HEAD", "https", AssetPolicy.HOST, -1, "/engine/page.html", BUNDLE);
    check(head.status == 200 && !head.body, "HEAD has no body");
    check(AssetPolicy.isEntry("https", AssetPolicy.HOST, -1, "/engine/page.html"), "entry navigation");
    check(!AssetPolicy.isEntry("https", AssetPolicy.HOST, -1, "/engine/host.js"), "non-entry navigation");
    check(!AssetPolicy.isEntry("https", "evil.example", -1, "/engine/page.html"), "foreign navigation");
    String csp = AssetPolicy.contentSecurityPolicy("'sha256-abc='");
    check(csp.startsWith("default-src 'none';") && csp.contains("script-src 'self' 'sha256-abc=' 'wasm-unsafe-eval';") && csp.contains("connect-src 'self';")
      && csp.contains("worker-src 'self';") && !csp.contains(" 'unsafe-eval'") && !csp.contains("script-src 'self' 'unsafe-inline'"), "CSP");
    // args: ext=mime pairs from tools/bundle-manifest.mjs; both tables must agree.
    check(args.length > 0, "build-time MIME table supplied");
    for (String pair : args) {
      String[] parts = pair.split("=", 2);
      check(parts[1].equals(AssetPolicy.mime("file" + parts[0])), "MIME table agrees for " + parts[0]);
    }
    for (int status : new int[] { 200, 403, 404, 405 }) check(!AssetPolicy.reason(status).isEmpty(), "reason " + status);
    if (failures != 0) { System.err.println("asset policy test: " + failures + " failure(s)"); System.exit(1); }
    System.out.println("asset policy test: ok");
  }
}
