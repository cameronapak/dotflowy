import { Clock, Effect, Fiber, Schema } from "effect";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";

import { decode, fail, io } from "./core.js";
import { credentialStore, type Credential } from "./credentials.js";
import { requestJson } from "./http.js";

const exec = promisify(execFile);
const Metadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.String,
});
const Registration = Schema.Struct({ client_id: Schema.NonEmptyString });
const Token = Schema.Struct({
  access_token: Schema.NonEmptyString,
  token_type: Schema.String,
  expires_in: Schema.Number,
  refresh_token: Schema.optionalKey(Schema.NonEmptyString),
});

export function trustedEndpoint(value: string, server: string): string {
  const url = new URL(value);
  if (url.origin !== server || url.username || url.password || url.hash) {
    throw fail(
      "OAuth discovery points outside the selected server. Refusing to send credentials.",
    );
  }
  return url.href;
}
const endpoint = (value: string, server: string) =>
  Effect.try({
    try: () => trustedEndpoint(value, server),
    catch: () => fail("OAuth endpoint does not belong to the selected server."),
  });

export const discover = Effect.fn("OAuth.discover")(function* (server: string) {
  const data = yield* decode(
    Metadata,
    yield* requestJson(`${server}/.well-known/oauth-authorization-server`),
    "OAuth metadata",
  );
  yield* endpoint(data.issuer, server);
  return {
    authorize: yield* endpoint(data.authorization_endpoint, server),
    token: yield* endpoint(data.token_endpoint, server),
    register: yield* endpoint(data.registration_endpoint, server),
  };
});

export const exchange = Effect.fn("OAuth.exchange")(function* (
  tokenEndpoint: string,
  fields: Record<string, string>,
  clientId: string,
) {
  const data = yield* decode(
    Token,
    yield* requestJson(tokenEndpoint, {
      body: new URLSearchParams(fields).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
    "OAuth token response",
  );
  if (
    data.token_type.toLowerCase() !== "bearer" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  ) {
    return yield* Effect.fail(fail("Unsupported OAuth token response."));
  }
  const now = yield* Clock.currentTimeMillis;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + data.expires_in * 1000,
    clientId,
    tokenEndpoint,
  } satisfies Credential;
});

export function callbackCode(requestUrl: string, state: string): string | null {
  const url = new URL(requestUrl, "http://127.0.0.1");
  if (
    url.pathname !== "/callback" ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== state
  )
    return null;
  if (url.searchParams.has("error"))
    throw fail("OAuth authorization was denied.", 3);
  const codes = url.searchParams.getAll("code");
  return codes.length === 1 && codes[0] ? codes[0] : null;
}

const closeServer = (server: Server) =>
  Effect.sync(() => {
    server.closeAllConnections();
    server.close();
  });

export const login = Effect.fn("OAuth.login")(
  function* (
    server: string,
    directory: string,
    insecure: boolean,
    announce: (url: string) => void,
    openBrowser = true,
  ) {
    const store = credentialStore(directory, server);
    yield* store.check(insecure);
    const metadata = yield* discover(server);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const listener = yield* Effect.acquireRelease(
      Effect.sync(() => createServer()),
      closeServer,
    );
    yield* io(
      "Could not start OAuth callback listener.",
      () =>
        new Promise<void>((resolve, reject) => {
          listener.once("error", reject);
          listener.listen(0, "127.0.0.1", () => {
            listener.removeListener("error", reject);
            resolve();
          });
        }),
    );
    const address = listener.address();
    if (!address || typeof address === "string")
      return yield* Effect.fail(fail("No OAuth callback address."));
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const registered = yield* decode(
      Registration,
      yield* requestJson(metadata.register, {
        body: JSON.stringify({
          client_name: "Dotflowy CLI",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      }),
      "OAuth client registration",
    );
    const url = new URL(metadata.authorize);
    url.search = new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "openid offline_access",
    }).toString();

    const code = yield* Effect.callback<string, import("./core.js").CliError>(
      (resume) => {
        let completed = false;
        const handler: import("node:http").RequestListener = (
          request,
          response,
        ) => {
          response.setHeader("cache-control", "no-store");
          response.setHeader("content-type", "text/plain; charset=utf-8");
          if (completed || request.method !== "GET") {
            response.writeHead(400).end("Invalid callback.");
            return;
          }
          try {
            const value = callbackCode(request.url ?? "/", state);
            if (!value) {
              response.writeHead(400).end("Invalid callback.");
              return;
            }
            completed = true;
            response.end(
              "Authorization received. Return to your terminal to finish signing in.",
            );
            resume(Effect.succeed(value));
          } catch {
            completed = true;
            response.writeHead(400).end("Authorization denied.");
            resume(Effect.fail(fail("OAuth authorization was denied.", 3)));
          }
        };
        listener.on("request", handler);
        announce(url.href);
        return Effect.sync(() => listener.removeListener("request", handler));
      },
    ).pipe(
      // Listener is installed before the browser is opened, even for immediate callbacks.
      Effect.forkScoped,
    );
    if (openBrowser) {
      const command =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "rundll32.exe"
            : "xdg-open";
      const args =
        process.platform === "win32"
          ? ["url.dll,FileProtocolHandler", url.href]
          : [url.href];
      yield* io(
        "Could not open your browser. Open the printed URL manually.",
        (signal) => exec(command, args, { signal }),
      ).pipe(
        Effect.timeout("5 seconds"),
        Effect.catch(() => Effect.void),
      );
    }
    const authorizationCode = yield* Fiber.join(code);
    const credential = yield* exchange(
      metadata.token,
      {
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: redirectUri,
        client_id: registered.client_id,
        code_verifier: verifier,
      },
      registered.client_id,
    );
    yield* store.save(credential, insecure);
  },
  (effect) =>
    effect.pipe(
      Effect.timeout("5 minutes"),
      Effect.mapError((error) =>
        error._tag === "CliError"
          ? error
          : fail("Login timed out. Run dotflowy login again.", 3),
      ),
      Effect.scoped,
    ),
);

export const accessToken = Effect.fn("OAuth.accessToken")(function* (
  server: string,
  directory: string,
  environmentToken?: string,
) {
  if (environmentToken !== undefined) {
    if (!environmentToken.trim() || /\s/.test(environmentToken))
      return yield* Effect.fail(
        fail("DOTFLOWY_TOKEN is empty or malformed.", 3),
      );
    return environmentToken;
  }
  return yield* credentialStore(directory, server).transaction((store) =>
    Effect.gen(function* () {
      const saved = yield* store.load();
      if (!saved)
        return yield* Effect.fail(
          fail(
            "Not signed in. Run dotflowy login or supply DOTFLOWY_TOKEN.",
            3,
          ),
        );
      const now = yield* Clock.currentTimeMillis;
      if (
        saved.credential.expiresAt !== undefined &&
        saved.credential.expiresAt <= now + 30_000
      ) {
        if (!saved.credential.refreshToken)
          return yield* Effect.fail(
            fail("Login expired. Run dotflowy login.", 3),
          );
        const tokenEndpoint = yield* endpoint(
          saved.credential.tokenEndpoint,
          server,
        );
        const refreshed = yield* exchange(
          tokenEndpoint,
          {
            grant_type: "refresh_token",
            refresh_token: saved.credential.refreshToken,
            client_id: saved.credential.clientId,
          },
          saved.credential.clientId,
        );
        yield* store.save(
          {
            ...refreshed,
            refreshToken:
              refreshed.refreshToken ?? saved.credential.refreshToken,
          },
          saved.insecure,
        );
        return refreshed.accessToken;
      }
      return saved.credential.accessToken;
    }),
  );
});
