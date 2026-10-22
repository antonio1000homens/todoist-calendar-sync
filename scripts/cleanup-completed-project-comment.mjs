#!/usr/bin/env node
// Provider-aware follow-up to #114. Never run automatically: one exact
// project comment, dry-run by default and two explicit confirmations for apply.
import {
  completedCommentProjectId, completedProjectCommentAdapter, retireCompletedProjectMappingComment,
} from "../dist/completed-project-comment-cleanup.js";

const args = process.argv.slice(2);
const options = new Map();
for (const arg of args) {
  if (arg === "--apply") { if (options.has("apply")) throw new Error("Duplicate --apply"); options.set("apply","true"); continue; }
  const match = /^--(profile|task-id|event-id|comment-id|confirm-comment-id)=(.+)$/.exec(arg);
  if (!match || options.has(match[1])) throw new Error("Unknown, empty, or duplicate option: " + arg);
  options.set(match[1], match[2]);
}
const profile = options.get("profile");
if (!["home","antonio","work"].includes(profile)) throw new Error("--profile=home|antonio|work is required");
for (const name of ["task-id","event-id","comment-id"]) {
  if (!options.get(name)) throw new Error("--" + name + " is required");
}
const apply = options.has("apply");
if (apply && options.get("confirm-comment-id") !== options.get("comment-id")) {
  throw new Error("Apply requires --confirm-comment-id=<the exact --comment-id value>");
}
if (!apply && options.has("confirm-comment-id")) {
  throw new Error("--confirm-comment-id is valid only with --apply");
}
if (!process.env.STATE_TABLE_NAME) throw new Error("STATE_TABLE_NAME is required");
const target = {
  profile, taskId: options.get("task-id"), eventId: options.get("event-id"),
  commentId: options.get("comment-id"), projectId: completedCommentProjectId(profile),
};
const adapter = await completedProjectCommentAdapter(profile);
const result = await retireCompletedProjectMappingComment(target,adapter,{apply});
console.log(JSON.stringify({mode:apply?"apply":"dry-run",...result},null,2));
if (result.status !== (apply?"retired":"eligible")) process.exitCode=2;
