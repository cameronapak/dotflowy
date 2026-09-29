import { Effect, Schema, Schedule } from "effect";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { decode, fail, io, parseJson } from "./core.js";

const exec = promisify(execFile);
export const Credential = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  refreshToken: Schema.optionalKey(Schema.NonEmptyString),
  expiresAt: Schema.optionalKey(Schema.Number),
  clientId: Schema.NonEmptyString,
  tokenEndpoint: Schema.String,
});
export type Credential = typeof Credential.Type;
const Record = Schema.Struct({
  server: Schema.String,
  storage: Schema.Literals(["keyring", "file"]),
  credential: Schema.optionalKey(Credential),
  pendingKeyringCleanup: Schema.optionalKey(Schema.Boolean),
});
type Record = typeof Record.Type;

const secureMessage =
  "OS credential store unavailable. Unlock/configure it, supply DOTFLOWY_TOKEN, or explicitly use login --insecure-storage.";
const entry = (server: string) =>
  io(secureMessage, async () => {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry("dotflowy", server, {
      linux: { store: "secret-service" },
    });
  });

const pathFor = (directory: string, server: string) =>
  join(directory, `${createHash("sha256").update(server).digest("hex")}.json`);

const missing = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

// The native bridge is deliberately small; sequencing and failures stay in Effect.
const readRecord = Effect.fn("Credentials.readRecord")(function* (
  directory: string,
  server: string,
) {
  const text = yield* io("Cannot read credential configuration.", async () => {
    const path = pathFor(directory, server);
    try {
      const handle = await fs.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.size > 64 * 1024 ||
          (process.platform !== "win32" &&
            ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
        ) {
          throw new Error("Unsafe credential file");
        }
        return await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  });
  if (text === null) return null;
  const record = yield* decode(
    Record,
    yield* parseJson(text),
    "credential configuration",
  );
  if (record.server !== server)
    return yield* Effect.fail(fail("Credential server mismatch."));
  return record;
});

const prepareDirectory = (directory: string) =>
  Effect.gen(function* () {
    const message = "Cannot create a private credential directory.";
    yield* io(
      message,
      () => fs.mkdir(directory, { recursive: true, mode: 0o700 }),
      "mkdir",
    );
    const stat = yield* io(message, () => fs.lstat(directory), "lstat");
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return yield* Effect.fail(fail(`${message} [lstat: unsafe directory]`));
    if (process.platform === "win32") {
      // Replace, rather than merge, the DACL so pre-existing explicit grants cannot survive.
      // The path travels as data, never interpolated into PowerShell source.
      yield* io(
        message,
        () =>
          exec(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              [
                "$ErrorActionPreference = 'Stop'",
                "try { $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { exit 11 }",
                "try { $acl = [System.IO.Directory]::GetAccessControl($env:DOTFLOWY_CREDENTIAL_DIRECTORY, [System.Security.AccessControl.AccessControlSections]::Access) } catch { exit 12 }",
                // Replace only the DACL. Keeping the existing descriptor preserves its owner.
                'try { $acl.SetSecurityDescriptorSddlForm("D:P(A;OICI;FA;;;$sid)", [System.Security.AccessControl.AccessControlSections]::Access) } catch { exit 13 }',
                "try { [System.IO.Directory]::SetAccessControl($env:DOTFLOWY_CREDENTIAL_DIRECTORY, $acl) } catch { exit 14 }",
              ].join("; "),
            ],
            {
              env: {
                ...process.env,
                DOTFLOWY_CREDENTIAL_DIRECTORY: resolve(directory),
              },
            },
          ),
        "windows-acl",
      );
    } else {
      if (stat.uid !== process.getuid?.())
        return yield* Effect.fail(fail(`${message} [lstat: wrong owner]`));
      yield* io(message, () => fs.chmod(directory, 0o700), "chmod");
    }
  });

const writeRecord = Effect.fn("Credentials.writeRecord")(function* (
  directory: string,
  server: string,
  record: Record,
) {
  yield* prepareDirectory(directory);
  yield* io("Cannot save credential configuration.", async () => {
    const path = pathFor(directory, server);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(record), {
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, path);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  });
});

