import { Schema } from "effect";

import { dayKeyToScaffoldChain } from "../src/data/date-links";
import {
  bareHttpUrl,
  encodeUrlForMarkdown,
  sanitizeLinkLabel,
} from "../src/data/links";
import { isHttpUrlString } from "./unfurl-core";

export const CaptureBody = Schema.Struct({
  attemptId: Schema.String.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    ),
  ),
  date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  text: Schema.String.check(Schema.isMaxLength(10_000)),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
});

export const ApiKeyPermission = Schema.Literals(["capture", "read", "write"]);
export type ApiKeyPermission = typeof ApiKeyPermission.Type;

export const CaptureKeyCreateBody = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  expiry: Schema.optionalKey(Schema.Literals(["30d", "90d"])),
});

export const ApiKeyCreateBody = Schema.Struct({
  ...CaptureKeyCreateBody.fields,
  permission: Schema.optionalKey(ApiKeyPermission),
});

export const ApiKeyRotateBody = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(36)),
  expiry: CaptureKeyCreateBody.fields.expiry,
});

export const CaptureKeyRevokeBody = Schema.Struct({
  id: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(36))),
});

export interface CaptureReceipt {
  saved: true;
  nodeId: string;
  dailyNoteId: string;
  date: string;
}

export interface CaptureInput {
  attemptId: string;
  date: string;
  text: string;
  fingerprint: string;
}

export type CaptureResult =
  | { receipt: CaptureReceipt; replayed: true }
  | { receipt: CaptureReceipt; replayed: false; nodeIds: string[] }
  | { error: "node_limit" | "attempt_conflict" };

/** Preserve Markdown structure for intake; only standalone URLs are rewritten. */
export function normalizeCapture(input: typeof CaptureBody.Type) {
  if (!dayKeyToScaffoldChain(input.date)) return null;
  const text = input.text;
  if (!text.trim()) return null;
  const url = bareHttpUrl(text);
  if (!url || !isHttpUrlString(url)) return { text, unfurlUrl: null };
  const title = sanitizeLinkLabel(input.title ?? "");
  const label = title || sanitizeLinkLabel(url);
  return {
    text: `[${label}](${encodeUrlForMarkdown(url)})`,
    unfurlUrl: title ? null : url,
  };
}

export function captureKeyExpiration(
  expiry: typeof CaptureKeyCreateBody.Type.expiry,
  now: number,
): number {
  return now + (expiry === "90d" ? 90 : 30) * 86_400_000;
}

export async function captureDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
