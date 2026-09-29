import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { credentialStore } from "../src/credentials.js";

const credentialsModule = new URL("../dist/credentials.js", import.meta.url)
  .href;
const authModule = new URL("../dist/auth.js", import.meta.url).href;
const credential = {
  accessToken: "old",
  refreshToken: "refresh",
  clientId: "client",
  tokenEndpoint: "https://example.test/token",
  expiresAt: 1,
};

test("credential locks are released on failure and interruption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dotflowy-lock-"));
  const store = credentialStore(dir, "https://example.test");
  try {
    await expect(
      Effect.runPromise(store.transaction(() => Effect.fail("failure"))),
    ).rejects.toThrow();
    const entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    const interrupted = Effect.runPromise(
      store.transaction(() =>
        Effect.gen(function* () {
          entered.resolve();
          yield* Effect.never;
        }),
      ),
      { signal: controller.signal },
    );
    await entered.promise;
    controller.abort();
    await expect(interrupted).rejects.toThrow();
    await Effect.runPromise(store.save(credential, true));
    expect(
      (await Effect.runPromise(store.load()))?.credential.accessToken,
    ).toBe("old");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const action of ["logout", "replace"] as const) {
  test(`a delayed refresh cannot undo ${action} in another process`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "dotflowy-race-"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        entered.resolve();
        await release.promise;
        return Response.json({
          access_token: "refreshed",
          refresh_token: "refresh2",
          token_type: "Bearer",
          expires_in: 3600,
        });
      },
    });
    const origin = server.url.origin;
    const store = credentialStore(dir, origin);
    const spawn = (source: string) =>
      Bun.spawn(["node", "--input-type=module", "-e", source, dir, origin], {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
    try {
      await Effect.runPromise(
        store.save({ ...credential, tokenEndpoint: `${origin}/token` }, true),
      );
      const refresh = spawn(
        `import { Effect } from 'effect'; import { accessToken } from ${JSON.stringify(authModule)}; await Effect.runPromise(accessToken(process.argv[2], process.argv[1]));`,
      );
      await entered.promise;
      const mutation = spawn(
        `import { Effect } from 'effect'; import { credentialStore } from ${JSON.stringify(credentialsModule)}; const store = credentialStore(process.argv[1], process.argv[2]); console.log('started'); await Effect.runPromise(${action === "logout" ? "store.remove()" : `store.save(${JSON.stringify({ ...credential, accessToken: "new-account", expiresAt: Date.now() + 3600000 })}, true)`});`,
      );
      const reader = mutation.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "started",
      );
      reader.releaseLock();
      // A bounded non-completion assertion exercises real interprocess contention.
      expect(
        await Promise.race([
          mutation.exited.then(() => "finished"),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("waiting"), 250),
          ),
        ]),
      ).toBe("waiting");
      release.resolve();
      expect(await refresh.exited).toBe(0);
      expect(await mutation.exited).toBe(0);
      expect(await new Response(refresh.stderr).text()).toBe("");
      expect(await new Response(mutation.stderr).text()).toBe("");
      const saved = await Effect.runPromise(store.load());
      if (action === "logout") expect(saved).toBeNull();
      else expect(saved?.credential.accessToken).toBe("new-account");
    } finally {
      release.resolve();
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  }, 10000);
}

test.skipIf(process.platform !== "linux")(
  "explicit file login survives unavailable old keyring and records cleanup",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "dotflowy-transition-"));
    const server = "https://example.test";
    const path = join(
      dir,
      `${createHash("sha256").update(server).digest("hex")}.json`,
    );
    try {
      await writeFile(path, JSON.stringify({ server, storage: "keyring" }), {
        mode: 0o600,
      });
      const child = Bun.spawn(
        [
          "node",
          "--input-type=module",
          "-e",
          `import { Effect } from 'effect'; import { credentialStore } from ${JSON.stringify(credentialsModule)}; await Effect.runPromise(credentialStore(process.argv[1], process.argv[2]).save(${JSON.stringify(credential)}, true));`,
          dir,
          server,
        ],
        {
          cwd: join(import.meta.dir, ".."),
          env: {
            ...process.env,
            DBUS_SESSION_BUS_ADDRESS:
              "unix:path=/nonexistent-dotflowy-test-bus",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toContain(
        "Cleanup is pending",
      );
      const record = JSON.parse(await readFile(path, "utf8"));
      expect(record.storage).toBe("file");
      expect(record.pendingKeyringCleanup).toBe(true);
      expect(
        (await Effect.runPromise(credentialStore(dir, server).load()))
          ?.credential.accessToken,
      ).toBe("old");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
