# Pyrus compiled workflow ports

## Release review

Sources: `project-pyrus/src/main/releases/changelog.js` and `suspicious-scanner.js`.

The compiled slice validates changelog SemVer headings and hashes, normalizes and sorts semantic deployment diffs, enforces scan/preview/finding limits, and reports secret files, local state, binaries, nested generated output, large additions, deletions, and credential patterns. `app/main.ts` exposes it as `pyrus:review-release` over binary IPC.

Differences:

- CommonJS became typed ESM.
- `localeCompare(value, "en")` became the statically lowered one-argument code-unit comparator. Finding content is unchanged; only presentation order can differ for non-ASCII paths. The two-argument ICU collation remains `SC2020`.
- Returned records are not frozen. They remain private values serialized immediately by the main-process handler.

This port drove static compiler support for non-empty literal-string `replaceAll` and named `node:path` `posix` namespace imports. Dynamic or empty string patterns remain an explicit compile-time refusal.

## Pear NDJSON

Source: `project-pyrus/src/main/pear/ndjson.js`.

The compiled parser preserves Pyrus's shared byte, line, object, event-count, UTF-8, JSON-shape, identity, structured-error, and nesting limits. It handles fragmented lines and CRLF, classifies known tags, and rejects malformed UTF-8 through `node:util.TextDecoder("utf-8", { fatal: true })`. `app/main.ts` exposes it as `pyrus:parse-ndjson` over binary IPC.

Differences:

- CommonJS and `Buffer` became typed ESM and `Uint8Array`.
- Parsed values are not deeply frozen. They remain private values reduced to a summary by the main-process handler.
- `PearNDJSONError.details` is omitted; IPC returns the bounded error message.
- Custom known-tag maps are not exposed; the compiled parser uses Pyrus's default command/tag contract.

This port drove exact fatal UTF-8 decoding in scriptc's C and LLVM backends and named `node:util` `TextDecoder` imports. Non-fatal decoder options and fatal non-UTF-8 decoders remain explicit `SC2020` refusals.

## Output sanitizer

Source: `project-pyrus/src/main/output-sanitizer.js`.

The compiled streaming sanitizer preserves Pyrus's UTF-8 chunk decoding, CRLF normalization, terminal escape-state handling, control-character filtering, and bidi-isolate filtering. `app/main.ts` exposes a bounded byte payload as `pyrus:sanitize-output` over binary IPC.

Differences:

- CommonJS and `Buffer` became typed ESM and `Uint8Array`.
- The IPC validation handler splits one bounded request into two chunks; process supervisors can use `OutputSanitizer` directly for arbitrary stream chunking.

This port drove exact `string.codePointAt` optional results and string-pattern `string.replace` support in scriptc's C and LLVM backends. Function replacement callbacks remain an explicit `SC1120` refusal.

## Pear links

Source: `project-pyrus/src/main/links/pear-link.js`.

The compiled parser preserves stable and versioned z-base-32/hex authorities, safe-integer fork and length checks, path depth and decoded-segment limits, percent-decoding failures, encoded separator and dot-segment rejection, fragment validation, and canonical/base-kind classification. `app/main.ts` exposes it as `pyrus:parse-link` with a 16 KiB pre-parse IPC cap.

Difference: returned records and path arrays are not frozen. They remain private values serialized immediately by the main-process handler.

## Untrusted structured data

Source: `project-pyrus/src/main/links/untrusted-data.js`.

The compiled sanitizer preserves control-character rejection, finite-number checks, UTF-8 byte accounting, unsafe-key rejection, undefined-to-null conversion, null-prototype output dictionaries, and configurable depth, node, string, byte, array, and object-key limits. `app/main.ts` exposes the default policy as `pyrus:sanitize-data` with a 512 KiB pre-parse IPC cap.

Differences:

- The IPC boundary accepts JSON, which cannot encode custom prototypes, functions, symbols, cycles, undefined properties, or non-finite numbers. The direct compiled sanitizer still handles undefined and rejects non-finite numbers, but has no JavaScript prototype objects to inspect.
- The separate recursive `freezeData` helper is not exposed; sanitized values remain private and are serialized immediately by the main-process handler.

## Semantic Pear arguments

Source: `project-pyrus/src/main/pear/argv.js`.

The compiled builders preserve the 21-operation allowlist, exact per-operation input keys, token type and control-character checks, integer checks, boolean flags, argument ordering, the 4,096-byte token limit, 64-argument limit, 32 KiB aggregate limit, and both direct and prefixed `--secret` rejection. `app/main.ts` exposes version-gated construction as `pyrus:build-argv` through an exact two-field request envelope capped at 128 KiB; the main process derives the capability record from its bounded `NT_PEAR_VERSION_OUTPUT`, not renderer input.

Differences:

- IPC JSON values cannot carry custom prototypes, so the plain-object check rejects null, arrays, and primitives without a prototype inspection step.
- Returned arrays are not frozen. They remain private values serialized immediately by the main-process handler.

This port drove `Object.hasOwn` for pure index-signature records and fixed one-item `Array.splice` insertion in scriptc's C and LLVM backends.

## Pear capability gate

Sources: `project-pyrus/src/main/pear/capabilities.js` and `src/shared/runtime-contracts.js`.

The compiled gate extracts bounded `SemVer=` metadata, strips build metadata, preserves prerelease values, enforces Pear 3.2.0 as the minimum structured-operation version, and distinguishes the exact 3.2 contract from later fallback versions. `app/main.ts` exposes it as `pyrus:pear-capabilities`; input is capped at the original 64 KiB executable-inspection output limit.

Differences:

- The compiled API accepts version strings or typed `PearVersion` records. Arbitrary object-shaped version inputs remain outside this slice.
- Returned records and capability arrays are not frozen. They remain private values serialized immediately by the main-process handler.

## Build output hash

Source: `project-pyrus/src/main/workflows/build-runtime.js`.

The compiled traversal preserves sorted breadth-first enumeration, symlink and unsupported-file rejection, the 10,000-artifact and 2 GiB limits, `O_NOFOLLOW`, path-stat versus handle-stat identity checks, post-read size and modification-time checks, bounded 64 KiB reads, and incremental SHA-256 hashing. `app/main.ts` exposes it as `pyrus:hash-build` only for the exact `NT_PYRUS_BUILD_ROOT`; responses remain below the IPC frame limit.

Differences:

- CommonJS became typed ESM.
- Directory reads return names and use `lstat` for type classification instead of retaining `Dirent` values; the subsequent checks and hash input are unchanged.

This port drove `Stats.dev`/`Stats.ino`, numeric `fs.promises.open` flags, `fs.constants.O_RDONLY`/`O_NOFOLLOW`, and owned incremental SHA-256/SHA-1 hash handles in scriptc's C and LLVM backends.

## Process environment

Sources: `project-pyrus/src/main/environment.js`, `output-sanitizer.js`, and the bounded stream handling in `process-manager.js`.

The compiled macOS path preserves Pyrus's environment allowlist, value bounds, NUL rejection, absolute-path requirement, canonicalization, directory check, and deduplication. The sample `proc:run` handler now accepts only `/usr/bin/uname` with `-a` or `-s`, ignores stdin, replaces the child environment, sanitizes both output streams, terminates after five seconds, and rejects output above 1 MiB.

Differences:

- The compiled desktop target is macOS-only, so PATH parsing uses the POSIX delimiter and `node:path` `posix` implementation. Pyrus's Windows branch remains in Pyrus.
- The sample executable policy is intentionally narrower than Pyrus's verified Pear process manager.
