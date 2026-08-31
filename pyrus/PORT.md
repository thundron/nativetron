# Pyrus release-review port

Source workflow: `project-pyrus/src/main/releases/changelog.js` and `suspicious-scanner.js`.

The compiled slice validates changelog SemVer headings and hashes, normalizes and sorts semantic deployment diffs, enforces scan/preview/finding limits, and reports secret files, local state, binaries, nested generated output, large additions, deletions, and credential patterns. `app/main.ts` exposes it as `pyrus:review-release` over binary IPC.

Differences from Pyrus:

- CommonJS became typed ESM.
- `localeCompare(value, "en")` became the statically lowered one-argument code-unit comparator. Finding content is unchanged; only presentation order can differ for non-ASCII paths. The two-argument ICU collation remains `SC2020`.
- Returned records are not frozen. They remain private values serialized immediately by the main-process handler.

The port drove static compiler support for non-empty literal-string `replaceAll` and named `node:path` `posix` namespace imports. Dynamic or empty string patterns remain an explicit compile-time refusal.
