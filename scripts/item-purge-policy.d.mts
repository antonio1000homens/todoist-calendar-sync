export interface PurgeTarget { profile: "home" | "antonio" | "work"; taskId: string; eventId?: string }
export interface PurgeRecord { pk: string; sk: string; type: string; classification: string; reasons: string[]; hazards: string[]; digest: string }
export function planPurge(rows: Record<string, unknown>[], target: PurgeTarget): {
  records: PurgeRecord[]; counts: Record<string, number>; blockers: string[]; inventoryDigest: string;
};
export function fingerprint(value: unknown): string;
export function publicInventoryRecord(record: PurgeRecord): Omit<PurgeRecord, "digest">;
