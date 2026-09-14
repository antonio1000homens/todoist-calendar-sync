import { googleCredentials, profileForTodoistProject, profiles, todoistToken } from "./config.js";
import { GoogleCalendar, Todoist } from "./providers.js";
import { StateRepository, type CalendarProjectionTombstone, type CalendarProjectionTombstoneReason } from "./repository.js";
import { canRecreateCalendarProjection, hasCanonicalState, Synchronizer, toCalendarEvent, todoistCalendarLifecycle } from "./sync.js";
import {
  calendarRecurrenceMatchesTodoist,
  recurrenceEffectiveStart,
  recurrenceOriginalStart,
  selectTodoistCurrentInstance,
  todoistRecurrenceToRrule,
} from "./todoist-recurrence.js";
import type { CalendarEvent, Delivery, Mapping, Profile, RecurrenceLink, TodoistTask, TodoistWebhookPayload } from "./types.js";

export type TodoistProjectAction = "skip" | "create_projection" | "delete_projection" | "upsert_projection" | "move_projection";

export interface TodoistProjectTransition {
  action: TodoistProjectAction;
  fromProfile?: Profile;
  toProfile?: Profile;
}

export function todoistProjectTransition(
  oldProjectId: string | undefined,
  newProjectId: string | undefined,
  persistedProfile?: Profile,
): TodoistProjectTransition {
  const oldProfile = profileForTodoistProject(oldProjectId);
  const toProfile = profileForTodoistProject(newProjectId);
  const fromProfile = persistedProfile || oldProfile;
  if (!fromProfile && !toProfile) return { action: "skip" };
  if (!fromProfile && toProfile) return { action: "create_projection", toProfile };
  if (fromProfile && !toProfile) return { action: "delete_projection", fromProfile };
  if (fromProfile === toProfile) return { action: "upsert_projection", fromProfile, toProfile };
  return { action: "move_projection", fromProfile, toProfile };
}

function eventStart(event: CalendarEvent): string | undefined {
  return recurrenceOriginalStart(event);
}

function eventEffectiveStart(event: CalendarEvent): string | undefined {
  return recurrenceEffectiveStart(event);
}

function normalizedOccurrenceStart(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value.slice(0, 19);
}

function matchingRecurringInstance(instances: CalendarEvent[], task: TodoistTask, originalStart?: string): CalendarEvent | undefined {
  const desired = normalizedOccurrenceStart(originalStart || task.due?.datetime || task.due?.date);
  const active = instances.filter((instance) => instance.status !== "cancelled" && Boolean(eventStart(instance)));
  if (!desired) return active.sort((a, b) => (eventStart(a) || "").localeCompare(eventStart(b) || ""))[0];
  return active.find((instance) => normalizedOccurrenceStart(eventStart(instance)) === desired);
}

function taskComment(event: CalendarEvent): string {
  return `todoist-calendar-sync\ncalendarEventId=${event.id}\ncalendarUrl=${event.htmlLink || ""}`;
}

function recurrenceLink(mapping: Mapping, owner: RecurrenceLink["owner"] = "todoist"): RecurrenceLink {
  if (!mapping.seriesId) throw new Error("Recurring mapping is missing its logical series ID");
  return {
    profile: mapping.profile,
    owner,
    seriesId: mapping.seriesId,
    masterEventId: mapping.masterEventId,
    taskId: mapping.taskId,
    eventId: mapping.eventId,
    activeInstanceId: mapping.activeInstanceId,
    originalStart: mapping.originalStart,
    activeEffectiveStart: mapping.activeEffectiveStart,
    updatedAt: mapping.updatedAt,
  };
}

function calendarSeriesProjection(master: CalendarEvent, task: TodoistTask): CalendarEvent {
  return {
    id: "",
    summary: master.summary,
    description: master.description,
    start: master.start,
    end: master.end,
    recurrence: master.recurrence,
    extendedProperties: {
      ...(master.extendedProperties || {}),
      shared: {
        ...(master.extendedProperties?.shared || {}),
        taskId: task.id,
        taskUrl: task.url || `https://app.todoist.com/app/task/${task.id}`,
        originalSummary: task.content,
        syncSource: "todoist-calendar-sync",
      },
    },
  };
}

