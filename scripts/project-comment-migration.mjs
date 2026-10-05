import { runProjectCommentMigration } from "../dist/project-comment-migration.js";

const profiles = ["home", "antonio", "work"];
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const cleanupLegacy = args.includes("--cleanup-legacy");
const target = args.find((arg) => !arg.startsWith("--"));

if (!target || (target !== "all" && !profiles.includes(target))) {
  console.error("Usage: npm run migrate:project-comments -- <home|antonio|work|all> [--cleanup-legacy] [--apply]");
  process.exitCode = 2;
} else {
  const selected = target === "all" ? profiles : [target];
  const results = {};
  for (const profile of selected) {
    results[profile] = await runProjectCommentMigration(profile, apply, cleanupLegacy);
  }
  console.log(JSON.stringify({
    mode: apply ? "apply" : "report",
    cleanupLegacy,
    results,
  }, null, 2));
}
