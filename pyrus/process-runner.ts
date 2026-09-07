import { spawn } from "node:child_process";
import { sanitizedEnvironment } from "./environment.js";
import { OutputSanitizer } from "./output-sanitizer.js";

export interface ProcessRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function bytes(buffer: Buffer): Uint8Array {
  const out = new Uint8Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) out[i] = buffer[i]!;
  return out;
}

export function runBoundedProcess(
  command: string,
  args: string[],
  timeoutMs = 5000,
  maxOutputBytes = 1024 * 1024,
): Promise<ProcessRunResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000)
    throw new RangeError("process timeout is outside the allowed range");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 64 * 1024 * 1024)
    throw new RangeError("process output limit is outside the allowed range");
  return new Promise<ProcessRunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: sanitizedEnvironment(),
    });
    const stdout = new OutputSanitizer();
    const stderr = new OutputSanitizer();
    let out = "";
    let err = "";
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("process timed out"));
    }, timeoutMs);
    child.stdout!.on("data", (data: Buffer) => {
      if (settled) return;
      outputBytes += data.length;
      if (outputBytes > maxOutputBytes) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(new Error("process output limit exceeded"));
        return;
      }
      out += stdout.write(bytes(data));
    });
    child.stderr!.on("data", (data: Buffer) => {
      if (settled) return;
      outputBytes += data.length;
      if (outputBytes > maxOutputBytes) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(new Error("process output limit exceeded"));
        return;
      }
      err += stderr.write(bytes(data));
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out += stdout.end();
      err += stderr.end();
      resolve({ code, stdout: out, stderr: err });
    });
  });
}
