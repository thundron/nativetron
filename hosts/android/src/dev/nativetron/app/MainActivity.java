package dev.nativetron.app;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;

public final class MainActivity extends Activity implements NativeControl.Listener {
  private static final String TAG = "nt-android";
  private static final int MAX_PAGE_QUEUE = 32;
  private static final int MAX_RENDERER_RESTARTS = 2;
  private static final long SELFTEST_TIMEOUT_MS = 30000;
  private static final int TOPIC_CHANGE_COLOUR = 1;

  private final Handler main = new Handler(Looper.getMainLooper());
  private final ArrayDeque<byte[]> pageQueue = new ArrayDeque<>();
  private WebView web;
  private Bridge bridge;
  private NativeControl control;
  private boolean debuggable, destroyed, pageReady, selftest, selftestCommandSent, selftestDone;
  private int rendererRestarts;
  private final Runnable selftestTimeout = () -> finishSelftest("NT_ANDROID_TIMEOUT");

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    Intent intent = getIntent();
    WebView.setWebContentsDebuggingEnabled(debuggable && intent.getBooleanExtra("debug", false));
    blockServiceWorkers();
    control = new NativeControl(this);
    selftest = debuggable && intent.getBooleanExtra("nt.selftest", false);
    if (selftest) {
      Log.i(TAG, "NT_ANDROID_SELFTEST start");
      main.postDelayed(selftestTimeout, SELFTEST_TIMEOUT_MS);
    }
    createWebView();
    lifecycle("create");
  }

  // ── WebView construction and offline bundle policy ─────────────────────

  private void createWebView() {
    web = new WebView(this);
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setAllowFileAccessFromFileURLs(false);
    settings.setAllowUniversalAccessFromFileURLs(false);
    settings.setBlockNetworkLoads(true);
    settings.setGeolocationEnabled(false);
    settings.setSupportMultipleWindows(false);
    settings.setJavaScriptCanOpenWindowsAutomatically(false);
    settings.setMediaPlaybackRequiresUserGesture(true);
    settings.setSafeBrowsingEnabled(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
    bridge = new Bridge(this);
    web.addJavascriptInterface(bridge, "ntEngine");
    web.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onConsoleMessage(ConsoleMessage message) {
        String text = String.valueOf(message.message());
        Log.i("nt-console", text.substring(0, Math.min(text.length(), 8192)) + " @" + message.lineNumber());
        return true;
      }
      @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
      @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) { callback.invoke(origin, false, false); }
      @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) { return false; }
      @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, android.os.Message message) { return false; }
    });
    web.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        return serve(request.getMethod(), request.getUrl());
      }
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        boolean allowed = request.isForMainFrame() && AssetPolicy.isEntry(url.getScheme(), url.getHost(), url.getPort(), url.getEncodedPath());
        if (!allowed) Log.w("nt-offline", "NAVIGATION_BLOCKED " + url.getScheme() + " " + url.getHost());
        return !allowed;
      }
      @Override public void onPageStarted(WebView view, String url, Bitmap icon) {
        Uri uri = Uri.parse(url);
        bridge.trusted = AssetPolicy.isEntry(uri.getScheme(), uri.getHost(), uri.getPort(), uri.getEncodedPath());
        pageReady = false;
        if (!bridge.trusted) Log.w("nt-offline", "PAGE_UNTRUSTED " + uri.getScheme() + " " + uri.getHost());
      }
      @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        Log.e(TAG, "NT_RENDERER_GONE crashed=" + detail.didCrash() + " priority=" + detail.rendererPriorityAtExit());
        if (view != web) return true;
        destroyWebView();
        if (destroyed || isFinishing()) return true;
        if (++rendererRestarts > MAX_RENDERER_RESTARTS) {
          finishSelftest("NT_ANDROID_RENDERER_FAILED");
          finish();
          return true;
        }
        createWebView();
        return true;
      }
    });
    setContentView(web);
    web.loadUrl(AssetPolicy.ORIGIN + "/" + AssetPolicy.ENTRY);
  }

  private WebResourceResponse serve(String method, Uri url) {
    AssetPolicy.Decision decision = AssetPolicy.resolve(method, url.getScheme(), url.getHost(), url.getPort(), url.getEncodedPath(), BundleManifest.FILES);
    if (decision.status == 403) Log.w("nt-offline", "REQUEST_BLOCKED " + url.getScheme() + " " + url.getHost());
    else if (decision.status != 200) Log.w("nt-offline", "REQUEST_REFUSED " + decision.status + " " + url.getEncodedPath());
    InputStream body = new ByteArrayInputStream(new byte[0]);
    int status = decision.status;
    String mime = decision.mime;
    if (status == 200 && decision.body) {
      try { body = getAssets().open(decision.asset, android.content.res.AssetManager.ACCESS_STREAMING); }
      catch (IOException error) { status = 404; mime = "text/plain"; }
    }
    Map<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-store");
    headers.put("Cross-Origin-Opener-Policy", "same-origin");
    headers.put("Cross-Origin-Embedder-Policy", "require-corp");
    headers.put("Cross-Origin-Resource-Policy", "same-origin");
    headers.put("X-Content-Type-Options", "nosniff");
    headers.put("Referrer-Policy", "no-referrer");
    headers.put("Content-Security-Policy", AssetPolicy.contentSecurityPolicy(BundleManifest.SCRIPT_HASHES));
    return new WebResourceResponse(mime, mime.startsWith("text/") || mime.endsWith("json") || mime.endsWith("+xml") ? "utf-8" : null,
      status, AssetPolicy.reason(status), headers, body);
  }

  private static void blockServiceWorkers() {
    ServiceWorkerController controller = ServiceWorkerController.getInstance();
    controller.getServiceWorkerWebSettings().setAllowContentAccess(false);
    controller.getServiceWorkerWebSettings().setAllowFileAccess(false);
    controller.getServiceWorkerWebSettings().setBlockNetworkLoads(true);
    controller.setServiceWorkerClient(new ServiceWorkerClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
        Log.w("nt-offline", "SERVICE_WORKER_BLOCKED");
        return new WebResourceResponse("text/plain", null, 403, "Forbidden", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
      }
    });
  }

  private void destroyWebView() {
    if (web == null) return;
    WebView old = web;
    web = null;
    if (bridge != null) bridge.activity = null;
    bridge = null;
    pageReady = false;
    pageQueue.clear();
    old.removeJavascriptInterface("ntEngine");
    old.stopLoading();
    old.setWebChromeClient(null);
    old.setWebViewClient(new WebViewClient());
    ViewGroup parent = (ViewGroup) old.getParent();
    if (parent != null) parent.removeView(old);
    old.destroy();
  }

  // ── engine↔native bridge through the scriptc control library ──────────

  /** JavaBridge-thread entry. Bounded, rate limited, envelope-validated, then handed to the library owner thread. */
  static final class Bridge {
    volatile MainActivity activity;
    volatile boolean trusted;
    private long windowStart;
    private int messages;
    Bridge(MainActivity activity) { this.activity = activity; }

    @JavascriptInterface public void postMessage(String text) {
      MainActivity target = activity;
      if (target == null || !trusted || text == null) return;
      synchronized (this) {
        long now = SystemClock.elapsedRealtime();
        if (now - windowStart >= 1000) { windowStart = now; messages = 0; }
        if (++messages > EngineProtocol.MAX_RATE) return;
      }
      byte[] bytes = EngineProtocol.decodeEnvelope(text);
      if (bytes == null || !EngineProtocol.fromEngineToNative(bytes)) { Log.w(TAG, "ENGINE_FRAME_REJECTED"); return; }
      target.control.receive(bytes);
    }
  }

  @Override public void onCommandFrame(byte[] frame) {
    if (destroyed) return;
    if (!pageReady) {
      if (pageQueue.size() >= MAX_PAGE_QUEUE) { Log.w(TAG, "PAGE_QUEUE_FULL"); return; }
      pageQueue.add(frame);
      return;
    }
    deliver(frame);
  }

  private void deliver(byte[] frame) {
    if (web == null || !bridge.trusted) return;
    String encoded = Base64.encodeToString(frame, Base64.NO_WRAP);
    web.evaluateJavascript("window.__nt_engine_receive(\"" + encoded + "\")", null);
    int topic = ByteBuffer.wrap(frame).order(ByteOrder.LITTLE_ENDIAN).getInt(8);
    Log.i(TAG, "NT_ANDROID_COMMAND_SENT " + Integer.toUnsignedString(topic));
  }

  @Override public void onEngineFrame(byte[] frame) {
    if (destroyed) return;
    if (!pageReady) {
      // The first engine→native frame proves __nt_engine_receive exists.
      pageReady = true;
      if (selftest) web.evaluateJavascript(AssetProbe.SCRIPT, null);
      while (!pageQueue.isEmpty()) deliver(pageQueue.poll());
    }
    if (frame[1] != 5) { Log.i("nt-engine", "FRAME kind=" + frame[1]); return; }
    byte[] payload = EngineProtocol.payload(frame);
    String text = new String(payload, 0, Math.min(payload.length, 4096), StandardCharsets.UTF_8);
    Log.i("nt-engine", text);
    if (!selftest || selftestDone) return;
    if (text.equals("GPU_READBACK_OK 4096") && !selftestCommandSent) {
      selftestCommandSent = true;
      main.postDelayed(() -> { if (!destroyed) control.command(TOPIC_CHANGE_COLOUR, new byte[0]); }, 250);
    } else if (text.equals("GPU_COLOUR_CHANGED") && selftestCommandSent) {
      finishSelftest("NT_ANDROID_OK");
    } else {
      String failure = SelftestResult.failure(text);
      if (failure != null) finishSelftest(failure);
    }
  }

  @Override public void onFailure(String operation, int status, String detail) {
    if (destroyed) return;
    if (selftest && (operation.equals("open") || operation.equals("command") || status == NativeControl.POISONED)) {
      finishSelftest("NT_ANDROID_CONTROL_FAILED " + operation + " " + status);
    }
    invalidateOptionsMenu();
  }

  private void finishSelftest(String marker) {
    if (!selftest || selftestDone) return;
    selftestDone = true;
    main.removeCallbacks(selftestTimeout);
    Log.i(TAG, marker);
  }

  // ── native menu and debuggable-only runner commands ────────────────────

  @Override public boolean onCreateOptionsMenu(Menu menu) { menu.add(0, 1, 0, "Change clear colour"); return true; }
  @Override public boolean onPrepareOptionsMenu(Menu menu) {
    MenuItem item = menu.findItem(1);
    if (item != null) item.setEnabled(control != null && control.ready());
    return true;
  }
  @Override public boolean onOptionsItemSelected(MenuItem item) {
    if (item.getItemId() != 1) return super.onOptionsItemSelected(item);
    control.command(TOPIC_CHANGE_COLOUR, new byte[0]);
    return true;
  }

  @Override protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    if (!debuggable) return;
    if (intent.hasExtra("nt.command")) {
      int topic = intent.getIntExtra("nt.command", -1);
      if (topic >= 0) control.command(topic, new byte[0]);
      else Log.w(TAG, "NT_ANDROID_COMMAND_REJECTED");
    }
    if (intent.getBooleanExtra("nt.finish", false)) finish();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  private static void lifecycle(String phase) { Log.i(TAG, "NT_LIFECYCLE " + phase); }

  @Override protected void onStart() { super.onStart(); lifecycle("start"); }
  @Override protected void onResume() {
    super.onResume();
    if (web != null) { web.onResume(); web.resumeTimers(); }
    lifecycle("resume");
  }
  @Override protected void onPause() {
    if (web != null) { web.onPause(); web.pauseTimers(); }
    lifecycle("pause");
    super.onPause();
  }
  @Override protected void onStop() {
    control.collect();
    lifecycle("stop");
    super.onStop();
  }
  @Override public void onTrimMemory(int level) {
    super.onTrimMemory(level);
    control.collect();
    lifecycle("trim " + level);
  }
  @Override protected void onDestroy() {
    destroyed = true;
    main.removeCallbacksAndMessages(null);
    destroyWebView();
    control.close();
    lifecycle("destroy");
    Log.i(TAG, "NT_ANDROID_DISPOSED");
    super.onDestroy();
  }
}
