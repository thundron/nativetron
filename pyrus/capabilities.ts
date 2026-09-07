export interface PearVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  raw: string;
}

export interface PearCapabilities {
  state: "supported" | "fallback" | "unsupported";
  supported: boolean;
  contract: string | null;
  version: PearVersion | null;
  capabilities: string[];
  reason: string | null;
}

const CAPABILITIES = [
  "structured-errors", "interactive-menu", "touch", "build", "stage", "provision",
  "seed", "install", "info", "dump", "changelog", "cores", "versions", "multisig",
];
const NO_CAPABILITIES: string[] = [];
const VERSION_PATTERN = /(?:^|[\s,;])SemVer=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|[\s,;])/mu;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u;

function parseSemver(value: string): PearVersion | null {
  const match = value.match(SEMVER_PATTERN);
  if (match === null) return null;
  const prerelease = match[4] === undefined || match[4]!.length === 0 ? null : match[4]!;
  return {
    major: Number(match[1]!),
    minor: Number(match[2]!),
    patch: Number(match[3]!),
    prerelease,
    raw: match[0]!,
  };
}

export function parsePearVersionOutput(output: string): PearVersion | null {
  const match = output.match(VERSION_PATTERN);
  if (match === null) return null;
  const withoutBuild = match[1]!.split("+", 1)[0]!;
  return parseSemver(withoutBuild);
}

function normalizedVersion(value: string | PearVersion): PearVersion | null {
  if (typeof value === "string") return parseSemver(value);
  if (!Number.isSafeInteger(value.major) || !Number.isSafeInteger(value.minor) ||
      !Number.isSafeInteger(value.patch) || value.major < 0 || value.minor < 0 || value.patch < 0)
    return null;
  const prerelease = value.prerelease !== null && value.prerelease.length > 0 ? value.prerelease : null;
  return {
    major: value.major,
    minor: value.minor,
    patch: value.patch,
    prerelease,
    raw: "" + value.major + "." + value.minor + "." + value.patch +
      (prerelease === null ? "" : "-" + prerelease),
  };
}

function atLeastStructured(version: PearVersion): boolean {
  if (version.major !== 3) return version.major > 3;
  if (version.minor !== 2) return version.minor > 2;
  return version.patch >= 0;
}

export function capabilitiesForVersion(value: string | PearVersion): PearCapabilities {
  const version = normalizedVersion(value);
  if (version === null || !atLeastStructured(version)) {
    return {
      state: "unsupported",
      supported: false,
      contract: null,
      version,
      capabilities: NO_CAPABILITIES,
      reason: "Pear 3.2.0 or newer is required for structured operations",
    };
  }
  const exactContract = version.major === 3 && version.minor === 2;
  return {
    state: exactContract ? "supported" : "fallback",
    supported: true,
    contract: "pear-3.2-ndjson",
    version,
    capabilities: CAPABILITIES,
    reason: exactContract ? null : "Using the stable Pear 3.2 structured-output compatibility contract",
  };
}

export function capabilitiesFromVersionOutput(output: string): PearCapabilities {
  const version = parsePearVersionOutput(output);
  if (version === null) throw new Error("Pear returned invalid SemVer metadata");
  return capabilitiesForVersion(version);
}
