import { hashBuildDirectory } from "./build-hash.js";

async function main(): Promise<void> {
  const root = process.argv[2]!;
  const result = await hashBuildDirectory(root);
  let symlinkRejected = false;
  try {
    await hashBuildDirectory(root + "-symlink");
  } catch (error) {
    symlinkRejected = error instanceof Error && error.message === "Pear build produced a symlink";
  }
  const ok = result.entries.length === 4
    && result.entries[0]!.path === "a.txt"
    && result.entries[1]!.path === "dir" && result.entries[1]!.directory
    && result.entries[2]!.path === "package.json"
    && result.entries[3]!.path === "dir/b.bin"
    && symlinkRejected;
  console.log((ok ? "PYRUS_BUILD_HASH=OK " : "PYRUS_BUILD_HASH=FAIL ") + result.contentHash);
  if (!ok) process.exit(1);
}

main().catch((error: unknown) => {
  console.log(error instanceof Error ? error.message : "build hash failed");
  process.exit(1);
});
