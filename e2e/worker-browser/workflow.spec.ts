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

test("legacy clients read numbered nodes without losing their Kind through writes or undo", async ({
  page,
  context,
}) => {
  const { origin } = backend;
  const email = "numbered-compat@worker-browser.test";
  const password = "disposable-numbered-password";
  const signup = await context.request.post(
    `${origin}/api/auth/sign-up/email`,
    {
      headers: { origin },
      data: { email, name: "Numbered compatibility", password },
    },
  );
  expect(signup.status()).toBe(200);
  const { user } = await signup.json();
  await backend.db
    .prepare('UPDATE "user" SET emailVerified=1 WHERE id=?')
    .bind(user.id)
    .run();
  expect(
    (
      await context.request.post(`${origin}/api/auth/sign-in/email`, {
        headers: { origin },
        data: { email, password },
      })
    ).status(),
  ).toBe(200);
  const numbered = createNode({
    id: "numbered",
    text: "First step",
    kind: "numbered",
  });
  const plain = createNode({
    id: "plain",
    text: "Unchanged",
    prevSiblingId: "numbered",
  });
  const headers = { "x-dotflowy-numbered": "true" };
  expect(
    (
      await context.request.post(`${origin}/api/nodes`, {
        headers,
        data: { nodes: [numbered, plain] },
      })
    ).status(),
  ).toBe(200);
  const frames: Array<{
    modern: boolean;
    frame: import("../../src/data/wire-schema").ServerMessage;
  }> = [];
  page.on("websocket", (socket) => {
    if (!socket.url().includes("compat=")) return;
    socket.on("framereceived", ({ payload }) =>
      frames.push({
        modern: socket.url().endsWith("compat=modern"),
        frame: JSON.parse(String(payload)),
      }),
    );
  });
  await page.goto(origin);
  await expect(editor(page, "numbered")).toHaveText("First step");
  for (const modern of [false, true]) {
    await page.evaluate(
      (modern) =>
        new Promise<void>((resolve) => {
          const socket = new WebSocket(
            `ws://${location.host}/api/sync?compat=${modern ? "modern" : "legacy"}`,
          );
          const hello = modern
            ? { type: "hello", since: null, numbered: true }
            : { type: "hello", since: null };
          socket.onopen = () => socket.send(JSON.stringify(hello));
          socket.onmessage = () => resolve();
        }),
      modern,
    );
  }
  const snapshot = frames.find(
    (entry) => !entry.modern && entry.frame.type === "snapshot",
  )!.frame;
  expect(snapshot.type).toBe("snapshot");
  if (snapshot.type !== "snapshot") throw new Error("missing snapshot");
  expect(
    snapshot.nodes.find((node) => node.id === "numbered")?.kind,
  ).toBeNull();
  expect(snapshot.serverVersion).toBeTruthy();
  expect(snapshot.calendar).toBeDefined();
  const modernSnapshot = frames.find(
    (entry) => entry.modern && entry.frame.type === "snapshot",
  )!.frame;
  expect(
    modernSnapshot.type === "snapshot" &&
      modernSnapshot.nodes.find((node) => node.id === "numbered")?.kind,
  ).toBe("numbered");
  const legacyRead = await (
    await context.request.get(`${origin}/api/nodes`)
  ).json();
  expect(
    legacyRead.find((node: { id: string }) => node.id === "numbered").kind,
  ).toBeNull();
  const edited = await context.request.patch(`${origin}/api/nodes`, {
    data: {
      updates: [{ id: "numbered", changes: { text: "Legacy text edit" } }],
      clientId: "legacy-client",
    },
  });
  expect(edited.status()).toBe(200);
  const { seq } = await edited.json();
  await expect
    .poll(
      () =>
        frames.filter(
          (entry) => entry.frame.type === "change" && entry.frame.seq === seq,
        ).length,
    )
    .toBe(2);
  for (const { modern, frame } of frames.filter(
    (entry) => entry.frame.type === "change" && entry.frame.seq === seq,
  )) {
    if (frame.type !== "change") throw new Error("missing change");
    expect(frame.clientId).toBe("legacy-client");
    const op = frame.ops[0]!;
    expect(op.op !== "delete" && op.value.kind).toBe(
      modern ? "numbered" : null,
    );
  }
  const resume = await page.evaluate(
    (since) =>
      new Promise<import("../../src/data/wire-schema").ServerMessage>(
        (resolve) => {
          const socket = new WebSocket(`ws://${location.host}/api/sync`);
          socket.onopen = () =>
            socket.send(JSON.stringify({ type: "hello", since }));
          socket.onmessage = (event) => {
            socket.close();
            resolve(JSON.parse(event.data));
          };
        },
      ),
    snapshot.seq,
  );
  expect(resume.type).toBe("resume");
  if (resume.type !== "resume") throw new Error("missing resume");
  expect(resume.seq).toBe(seq);
  expect(resume.changes[0]?.clientId).toBe("legacy-client");
  expect(
    resume.changes[0]?.ops[0]?.op !== "delete" &&
      resume.changes[0]?.ops[0]?.value.kind,
  ).toBeNull();
  const inspect = async (): Promise<OutlineSnapshot> =>
    backend.control("inspect", user.id);
  const baseline = (await inspect()).nodes;
  // A stale paragraph undo and a delete/undo cycle must not erase numbered Kind.
  for (const body of [
    {
      ops: [
        { op: "update", value: { ...plain, text: "Must roll back" } },
        { op: "update", value: { ...numbered, kind: "paragraph" } },
      ],
      expectedSeq: seq,
    },
    { nodes: [{ ...numbered, kind: null }] },
    {
      ops: [
        { op: "delete", key: "numbered" },
        { op: "update", value: { ...plain, prevSiblingId: null } },
      ],
    },
  ]) {
    const response = await context.request.post(`${origin}/api/nodes`, {
      data: body,
    });
    expect(response.status()).toBe(409);
    expect((await response.json()).error).toBe("client_upgrade_required");
    expect((await inspect()).nodes).toEqual(baseline);
  }
  for (const changes of [
    { kind: null, isTask: true },
    { kind: "paragraph", text: "Must not be coupled" },
  ]) {
    const response = await context.request.patch(`${origin}/api/nodes`, {
      data: {
        updates: [
          { id: "plain", changes: { text: "Must roll back" } },
          { id: "numbered", changes },
        ],
      },
    });
    expect(response.status()).toBe(409);
    expect((await inspect()).nodes).toEqual(baseline);
  }
  expect(
    (
      await context.request.delete(`${origin}/api/nodes`, {
        data: { ids: ["plain", "numbered"] },
      })
    ).status(),
  ).toBe(409);
  expect((await inspect()).nodes).toEqual(baseline);
  expect(
    (
      await context.request.patch(`${origin}/api/nodes`, {
        headers,
        data: {
          updates: [{ id: "numbered", changes: { kind: null, isTask: true } }],
        },
      })
    ).status(),
  ).toBe(200);
  const converted = (await inspect()).nodes.find(
    (node) => node.id === "numbered",
  );
  expect(converted?.kind).toBeNull();
  expect(converted?.isTask).toBe(true);
  expect(converted?.text).toBe("Legacy text edit");
});

