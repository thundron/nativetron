import type { ReleaseReviewRequest } from "./release-review.js";

export const SAMPLE_REVIEW: ReleaseReviewRequest = {
  packageVersion: "1.2.3",
  changelog: "# Changelog\n\n## 1.2.3 - 2026-08-31\n\n- Release candidate\n",
  diff: [
    { path: "src/old.ts", action: "delete", beforeBytes: 40, afterBytes: 0 },
    { path: "dist/build/app.wasm", action: "add", afterBytes: 30 * 1024 * 1024 },
    { path: ".env.production", action: "add", afterBytes: 40, preview: "API_KEY=abcdefghijk" },
    { path: ".DS_Store", action: "add", afterBytes: 6148 },
  ],
};

export const SAFE_REVIEW: ReleaseReviewRequest = {
  packageVersion: "1.2.3",
  changelog: "# Changelog\n\n## 1.2.3\n\n- Safe release\n",
  diff: [
    { path: "src/index.ts", action: "change", beforeBytes: 100, afterBytes: 120, preview: "export const ok = true;" },
  ],
};
