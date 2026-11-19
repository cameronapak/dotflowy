/// <reference types="@cloudflare/workers-types" />
import { mcp } from "@better-auth/mcp";
import {
  getOAuthProviderApi,
  verifyOAuthQueryParams,
} from "@better-auth/oauth-provider";
import { createAuthEndpoint, isAPIError } from "better-auth/api";
import { Schema } from "effect";

import type { Auth } from "./auth";

import { grantEpoch, readMcpConsent } from "./mcp-oauth";

export async function hashOAuthToken(token: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function mcpProvider(resource: string) {
  const options = {
    resource,
    loginPage: "/",
    consentPage: "/mcp-consent",
    disableJwtPlugin: true,
    refreshTokenReuseInterval: 0,
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultApplicationType: "infer",
    grantTypes: ["authorization_code", "refresh_token"],
    scopes: ["openid", "profile", "email", "offline_access"],
    clientRegistrationDefaultScopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
    ],
    storeTokens: { hash: hashOAuthToken },
  } satisfies Parameters<typeof mcp>[0];
  const provider = mcp(options);
  return {
    ...provider,
    endpoints: {
      ...provider.endpoints,
      getMcpSession: createAuthEndpoint(
        "/mcp/get-session",
        { method: "GET" },
        async (ctx) => {
          const match = ctx.headers
            ?.get("authorization")
            ?.match(/^Bearer ([^\s]+)$/i);
          if (!match) return null;
          try {
            const payload = await getOAuthProviderApi(
              ctx,
              options,
            ).requireActiveAccessToken(match[1]!);
            const audiences = Array.isArray(payload.aud)
              ? payload.aud
              : [payload.aud];
            if (!payload.sub || payload.cnf || !audiences.includes(resource))
              return null;
            return { userId: payload.sub };
          } catch (error) {
            if (isAPIError(error) && error.statusCode === 401) return null;
            throw error;
          }
        },
      ),
    },
  };
}

const oauthError = (error: string, status = 401) =>
  Response.json(
    { error },
    { status, headers: { "cache-control": "no-store" } },
  );
const ConsentBody = Schema.Struct({
  consent_code: Schema.String,
  accept: Schema.Boolean,
});
const ProviderRedirect = Schema.Struct({ url: Schema.String });
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
});
const CodeValue = Schema.Struct({
  userId: Schema.String,
  query: Schema.Struct({ client_id: Schema.String }),
  mcpEpoch: Schema.Number,
});

