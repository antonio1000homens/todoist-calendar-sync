#!/usr/bin/env node
/**
 * Phase B sandbox capture and read-only provider validation (#290).
 *
 * NEVER imports the production synchronizer or calls any mutation method.
 * The operator manually completes ONE task in an isolated Todoist project
 * between 'before' and 'after'. This script cannot prove that human action
 * from snapshots alone, and its verdict never authorizes a production write.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleCalendar, Todoist } from "../dist/providers.js";
import { todoistPhaseBCandidate } from "../dist/todoist-calendar-phase-b.js";
import { assessTodoistPhaseBProviders } from "../dist/todoist-calendar-phase-b-evidence.js";

const requiredEnv = [
  "PHASE_B_SANDBOX_TODOIST_TOKEN",
  "PHASE_B_SANDBOX_GOOGLE_CREDENTIALS_JSON",
  "PHASE_B_SANDBOX_CALENDAR_ID",
  "PHASE_B_SANDBOX_PROJECT_ID",
  "SYNC_PROFILE_CONFIG_JSON",
];

export function validateSandboxEnvironment(env) {
  for (const name of requiredEnv) {
    if (!env[name] || !String(env[name]).trim()) throw new Error(name + " is required");
  }
  if (env.PHASE_B_SANDBOX_CONFIRM !== "isolated-test-assets")
    throw new Error("PHASE_B_SANDBOX_CONFIRM must equal isolated-test-assets");
  let profiles;
  let credentials;
  try {
    profiles = JSON.parse(env.SYNC_PROFILE_CONFIG_JSON);
    credentials = JSON.parse(env.PHASE_B_SANDBOX_GOOGLE_CREDENTIALS_JSON);
  } catch { throw new Error("Invalid sandbox Google credentials or managed profile configuration JSON"); }
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)
    || !["home", "antonio", "work"].every((name) => profiles[name]?.calendarId
      && profiles[name]?.todoistProjectId))
    throw new Error("All managed profile calendar/project IDs must be supplied for sandbox isolation checks");
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials))
    throw new Error("Sandbox Google credentials must be a JSON object");
  const calendarId = env.PHASE_B_SANDBOX_CALENDAR_ID;
  const projectId = env.PHASE_B_SANDBOX_PROJECT_ID;
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.calendarId === calendarId || profile.todoistProjectId === projectId)
      throw new Error("Sandbox assets overlap the configured " + name + " sync profile");
  }
  if (calendarId === projectId) throw new Error("Sandbox calendar and project IDs must be distinct");
  return {
    calendarId, projectId, credentials,
    token: env.PHASE_B_SANDBOX_TODOIST_TOKEN,
  };
}

export function parseArgs(argv) {
  const action = argv[0];
  if (!["before", "after", "verify"].includes(action))
    throw new Error("Action must be before, after or verify");
  const flags = new Map();
  const names = new Set(["file", "task-id", "master-id", "anchor-start", "time-zone", "anchor-note"]);
  for (let i = 1; i < argv.length; i += 2) {
    const name = argv[i]?.startsWith("--") ? argv[i].slice(2) : undefined;
    const value = argv[i + 1];
    if (!name || !names.has(name) || !value || value.startsWith("--") || flags.has(name))
      throw new Error("Unknown, duplicate or incomplete CLI argument");
    flags.set(name, value);
  }
  if (!flags.get("file")) throw new Error("--file is required");
  if (action !== "before" && [...flags.keys()].some((key) => key !== "file"))
    throw new Error("Only --file is supported for after/verify");
  if (action === "before" && ["task-id", "master-id", "anchor-start", "anchor-note"]
    .some((name) => !flags.get(name)))
    throw new Error("before requires --task-id, --master-id, --anchor-start and --anchor-note");
  return { action, file: flags.get("file"), flags };
}

/** Persist only recurrence observations, not descriptions, URLs or API tokens. */
export function snapshotTask(task) {
  return {
    id: task?.id, project_id: task?.project_id,
    is_completed: Boolean(task?.is_completed),
    is_deleted: Boolean(task?.is_deleted),
    due: task?.due ? {
      date: task.due.date,
      datetime: task.due.datetime,
      timezone: task.due.timezone,
      string: task.due.string,
      is_recurring: task.due.is_recurring,
    } : null,
  };
}

export function matchingSandboxSnapshot(task, taskId, projectId) {
  return Boolean(task?.id === taskId && task.project_id === projectId
    && task.is_deleted !== true && task.is_completed !== true
    && task.due?.is_recurring === true && task.due?.string
    && (task.due?.date || task.due?.datetime));
}

