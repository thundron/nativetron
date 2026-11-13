package dev.nativetron.app;

/** Pure state/revision logic, shared by snapshot reads and OS notifications. */
final class PowerStateModel {
  private boolean initialized, lowPower;
  private int thermal;
  private long revision;
  synchronized long update(boolean saver, int status) {
    if (!initialized || saver != lowPower || status != thermal) {
      initialized = true;
      lowPower = saver;
      thermal = status;
      revision++;
    }
    return revision;
  }
  static String normalized(int status) {
    switch (status) {
      case 0:
        return "nominal";
      case 1:
      case 2:
        return "fair";
      case 3:
        return "serious";
      case 4:
      case 5:
      case 6:
        return "critical";
      default:
        return "unknown";
    }
  }
}
