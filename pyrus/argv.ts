import { PearCapabilityError, requireStructuredCapabilities, type PearCapabilities } from "./capabilities.js";

const MAX_ARGUMENT_LENGTH = 4096;
const MAX_ARGUMENTS = 64;
const MAX_TOTAL_ARGUMENT_LENGTH = 32768;

type Input = Record<string, unknown>;

function inputObject(value: unknown): Input {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("operation input must be a plain object");
  const input = value as Input;
  if (Object.hasOwn(input, "secret"))
    throw new TypeError("secret material is not supported by semantic operations");
  return input;
}

function exact(input: Input, allowed: string[]): void {
  const keys = Object.keys(input);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (!allowed.includes(key)) throw new TypeError("operation input." + key + " is not allowed");
  }
}

function token(value: unknown, label: string, required = true, integer = false): string | null {
  if (!required && (value === null || value === undefined)) return null;
  let text: unknown = value;
  if (integer) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new TypeError(label + " must be a non-negative integer");
    text = value.toString();
  }
  if (typeof text !== "string" || (required && text.length === 0) ||
      text.length > MAX_ARGUMENT_LENGTH || /[\0\r\n]/u.test(text))
    throw new TypeError(label + " is invalid");
  return text;
}

function values(value: unknown, label: string): string[] {
  if (value === null || value === undefined) return [];
  const entries: unknown[] = Array.isArray(value) ? value : [value];
  const result: string[] = [];
  for (let i = 0; i < entries.length; i++) result.push(token(entries[i], label + "[" + i + "]")!);
  return result;
}

function booleanFlag(name: string): string {
  if (name === "dryRun") return "--dry-run";
  if (name === "metadata") return "--metadata";
  if (name === "manifest") return "--manifest";
  if (name === "multisig") return "--multisig";
  if (name === "key") return "--key";
  if (name === "purge") return "--purge";
  if (name === "force") return "--force";
  if (name === "noPrune") return "--no-prune";
  if (name === "allCores") return "--all-cores";
  if (name === "modules") return "--modules";
  if (name === "full") return "--full";
  throw new Error("unknown boolean flag");
}

function flag(argv: string[], name: string, value: unknown): void {
  if (value === true) argv.push(booleanFlag(name));
  else if (value !== false && value !== null && value !== undefined)
    throw new TypeError(name + " must be a boolean");
}

function option(argv: string[], name: string, value: unknown, integer = false): void {
  if (value !== null && value !== undefined) argv.push(name, token(value, name, true, integer)!);
}

function finish(argv: string[]): string[] {
  const forbiddenSecretFlag = ["--", "secret"].join("");
  let bytes = 0;
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]!;
    if (item === forbiddenSecretFlag || item.startsWith(forbiddenSecretFlag + "="))
      throw new TypeError("secret-output options are forbidden in semantic operations");
    bytes += Buffer.byteLength(item);
  }
  if (argv.length > MAX_ARGUMENTS) throw new RangeError("operation has too many arguments");
  if (bytes > MAX_TOTAL_ARGUMENT_LENGTH) throw new RangeError("operation arguments are too large");
  return argv;
}

export function buildTouchArgv(value: unknown): string[] {
  const input = inputObject(value);
  exact(input, ["vanity"]);
  const argv = ["touch", "--json"];
  option(argv, "--vanity", input["vanity"]);
  return finish(argv);
}

export function buildInfoArgv(value: unknown): string[] {
  const input = inputObject(value);
  exact(input, ["link", "directory", "metadata", "manifest", "multisig", "key"]);
  const argv = ["info", token(input["link"], "link")!, "--json"];
  if (input["directory"] !== null && input["directory"] !== undefined)
    argv.splice(2, 0, token(input["directory"], "directory")!);
  const names = ["metadata", "manifest", "multisig", "key"];
  for (let i = 0; i < names.length; i++) flag(argv, names[i]!, input[names[i]!]);
  return finish(argv);
}

const BUILD_PATH_NAMES = [
  "darwinArm64App", "darwinX64App", "linuxArm64App", "linuxX64App",
  "win32X64App", "win32Arm64App", "iosArm64", "iosArm64Simulator",
  "iosX64Simulator", "androidArm64",
];
const BUILD_PATH_FLAGS = [
  "--darwin-arm64-app", "--darwin-x64-app", "--linux-arm64-app", "--linux-x64-app",
  "--win32-x64-app", "--win32-arm64-app", "--ios-arm64", "--ios-arm64-simulator",
  "--ios-x64-simulator", "--android-arm64",
];