const unlockedStore = (directory: string, server: string) => ({
  check: (insecure: boolean) =>
    Effect.gen(function* () {
      yield* prepareDirectory(directory);
      if (!insecure) {
        const key = yield* entry(server);
        yield* io(secureMessage, () => key.getPassword());
      }
    }),
  load: () =>
    Effect.gen(function* () {
      const record = yield* readRecord(directory, server);
      if (!record) return null;
      if (record.storage === "file") {
        if (!record.credential)
          return yield* Effect.fail(
            fail("Missing file credential. Run dotflowy login.", 3),
          );
        return { credential: record.credential, insecure: true };
      }
      const key = yield* entry(server);
      const text = yield* io(secureMessage, () => key.getPassword());
      if (!text)
        return yield* Effect.fail(
          fail("Saved credential not found. Run dotflowy login.", 3),
        );
      return {
        credential: yield* decode(
          Credential,
          yield* parseJson(text),
          "saved credential",
        ),
        insecure: false,
      };
    }),
  save: (credential: Credential, insecure: boolean) =>
    Effect.gen(function* () {
      const previous = yield* readRecord(directory, server);
      if (insecure) {
        const pending =
          previous?.storage === "keyring" ||
          previous?.pendingKeyringCleanup === true;
        yield* writeRecord(directory, server, {
          server,
          storage: "file",
          credential,
          pendingKeyringCleanup: pending,
        });
        if (pending) {
          const removed = yield* Effect.gen(function* () {
            const key = yield* entry(server);
            yield* io(secureMessage, () => key.deletePassword());
            return true;
          }).pipe(Effect.catch(() => Effect.succeed(false)));
          if (removed)
            yield* writeRecord(directory, server, {
              server,
              storage: "file",
              credential,
            });
          else
            yield* Effect.sync(() =>
              console.error(
                "Warning: file credentials saved, but the old OS keyring entry could not be removed. Cleanup is pending; unlock the keyring and run logout to remove both.",
              ),
            );
        }
      } else {
        const key = yield* entry(server);
        yield* io(secureMessage, () =>
          key.setPassword(JSON.stringify(credential)),
        );
        yield* writeRecord(directory, server, { server, storage: "keyring" });
      }
    }),
  remove: () =>
    Effect.gen(function* () {
      const record = yield* readRecord(directory, server);
      if (record?.storage === "keyring" || record?.pendingKeyringCleanup) {
        const key = yield* entry(server);
        yield* io(secureMessage, () => key.deletePassword());
      }
      yield* io("Cannot remove credential configuration.", () =>
        fs.rm(pathFor(directory, server), { force: true }),
      );
    }),
});

// An atomic per-server directory coordinates independent CLI processes. Never
// steal an old lock: a paused process may still hold a live refresh operation.
export const credentialStore = (directory: string, server: string) => {
  const store = unlockedStore(directory, server);
  const transaction = <A, E, R>(
    run: (store: ReturnType<typeof unlockedStore>) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      yield* prepareDirectory(directory);
      const lock = `${pathFor(directory, server)}.lock`;
      yield* Effect.acquireRelease(
        io(
          `Credential lock unavailable: ${lock}. If no Dotflowy processes are running, remove this lock directory and try again.`,
          () => fs.mkdir(lock, { mode: 0o700 }),
        ).pipe(
          Effect.retry({ times: 300, schedule: Schedule.spaced("100 millis") }),
        ),
        () =>
          io("Cannot release credential lock.", () => fs.rmdir(lock)).pipe(
            Effect.orDie,
          ),
      );
      return yield* run(store);
    }).pipe(Effect.scoped);
  return {
    check: store.check,
    load: () => transaction((store) => store.load()),
    save: (credential: Credential, insecure: boolean) =>
      transaction((store) => store.save(credential, insecure)),
    remove: () => transaction((store) => store.remove()),
    transaction,
  };
};
