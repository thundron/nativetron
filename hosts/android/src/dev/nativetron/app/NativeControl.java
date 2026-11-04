package dev.nativetron.app;

import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Log;
import java.nio.charset.StandardCharsets;

/**
 * Owns the scriptc nt-control static library (libntcontrol.so). Every native
 * call runs on one dedicated owner thread; results are copied out by the JNI
 * layer and delivered to the listener on the main thread after the library
 * call has returned. The library carries only low-rate control frames; the
 * GPU engine stays wasm inside the page.
 */
final class NativeControl {
  static final int OK = 0, REFUSED = 1, WRONG_THREAD = 2, CLOSED = 3, POISONED = 4, PROTOCOL = 5, NO_MEMORY = 6, BUSY = 7, TOO_LARGE = 8;
  static final int UNAVAILABLE = -1, OVERLOADED = -2;
  static final int MAX_PENDING = 64;
  private static final String TAG = "nt-control";

  interface Listener {
    /** A native→engine COMMAND frame encoded by the library, for the page. */
    void onCommandFrame(byte[] frame);
    /** An engine→native frame the library validated and routed to native. */
    void onEngineFrame(byte[] frame);
    void onFailure(String operation, int status, String detail);
  }

  private static final boolean LOADED;
  private static final String LOAD_ERROR;
  static {
    boolean loaded = false; String error = null;
    try { System.loadLibrary("ntcontrol"); loaded = true; }
    catch (UnsatisfiedLinkError e) { error = String.valueOf(e.getMessage()); }
    LOADED = loaded; LOAD_ERROR = error;
  }

  private static native int nativeOpen();
  private static native int nativeClose();
  private static native int nativeCollect();
  private static native byte[] nativeCommand(long topic, byte[] payload, int[] status);
  private static native byte[] nativeReceive(byte[] frame, int[] status);
  private static native byte[] nativePanic();

  private final Handler main = new Handler(Looper.getMainLooper());
  private final Listener listener;
  private final HandlerThread thread;
  private final Handler owner;
  private final Object lock = new Object();
  private int pending;
  private boolean closed;
  private volatile boolean ready;
  /** Owner thread of the newest instance; a successor waits for it to release the library. */
  private static HandlerThread latestOwner;

  NativeControl(Listener listener) {
    this.listener = listener;
    if (!LOADED) {
      thread = null; owner = null; closed = true;
      Log.e(TAG, "NT_CONTROL_UNAVAILABLE " + LOAD_ERROR);
      return;
    }
    thread = new HandlerThread("nt-control");
    final HandlerThread prior;
    synchronized (NativeControl.class) { prior = latestOwner; latestOwner = thread; }
    thread.start();
    owner = new Handler(thread.getLooper());
    post("open", () -> {
      // A recreated activity may start before its predecessor's owner thread
      // has run nativeClose; the library refuses a second owner until then.
      if (prior != null) {
        try { prior.join(2000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
      }
      int status = nativeOpen();
      ready = status == OK;
      if (ready) Log.i(TAG, "NT_CONTROL_READY scriptc nt-control aarch64-linux-android");
      else fail("open", status);
    });
  }

  static boolean available() { return LOADED; }
  boolean ready() { return ready; }

  void command(long topic, byte[] payload) {
    byte[] copy = payload.clone();
    post("command", () -> {
      int[] status = { UNAVAILABLE };
      byte[] frame = nativeCommand(topic, copy, status);
      if (frame == null) { fail("command", status[0]); return; }
      main.post(() -> { if (!isClosed()) listener.onCommandFrame(frame); });
    });
  }

  /** frame is owned by the caller and copied before crossing threads. */
  void receive(byte[] frame) {
    byte[] copy = frame.clone();
    post("receive", () -> {
      int[] status = { UNAVAILABLE };
      byte[] routed = nativeReceive(copy, status);
      if (routed == null) { fail("receive", status[0]); return; }
      main.post(() -> { if (!isClosed()) listener.onEngineFrame(routed); });
    });
  }

  void collect() { post("collect", () -> { int status = nativeCollect(); if (status != OK) fail("collect", status); }); }

  /** Releases library ownership on the owner thread, then stops the thread. Idempotent. */
  void close() {
    synchronized (lock) {
      if (closed) return;
      closed = true;
    }
    ready = false;
    owner.post(() -> {
      int status = nativeClose();
      Log.i(TAG, "NT_CONTROL_CLOSED " + status);
    });
    thread.quitSafely();
  }

  private boolean isClosed() { synchronized (lock) { return closed; } }

  private void post(String operation, Runnable work) {
    synchronized (lock) {
      if (closed) { report(operation, LOADED ? CLOSED : UNAVAILABLE, null); return; }
      if (pending >= MAX_PENDING) { report(operation, OVERLOADED, null); return; }
      pending++;
    }
    owner.post(() -> {
      synchronized (lock) { pending--; }
      work.run();
    });
  }

  /** Runs on the owner thread after a failed library call. */
  private void fail(String operation, int status) {
    String detail = null;
    if (status == POISONED) {
      ready = false;
      byte[] panic = nativePanic();
      detail = panic == null ? "" : printable(panic);
      Log.e(TAG, "NT_CONTROL_PANIC " + detail);
    }
    report(operation, status, detail);
  }

  private void report(String operation, int status, String detail) {
    Log.w(TAG, "NT_CONTROL_FAILED " + operation + " " + status);
    main.post(() -> listener.onFailure(operation, status, detail));
  }

  /** scriptc diagnostics use 0x01/0x1F field markers; keep them readable in logcat. */
  static String printable(byte[] bytes) {
    String text = new String(bytes, StandardCharsets.UTF_8);
    StringBuilder out = new StringBuilder(Math.min(text.length(), 2048));
    for (int i = 0; i < text.length() && out.length() < 2048; i++) {
      char c = text.charAt(i);
      out.append(c == 0x1f ? '|' : c < 0x20 || c == 0x7f ? ' ' : c);
    }
    return out.toString().trim();
  }
}
