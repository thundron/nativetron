package dev.nativetron.app;

import java.util.Locale;
import java.util.Set;

/** Virtual-HTTPS bundle policy. Pure Java so host tests run it without Android. */
final class AssetPolicy {
  static final String SCHEME = "https";
  static final String HOST = "appassets.androidplatform.net";
  static final String ORIGIN = SCHEME + "://" + HOST;
  static final String ENTRY = "engine/page.html";
  static final int MAX_PATH = 512;

  static final class Decision {
    final int status;
    final String asset;
    final String mime;
    final boolean body;
    Decision(int status, String asset, String mime, boolean body) { this.status = status; this.asset = asset; this.mime = mime; this.body = body; }
  }

  private AssetPolicy() {}

  /** MIME for a bundled asset extension, or null when the extension is not servable. */
  static String mime(String path) {
    String value = path.toLowerCase(Locale.ROOT);
    if (value.endsWith(".wasm")) return "application/wasm";
    if (value.endsWith(".js") || value.endsWith(".mjs")) return "text/javascript";
    if (value.endsWith(".html")) return "text/html";
    if (value.endsWith(".css")) return "text/css";
    if (value.endsWith(".json")) return "application/json";
    if (value.endsWith(".svg")) return "image/svg+xml";
    if (value.endsWith(".png")) return "image/png";
    return null;
  }

  static boolean sameOrigin(String scheme, String host, int port) {
    return SCHEME.equals(scheme) && HOST.equals(host) && (port == -1 || port == 443);
  }

  static boolean isEntry(String scheme, String host, int port, String encodedPath) {
    return sameOrigin(scheme, host, port) && ("/" + ENTRY).equals(encodedPath);
  }

  /**
   * Resolves one request. Only GET/HEAD for an allowlisted bundle path on the
   * virtual origin succeeds. The encoded path is checked so percent-encoded
   * separators or dot segments cannot reach AssetManager after decoding.
   */
  static Decision resolve(String method, String scheme, String host, int port, String encodedPath, Set<String> bundle) {
    if (!sameOrigin(scheme, host, port)) return new Decision(403, null, "text/plain", false);
    boolean head = "HEAD".equals(method);
    if (!head && !"GET".equals(method)) return new Decision(405, null, "text/plain", false);
    if (encodedPath == null || encodedPath.length() < 2 || encodedPath.length() > MAX_PATH || encodedPath.charAt(0) != '/') return new Decision(404, null, "text/plain", false);
    for (int i = 0; i < encodedPath.length(); i++) {
      char c = encodedPath.charAt(i);
      boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '/' || c == '.' || c == '-' || c == '_';
      if (!ok) return new Decision(404, null, "text/plain", false);
    }
    String asset = encodedPath.substring(1);
    for (String part : asset.split("/", -1)) {
      if (part.isEmpty() || part.equals(".") || part.equals("..")) return new Decision(404, null, "text/plain", false);
    }
    String mime = mime(asset);
    if (mime == null || !bundle.contains(asset)) return new Decision(404, null, "text/plain", false);
    return new Decision(200, asset, mime, !head);
  }

  static String reason(int status) {
    switch (status) {
      case 200: return "OK";
      case 403: return "Forbidden";
      case 404: return "Not Found";
      case 405: return "Method Not Allowed";
      default: return "Error";
    }
  }

  /** Content-Security-Policy for bundle responses; inline scripts must match a build-time hash. */
  static String contentSecurityPolicy(String scriptHashes) {
    return "default-src 'none'; script-src 'self' " + scriptHashes + " 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; base-uri 'none'; form-action 'none'; " +
      "frame-src 'none'; object-src 'none'; frame-ancestors 'none'";
  }
}