function todoistOwnedOccurrenceIsException(master: CalendarEvent, occurrence: CalendarEvent): boolean {
  return eventEffectiveStart(occurrence) !== eventStart(occurrence)
    || (occurrence.summary || "") !== (master.summary || "")
    || (occurrence.description || "") !== (master.description || "");
}

function todoistOccurrenceProjection(task: TodoistTask, existing: CalendarEvent): CalendarEvent {
  // The Todoist task remains recurring, but this write targets one Google
  // instance. Strip recurrence from the projection so Google never interprets
  // an active-occurrence edit as an RRULE/master rewrite.
  const nonRecurringTask: TodoistTask = {
    ...task,
    due: task.due ? { ...task.due, is_recurring: false } : task.due,
  };
  const projected = toCalendarEvent(nonRecurringTask, existing);
  return {
    ...projected,
    extendedProperties: existing.extendedProperties || projected.extendedProperties,
  };
}

function todoistTaskChangedAgainstOldItem(task: TodoistTask, oldTask: TodoistTask | undefined): boolean {
  if (!oldTask) return true;
  const due = task.due?.datetime || task.due?.date || "";
  const oldDue = oldTask.due?.datetime || oldTask.due?.date || "";
  return due !== oldDue
    || (task.content || "") !== (oldTask.content || "")
    || (task.description || "") !== (oldTask.description || "");
}

type ClientPair = { calendar: GoogleCalendar; todoist: Todoist };
type ClientFactory = (profile: Profile) => Promise<ClientPair>;
type ScheduleOrphan = (delivery: Delivery, eventId: string, taskId: string) => Promise<void>;
type TodoistLifecycle = NonNullable<ReturnType<typeof todoistCalendarLifecycle>>;

export class ProjectAwareSynchronizer {
  private readonly delegate;

  constructor(
    private readonly state = new StateRepository(),
    scheduleOrphan?: ScheduleOrphan,
    private readonly clientFactory?: ClientFactory,
  ) {
    this.delegate = new Synchronizer(state, scheduleOrphan, clientFactory);
  }

  private async clients(profile: Profile): Promise<ClientPair> {
    if (this.clientFactory) return this.clientFactory(profile);
    return {
      calendar: new GoogleCalendar(await googleCredentials(profile), profiles[profile].calendarId),
      todoist: new Todoist(await todoistToken(profile)),
    };
  }

  async process(delivery: Delivery): Promise<void> {
    if (delivery.kind === "todoist") return this.processTodoist(delivery);
    if (delivery.kind === "orphan") {
      const handled = await this.processMovedOrphan(delivery);
      if (handled) return;
    }
    return this.delegate.process(delivery);
  }

  private async processMovedOrphan(delivery: Delivery): Promise<boolean> {
    const orphan = delivery.orphan;
    if (!orphan) return false;
    const { todoist } = await this.clients(delivery.profile);
    try {
      const task = await todoist.getTask(orphan.taskId);
      const currentProfile = profileForTodoistProject(task.project_id);
      if (currentProfile === delivery.profile) return false;
      const mapping = await this.state.getMappingByEvent(delivery.profile, orphan.eventId);
      await this.state.putCalendarProjectionTombstone(
        delivery.profile,
        orphan.taskId,
        task.updated_at || delivery.receivedAt,
        currentProfile ? undefined : "project_exit",
      );
      if (mapping?.taskId === orphan.taskId) await this.state.deleteMapping(mapping);
      await this.state.audit(delivery.profile, "orphan_recheck_task_moved_project", {
        ...orphan,
        projectId: task.project_id,
        currentProfile,
      });
      return true;
    } catch (error) {
      if (Number((error as { status?: number }).status) === 404) return false;
      throw error;
    }
  }

