import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { googleCredentials, profiles, todoistToken } from "../dist/config.js";
import { buildProjectMappingIndex } from "../dist/mapping-comments.js";
import { GoogleCalendar, Todoist } from "../dist/providers.js";
import {
  uniqueProjectEventMapping,
  uniqueProjectTaskMapping,
  uniqueProjectTaskMappingForEvent,
  unsupportedCalendarRecurrencePreserved,
} from "./production-e2e-assertions.mjs";
import { providerNotFound, providerStatus, safeDeleteCalendar, safeDeleteTodoist } from "./production-provider-cleanup.mjs";

const PROFILE_NAMES = ["antonio"];
const DEFAULT_TIMEOUT_SECONDS = 180;
const POLL_INTERVAL_MS = 3000;
let lastAcceptanceStage = "provider_scope_verification";

class AcceptanceTimeoutError extends Error {
  constructor(stage) {
    super(`Timed out waiting for ${stage}`);
    this.name = "AcceptanceTimeoutError";
    this.stage = stage;
  }
}

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
  if (!PROFILE_NAMES.includes(profile)) throw new Error(`Production acceptance is only permitted for profile antonio; received ${profile}`);
  const timeoutSeconds = Number(values.get("timeout-seconds") || process.env.E2E_TIMEOUT_SECONDS || DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 900) {
    throw new Error("timeout-seconds must be between 30 and 900");
  }
  const cleanupRaw = values.get("cleanup") || process.env.E2E_CLEANUP || "true";
  const cleanup = !["false", "0", "no"].includes(String(cleanupRaw).toLowerCase());
  if (!cleanup) throw new Error("Production acceptance must clean up every disposable fixture");
  return { profiles: [profile], timeoutMs: timeoutSeconds * 1000, cleanup };
}

function log(event, detail = {}) {
  if (!event.endsWith("_failed") && event !== "run_started" && event !== "run_passed") {
    lastAcceptanceStage = event.replace(/\b(?:home|antonio|work)\b/gi, "profile");
  }
  console.log(JSON.stringify({ service: "todoist-calendar-sync-production-e2e", event, ...detail }));
}

function safeFailure(error) {
  if (error instanceof AcceptanceTimeoutError) {
    const stage = error.stage.replace(/\b(?:home|antonio|work)\b/gi, "profile");
    return `timeout:${stage}`;
  }
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "provider_request_timeout";
  const status = providerStatus(error);
  return status ? `provider_http_status_${status}` : "acceptance_operation_failed";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(description, timeoutMs, operation, predicate) {
  lastAcceptanceStage = description.replace(/\b(?:home|antonio|work)\b/gi, "profile");
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await operation();
      if (await predicate(lastValue)) return lastValue;
    } catch {}
    await sleep(POLL_INTERVAL_MS);
  }
  throw new AcceptanceTimeoutError(description);
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

async function providerMapping(todoist, projectId, eventId, taskId) {
  const comments = await todoist.listProjectComments(projectId, true);
  const index = buildProjectMappingIndex(comments);
  return uniqueProjectTaskMappingForEvent(index, projectId, eventId, taskId)?.payload;
}

async function providerMappingComment(todoist, projectId, eventId, taskId) {
  const comments = await todoist.listProjectComments(projectId, true);
  const index = buildProjectMappingIndex(comments);
  return uniqueProjectTaskMappingForEvent(index, projectId, eventId, taskId)?.comment;
}

async function providerMappingByTask(todoist, projectId, taskId) {
  const comments = await todoist.listProjectComments(projectId, true);
  const index = buildProjectMappingIndex(comments);
  return uniqueProjectTaskMapping(index, projectId, taskId)?.payload;
}

async function fixtureStillPresent(calendar, todoist, projectId, eventId, taskId) {
  let event;
  let task;
  if (eventId) {
    try { event = await calendar.getEvent(eventId); }
    catch (error) { if (!providerNotFound(error)) throw error; }
  }
  if (taskId) {
    try { task = await todoist.getTask(taskId); }
    catch (error) { if (!providerNotFound(error)) throw error; }
  }
  const mapping = eventId && taskId ? await providerMapping(todoist, projectId, eventId, taskId) : undefined;
  return Boolean((event && event.status !== "cancelled") || (task && !task.is_deleted) || mapping);
}

