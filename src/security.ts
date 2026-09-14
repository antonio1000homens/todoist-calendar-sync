import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function equalSecret(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const candidate = Buffer.from(supplied);
  const target = Buffer.from(expected);
  return candidate.length === target.length && timingSafeEqual(candidate, target);
}

export function validTodoistSignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest("base64");
  return equalSecret(signature, expected);
}

export function normalizedText(value: unknown): string {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\u200B/g, "").replace(/\s+/g, " ").trim();
}

export function normalizedStart(value: string | undefined, dateOnly: boolean): string {
  if (!value) return "";
  if (dateOnly) return `date:${value.slice(0, 10)}`;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? `invalid:${value}` : `datetime:${new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}
