import { buildOperationArgv, buildVersionedArgv } from "./argv.js";
import { capabilitiesForVersion, PearCapabilityError } from "./capabilities.js";

function rejected(operation: string, input: unknown, message: string): boolean {
  try {
    buildOperationArgv(operation, input);
  } catch (error) {
    return error instanceof Error && error.message === message;
  }
  return false;
}

function main(): void {
  const build = buildOperationArgv("build", {
    package: "/tmp/package.json",
    target: "/tmp/out",
    darwinArm64App: "/tmp/App.app",
  });
  const stage = buildOperationArgv("stage", {
    link: "pear://abc",
    directory: "/tmp/project",
    dryRun: true,
    purge: false,
    ignore: ["a", "b"],
    only: "src",
  });
  const forced = buildOperationArgv("stage-dry-run", {
    link: "pear://abc",
    directory: "/tmp/project",
    dryRun: false,
  });
  const seed = buildOperationArgv("seed", { link: "pear://abc", statsInterval: 250 });
  const list = buildOperationArgv("list", { link: "pear://abc", list: false });
  const multisig = buildOperationArgv("multisig-verify", { request: "req", responses: ["a", "b"] });
  const many: string[] = [];
  for (let i = 0; i < 31; i++) many.push("x");
  const large: string[] = [];
  for (let i = 0; i < 9; i++) large.push("x".repeat(4096));
  const versioned = buildVersionedArgv(capabilitiesForVersion("4.0.0"), "touch", {});
  let oldVersionRejected = false;
  try {
    buildVersionedArgv(capabilitiesForVersion("3.1.9"), "touch", {});
  } catch (error) {
    oldVersionRejected = error instanceof PearCapabilityError &&
      error.code === "PEAR_VERSION_UNSUPPORTED" &&
      error.message === "Pear 3.2.0 or newer is required for structured operations";
  }
  const ok = build.join("|") === "build|--json|--package|/tmp/package.json|--target|/tmp/out|--darwin-arm64-app|/tmp/App.app"
    && stage.join("|") === "stage|pear://abc|/tmp/project|--json|--dry-run|--ignore|a|--ignore|b|--only|src"
    && forced.join("|") === "stage|pear://abc|/tmp/project|--json|--dry-run"
    && seed.join("|") === "seed|pear://abc|--json|--no-tty|--stats-interval|250"
    && list.join("|") === "dump|pear://abc|--json|--list"
    && multisig.join("|") === "multisig|verify|req|a|b|--json"
    && versioned.join("|") === "touch|--json" && oldVersionRejected
    && rejected("touch", { secret: "value" }, "secret material is not supported by semantic operations")
    && rejected("touch", { secret: undefined }, "secret material is not supported by semantic operations")
    && rejected("touch", { extra: true }, "operation input.extra is not allowed")
    && rejected("touch", { extra: undefined }, "operation input.extra is not allowed")
    && rejected("info", { link: "bad\nvalue" }, "link is invalid")
    && rejected("versions", { modules: "yes" }, "modules must be a boolean")
    && rejected("info", { link: "--secret" }, "secret-output options are forbidden in semantic operations")
    && rejected("stage", { link: "a", directory: "b", only: many }, "operation has too many arguments")
    && rejected("stage", { link: "a", directory: "b", only: large }, "operation arguments are too large")
    && rejected("unknown", {}, "unsupported semantic operation: unknown");
  console.log(ok ? "PYRUS_ARGV=OK" : "PYRUS_ARGV=FAIL");
  if (!ok) process.exit(1);
}

main();
