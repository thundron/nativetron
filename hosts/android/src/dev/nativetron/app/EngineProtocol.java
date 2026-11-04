// generated from ipc/engine.json by ipc/generate-engine.mjs — do not edit
package dev.nativetron.app;
import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import org.json.JSONObject;

final class EngineProtocol {
  static final int MAX_PAYLOAD = 65536;
  static final int MAX_RATE = 60;
  static boolean valid(byte[] bytes) {
    if (bytes.length < 16 || bytes.length > 65552) return false;
    ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
    return b.get(0) == 1 && b.get(1) >= 1 && b.get(1) <= 5 &&
      b.get(2) >= 0 && b.get(2) <= 2 && b.get(3) >= 0 && b.get(3) <= 2 && b.get(2) != b.get(3) &&
      b.getInt(12) == bytes.length - 16;
  }
  static byte[] decodeEnvelope(String text) {
    if (text.length() > 87468) return null;
    try {
      JSONObject object = new JSONObject(text);
      if (object.length() != 2 || !(object.get("ntEngine") instanceof Integer) || object.getInt("ntEngine") != 1 || !(object.get("frame") instanceof String)) return null;
      String value = object.getString("frame");
      byte[] bytes = Base64.decode(value, Base64.NO_WRAP);
      return Base64.encodeToString(bytes, Base64.NO_WRAP).equals(value) && valid(bytes) ? bytes : null;
    } catch (Exception error) { return null; }
  }
  static byte[] command(int topic, byte[] payload) {
    if (payload.length > MAX_PAYLOAD) throw new IllegalArgumentException("engine payload too large");
    ByteBuffer b = ByteBuffer.allocate(16 + payload.length).order(ByteOrder.LITTLE_ENDIAN);
    b.put(0, (byte)1); b.put(1, (byte)1); b.put(2, (byte)0); b.put(3, (byte)2);
    b.putInt(8, topic); b.putInt(12, payload.length);
    b.position(16); b.put(payload); return b.array();
  }
  static byte[] payload(byte[] bytes) { return Arrays.copyOfRange(bytes, 16, bytes.length); }
  static boolean fromEngineToNative(byte[] bytes) { return valid(bytes) && bytes[2] == 2 && bytes[3] == 0; }
}
