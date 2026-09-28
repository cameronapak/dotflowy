import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { accessToken, login } from "../src/auth.js";
import { credentialStore, type Credential } from "../src/credentials.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), "dotflowy-test-"));
  directories.push(path);
  return path;
};
const credential: Credential = {
  accessToken: "secret-access",
  refreshToken: "secret-refresh",
  clientId: "client",
  tokenEndpoint: "https://one.test/token",
  expiresAt: Date.now() + 100000,
};

test.skipIf(process.platform !== "linux")(
  "unavailable keyring never falls back to plaintext",
  async () => {
    const dir = await directory();
    const child = Bun.spawn(
      [
        "node",
        join(import.meta.dir, "../dist/main.js"),
        "login",
        "--no-browser",
      ],
      {
        env: {
          ...process.env,
          DOTFLOWY_TOKEN: undefined,
          DOTFLOWY_CONFIG_DIR: dir,
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-dotflowy-test-bus",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("OS credential store unavailable");
    expect(await readdir(dir)).toEqual([]);
  },
);

test("file opt-in saves privately, isolates servers, and logout removes only selected server", async () => {
  const dir = await directory();
  const one = credentialStore(dir, "https://one.test");
  const two = credentialStore(dir, "https://two.test");
  await Effect.runPromise(one.save(credential, true));
  expect(await Effect.runPromise(two.load())).toBeNull();
  await Effect.runPromise(
    two.save({ ...credential, accessToken: "second" }, true),
  );
  expect((await Effect.runPromise(one.load()))?.credential.accessToken).toBe(
    "secret-access",
  );
  if (process.platform !== "win32") {
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(dir))
      expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
  }
  await Effect.runPromise(one.remove());
  expect(await Effect.runPromise(one.load())).toBeNull();
  expect((await Effect.runPromise(two.load()))?.credential.accessToken).toBe(
    "second",
  );
});

test("environment credentials never touch the credential directory", async () => {
  const dir = await directory();
  expect(
    await Effect.runPromise(
      accessToken("https://one.test", dir, "environment"),
    ),
  ).toBe("environment");
  expect(await readdir(dir)).toEqual([]);
  await expect(
    Effect.runPromise(accessToken("https://one.test", dir, "")),
  ).rejects.toThrow("malformed");
});

test.skipIf(process.platform === "win32")(
  "refuses broad permissions and symlinked credential files",
  async () => {
    const dir = await directory();
    const store = credentialStore(dir, "https://one.test");
    await Effect.runPromise(store.save(credential, true));
    const [name] = await readdir(dir);
    if (!name) throw new Error("No credential file");
    const file = join(dir, name);
    await chmod(file, 0o644);
    await expect(Effect.runPromise(store.load())).rejects.toThrow(
      "Cannot read",
    );
    await rm(file);
    await symlink("/etc/passwd", file);
    await expect(Effect.runPromise(store.load())).rejects.toThrow(
      "Cannot read",
    );
  },
);

test("login exchanges PKCE code, saves tokens, refreshes, and closes callback listener", async () => {
  const dir = await directory();
  let authorization: URL | undefined;
  let redirect = "";
  let refreshCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const origin = new URL(request.url).origin;
      const path = new URL(request.url).pathname;
      if (path === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
        });
      if (path === "/register") {
        const body = await request.json();
        expect(body.token_endpoint_auth_method).toBe("none");
        redirect = body.redirect_uris[0];
        return Response.json({ client_id: "client" });
      }
      const form = new URLSearchParams(await request.text());
      if (form.get("grant_type") === "refresh_token") {
        refreshCount++;
        expect(form.get("refresh_token")).toBe("refresh1");
        return Response.json({
          access_token: "access2",
          refresh_token: "refresh2",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      expect(form.get("redirect_uri")).toBe(redirect);
      expect(form.get("code")).toBe("authorization-code");
      expect(
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url"),
      ).toBe(authorization?.searchParams.get("code_challenge") ?? "missing");
      return Response.json({
        access_token: "access1",
        refresh_token: "refresh1",
        token_type: "Bearer",
        expires_in: 1,
      });
    },
  });
  try {
    let callbackDone: Promise<Response> | undefined;
    await Effect.runPromise(
      login(
        server.url.origin,
        dir,
        true,
        (url) => {
          authorization = new URL(url);
          const callback = new URL(redirect);
          callback.search = new URLSearchParams({
            state: authorization.searchParams.get("state") ?? "",
            code: "authorization-code",
          }).toString();
          callbackDone = fetch(callback);
        },
        false,
      ),
    );
    expect((await callbackDone)?.status).toBe(200);
    expect(await Effect.runPromise(accessToken(server.url.origin, dir))).toBe(
      "access2",
    );
    expect(refreshCount).toBe(1);
    const saved = await Effect.runPromise(
      credentialStore(dir, server.url.origin).load(),
    );
    expect(saved?.credential.refreshToken).toBe("refresh2");
    await expect(fetch(redirect)).rejects.toThrow();
    const [name] = await readdir(dir);
    expect(name && (await readFile(join(dir, name), "utf8"))).not.toContain(
      "code_verifier",
    );
  } finally {
    server.stop(true);
  }
});

test("OAuth discovery refuses cross-origin endpoints before registration", async () => {
  const dir = await directory();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests++;
      return Response.json({
        issuer: new URL(request.url).origin,
        authorization_endpoint: "https://evil.test/authorize",
        token_endpoint: "https://evil.test/token",
        registration_endpoint: "https://evil.test/register",
      });
    },
  });
  try {
    await expect(
      Effect.runPromise(login(server.url.origin, dir, true, () => {}, false)),
    ).rejects.toThrow("selected server");
    expect(requests).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  } finally {
    server.stop(true);
  }
});
