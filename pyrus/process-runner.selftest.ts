import { runBoundedProcess, type ProcessRunResult } from "./process-runner.js";

async function rejectedMessage(run: Promise<ProcessRunResult>): Promise<string> {
  try {
    await run;
    return "resolved";
  } catch (error) {
    return error instanceof Error ? error.message : "non-error";
  }
}

async function main(): Promise<void> {
  const clean = await runBoundedProcess(
    "/bin/sh",
    ["-c", "printf 'safe\\r\\n\\033[31mred\\033[0m'; printf '\\033]8;;x\\007bad\\033]8;;\\007' >&2"],
    2000,
    4096,
  );
  const limited = await rejectedMessage(runBoundedProcess("/usr/bin/yes", ["x"], 2000, 1024));
  const timed = await rejectedMessage(runBoundedProcess("/bin/sleep", ["1"], 20, 1024));
  const missing = await rejectedMessage(runBoundedProcess("/definitely/missing/nativetron", [], 2000, 1024));
  const ok = clean.code === 0
    && clean.stdout === "safe\nred"
    && clean.stderr === "bad"
    && limited === "process output limit exceeded"
    && timed === "process timed out"
    && missing.includes("ENOENT");
  console.log(ok ? "PYRUS_PROCESS_RUNNER=OK" : "PYRUS_PROCESS_RUNNER=FAIL");
  if (!ok) process.exit(1);
}

main().catch((error: unknown) => {
  console.log(error instanceof Error ? error.message : "process runner failed");
  process.exit(1);
});
