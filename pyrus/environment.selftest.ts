import { sanitizedEnvironment, sanitizedPath } from "./environment.js";

const path = sanitizedPath(".:relative:/usr/bin:/usr/bin:/definitely/missing/nativetron");
const source: Record<string, string | undefined> = {
  HOME: "/tmp/home",
  LANG: "en_US.UTF-8",
  NODE_OPTIONS: "--require=attacker.js",
  ELECTRON_RUN_AS_NODE: "1",
  PATH: ".:relative:/usr/bin:/usr/bin",
};
const environment = sanitizedEnvironment(source);
const ok = path.length > 0
  && !path.includes("relative")
  && path.indexOf(":") === -1
  && environment["HOME"] === "/tmp/home"
  && environment["LANG"] === "en_US.UTF-8"
  && environment["NODE_OPTIONS"] === undefined
  && environment["ELECTRON_RUN_AS_NODE"] === undefined
  && environment["PATH"] === path;
console.log(ok ? "PYRUS_ENVIRONMENT=OK" : "PYRUS_ENVIRONMENT=FAIL");
if (!ok) process.exit(1);
