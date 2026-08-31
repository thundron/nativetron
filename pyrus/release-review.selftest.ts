import { reviewRelease } from "./release-review.js";
import { SAMPLE_REVIEW, SAFE_REVIEW } from "./sample.js";

const expected = [
  "local-state",
  "secret-file",
  "credential-pattern",
  "unexpected-binary",
  "nested-generated-output",
  "large-addition",
  "deletion",
];
const unsafe = reviewRelease(SAMPLE_REVIEW);
if (!unsafe.changelog.valid || !unsafe.changelog.currentVersionPresent || !unsafe.blocking) {
  throw new Error("unsafe changelog result mismatch");
}
if (unsafe.changelog.contentHash === null || unsafe.changelog.contentHash.length !== 64) {
  throw new Error("changelog hash mismatch");
}
if (unsafe.findings.length !== expected.length) throw new Error("finding count mismatch");
for (let i = 0; i < expected.length; i++) {
  if (unsafe.findings[i]!.code !== expected[i]) throw new Error("finding order mismatch");
}
const safe = reviewRelease(SAFE_REVIEW);
if (safe.blocking || safe.findings.length !== 0 || !safe.changelog.currentVersionPresent) {
  throw new Error("safe review mismatch");
}
console.log("PYRUS_RELEASE_REVIEW=OK");