  private async authoritativeTask(
    delivery: Delivery,
    payload: TodoistWebhookPayload,
    mapping: Mapping | undefined,
  ): Promise<TodoistTask> {
    const webhookTask = payload.event_data!;
    const oldProjectId = payload.event_data_extra?.old_item?.project_id;
    const currentProfile = profileForTodoistProject(webhookTask.project_id);
    const projectChanged = Boolean(oldProjectId && oldProjectId !== webhookTask.project_id);
    const ownershipConflict = Boolean(mapping && currentProfile !== mapping.profile);
    if (!webhookTask.project_id || projectChanged || ownershipConflict) {
      try {
        const { todoist } = await this.clients(delivery.profile);
        return await todoist.getTask(webhookTask.id);
      } catch (error) {
        if (Number((error as { status?: number }).status) !== 404) throw error;
      }
    }
    return webhookTask;
  }

  private async mutationAllowed(delivery: Delivery, profilesToMutate: Profile[]): Promise<boolean> {
    if (delivery.mode !== "aws") return false;
    for (const profile of [...new Set(profilesToMutate)]) {
      if (!await this.state.mutationAllowed(profile)) return false;
    }
    return true;
  }

  private async applyActiveTodoistExceptionEdit(
    delivery: Delivery,
    task: TodoistTask,
    lifecycle: TodoistLifecycle,
    mapping: Mapping | undefined,
    profile: Profile,
    oldTask?: TodoistTask,
  ): Promise<boolean> {
    if (lifecycle.action !== "upsert"
      || mapping?.recurrenceOwner !== "todoist"
      || !mapping.masterEventId
      || !mapping.activeInstanceId
      || !todoistRecurrenceToRrule(task)
      // Google->Todoist propagation may itself cause a Todoist item:updated
      // webhook. Only a real Todoist field change is allowed to write back to
      // the active exception, otherwise the echo would become a false edit.
      || !todoistTaskChangedAgainstOldItem(task, oldTask)) return false;

    const { calendar } = await this.clients(profile);
    let master: CalendarEvent;
    try {
      master = await calendar.getEvent(mapping.masterEventId);
    } catch (error) {
      if ([404, 410].includes(Number((error as { status?: number }).status))) return false;
      throw error;
    }
    // A recurrence-rule edit belongs to Todoist as rule owner and must flow to
    // the master through the normal synchronizer, not be mistaken for a one-off
    // exception edit.
    if (!master.recurrence?.length || !calendarRecurrenceMatchesTodoist(master, task)) return false;

    const instances = await calendar.listInstances(master.id);
    const active = instances.find((instance) => instance.id === mapping.activeInstanceId && instance.status !== "cancelled");
    // Only intercept when Google already has an exception. Ordinary Todoist
    // edits on a normal occurrence continue to update the Todoist-owned series
    // template/master as before.
    if (!active || !todoistOwnedOccurrenceIsException(master, active)) return false;

    const versionAccepted = await this.state.acceptTaskVersion(profile, task.id, task.updated_at, delivery.id);
    if (!versionAccepted) {
      await this.state.audit(profile, "todoist_recurrence_active_exception_stale_version_suppressed", {
        taskId: task.id,
        eventId: active.id,
        taskUpdatedAt: task.updated_at,
      });
      return true;
    }

    if (!await this.mutationAllowed(delivery, [profile])) {
      await this.state.audit(profile, "todoist_recurrence_active_exception_writeback_suppressed", {
        taskId: task.id,
        eventId: active.id,
        mode: delivery.mode,
      });
      return true;
    }

    const stored = await calendar.upsertEvent(todoistOccurrenceProjection(task, active), active.id);
    const nextMapping: Mapping = {
      ...mapping,
      eventId: master.id,
      activeInstanceId: stored.id,
      originalStart: eventStart(stored) || mapping.originalStart,
      activeEffectiveStart: eventEffectiveStart(stored) || mapping.activeEffectiveStart,
      updatedAt: new Date().toISOString(),
    };
    await this.state.putMapping(nextMapping);
    await this.state.putRecurrenceLink(recurrenceLink(nextMapping, "todoist"));
    await this.state.recordMutation(profile);
    await this.state.audit(profile, "todoist_recurrence_active_exception_written_back", {
      taskId: task.id,
      masterEventId: master.id,
      eventId: stored.id,
      originalStart: nextMapping.originalStart,
      effectiveStart: nextMapping.activeEffectiveStart,
      // We intentionally do not delete/recreate the Google instance merely to
      // erase exception metadata. Matching the master values is sufficient to
      // reconstitute the series visually while retaining stable logical identity.
      visuallyRejoinedSeries: !todoistOwnedOccurrenceIsException(master, stored),
    });
    return true;
  }

