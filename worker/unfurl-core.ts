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

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Return the canonical metadata URL for a recognized YouTube video URL.
 * The user's pasted URL stays untouched; this identity only deduplicates title
 * lookups across watch/share/Shorts/Live/embed and timestamp variants. */
export function canonicalYouTubeVideoUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.port) return null;

  const host = u.hostname.toLowerCase();
  let videoId: string | null = null;

  if (host === "youtu.be") {
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 1) videoId = parts[0] ?? null;
  } else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (u.pathname === "/watch") {
      videoId = u.searchParams.get("v");
    } else {
      videoId =
        /^\/(?:v|shorts|embed|live)\/([^/]+)\/?$/.exec(u.pathname)?.[1] ?? null;
    }
  }

  return videoId && YOUTUBE_VIDEO_ID.test(videoId)
    ? `https://www.youtube.com/watch?v=${videoId}`
    : null;
}

/** An IPv4 literal outside public unicast space: private, loopback,
 *  link-local, CGNAT, documentation, benchmarking, multicast, or reserved. Used
 *  to deny obvious internal targets even though Cloudflare already blocks raw-IP
 *  fetch -- belt and suspenders. Non-IPv4 hostnames return false here (handled
 *  by the name checks in isAllowedUnfurlTarget). */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  // SAFETY: the regex captured exactly four groups and map preserves length.
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10/8 private
    a === 127 || // 127/8 loopback
    (a === 169 && b === 254) || // 169.254/16 link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
    (a === 192 && b === 168) || // 192.168/16 private
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0/24 IETF, 192.0.2/24 TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // 198.51.100/24 TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // 203.0.113/24 TEST-NET-3
    a >= 224 // 224/4 multicast, 240/4 reserved, 255.255.255.255 broadcast
  );
}

/** Parse an IPv6 literal (no brackets) into its eight 16-bit groups, else
 *  null. Accepts `::` compression and a trailing dotted-IPv4 tail. */
function parseIpv6(host: string): number[] | null {
  if (!host.includes(":")) return null;
  let text = host;
  const tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const o = dotted[2]!.split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    tail.push((o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!);
    text = dotted[1]!.endsWith("::") ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
    return groups.map((g) => parseInt(g, 16));
  };
  const head = parseGroups(halves[0]!);
  const rest = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (!head || !rest) return null;
  const explicit = head.length + rest.length + tail.length;
  if (halves.length === 1) return explicit === 8 ? [...head, ...tail] : null;
  if (explicit > 7) return null;
  return [...head, ...Array<number>(8 - explicit).fill(0), ...rest, ...tail];
}

/** True iff an IPv6 literal may be fetched. Only global unicast (2000::/3) is
 *  allowed, minus the ranges that embed or tunnel to an IPv4 address (6to4
 *  2002::/16, Teredo 2001::/32) and documentation space. This denies loopback,
 *  unspecified, link-local, ULA, multicast, NAT64 64:ff9b::/96, and the
 *  deprecated IPv4-compatible ::/96. IPv4-mapped ::ffff:0:0/96 is judged by
 *  its embedded IPv4 address (#232). An unparseable literal is denied. */
function isAllowedIpv6(host: string): boolean {
  const g = parseIpv6(host);
  if (!g) return false;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const [hi, lo] = [g[6]!, g[7]!];
    return !isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const [g0, g1] = [g[0]!, g[1]!];
  if ((g0 & 0xe000) !== 0x2000) return false; // not 2000::/3 global unicast
  if (g0 === 0x2002) return false; // 6to4
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0x0db8)) return false; // Teredo, docs
  if ((g0 & 0xfff0) === 0x3ff0 && g1 < 0x1000) return false; // 3fff::/20 docs
  return true;
}

/** The outbound target guard: exclude internal destinations and browser-only
 *  X content. Run before cache reads and on every redirect hop. A blocked
 *  target yields `{title:null}` (200), NOT a 400: from the client's view it's
 *  just "no title". */
export function isAllowedUnfurlTarget(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|]$|\.+$/g, ""); // IPv6 brackets / all trailing DNS dots
  if (!host) return false;
  if (
    host === "x.com" ||
    host.endsWith(".x.com") ||
    host === "twitter.com" ||
    host.endsWith(".twitter.com")
  )
    return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host.includes(":")) return isAllowedIpv6(host);
  if (isPrivateIpv4(host)) return false;
  return true;
}

/** The named HTML entities a title carries, keyed by lowercase name. */
interface EntityTable {
  [key: string]: string;
}

const NAMED_ENTITIES: EntityTable = {
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
