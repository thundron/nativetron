package dev.nativetron.app;

import android.content.*;
import android.os.Build;
import android.os.PowerManager;
import java.util.function.Consumer;
import org.json.*;

/** Native snapshots + notifications; no Battery API or periodic polling. */
final class HostPowerState {
  private final Context context;
  private final PowerManager manager;
  private final Consumer<JSONObject> notify;
  private final BroadcastReceiver receiver;
  private final PowerManager.OnThermalStatusChangedListener thermal;
  private final PowerStateModel model = new PowerStateModel();
  private boolean closed, thermalRegistered, receiverRegistered;
  HostPowerState(Context context, Consumer<JSONObject> notify) {
    this.context = context.getApplicationContext();
    this.notify = notify;
    manager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
    receiver = new BroadcastReceiver() {
      @Override
      public void onReceive(Context c, Intent intent) {
        refresh();
      }
    };
    IntentFilter filter = new IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED);
    try {
      if (Build.VERSION.SDK_INT >= 33)
        this.context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
      else
        this.context.registerReceiver(receiver, filter);
      receiverRegistered = true;
    } catch (RuntimeException unavailable) {
      receiverRegistered = false;
    }
    thermal = status -> refresh();
    if (manager != null) {
      try {
        manager.addThermalStatusListener(context.getMainExecutor(), thermal);
        thermalRegistered = true;
      } catch (RuntimeException unavailable) {
        thermalRegistered = false;
      }
    }
  }
  synchronized JSONObject snapshot() {
    int status = -1;
    if (manager != null) {
      try {
        status = manager.getCurrentThermalStatus();
      } catch (RuntimeException unavailable) {
        status = -1;
      }
    }
    boolean saver = manager != null && manager.isPowerSaveMode();
    long revision = model.update(saver, status);
    try {
      return new JSONObject()
          .put("platform", "android")
          .put("notificationsAvailable", receiverRegistered)
          .put("thermalNotificationsAvailable", thermalRegistered)
          .put("lowPowerMode", saver)
          .put("thermalState", PowerStateModel.normalized(status))
          .put("nativeThermalState", status)
          .put("revision", revision);
    } catch (JSONException impossible) {
      throw new IllegalStateException(impossible);
    }
  }
  void refresh() {
    synchronized (this) {
      if (closed)
        return;
    }
    notify.accept(snapshot());
  }
  synchronized void dispose() {
    if (closed)
      return;
    closed = true;
    if (receiverRegistered) {
      context.unregisterReceiver(receiver);
      receiverRegistered = false;
    }
    if (manager != null && thermalRegistered) {
      manager.removeThermalStatusListener(thermal);
      thermalRegistered = false;
    }
  }
}
