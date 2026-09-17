import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { googleCredentials, profiles, todoistToken } from "../dist/config.js";
import { GoogleCalendar, Todoist } from "../dist/providers.js";
import { StateRepository } from "../dist/repository.js";

const PROFILE_NAMES = ["home", "antonio", "work"];
const DEFAULT_TIMEOUT_SECONDS = 180;
const POLL_INTERVAL_MS = 3000;

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) values.set(key, inlineValue);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) values.set(key, argv[++index]);
    else values.set(key, "true");
  }
  const profile = values.get("profile") || process.env.E2E_PROFILE || "antonio";
  if (![...PROFILE_NAMES, "all"].includes(profile)) throw new Error(`Unsupported profile: ${profile}`);
  const timeoutSeconds = Number(values.get("timeout-seconds") || process.env.E2E_TIMEOUT_SECONDS || DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 900) {
    throw new Error("timeout-seconds must be between 30 and 900");
  }
  const cleanupRaw = values.get("cleanup") || process.env.E2E_CLEANUP || "true";
  const cleanup = !["false", "0", "no"].includes(String(cleanupRaw).toLowerCase());
  return { profiles: profile === "all" ? PROFILE_NAMES : [profile], timeoutMs: timeoutSeconds * 1000, cleanup };
}

function log(event, detail = {}) {
  console.log(JSON.stringify({ service: "todoist-calendar-sync-production-e2e", event, ...detail }));
}

function providerStatus(error) {
  return Number(error?.status || error?.$metadata?.httpStatusCode || 0);
}

