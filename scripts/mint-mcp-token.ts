/**
 * Mint a real Better Auth MCP OAuth bearer for the local dev account against a
 * running Worker — dynamic client registration + PKCE authorization code, the
 * same path `auth.api.getMcpSession` validates on `/mcp`.
 *
 * Localhost-only by construction (`API` is hardcoded). Use the printed bearer
 * with `Authorization: Bearer …` on `POST http://localhost:8787/mcp`.
 *
 * MCP tool calls also require a paid plan locally — run `bun run comp:dev-plan`
 * once per D1 reset before exercising writes.
 *
 * Requires `bun run cf:dev` and `bun run seed:user`.
 */
import { Schema } from "effect";

const API = "http://localhost:8787";
const AUTH = `${API}/api/auth`;
const EMAIL = "dev@dotflowy.local";
const PASSWORD = "dotflowy-dev";
const ORIGIN = "http://localhost:8787";
/** Loopback redirect the authorize step can target without a listener. */
const REDIRECT_URI = "http://127.0.0.1:8765/callback";

const SignInBody = Schema.Struct({
  user: Schema.Struct({ id: Schema.String }),
});
const RegisterBody = Schema.Struct({
  client_id: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
const TokenBody = Schema.Struct({
  access_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String),
});

function randomVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sessionCookie(res: Response): string {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

async function signIn(): Promise<{ cookie: string; userId: string }> {
  const res = await fetch(`${AUTH}/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
    },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `sign-in failed (${res.status}): ${text}. Run \`bun run seed:user\` first.`,
    );
  }
  const body = Schema.decodeUnknownSync(SignInBody)(await res.json());
  const userId = body.user?.id;
  if (!userId) throw new Error("sign-in succeeded but user id missing");
  return { cookie: sessionCookie(res), userId };
}

async function registerClient(cookie: string): Promise<string> {
  const res = await fetch(`${AUTH}/mcp/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: ORIGIN,
    },
    body: JSON.stringify({
      client_name: "local-mcp-dogfood",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  const body = Schema.decodeUnknownSync(RegisterBody)(await res.json());
  if (!res.ok || !body.client_id) {
    throw new Error(
      `client registration failed (${res.status}): ${JSON.stringify(body)}`,
    );
  }
  return body.client_id;
}

async function authorizeCode(
  cookie: string,
  clientId: string,
  challenge: string,
): Promise<string> {
  const url = new URL(`${AUTH}/mcp/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "openid");

  const res = await fetch(url, {
    redirect: "manual",
    headers: { cookie, origin: ORIGIN },
  });
  const location = res.headers.get("location");
  if (res.status !== 302 || !location) {
    throw new Error(
      `authorize failed (status ${res.status}, location ${location ?? "none"})`,
    );
  }
  const pending = new URL(location, API).searchParams.get("consent_code");
  if (!pending) throw new Error("authorize redirect missing consent request");
  const consent = await fetch(`${AUTH}/oauth2/consent`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ consent_code: pending, accept: true }),
  });
  const approved = Schema.decodeUnknownSync(
    Schema.Struct({
      redirectURI: Schema.optionalKey(Schema.String),
    }),
  )(await consent.json());
  if (!consent.ok || !approved.redirectURI)
    throw new Error(`consent failed (${consent.status})`);
  const code = new URL(approved.redirectURI).searchParams.get("code");
  if (!code) throw new Error(`authorize redirect missing code: ${location}`);
  return code;
}

async function exchangeToken(clientId: string, code: string, verifier: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  const res = await fetch(`${AUTH}/mcp/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
    },
    body,
  });
  const json = Schema.decodeUnknownSync(TokenBody)(await res.json());
  if (!res.ok || !json.access_token) {
    throw new Error(
      `token exchange failed (${res.status}): ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function main(): Promise<void> {
  try {
    await fetch(`${API}/api/auth/ok`);
  } catch {
    console.error(
      `Worker not reachable at ${API}. Run \`bun run cf:dev\` first.`,
    );
    process.exit(1);
  }

  const { cookie, userId } = await signIn();
  const clientId = await registerClient(cookie);
  const verifier = randomVerifier();
  const challenge = await pkceChallenge(verifier);
  const code = await authorizeCode(cookie, clientId, challenge);
  const token = await exchangeToken(clientId, code, verifier);

  console.log(`userId: ${userId}`);
  console.log(`clientId: ${clientId}`);
  console.log(`access_token: ${token.access_token}`);
  console.log(`expires_in: ${token.expires_in ?? "unknown"}s`);
  console.log("");
  console.log("Example: curl -s -X POST http://localhost:8787/mcp \\");
  console.log(`  -H 'authorization: Bearer ${token.access_token}' \\`);
  console.log("  -H 'content-type: application/json' \\");
  console.log(
    '  -d \'{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\'',
  );
}

await main();
