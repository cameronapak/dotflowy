import { afterAll, beforeAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { build } from "esbuild";
import {
  Headers as ProviderHeaders,
  Miniflare,
  Request as ProviderRequest,
  Response as ProviderResponse,
} from "miniflare";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let mf: Miniflare;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "dotflowy-google-auth-"));
  const bundle = await build({
    stdin: {
      contents: `import { createAuth } from "./worker/auth";
        const mail = new Map();
        export default { fetch(request, env, ctx) {
          const url = new URL(request.url);
          if (url.pathname === "/__fixture/email")
            return Response.json(mail.get(url.searchParams.get("to")) ?? null);
          const mode = request.headers.get("x-fixture-signup-mode");
          return createAuth({ ...env,
            EMAIL: { async send(message) { mail.set(message.to, message.text); return { messageId: "fixture-only" }; } },
            SIGNUP_OPEN: mode === "open" ? "true" : mode === "malformed" ? "TRUE" : undefined }, "http://fixture", ctx).handler(request);
        } };`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "browser"],
    external: ["cloudflare:*", "node:*"],
    target: "es2022",
  });
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker" as const,
          name: "auth-test",
          compatibilityDate: "2026-06-23",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.mjs",
            modulesRoot: directory,
            modules: {
              "worker.mjs": {
                type: "esm" as const,
                contents: bundle.outputFiles[0]!.text,
              },
            },
          },
          env: {
            DB: { type: "d1" as const, id: "google-auth-db" },
            BETTER_AUTH_SECRET: {
              type: "text" as const,
              value: "disposable-google-auth-test-secret",
            },
            BETTER_AUTH_URL: { type: "text" as const, value: "http://fixture" },
            GOOGLE_CLIENT_ID: {
              type: "text" as const,
              value: "fixture-client",
            },
            GOOGLE_CLIENT_SECRET: {
              type: "text" as const,
              value: "fixture-secret",
            },
            INVITE_CODES: { type: "text" as const, value: "fixture-invite" },
          },
        },
        dev: {
          outboundService: {
            type: "fetcher" as const,
            async handler(request: ProviderRequest) {
              const url = new URL(request.url);
              if (
                url.origin !== "https://oauth2.googleapis.com" ||
                url.pathname !== "/token"
              )
                throw new Error(`Unexpected outbound request: ${request.url}`);
              const email = new URLSearchParams(await request.text()).get(
                "code",
              )!;
              // Only Google's code-exchange transport is replaced. Better Auth
              // owns state/PKCE, provider profile decoding, linking, D1 and sessions.
              const payload = Buffer.from(
                JSON.stringify({
                  sub: `google:${email}`,
                  email,
                  email_verified: true,
                  name: "Google Fixture",
                  aud: "fixture-client",
                  iss: "https://accounts.google.com",
                  iat: Math.floor(Date.now() / 1000),
                  exp: Math.floor(Date.now() / 1000) + 3600,
                }),
              ).toString("base64url");
              return new ProviderResponse(
                JSON.stringify({
                  access_token: "fixture-access-token",
                  token_type: "Bearer",
                  expires_in: 3600,
                  id_token: `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${payload}.fixture-signature`,
                }),
                { headers: { "content-type": "application/json" } },
              );
            },
          },
        },
      },
    ],
  });
  const db = await mf.getD1Database("DB");
  for (const file of [
    "0003_create_auth.sql",
    "0004_create_oauth.sql",
    "0005_create_waitlist.sql",
    "0006_create_stripe.sql",
    "0007_create_invites.sql",
    "0014_capture_keys.sql",
  ]) {
    const sql = await readFile(`migrations/${file}`, "utf8");
    await db.exec(sql.replace(/--[^\n]*/g, "").replaceAll("\n", " "));
  }
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function request(
  mode: string,
  path: string,
  body?: Record<string, string | boolean>,
  cookie?: string,
) {
  const headers = new ProviderHeaders({
    origin: "http://fixture",
    "content-type": "application/json",
    "x-fixture-signup-mode": mode,
  });
  if (cookie) headers.set("cookie", cookie);
  return mf.dispatchFetch(`http://fixture/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
}

function cookies(response: Pick<ProviderResponse, "headers">) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function google(mode: string, email: string, requestSignUp = false) {
  const start = await request(mode, "/sign-in/social", {
    provider: "google",
    callbackURL: "http://fixture/",
    errorCallbackURL: "http://fixture/",
    requestSignUp,
  });
  expect(start.status, await start.clone().text()).toBe(200);
  // SAFETY: The successful Better Auth social-start response supplies its authorization URL.
  const body = (await start.json()) as { url: string };
  const state = new URL(body.url).searchParams.get("state")!;
  return request(
    mode,
    `/callback/google?${new URLSearchParams({ state, code: email })}`,
    undefined,
    cookies(start),
  );
}

async function session(
  mode: string,
  response: Awaited<ReturnType<typeof google>>,
) {
  const result = await request(
    mode,
    "/get-session",
    undefined,
    cookies(response),
  );
  // SAFETY: Better Auth get-session returns the authenticated user or null; assertions below verify identity.
  return result.json() as Promise<{
    user: { id: string; email: string; emailVerified: boolean };
  } | null>;
}

test("gift verification returns to redemption without signing in or allowing an external redirect", async () => {
  const email = "gift-recipient@auth.test";
  const credentials = {
    name: "Gift Recipient",
    email,
    password: "fixture-password",
    callbackURL: "/redeem",
  };
  const signup = await request("open", "/sign-up/email", credentials);
  expect(signup.status).toBe(200);
  expect(await session("open", signup)).toBeNull();
  const mail = await mf.dispatchFetch(
    `http://fixture/__fixture/email?to=${encodeURIComponent(email)}`,
  );
  const text = Schema.decodeUnknownSync(Schema.String)(await mail.json());
  const link = text.match(
    /http:\/\/fixture\/api\/auth\/verify-email\?[^\s]+/,
  )?.[0];
  expect(link).toBeDefined();
  expect(new URL(link!).searchParams.get("callbackURL")).toBe("/redeem");
  const verified = await mf.dispatchFetch(link!, { redirect: "manual" });
  expect(verified.status).toBe(302);
  expect(verified.headers.get("location")).toBe("/redeem");
  expect(await session("open", verified)).toBeNull();
  const login = await request("open", "/sign-in/email", credentials);
  expect(login.status).toBe(200);
  expect((await session("open", login))?.user).toMatchObject({
    email,
    emailVerified: true,
  });
  const unsafe = await request("open", "/sign-in/email", {
    ...credentials,
    callbackURL: "https://untrusted.test/redeem",
  });
  expect(unsafe.status).toBe(403);
  expect(unsafe.headers.get("location")).toBeNull();
});