  private async processTodoist(delivery: Delivery): Promise<void> {
    const rawPayload = JSON.parse(delivery.body) as TodoistWebhookPayload;
    if (!rawPayload.event_data?.id) return;

    const mapping = await this.state.getMappingByTaskAnyProfile(rawPayload.event_data.id);
    const task = await this.authoritativeTask(delivery, rawPayload, mapping);
    const payload: TodoistWebhookPayload = { ...rawPayload, event_data: task };
    const lifecycle = todoistCalendarLifecycle(payload);
    if (!lifecycle) return;

    const oldProjectId = rawPayload.event_data_extra?.old_item?.project_id;
    const transition = todoistProjectTransition(oldProjectId, task.project_id, mapping?.profile);
    const explicitProjectChange = Boolean(oldProjectId && oldProjectId !== task.project_id);
    const explicitProjectReentry = Boolean(
      explicitProjectChange
      && !profileForTodoistProject(oldProjectId)
      && transition.action === "create_projection"
      && transition.toProfile,
    );

    if (transition.action === "skip") {
      return this.state.audit(delivery.profile, "todoist_calendar_skipped_unmapped_project", {
        taskId: task.id,
        projectId: task.project_id,
        event: payload.event_name,
      });
    }

    if (transition.action === "move_projection" || transition.action === "delete_projection" || transition.action === "create_projection") {
      const versionAccepted = await this.state.acceptTaskVersion(delivery.profile, task.id, task.updated_at, delivery.id);
      if (!versionAccepted && !explicitProjectChange) {
        return this.state.audit(delivery.profile, "todoist_stale_project_move_suppressed", {
          taskId: task.id,
          taskUpdatedAt: task.updated_at,
          fromProfile: transition.fromProfile,
          toProfile: transition.toProfile,
        });
      }
      if (transition.action === "create_projection") {
        if (transition.toProfile && lifecycle.action === "upsert") {
          const tombstone = await this.state.getCalendarProjectionTombstone(transition.toProfile, task.id);
          await this.createDestinationProjection(delivery, task, lifecycle, transition.toProfile, tombstone, explicitProjectReentry);
        } else {
          await this.state.audit(transition.toProfile || delivery.profile, "todoist_project_projection_not_created", {
            taskId: task.id,
            toProfile: transition.toProfile,
            reason: lifecycle.reason,
          });
        }
        return;
      }
      await this.applyProjectMove(delivery, task, lifecycle, transition, mapping);
      return;
    }

    const destinationProfile = transition.toProfile || mapping?.profile;
    if (!destinationProfile) return;
    if (await this.applyActiveTodoistExceptionEdit(
      delivery,
      task,
      lifecycle,
      mapping,
      destinationProfile,
      rawPayload.event_data_extra?.old_item,
    )) return;

    const routed: Delivery = {
      ...delivery,
      profile: destinationProfile,
      body: JSON.stringify(payload),
    };
    return this.delegate.process(routed);
  }

