import { expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (cause?: unknown) => void;
}

const keyring = new Map<string, string>();
let pauseKeyringSet:
  | {
      server: string;
      entered: Deferred;
      release: Deferred;
    }
  | undefined;
let afterKeyringSet: { server: string; run: () => Promise<void> } | undefined;

mock.module("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    constructor(
      _service: string,
      private readonly server: string,
    ) {}

    async getPassword() {
      return keyring.get(this.server) ?? null;
    }

    async setPassword(value: string) {
      if (pauseKeyringSet?.server === this.server) {
        pauseKeyringSet.entered.resolve();
        await pauseKeyringSet.release.promise;
      }
      keyring.set(this.server, value);
      if (afterKeyringSet?.server === this.server) await afterKeyringSet.run();
    }

    async deletePassword() {
      return keyring.delete(this.server);
    }
  },
}));

const recordPath = (directory: string, server: string) =>
  join(directory, `${createHash("sha256").update(server).digest("hex")}.json`);

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

test("an interrupted credential write keeps the lock until the keyring settles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dotflowy-interrupt-"));
  const server = "https://interrupt.test";
  const store = credentialStore(dir, server);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  pauseKeyringSet = { server, entered, release };
  const controller = new AbortController();
  try {
    const save = Effect.runPromise(store.save(credential, false), {
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    const logout = Effect.runPromise(store.remove());
    expect(
      await Promise.race([
        logout.then(() => "finished"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("waiting"), 250),
        ),
      ]),
    ).toBe("waiting");
    release.resolve();
    await expect(save).rejects.toThrow();
    await logout;
    expect(keyring.has(server)).toBe(false);
    expect(await Effect.runPromise(store.load())).toBeNull();
  } finally {
    release.resolve();
    pauseKeyringSet = undefined;
    keyring.delete(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed keyring metadata finalization preserves file credentials for cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dotflowy-keyring-intent-"));
  const server = "https://keyring-intent.test";
  const store = credentialStore(dir, server);
  const path = recordPath(dir, server);
  const intent = `${path}.intent`;
  try {
    await Effect.runPromise(store.save(credential, true));
    afterKeyringSet = {
      server,
      run: async () => {
        await rename(path, intent);
        await mkdir(path);
      },
    };
    await expect(
      Effect.runPromise(
        store.save({ ...credential, accessToken: "replacement" }, false),
      ),
    ).rejects.toThrow("Cannot save credential configuration");
    afterKeyringSet = undefined;
    await rm(path, { recursive: true });
    await rename(intent, path);
    expect(keyring.has(server)).toBe(true);
    const preserved = await Effect.runPromise(store.load());
    expect(preserved?.insecure).toBe(true);
    expect(preserved?.credential.accessToken).toBe("old");
    await Effect.runPromise(store.remove());
    expect(keyring.has(server)).toBe(false);
    expect(await Effect.runPromise(store.load())).toBeNull();
  } finally {
    afterKeyringSet = undefined;
    keyring.delete(server);
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
    const path = recordPath(dir, server);
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
