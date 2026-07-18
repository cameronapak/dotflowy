/**
 * The Worker's auth/identity gates, as pure functions (map #151 / ticket #232).
 *
 * These decide tenant isolation (which DO a session touches), admin access, and
 * the shape/validity of the invite + email inputs. They use NO Workers globals
 * and NO bindings — only plain string env fields — so they import cleanly under
 * `bun test` (worker/identity.test.ts). e2e can't reach them (the mock
 * intercepts `/api/auth`), so unit tests are the only coverage this
 * security-critical logic gets. Keep them pure; the request wiring stays in
 * worker/index.ts / worker/auth.ts. See docs/adr/0011-the-auth-gate.md.
 */

/** The env slice these gates read — all plain config strings, no bindings. */
export interface IdentityEnv {
  /** The owner's Better Auth `user.id`; collapses that one account to the
   *  constant 'default' DO. See resolveUserId. */
  OWNER_USER_ID?: string;
  /** Comma-separated Better Auth `user.id`s allowed on admin surfaces — the
   *  PINNED admin identity (item 3, #232). When non-empty this is the sole
   *  admin check and ADMIN_EMAILS is ignored. */
  ADMIN_USER_IDS?: string;
  /** Legacy comma-separated admin email allowlist. Honored ONLY as a fallback
   *  when ADMIN_USER_IDS is empty, so a deploy that set only this keeps working.
   *  Prefer ADMIN_USER_IDS: an email is unverified (verification is off for
   *  beta), so the email path can be pre-registered; a `user.id` can't. */
  ADMIN_EMAILS?: string;
}

/** The owner-continuity DO name: the constant 'default' DO holding the pre-auth
 *  outline. Also the sentinel the Worker checks to run the one-time legacy
 *  import. */
export const OWNER_DO_ID = "default";

/**
 * The Durable Object name for a signed-in user's outline.
 *
 * LOCKED DECISION: a DO name is permanent and cannot be renamed, so it must
 * NEVER be an email or any value that can change — keying by email would orphan
 * a user's whole outline on an email/auth-provider change. Key by the stable
 * `user.id`. The one exception is the owner-continuity bridge: OWNER_USER_ID's
 * account maps to the constant 'default' DO (where the pre-auth outline lives),
 * carrying existing data over with zero copy. Do NOT key this off the email.
 */
export function resolveUserId(sessionUserId: string, env: IdentityEnv): string {
  if (env.OWNER_USER_ID && sessionUserId === env.OWNER_USER_ID)
    return OWNER_DO_ID;
  return sessionUserId;
}

/** Split a comma-separated env list into trimmed, non-empty entries. */
function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Is this session on the admin allowlist? Fail-closed at every step: no session,
 * neither var set, or no match → false.
 *
 * Pins to `user.id` (ADMIN_USER_IDS) when that's set — the hardened primary,
 * because it closes the register-the-admin-email-first path permanently (item 3,
 * #232). Falls back to the legacy case-insensitive email allowlist only when no
 * user-id allowlist is configured.
 */
export function isAdminSession(
  session: { user: { id: string; email: string } } | null,
  env: IdentityEnv,
): boolean {
  if (!session) return false;
  const ids = splitList(env.ADMIN_USER_IDS);
  if (ids.length > 0) return ids.includes(session.user.id);
  const emails = splitList(env.ADMIN_EMAILS).map((e) => e.toLowerCase());
  return emails.includes(session.user.email.toLowerCase());
}

/** Good-enough shape check for an address someone wants an invite sent to.
 *  Deliverability is unknowable here; this only rejects obvious junk. */
export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Does `supplied` match the shared INVITE_CODES backdoor? Pure half of the
 * signup gate's branch (b) (worker/auth.ts) — the per-email single-use path (a)
 * needs a D1 read and stays there. Fail-closed: an empty/whitespace-only
 * INVITE_CODES, or an empty supplied code, denies. Codes are matched verbatim
 * (already trimmed by the caller); no normalization.
 */
export function matchesSharedInviteCode(
  supplied: string,
  inviteCodes: string | undefined,
): boolean {
  if (!supplied) return false;
  return splitList(inviteCodes).includes(supplied);
}
