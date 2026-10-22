import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { login, accessToken } from "../src/auth.js";
import { commands } from "../src/commands.js";
import { credentialStore } from "../src/credentials.js";

// Explicit opt-in, loopback-only, and the seeded dev account only. Never production.
test.skipIf(process.env.DOTFLOWY_LIVE_TEST !== "1")(
  "real Worker: OAuth, every MCP tool, refresh, and logout",
  async () => {
    const server = "http://localhost:8787";
    const directory = await mkdtemp(join(tmpdir(), "dotflowy-live-"));
    const signIn = await fetch(`${server}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server },
      body: JSON.stringify({
        email: "dev@dotflowy.local",
        password: "dotflowy-dev",
      }),
    });
    expect(signIn.ok).toBe(true);
    const cookie = signIn.headers
      .getSetCookie()
      .map((s) => s.split(";")[0])
      .join("; ");
    const executable = resolve(import.meta.dir, "../dist/main.js");
    const run = async (args: string[]) => {
      const child = Bun.spawn(
        ["node", executable, "--server", server, "--json", ...args],
        {
          env: {
            ...process.env,
            DOTFLOWY_TOKEN: undefined,
            DOTFLOWY_CONFIG_DIR: directory,
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
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return JSON.parse(stdout);
    };
    const text = (result: { content: Array<{ text: string }> }) =>
      result.content.map((c) => c.text).join("\n");
    const nodeId = (value: string) => {
      const found = value.match(/(?:node id|mirror id|id): ([\w-]+)/)?.[1];
      if (!found) throw new Error("Expected a node ID in receipt");
      return found;
    };
    const cleanup: string[] = [];
    try {
      let browser: Promise<void> | undefined;
      await Effect.runPromise(
        login(
          server,
          directory,
          true,
          (url) => {
            browser = (async () => {
              const response = await fetch(url, {
                headers: { cookie, origin: server },
                redirect: "manual",
              });
              const location = response.headers.get("location");
              expect(response.status).toBe(302);
              if (!location) throw new Error("No OAuth callback");
              expect(new URL(location).hostname).toBe("127.0.0.1");
              expect((await fetch(location)).ok).toBe(true);
            })();
          },
          false,
        ),
      );
      await browser;
      const store = credentialStore(directory, server);
      const saved = await Effect.runPromise(store.load());
      expect(Boolean(saved?.credential.refreshToken)).toBe(true);
      if (!saved) throw new Error("No saved credential");
      await Effect.runPromise(
        store.save({ ...saved.credential, expiresAt: 1 }, true),
      );
      const refreshed = await Effect.runPromise(accessToken(server, directory));
      expect(refreshed === saved.credential.accessToken).toBe(false);

      const discovered = await run(["tools"]);
      expect(
        discovered.tools.map((t: { name: string }) => t.name).sort(),
      ).toEqual(
        Object.values(commands)
          .map((c) => c.tool)
          .sort(),
      );
      const marker = `CLI e2e ${crypto.randomUUID()}`;
      const root = nodeId(text(await run(["add", marker])));
      cleanup.push(root);
      const source = nodeId(
        text(
          await run(["add", "source ||private-spoiler||", "--parent", root]),
        ),
      );
      const outline = text(await run(["outline", root]));
      expect(outline).toContain("[spoiler]");
      expect(outline).not.toContain("private-spoiler");
      expect(text(await run(["search", marker]))).toContain(root);
      expect(
        text(await run(["update", source, "--completed", "--task"])),
      ).toContain("Updated");
      const mirror = nodeId(
        text(await run(["mirror", source, "--parent", root])),
      );
      expect(
        text(
          await run(["move", mirror, "--parent", root, "--position", "first"]),
        ),
      ).toContain("Moved");
      expect(
        text(
          await run([
            "subtree",
            "--args",
            JSON.stringify({
              parentId: root,
              nodes: [{ text: "nested", children: [{ text: "child" }] }],
            }),
          ]),
        ),
      ).toContain("child");
      const today = nodeId(
        text(await run(["today", marker, "--time-zone", "America/Chicago"])),
      );
      cleanup.push(today);
      const dailyMirror = nodeId(
        text(
          await run(["mirror-today", source, "--time-zone", "America/Chicago"]),
        ),
      );
      cleanup.push(dailyMirror);
      const opml =
        '<?xml version="1.0"?><opml version="2.0"><body><outline text="imported"/></body></opml>';
      expect(
        text(
          await run([
            "import-opml",
            "--args",
            JSON.stringify({ parentId: root, opml, dryRun: true }),
          ]),
        ),
      ).toContain("Nothing was written");
      expect(
        text(
          await run([
            "import-opml",
            "--args",
            JSON.stringify({ parentId: root, opml }),
          ]),
        ),
      ).toContain("Imported");
      const exported = text(await run(["export-opml", root]));
      expect(exported).toContain("<opml");
      expect(exported).not.toContain("private-spoiler");
      expect(
        text(
          await run([
            "call",
            "get_outline",
            "--args",
            JSON.stringify({ nodeId: root }),
          ]),
        ),
      ).toContain(marker);
      await run(["delete", dailyMirror, "--yes"]);
      cleanup.splice(cleanup.indexOf(dailyMirror), 1);
      await run(["delete", today, "--yes"]);
      cleanup.splice(cleanup.indexOf(today), 1);
      await run(["delete", root, "--yes"]);
      cleanup.splice(cleanup.indexOf(root), 1);
      expect((await run(["logout"])).localCredentialsRemoved).toBe(true);
      expect(await Effect.runPromise(store.load())).toBeNull();
    } finally {
      for (const id of cleanup.reverse())
        await run(["delete", id, "--yes"]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
