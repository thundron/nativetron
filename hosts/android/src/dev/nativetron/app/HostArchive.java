package dev.nativetron.app;

import java.io.*;
import java.nio.channels.FileLock;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.*;

/** Durable project archives, independent of WebView storage. No page paths. */
final class HostArchive implements Closeable {
  static final int CHUNK = 192 * 1024, MAX_FILE = 256 * 1024 * 1024;
  static final long QUOTA = 1024L * 1024 * 1024;
  static final class Info {
    final String file, name;
    final long size;
    Info(String file, String name, long size) {
      this.file = file;
      this.name = name;
      this.size = size;
    }
  }
  private static final class Write {
    final String key;
    final File file;
    final long expected;
    final RandomAccessFile output;
    long offset;
    Write(String key, File file, long size) throws IOException {
      this.key = key;
      this.file = file;
      expected = size;
      output = new RandomAccessFile(file, "rw");
    }
  }
  private final File root, archives, staging;
  private final RandomAccessFile lockFile;
  private final FileLock processLock;
  private final Map<String, Write> writes = new HashMap<>();
  private final Map<String, File> files = new HashMap<>();
  HostArchive(File root) throws IOException {
    this.root = root;
    archives = new File(root, "archives");
    staging = new File(root, "staging");
    if ((!archives.mkdirs() && !archives.isDirectory())
        || (!staging.mkdirs() && !staging.isDirectory()))
      throw new IOException("archive directory unavailable");
    lockFile = new RandomAccessFile(new File(root, ".lock"), "rw");
    FileLock acquired;
    try {
      acquired = lockFile.getChannel().tryLock();
    } catch (RuntimeException | IOException error) {
      lockFile.close();
      throw error;
    }
    if (acquired == null) {
      lockFile.close();
      throw new IOException("archive store busy");
    }
    processLock = acquired;
    for (File file : entries(staging))
      if (!file.delete()) {
        close();
        throw new IOException("cannot remove abandoned staging file");
      }
  }
  private static File[] entries(File directory) throws IOException {
    File[] files = directory.listFiles();
    if (files == null)
      throw new IOException("cannot list archive directory");
    return files;
  }
  private static String key(String name) throws IOException {
    if (name == null || !name.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}") || name.contains(".."))
      throw new IOException("invalid archive key");
    return name;
  }
  private long used() throws IOException {
    long size = 0;
    for (File f : entries(archives)) size += f.length();
    for (File f : entries(staging)) size += f.length();
    for (Write w : writes.values()) size += w.expected - w.offset;
    return size;
  }
  private void capacity(long extra) throws IOException {
    if (extra < 0 || used() > QUOTA - extra)
      throw new IOException("archive quota exceeded");
  }
  synchronized String begin(String name, long size) throws IOException {
    key(name);
    if (size < 0 || size > MAX_FILE || writes.size() >= 16)
      throw new IOException("invalid archive write size/capacity");
    for (Write item : writes.values())
      if (item.key.equals(name))
        throw new IOException("archive write busy");
    if (entries(archives).length >= 128 && !new File(archives, name).exists())
      throw new IOException("archive count exceeded");
    capacity(size);
    String id = UUID.randomUUID().toString();
    writes.put(id, new Write(name, new File(staging, id), size));
    return id;
  }
  synchronized void write(String id, long offset, byte[] bytes) throws IOException {
    Write item = writes.get(id);
    if (item == null || offset != item.offset || bytes.length > CHUNK
        || bytes.length > item.expected - offset)
      throw new IOException("invalid archive chunk or offset");
    item.output.write(bytes);
    item.offset += bytes.length;
  }
  synchronized long commit(String id) throws IOException {
    Write item = writes.get(id);
    if (item == null || item.offset != item.expected)
      throw new IOException("incomplete archive");
    item.output.getChannel().force(true);
    item.output.close();
    Files.move(item.file.toPath(), new File(archives, item.key).toPath(),
        StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    writes.remove(id);
    return item.expected;
  }
  synchronized void abort(String id) throws IOException {
    Write item = writes.remove(id);
    if (item != null) {
      item.output.close();
      if (!item.file.delete() && item.file.exists())
        throw new IOException("cannot remove archive transaction");
    }
  }
  synchronized Map<String, Long> list() throws IOException {
    Map<String, Long> result = new TreeMap<>();
    for (File file : entries(archives)) result.put(file.getName(), file.length());
    return result;
  }
  synchronized void remove(String name) throws IOException {
    if (!new File(archives, key(name)).delete())
      throw new IOException("archive not found");
  }
  synchronized Info snapshot(String name) throws IOException {
    key(name);
    if (files.size() >= 32)
      throw new IOException("file lease capacity exceeded");
    File source = new File(archives, name);
    if (!source.isFile())
      throw new IOException("archive not found");
    String id = UUID.randomUUID().toString();
    File file = new File(staging, id);
    Files.createLink(file.toPath(), source.toPath());
    files.put(id, file);
    return new Info(id, name, file.length());
  }
  synchronized Info importFile(InputStream source, String name) throws IOException {
    if (files.size() >= 32)
      throw new IOException("file lease capacity exceeded");
    String id = UUID.randomUUID().toString();
    File file = new File(staging, id);
    long size = 0;
    try (FileOutputStream output = new FileOutputStream(file)) {
      byte[] bytes = new byte[CHUNK];
      int count;
      while ((count = source.read(bytes)) != -1) {
        if (Thread.currentThread().isInterrupted())
          throw new InterruptedIOException("file import cancelled");
        if (size + count > MAX_FILE)
          throw new IOException("file too large");
        capacity(count);
        output.write(bytes, 0, count);
        size += count;
      }
      output.getChannel().force(true);
    } catch (IOException | RuntimeException error) {
      file.delete();
      throw error;
    }
    files.put(id, file);
    return new Info(id, name, size);
  }
  synchronized File file(String id) throws IOException {
    File file = files.get(id);
    if (file == null)
      throw new IOException("unknown file token");
    return file;
  }
  synchronized byte[] read(String id, long offset, int length) throws IOException {
    File file = file(id);
    if (offset < 0 || length < 0 || length > CHUNK || offset > file.length()
        || length > file.length() - offset)
      throw new IOException("invalid file range");
    try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
      input.seek(offset);
      byte[] bytes = new byte[length];
      input.readFully(bytes);
      return bytes;
    }
  }
  synchronized void release(String id) throws IOException {
    File file = files.remove(id);
    if (file != null && !file.delete() && file.exists())
      throw new IOException("cannot release file");
  }
  @Override
  public synchronized void close() throws IOException {
    for (String id : new ArrayList<>(writes.keySet())) abort(id);
    for (String id : new ArrayList<>(files.keySet())) release(id);
    if (processLock.isValid())
      processLock.release();
    lockFile.close();
  }
}
