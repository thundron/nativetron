package dev.nativetron.app;
public final class PowerStateModelTest {
  public static void main(String[] args) {
    PowerStateModel model = new PowerStateModel();
    if (model.update(false, 0) != 1 || model.update(false, 0) != 1 || model.update(true, 0) != 2
        || model.update(true, 3) != 3)
      throw new AssertionError("unstable power revision");
    String[] expected = {"nominal", "fair", "fair", "serious", "critical", "critical", "critical"};
    for (int i = 0; i < expected.length; i++)
      if (!PowerStateModel.normalized(i).equals(expected[i]))
        throw new AssertionError("wrong thermal mapping");
    if (!PowerStateModel.normalized(-1).equals("unknown")
        || !PowerStateModel.normalized(99).equals("unknown"))
      throw new AssertionError("unknown thermal state");
    System.out.println(
        "Android power: saver/thermal revisions and raw-status normalization passed");
  }
}
