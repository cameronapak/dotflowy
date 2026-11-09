export async function resolveAdminCookie(api: string): Promise<string> {
  const explicit = process.env.DOTFLOWY_SESSION_COOKIE;
  if (explicit) return explicit;

  const email = process.env.DOTFLOWY_ADMIN_EMAIL;
  const password = process.env.DOTFLOWY_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error(
      "Set DOTFLOWY_ADMIN_EMAIL + DOTFLOWY_ADMIN_PASSWORD (an admin on the allowlist),\n" +
        "or DOTFLOWY_SESSION_COOKIE with a signed-in session cookie.",
    );
    process.exit(1);
  }

  const res = await fetch(`${api}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    console.error(
      `admin sign-in failed (status ${res.status}): ${await res.text()}`,
    );
    process.exit(1);
  }
  const cookie = res.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
  if (!cookie) {
    console.error("admin sign-in returned no session cookie");
    process.exit(1);
  }
  return cookie;
}