export function buildBuildArgv(value: unknown): string[] {
  const input = inputObject(value);
  exact(input, ["package", "target", "darwinArm64App", "darwinX64App", "linuxArm64App", "linuxX64App",
    "win32X64App", "win32Arm64App", "iosArm64", "iosArm64Simulator", "iosX64Simulator", "androidArm64"]);
  const argv = ["build", "--json"];
  option(argv, "--package", input["package"]);
  option(argv, "--target", input["target"]);
  for (let i = 0; i < BUILD_PATH_NAMES.length; i++)
    option(argv, BUILD_PATH_FLAGS[i]!, input[BUILD_PATH_NAMES[i]!]);
  return finish(argv);
}

function buildStage(value: unknown, forceDryRun: boolean): string[] {
  const input = inputObject(value);
  exact(input, ["link", "directory", "dryRun", "ignore", "only", "purge"]);
  const argv = ["stage", token(input["link"], "link")!, token(input["directory"], "directory")!, "--json"];
  flag(argv, "dryRun", forceDryRun ? true : input["dryRun"]);
  flag(argv, "purge", input["purge"]);
  const ignored = values(input["ignore"], "ignore");
  for (let i = 0; i < ignored.length; i++) argv.push("--ignore", ignored[i]!);
  const only = values(input["only"], "only");
  for (let i = 0; i < only.length; i++) argv.push("--only", only[i]!);
  return finish(argv);
}

export function buildStageArgv(value: unknown): string[] { return buildStage(value, false); }
export function buildStageDryRunArgv(value: unknown): string[] { return buildStage(value, true); }

function buildProvision(value: unknown, forceDryRun: boolean): string[] {
  const input = inputObject(value);
  exact(input, ["source", "target", "production", "dryRun"]);
  const argv = ["provision", token(input["source"], "source")!, token(input["target"], "target")!];
  if (input["production"] !== null && input["production"] !== undefined)
    argv.push(token(input["production"], "production")!);
  argv.push("--json");
  flag(argv, "dryRun", forceDryRun ? true : input["dryRun"]);
  return finish(argv);
}

export function buildProvisionArgv(value: unknown): string[] { return buildProvision(value, false); }
export function buildProvisionDryRunArgv(value: unknown): string[] { return buildProvision(value, true); }

export function buildSeedArgv(value: unknown): string[] {
  const input = inputObject(value);
  exact(input, ["link", "untilSync", "statsInterval"]);
  const argv = ["seed", token(input["link"], "link")!, "--json", "--no-tty"];
  option(argv, "--until-sync", input["untilSync"]);
  option(argv, "--stats-interval", input["statsInterval"], true);
  return finish(argv);
}

export function buildInstallArgv(value: unknown): string[] {
  const input = inputObject(value);
  exact(input, ["link", "only", "timeout", "destination", "dhtBootstrap"]);
  const argv = ["install", token(input["link"], "link")!, "--json"];
  option(argv, "--only", input["only"]);
  option(argv, "--timeout", input["timeout"], true);
  option(argv, "--to", input["destination"]);
  option(argv, "--dht-bootstrap", input["dhtBootstrap"]);
  return finish(argv);
}

function buildDump(value: unknown, forceList: boolean): string[] {
  const input = inputObject(value);
  exact(input, ["link", "directory", "dryRun", "checkout", "only", "force", "list", "noPrune"]);
  const argv = ["dump", token(input["link"], "link")!];
  if (input["directory"] !== null && input["directory"] !== undefined)
    argv.push(token(input["directory"], "directory")!);
  argv.push("--json");
  flag(argv, "dryRun", input["dryRun"]);
  flag(argv, "force", input["force"]);
  flag(argv, "noPrune", input["noPrune"]);
  const listValue: unknown = forceList ? true : input["list"];
  if (listValue === true) argv.push("--list");
  else if (listValue !== null && listValue !== undefined && listValue !== false)
    throw new TypeError("list must be a boolean");
  option(argv, "--checkout", input["checkout"], true);
  const only = values(input["only"], "only");
  for (let i = 0; i < only.length; i++) argv.push("--only", only[i]!);
  return finish(argv);
}

export function buildDumpArgv(value: unknown): string[] { return buildDump(value, false); }
export function buildListArgv(value: unknown): string[] { return buildDump(value, true); }
export function buildExportArgv(value: unknown): string[] { return buildDump(value, false); }