test("open Google signup creates a verified account and later sign-ins reuse it even with signup closed", async () => {
  const email = "new-google@auth.test";
  const created = await google("open", email);
  expect(created.status).toBe(302);
  expect(created.headers.get("location")).toBe("http://fixture/");
  const first = await session("open", created);
  expect(first?.user).toMatchObject({ email, emailVerified: true });
  expect(first?.user.id).toBeTruthy();

  const again = await google("invite", email);
  expect(again.headers.get("location")).toBe("http://fixture/");
  expect((await session("invite", again))?.user.id).toBe(first!.user.id);
  const db = await mf.getD1Database("DB");
  expect(
    await db
      .prepare('SELECT count(*) AS count FROM "user" WHERE email = ?')
      .bind(email)
      .first<number>("count"),
  ).toBe(1);

  // Google-only accounts can acquire a password through the existing mailbox
  // proof, without creating a second user or losing Google access.
  expect(
    (await request("invite", "/request-password-reset", { email })).status,
  ).toBe(200);
  const reset = await db
    .prepare(
      "SELECT identifier FROM verification WHERE value = ? AND identifier LIKE 'reset-password:%'",
    )
    .bind(first!.user.id)
    .first<{ identifier: string }>();
  expect(reset).not.toBeNull();
  expect(
    (
      await request("invite", "/reset-password", {
        token: reset!.identifier.slice("reset-password:".length),
        newPassword: "new-fixture-password",
      })
    ).status,
  ).toBe(200);
  const passwordLogin = await request("invite", "/sign-in/email", {
    email,
    password: "new-fixture-password",
  });
  expect(passwordLogin.status).toBe(200);
  expect((await session("invite", passwordLogin))?.user.id).toBe(
    first!.user.id,
  );
  expect(
    (await session("invite", await google("invite", email)))?.user.id,
  ).toBe(first!.user.id);
});

test.each(["invite", "malformed"])(
  "%s signup refuses new Google users even with requestSignUp, while email invites still work",
  async (mode) => {
    const email = `${mode}@auth.test`;
    const refused = await google(mode, email, true);
    expect(
      new URL(refused.headers.get("location")!).searchParams.get("error"),
    ).toBe("signup_disabled");
    expect(await session(mode, refused)).toBeNull();
    const db = await mf.getD1Database("DB");
    expect(
      await db
        .prepare('SELECT count(*) AS count FROM "user" WHERE email = ?')
        .bind(email)
        .first<number>("count"),
    ).toBe(0);

    const signup = {
      email,
      name: "Invited Fixture",
      password: "fixture-password",
    };
    expect((await request(mode, "/sign-up/email", signup)).status).toBe(403);
    const invited = await request(mode, "/sign-up/email", {
      ...signup,
      inviteCode: "fixture-invite",
    });
    expect(invited.status).toBe(200);
    // SAFETY: Successful email signup includes token, which is null while verification is required.
    expect(
      ((await invited.json()) as { token: string | null }).token,
    ).toBeNull();
  },
);

test("Google links only verified matching password accounts, preserving their identity and password access", async () => {
  for (const verified of [false, true]) {
    const email = `password-${verified}@auth.test`;
    const signup = await request("open", "/sign-up/email", {
      email,
      name: "Password Fixture",
      password: "fixture-password",
    });
    expect(signup.status).toBe(200);
    // SAFETY: The successful Better Auth signup response includes the created user's id.
    const { user } = (await signup.json()) as { user: { id: string } };
    const db = await mf.getD1Database("DB");
    if (verified)
      await db
        .prepare('UPDATE "user" SET emailVerified = 1 WHERE id = ?')
        .bind(user.id)
        .run();

    const result = await google("invite", email);
    if (verified) {
      expect(result.headers.get("location")).toBe("http://fixture/");
      expect((await session("invite", result))?.user.id).toBe(user.id);
      const passwordLogin = await request("invite", "/sign-in/email", {
        email,
        password: "fixture-password",
      });
      expect(passwordLogin.status).toBe(200);
      expect((await session("invite", passwordLogin))?.user.id).toBe(user.id);
    } else {
      expect(
        new URL(result.headers.get("location")!).searchParams.get("error"),
      ).toBe("account_not_linked");
      expect(await session("invite", result)).toBeNull();
      expect(
        await db
          .prepare(
            "SELECT count(*) AS count FROM account WHERE userId = ? AND providerId = 'google'",
          )
          .bind(user.id)
          .first<number>("count"),
      ).toBe(0);
    }
    expect(
      await db
        .prepare('SELECT count(*) AS count FROM "user" WHERE email = ?')
        .bind(email)
        .first<number>("count"),
    ).toBe(1);
  }
});
