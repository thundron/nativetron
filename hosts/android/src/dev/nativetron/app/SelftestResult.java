package dev.nativetron.app;

final class SelftestResult {
  private SelftestResult() {}
  static String failure(String report) {
    if (report.startsWith("GPU_UNAVAILABLE")) return "NT_ANDROID_UNAVAILABLE " + report;
    if (report.startsWith("GPU_ERROR") || report.equals("GPU_READBACK_FAILED")) return "NT_ANDROID_GPU_FAILED " + report;
    return null;
  }
}
