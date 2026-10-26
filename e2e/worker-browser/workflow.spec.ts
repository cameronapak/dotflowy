import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

import type { OutlineSnapshot } from "../../worker/backup";

import { createNode } from "../../src/data/tree";
import { placeCaret } from "../fixtures";
import { startBackend } from "./backend";

let backend: Awaited<ReturnType<typeof startBackend>>;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  backend = await startBackend();
});
test.afterAll(async () => {
  await backend?.dispose();
});

// The contentEditable rows have no accessible name; address the stable node ID.
const editor = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

test("acknowledged splits survive missing echoes, resync, peer edits and reload", async ({
  page,
  context,
}, info) => {
  const { origin } = backend;
  const password = "disposable-browser-password";
  const email = "persistence@worker-browser.test";
  const signup = await context.request.post(
    `${origin}/api/auth/sign-up/email`,
    {
      headers: { origin },
      data: { email, name: "Persistence test", password },
    },
  );
  expect(signup.status()).toBe(200);
  const { user } = await signup.json();
  // Only mailbox verification is fixture setup. Sessions and writes use real auth.
  await backend.db
    .prepare('UPDATE "user" SET emailVerified=1 WHERE id=?')
    .bind(user.id)
    .run();
  const signIn = await context.request.post(
    `${origin}/api/auth/sign-in/email`,
    {
      headers: { origin },
      data: { email, password },
    },
  );
  expect(signIn.status()).toBe(200);
  const seeded = await context.request.post(`${origin}/api/nodes`, {
    data: {
      nodes: [
        createNode({ id: "a", text: "ABCDEF" }),
        createNode({
          id: "rapid",
          text: "Before **guide** after",
          prevSiblingId: "a",
        }),
        createNode({
          id: "sentinel",
          text: "Peer sentinel",
          prevSiblingId: "rapid",
        }),
      ],
    },
  });
  expect(seeded.status()).toBe(200);
  const inspect = async (): Promise<OutlineSnapshot> =>
    backend.control("inspect", user.id);
  const protocol: unknown[] = [];
  let dropChanges = false;
  let recoveryHeld = false;
  let recoverySnapshots = 0;
  let deliveredSnapshots = 0;
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  // All frames originate in the real Worker. Only this client's delivery is held.
  await page.routeWebSocket("**/api/sync", (socket) => {
    const server = socket.connectToServer();
    server.onMessage(async (raw) => {
      const frame = JSON.parse(String(raw));
      protocol.push(frame);
      if (
        dropChanges &&
        frame.type === "change" &&
        !frame.ops.every(
          (op: { value?: { id: string } }) => op.value?.id === "sentinel",
        )
      )
        return;
      if (dropChanges && frame.type === "snapshot") {
        recoveryHeld = true;
        recoverySnapshots++;
        await snapshotGate;
      }
      socket.send(raw);
      if (dropChanges && frame.type === "snapshot") deliveredSnapshots++;
    });
  });
  try {
    await page.goto(origin);
    await expect(editor(page, "a")).toHaveText("ABCDEF");
    const peer = await context.newPage();
    await peer.goto(origin);
    await expect(editor(peer, "a")).toHaveText("ABCDEF");
    dropChanges = true;
    await placeCaret(editor(page, "a"), 3);
    const acknowledgement = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/nodes") &&
        response.request().method() === "POST",
    );
    await page.keyboard.press("Enter");
    expect((await acknowledgement).status()).toBe(200);
    const acknowledgedAt = Date.now();
    const split = (await inspect()).nodes.find((node) => node.text === "DEF")!;
    expect(split.prevSiblingId).toBe("a");
    await expect(editor(peer, "a")).toHaveText("ABC");
    await expect(editor(peer, split.id)).toHaveText("DEF");

    // Cross the actual eight-second deadline, with both echo and recovery held.
    await expect
      .poll(() => Date.now() - acknowledgedAt, { timeout: 12_000 })
      .toBeGreaterThan(9_000);
    console.log("After echo deadline", {
      origin: await editor(page, "a").textContent(),
      stored: (await inspect()).nodes
        .filter((node) => ["a", split.id].includes(node.id))
        .map((node) => node.text),
      recoveryHeld,
    });
    await expect(editor(page, "a")).toHaveText("ABC");
    await expect(editor(page, split.id)).toHaveText("DEF");
    await expect.poll(() => recoveryHeld).toBe(true);

    // The held snapshot predates this next acknowledged split. It must not
    // release this newer overlay just because it is a full snapshot.
    await placeCaret(editor(page, split.id), 1);
    const nextAck = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/nodes") &&
        response.request().method() === "POST",
    );
    await page.keyboard.press("Enter");
    expect((await nextAck).status()).toBe(200);
    const newer = (await inspect()).nodes.find((node) => node.text === "EF")!;
    await expect(editor(page, newer.id)).toHaveText("EF");
    await page.evaluate((id) => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector(`li[data-node-id="${id}"]`)) {
          document.documentElement.dataset.lostAcknowledgedSplit = "true";
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }, newer.id);
    releaseSnapshot();
    await expect.poll(() => deliveredSnapshots).toBeGreaterThanOrEqual(1);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    // The snapshot covers the first split, not the second. Deliver an unrelated
    // later delta across that hole: its higher sequence must not release the
    // unobserved split. Recovery must fetch the missing state instead.
    await placeCaret(editor(peer, "sentinel"), "end");
    await peer.keyboard.type("!");
    await expect
      .poll(() => recoverySnapshots, { timeout: 12_000 })
      .toBeGreaterThanOrEqual(2);
    await expect(editor(page, split.id)).toHaveText("D");
    await expect(editor(page, newer.id)).toHaveText("EF");
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-lost-acknowledged-split",
      "true",
    );
    dropChanges = false;

    // A later peer update must become visible: an overlay retained forever is wrong too.
    await placeCaret(editor(peer, split.id), "end");
    await peer.keyboard.type("-peer");
    await editor(page, "rapid").click();
    await expect(editor(page, split.id)).toHaveText("D-peer");

    // No readiness/focus waits between these native edits. Field generations
    // must not cross either structural boundary or overtake their insert.
    await placeCaret(editor(page, "rapid"), "end");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await page.keyboard.type("X");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Y");
    await expect
      .poll(async () => {
        const nodes = (await inspect()).nodes;
        const first = nodes.find((node) => node.prevSiblingId === "rapid");
        const second = nodes.find((node) => node.prevSiblingId === first?.id);
        return [
          nodes.find((node) => node.id === "rapid")?.text,
          first?.text,
          second?.text,
        ];
      })
      .toEqual(["Before **guide** ", "X", "Yafter"]);
    const committed = await inspect();
    for (const node of committed.nodes)
      await expect(editor(peer, node.id)).toHaveText(
        node.text.replaceAll("**", ""),
      );
    await page.reload();
    for (const node of committed.nodes)
      await expect(editor(page, node.id)).toHaveText(
        node.text.replaceAll("**", ""),
      );
    expect((await inspect()).nodes).toEqual(committed.nodes);
    await writeFile(
      info.outputPath("committed-outline.json"),
      JSON.stringify(committed, null, 2),
    );
  } finally {
    releaseSnapshot();
    await writeFile(
      info.outputPath("provenance.json"),
      JSON.stringify(backend.provenance, null, 2),
    );
    await writeFile(
      info.outputPath("protocol.json"),
      JSON.stringify(protocol, null, 2),
    );
  }
});
