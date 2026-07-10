/**
 * Pure helpers for the link-title unfurl endpoint (ADR 0016): input validation,
 * the SSRF target guard, and server-side title sanitization. These use NO
 * Workers globals (no fetch/HTMLRewriter/caches), so they import cleanly under
 * `bun test` (worker/unfurl.test.ts) -- the security-critical decisions live
 * here, unit-tested, while the hardened fetch that consumes them lives in
 * unfurl.ts (CF runtime only).
 */

export const MAX_TITLE_LEN = 300;

/** True iff `s` is a well-formed http(s) URL. The route uses this for the only
 *  400 (a missing / non-http(s) `url` param); every other "can't get a title"
 *  reason collapses to a 200 `{title:null}` (ADR 0016). */
export function isHttpUrlString(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return u.protocol === "http:" || u.protocol === "https:";
}

/** An IPv4 literal in a private / loopback / link-local / reserved range. Used
 *  to deny obvious internal targets even though Cloudflare already blocks raw-IP
 *  fetch -- belt and suspenders. Non-IPv4 hostnames return false here (handled
 *  by the name checks in isAllowedUnfurlTarget). */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10/8 private
    a === 127 || // 127/8 loopback
    (a === 169 && b === 254) || // 169.254/16 link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
    (a === 192 && b === 168) || // 192.168/16 private
    (a === 100 && b >= 64 && b <= 127) // 100.64/10 CGNAT
  );
}

/** The SSRF target guard: a fully-formed http(s) URL whose host isn't an obvious
 *  internal destination. Re-run on every redirect hop -- a 302 to an internal
 *  target is the classic redirect bounce. A blocked target yields `{title:null}`
 *  (200), NOT a 400: from the client's view it's just "no title". */
export function isAllowedUnfurlTarget(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|]$/g, ""); // strip IPv6 brackets
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host === "0.0.0.0" || host === "::" || host === "::1") return false;
  if (
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  )
    return false; // IPv6 link-local / ULA
  if (isPrivateIpv4(host)) return false;
  return true;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

/** Decode the handful of HTML entities a `<title>`/og:title realistically
 *  carries (HTMLRewriter text is not entity-decoded). Numeric and hex forms
 *  too. Unknown entities are left as-is. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase();
    if (key[0] === "#") {
      const code =
        key[1] === "x"
          ? parseInt(key.slice(2), 16)
          : parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[key] ?? whole;
  });
}

/** Make a raw extracted title presentable: entity-decode, collapse whitespace,
 *  trim, length-cap. Returns null when nothing usable is left -- the route then
 *  answers `{title:null}` and the client keeps the url placeholder. The client
 *  does its own markdown-label-safety pass (strip `]`) before inserting. */
export function sanitizeServerTitle(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const collapsed = decodeEntities(raw).replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > MAX_TITLE_LEN
    ? collapsed.slice(0, MAX_TITLE_LEN).trimEnd()
    : collapsed;
}
