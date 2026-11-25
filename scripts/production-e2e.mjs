import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { googleCredentials, profiles, todoistToken } from "../dist/config.js";
import { buildProjectMappingIndex } from "../dist/mapping-comments.js";
import { GoogleCalendar, Todoist } from "../dist/providers.js";

const PROFILE_NAMES = ["antonio"];
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
  console.log(JSON.stringify({ service: "todoist-calendar-sync-production-e2e", event, ...detail }));
}

function providerStatus(error) {
  return Number(error?.status || error?.$metadata?.httpStatusCode || 0);
}

function providerNotFound(error) {
  return [404, 410].includes(providerStatus(error));
}

function safeFailure(error) {
  const status = providerStatus(error);
  return status ? `provider_http_status_${status}` : "acceptance_operation_failed";
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

async function providerMapping(todoist, projectId, eventId, taskId) {
  const comments = await todoist.listProjectComments(projectId, true);
  const index = buildProjectMappingIndex(comments);
  return (index.byEventId.get(eventId) || []).find((entry) =>
    entry.payload.taskId === taskId && entry.payload.projectId === projectId)?.payload;
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
  return Boolean((event && event.status !== "cancelled") || task || mapping);
}

async function runProfile(profile, { timeoutMs, cleanup, runTag }) {
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

  log("profile_started", { profile, token, cleanup });
  try {
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
      due: { datetime: recurringStart.toISOString(), string: "every day", timezone: calendarTimeZone },
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
    const completedDue = recurringTask?.due?.datetime || recurringTask?.due?.date;
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
    }

    return { profile, token, cleanup, status: "passed" };
  } catch (error) {
    log("profile_failed", { profile, error: safeFailure(error) });
    if (cleanup) {
      try { await safeDeleteCalendar(calendar, eventId); } catch (cleanupError) { log("fallback_calendar_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      try { await safeDeleteTodoist(todoist, taskId); } catch (cleanupError) { log("fallback_todoist_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      try { await safeDeleteTodoist(todoist, reverseTaskId); } catch (cleanupError) { log("fallback_reverse_todoist_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      try { await safeDeleteCalendar(calendar, reverseEventId); } catch (cleanupError) { log("fallback_reverse_calendar_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      try { await safeDeleteTodoist(todoist, todoistRecurringTaskId); } catch (cleanupError) { log("fallback_todoist_recurrence_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      try { await safeDeleteCalendar(calendar, todoistRecurringEventId); } catch (cleanupError) { log("fallback_calendar_recurrence_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      try { await safeDeleteCalendar(calendar, recurringEventId); } catch (cleanupError) { log("fallback_recurring_calendar_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      try { await safeDeleteTodoist(todoist, recurringTaskId); } catch (cleanupError) { log("fallback_recurring_todoist_cleanup_failed", { profile, error: safeFailure(cleanupError) }); }
      const fixtures = [
        [eventId, taskId],
        [reverseEventId, reverseTaskId],
        [todoistRecurringEventId, todoistRecurringTaskId],
        [recurringEventId, recurringTaskId],
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
    const summary = { status: "failed", initialDlqDepth, finalDlqDepth, results, error: safeFailure(error) };
    await writeFile(resultFile, `${JSON.stringify(summary, null, 2)}\n`);
    throw error;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ service: "todoist-calendar-sync-production-e2e", event: "run_failed", error: safeFailure(error) }));
  process.exitCode = 1;
});