export function validateCaptureManifest(manifest, assets, requireAfter = false) {
  if (!manifest || manifest.version !== 1 || manifest.type !== "todoist-phase-b-sandbox"
    || manifest.sandboxCalendarId !== assets.calendarId
    || manifest.sandboxProjectId !== assets.projectId)
    throw new Error("Manifest does not belong to the current isolated sandbox assets");
  const src = manifest.source;
  if (!src || typeof src.taskId !== "string" || !src.taskId
    || typeof src.masterId !== "string" || !src.masterId
    || src.todoistProjectId !== assets.projectId
    || src.anchor?.source !== "verified_original_schedule"
    || !matchingSandboxSnapshot(src.beforeCompletion, src.taskId, assets.projectId))
    throw new Error("Manifest identity, original anchor or before-completion observation is invalid");
  if (typeof manifest.anchorEvidenceNote !== "string" || !manifest.anchorEvidenceNote.trim())
    throw new Error("Original schedule provenance note is required");
  if (!Number.isFinite(Date.parse(manifest.beforeCapturedAt)))
    throw new Error("Before-capture timestamp is invalid");
  if (requireAfter) {
    if (!matchingSandboxSnapshot(src.afterCompletion, src.taskId, assets.projectId)
      || !Number.isFinite(Date.parse(manifest.afterCapturedAt))
      || Date.parse(manifest.afterCapturedAt) < Date.parse(manifest.beforeCapturedAt))
      throw new Error("Missing, mismatched or out-of-order post-completion capture");
    const beforeDue = JSON.stringify(src.beforeCompletion.due);
    const afterDue = JSON.stringify(src.afterCompletion.due);
    if (beforeDue === afterDue) throw new Error("Todoist recurrence did not advance");
  }
}

async function atomicSave(path, value) {
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export async function runCapture(action, args, env, dependencies = {}) {
  const assets = validateSandboxEnvironment(env);
  const todoist = dependencies.todoist || new Todoist(assets.token);
  const calendar = dependencies.calendar || new GoogleCalendar(assets.credentials, assets.calendarId);
  const read = dependencies.read || (async (path) => JSON.parse(await readFile(path, "utf8")));
  const create = dependencies.create || (async (path, data) =>
    writeFile(path, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 }));
  const save = dependencies.save || atomicSave;
  const now = dependencies.now || (() => new Date().toISOString());
  if (action === "before") {
    const taskId = args.flags.get("task-id");
    const masterId = args.flags.get("master-id");
    const anchor = {
      start: args.flags.get("anchor-start"),
      ...(args.flags.get("time-zone") ? { timeZone: args.flags.get("time-zone") } : {}),
      source: "verified_original_schedule",
    };
    const current = snapshotTask(await todoist.getTask(taskId));
    if (!matchingSandboxSnapshot(current, taskId, assets.projectId))
      throw new Error("Todoist task must be a live recurrence in the isolated sandbox project");
    const candidate = todoistPhaseBCandidate(current, anchor);
    if (!candidate.family || !candidate.candidateRrule
      || candidate.reason !== "provider_readback_required")
      throw new Error("Before snapshot is not an anchored Phase B recurrence candidate: " + candidate.reason);
    const [master, linked] = await Promise.all([
      calendar.getEvent(masterId),
      calendar.findByTodoistTaskId(taskId),
    ]);
    if (master.id !== masterId || linked?.id !== masterId
      || master.status !== "confirmed" || master.extendedProperties?.shared?.taskId !== taskId
      || master.extendedProperties?.shared?.syncRecurrenceOwner !== "todoist"
      || master.extendedProperties?.shared?.todoistAnchorStart !== anchor.start)
      throw new Error("Sandbox Calendar master and exact Todoist linkage are not verified");
    const manifest = {
      version: 1, type: "todoist-phase-b-sandbox",
      sandboxCalendarId: assets.calendarId,
      sandboxProjectId: assets.projectId,
      anchorEvidenceNote: args.flags.get("anchor-note"),
      beforeCapturedAt: now(),
      source: {
        taskId, masterId, todoistProjectId: assets.projectId,
        anchor, beforeCompletion: current,
      },
    };
    await create(args.file, manifest);
    return { action, status: "captured", family: candidate.family,
      next: "Manually complete the isolated Todoist task once, then run after" };
  }
  const manifest = await read(args.file);
  validateCaptureManifest(manifest, assets);
  if (action === "after") {
    if (manifest.source.afterCompletion || manifest.afterCapturedAt)
      throw new Error("After snapshot already exists; do not overwrite captured completion evidence");
    const after = snapshotTask(await todoist.getTask(manifest.source.taskId));
    if (!matchingSandboxSnapshot(after, manifest.source.taskId, assets.projectId))
      throw new Error("Todoist task must still be an active recurrence in the same test project");
    const updated = {
      ...manifest, afterCapturedAt: now(),
      source: { ...manifest.source, afterCompletion: after },
    };
    validateCaptureManifest(updated, assets, true);
    await save(args.file, updated);
    return { action, status: "captured",
      next: "Run verify to fetch Calendar instances and cross-check provider progression" };
  }
  validateCaptureManifest(manifest, assets, true);
  const decision = await assessTodoistPhaseBProviders(manifest.source, { todoist, calendar });
  // The result is diagnostic; no method in this file can authorize production
  // native conversion or mutate a Calendar or Todoist resource.
  return { action, status: "read_only_assessment", disposition: decision.disposition,
    reason: decision.reason, family: decision.family, observations: decision.observations,
    productionWriteAuthorized: false };
}

async function main() {
  const { action, file, flags } = parseArgs(process.argv.slice(2));
  const result = await runCapture(action, { file, flags }, process.env);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write("Phase B sandbox capture failed: " + (error?.message || "unknown error") + "\n");
    process.exitCode = 1;
  });
}
