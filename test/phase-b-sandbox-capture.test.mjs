import assert from "node:assert/strict";
import test from "node:test";
import {
  matchingSandboxSnapshot, parseArgs, runCapture, snapshotTask,
  validateCaptureManifest, validateSandboxEnvironment,
} from "../scripts/phase-b-sandbox-capture.mjs";

const dates = ["2027-01-02", "2027-01-15", "2027-01-27", "2027-02-02"];
const expression = "every 2, 15, 27";

function environment(overrides = {}) {
  return {
    PHASE_B_SANDBOX_TODOIST_TOKEN: "sandbox-token",
    PHASE_B_SANDBOX_GOOGLE_CREDENTIALS_JSON: JSON.stringify({ client_id: "x", client_secret: "y", refresh_token: "z" }),
    PHASE_B_SANDBOX_CALENDAR_ID: "sandbox-calendar",
    PHASE_B_SANDBOX_PROJECT_ID: "sandbox-project",
    PHASE_B_SANDBOX_CONFIRM: "isolated-test-assets",
    SYNC_PROFILE_CONFIG_JSON: JSON.stringify({
      home: { calendarId: "home-calendar", todoistProjectId: "home-project" },
      antonio: { calendarId: "personal-calendar", todoistProjectId: "personal-project" },
      work: { calendarId: "work-calendar", todoistProjectId: "work-project" },
    }),
    ...overrides,
  };
}

function task(date = dates[0], overrides = {}) {
  return {
    id: "sandbox-task", project_id: "sandbox-project", content: "Do not persist me",
    description: "Sensitive fixture notes", url: "https://example.com/private",
    is_completed: false, is_deleted: false,
    due: { date, string: expression, is_recurring: true }, ...overrides,
  };
}
function master() {
  return {
    id: "sandbox-master", status: "confirmed", etag: "etag-1",
    start: { date: dates[0] }, end: { date: "2027-01-03" },
    recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27"],
    extendedProperties: { shared: {
      taskId: "sandbox-task", syncRecurrenceOwner: "todoist",
      todoistAnchorStart: dates[0], todoistRecurrence: expression,
    } },
  };
}
function instance(date, index) {
  return { id: "instance-" + index, recurringEventId: "sandbox-master",
    originalStartTime: { date }, start: { date }, status: "confirmed" };
}
function fixtures(afterTask = task(dates[1]), options = {}) {
  const calls = [];
  let manifest;
  const current = { value: task() };
  const calendarMaster = master();
  const todoist = {
    async getTask(id) { calls.push("getTask"); assert.equal(id, "sandbox-task");
      return structuredClone(current.value); },
    async upsertTask() { throw new Error("unexpected mutation"); },
    async deleteTask() { throw new Error("unexpected mutation"); },
  };
  const calendar = {
    async getEvent(id) { calls.push("getEvent"); assert.equal(id, "sandbox-master");
      return structuredClone(calendarMaster); },
    async findByTodoistTaskId(id) { calls.push("findByTodoistTaskId"); assert.equal(id, "sandbox-task");
      return structuredClone(calendarMaster); },
    async listExplicitSeriesExceptions() { calls.push("listExplicitSeriesExceptions");
      return structuredClone(options.exceptions || []); },
    async listInstancesInWindow(_id, from, through) {
      calls.push("listInstancesInWindow"); assert.ok(from < through);
      return structuredClone(options.instances || dates.map(instance));
    },
    async getTimeZone() { calls.push("getTimeZone"); return "Europe/London"; },
    async upsertEvent() { throw new Error("unexpected mutation"); },
    async deleteEvent() { throw new Error("unexpected mutation"); },
  };
  const dependencies = {
    todoist, calendar,
    now() { return current.value.due?.date === dates[0]
      ? "2027-01-01T10:00:00Z" : "2027-01-02T10:00:00Z"; },
    async read() { calls.push("readManifest"); return structuredClone(manifest); },
    async create(_path, data) {
      calls.push("createManifest"); assert.equal(manifest, undefined);
      manifest = structuredClone(data);
    },
    async save(_path, data) {
      calls.push("saveManifest"); manifest = structuredClone(data);
    },
  };
  return {
    calls, current, dependencies, afterTask, env: environment(),
    getManifest: () => structuredClone(manifest),
    setManifest: (value) => { manifest = structuredClone(value); },
  };
}
function args(action, extra = {}) {
  return { file: "tmp-phase-b.json", flags: new Map([
    ["file", "tmp-phase-b.json"],
    ...(action === "before" ? [
      ["task-id", "sandbox-task"],
      ["master-id", "sandbox-master"],
      ["anchor-start", dates[0]],
      ["anchor-note", "Verified separately from isolated fixture creation log"],
    ] : []),
    ...Object.entries(extra),
  ]) };
}
async function snapshotBefore(f) {
  const result = await runCapture("before", args("before"), f.env, f.dependencies);
  assert.equal(result.status, "captured");
  return f.getManifest();
}
async function snapshotAfter(f) {
  f.current.value = f.afterTask;
  return runCapture("after", args("after"), f.env, f.dependencies);
}

