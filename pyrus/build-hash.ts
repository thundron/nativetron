import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface BuildEntry {
  path: string;
  bytes: number;
  directory: boolean;
}

export interface BuildDirectoryHash {
  entries: BuildEntry[];
  contentHash: string;
}

export async function hashBuildDirectory(target: string): Promise<BuildDirectoryHash> {
  const entries: BuildEntry[] = [];
  const hash = createHash("sha256");
  const queue = [""];
  let totalBytes = 0;
  while (queue.length > 0) {
    const relative = queue.shift()!;
    const directory = join(target, relative);
    const names = await readdir(directory);
    names.sort((a: string, b: string) => a.localeCompare(b));
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      const childRelative = relative.length > 0 ? relative + "/" + name : name;
      const filename = join(target, childRelative);
      const stat = await lstat(filename);
      if (stat.isSymbolicLink()) throw new Error("Pear build produced a symlink");
      if (entries.length >= 10000) throw new Error("Pear build output exceeds the artifact limit");
      if (stat.isDirectory()) {
        hash.update("directory\0" + childRelative + "\0");
        entries.push({ path: childRelative, bytes: 0, directory: true });
        queue.push(childRelative);
        continue;
      }
      if (!stat.isFile()) throw new Error("Pear build produced an unsupported file type");
      totalBytes += stat.size;
      if (totalBytes > 2 * 1024 * 1024 * 1024)
        throw new Error("Pear build output exceeds the byte limit");
      hash.update("file\0" + childRelative + "\0" + stat.size + "\0");
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size)
          throw new Error("Pear build output changed while it was being hashed");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (position < opened.size) {
          const result = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, opened.size - position),
            position,
          );
          if (result.bytesRead <= 0)
            throw new Error("Pear build output ended while it was being hashed");
          hash.update(buffer.subarray(0, result.bytesRead));
          position += result.bytesRead;
        }
        const after = await handle.stat();
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
          throw new Error("Pear build output changed while it was being hashed");
      } finally {
        await handle.close();
      }
      entries.push({ path: childRelative, bytes: stat.size, directory: false });
    }
  }
  return { entries, contentHash: hash.digest("hex") };
}
