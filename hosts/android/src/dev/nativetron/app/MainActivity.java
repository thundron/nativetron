package dev.nativetron.app;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public final class MainActivity extends Activity {
  private static final String HOST = "appassets.androidplatform.net";
  private static final String ORIGIN = "https://" + HOST;
  private WebView web;
  private long windowStart = 0;
  private int messages = 0;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    web = new WebView(this);
    WebView.setWebContentsDebuggingEnabled(getIntent().getBooleanExtra("debug", false));
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    web.addJavascriptInterface(new Object() {
      @JavascriptInterface public synchronized void postMessage(String text) {
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - windowStart >= 1000) { windowStart = now; messages = 0; }
        if (++messages > EngineProtocol.MAX_RATE) return;
        byte[] bytes = EngineProtocol.decodeEnvelope(text);
        if (bytes == null || !EngineProtocol.fromEngineToNative(bytes)) return;
        Log.i("nt-engine", new String(EngineProtocol.payload(bytes), java.nio.charset.StandardCharsets.UTF_8));
      }
    }, "ntEngine");
    web.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onConsoleMessage(ConsoleMessage message) {
        String text = message.message();
        Log.i("nt-console", text.substring(0, Math.min(text.length(), 8192)) + " @" + message.lineNumber());
        return true;
      }
    });
    web.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if (!"https".equals(url.getScheme()) || !HOST.equals(url.getHost())) return response(403, "text/plain", new ByteArrayInputStream(new byte[0]));
        String path = url.getPath();
        if (path == null || path.equals("/")) path = "/engine/page.html";
        for (String part : path.split("/")) if (part.equals("..") || part.equals(".") || part.indexOf('\\') >= 0) return response(403, "text/plain", new ByteArrayInputStream(new byte[0]));
        try { return response(200, mime(path), getAssets().open(path.substring(1))); }
        catch (IOException error) { return response(404, "text/plain", new ByteArrayInputStream(new byte[0])); }
      }
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return !"https".equals(request.getUrl().getScheme()) || !HOST.equals(request.getUrl().getHost());
      }
    });
    setContentView(web);
    web.loadUrl(ORIGIN + "/engine/page.html");
  }
  private static WebResourceResponse response(int status, String mime, java.io.InputStream body) {
    Map<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-store");
    headers.put("Cross-Origin-Opener-Policy", "same-origin");
    headers.put("Cross-Origin-Embedder-Policy", "require-corp");
    return new WebResourceResponse(mime, mime.startsWith("text/") ? "utf-8" : null, status, status == 200 ? "OK" : "Not Found", headers, body);
  }
  private static String mime(String path) {
    String value = path.toLowerCase(Locale.ROOT);
    if (value.endsWith(".wasm")) return "application/wasm";
    if (value.endsWith(".js") || value.endsWith(".mjs")) return "text/javascript";
    if (value.endsWith(".html")) return "text/html";
    if (value.endsWith(".css")) return "text/css";
    if (value.endsWith(".json")) return "application/json";
    return "application/octet-stream";
  }
  @Override public boolean onCreateOptionsMenu(Menu menu) { menu.add("Change clear colour"); return true; }
  @Override public boolean onOptionsItemSelected(MenuItem item) {
    byte[] bytes = EngineProtocol.command(1, new byte[0]);
    web.evaluateJavascript("window.__nt_engine_receive(\"" + Base64.encodeToString(bytes, Base64.NO_WRAP) + "\")", null);
    return true;
  }
  @Override protected void onPause() { web.onPause(); super.onPause(); }
  @Override protected void onResume() { super.onResume(); web.onResume(); }
  @Override protected void onDestroy() { web.removeJavascriptInterface("ntEngine"); web.destroy(); super.onDestroy(); }
}
