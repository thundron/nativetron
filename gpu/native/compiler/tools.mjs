// Builds the tools the compiler checks use, against one wgpu-native variant (official prebuilt or patched build):
// the existing ntgpu-probe (gpu/native/build.sh) and ntgpu-corpus-runner (corpus/corpus-runner.cc, same facade and
// library). Output stays in the build directory build.sh chose, outside the worktree.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const native = join(here, "..");

const sh = (cmd, argv) => execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

export function buildTools(variant) {
  const prefix = sh(join(native, "fetch-deps.sh"), ["--variant", variant]).split("\n").at(-1);
  const probe = sh(join(native, "build.sh"), ["--wgpu", variant]).split("\n").at(-1);
  const buildDir = dirname(probe);
  const runner = join(buildDir, "ntgpu-corpus-runner");
  execFileSync("xcrun", ["clang++", "-std=c++17", "-O2", "-g0", "-Wall", "-Wextra", "-Werror", "-target",
    "arm64-apple-macos14.0", `-I${prefix}/include`, `-I${native}`, join(here, "corpus", "corpus-runner.cc"),
    join(buildDir, "libntgpu.a"), join(prefix, "lib", "libwgpu_native.a"), "-Wl,-dead_strip", "-framework", "Metal",
    "-framework", "QuartzCore", "-framework", "Foundation", "-framework", "CoreFoundation", "-lobjc", "-liconv",
    "-o", runner], { stdio: "inherit" });
  return { prefix, probe, runner };
}
