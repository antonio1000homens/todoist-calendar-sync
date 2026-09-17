export type Profile = "home" | "antonio" | "work";
export type CutoverMode = "aws";
export type DeliveryKind = "calendar" | "todoist" | "orphan" | "reconcile" | "manual";
export type ReconciliationReason = "webhook" | "scheduled" | "baseline_recovery" | "manual";
export type CalendarWatchStatus = "active" | "replaced" | "missing";

export interface CalendarWatchState {
  profile: Profile;
  channelId: string;
  resourceId: string;
  expiration: string;
  callbackUrl: string;
  generation: string;
  createdAt: string;
  renewedAt: string;
  lastNotificationAt?: string;
  status: CalendarWatchStatus;
}

/**
 * Ordering is isolated by sync profile. Work that can mutate one profile must
 * always use the same FIFO message group so webhook processing and repair work
 * cannot overlap for that profile. Worker concurrency remains 1 until
 * cross-profile Todoist moves have explicit coordination.
 */
export function syncMessageGroupId(profile: Profile): string {
  return `sync:${profile}`;
}

export type ManualCommand =
  | "reconcile_now"
  | "show_status"
  | "list_conflicts"
  | "inspect_mapping"
  | "resume_pending_reconciliation"
  | "resume_decision"
  | "list_policies"
  | "set_policy"
  | "clear_policy";

export interface ManualPolicyControl {
  decisionType: string;
  scope: "global" | "profile" | "series";
  mode?: "off" | "observe" | "prompt" | "auto";
  defaultAction?: string;
  seriesId?: string;
}

export interface ManualControlDelivery {
  decisionId?: string;
  action?: string;
  command?: ManualCommand;
  targetType?: "task" | "event" | "decision" | "profile" | "policy";
  targetId?: string;
  slackUserId?: string;
  slackChannelId?: string;
  slackMessageTs?: string;
  policy?: ManualPolicyControl;
}

export interface ReconciliationContinuation {
  sequence: number;
  phase: "mapped" | "unmapped" | "calendar";
  /** Last Todoist task id processed in mapped/unmapped phases. Candidates are sorted before applying this cursor. */
  afterTaskId?: string;
  /** Last Calendar event id processed in Calendar snapshot recovery. Events are sorted before applying this cursor. */
  afterEventId?: string;
}

export interface Delivery {
  id: string;
  kind: DeliveryKind;
  profile: Profile;
  mode: CutoverMode;
  receivedAt: string;
  /** Sanitized provider metadata only. Never persist auth/signature headers. */
  headers: Record<string, string>;
  body: string;
  orphan?: { eventId: string; taskId: string; attempt: 2 };
  reconcile?: {
    reason: ReconciliationReason;
    generation: string;
    continuation?: ReconciliationContinuation;
  };
  manual?: ManualControlDelivery;
  /** @deprecated Compatibility for any pre-deployment queued reconcile message. */
  reconcileProfiles?: readonly Profile[];
}

export interface GoogleOAuthCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

export interface GoogleServiceAccountCredentials {
  type: "service_account";
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export type GoogleCredentials = GoogleOAuthCredentials | GoogleServiceAccountCredentials;

export interface TodoistDue {
  date?: string;
  datetime?: string;
  timezone?: string;
  string?: string;
  lang?: string;
  is_recurring?: boolean;
}

export interface TodoistTask {
  id: string;
  content: string;
  description?: string;
  project_id?: string;
  due?: TodoistDue | null;
  url?: string;
  updated_at?: string;
  is_completed?: boolean;
  is_deleted?: boolean;
}

export interface TodoistWebhookPayload {
  event_name?: string;
  event_data?: TodoistTask;
  event_data_extra?: {
    old_item?: TodoistTask;
    update_intent?: string;
  };
}

export interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string;
  iCalUID?: string;
  originalStartTime?: { date?: string; dateTime?: string; timeZone?: string };
  extendedProperties?: { shared?: Record<string, string>; private?: Record<string, string> };
}

export interface Mapping {
  profile: Profile;
  eventId: string;
  taskId: string;
  projectId?: string;
  /** Canonical Todoist-side breadcrumb from the project comment index. */
  projectCommentId?: string;
  /** Explicit legacy task comment retained only for migration/fallback/cleanup. */
  taskCommentId?: string;
  /** @deprecated Legacy task-comment mapping field. Read for migration compatibility only. */
  commentId?: string;
  /** Monotonic revision stored in the versioned project mapping comment. */
  mappingRevision?: number;
  recurrenceId?: string;
  /** The authoritative recurrence system. Calendar-owned series use one Todoist mirror; supported Todoist-owned rules use a Calendar RRULE master. */
  recurrenceOwner?: "calendar" | "todoist";
  /** Calendar iCalUID for Calendar-owned series, or the Todoist task ID for Todoist-owned recurrence projections. */
  seriesId?: string;
  /** Owning Google recurring master when one exists. */
  masterEventId?: string;
  /** Current projected occurrence for rolling recurrence models or the active Google instance for a Todoist-owned RRULE. */
  activeInstanceId?: string;
  /** Immutable logical occurrence identity (`originalStartTime` for Google instances). */
  originalStart?: string;
  /** Actual scheduled start of the active occurrence after Calendar exceptions have been applied. */
  activeEffectiveStart?: string;
  /** Marks Calendar-owned recurrence state whose completion progress is safe to use for backward re-anchoring. */
  calendarProgressVersion?: 1;
  /** Monotonic immutable `originalStart` of the latest logically completed Calendar-owned occurrence. */
  completedThroughOriginalStart?: string;
  updatedAt: string;
}

export interface RecurrenceLink {
  profile: Profile;
  owner: "calendar" | "todoist";
  seriesId: string;
  masterEventId?: string;
  activeInstanceId?: string;
  originalStart?: string;
  activeEffectiveStart?: string;
  /** Marks Calendar-owned recurrence state whose completion progress is safe to use for backward re-anchoring. */
  calendarProgressVersion?: 1;
  /** Monotonic immutable `originalStart` of the latest logically completed Calendar-owned occurrence. */
  completedThroughOriginalStart?: string;
  taskId: string;
  eventId: string;
  updatedAt: string;
}