  private async createDestinationProjection(
    delivery: Delivery,
    task: TodoistTask,
    lifecycle: TodoistLifecycle,
    destinationProfile: Profile,
    destinationTombstone: CalendarProjectionTombstone | undefined,
    explicitProjectReentry = false,
  ): Promise<Mapping | undefined> {
    if (!await this.mutationAllowed(delivery, [destinationProfile])) {
      await this.state.audit(destinationProfile, "todoist_project_create_mutation_suppressed", { taskId: task.id, mode: delivery.mode });
      return undefined;
    }
    const projectResetRequired = destinationTombstone?.reason === "project_exit";
    const projectResetAllowed = Boolean(projectResetRequired && explicitProjectReentry);
    const tombstoneBlocksCreation = Boolean(
      destinationTombstone
      && ((projectResetRequired && !projectResetAllowed)
        || (!projectResetRequired && !canRecreateCalendarProjection(lifecycle, task.updated_at, destinationTombstone.sourceUpdatedAt)))
    );
    if (tombstoneBlocksCreation) {
      await this.state.audit(destinationProfile, "todoist_project_create_stale_destination_suppressed", {
        taskId: task.id,
        taskUpdatedAt: task.updated_at,
        removedAt: destinationTombstone?.sourceUpdatedAt,
        tombstoneReason: destinationTombstone?.reason,
      });
      return undefined;
    }
    const clients = await this.clients(destinationProfile);
    let existingEvent = await clients.calendar.findByTodoistTaskId(task.id);
    if (existingEvent?.status === "cancelled") existingEvent = undefined;
    const stored = existingEvent && hasCanonicalState(existingEvent, task)
      ? existingEvent
      : await clients.calendar.upsertEvent(toCalendarEvent(task, existingEvent), existingEvent?.id);
    const existingComment = await clients.todoist.findComment(task.id, stored.id);
    const comment = await clients.todoist.upsertComment(task.id, taskComment(stored), existingComment?.id);
    const todoistRecurring = Boolean(task.due?.is_recurring);
    const todoistRrule = Boolean(todoistRecurring && todoistRecurrenceToRrule(task) && stored.recurrence?.length);
    let active: CalendarEvent | undefined;
    if (todoistRrule) active = selectTodoistCurrentInstance(await clients.calendar.listInstances(stored.id), task);
    const nextMapping: Mapping = {
      profile: destinationProfile,
      projectId: task.project_id,
      eventId: stored.id,
      taskId: task.id,
      commentId: comment.id,
      recurrenceId: stored.recurringEventId,
      recurrenceOwner: todoistRecurring ? "todoist" : undefined,
      seriesId: todoistRecurring ? task.id : undefined,
      masterEventId: todoistRrule ? stored.id : undefined,
      activeInstanceId: todoistRrule ? active?.id : todoistRecurring ? stored.id : undefined,
      originalStart: todoistRrule ? (active ? eventStart(active) : eventStart(stored)) : todoistRecurring ? eventStart(stored) : undefined,
      activeEffectiveStart: todoistRrule ? (active ? eventEffectiveStart(active) : undefined) : todoistRecurring ? eventEffectiveStart(stored) : undefined,
      updatedAt: new Date().toISOString(),
    };
    await this.state.putMapping(nextMapping);
    if (todoistRecurring) await this.state.putRecurrenceLink(recurrenceLink(nextMapping, "todoist"));
    if (destinationTombstone) await this.state.deleteCalendarProjectionTombstone(destinationProfile, task.id);
    await this.state.recordMutation(destinationProfile);
    await this.state.audit(destinationProfile, projectResetAllowed ? "todoist_project_projection_reset" : "todoist_project_projection_created", {
      taskId: task.id,
      eventId: stored.id,
      activeInstanceId: active?.id,
      recurrenceProjection: todoistRrule ? "rrule" : todoistRecurring ? "rolling" : "none",
      ...(projectResetAllowed ? { resetReason: "project_exit" } : {}),
    });
    return nextMapping;
  }

  private async removeSourceProjection(
    delivery: Delivery,
    task: TodoistTask,
    sourceProfile: Profile,
    mapping: Mapping | undefined,
    deleteCalendarMaster = false,
    tombstoneReason?: CalendarProjectionTombstoneReason,
  ): Promise<void> {
    const sourceClients = await this.clients(sourceProfile);
    const sourceMapping = mapping?.profile === sourceProfile ? mapping : undefined;
    let eventId = sourceMapping
      ? (deleteCalendarMaster && sourceMapping.masterEventId ? sourceMapping.masterEventId : sourceMapping.eventId)
      : undefined;
    if (!eventId) {
      const linked = await sourceClients.calendar.findByTodoistTaskId(task.id);
      if (linked?.status !== "cancelled") eventId = deleteCalendarMaster && linked?.recurringEventId ? linked.recurringEventId : linked?.id;
    }
    await this.state.putCalendarProjectionTombstone(sourceProfile, task.id, task.updated_at || delivery.receivedAt, tombstoneReason);
    if (eventId) {
      await sourceClients.calendar.deleteEvent(eventId).catch((error: unknown) => {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
      });
    }
    if (sourceMapping?.commentId) await sourceClients.todoist.deleteComment(sourceMapping.commentId).catch(() => undefined);
    if (sourceMapping?.seriesId) await this.state.deleteRecurrenceLink(sourceProfile, sourceMapping.seriesId);
    if (sourceMapping) await this.state.deleteMapping(sourceMapping);
    if (eventId || sourceMapping) await this.state.recordMutation(sourceProfile);
  }

