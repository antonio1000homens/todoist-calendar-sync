import { runAutomaticProjectCommentMigration } from "../dist/project-comment-migration.js";

const result = await runAutomaticProjectCommentMigration();
console.log(JSON.stringify(result, null, 2));
if (result.status !== "completed") process.exitCode = 1;