test("sandbox guard rejects production calendar/project collisions and unknown environments", () => {
  assert.equal(validateSandboxEnvironment(environment()).projectId, "sandbox-project");
  for (const bad of [
    { PHASE_B_SANDBOX_CONFIRM: undefined },
    { PHASE_B_SANDBOX_CALENDAR_ID: "home-calendar" },
    { PHASE_B_SANDBOX_PROJECT_ID: "work-project" },
    { SYNC_PROFILE_CONFIG_JSON: undefined },
    { SYNC_PROFILE_CONFIG_JSON: JSON.stringify({ home: {} }) },
    { PHASE_B_SANDBOX_GOOGLE_CREDENTIALS_JSON: "not-json" },
  ]) assert.throws(() => validateSandboxEnvironment(environment(bad)), JSON.stringify(bad));
});

test("CLI argument parsing requires explicit test identity, anchor and explanation", () => {
  const p = parseArgs([
    "before", "--file", "fixture.json", "--task-id", "t", "--master-id", "e",
    "--anchor-start", "2027-01-02", "--anchor-note", "external original schedule evidence",
  ]);
  assert.equal(p.flags.get("anchor-start"), dates[0]);
  for (const params of [
    ["after", "--file", "x", "--task-id", "t"],
    ["before", "--file", "x", "--unknown", "anything"],
    ["before", "--file", "x", "--file", "y"],
    ["verify"], ["close", "--file", "x"],
  ]) assert.throws(() => parseArgs(params));
});

test("before capture reads exact sandbox identity and omits sensitive task fields", async () => {
  const f = fixtures();
  const created = await snapshotBefore(f);
  assert.deepEqual(f.calls, ["getTask", "getEvent", "findByTodoistTaskId", "createManifest"]);
  assert.equal(created.source.beforeCompletion.id, "sandbox-task");
  assert.equal(created.anchorEvidenceNote.includes("fixture creation log"), true);
  assert.equal(created.source.afterCompletion, undefined);
  assert.ok(!JSON.stringify(created).includes("Sensitive fixture notes"));
  assert.ok(!JSON.stringify(created).includes("Do not persist me"));
  assert.ok(!JSON.stringify(created).includes("sandbox-token"));
  assert.equal(snapshotTask(task()).description, undefined);
});

test("before rejects wrong-project and non-recurring source observations", async () => {
  for (const bad of [
    task(dates[0], { project_id: "home-project" }),
    task(dates[0], { due: { date: dates[0], is_recurring: false, string: expression } }),
    task(dates[0], { is_completed: true }),
  ]) {
    const f = fixtures();
    f.current.value = bad;
    await assert.rejects(runCapture("before", args("before"), f.env, f.dependencies));
    assert.equal(f.getManifest(), undefined);
  }
  assert.equal(matchingSandboxSnapshot(task(), "sandbox-task", "sandbox-project"), true);
});

test("after requires an observed due-date advance and does not overwrite evidence", async () => {
  const f = fixtures();
  await snapshotBefore(f);
  await assert.rejects(runCapture("after", args("after"), f.env, f.dependencies),
    /did not advance/);
  assert.equal(f.getManifest().source.afterCompletion, undefined);
  const result = await snapshotAfter(f);
  assert.equal(result.status, "captured");
  const manifest = f.getManifest();
  assert.equal(manifest.source.afterCompletion.due.date, dates[1]);
  assert.deepEqual(f.calls.slice(-3), ["readManifest", "getTask", "saveManifest"]);
  validateCaptureManifest(manifest, validateSandboxEnvironment(f.env), true);
  await assert.rejects(runCapture("after", args("after"), f.env, f.dependencies),
    /already exists/);
});

test("read-only verification uses independent provider queries, no writes or rollout approval", async () => {
  const f = fixtures();
  await snapshotBefore(f);
  await snapshotAfter(f);
  const decision = await runCapture("verify", args("verify"), f.env, f.dependencies);
  assert.equal(decision.status, "read_only_assessment");
  assert.equal(decision.disposition, "native_exact");
  assert.equal(decision.reason, "verified_equivalent");
  assert.equal(decision.productionWriteAuthorized, false);
  assert.equal(decision.observations.instanceCount, 4);
  assert.deepEqual(f.calls.slice(-6), [
    "readManifest", "getTask", "getEvent",
    "findByTodoistTaskId", "listExplicitSeriesExceptions", "listInstancesInWindow",
  ]);
});

test("Calendar exception readback fails closed and keeps the decision read-only", async () => {
  const f = fixtures(task(dates[1]), {
    exceptions: [{ id: "cancelled", status: "cancelled", recurringEventId: "sandbox-master" }],
  });
  await snapshotBefore(f);
  await snapshotAfter(f);
  const decision = await runCapture("verify", args("verify"), f.env, f.dependencies);
  assert.equal(decision.disposition, "rolling_required");
  assert.equal(decision.reason, "calendar_explicit_exceptions_present");
  assert.equal(decision.productionWriteAuthorized, false);
});

test("replaying a completed fixture against a different calendar/project is rejected", async () => {
  const f = fixtures();
  await snapshotBefore(f);
  await snapshotAfter(f);
  const env = environment({
    PHASE_B_SANDBOX_CALENDAR_ID: "different-sandbox-calendar",
  });
  await assert.rejects(runCapture("verify", args("verify"), env, f.dependencies),
    /does not belong/);
});
