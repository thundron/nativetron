import { changelogStatus, type ChangelogStatus } from "./changelog.js";
import { scanSuspiciousContent, type SemanticDiffEntry, type SuspiciousFinding } from "./suspicious-scanner.js";

export interface ReleaseReviewRequest {
  packageVersion: string | null;
  changelog: string | null;
  diff: SemanticDiffEntry[];
}

export interface ReleaseReview {
  changelog: ChangelogStatus;
  findings: SuspiciousFinding[];
  blocking: boolean;
}

export function reviewRelease(request: ReleaseReviewRequest): ReleaseReview {
  const changelog = changelogStatus(request.changelog, request.packageVersion);
  const findings = scanSuspiciousContent(request.diff);
  let blocking = !changelog.valid || !changelog.currentVersionPresent;
  for (let i = 0; i < findings.length; i++) {
    if (findings[i]!.severity === "high") blocking = true;
  }
  return { changelog, findings, blocking };
}
