import { capabilitiesForVersion, capabilitiesFromVersionOutput, parsePearVersionOutput } from "./capabilities.js";

function main(): void {
  const parsed = parsePearVersionOutput("Pear Runtime; SemVer=3.2.4-beta.1+build.9, Key=abc");
  const supported = capabilitiesFromVersionOutput("SemVer=3.2.4-beta.1+build.9");
  const fallback = capabilitiesForVersion("4.0.0");
  const old = capabilitiesForVersion("3.1.99");
  const prereleaseMinimum = capabilitiesForVersion("3.2.0-rc.1");
  let invalidRejected = false;
  try {
    capabilitiesFromVersionOutput("Version=3.2.0");
  } catch (error) {
    invalidRejected = error instanceof Error && error.message === "Pear returned invalid SemVer metadata";
  }
  const ok = parsed !== null && parsed.raw === "3.2.4-beta.1" && parsed.prerelease === "beta.1"
    && supported.state === "supported" && supported.capabilities.join(",") ===
      "structured-errors,interactive-menu,touch,build,stage,provision,seed,install,info,dump,changelog,cores,versions,multisig"
    && supported.version !== null && supported.version.raw === "3.2.4-beta.1"
    && fallback.state === "fallback" && fallback.supported && fallback.reason !== null
    && old.state === "unsupported" && !old.supported && old.contract === null
    && prereleaseMinimum.supported && invalidRejected
    && parsePearVersionOutput("xSemVer=3.2.0") === null
    && parsePearVersionOutput("SemVer=3.2.0x") === null;
  console.log(ok ? "PYRUS_CAPABILITIES=OK" : "PYRUS_CAPABILITIES=FAIL");
  if (!ok) process.exit(1);
}

main();