  private async prepareCalendarOwnedDestinationSeries(
    task: TodoistTask,
    destinationProfile: Profile,
    sourceMaster: CalendarEvent,
    sourceMapping: Mapping,
  ): Promise<Mapping> {
    const destinationClients = await this.clients(destinationProfile);
    const existing = await destinationClients.calendar.findByTodoistTaskId(task.id);
    let destinationMaster: CalendarEvent | undefined;
    if (existing?.recurringEventId) {
      try {
        destinationMaster = await destinationClients.calendar.getEvent(existing.recurringEventId);
      } catch (error) {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
      }
    } else if (existing?.recurrence?.length) {
      destinationMaster = existing;
    } else if (existing && existing.status !== "cancelled") {
      destinationMaster = await destinationClients.calendar.upsertEvent(calendarSeriesProjection(sourceMaster, task), existing.id);
    }
    if (!destinationMaster) destinationMaster = await destinationClients.calendar.upsertEvent(calendarSeriesProjection(sourceMaster, task));

    const instances = await destinationClients.calendar.listInstances(destinationMaster.id);
    const active = matchingRecurringInstance(instances, task, sourceMapping.originalStart);
    if (!active) throw new Error(`Moved Calendar recurrence ${destinationMaster.id} has no instance matching Todoist task ${task.id}`);
    return {
      profile: destinationProfile,
      projectId: task.project_id,
      eventId: active.id,
      taskId: task.id,
      recurrenceOwner: "calendar",
      seriesId: destinationMaster.iCalUID || destinationMaster.id,
      masterEventId: destinationMaster.id,
      activeInstanceId: active.id,
      originalStart: eventStart(active),
      activeEffectiveStart: eventEffectiveStart(active),
      updatedAt: new Date().toISOString(),
    };
  }

