package dev.nativetron.app;
import java.io.*;
import java.nio.file.*;
import java.util.*;

public final class HostArchiveTest {
  interface Attempt {
    void run() throws Exception;
  }
  static void rejected(Attempt fn) throws Exception {
    boolean rejected = false;
    try {
      fn.run();
    } catch (Exception expected) {
      rejected = true;
    }
    if (!rejected)
      throw new AssertionError("expected rejection");
  }
  public static void main(String[] args) throws Exception {
    Path root = Files.createTempDirectory("nt-android-archive-test-");
    try {
      try (HostArchive store = new HostArchive(root.toFile())) {
        for (String key : Arrays.asList("../escape", "a/b", "", ".hidden", "a..b"))
          rejected(() -> store.begin(key, 1));
        String id = store.begin("project.ntproject", 3);
        rejected(() -> store.write(id, 1, new byte[] {1}));
        rejected(() -> store.commit(id));
        store.write(id, 0, new byte[] {1, 2, 3});
        store.commit(id);
        HostArchive.Info snapshot = store.snapshot("project.ntproject");
        if (Files.isSameFile(
                root.resolve("archives/project.ntproject"), store.file(snapshot.file).toPath()))
          throw new AssertionError("snapshot must not require a hard link");
        String replace = store.begin("project.ntproject", 3);
        store.write(replace, 0, new byte[] {4, 5, 6});
        store.commit(replace);
        if (!Arrays.equals(store.read(snapshot.file, 0, 3), new byte[] {1, 2, 3}))
          throw new AssertionError("unstable snapshot");
        store.release(snapshot.file);
        rejected(() -> store.read(snapshot.file, 0, 1));
        String abandoned = store.begin("aborted", 3);
        store.abort(abandoned);
        rejected(() -> store.begin("too-large", HostArchive.MAX_FILE + 1L));
        if (store.list().size() != 1)
          throw new AssertionError("unexpected archives");
      }
      try (HostArchive store = new HostArchive(root.toFile())) {
        HostArchive.Info snapshot = store.snapshot("project.ntproject");
        if (!Arrays.equals(store.read(snapshot.file, 0, 3), new byte[] {4, 5, 6}))
          throw new AssertionError("not persistent");
        rejected(() -> store.read(snapshot.file, 2, 2));
        store.release(snapshot.file);
        store.remove("project.ntproject");
        if (!store.list().isEmpty())
          throw new AssertionError("delete failed");
      }
      try (HostArchive limited = new HostArchive(root.resolve("limited").toFile(), 6)) {
        String write = limited.begin("project", 3);
        limited.write(write, 0, new byte[] {1, 2, 3});
        limited.commit(write);
        HostArchive.Info lease = limited.snapshot("project");
        rejected(() -> limited.snapshot("project"));
        limited.release(lease.file);
        HostArchive.Info retry = limited.snapshot("project");
        limited.release(retry.file);
      }
      System.out.println(
          "Android archive: atomic replacement, snapshots, persistence, bounds and cleanup passed");
    } finally {
      try (java.util.stream.Stream<Path> paths = Files.walk(root)) {
        for (Path path : (Iterable<Path>) paths.sorted(Comparator.reverseOrder())::iterator)
          Files.delete(path);
      }
    }
  }
}