/** The provider owns OAuth; this boundary preserves public paths and D1 revocation ordering. */
export async function handleMcpAuthRequest(
  auth: Auth,
  request: Request,
  db: D1Database,
) {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(
    /^\/api\/auth\/mcp\/(authorize|token|register)$/,
    "/api/auth/oauth2/$1",
  );
  const path = url.pathname;
  if (!path.startsWith("/api/auth/oauth2/")) return auth.handler(request);
  const session = () => auth.api.getSession({ headers: request.headers });
  const context = await auth.$context;
  const secret = context.secret;
  const resource = `${new URL(context.baseURL).origin}/mcp`;
  const normalizeResources = (params: URLSearchParams) => {
    const accepted = [
      new URL(resource).origin,
      resource,
      `${new URL(resource).origin}/api/mcp`,
    ];
    if (params.getAll("resource").some((value) => !accepted.includes(value)))
      return false;
    params.set("resource", resource);
    return true;
  };
  if (path === "/api/auth/oauth2/authorize") {
    if (!normalizeResources(url.searchParams))
      return oauthError("invalid_target", 400);
    url.searchParams.set("prompt", "consent");
    const response = await auth.handler(new Request(url, request));
    const location = response.headers.get("location");
    if (!location) return response;
    const target = new URL(location, resource);
    if (
      target.pathname !== "/mcp-consent" ||
      target.origin !== new URL(resource).origin
    )
      return response;
    const identity = await session();
    if (
      !identity ||
      !(await verifyOAuthQueryParams(target.search.slice(1), secret))
    )
      return oauthError("invalid_request");
    const clientId = target.searchParams.get("client_id");
    const redirectURI = target.searchParams.get("redirect_uri");
    if (!clientId || !redirectURI) return oauthError("invalid_request");
    const code = crypto.randomUUID();
    const now = new Date().toISOString();
    const value = {
      userId: identity.user.id,
      clientId,
      redirectURI,
      requireConsent: true,
      scope: (target.searchParams.get("scope") ?? "")
        .split(" ")
        .filter(Boolean),
      state: target.searchParams.get("state"),
      oauthQuery: target.search.slice(1),
      epoch: await grantEpoch(db, identity.user.id, clientId),
    };
    await db
      .prepare(
        "INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        code,
        JSON.stringify(value),
        new Date(Date.now() + 600_000).toISOString(),
        now,
        now,
      )
      .run();
    target.search = new URLSearchParams({ consent_code: code }).toString();
    const headers = new Headers(response.headers);
    headers.set("location", target.toString());
    headers.set("cache-control", "no-store");
    return new Response(null, { status: response.status, headers });
  }
  if (path === "/api/auth/oauth2/consent") {
    if (
      request.method !== "POST" ||
      request.headers.get("origin") !== new URL(resource).origin
    )
      return oauthError("invalid_origin", 403);
    const body = Schema.decodeUnknownResult(ConsentBody)(
      await request.json().catch(() => null),
    );
    const identity = await session();
    if (body._tag === "Failure" || !identity)
      return oauthError("invalid_request", 403);
    const consent = await readMcpConsent(
      db,
      identity.user.id,
      body.success.consent_code,
    );
    if (!consent) return oauthError("invalid_request", 403);
    const consumed = await db
      .prepare(
        "DELETE FROM verification WHERE identifier = ? AND json_extract(value, '$.userId') = ? RETURNING id",
      )
      .bind(body.success.consent_code, identity.user.id)
      .first();
    if (!consumed) return oauthError("invalid_request", 403);
    const response = await auth.handler(
      new Request(url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({
          accept: body.success.accept,
          oauth_query: consent.oauthQuery,
        }),
      }),
    );
    if (!response.ok) return response;
    const redirect = Schema.decodeUnknownResult(ProviderRedirect)(
      await response.json(),
    );
    if (redirect._tag === "Failure") return oauthError("invalid_request");
    const target = new URL(redirect.success.url, url);
    const code = target.searchParams.get("code");
    const identifier = code ? await hashOAuthToken(code) : "";
    const currentEpoch = await grantEpoch(
      db,
      identity.user.id,
      consent.clientId,
    );
    const updated =
      code && currentEpoch === consent.epoch
        ? await db
            .prepare(
              "UPDATE verification SET value = json_set(value, '$.mcpEpoch', ?) WHERE identifier = ? AND EXISTS (SELECT 1 FROM mcpGrant WHERE userId = ? AND clientId = ? AND epoch = ?)",
            )
            .bind(
              consent.epoch,
              identifier,
              identity.user.id,
              consent.clientId,
              consent.epoch,
            )
            .run()
        : null;
    if (body.success.accept && (!code || updated?.meta.changes !== 1)) {
      await db.batch([
        db
          .prepare("DELETE FROM verification WHERE identifier = ?")
          .bind(identifier),
        db
          .prepare("DELETE FROM oauthConsent WHERE userId = ? AND clientId = ?")
          .bind(identity.user.id, consent.clientId),
      ]);
      return oauthError("invalid_grant", 403);
    }
    return Response.json(
      { redirectURI: target.toString() },
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (path === "/api/auth/oauth2/token" && request.method === "POST") {
    if (
      !request.headers
        .get("content-type")
        ?.startsWith("application/x-www-form-urlencoded")
    )
      return oauthError("invalid_request", 400);
    const params = new URLSearchParams(await request.text());
    if (!normalizeResources(params)) return oauthError("invalid_target", 400);
    const isRefresh = params.get("grant_type") === "refresh_token";
    const credential = params.get(isRefresh ? "refresh_token" : "code");
    if (!credential) return oauthError("invalid_grant");
    let userId: string;
    let clientId: string;
    let epoch: number;
    let refreshId: string | null = null;
    if (isRefresh) {
      const row = await db
        .prepare(
          "SELECT id, userId, clientId FROM oauthRefreshToken WHERE token = ?",
        )
        .bind(await hashOAuthToken(credential))
        .first<{ id: string; userId: string; clientId: string }>();
      if (!row) return oauthError("invalid_grant");
      ({ userId, clientId } = row);
      refreshId = row.id;
      epoch = await grantEpoch(db, userId, clientId);
    } else {
      const row = await db
        .prepare("SELECT value FROM verification WHERE identifier = ?")
        .bind(await hashOAuthToken(credential))
        .first<{ value: string }>();
      const parsed = Schema.decodeUnknownResult(
        Schema.fromJsonString(CodeValue),
      )(row?.value);
      if (parsed._tag === "Failure") {
        if (!row)
          await auth.handler(
            new Request(url, {
              method: "POST",
              headers: request.headers,
              body: params.toString(),
            }),
          );
        return oauthError("invalid_grant");
      }
      userId = parsed.success.userId;
      clientId = parsed.success.query.client_id;
      epoch = parsed.success.mcpEpoch;
    }
    const response = await auth.handler(
      new Request(url, {
        method: "POST",
        headers: request.headers,
        body: params.toString(),
      }),
    );
    if (!response.ok) return response;
    const parsed = Schema.decodeUnknownResult(TokenResponse)(
      await response.clone().json(),
    );
    if (parsed._tag === "Failure") return oauthError("invalid_grant");
    const accessHash = await hashOAuthToken(parsed.success.access_token);
    const refreshHash = parsed.success.refresh_token
      ? await hashOAuthToken(parsed.success.refresh_token)
      : "";
    if (refreshId)
      await db
        .prepare("DELETE FROM oauthAccessToken WHERE refreshId = ?")
        .bind(refreshId)
        .run();
    const valid = await db
      .prepare(`SELECT 1 FROM mcpGrant g WHERE g.userId = ? AND g.clientId = ? AND g.epoch = ?
      AND EXISTS (SELECT 1 FROM oauthConsent c WHERE c.userId = g.userId AND c.clientId = g.clientId)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM oauthRefreshToken WHERE id = ? AND revoked IS NOT NULL))`)
      .bind(userId, clientId, epoch, refreshId, refreshId)
      .first();
    if (!valid) {
      await db.batch([
        db
          .prepare("DELETE FROM oauthAccessToken WHERE token = ?")
          .bind(accessHash),
        db
          .prepare("DELETE FROM oauthRefreshToken WHERE token = ?")
          .bind(refreshHash),
      ]);
      return oauthError("invalid_grant");
    }
    return response;
  }
  return auth.handler(new Request(url, request));
}
