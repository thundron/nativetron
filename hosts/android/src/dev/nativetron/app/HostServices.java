package dev.nativetron.app;

import android.app.Activity;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.*;
import android.print.*;
import android.print.pdf.*;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.*;
import org.json.*;

/** Main-page-only service broker. Files stay behind opaque, bounded leases. */
public final class HostServices {
  private static int nextPickerRequest = 23171;
  private int pickerRequest = -1;
  private static synchronized int pickerRequest() {
    if (nextPickerRequest > 65535)
      throw new IllegalStateException("picker request IDs exhausted");
    return nextPickerRequest++;
  }
  private static HostArchive shared;
  private static final List<HostArchive.Info> incoming = new ArrayList<>();
  private static synchronized HostArchive archive(Activity activity) throws IOException {
    if (shared == null)
      shared = new HostArchive(new File(activity.getFilesDir(), "nt-documents"));
    return shared;
  }
  private static final class Session {
    final String token = UUID.randomUUID().toString();
    final Set<String> active = new HashSet<>(), writes = new HashSet<>(), leases = new HashSet<>();
    JSONArray shortcuts = new JSONArray();
  }
  private interface Done {
    void finish(Object value, Throwable error);
  }
  private final Activity activity;
  private final BiFunction<String, Uri, WebResourceResponse> assets;
  private final WebView web;
  private final ThreadPoolExecutor io =
      new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(32), r -> {
        Thread t = new Thread(r, "nt-host-io");
        t.setDaemon(true);
        return t;
      });
  private volatile Session session = new Session();
  private volatile boolean closed, trusted;
  private String pickerKind;
  private Done pickerDone;
  private File pickerSource;
  private Runnable cancelPDF;
  public HostServices(
      Activity activity, WebView web, BiFunction<String, Uri, WebResourceResponse> assets) {
    this.activity = activity;
    this.web = web;
    this.assets = assets;
    web.addJavascriptInterface(new Bridge(), "ntHost");
  }
  public final class Bridge {
    @JavascriptInterface
    public void postMessage(String text) {
      if (text == null || text.length() > 512 * 1024)
        return;
      activity.runOnUiThread(() -> receive(text));
    }
  }
  public void pageStarted(Uri url) {
    if (closed)
      return;
    Session old = session;
    session = new Session();
    trusted =
        AssetPolicy.isEntry(url.getScheme(), url.getHost(), url.getPort(), url.getEncodedPath());
    if (pickerDone != null) {
      Done done = pickerDone;
      pickerDone = null;
      pickerSource = null;
      int request = pickerRequest;
      pickerRequest = -1;
      activity.finishActivity(request);
      done.finish(null, new IOException("page replaced"));
    }
    if (cancelPDF != null) {
      cancelPDF.run();
      cancelPDF = null;
    }
    io.execute(() -> cleanup(old));
    activity.invalidateOptionsMenu();
  }
  public void pageFinished() {
    if (closed || !trusted)
      return;
    web.evaluateJavascript("window.__ntHostToken=" + JSONObject.quote(session.token)
            + ";window.dispatchEvent(new Event('nt-host-ready'));",
        null);
  }
  private void receive(String text) {
    if (closed || !trusted)
      return;
    try {
      if (text.getBytes(StandardCharsets.UTF_8).length > 512 * 1024)
        return;
      JSONObject request = new JSONObject(text);
      if (request.optInt("ntHost") != 1 || !session.token.equals(request.optString("token")))
        return;
      Object idObject = request.get("id");
      if (!(idObject instanceof Integer || idObject instanceof Long))
        return;
      long id = request.getLong("id");
      if (id <= 0 || id > 9007199254740991L)
        return;
      String caller = request.getString("session"), method = request.getString("method");
      if (!caller.matches("[A-Za-z0-9-]{1,80}") || method.length() > 64)
        return;
      JSONObject args = request.getJSONObject("args");
      Session current = session;
      String key = caller + ":" + id;
      if (current.active.size() >= 16 || !current.active.add(key)) {
        reply(current, caller, id, null, new IOException("host request capacity exceeded"));
        return;
      }
      Done done = (value, error) -> activity.runOnUiThread(() -> {
        current.active.remove(key);
        reply(current, caller, id, value, error);
      });
      try {
        io.execute(() -> {
          if (closed || current != session)
            return;
          try {
            perform(current, method, args, done);
          } catch (Throwable error) {
            done.finish(null, error);
          }
        });
      } catch (RejectedExecutionException error) {
        done.finish(null, error);
      }
    } catch (JSONException ignored) {
    }
  }
  private void reply(Session current, String caller, long id, Object value, Throwable error) {
    if (closed || !trusted || current != session)
      return;
    try {
      JSONObject response = new JSONObject()
                                .put("ntHost", 1)
                                .put("session", caller)
                                .put("id", id)
                                .put("ok", error == null);
      if (error == null)
        response.put("value", value == null ? JSONObject.NULL : value);
      else
        response.put("error",
            new JSONObject()
                .put("code",
                    error instanceof UnsupportedOperationException ? "unsupported"
                        : error instanceof SecurityException       ? "permission-denied"
                        : error instanceof CancellationException   ? "cancelled"
                                                                   : "host-error")
                .put("message", String.valueOf(error.getMessage())));
      web.evaluateJavascript("window.__ntHostReceive?.(" + response + ")", null);
    } catch (JSONException ignored) {
    }
  }
  private void event(String name, Object value) {
    final Object payload = JSONObject.wrap(value);
    activity.runOnUiThread(() -> {
      if (closed || !trusted)
        return;
      try {
        web.evaluateJavascript("window.__ntHostReceive?.("
                + new JSONObject().put("ntHost", 1).put("event", name).put("value", payload) + ")",
            null);
      } catch (JSONException ignored) {
      }
    });
  }
  private static JSONObject info(HostArchive.Info file) throws JSONException {
    return new JSONObject().put("file", file.file).put("name", file.name).put("size", file.size);
  }
  private boolean owns(Session s, String file) {
    if (s.leases.contains(file))
      return true;
    synchronized (incoming) {
      for (HostArchive.Info item : incoming)
        if (item.file.equals(file))
          return true;
    }
    return false;
  }
  private static long integer(JSONObject args, String field) throws JSONException {
    Object value = args.get(field);
    if (!(value instanceof Integer || value instanceof Long) || ((Number) value).longValue() < 0)
      throw new JSONException("invalid " + field);
    return ((Number) value).longValue();
  }
  private void perform(Session current, String method, JSONObject args, Done done)
      throws Exception {
    if (method.equals("capabilities")) {
      done.finish(new JSONObject()
                      .put("version", 1)
                      .put("files", true)
                      .put("share", true)
                      .put("gallery", true)
                      .put("pdf", true)
                      .put("pdfOutput", "system-dialog")
                      .put("print", true)
                      .put("archive", true)
                      .put("shortcuts", true)
                      .put("maxFileBytes", HostArchive.MAX_FILE)
                      .put("chunkBytes", HostArchive.CHUNK),
          null);
      return;
    }
    if (method.equals("files.incoming")) {
      JSONArray result = new JSONArray();
      synchronized (incoming) {
        for (HostArchive.Info item : incoming) result.put(info(item));
      }
      done.finish(result, null);
      return;
    }
    HostArchive store = archive(activity);
    switch (method) {
      case "archive.begin": {
        String id = store.begin(args.getString("key"), integer(args, "size"));
        current.writes.add(id);
        done.finish(id, null);
        break;
      }
      case "archive.write": {
        String id = args.getString("transaction");
        if (!current.writes.contains(id))
          throw new IOException("unknown transaction");
        byte[] bytes =
            android.util.Base64.decode(args.getString("data"), android.util.Base64.NO_WRAP);
        store.write(id, integer(args, "offset"), bytes);
        done.finish(true, null);
        break;
      }
      case "archive.commit": {
        String id = args.getString("transaction");
        if (!current.writes.contains(id))
          throw new IOException("unknown transaction");
        long size = store.commit(id);
        current.writes.remove(id);
        done.finish(new JSONObject().put("size", size), null);
        break;
      }
      case "archive.abort": {
        String id = args.getString("transaction");
        if (current.writes.remove(id))
          store.abort(id);
        done.finish(true, null);
        break;
      }
      case "archive.list": {
        JSONArray result = new JSONArray();
        for (Map.Entry<String, Long> item : store.list().entrySet())
          result.put(new JSONObject().put("key", item.getKey()).put("size", item.getValue()));
        done.finish(result, null);
        break;
      }
      case "archive.delete":
        store.remove(args.getString("key"));
        done.finish(true, null);
        break;
      case "archive.stat": {
        HostArchive.Info file = store.snapshot(args.getString("key"));
        current.leases.add(file.file);
        done.finish(info(file), null);
        break;
      }
      case "files.read": {
        String id = args.getString("file");
        if (!owns(current, id))
          throw new IOException("unknown file lease");
        long length = integer(args, "length");
        if (length > HostArchive.CHUNK)
          throw new IOException("file range too large");
        done.finish(
            android.util.Base64.encodeToString(
                store.read(id, integer(args, "offset"), (int) length), android.util.Base64.NO_WRAP),
            null);
        break;
      }
      case "files.release": {
        String id = args.getString("file");
        if (!owns(current, id))
          throw new IOException("unknown file lease");
        current.leases.remove(id);
        synchronized (incoming) {
          incoming.removeIf(item -> item.file.equals(id));
        }
        store.release(id);
        done.finish(true, null);
        break;
      }
      case "shortcuts.set": {
        JSONArray shortcuts = args.getJSONArray("shortcuts");
        validateShortcuts(shortcuts);
        activity.runOnUiThread(() -> {
          if (current != session || closed)
            return;
          current.shortcuts = shortcuts;
          activity.invalidateOptionsMenu();
          done.finish(true, null);
        });
        break;
      }
      case "files.pick":
      case "gallery.pick":
        activity.runOnUiThread(() -> {
          if (current != session || closed)
            return;
          try {
            pick(method, args, done);
          } catch (Throwable error) {
            done.finish(null, error);
          }
        });
        break;
      case "files.save":
      case "files.share":
      case "gallery.save": {
        String id = args.getString("file");
        if (!owns(current, id))
          throw new IOException("unknown file lease");
        File source = store.file(id);
        if (method.equals("gallery.save")) {
          saveGallery(source, args);
          done.finish(true, null);
        } else if (method.equals("files.share")) {
          Uri uri =
              HostFileProvider.snapshot(activity, source, args.optString("name", "project.bin"),
                  args.optString("mime", "application/octet-stream"));
          activity.runOnUiThread(() -> {
            if (current != session || closed)
              return;
            try {
              Intent intent = new Intent(Intent.ACTION_SEND)
                                  .setType(args.optString("mime", "application/octet-stream"))
                                  .putExtra(Intent.EXTRA_STREAM, uri)
                                  .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
              intent.setClipData(ClipData.newUri(activity.getContentResolver(), "export", uri));
              activity.startActivity(Intent.createChooser(intent, "Share"));
              done.finish(new JSONObject().put("status", "presented"), null);
            } catch (Throwable error) {
              done.finish(null, error);
            }
          });
        } else
          activity.runOnUiThread(() -> {
            if (current != session || closed)
              return;
            try {
              save(source, args, done);
            } catch (Throwable error) {
              done.finish(null, error);
            }
          });
        break;
      }
      case "document.pdf":
      case "document.print":
        activity.runOnUiThread(() -> {
          if (current != session || closed)
            return;
          try {
            document(current, method.equals("document.print"), args, done);
          } catch (Throwable error) {
            done.finish(null, error);
          }
        });
        break;
      default:
        throw new UnsupportedOperationException("unsupported host service: " + method);
    }
  }
  private void pick(String kind, JSONObject args, Done done) {
    if (pickerDone != null)
      throw new IllegalStateException("document picker busy");
    Intent intent;
    if (kind.equals("gallery.pick") && Build.VERSION.SDK_INT >= 33 && !args.optBoolean("multiple"))
      intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
    else {
      intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                   .addCategory(Intent.CATEGORY_OPENABLE)
                   .setType("*/*")
                   .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.optBoolean("multiple"));
      if (kind.equals("gallery.pick"))
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"image/*", "video/*"});
      else if ((args.optJSONArray("mimeTypes") != null || args.optJSONArray("types") != null)) {
        JSONArray types = args.optJSONArray("mimeTypes") != null ? args.optJSONArray("mimeTypes")
                                                                 : args.optJSONArray("types");
        if (types.length() > 16)
          throw new IllegalArgumentException("too many document types");
        String[] values = new String[types.length()];
        for (int i = 0; i < values.length; i++) values[i] = types.optString(i);
        intent.putExtra(Intent.EXTRA_MIME_TYPES, values);
      }
    }
    pickerDone = done;
    pickerKind = "pick";
    pickerSource = null;
    try {
      pickerRequest = pickerRequest();
      activity.startActivityForResult(intent, pickerRequest);
    } catch (RuntimeException error) {
      pickerDone = null;
      throw error;
    }
  }
  private void save(File source, JSONObject args, Done done) {
    if (pickerDone != null)
      throw new IllegalStateException("document picker busy");
    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType(args.optString("mime", "application/octet-stream"))
                        .putExtra(Intent.EXTRA_TITLE, args.optString("name", "project.bin"));
    pickerDone = done;
    pickerKind = "save";
    pickerSource = source;
    try {
      pickerRequest = pickerRequest();
      activity.startActivityForResult(intent, pickerRequest);
    } catch (RuntimeException error) {
      pickerDone = null;
      pickerSource = null;
      throw error;
    }
  }
  public boolean result(int request, int result, Intent intent) {
    if (request != pickerRequest)
      return false;
    pickerRequest = -1;
    Done done = pickerDone;
    File source = pickerSource;
    String kind = pickerKind;
    pickerDone = null;
    pickerSource = null;
    if (done == null)
      return true;
    if (result != Activity.RESULT_OK || intent == null) {
      done.finish(null, new CancellationException("cancelled"));
      return true;
    }
    Session current = session;
    io.execute(() -> {
      List<HostArchive.Info> imported = new ArrayList<>();
      try {
        if (current != session || closed)
          return;
        if ("save".equals(kind)) {
          Uri target = intent.getData();
          if (target == null)
            throw new IOException("missing export target");
          try (InputStream input = new FileInputStream(source);
              OutputStream output = activity.getContentResolver().openOutputStream(target, "wt")) {
            if (output == null)
              throw new IOException("cannot open target");
            copy(input, output);
          }
          done.finish(true, null);
        } else {
          List<Uri> uris = new ArrayList<>();
          if (intent.getClipData() != null) {
            ClipData clip = intent.getClipData();
            if (clip.getItemCount() > 16)
              throw new IOException("too many documents");
            for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
          } else if (intent.getData() != null)
            uris.add(intent.getData());
          JSONArray files = new JSONArray();
          for (Uri uri : uris) {
            HostArchive.Info file = importUri(uri);
            imported.add(file);
            current.leases.add(file.file);
            files.put(info(file));
          }
          done.finish(files, null);
        }
      } catch (Throwable error) {
        for (HostArchive.Info item : imported) {
          try {
            archive(activity).release(item.file);
          } catch (IOException ignored) {
          }
          current.leases.remove(item.file);
        }
        done.finish(null, error);
      }
    });
    return true;
  }
  private HostArchive.Info importUri(Uri uri) throws IOException {
    if (uri == null || !"content".equals(uri.getScheme()))
      throw new IOException("unsupported incoming document URI");
    String name = "document.bin";
    if ("content".equals(uri.getScheme()))
      try (Cursor cursor = activity.getContentResolver().query(
               uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
        if (cursor != null && cursor.moveToFirst())
          name = cursor.getString(0);
      }
    else
      throw new IOException("incoming documents require a content URI grant");
    try (InputStream input = activity.getContentResolver().openInputStream(uri)) {
      if (input == null)
        throw new IOException("cannot open document");
      return archive(activity).importFile(input, name);
    }
  }
  public void openIntent(Intent intent) {
    if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())
        || intent.getData() == null)
      return;
    Uri uri = intent.getData();
    io.execute(() -> {
      try {
        synchronized (incoming) {
          if (incoming.size() >= 32)
            throw new IOException("incoming document capacity exceeded");
        }
        HostArchive.Info file = importUri(uri);
        synchronized (incoming) {
          incoming.add(file);
        }
        event("open-file", info(file));
      } catch (Throwable error) {
        event("open-file-error", String.valueOf(error.getMessage()));
      }
    });
  }
  private static void copy(InputStream input, OutputStream output) throws IOException {
    byte[] bytes = new byte[HostArchive.CHUNK];
    int count;
    long total = 0;
    while ((count = input.read(bytes)) != -1) {
      if (Thread.currentThread().isInterrupted())
        throw new InterruptedIOException();
      total += count;
      if (total > HostArchive.MAX_FILE)
        throw new IOException("file too large");
      output.write(bytes, 0, count);
    }
  }
  private void saveGallery(File source, JSONObject args) throws Exception {
    String mime = args.getString("mime");
    boolean video = mime.startsWith("video/");
    if (!video && !mime.startsWith("image/"))
      throw new IOException("gallery needs image/video MIME");
    ContentValues values = new ContentValues();
    values.put(MediaStore.MediaColumns.DISPLAY_NAME,
        args.optString("name", video ? "export.mp4" : "export.png"));
    values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
    values.put(MediaStore.MediaColumns.RELATIVE_PATH,
        video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES);
    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
    Uri uri =
        activity.getContentResolver().insert(video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                                                   : MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            values);
    if (uri == null)
      throw new IOException("cannot allocate gallery entry");
    try {
      try (InputStream input = new FileInputStream(source);
          OutputStream output = activity.getContentResolver().openOutputStream(uri)) {
        if (output == null)
          throw new IOException("cannot write gallery entry");
        copy(input, output);
      }
      values.clear();
      values.put(MediaStore.MediaColumns.IS_PENDING, 0);
      activity.getContentResolver().update(uri, values, null, null);
    } catch (Throwable error) {
      activity.getContentResolver().delete(uri, null, null);
      throw error;
    }
  }
  private void document(Session current, boolean printing, JSONObject args, Done done) {
    if (cancelPDF != null)
      throw new IllegalStateException("document renderer busy");
    final WebView[] hidden = {null};
    final boolean[] finished = {false}, submitted = {false};
    final Runnable[] deadline = {null};
    Done finish = (value, error) -> {
      if (finished[0])
        return;
      finished[0] = true;
      cancelPDF = null;
      if (deadline[0] != null)
        activity.getWindow().getDecorView().removeCallbacks(deadline[0]);
      if (hidden[0] != null) {
        hidden[0].stopLoading();
        hidden[0].destroy();
        hidden[0] = null;
      }
      if (!submitted[0])
        done.finish(value, error);
    };
    cancelPDF = () -> finish.finish(null, new CancellationException("document cancelled"));
    deadline[0] = () -> {
      if (!finished[0] && !submitted[0])
        finish.finish(null, new IOException("document render timed out"));
    };
    activity.getWindow().getDecorView().postDelayed(deadline[0], 60000);
    Consumer<WebView> render = view -> {
      if (finished[0] || current != session || closed)
        return;
      PrintDocumentAdapter adapter =
          view.createPrintDocumentAdapter(args.optString("name", "document"));
      // Android's public SDK exposes HTML printing through PrintManager.
      // Direct LayoutResultCallback/WriteResultCallback construction is hidden
      // API; do not use reflection or a debug-only DevTools PDF endpoint.
      PrintDocumentAdapter retained = new PrintDocumentAdapter() {
        @Override
        public void onStart() {
          adapter.onStart();
        }
        @Override
        public void onLayout(PrintAttributes old, PrintAttributes next, CancellationSignal signal,
            LayoutResultCallback callback, Bundle extras) {
          adapter.onLayout(old, next, signal, callback, extras);
        }
        @Override
        public void onWrite(PageRange[] pages, ParcelFileDescriptor output,
            CancellationSignal signal, WriteResultCallback callback) {
          adapter.onWrite(pages, output, signal, callback);
        }
        @Override
        public void onFinish() {
          adapter.onFinish();
          finish.finish(null, null);
        }
      };
      PrintManager manager = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
      PrintJob job =
          manager.print(args.optString("name", printing ? "Print document" : "Save as PDF"),
              retained, new PrintAttributes.Builder().build());
      // A submitted job is not a claim of completed printing or a returned PDF
      // file. For PDF export the system destination must be Save as PDF.
      submitted[0] = true;
      activity.getWindow().getDecorView().removeCallbacks(deadline[0]);
      cancelPDF = () -> {
        job.cancel();
        finish.finish(null, new CancellationException("print cancelled"));
      };
      try {
        done.finish(new JSONObject()
                        .put("status", "submitted")
                        .put("mode", "system-dialog")
                        .put("job", job.getId().toString()),
            null);
      } catch (JSONException error) {
        finish.finish(null, error);
      }
    };
    if (!args.has("html")) {
      render.accept(web);
      return;
    }
    String html = args.optString("html");
    if (html.getBytes(StandardCharsets.UTF_8).length > 384 * 1024) {
      finish.finish(null, new IOException("HTML too large"));
      return;
    }
    WebView view = new WebView(activity);
    hidden[0] = view;
    view.getSettings().setJavaScriptEnabled(true);
    view.getSettings().setBlockNetworkLoads(true);
    view.getSettings().setAllowFileAccess(false);
    view.getSettings().setAllowContentAccess(false);
    view.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
        return assets.apply(request.getMethod(), request.getUrl());
      }
      @Override
      public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
        return !AssetPolicy.ORIGIN.equals(
            request.getUrl().getScheme() + "://" + request.getUrl().getAuthority());
      }
      @Override
      public void onPageFinished(WebView v, String url) {
        v.evaluateJavascript(
            "Promise.all([document.fonts.ready,...Array.from(document.images).map(i=>i.complete?"
                + "Promise.resolve():new "
                + "Promise(r=>{i.onload=r;i.onerror=r}))]).then(()=>{document.title='nt-print-"
                  + "ready'})",
            null);
        awaitPrintReady(v, render, finished);
      }
    });
    String policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; "
        + "img-src data: https://appassets.androidplatform.net; style-src "
        + "'unsafe-inline' https://appassets.androidplatform.net; font-src "
        + "https://appassets.androidplatform.net; script-src 'none'\">";
    view.loadDataWithBaseURL(AssetPolicy.ORIGIN + "/", policy + html, "text/html", "UTF-8", null);
  }
  private void awaitPrintReady(WebView view, Consumer<WebView> render, boolean[] finished) {
    if (finished[0])
      return;
    view.evaluateJavascript("document.title==='nt-print-ready'", value -> {
      if (finished[0])
        return;
      if ("true".equals(value))
        render.accept(view);
      else
        view.postDelayed(() -> awaitPrintReady(view, render, finished), 16);
    });
  }
  private static void validateShortcuts(JSONArray items) throws JSONException {
    if (items.length() > 32)
      throw new JSONException("too many shortcuts");
    Set<String> ids = new HashSet<>(), chords = new HashSet<>();
    for (int i = 0; i < items.length(); i++) {
      JSONObject item = items.getJSONObject(i);
      String id = item.getString("id"), key = item.getString("key"),
             title = item.getString("title");
      JSONArray modifiers = item.getJSONArray("modifiers");
      TreeSet<String> mods = new TreeSet<>();
      for (int j = 0; j < modifiers.length(); j++) {
        String m = modifiers.getString(j);
        if (!Arrays.asList("meta", "ctrl", "alt", "shift").contains(m) || !mods.add(m))
          throw new JSONException("invalid shortcut modifier");
      }
      if (!id.matches("[A-Za-z0-9._-]{1,64}") || !key.matches("[a-z0-9]") || title.isEmpty()
          || title.length() > 80 || mods.isEmpty() || !ids.add(id) || !chords.add(key + mods)
          || ((mods.contains("meta") || mods.contains("ctrl"))
              && Arrays.asList("q", "w", "c", "v", "x", "z", "a", "r").contains(key)))
        throw new JSONException("invalid, duplicate or reserved shortcut");
    }
  }
  public void addMenu(Menu menu) {
    for (int i = 0; i < session.shortcuts.length(); i++)
      menu.add(0, 1000 + i, 0, session.shortcuts.optJSONObject(i).optString("title"));
  }
  public boolean menu(MenuItem item) {
    int index = item.getItemId() - 1000;
    if (index < 0 || index >= session.shortcuts.length())
      return false;
    event("shortcut",
        Collections.singletonMap("id", session.shortcuts.optJSONObject(index).optString("id")));
    return true;
  }
  public boolean shortcut(KeyEvent event) {
    if (event.getAction() != KeyEvent.ACTION_DOWN || event.getRepeatCount() != 0)
      return false;
    int code = event.getKeyCode();
    String key = code >= KeyEvent.KEYCODE_A && code <= KeyEvent.KEYCODE_Z
        ? String.valueOf((char) ('a' + code - KeyEvent.KEYCODE_A))
        : code >= KeyEvent.KEYCODE_0 && code <= KeyEvent.KEYCODE_9
        ? String.valueOf((char) ('0' + code - KeyEvent.KEYCODE_0))
        : "";
    for (int i = 0; i < session.shortcuts.length(); i++) {
      JSONObject item = session.shortcuts.optJSONObject(i);
      JSONArray modifiers = item.optJSONArray("modifiers");
      Set<String> mods = new HashSet<>();
      for (int j = 0; j < modifiers.length(); j++) mods.add(modifiers.optString(j));
      if (key.equals(item.optString("key")) && event.isCtrlPressed() == mods.contains("ctrl")
          && event.isMetaPressed() == mods.contains("meta")
          && event.isAltPressed() == mods.contains("alt")
          && event.isShiftPressed() == mods.contains("shift")) {
        event("shortcut", Collections.singletonMap("id", item.optString("id")));
        return true;
      }
    }
    return false;
  }
  private void cleanup(Session old) {
    try {
      HostArchive store = archive(activity);
      for (String id : old.writes) store.abort(id);
      for (String id : old.leases) store.release(id);
      old.writes.clear();
      old.leases.clear();
    } catch (IOException ignored) {
    }
  }
  public void dispose() {
    if (closed)
      return;
    closed = true;
    if (cancelPDF != null)
      cancelPDF.run();
    if (pickerDone != null) {
      int request = pickerRequest;
      pickerRequest = -1;
      activity.finishActivity(request);
      pickerDone.finish(null, new CancellationException("host disposed"));
      pickerDone = null;
    }
    web.removeJavascriptInterface("ntHost");
    Session old = session;
    io.execute(() -> cleanup(old));
    io.shutdown();
  }
}
