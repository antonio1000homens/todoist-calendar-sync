export interface PurgeTarget { profile: "home" | "antonio" | "work"; taskId: string; eventId?: string }
export interface PurgeRecord { pk: string; sk: string; type: string; classification: string; reasons: string[]; hazards: string[]; digest: string; receiptCleanup?:"scrub_identity_refs"; scrubbedDigest?:string }
export function planPurge(rows: Record<string, unknown>[], target: PurgeTarget, options?: {allowCompletedExactDeliveryReceipts?: boolean;knownEventIds?:string[]}): {
  records: PurgeRecord[]; counts: Record<string, number>; blockers: string[]; receiptSanitizationRequirements:string[]; inventoryDigest: string;
};
export function exactCalendarEventIds(row: Record<string, unknown>): string[];
export function exactTodoistTaskIds(row: Record<string, unknown>): string[];
export function fingerprint(value: unknown): string;
export function publicInventoryRecord(record: PurgeRecord): Omit<PurgeRecord, "digest">;