  private async applyCalendarOwnedProjectMove(
    delivery: Delivery,
    task: TodoistTask,
    lifecycle: TodoistLifecycle,
    transition: TodoistProjectTransition,
    mapping: Mapping,
  ): Promise<void> {
    const sourceProfile = transition.fromProfile;
    const destinationProfile = transition.toProfile;
    if (!sourceProfile || !mapping.masterEventId) return;

    const willCreateDestination = Boolean(destinationProfile && lifecycle.action === "upsert");
    const affected = [sourceProfile, ...(willCreateDestination && destinationProfile ? [destinationProfile] : [])];
    if (!await this.mutationAllowed(delivery, affected)) {
      return this.state.audit(sourceProfile, "todoist_calendar_owned_project_move_mutation_suppressed", {
        taskId: task.id,
        fromProfile: sourceProfile,
        toProfile: destinationProfile,
        mode: delivery.mode,
      });
    }

    const destinationTombstone = willCreateDestination && destinationProfile
      ? await this.state.getCalendarProjectionTombstone(destinationProfile, task.id)
      : undefined;
    const destinationAllowed = !destinationTombstone || canRecreateCalendarProjection(lifecycle, task.updated_at, destinationTombstone.sourceUpdatedAt);

    let preparedDestination: Mapping | undefined;
    if (willCreateDestination && destinationProfile && destinationAllowed) {
      const sourceClients = await this.clients(sourceProfile);
      let sourceMaster: CalendarEvent;
      try {
        sourceMaster = await sourceClients.calendar.getEvent(mapping.masterEventId);
      } catch (error) {
        if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
        await this.removeSourceProjection(delivery, task, sourceProfile, mapping, true);
        await this.createDestinationProjection(delivery, task, lifecycle, destinationProfile, destinationTombstone);
        return;
      }
      preparedDestination = await this.prepareCalendarOwnedDestinationSeries(task, destinationProfile, sourceMaster, mapping);
    }

    await this.removeSourceProjection(
      delivery,
      task,
      sourceProfile,
      mapping,
      true,
      destinationProfile ? undefined : "project_exit",
    );

    if (!willCreateDestination || !destinationProfile) {
      return this.state.audit(sourceProfile, "todoist_calendar_owned_project_projection_removed", {
        taskId: task.id,
        fromProfile: sourceProfile,
        toProfile: destinationProfile,
        reason: lifecycle.reason,
      });
    }
    if (!destinationAllowed) {
      return this.state.audit(destinationProfile, "todoist_calendar_owned_project_move_stale_destination_suppressed", {
        taskId: task.id,
        fromProfile: sourceProfile,
        toProfile: destinationProfile,
        taskUpdatedAt: task.updated_at,
        removedAt: destinationTombstone?.sourceUpdatedAt,
      });
    }
    if (!preparedDestination) return;

    const destinationClients = await this.clients(destinationProfile);
    const existingComment = await destinationClients.todoist.findComment(task.id, preparedDestination.eventId);
    const activeEvent = await destinationClients.calendar.getEvent(preparedDestination.eventId).catch(() => undefined);
    const commentEvent: CalendarEvent = activeEvent || { id: preparedDestination.eventId };
    const comment = await destinationClients.todoist.upsertComment(task.id, taskComment(commentEvent), existingComment?.id);
    const nextMapping: Mapping = { ...preparedDestination, commentId: comment.id };
    await this.state.putMapping(nextMapping);
    await this.state.putRecurrenceLink(recurrenceLink(nextMapping, "calendar"));
    if (destinationTombstone) await this.state.deleteCalendarProjectionTombstone(destinationProfile, task.id);
    await this.state.recordMutation(destinationProfile);
    await this.state.audit(destinationProfile, "todoist_calendar_owned_project_projection_moved", {
      taskId: task.id,
      fromProfile: sourceProfile,
      toProfile: destinationProfile,
      masterEventId: nextMapping.masterEventId,
      eventId: nextMapping.eventId,
    });
  }

  private async applyProjectMove(
    delivery: Delivery,
    task: TodoistTask,
    lifecycle: TodoistLifecycle,
    transition: TodoistProjectTransition,
    mapping: Mapping | undefined,
  ): Promise<void> {
    const sourceProfile = transition.fromProfile;
    const destinationProfile = transition.toProfile;
    if (!sourceProfile) return;

    if (mapping?.recurrenceOwner === "calendar" && mapping.masterEventId) {
      return this.applyCalendarOwnedProjectMove(delivery, task, lifecycle, transition, mapping);
    }

    const willCreateDestination = Boolean(destinationProfile && lifecycle.action === "upsert");
    const affected = [sourceProfile, ...(willCreateDestination && destinationProfile ? [destinationProfile] : [])];
    if (!await this.mutationAllowed(delivery, affected)) {
      return this.state.audit(sourceProfile, "todoist_project_move_mutation_suppressed", {
        taskId: task.id,
        fromProfile: sourceProfile,
        toProfile: destinationProfile,
        mode: delivery.mode,
      });
    }

    const destinationTombstone = willCreateDestination && destinationProfile
      ? await this.state.getCalendarProjectionTombstone(destinationProfile, task.id)
      : undefined;

    await this.removeSourceProjection(
      delivery,
      task,
      sourceProfile,
      mapping,
      false,
      destinationProfile ? undefined : "project_exit",
    );

    if (!willCreateDestination || !destinationProfile) {
      return this.state.audit(sourceProfile, "todoist_project_projection_removed", {
        taskId: task.id,
        fromProfile: sourceProfile,
        toProfile: destinationProfile,
        reason: lifecycle.reason,
      });
    }

    const nextMapping = await this.createDestinationProjection(delivery, task, lifecycle, destinationProfile, destinationTombstone);
    if (nextMapping) {
      await this.state.audit(destinationProfile, "todoist_project_projection_moved", {
        taskId: task.id,
        fromProfile: sourceProfile,
        toProfile: destinationProfile,
        eventId: nextMapping.eventId,
      });
    }
  }
}
