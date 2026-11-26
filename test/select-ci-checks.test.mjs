import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

function select(...files) {
  const output = execFileSync(process.execPath, ["scripts/select-ci-checks.mjs", ...files], { encoding: "utf8" });
  return Object.fromEntries(output.trim().split("\n").map((line) => {
    const [key, value] = line.split("=");
    return [key, value === "true"];
  }));
}

test("documentation changes keep stable CI green without running builds", () => {
  assert.deepEqual(select("README.md", "docs/runbook.md"), {
    full: false, unit: false, worker: false, sam: false, public: true, e2eSyntax: false,
  });
});

test("test-only changes select unit tests while source and workflow changes select the full suite", () => {
  assert.equal(select("test/sync.test.mjs").unit, true);
  assert.equal(select("test/sync.test.mjs").full, false);
  assert.equal(select("test/fixtures/provider.json").full, true);
  assert.equal(select("src/sync.ts").full, true);
  assert.equal(select(".github/workflows/ci.yml").full, true);
});

test("Worker and infrastructure changes select their relevant checks", () => {
  assert.equal(select("cloudflare/calendar-sync/worker.ts").worker, true);
  assert.equal(select("template.yaml").sam, true);
});