function providerNotFound(error) {
  return [404, 410].includes(providerStatus(error));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(description, timeoutMs, operation, predicate) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastValue = await operation();
      lastError = undefined;
      if (await predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const suffix = lastError ? `; last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

function futureWindow() {
  const start = new Date(Date.now() + 36 * 60 * 60 * 1000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return { start, end };
}

function timestampsMatch(left, right) {
  const a = Date.parse(left || "");
  const b = Date.parse(right || "");
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

async function queueDepth(client, url) {
  const response = await client.send(new GetQueueAttributesCommand({
    QueueUrl: url,
    AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"],
  }));
  const attributes = response.Attributes || {};
  return ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"]
    .reduce((total, name) => total + Number(attributes[name] || 0), 0);
}

async function safeDeleteCalendar(calendar, eventId) {
  if (!eventId) return;
  try {
    await calendar.deleteEvent(eventId);
  } catch (error) {
    if (!providerNotFound(error)) throw error;
  }
}

async function safeDeleteTodoist(todoist, taskId) {
  if (!taskId) return;
  try {
    await todoist.deleteTask(taskId);
  } catch (error) {
    if (!providerNotFound(error)) throw error;
  }
}

async function runProfile(profile, { timeoutMs, cleanup, runTag, state }) {
  const config = profiles[profile];
  const calendar = new GoogleCalendar(await googleCredentials(profile), config.calendarId);
  const todoist = new Todoist(await todoistToken(profile));
  const { start, end } = futureWindow();
  const token = `${runTag}-${profile}-${randomUUID().slice(0, 8)}`;
  const title = `[E2E ${token}] Calendar to Todoist`;
  const updatedTitle = `[E2E ${token}] Todoist to Calendar`;
  const updatedDue = new Date(start.getTime() + 60 * 60 * 1000).toISOString();
  let eventId;
  let taskId;

  log("profile_started", { profile, token, cleanup });
  try {
    const createdEvent = await calendar.upsertEvent({
      summary: title,
      description: "Disposable todoist-calendar-sync production E2E item. Safe to delete.",
      start: { dateTime: start.toISOString(), timeZone: "Europe/London" },
      end: { dateTime: end.toISOString(), timeZone: "Europe/London" },
    });
    eventId = createdEvent.id;
    if (!eventId) throw new Error("Google Calendar did not return an event ID");
    log("calendar_event_created", { profile, eventId });

    const mirroredTask = await poll(
      `${profile} Todoist projection creation`,
      timeoutMs,
      () => todoist.listTasks(config.todoistProjectId),
      (tasks) => tasks.filter((task) => task.content === title).length === 1,
    ).then((tasks) => tasks.find((task) => task.content === title));
    taskId = mirroredTask?.id;
    if (!taskId) throw new Error("Todoist projection did not expose a task ID");
    log("todoist_projection_created", { profile, eventId, taskId });

    const mapping = await poll(
      `${profile} durable mapping creation`,
      timeoutMs,
      () => state.getMappingByEvent(profile, eventId),
      (candidate) => candidate?.taskId === taskId,
    );
    log("mapping_verified", { profile, eventId, taskId, mappingRevision: mapping.mappingRevision });

    const updatedTask = await todoist.upsertTask({
      ...mirroredTask,
      content: updatedTitle,
      due: {
        ...(mirroredTask.due || {}),
        datetime: updatedDue,
        timezone: mirroredTask.due?.timezone || "Europe/London",
      },
    }, taskId);
    log("todoist_task_updated", { profile, taskId, updatedAt: updatedTask.updated_at });

    const updatedEvent = await poll(
      `${profile} Calendar projection update`,
      timeoutMs,
      () => calendar.getEvent(eventId),
      (candidate) => candidate.summary === updatedTitle && timestampsMatch(candidate.start?.dateTime, updatedDue),
    );
    log("calendar_projection_updated", { profile, eventId, taskId, start: updatedEvent.start?.dateTime });

    const stableMapping = await state.getMappingByEvent(profile, eventId);
    if (stableMapping?.taskId !== taskId) {
      throw new Error(`Durable mapping changed unexpectedly for ${profile}: expected ${taskId}, got ${stableMapping?.taskId || "missing"}`);
    }

    if (cleanup) {
      await calendar.deleteEvent(eventId);
      log("calendar_event_deleted", { profile, eventId });

      await poll(
        `${profile} Todoist cleanup propagation`,
        timeoutMs,
        async () => {
          try {
            await todoist.getTask(taskId);
            return false;
          } catch (error) {
            if (providerNotFound(error)) return true;
            throw error;
          }
        },
        Boolean,
      );

      await poll(
        `${profile} mapping cleanup`,
        timeoutMs,
        () => state.getMappingByEvent(profile, eventId),
        (candidate) => candidate === undefined,
      );
      log("cleanup_verified", { profile, eventId, taskId });
    }

    return { profile, token, eventId, taskId, cleanup, status: "passed" };
  } catch (error) {
    log("profile_failed", { profile, eventId, taskId, error: error.message });
    if (cleanup) {
      try { await safeDeleteCalendar(calendar, eventId); } catch (cleanupError) { log("fallback_calendar_cleanup_failed", { profile, error: cleanupError.message }); }
      try { await safeDeleteTodoist(todoist, taskId); } catch (cleanupError) { log("fallback_todoist_cleanup_failed", { profile, error: cleanupError.message }); }
    }
    throw error;
  }
}

async function main() {
  if (!process.env.STATE_TABLE_NAME) throw new Error("STATE_TABLE_NAME is required");
  if (!process.env.SYNC_DLQ_URL) throw new Error("SYNC_DLQ_URL is required");
  const options = parseArgs(process.argv.slice(2));
  const state = new StateRepository();
  const sqs = new SQSClient({});
  const runTag = process.env.E2E_RUN_TAG || process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
  const resultFile = process.env.E2E_RESULT_FILE || "e2e-result.json";
  const results = [];
  const initialDlqDepth = await queueDepth(sqs, process.env.SYNC_DLQ_URL);
  log("run_started", { profiles: options.profiles, cleanup: options.cleanup, initialDlqDepth });

  try {
    for (const profile of options.profiles) {
      results.push(await runProfile(profile, { ...options, runTag, state }));
    }
    await sleep(2000);
    const finalDlqDepth = await queueDepth(sqs, process.env.SYNC_DLQ_URL);
    if (finalDlqDepth > initialDlqDepth) {
      throw new Error(`DLQ depth increased during E2E run: ${initialDlqDepth} -> ${finalDlqDepth}`);
    }
    const summary = { status: "passed", initialDlqDepth, finalDlqDepth, results };
    await writeFile(resultFile, `${JSON.stringify(summary, null, 2)}\n`);
    log("run_passed", summary);
  } catch (error) {
    let finalDlqDepth;
    try { finalDlqDepth = await queueDepth(sqs, process.env.SYNC_DLQ_URL); } catch { finalDlqDepth = undefined; }
    const summary = { status: "failed", initialDlqDepth, finalDlqDepth, results, error: error.message };
    await writeFile(resultFile, `${JSON.stringify(summary, null, 2)}\n`);
    throw error;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ service: "todoist-calendar-sync-production-e2e", event: "run_failed", error: error.message }));
  process.exitCode = 1;
});
