import { build } from "esbuild";
import { Miniflare, Response as LocalResponse } from "miniflare";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

export async function startBackend() {
  // Do not inherit build-time Sentry uploads or application secrets from the orb.
  const buildEnv = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "AMP_ORB", "DOTFLOWY_HEAVY_LANE"].flatMap(
      (key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]!]],
    ),
  );
  execFileSync("bun", ["run", "build:cf"], { env: buildEnv, stdio: "inherit" });
  const directory = await mkdtemp(join(tmpdir(), "dotflowy-worker-browser-"));
  const scriptPath = join(directory, "worker.mjs");
  const key = randomUUID();
  let mf: Miniflare | undefined;
  try {
    await build({
      entryPoints: ["e2e/worker-browser/worker-entry.js"],
      outfile: scriptPath,
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd", "browser"],
      external: ["cloudflare:*", "node:*"],
      target: "es2022",
    });
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
    // SAFETY: listen above completed with a TCP port, not a Unix socket.
    const address = reservation.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((done, reject) =>
      reservation.close((error) => (error ? reject(error) : done())),
    );
    const outbound: string[] = [];
    mf = new Miniflare({
      host: "127.0.0.1",
      port: address.port,
      resourcePersistencePath: join(directory, "storage"),
      workers: [
        {
          config: {
            type: "worker",
            name: "worker-browser",
            compatibilityDate: "2026-06-23",
            compatibilityFlags: ["nodejs_compat"],
            manifest: {
              mainModule: "worker.mjs",
              modulesRoot: directory,
              modules: {
                "worker.mjs": {
                  type: "esm",
                  contents: await readFile(scriptPath),
                },
              },
            },
            assets: {
              directory: resolve("dist/client"),
              hasUserWorker: true,
              runWorkerFirst: true,
              notFoundHandling: "single-page-application",
            },
            env: {
              ASSETS: { type: "assets" },
              USER_OUTLINE: {
                type: "durable-object",
                worker: "worker-browser",
                exportName: "UserOutlineDO",
              },
              SHARD: {
                type: "durable-object",
                worker: "worker-browser",
                exportName: "ShardDO",
              },
              DB: { type: "d1", id: "worker-browser-db" },
              BACKUPS: { type: "r2", name: "worker-browser-backups" },
              BETTER_AUTH_SECRET: {
                type: "text",
                value: "disposable-worker-browser-secret-not-for-production",
              },
              BETTER_AUTH_URL: { type: "text", value: origin },
              SIGNUP_OPEN: { type: "text", value: "true" },
              OWNER_USER_ID: {
                type: "text",
                value: "no-owner-in-this-fixture",
              },
              FIXTURE_KEY: { type: "text", value: key },
            },
            exports: {
              UserOutlineDO: { type: "durable-object", storage: "sqlite" },
              ShardDO: { type: "durable-object", storage: "sqlite" },
            },
          },
          dev: {
            outboundService: {
              type: "fetcher",
              handler(request) {
                outbound.push(request.url);
                return new LocalResponse("External network disabled", {
                  status: 502,
                });
              },
            },
          },
        },
      ],
    });
    await mf.ready;
    const db = await mf.getD1Database("DB");
    for (const file of (await readdir("migrations"))
      .filter((file) => file.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(join("migrations", file), "utf8");
      await db.exec(sql.replace(/--[^\n]*/g, "").replaceAll("\n", " "));
    }
    const assets: Record<string, string> = {};
    for (const file of (
      await readdir("dist/client", { recursive: true })
    ).sort()) {
      const path = join("dist/client", file);
      if ((await stat(path)).isFile())
        assets[file] = hash(await readFile(path));
    }
    const provenance = {
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      trackedDiffSha256: hash(
        execFileSync("git", [
          "diff",
          "HEAD",
          "--",
          "src",
          "worker",
          "migrations",
          "public",
          "scripts",
          "package.json",
          "bun.lock",
          "vite.config.ts",
          ".env.production",
        ]),
      ),
      lockfileSha256: hash(await readFile("bun.lock")),
      recipe:
        "bun run build:cf (allowlisted environment, no Sentry token); esbuild test entry delegates to worker/index.ts",
      workerBundleSha256: hash(await readFile(scriptPath)),
      assets,
      runtime: {
        node: process.version,
        bun: execFileSync("bun", ["--version"], {
          encoding: "utf8",
          env: buildEnv,
        }).trim(),
        platform: process.platform,
        arch: process.arch,
      },
      browser: {
        name: "chromium",
        viewport: "1280x800@2",
        locale: "en-US",
        timezone: "America/Chicago",
      },
    };
    return {
      origin,
      db,
      provenance,
      outbound,
      async control(path: "inspect", userId: string) {
        const response = await fetch(`${origin}/__worker_browser/${path}`, {
          method: "POST",
          headers: { "x-fixture-key": key, "content-type": "application/json" },
          body: JSON.stringify({ userId }),
        });
        if (!response.ok)
          throw new Error(`Control ${path}: ${response.status}`);
        return response.json();
      },
      async dispose() {
        await mf!.dispose();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await mf?.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