async function runProfile(profile, { timeoutMs, cleanup, runTag }) {
  lastAcceptanceStage = "provider_scope_verification";
  const config = profiles[profile];
  const calendar = new GoogleCalendar(await googleCredentials(profile), config.calendarId);
  const todoist = new Todoist(await todoistToken(profile));
  const [project, calendarAccess, calendarTimeZone] = await Promise.all([
    todoist.getProject(config.todoistProjectId),
    calendar.listCalendarListForErasureAudit(),
    calendar.getTimeZone(),
  ]);
  if (project.name.trim().toLowerCase() !== "antonio1000homens") {
    throw new Error("Configured antonio project ID does not resolve to antonio1000homens");
  }
  const configuredCalendars = calendarAccess.filter((entry) => entry.configured && entry.id === config.calendarId);
  if (configuredCalendars.length !== 1 || !["owner", "writer", "writerWithoutPrivateAccess"].includes(configuredCalendars[0].accessRole)) {
    throw new Error("Configured antonio Calendar is not listed with write access");
  }
  log("acceptance_scope_verified", { profile, projectName: "antonio1000homens", calendarWriteAccess: true, calendarTimeZone });
  const { start, end } = futureWindow();
  const token = `${runTag}-${profile}-${randomUUID().slice(0, 8)}`;
  const title = `[E2E ${token}] Calendar to Todoist`;
  const updatedTitle = `[E2E ${token}] Todoist to Calendar`;
  const updatedDue = new Date(start.getTime() + 60 * 60 * 1000).toISOString();
  const recurringStart = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const recurringEnd = new Date(recurringStart.getTime() + 30 * 60 * 1000);
  const recurringTitle = `[E2E ${token}] Calendar daily recurrence`;
  const reverseTitle = `[E2E ${token}] Todoist to Calendar creation`;
  const reverseDue = new Date(start.getTime() + 2 * 60 * 60 * 1000).toISOString();
  const todoistRecurringTitle = `[E2E ${token}] Todoist daily recurrence`;
  let eventId;
  let taskId;
  let reverseEventId;
  let reverseTaskId;
  let todoistRecurringEventId;
  let todoistRecurringTaskId;
  let recurringEventId;
  let recurringTaskId;
  const recurrenceMatrixFixtures = [];
  const seriesDeletionFixtures = [];

  log("profile_started", { profile, token, cleanup });
  try {
    lastAcceptanceStage = "calendar_event_create";
    const createdEvent = await calendar.upsertEvent({
      summary: title,
      description: "Disposable todoist-calendar-sync production E2E item. Safe to delete.",
      start: { dateTime: start.toISOString(), timeZone: calendarTimeZone },
      end: { dateTime: end.toISOString(), timeZone: calendarTimeZone },
    });
    eventId = createdEvent.id;
    if (!eventId) throw new Error("Google Calendar did not return an event ID");
    log("calendar_event_created", { profile });

    const mirroredTask = await poll(
      `${profile} Todoist projection creation`,
      timeoutMs,
      () => todoist.listTasks(config.todoistProjectId),
      (tasks) => tasks.filter((task) => task.content === title).length === 1,
    ).then((tasks) => tasks.find((task) => task.content === title));
    taskId = mirroredTask?.id;
    if (!taskId) throw new Error("Todoist projection did not expose a task ID");
    log("todoist_projection_created", { profile });

    await poll(
      `${profile} provider-native correlation creation`,
      timeoutMs,
      async () => {
        const [event, mapping] = await Promise.all([
          calendar.getEvent(eventId), providerMapping(todoist, config.todoistProjectId, eventId, taskId),
        ]);
        return { event, mapping };
      },
      ({ event, mapping }) => event.extendedProperties?.shared?.taskId === taskId
        && event.extendedProperties.shared.syncSchemaVersion === "2"
        && event.extendedProperties.shared.syncProfile === profile
        && event.extendedProperties.shared.syncCalendarId === config.calendarId
        && event.extendedProperties.shared.syncEventId === eventId
        && event.extendedProperties.shared.syncTaskId === taskId
        && mapping?.profile === profile && mapping.eventId === eventId
        && mapping.calendarId === config.calendarId && mapping.syncedTitle === title
        && typeof mapping.syncedDue === "string",
    );
    log("provider_correlation_verified", { profile });

    const updatedTask = await todoist.upsertTask({
      ...mirroredTask,
      content: updatedTitle,
      due: {
        ...(mirroredTask.due || {}),
        datetime: updatedDue,
        timezone: mirroredTask.due?.timezone || calendarTimeZone,
      },
    }, taskId);
    log("todoist_task_updated", { profile, updatedAt: updatedTask.updated_at });

    const updatedEvent = await poll(
      `${profile} Calendar projection update`,
      timeoutMs,
      () => calendar.getEvent(eventId),
      (candidate) => candidate.summary === updatedTitle && timestampsMatch(candidate.start?.dateTime, updatedDue),
    );
    log("calendar_projection_updated", { profile, start: updatedEvent.start?.dateTime });

    const stableMapping = await providerMapping(todoist, config.todoistProjectId, eventId, taskId);
    const stableEvent = await calendar.getEvent(eventId);
    if (stableMapping?.taskId !== taskId || stableEvent.extendedProperties?.shared?.taskId !== taskId) {
      throw new Error(`Provider-native correlation changed unexpectedly for ${profile}`);
    }

    if (cleanup) {
      await calendar.deleteEvent(eventId);
      log("calendar_event_deleted", { profile });

      await poll(
        `${profile} Todoist cleanup propagation`,
        timeoutMs,
        async () => {
          try {
            const task = await todoist.getTask(taskId);
            // Todoist can keep a deleted-item tombstone readable by ID. Treat
            // that terminal provider state as absence just like a 404.
            return Boolean(task.is_deleted);
          } catch (error) {
            if (providerNotFound(error)) return true;
            throw error;
          }
        },
        Boolean,
      );

      await poll(
        `${profile} provider correlation cleanup`,
        timeoutMs,
        async () => {
          try {
            const [event, mapping] = await Promise.all([
              calendar.getEvent(eventId), providerMapping(todoist, config.todoistProjectId, eventId, taskId),
            ]);
            return { event, mapping };
          } catch (error) {
            if (providerNotFound(error)) return { event: undefined, mapping: undefined };
            throw error;
          }
        },
        ({ event, mapping }) => (!event || event.status === "cancelled") && !mapping,
      );
      log("cleanup_verified", { profile });
    }

    const reverseTask = await todoist.upsertTask({
      content: reverseTitle,
      description: "Disposable todoist-calendar-sync production E2E item created in Todoist. Safe to delete.",
      project_id: config.todoistProjectId,
      due: { datetime: reverseDue, timezone: calendarTimeZone },
    });
    reverseTaskId = reverseTask.id;
    if (!reverseTaskId) throw new Error("Todoist did not return an ID for the Todoist-originated fixture");
    log("todoist_originated_fixture_created", { profile });

    const reverseEvent = await poll(
      `${profile} Calendar projection creation from Todoist`,
      timeoutMs,
      () => calendar.findByTodoistTaskId(reverseTaskId),
      (candidate) => candidate?.summary === reverseTitle,
    );
    reverseEventId = reverseEvent.id;
    if (!reverseEventId) throw new Error("Calendar projection did not expose its event ID");
    await poll(
      `${profile} Todoist-originated provider correlation`,
      timeoutMs,
      async () => {
        const [event, mapping] = await Promise.all([
          calendar.getEvent(reverseEventId), providerMapping(todoist, config.todoistProjectId, reverseEventId, reverseTaskId),
        ]);
        return { event, mapping };
      },
      ({ event, mapping }) => event.extendedProperties?.shared?.taskId === reverseTaskId
        && event.extendedProperties.shared.syncProfile === profile
        && event.extendedProperties.shared.syncCalendarId === config.calendarId
        && event.extendedProperties.shared.syncEventId === reverseEventId
        && event.extendedProperties.shared.syncTaskId === reverseTaskId
        && mapping?.taskId === reverseTaskId && mapping.eventId === reverseEventId
        && mapping.calendarId === config.calendarId,
    );
    log("todoist_originated_correlation_verified", { profile });

    if (cleanup) {
      await safeDeleteTodoist(todoist, reverseTaskId);
      await poll(
        `${profile} Todoist-originated Calendar cleanup`,
        timeoutMs,
        async () => {
          try { return await calendar.getEvent(reverseEventId); }
          catch (error) { if (providerNotFound(error)) return undefined; throw error; }
        },
        (event) => !event,
      );
      await poll(
        `${profile} Todoist-originated provider correlation cleanup`,
        timeoutMs,
        () => providerMapping(todoist, config.todoistProjectId, reverseEventId, reverseTaskId),
        (mapping) => !mapping,
      );
      log("todoist_originated_cleanup_verified", { profile });
    }

    const todoistRecurringTask = await todoist.upsertTask({
      content: todoistRecurringTitle,
      description: "Disposable todoist-calendar-sync production recurring acceptance item. Safe to delete.",
      project_id: config.todoistProjectId,
      due: { string: "every day", is_recurring: true },
    });
    todoistRecurringTaskId = todoistRecurringTask.id;
    if (!todoistRecurringTaskId || !todoistRecurringTask.due?.is_recurring) {
      throw new Error("Todoist did not create a native recurring task");
    }
    const todoistRecurringEvent = await poll(
      `${profile} Calendar recurrence creation from Todoist`,
      timeoutMs,
      () => calendar.findByTodoistTaskId(todoistRecurringTaskId),
      (candidate) => Boolean(candidate?.recurrence?.length),
    );
    todoistRecurringEventId = todoistRecurringEvent.id;
    if (!todoistRecurringEventId) throw new Error("Todoist-originated Calendar series did not expose its master ID");
    await poll(
      `${profile} Todoist-originated recurring provider correlation`,
      timeoutMs,
      async () => {
        const [master, mapping] = await Promise.all([
          calendar.getEvent(todoistRecurringEventId),
          providerMapping(todoist, config.todoistProjectId, todoistRecurringEventId, todoistRecurringTaskId),
        ]);
        return { master, mapping };
      },
      ({ master, mapping }) => master.extendedProperties?.shared?.taskId === todoistRecurringTaskId
        && master.extendedProperties.shared.syncProfile === profile
        && master.extendedProperties.shared.syncCalendarId === config.calendarId
        && master.recurrence?.length > 0
        && mapping?.taskId === todoistRecurringTaskId && mapping.eventId === todoistRecurringEventId
        && mapping.calendarId === config.calendarId
        && mapping.masterEventId === todoistRecurringEventId && mapping.seriesId === todoistRecurringTaskId,
    );
    log("todoist_originated_recurrence_verified", { profile });

    if (cleanup) {
      await safeDeleteTodoist(todoist, todoistRecurringTaskId);
      await poll(
        `${profile} Todoist-originated recurring Calendar cleanup`,
        timeoutMs,
        async () => {
          try { return await calendar.getEvent(todoistRecurringEventId); }
          catch (error) { if (providerNotFound(error)) return undefined; throw error; }
        },
        (master) => !master,
      );
      await poll(
        `${profile} Todoist-originated recurring correlation cleanup`,
        timeoutMs,
        () => providerMapping(todoist, config.todoistProjectId, todoistRecurringEventId, todoistRecurringTaskId),
        (mapping) => !mapping,
      );
      log("todoist_originated_recurrence_cleanup_verified", { profile });
    }

    const recurringEvent = await calendar.upsertEvent({
      summary: recurringTitle,
      description: "Disposable todoist-calendar-sync production recurrence acceptance item. Safe to delete.",
      start: { dateTime: recurringStart.toISOString(), timeZone: calendarTimeZone },
      end: { dateTime: recurringEnd.toISOString(), timeZone: calendarTimeZone },
      recurrence: ["RRULE:FREQ=DAILY"],
    });
    recurringEventId = recurringEvent.id;
    if (!recurringEventId) throw new Error("Google Calendar did not return a recurring master ID");
    log("calendar_recurrence_created", { profile });

    const recurringTask = await poll(
      `${profile} recurring Todoist projection creation`,
      timeoutMs,
      () => todoist.listTasks(config.todoistProjectId),
      (tasks) => tasks.filter((task) => task.content === recurringTitle && task.due?.is_recurring).length === 1,
    ).then((tasks) => tasks.find((task) => task.content === recurringTitle && task.due?.is_recurring));
    recurringTaskId = recurringTask?.id;
    let completedDue = recurringTask?.due?.datetime || recurringTask?.due?.date;
    if (!recurringTaskId || !completedDue) throw new Error("Recurring Todoist projection did not expose its ID and due");

    const initialRecurringMapping = await poll(
      `${profile} recurring provider-native correlation creation`,
      timeoutMs,
      async () => {
        const [event, mapping] = await Promise.all([
          calendar.getEvent(recurringEventId), providerMapping(todoist, config.todoistProjectId, recurringEventId, recurringTaskId),
        ]);
        return { event, mapping };
      },
      ({ event, mapping }) => event.extendedProperties?.shared?.taskId === recurringTaskId
        && event.extendedProperties.shared.syncProfile === profile
        && event.extendedProperties.shared.syncCalendarId === config.calendarId
        && event.extendedProperties.shared.syncEventId === recurringEventId
        && event.extendedProperties.shared.syncTaskId === recurringTaskId
        && !event.extendedProperties.shared.syncSource && !event.extendedProperties.shared.syncRecurrenceOwner
        && mapping?.profile === profile && mapping.eventId === recurringEventId
        && mapping.calendarId === config.calendarId && mapping.taskId === recurringTaskId
        && mapping.calendarProgressVersion === 1,
    );
    log("recurring_provider_correlation_verified", { profile });

    const exceptionTitle = `[E2E ${token}] Calendar moved occurrence`;
    const calendarSeriesTitle = `[E2E ${token}] Calendar series rename`;
    const todoistSeriesTitle = `[E2E ${token}] Todoist series rename`;
    const instanceInventory = await poll(
      `${profile} recurring instance inventory`, timeoutMs,
      () => calendar.listInstancesInWindow(recurringEventId,
        new Date(recurringStart.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        new Date(recurringStart.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString()),
      (items) => items.filter((item) => item.recurringEventId === recurringEventId
        && item.originalStartTime && item.status !== "cancelled").length >= 4,
    );
    const orderedInstances = instanceInventory
      .filter((item) => item.recurringEventId === recurringEventId && item.originalStartTime)
      .sort((left, right) => Date.parse(left.originalStartTime.dateTime || left.originalStartTime.date || "")
        - Date.parse(right.originalStartTime.dateTime || right.originalStartTime.date || ""));
    const currentInstance = orderedInstances.find((item) => item.id === initialRecurringMapping.mapping.activeInstanceId);
    if (!currentInstance || currentInstance.status === "cancelled") {
      throw new Error("Calendar recurrence did not expose its exactly mapped current instance");
    }
    const currentOccurrenceTitle = `[E2E ${token}] Current occurrence rename`;
    await calendar.upsertEvent({ ...currentInstance, summary: currentOccurrenceTitle }, currentInstance.id);
    await poll(
      `${profile} current Calendar occurrence metadata propagation`, timeoutMs,
      () => todoist.getTask(recurringTaskId),
      (candidate) => candidate.id === recurringTaskId && candidate.content === currentOccurrenceTitle
        && candidate.due?.is_recurring
        && (candidate.due?.datetime || candidate.due?.date) === completedDue,
    );
    const restoredCurrent = await calendar.getEvent(currentInstance.id);
    await calendar.upsertEvent({ ...restoredCurrent, summary: recurringTitle }, currentInstance.id);
    await poll(
      `${profile} current Calendar occurrence metadata restoration`, timeoutMs,
      () => todoist.getTask(recurringTaskId),
      (candidate) => candidate.id === recurringTaskId && candidate.content === recurringTitle
        && candidate.due?.is_recurring
        && (candidate.due?.datetime || candidate.due?.date) === completedDue,
    );
    const currentForMove = await calendar.getEvent(currentInstance.id);
    const currentOriginalStart = currentForMove.originalStartTime?.dateTime || currentForMove.originalStartTime?.date;
    const currentOriginalEffectiveStart = currentForMove.start?.dateTime || currentForMove.start?.date;
    const currentOriginalEnd = currentForMove.end?.dateTime || currentForMove.end?.date;
    const currentDurationMs = Date.parse(currentOriginalEnd || "") - Date.parse(currentOriginalEffectiveStart || "");
    if (!currentOriginalStart || !currentOriginalEffectiveStart?.includes("T")
      || !timestampsMatch(completedDue, currentOriginalEffectiveStart)
      || !Number.isFinite(currentDurationMs) || currentDurationMs <= 0) {
      throw new Error("Calendar current-occurrence move acceptance requires valid timed instance boundaries");
    }
    const currentMasterRule = (await calendar.getEvent(recurringEventId)).recurrence;
    const movedCalendarCurrentStart = new Date(Date.parse(currentOriginalEffectiveStart) + 30 * 60 * 1000);
    const movedCalendarCurrentEnd = new Date(movedCalendarCurrentStart.getTime() + currentDurationMs);
    await calendar.upsertEvent({
      ...currentForMove,
      start: { dateTime: movedCalendarCurrentStart.toISOString(), timeZone: calendarTimeZone },
      end: { dateTime: movedCalendarCurrentEnd.toISOString(), timeZone: calendarTimeZone },
    }, currentForMove.id);
    const movedCalendarCurrent = await poll(
      `${profile} moving the current Calendar occurrence updates only Todoist due`, timeoutMs,
      async () => {
        const [task, instance, master, mapping] = await Promise.all([
          todoist.getTask(recurringTaskId),
          calendar.getEvent(currentForMove.id),
          calendar.getEvent(recurringEventId),
          providerMapping(todoist, config.todoistProjectId, recurringEventId, recurringTaskId),
        ]);
        return { task, instance, master, mapping };
      },
      ({ task, instance, master, mapping }) => task.id === recurringTaskId && task.due?.is_recurring
        && timestampsMatch(task.due?.datetime || task.due?.date, movedCalendarCurrentStart.toISOString())
        && timestampsMatch(instance.start?.dateTime, movedCalendarCurrentStart.toISOString())
        && (instance.originalStartTime?.dateTime || instance.originalStartTime?.date) === currentOriginalStart
        && JSON.stringify(master.recurrence) === JSON.stringify(currentMasterRule)
        && mapping?.activeInstanceId === currentForMove.id
        && mapping.originalStart === currentOriginalStart
        && timestampsMatch(mapping.activeEffectiveStart, movedCalendarCurrentStart.toISOString()),
    );
    await calendar.upsertEvent({
      ...movedCalendarCurrent.instance,
      start: { dateTime: currentOriginalEffectiveStart, timeZone: calendarTimeZone },
      end: { dateTime: currentOriginalEnd, timeZone: calendarTimeZone },
    }, currentForMove.id);
    const restoredCalendarCurrent = await poll(
      `${profile} restoring the current Calendar occurrence after move acceptance`, timeoutMs,
      async () => {
        const [task, instance, master, mapping] = await Promise.all([
          todoist.getTask(recurringTaskId),
          calendar.getEvent(currentForMove.id),
          calendar.getEvent(recurringEventId),
          providerMapping(todoist, config.todoistProjectId, recurringEventId, recurringTaskId),
        ]);
        return { task, instance, master, mapping };
      },
      ({ task, instance, master, mapping }) => task.id === recurringTaskId && task.due?.is_recurring
        && timestampsMatch(task.due?.datetime || task.due?.date, currentOriginalEffectiveStart)
        && timestampsMatch(instance.start?.dateTime, currentOriginalEffectiveStart)
        && (instance.originalStartTime?.dateTime || instance.originalStartTime?.date) === currentOriginalStart
        && JSON.stringify(master.recurrence) === JSON.stringify(currentMasterRule)
        && mapping?.activeInstanceId === currentForMove.id
        && mapping.originalStart === currentOriginalStart
        && timestampsMatch(mapping.activeEffectiveStart, currentOriginalEffectiveStart),
    );
    completedDue = restoredCalendarCurrent.task.due?.datetime || restoredCalendarCurrent.task.due?.date;
    if (!completedDue) throw new Error("Restored Calendar current occurrence lost the Todoist due date");
    log("calendar_current_occurrence_reschedule_verified", {
      profile, taskIdPreserved: true, originalStartPreserved: true, recurrenceRulePreserved: true,
    });
    log("current_occurrence_edit_verified", { profile, taskIdPreserved: true, recurrencePreserved: true });
    const [movedInstance, cancelledInstance, followingInstance] = orderedInstances
      .filter((item) => item.id !== currentInstance.id && item.status !== "cancelled");
    if (!movedInstance || !cancelledInstance || !followingInstance) {
      throw new Error("Calendar recurrence did not expose enough future instances for exception acceptance");
    }
    const originalMovedStart = movedInstance.start?.dateTime || movedInstance.start?.date;
    const originalMovedEnd = movedInstance.end?.dateTime || movedInstance.end?.date;
    const durationMs = Date.parse(originalMovedEnd || "") - Date.parse(originalMovedStart || "");
    if (!originalMovedStart || !Number.isFinite(durationMs) || durationMs <= 0 || !originalMovedStart.includes("T")) {
      throw new Error("Calendar daily acceptance requires valid timed instance boundaries");
    }
    const movedStart = new Date(Date.parse(originalMovedStart) + 26 * 60 * 60 * 1000);
    const movedEnd = new Date(movedStart.getTime() + durationMs);
    await calendar.upsertEvent({
      ...movedInstance,
      summary: exceptionTitle,
      description: "Disposable moved Calendar occurrence for production acceptance.",
      start: { dateTime: movedStart.toISOString(), timeZone: calendarTimeZone },
      end: { dateTime: movedEnd.toISOString(), timeZone: calendarTimeZone },
    }, movedInstance.id);
    await calendar.deleteEvent(cancelledInstance.id);
    await poll(
      `${profile} future Calendar exception readback`, timeoutMs,
      async () => {
        const [moved, currentTask] = await Promise.all([
          calendar.getEvent(movedInstance.id), todoist.getTask(recurringTaskId),
        ]);
        let cancelled;
        try { cancelled = await calendar.getEvent(cancelledInstance.id); }
        catch (error) { if (providerNotFound(error)) cancelled = { status: "cancelled" }; else throw error; }
        return { moved, cancelled, currentTask };
      },
      ({ moved, cancelled, currentTask }) => moved.summary === exceptionTitle
        && timestampsMatch(moved.start?.dateTime, movedStart.toISOString())
        && cancelled.status === "cancelled" && currentTask.id === recurringTaskId
        && (currentTask.due?.datetime || currentTask.due?.date) === completedDue
        && currentTask.due?.is_recurring,
    );
    log("future_calendar_exceptions_verified", { profile, moved: true, cancelled: true, currentTaskUnchanged: true });

    const recurringMaster = await calendar.getEvent(recurringEventId);
    await calendar.upsertEvent({ ...recurringMaster, summary: calendarSeriesTitle }, recurringEventId);
    const calendarSeriesEditTask = await poll(
      `${profile} Calendar series metadata propagation`, timeoutMs,
      () => todoist.getTask(recurringTaskId),
      (candidate) => candidate.content === calendarSeriesTitle && candidate.due?.is_recurring
        && (candidate.due?.datetime || candidate.due?.date) === completedDue,
    );
    await todoist.updateTaskMetadata(recurringTaskId, {
      content: todoistSeriesTitle,
      description: calendarSeriesEditTask.description || "",
    });
    const todoistSeriesEditMaster = await poll(
      `${profile} Todoist series metadata propagation`, timeoutMs,
      () => calendar.getEvent(recurringEventId),
      (candidate) => candidate.summary === todoistSeriesTitle && candidate.recurrence?.length > 0,
    );
    const preservedException = await calendar.getEvent(movedInstance.id);
    const seriesEditTask = await todoist.getTask(recurringTaskId);
    if (preservedException.summary !== exceptionTitle
      || !timestampsMatch(preservedException.start?.dateTime, movedStart.toISOString())
      || (seriesEditTask.due?.datetime || seriesEditTask.due?.date) !== completedDue
      || !seriesEditTask.due?.is_recurring
      || todoistSeriesEditMaster.extendedProperties?.shared?.taskId !== recurringTaskId) {
      throw new Error("Bidirectional series title edits changed recurrence identity or erased an explicit Calendar exception");
    }
    log("bidirectional_series_edits_verified", {
      profile, calendarToTodoist: true, todoistToCalendar: true, exceptionPreserved: true,
    });

    const currentTaskBeforeReschedule = await todoist.getTask(recurringTaskId);
    const recurrenceMappingBeforeReschedule = await providerMapping(
      todoist, config.todoistProjectId, recurringEventId, recurringTaskId,
    );
    if (!recurrenceMappingBeforeReschedule?.activeInstanceId || !currentTaskBeforeReschedule.due?.is_recurring
      || !currentTaskBeforeReschedule.due.string) {
      throw new Error("Todoist recurrence did not expose its exact active occurrence before reschedule acceptance");
    }
    const currentOccurrence = await calendar.getEvent(recurrenceMappingBeforeReschedule.activeInstanceId);
    const immutableOriginalStart = currentOccurrence.originalStartTime?.dateTime
      || currentOccurrence.originalStartTime?.date;
    const masterRuleBeforeReschedule = (await calendar.getEvent(recurringEventId)).recurrence;
    const currentDueBeforeReschedule = currentTaskBeforeReschedule.due.datetime || currentTaskBeforeReschedule.due.date;
    if (!immutableOriginalStart || !currentDueBeforeReschedule?.includes("T")) {
      throw new Error("Todoist current-occurrence reschedule acceptance requires a timed mapped instance");
    }
    const movedCurrentDue = new Date(Date.parse(currentDueBeforeReschedule) + 30 * 60 * 1000).toISOString();
    await todoist.updateRecurringOccurrence(currentTaskBeforeReschedule, {
      content: currentTaskBeforeReschedule.content,
      description: currentTaskBeforeReschedule.description || "",
      due: {
        datetime: movedCurrentDue,
        string: currentTaskBeforeReschedule.due.string,
        ...(currentTaskBeforeReschedule.due.timezone ? { timezone: currentTaskBeforeReschedule.due.timezone } : {}),
      },
    });
    await poll(
      `${profile} Todoist current occurrence reschedule patches only the mapped Calendar instance`, timeoutMs,
      async () => {
        const [task, instance, master, mapping] = await Promise.all([
          todoist.getTask(recurringTaskId),
          calendar.getEvent(recurrenceMappingBeforeReschedule.activeInstanceId),
          calendar.getEvent(recurringEventId),
          providerMapping(todoist, config.todoistProjectId, recurringEventId, recurringTaskId),
        ]);
        return { task, instance, master, mapping };
      },
      ({ task, instance, master, mapping }) => task.due?.is_recurring
        && timestampsMatch(task.due.datetime || task.due.date, movedCurrentDue)
        && timestampsMatch(instance.start?.dateTime, movedCurrentDue)
        && (instance.originalStartTime?.dateTime || instance.originalStartTime?.date) === immutableOriginalStart
        && JSON.stringify(master.recurrence) === JSON.stringify(masterRuleBeforeReschedule)
        && mapping?.activeInstanceId === recurrenceMappingBeforeReschedule.activeInstanceId
        && mapping.originalStart === immutableOriginalStart
        && timestampsMatch(mapping.activeEffectiveStart, movedCurrentDue),
    );
    const movedCurrentTask = await todoist.getTask(recurringTaskId);
    await todoist.updateRecurringOccurrence(movedCurrentTask, {
      content: movedCurrentTask.content,
      description: movedCurrentTask.description || "",
      due: {
        datetime: currentDueBeforeReschedule,
        string: movedCurrentTask.due.string,
        ...(movedCurrentTask.due.timezone ? { timezone: movedCurrentTask.due.timezone } : {}),
      },
    });
    await poll(
      `${profile} Todoist current occurrence due restoration`, timeoutMs,
      async () => {
        const [task, instance, master] = await Promise.all([
          todoist.getTask(recurringTaskId),
          calendar.getEvent(recurrenceMappingBeforeReschedule.activeInstanceId),
          calendar.getEvent(recurringEventId),
        ]);
        return { task, instance, master };
      },
      ({ task, instance, master }) => task.due?.is_recurring
        && timestampsMatch(task.due.datetime || task.due.date, currentDueBeforeReschedule)
        && timestampsMatch(instance.start?.dateTime, currentDueBeforeReschedule)
        && (instance.originalStartTime?.dateTime || instance.originalStartTime?.date) === immutableOriginalStart
        && JSON.stringify(master.recurrence) === JSON.stringify(masterRuleBeforeReschedule),
    );
    log("todoist_current_occurrence_reschedule_verified", {
      profile, instanceOnly: true, originalStartPreserved: true, recurrenceRulePreserved: true,
    });

    let nextDue = completedDue;
    const completionResults = [];
    for (let occurrence = 1; occurrence <= 2; occurrence += 1) {
      const completionResult = await todoist.completeTask(recurringTaskId, nextDue);
      if (!["completed", "already_completed"].includes(completionResult)) {
        throw new Error(`Recurring Todoist completion ${occurrence} was not accepted: ${completionResult}`);
      }
      const advancedTask = await poll(
        `${profile} recurring task ID preservation after completion ${occurrence}`,
        timeoutMs,
        () => todoist.getTask(recurringTaskId),
        (candidate) => candidate.id === recurringTaskId && candidate.due?.is_recurring
          && (candidate.due?.datetime || candidate.due?.date) !== nextDue,
      );
      const advancedDue = advancedTask.due?.datetime || advancedTask.due?.date;
      if (!advancedDue) throw new Error("Recurring Todoist task lost its next due date");
      if (occurrence === 1 && (!timestampsMatch(advancedDue, movedStart.toISOString())
        || advancedTask.content !== exceptionTitle || !advancedTask.due?.is_recurring)) {
        throw new Error("Completing the current item did not apply the moved future Calendar exception without flattening recurrence");
      }
      const expectedFollowingStart = followingInstance.start?.dateTime || followingInstance.start?.date;
      if (occurrence === 2 && (expectedFollowingStart?.includes("T")
        ? !timestampsMatch(advancedDue, expectedFollowingStart)
        : advancedDue !== expectedFollowingStart)) {
        throw new Error("Completion did not skip the cancelled occurrence and return to the Calendar recurrence cadence");
      }
      const advancedMapping = await poll(
        `${profile} recurrence progress persistence after completion ${occurrence}`,
        timeoutMs,
        () => providerMapping(todoist, config.todoistProjectId, recurringEventId, recurringTaskId),
        (mapping) => mapping?.taskId === recurringTaskId && mapping.calendarProgressVersion === 1
          && (mapping.completedThroughOriginalStart === nextDue
            || timestampsMatch(mapping.completedThroughOriginalStart, nextDue)),
      );
      if (advancedMapping.eventId !== recurringEventId || advancedTask.id !== recurringTaskId) {
        throw new Error("Calendar recurrence completion changed the provider-native identity");
      }
      completionResults.push(completionResult);
      nextDue = advancedDue;
    }
    log("recurrence_completions_verified", { profile, count: completionResults.length });

    const activeMapping = await providerMapping(todoist, config.todoistProjectId, recurringEventId, recurringTaskId);
    if (activeMapping?.taskId !== recurringTaskId || !activeMapping.activeInstanceId) {
      throw new Error("Calendar recurrence did not expose the exact active occurrence after completion");
    }
    const postCompletionInstances = await calendar.listInstancesInWindow(recurringEventId,
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString());
    const activeAfterCompletion = postCompletionInstances.find((item) => item.id === activeMapping.activeInstanceId);
    const activeOriginalStart = activeAfterCompletion?.originalStartTime?.dateTime
      || activeAfterCompletion?.originalStartTime?.date;
    const nextAfterDeletion = postCompletionInstances
      .filter((item) => item.recurringEventId === recurringEventId && item.status !== "cancelled"
        && item.id !== activeMapping.activeInstanceId && item.originalStartTime)
      .filter((item) => {
        const original = item.originalStartTime.dateTime || item.originalStartTime.date;
        return Boolean(activeOriginalStart && original && Date.parse(original) > Date.parse(activeOriginalStart));
      })
      .sort((left, right) => Date.parse(left.originalStartTime.dateTime || left.originalStartTime.date || "")
        - Date.parse(right.originalStartTime.dateTime || right.originalStartTime.date || ""))[0];
    if (!activeAfterCompletion || activeAfterCompletion.status === "cancelled" || !nextAfterDeletion) {
      throw new Error("Calendar recurrence did not expose the active and successor occurrences for deletion acceptance");
    }
    await calendar.deleteEvent(activeAfterCompletion.id);
    const successorStart = nextAfterDeletion.start?.dateTime || nextAfterDeletion.start?.date;
    const afterActiveDeletion = await poll(
      `${profile} current Calendar occurrence deletion advances the mapped task`, timeoutMs,
      async () => {
        const [task, mapping] = await Promise.all([
          todoist.getTask(recurringTaskId),
          providerMapping(todoist, config.todoistProjectId, recurringEventId, recurringTaskId),
        ]);
        return { task, mapping };
      },
      ({ task, mapping }) => task.id === recurringTaskId && task.due?.is_recurring
        && (task.due?.datetime || task.due?.date) !== nextDue
        && mapping?.activeInstanceId === nextAfterDeletion.id,
    );
    if (!successorStart || !(successorStart.includes("T")
      ? timestampsMatch(afterActiveDeletion.task.due?.datetime || afterActiveDeletion.task.due?.date || "", successorStart)
      : (afterActiveDeletion.task.due?.datetime || afterActiveDeletion.task.due?.date) === successorStart)) {
      throw new Error("Deleting the active Calendar occurrence did not advance Todoist to the verified successor");
    }

    await safeDeleteCalendar(calendar, recurringEventId);
    await poll(
      `${profile} deleting a Calendar recurring master deletes its exact Todoist task and mapping`, timeoutMs,
      () => fixtureStillPresent(calendar, todoist, config.todoistProjectId, recurringEventId, recurringTaskId),
      present => !present,
    );
    log("calendar_series_deletion_verified", { profile, taskId: recurringTaskId, masterId: recurringEventId });

    const todoistSeriesDeletionFixture = {
      cadence: "todoist_series_delete",
      title: `[E2E ${token}] Todoist series deletion`,
      eventId: undefined,
      taskId: undefined,
    };
    seriesDeletionFixtures.push(todoistSeriesDeletionFixture);
    const todoistSeriesDeletionTask = await todoist.upsertTask({
      content: todoistSeriesDeletionFixture.title,
      description: "Disposable recurring series deletion acceptance fixture. Safe to delete.",
      project_id: config.todoistProjectId,
      due: { string: "every week", is_recurring: true },
    });
    todoistSeriesDeletionFixture.taskId = todoistSeriesDeletionTask.id;
    const todoistSeriesDeletionMaster = await poll(
      `${profile} Todoist recurring series creation before deletion`, timeoutMs,
      () => calendar.findByTodoistTaskId(todoistSeriesDeletionTask.id),
      event => Boolean(event?.id && event.recurrence?.length),
    );
    todoistSeriesDeletionFixture.eventId = todoistSeriesDeletionMaster.id;
    await poll(
      `${profile} Todoist recurring series correlation before deletion`, timeoutMs,
      () => providerMapping(todoist, config.todoistProjectId, todoistSeriesDeletionMaster.id, todoistSeriesDeletionTask.id),
      mapping => mapping?.taskId === todoistSeriesDeletionTask.id
        && mapping.masterEventId === todoistSeriesDeletionMaster.id,
    );
    await safeDeleteTodoist(todoist, todoistSeriesDeletionTask.id);
    await poll(
      `${profile} deleting a Todoist recurring task deletes its exact Calendar master and mapping`, timeoutMs,
      () => fixtureStillPresent(calendar, todoist, config.todoistProjectId,
        todoistSeriesDeletionMaster.id, todoistSeriesDeletionTask.id),
      present => !present,
    );
    log("todoist_series_deletion_verified", {
      profile, taskId: todoistSeriesDeletionTask.id, masterId: todoistSeriesDeletionMaster.id,
    });
    log("current_occurrence_deletion_verified", { profile, taskIdPreserved: true, successorMapped: true });

    const recurrenceMatrix = [
      { cadence: "weekly", start: new Date(recurringStart.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10), rule: "RRULE:FREQ=WEEKLY" },
      { cadence: "monthly", start: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 15)).toISOString().slice(0, 10), rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=15" },
      { cadence: "yearly", start: new Date(Date.UTC(new Date().getUTCFullYear() + 1, new Date().getUTCMonth(), 15)).toISOString().slice(0, 10), rule: "RRULE:FREQ=YEARLY" },
      { cadence: "finite_weekly", start: new Date(recurringStart.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10), rule: "RRULE:FREQ=WEEKLY;COUNT=4" },
    ];
    for (const spec of recurrenceMatrix) {
      const fixture = {
        cadence: spec.cadence,
        title: `[E2E ${token}] Calendar ${spec.cadence} recurrence`,
        eventId: undefined,
        taskId: undefined,
      };
      recurrenceMatrixFixtures.push(fixture);
      const matrixStart = new Date(`${spec.start}T00:00:00.000Z`);
      const matrixEnd = new Date(matrixStart.getTime() + 24 * 60 * 60 * 1000);
      const master = await calendar.upsertEvent({
        summary: fixture.title,
        description: "Disposable recurrence matrix fixture for production acceptance. Safe to delete.",
        start: { date: spec.start },
        end: { date: matrixEnd.toISOString().slice(0, 10) },
        recurrence: [spec.rule],
      });
      fixture.eventId = master.id;
      if (!fixture.eventId) throw new Error(`Calendar ${spec.cadence} fixture has no master ID`);
      const projected = await poll(
        `${profile} Calendar ${spec.cadence} recurrence becomes one native Todoist task`, timeoutMs,
        () => todoist.listTasks(config.todoistProjectId),
        (tasks) => tasks.filter((candidate) => candidate.content === fixture.title && candidate.due?.is_recurring).length === 1,
      ).then((tasks) => tasks.find((candidate) => candidate.content === fixture.title && candidate.due?.is_recurring));
      fixture.taskId = projected?.id;
      if (!fixture.taskId) throw new Error(`Calendar ${spec.cadence} recurrence did not retain a native Todoist task`);
      await poll(
        `${profile} Calendar ${spec.cadence} recurrence correlation readback`, timeoutMs,
        async () => {
          const [readback, mapping] = await Promise.all([
            calendar.getEvent(fixture.eventId),
            providerMapping(todoist, config.todoistProjectId, fixture.eventId, fixture.taskId),
          ]);
          return { readback, mapping };
        },
        ({ readback, mapping }) => readback.recurrence?.length === 1
          && readback.extendedProperties?.shared?.taskId === fixture.taskId
          && mapping?.taskId === fixture.taskId && mapping.masterEventId === fixture.eventId
          && mapping.calendarProgressVersion === 1 && mapping.activeInstanceId,
      );
      if (spec.cadence === "finite_weekly") {
        const finiteWindowStart = new Date(matrixStart.getTime() - 24 * 60 * 60 * 1000).toISOString();
        const finiteWindowEnd = new Date(matrixStart.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
        const finiteOccurrences = (await calendar.listInstancesInWindow(
          fixture.eventId, finiteWindowStart, finiteWindowEnd,
        )).filter((item) => item.recurringEventId === fixture.eventId && item.status !== "cancelled"
          && item.originalStartTime);
        finiteOccurrences.sort((left, right) => Date.parse(left.originalStartTime.dateTime || left.originalStartTime.date || "")
          - Date.parse(right.originalStartTime.dateTime || right.originalStartTime.date || ""));
        if (finiteOccurrences.length !== 4) {
          throw new Error(`Finite weekly acceptance expected four Calendar occurrences; observed ${finiteOccurrences.length}`);
        }
        let finiteDue = projected.due?.datetime || projected.due?.date;
        const finiteMapping = await providerMapping(todoist, config.todoistProjectId, fixture.eventId, fixture.taskId);
        const activeIndex = finiteOccurrences.findIndex((item) => item.id === finiteMapping?.activeInstanceId);
        if (!finiteDue || activeIndex !== 0) {
          throw new Error("Finite weekly completion acceptance did not start from its exact first mapped occurrence");
        }
        for (let completedIndex = 0; completedIndex < finiteOccurrences.length; completedIndex += 1) {
          const completion = await todoist.completeTask(fixture.taskId, finiteDue);
          if (!["completed", "already_completed"].includes(completion)) {
            throw new Error(`Finite occurrence ${completedIndex + 1} was not completed: ${completion}`);
          }
          const nextOccurrence = finiteOccurrences[completedIndex + 1];
          if (nextOccurrence) {
            const expectedNextDue = nextOccurrence.start?.dateTime || nextOccurrence.start?.date;
            const advanced = await poll(
              `${profile} finite weekly completion advances the same Todoist task ${completedIndex + 1}`,
              timeoutMs,
              async () => {
                const [task, mapping] = await Promise.all([
                  todoist.getTask(fixture.taskId),
                  providerMapping(todoist, config.todoistProjectId, fixture.eventId, fixture.taskId),
                ]);
                return { task, mapping };
              },
              ({ task, mapping }) => task.id === fixture.taskId && task.due?.is_recurring
                && (task.due?.datetime || task.due?.date) === expectedNextDue
                && mapping?.activeInstanceId === nextOccurrence.id,
            );
            finiteDue = advanced.task.due?.datetime || advanced.task.due?.date;
          } else {
            const terminal = await poll(
              `${profile} last finite occurrence completes without creating another task or event`, timeoutMs,
              async () => {
                const [tasks, master, instances, linkedMaster] = await Promise.all([
                  todoist.listTasks(config.todoistProjectId),
                  calendar.getEvent(fixture.eventId),
                  calendar.listInstancesInWindow(fixture.eventId, finiteWindowStart, finiteWindowEnd),
                  calendar.findByTodoistTaskId(fixture.taskId),
                ]);
                return { tasks, master, instances, linkedMaster };
              },
              ({ tasks, master, instances, linkedMaster }) => {
                const activeTask = tasks.find((item) => item.id === fixture.taskId);
                const liveOccurrences = instances.filter((item) => item.recurringEventId === fixture.eventId
                  && item.status !== "cancelled" && item.originalStartTime);
                return (!activeTask || activeTask.is_completed || Boolean(activeTask.completed_at))
                  && master.id === fixture.eventId
                  && linkedMaster?.id === fixture.eventId
                  && master.recurrence?.includes(spec.rule)
                  && liveOccurrences.length === finiteOccurrences.length
                  && liveOccurrences.every((item, index) => item.id === finiteOccurrences[index].id);
              },
            );
            const stillActiveByTitle = terminal.tasks.filter((item) => item.content === fixture.title
              && !item.is_completed && !item.completed_at);
            if (stillActiveByTitle.length) {
              throw new Error("Completing the last finite occurrence left an active duplicate Todoist task");
            }
          }
        }
        log("finite_recurrence_terminal_completion_verified", {
          profile, taskIdPreservedUntilTerminal: true, noSuccessorCreated: true,
        });
      }
      if (spec.cadence === "weekly") {
        const mappingComment = await providerMappingComment(todoist, config.todoistProjectId, fixture.eventId, fixture.taskId);
        if (!mappingComment?.id) throw new Error("Calendar correlation recovery fixture has no exact project mapping comment");
        await todoist.deleteComment(mappingComment.id);
        const eventBeforeRecovery = await calendar.getEvent(fixture.eventId);
        const recoveryDescription = `${eventBeforeRecovery.description || ""}\nCalendar correlation recovery ${token}`;
        const retriedDescription = `${recoveryDescription}\nCalendar correlation retry ${token}`;
        const firstRecoveryWrite = await calendar.upsertEventIfUnchanged({
          ...eventBeforeRecovery, description: recoveryDescription,
        }, fixture.eventId, eventBeforeRecovery.etag);
        // Consecutive provider changes exercise duplicate/out-of-order worker
        // deliveries after a partial correlation write. The latest live state
        // must win while the exact task/master pair is repaired in place.
        await calendar.upsertEventIfUnchanged({
          ...firstRecoveryWrite, description: retriedDescription,
        }, fixture.eventId, firstRecoveryWrite.etag);
        await poll(
          `${profile} Calendar task ID repairs a missing Todoist project mapping`, timeoutMs,
          async () => {
            const [event, task, mapping] = await Promise.all([
              calendar.getEvent(fixture.eventId), todoist.getTask(fixture.taskId),
              providerMapping(todoist, config.todoistProjectId, fixture.eventId, fixture.taskId),
            ]);
            return { event, task, mapping };
          },
          ({ event, task, mapping }) => event.extendedProperties?.shared?.taskId === fixture.taskId
            && task.id === fixture.taskId && task.description === retriedDescription
            && mapping?.taskId === fixture.taskId && mapping.masterEventId === fixture.eventId,
        );
        log("calendar_provider_correlation_retry_verified", { profile, taskIdPreserved: true, masterIdPreserved: true, latestStateWon: true });

        const before = await todoist.getTask(fixture.taskId);
        const masterBeforeRuleEdit = await calendar.getEvent(fixture.eventId);
        const changed = await calendar.upsertEventIfUnchanged({
          ...masterBeforeRuleEdit, recurrence: ["RRULE:FREQ=YEARLY"],
        }, fixture.eventId, masterBeforeRuleEdit.etag);
        await poll(
          `${profile} Calendar series rule edit updates its exact Todoist task`, timeoutMs,
          async () => {
            const [event, task, mapping] = await Promise.all([
              calendar.getEvent(fixture.eventId),
              todoist.getTask(fixture.taskId),
              providerMapping(todoist, config.todoistProjectId, fixture.eventId, fixture.taskId),
            ]);
            return { event, task, mapping };
          },
          ({ event, task, mapping }) => event.recurrence?.includes("RRULE:FREQ=YEARLY")
            && task.due?.is_recurring && task.due?.string !== before.due?.string
            && task.id === fixture.taskId && mapping?.taskId === fixture.taskId
            && mapping.masterEventId === fixture.eventId,
        );
        if (changed.id !== fixture.eventId) throw new Error("Calendar series edit changed the master ID");
        log("calendar_series_rule_edit_verified", { profile, taskIdPreserved: true, masterIdPreserved: true });

        const seriesTitle = `${fixture.title} renamed in Calendar`;
        const seriesDescription = `Calendar series description edit ${token}`;
        const beforeCalendarMetadata = await calendar.getEvent(fixture.eventId);
        const updatedCalendarMetadata = await calendar.upsertEventIfUnchanged({
          ...beforeCalendarMetadata, summary: seriesTitle, description: seriesDescription,
        }, fixture.eventId, beforeCalendarMetadata.etag);
        await poll(
          `${profile} Calendar series metadata updates its exact Todoist task`, timeoutMs,
          async () => {
            const [event, task, mapping] = await Promise.all([
              calendar.getEvent(fixture.eventId), todoist.getTask(fixture.taskId),
              providerMapping(todoist, config.todoistProjectId, fixture.eventId, fixture.taskId),
            ]);
            return { event, task, mapping };
          },
          ({ event, task, mapping }) => event.summary === seriesTitle
            && event.description === seriesDescription && task.id === fixture.taskId
            && task.content === seriesTitle && task.description === seriesDescription
            && task.due?.is_recurring && mapping?.taskId === fixture.taskId
            && mapping.masterEventId === fixture.eventId,
        );
        if (updatedCalendarMetadata.id !== fixture.eventId) throw new Error("Calendar series metadata edit changed the master ID");
        log("calendar_series_metadata_edit_verified", { profile, taskIdPreserved: true, masterIdPreserved: true });
      }
      log("recurrence_matrix_case_verified", { profile, cadence: spec.cadence, nativeTaskPreserved: true });
    }
    for (const spec of recurrenceMatrix.filter((candidate) => candidate.cadence !== "finite_weekly")) {
      const fixture = {
        cadence: `todoist_${spec.cadence}`,
        title: `[E2E ${token}] Todoist ${spec.cadence} recurrence`,
        eventId: undefined,
        taskId: undefined,
      };
      recurrenceMatrixFixtures.push(fixture);
      const phrase = spec.cadence === "weekly" ? "every week"
        : spec.cadence === "monthly" ? "every month" : "every year";
      const task = await todoist.upsertTask({
        content: fixture.title,
        description: "Disposable recurrence matrix fixture for production acceptance. Safe to delete.",
        project_id: config.todoistProjectId,
        due: { string: phrase, is_recurring: true },
      });
      fixture.taskId = task.id;
      if (!fixture.taskId || !task.due?.is_recurring) throw new Error(`Todoist ${spec.cadence} fixture is not a native recurring task`);
      const master = await poll(
        `${profile} Todoist ${spec.cadence} recurrence becomes one Calendar master`, timeoutMs,
        () => calendar.findByTodoistTaskId(fixture.taskId),
        (candidate) => Boolean(candidate?.recurrence?.length),
      );
      fixture.eventId = master.id;
      if (!fixture.eventId) throw new Error(`Todoist ${spec.cadence} recurrence did not expose a Calendar master ID`);
      await poll(
        `${profile} Todoist ${spec.cadence} recurrence correlation readback`, timeoutMs,
        async () => {
          const [readback, mapping] = await Promise.all([
            calendar.getEvent(fixture.eventId),
            providerMapping(todoist, config.todoistProjectId, fixture.eventId, fixture.taskId),
          ]);
          return { readback, mapping };
        },
        ({ readback, mapping }) => readback.recurrence?.length === 1
          && readback.extendedProperties?.shared?.taskId === fixture.taskId
          && mapping?.taskId === fixture.taskId && mapping.masterEventId === fixture.eventId
          && mapping.seriesId === fixture.taskId,
      );
      if (spec.cadence === "weekly") {
        const eventBeforeRecovery = await calendar.getEvent(fixture.eventId);
        const shared = eventBeforeRecovery.extendedProperties?.shared || {};
        const lostKeys = Object.keys(shared).filter((key) => key === "taskId" || key.startsWith("sync"));
        if (!lostKeys.includes("taskId") || !lostKeys.includes("syncTaskId"))
          throw new Error("Todoist correlation recovery fixture does not contain the expected Calendar task identifiers");
        const clearCorrelation = Object.fromEntries(lostKeys.map((key) => [key, null]));
        await calendar.updateSharedEventPropertiesIfUnchanged(fixture.eventId, eventBeforeRecovery.etag, clearCorrelation);
        const taskBeforeRecovery = await todoist.getTask(fixture.taskId);
        const recoveryDescription = `${taskBeforeRecovery.description || ""}\nTodoist correlation recovery ${token}`;
        const retriedDescription = `${recoveryDescription}\nTodoist correlation retry ${token}`;
        await todoist.upsertTask({ ...taskBeforeRecovery, description: recoveryDescription }, fixture.taskId);
        await todoist.upsertTask({ ...taskBeforeRecovery, description: retriedDescription }, fixture.taskId);
        await poll(
          `${profile} Todoist project mapping repairs missing Calendar correlation`, timeoutMs,
          async () => {
            const [event, currentTask, mapping] = await Promise.all([
              calendar.getEvent(fixture.eventId), todoist.getTask(fixture.taskId),
              providerMapping(todoist, config.todoistProjectId, fixture.eventId, fixture.taskId),
            ]);
            return { event, currentTask, mapping };
          },
          ({ event, currentTask, mapping }) => event.extendedProperties?.shared?.taskId === fixture.taskId
            && event.extendedProperties?.shared?.syncTaskId === fixture.taskId
            && currentTask.id === fixture.taskId && currentTask.description === retriedDescription
            && mapping?.taskId === fixture.taskId && mapping.masterEventId === fixture.eventId,
        );
        log("todoist_provider_correlation_retry_verified", { profile, taskIdPreserved: true, masterIdPreserved: true, latestStateWon: true });

        const beforeCalendarRuleEdit = await todoist.getTask(fixture.taskId);
        const masterBeforeCalendarRuleEdit = await calendar.getEvent(fixture.eventId);
        const changedCalendarRule = await calendar.upsertEventIfUnchanged({
          ...masterBeforeCalendarRuleEdit, recurrence: ["RRULE:FREQ=YEARLY"],
        }, fixture.eventId, masterBeforeCalendarRuleEdit.etag);
        await poll(
          `${profile} Calendar edit updates a Todoist-created series`, timeoutMs,
          async () => {
            const [readback, currentTask, mapping] = await Promise.all([
              calendar.getEvent(fixture.eventId), todoist.getTask(fixture.taskId),
              providerMapping(todoist, config.todoistProjectId, fixture.eventId, fixture.taskId),
            ]);
            return { readback, currentTask, mapping };
          },
          ({ readback, currentTask, mapping }) => readback.recurrence?.includes("RRULE:FREQ=YEARLY")
            && currentTask.id === fixture.taskId && currentTask.due?.is_recurring
            && currentTask.due?.string !== beforeCalendarRuleEdit.due?.string
            && mapping?.taskId === fixture.taskId && mapping.masterEventId === fixture.eventId,
        );
        if (changedCalendarRule.id !== fixture.eventId) throw new Error("Calendar edit changed the Todoist-created master ID");
        log("calendar_rule_edit_on_todoist_created_series_verified", { profile, taskIdPreserved: true, masterIdPreserved: true });

        const beforeTaskRuleChange = await todoist.getTask(fixture.taskId);
        const before = beforeTaskRuleChange.due?.string;
        const changed = await todoist.upsertTask({
          ...beforeTaskRuleChange,
          due: { ...beforeTaskRuleChange.due, string: "every month", is_recurring: true },
        }, fixture.taskId);
        await poll(
          `${profile} Todoist series rule edit updates its exact Calendar master`, timeoutMs,
          async () => {
            const [readback, currentTask, mapping] = await Promise.all([
              calendar.getEvent(fixture.eventId),
              todoist.getTask(fixture.taskId),
              providerMapping(todoist, config.todoistProjectId, fixture.eventId, fixture.taskId),
            ]);
            return { readback, currentTask, mapping };
          },
          ({ readback, currentTask, mapping }) => readback.recurrence?.includes("RRULE:FREQ=MONTHLY")
            && currentTask.id === fixture.taskId && currentTask.due?.is_recurring
            && currentTask.due?.string !== before && mapping?.taskId === fixture.taskId
            && mapping.masterEventId === fixture.eventId && mapping.seriesId === fixture.taskId,
        );
        if (changed.id !== fixture.taskId) throw new Error("Todoist series edit changed the task ID");
        log("todoist_series_rule_edit_verified", { profile, taskIdPreserved: true, masterIdPreserved: true });

        const seriesTitle = `${fixture.title} renamed in Todoist`;
        const seriesDescription = `Todoist series description edit ${token}`;
        const beforeTaskMetadata = await todoist.getTask(fixture.taskId);
        const updatedTaskMetadata = await todoist.upsertTask({
          ...beforeTaskMetadata, content: seriesTitle, description: seriesDescription,
        }, fixture.taskId);
        await poll(
          `${profile} Todoist series metadata updates its exact Calendar master`, timeoutMs,
          async () => {
            const [event, task, mapping] = await Promise.all([
              calendar.getEvent(fixture.eventId), todoist.getTask(fixture.taskId),
              providerMapping(todoist, config.todoistProjectId, fixture.eventId, fixture.taskId),
            ]);
            return { event, task, mapping };
          },
          ({ event, task, mapping }) => event.summary === seriesTitle
            && event.description === seriesDescription && task.id === fixture.taskId
            && task.content === seriesTitle && task.description === seriesDescription
            && task.due?.is_recurring && event.recurrence?.includes("RRULE:FREQ=MONTHLY")
            && mapping?.taskId === fixture.taskId && mapping.masterEventId === fixture.eventId,
        );
        if (updatedTaskMetadata.id !== fixture.taskId) throw new Error("Todoist series metadata edit changed the task ID");
        log("todoist_series_metadata_edit_verified", { profile, taskIdPreserved: true, masterIdPreserved: true });
      }
      log("recurrence_matrix_case_verified", { profile, cadence: fixture.cadence, nativeMasterPreserved: true });
    }

    const unsupportedFixture = {
      cadence: "todoist_finite_unsupported",
      title: `[E2E ${token}] Todoist finite unsupported recurrence`,
      eventId: undefined,
      taskId: undefined,
    };
    recurrenceMatrixFixtures.push(unsupportedFixture);
    const unsupportedUntilDate = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);
    const unsupportedUntil = new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    }).format(unsupportedUntilDate);
    const unsupportedTask = await todoist.upsertTask({
      content: unsupportedFixture.title,
      description: "Disposable unsupported recurrence fixture for production acceptance. Safe to delete.",
      project_id: config.todoistProjectId,
      due: { string: `every 2 weeks until ${unsupportedUntil}`, is_recurring: true },
    });
    unsupportedFixture.taskId = unsupportedTask.id;
    if (!unsupportedTask.due?.is_recurring) throw new Error("Finite Todoist recurrence fixture was not natively recurring");
    const unsupportedNativeFixture = {
      cadence: "todoist_rrule_without_native_admission",
      title: `[E2E ${token}] Todoist RRULE without native admission`,
      eventId: undefined,
      taskId: undefined,
    };
    recurrenceMatrixFixtures.push(unsupportedNativeFixture);
    const unsupportedNativeTask = await todoist.upsertTask({
      content: unsupportedNativeFixture.title,
      description: "Disposable RRULE recurrence outside native admission for production acceptance. Safe to delete.",
      project_id: config.todoistProjectId,
      due: { string: "every 2 years", is_recurring: true },
    });
    unsupportedNativeFixture.taskId = unsupportedNativeTask.id;
    if (!unsupportedNativeTask.due?.is_recurring) throw new Error("RRULE recurrence fixture was not natively recurring");
    const unsupportedCalendarFixture = {
      cadence: "calendar_unsupported_rule",
      title: `[E2E ${token}] Calendar unsupported recurrence`,
      eventId: undefined,
      taskId: undefined,
    };
    recurrenceMatrixFixtures.push(unsupportedCalendarFixture);
    const unsupportedCalendarStart = new Date(recurringStart.getTime() + 14 * 24 * 60 * 60 * 1000);
    const unsupportedCalendarEnd = new Date(unsupportedCalendarStart.getTime() + 24 * 60 * 60 * 1000);
    const unsupportedCalendarMaster = await calendar.upsertEvent({
      summary: unsupportedCalendarFixture.title,
      description: "Disposable unsupported Calendar recurrence fixture for production acceptance. Safe to delete.",
      start: { date: unsupportedCalendarStart.toISOString().slice(0, 10) },
      end: { date: unsupportedCalendarEnd.toISOString().slice(0, 10) },
      recurrence: ["RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1"],
    });
    unsupportedCalendarFixture.eventId = unsupportedCalendarMaster.id;
    if (!unsupportedCalendarFixture.eventId) throw new Error("Unsupported Calendar recurrence fixture has no master ID");
    const unsupportedNativeDue = JSON.stringify({
      date: unsupportedNativeTask.due.date,
      datetime: unsupportedNativeTask.due.datetime,
      string: unsupportedNativeTask.due.string,
      timezone: unsupportedNativeTask.due.timezone,
      is_recurring: unsupportedNativeTask.due.is_recurring,
    });
    const unsupportedDue = JSON.stringify({
      date: unsupportedTask.due.date,
      datetime: unsupportedTask.due.datetime,
      string: unsupportedTask.due.string,
      timezone: unsupportedTask.due.timezone,
      is_recurring: unsupportedTask.due.is_recurring,
    });
    const unrelatedFixture = {
      cadence: "unrelated_one_off_during_unsupported_recurrence",
      title: `[E2E ${token}] One-off beside unsupported recurrence`,
      eventId: undefined,
      taskId: undefined,
    };
    recurrenceMatrixFixtures.push(unrelatedFixture);
    const unrelatedTask = await todoist.upsertTask({
      content: unrelatedFixture.title,
      description: "Disposable one-off proving unsupported recurrence does not pause unrelated synchronization. Safe to delete.",
      project_id: config.todoistProjectId,
      due: { date: recurringStart.toISOString().slice(0, 10) },
    });
    unrelatedFixture.taskId = unrelatedTask.id;
    const unrelatedEvent = await poll(
      `${profile} unrelated one-off sync completes beside unsupported recurrence`, timeoutMs,
      () => calendar.findByTodoistTaskId(unrelatedFixture.taskId),
      (candidate) => Boolean(candidate?.id && !candidate.recurrence?.length),
    );
    unrelatedFixture.eventId = unrelatedEvent.id;
    const unsupportedCheckDeadline = Date.now() + Math.min(timeoutMs, 30_000);
    while (Date.now() < unsupportedCheckDeadline) {
      const [event, mapping, currentTask, nativeEvent, nativeMapping, nativeCurrentTask,
        unsupportedCalendarReadback, unsupportedCalendarTasks, unsupportedCalendarComments] = await Promise.all([
        calendar.findByTodoistTaskId(unsupportedFixture.taskId),
        providerMappingByTask(todoist, config.todoistProjectId, unsupportedFixture.taskId),
        todoist.getTask(unsupportedFixture.taskId),
        calendar.findByTodoistTaskId(unsupportedNativeFixture.taskId),
        providerMappingByTask(todoist, config.todoistProjectId, unsupportedNativeFixture.taskId),
        todoist.getTask(unsupportedNativeFixture.taskId),
        calendar.getEvent(unsupportedCalendarFixture.eventId),
        todoist.listTasks(config.todoistProjectId),
        todoist.listProjectComments(config.todoistProjectId, true),
      ]);
      const unsupportedCalendarIndex = buildProjectMappingIndex(unsupportedCalendarComments);
      const unsupportedCalendarMapping = uniqueProjectEventMapping(
        unsupportedCalendarIndex, config.todoistProjectId, unsupportedCalendarFixture.eventId,
      );
      const currentDue = JSON.stringify({
        date: currentTask.due?.date,
        datetime: currentTask.due?.datetime,
        string: currentTask.due?.string,
        timezone: currentTask.due?.timezone,
        is_recurring: currentTask.due?.is_recurring,
      });
      const nativeCurrentDue = JSON.stringify({
        date: nativeCurrentTask.due?.date,
        datetime: nativeCurrentTask.due?.datetime,
        string: nativeCurrentTask.due?.string,
        timezone: nativeCurrentTask.due?.timezone,
        is_recurring: nativeCurrentTask.due?.is_recurring,
      });
      if (event || mapping || currentDue !== unsupportedDue
        || nativeEvent || nativeMapping || nativeCurrentDue !== unsupportedNativeDue
        || !unsupportedCalendarRecurrencePreserved({
          readback: unsupportedCalendarReadback,
          expectedEventId: unsupportedCalendarFixture.eventId,
          expectedRule: unsupportedCalendarMaster.recurrence,
          tasks: unsupportedCalendarTasks,
          fixtureTitle: unsupportedCalendarFixture.title,
          mapping: unsupportedCalendarMapping,
        }))
        throw new Error("Unsupported recurrence was projected or changed during unrelated sync");
      await sleep(POLL_INTERVAL_MS);
    }
    log("unsupported_recurrence_nonblocking_behavior_verified", {
      profile, sourcePreserved: true, oneOffProjectionCreated: false,
      calendarRulePreserved: true, unrelatedOneOffSynchronized: true,
    });

    if (cleanup) {
      await safeDeleteCalendar(calendar, recurringEventId);
      await safeDeleteTodoist(todoist, recurringTaskId);
      await poll(
        `${profile} recurring fixture cleanup`,
        timeoutMs,
        async () => {
          const [events, tasks, mapping] = await Promise.all([
            calendar.listInstancesInWindow(recurringEventId,
              new Date(recurringStart.getTime() - 24 * 60 * 60 * 1000).toISOString(),
              new Date(recurringStart.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString()).catch((error) => {
              if (providerNotFound(error)) return [];
              throw error;
            }),
            todoist.listTasks(config.todoistProjectId),
            providerMapping(todoist, config.todoistProjectId, recurringEventId, recurringTaskId),
          ]);
          return { events, tasks, mapping };
        },
        ({ events, tasks, mapping }) => !events.some((event) => event.status !== "cancelled")
          && !tasks.some((task) => task.id === recurringTaskId) && !mapping,
      );
      log("recurring_cleanup_verified", { profile });
      for (const fixture of recurrenceMatrixFixtures) {
        await safeDeleteCalendar(calendar, fixture.eventId);
        await safeDeleteTodoist(todoist, fixture.taskId);
        await poll(
          `${profile} ${fixture.cadence} recurrence fixture cleanup`, timeoutMs,
          () => fixtureStillPresent(calendar, todoist, config.todoistProjectId, fixture.eventId, fixture.taskId),
          (present) => !present,
        );
      }
      log("recurrence_matrix_cleanup_verified", { profile, fixtureCount: recurrenceMatrixFixtures.length });
      for (const fixture of seriesDeletionFixtures) {
        await safeDeleteCalendar(calendar, fixture.eventId);
        await safeDeleteTodoist(todoist, fixture.taskId);
        await poll(
          `${profile} ${fixture.cadence} fixture cleanup`, timeoutMs,
          () => fixtureStillPresent(calendar, todoist, config.todoistProjectId, fixture.eventId, fixture.taskId),
          present => !present,
        );
      }
    }

    return { profile, token, cleanup, status: "passed" };
  } catch (error) {
    log("profile_failed", { profile, stage: lastAcceptanceStage, error: safeFailure(error) });
    if (cleanup) {
      try { await safeDeleteCalendar(calendar, eventId); } catch (cleanupError) { log("fallback_calendar_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      try { await safeDeleteTodoist(todoist, taskId); } catch (cleanupError) { log("fallback_todoist_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      try { await safeDeleteTodoist(todoist, reverseTaskId); } catch (cleanupError) { log("fallback_reverse_todoist_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      try { await safeDeleteCalendar(calendar, reverseEventId); } catch (cleanupError) { log("fallback_reverse_calendar_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      try { await safeDeleteTodoist(todoist, todoistRecurringTaskId); } catch (cleanupError) { log("fallback_todoist_recurrence_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      try { await safeDeleteCalendar(calendar, todoistRecurringEventId); } catch (cleanupError) { log("fallback_calendar_recurrence_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      try { await safeDeleteCalendar(calendar, recurringEventId); } catch (cleanupError) { log("fallback_recurring_calendar_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      try { await safeDeleteTodoist(todoist, recurringTaskId); } catch (cleanupError) { log("fallback_recurring_todoist_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      for (const fixture of recurrenceMatrixFixtures) {
        try { await safeDeleteCalendar(calendar, fixture.eventId); } catch (cleanupError) { log("fallback_matrix_calendar_cleanup_failed", { profile, cadence: fixture.cadence, error: safeFailure(cleanupError) }); }
        try {
          if (!fixture.taskId) {
            fixture.taskId = (await todoist.listTasks(config.todoistProjectId))
              .find((task) => task.content === fixture.title)?.id;
          }
          await safeDeleteTodoist(todoist, fixture.taskId);
        } catch (cleanupError) { log("fallback_matrix_todoist_cleanup_failed", { profile, cadence: fixture.cadence, error: safeFailure(cleanupError) }); }
      }
      for (const fixture of seriesDeletionFixtures) {
        try { await safeDeleteCalendar(calendar, fixture.eventId); } catch (cleanupError) { log("fallback_series_calendar_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
        try { await safeDeleteTodoist(todoist, fixture.taskId); } catch (cleanupError) { log("fallback_series_todoist_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      }
      const fixtures = [
        [eventId, taskId],
        [reverseEventId, reverseTaskId],
        [todoistRecurringEventId, todoistRecurringTaskId],
        [recurringEventId, recurringTaskId],
        ...recurrenceMatrixFixtures.map((fixture) => [fixture.eventId, fixture.taskId]),
        ...seriesDeletionFixtures.map((fixture) => [fixture.eventId, fixture.taskId]),
      ].filter(([fixtureEventId, fixtureTaskId]) => fixtureEventId || fixtureTaskId);
      const verification = await Promise.allSettled(fixtures.map(([fixtureEventId, fixtureTaskId]) => poll(
        `${profile} failure cleanup verification`, Math.min(timeoutMs, 30_000),
        () => fixtureStillPresent(calendar, todoist, config.todoistProjectId, fixtureEventId, fixtureTaskId),
        (present) => !present,
      )));
      const cleanupVerified = verification.filter((result) => result.status === "fulfilled").length;
      log("failure_cleanup_verification_finished", {
        profile, fixtureCount: fixtures.length, verified: cleanupVerified,
        unresolved: fixtures.length - cleanupVerified,
      });
    }
    throw error;
  }
}

async function main() {
  if (!process.env.SYNC_DLQ_URL) throw new Error("SYNC_DLQ_URL is required");
  const options = parseArgs(process.argv.slice(2));
  const sqs = new SQSClient({});
  const runTag = process.env.E2E_RUN_TAG || process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
  const resultFile = process.env.E2E_RESULT_FILE || "e2e-result.json";
  const results = [];
  const initialDlqDepth = await queueDepth(sqs, process.env.SYNC_DLQ_URL);
  log("run_started", { profiles: options.profiles, cleanup: options.cleanup, initialDlqDepth });

  try {
    for (const profile of options.profiles) {
      results.push(await runProfile(profile, { ...options, runTag }));
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
    const summary = {
      status: "failed", initialDlqDepth, finalDlqDepth, results,
      stage: lastAcceptanceStage, error: safeFailure(error),
    };
    await writeFile(resultFile, `${JSON.stringify(summary, null, 2)}\n`);
    throw error;
  }
}

main().catch(() => {
  console.error(JSON.stringify({
    service: "todoist-calendar-sync-production-e2e", event: "run_failed",
  }));
  process.exitCode = 1;
});