export function buildChangelogArgv(value: unknown): string[] {
  const input = inputObject(value);
  exact(input, ["link", "max", "of", "full"]);
  const argv = ["changelog", token(input["link"], "link")!, "--json"];
  option(argv, "--max", input["max"], true);
  option(argv, "--of", input["of"]);
  flag(argv, "full", input["full"]);
  return finish(argv);
}

export function buildCoresArgv(value: unknown): string[] {
  const input = inputObject(value);
  exact(input, ["allCores"]);
  const argv = ["cores", "--json"];
  flag(argv, "allCores", input["allCores"]);
  return finish(argv);
}

export function buildGcCoresArgv(value: unknown): string[] {
  const input = inputObject(value);
  exact(input, ["link"]);
  const argv = ["gc", "--json", "cores"];
  if (input["link"] !== null && input["link"] !== undefined)
    argv.push(token(input["link"], "link")!);
  return finish(argv);
}

export function buildVersionsArgv(value: unknown): string[] {
  const input = inputObject(value);
  exact(input, ["modules"]);
  const argv = ["versions", "--json"];
  flag(argv, "modules", input["modules"]);
  return finish(argv);
}

export function buildDhtArgv(value: unknown): string[] {
  const input = inputObject(value);
  exact(input, []);
  return finish(["data", "--json", "dht"]);
}

function multisig(operation: string, value: unknown, allowed: string[], required: string[]): string[] {
  const input = inputObject(value);
  exact(input, allowed);
  const argv = ["multisig", operation];
  for (let i = 0; i < required.length; i++) {
    const name = required[i]!;
    argv.push(token(input[name], name)!);
  }
  const responses = values(input["responses"], "responses");
  for (let i = 0; i < responses.length; i++) argv.push(responses[i]!);
  argv.push("--json");
  return finish(argv);
}

export function buildMultisigRequestArgv(value: unknown): string[] {
  return multisig("request", value, ["link"], ["link"]);
}
export function buildMultisigVerifyArgv(value: unknown): string[] {
  return multisig("verify", value, ["request", "responses"], ["request"]);
}
export function buildMultisigCommitArgv(value: unknown): string[] {
  return multisig("commit", value, ["request", "responses"], ["request"]);
}
export function buildMultisigKeysListArgv(value: unknown): string[] {
  const input = inputObject(value);
  exact(input, []);
  return finish(["multisig", "keys", "list", "--json"]);
}

export function buildOperationArgv(operation: string, value: unknown): string[] {
  if (operation === "touch") return buildTouchArgv(value);
  if (operation === "info") return buildInfoArgv(value);
  if (operation === "build") return buildBuildArgv(value);
  if (operation === "stage") return buildStageArgv(value);
  if (operation === "stage-dry-run") return buildStageDryRunArgv(value);
  if (operation === "provision") return buildProvisionArgv(value);
  if (operation === "provision-dry-run") return buildProvisionDryRunArgv(value);
  if (operation === "seed") return buildSeedArgv(value);
  if (operation === "install") return buildInstallArgv(value);
  if (operation === "dump") return buildDumpArgv(value);
  if (operation === "list") return buildListArgv(value);
  if (operation === "export") return buildExportArgv(value);
  if (operation === "changelog") return buildChangelogArgv(value);
  if (operation === "cores") return buildCoresArgv(value);
  if (operation === "gc-cores") return buildGcCoresArgv(value);
  if (operation === "versions") return buildVersionsArgv(value);
  if (operation === "dht") return buildDhtArgv(value);
  if (operation === "multisig-request") return buildMultisigRequestArgv(value);
  if (operation === "multisig-verify") return buildMultisigVerifyArgv(value);
  if (operation === "multisig-commit") return buildMultisigCommitArgv(value);
  if (operation === "multisig-keys-list") return buildMultisigKeysListArgv(value);
  throw new TypeError("unsupported semantic operation: " + operation);
}

export function buildVersionedArgv(capabilityRecord: PearCapabilities, operation: string, value: unknown): string[] {
  const supported = requireStructuredCapabilities(capabilityRecord);
  if (supported.contract !== "pear-3.2-ndjson") {
    throw new PearCapabilityError(
      "PEAR_CONTRACT_UNSUPPORTED",
      "Unsupported Pear structured-output contract: " + (supported.contract ?? "none"),
    );
  }
  return buildOperationArgv(operation, value);
}
