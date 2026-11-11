package dev.nativetron.app;

import android.content.*;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.*;
import java.nio.file.Files;
import java.util.UUID;

/** Read-only URI grants for explicitly shared app-owned snapshots. No file://. */
public final class HostFileProvider extends ContentProvider {
  private static File root(Context context) {
    return new File(context.getCacheDir(), "nt-share");
  }
  static synchronized Uri snapshot(Context context, File source, String name, String mime)
      throws IOException {
    if (name == null || name.isEmpty() || name.length() > 128 || name.contains("/")
        || name.contains("\\"))
      throw new IOException("invalid share name");
    if (mime == null || !mime.matches("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+"))
      throw new IOException("invalid share MIME");
    File root = root(context);
    if (!root.mkdirs() && !root.isDirectory())
      throw new IOException("share directory unavailable");
    File[] files = root.listFiles();
    if (files == null)
      throw new IOException("cannot list shares");
    int count = 0;
    long bytes = 0;
    for (File file : files) {
      if (System.currentTimeMillis() - file.lastModified() > 86400000L && file.delete())
        continue;
      count++;
      bytes += file.length();
    }
    if (count >= 32 || bytes + source.length() > HostArchive.QUOTA)
      throw new IOException("share quota exceeded");
    String id = UUID.randomUUID().toString();
    File target = new File(root, id);
    Files.copy(source.toPath(), target.toPath());
    return new Uri.Builder()
        .scheme("content")
        .authority(context.getPackageName() + ".files")
        .appendPath(id)
        .appendPath(name)
        .appendQueryParameter("type", mime)
        .build();
  }
  private File resolve(Uri uri) throws FileNotFoundException {
    if (!"content".equals(uri.getScheme())
        || !(getContext().getPackageName() + ".files").equals(uri.getAuthority())
        || uri.getPathSegments().size() != 2
        || !uri.getPathSegments().get(0).matches("[0-9a-fA-F-]{36}"))
      throw new FileNotFoundException("invalid file grant");
    File file = new File(root(getContext()), uri.getPathSegments().get(0));
    if (!file.isFile())
      throw new FileNotFoundException("expired file grant");
    return file;
  }
  @Override
  public boolean onCreate() {
    return true;
  }
  @Override
  public String getType(Uri uri) {
    String type = uri.getQueryParameter("type");
    return type != null && type.matches("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+")
        ? type
        : "application/octet-stream";
  }
  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    if (!"r".equals(mode))
      throw new FileNotFoundException("read-only file grant");
    return ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.MODE_READ_ONLY);
  }
  @Override
  public Cursor query(Uri uri, String[] columns, String selection, String[] args, String order) {
    try {
      File file = resolve(uri);
      String[] names = columns == null
          ? new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}
          : columns;
      MatrixCursor cursor = new MatrixCursor(names);
      Object[] row = new Object[names.length];
      for (int i = 0; i < names.length; i++)
        row[i] = OpenableColumns.DISPLAY_NAME.equals(names[i]) ? uri.getLastPathSegment()
            : OpenableColumns.SIZE.equals(names[i])            ? file.length()
                                                               : null;
      cursor.addRow(row);
      return cursor;
    } catch (FileNotFoundException error) {
      return new MatrixCursor(columns == null
              ? new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}
              : columns);
    }
  }
  @Override
  public Uri insert(Uri uri, ContentValues values) {
    throw new UnsupportedOperationException("read only");
  }
  @Override
  public int update(Uri uri, ContentValues values, String where, String[] args) {
    throw new UnsupportedOperationException("read only");
  }
  @Override
  public int delete(Uri uri, String where, String[] args) {
    throw new UnsupportedOperationException("read only");
  }
}