test("a share survives sign-in, saves only on Add to Today, and a cross-site post or link never saves", async ({
  page,
  context,
}) => {
  const { origin } = backend;
  const email = "share-target@worker-browser.test";
  const password = "disposable-share-password";
  const signup = await context.request.post(
    `${origin}/api/auth/sign-up/email`,
    { headers: { origin }, data: { email, name: "Share target", password } },
  );
  expect(signup.status()).toBe(200);
  const { user } = await signup.json();
  await backend.db
    .prepare('UPDATE "user" SET emailVerified=1 WHERE id=?')
    .bind(user.id)
    .run();
  const inspect = async (): Promise<OutlineSnapshot> =>
    backend.control("inspect", user.id);

  // Signed out: the share sheet's POST, as a top-level form submission from
  // this origin (what Chrome 156+ reports for a share launch).
  await page.goto(`${origin}/terms`);
  await page.evaluate(() => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/share";
    form.enctype = "multipart/form-data";
    for (const [name, value] of [
      ["title", "Shared page"],
      ["text", "- [ ] follow up on the shared page\n  - with a note"],
    ] as const) {
      const input = document.createElement("textarea");
      input.name = name;
      input.value = value;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  });
  await expect(page.getByPlaceholder("Email")).toBeVisible();
  // The shared text left the address bar before the sign-in screen rendered.
  expect(new URL(page.url()).hash).toBe("");
  expect(new URL(page.url()).pathname).toBe("/share");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  const preview = page.getByRole("figure", { name: "Shared content" });
  await expect(preview).toContainText("follow up on the shared page");
  await expect(
    page.getByRole("button", { name: "Add to Today" }),
  ).toBeVisible();
  // Loading the page, signed in, saved nothing.
  expect((await inspect()).nodes).toEqual([]);
  await page.getByRole("button", { name: "Add to Today" }).click();
  await expect(page.getByRole("status")).toHaveText("Added to Today.");
  const saved = await inspect();
  const task = saved.nodes.find(
    (node) => node.text === "follow up on the shared page",
  );
  expect(task?.isTask).toBe(true);
  expect(
    saved.nodes.filter((node) => node.parentId === task!.id),
  ).toMatchObject([{ text: "with a note" }]);
  await page.getByRole("button", { name: "Open Today" }).click();
  await expect(
    page.locator(`li[data-node-id="${task!.id}"] .node-text`),
  ).toHaveText("follow up on the shared page");
  const after = saved.nodes.length;

  // Signed in, another site posts a form to /share: refused before the page.
  const hostile = await context.newPage();
  await hostile.goto("about:blank");
  await hostile.setContent(
    `<form method="POST" action="${origin}/share" enctype="multipart/form-data"><textarea name="text">planted</textarea></form>`,
  );
  await hostile.evaluate(() => document.forms[0]!.submit());
  await expect(hostile.getByText("ignored it")).toBeVisible();
  await expect(
    hostile.getByRole("button", { name: "Add to Today" }),
  ).toHaveCount(0);
  // A plain link can carry text in the fragment; it still waits for a tap.
  await hostile.goto("about:blank");
  await hostile.goto(`${origin}/share#text=planted%20by%20a%20link`);
  await expect(
    hostile.getByRole("figure", { name: "Shared content" }),
  ).toHaveText("planted by a link");
  expect((await inspect()).nodes).toHaveLength(after);
});
