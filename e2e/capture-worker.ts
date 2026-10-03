/// <reference types="@cloudflare/workers-types" />

import { Effect } from "effect";

// Test-only Workerd entry. Never included in wrangler.jsonc or deployed.
import type { Node } from "../src/data/wire-schema";

import { handleCaptureKeys } from "../worker/capture";
import { captureDigest } from "../worker/capture-input";
import {
  authenticateCaptureKey,
  createCaptureKey,
} from "../worker/capture-keys";
import { resolveUserId } from "../worker/identity";
import productionWorker from "../worker/index";

export { UserOutlineDO } from "../worker/outline-do";
export { ShardDO } from "../worker/lunora-app";

type Env = Parameters<NonNullable<typeof productionWorker.fetch>>[1] & {
  USER_OUTLINE: DurableObjectNamespace<
    import("../worker/outline-do").UserOutlineDO
  >;
};

export type FixtureInput = {
  userId: string;
  password?: string;
  name?: string;
  expiry?: "never" | "30d" | "90d" | "1y";
  expiresAt?: number | null;
  attemptId?: string;
  date?: string;
  text?: string;
  fingerprint?: string;
  limit?: number | null;
  nodeId?: string;
  updatedText?: string;
  expected?: string;
  id?: string;
  sessionCreatedAt?: number;
  authorization?: string;
  now?: number;
  manageMethod?: "GET" | "POST" | "DELETE";
  manageBody?: unknown;
  origin?: string;
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") {
      const fetch = productionWorker.fetch;
      if (!fetch)
        throw new Error("production Worker fetch missing from fixture");
      return fetch(request, env, ctx);
    }

    const input = await request.json<FixtureInput>();
    const stub = env.USER_OUTLINE.get(
      env.USER_OUTLINE.idFromName(resolveUserId(input.userId, env)),
    );

    if (url.pathname === "/fixture/seed") {
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)',
        ).bind(
          input.userId,
          input.userId,
          `${input.userId}@capture.test`,
          now,
          now,
        ),
        env.DB.prepare(
          "INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,'credential',?,?,?,?)",
        ).bind(
          crypto.randomUUID(),
          input.userId,
          input.userId,
          input.password ?? "password-v1",
          now,
          now,
        ),
      ]);
      return Response.json({ seeded: true });
    }
    if (url.pathname === "/fixture/key") {
      const created = await createCaptureKey(
        env.DB,
        input.userId,
        {
          name: input.name ?? "fixture key",
          expiry: input.expiry ?? "never",
        },
        Date.now(),
      );
      if (created && input.expiresAt !== undefined) {
        await env.DB.prepare("UPDATE capture_key SET expiresAt=? WHERE id=?")
          .bind(input.expiresAt, created.entry.id)
          .run();
      }
      return Response.json(created);
    }
    if (url.pathname === "/fixture/manage") {
      const managed = new Request("http://fixture/api/capture-keys", {
        method: input.manageMethod ?? "GET",
        headers: {
          "content-type": "application/json",
          origin: input.origin ?? "http://fixture",
        },
        body:
          input.manageMethod === "GET"
            ? undefined
            : JSON.stringify(input.manageBody ?? {}),
      });
      return Effect.runPromise(
        handleCaptureKeys(
          managed,
          env,
          input.userId,
          new Date(input.sessionCreatedAt ?? Date.now()),
        ),
      );
    }
    if (url.pathname === "/fixture/auth") {
      return Response.json({
        authenticated: !!(await authenticateCaptureKey(
          env.DB,
          input.authorization ?? null,
          input.now ?? Date.now(),
        )),
      });
    }
    if (url.pathname === "/fixture/password") {
      await env.DB.prepare(
        "UPDATE account SET password=? WHERE userId=? AND providerId='credential'",
      )
        .bind(input.password, input.userId)
        .run();
      return Response.json({ changed: true });
    }
    if (url.pathname === "/fixture/inspect") {
      const snapshot = await stub.exportSnapshot();
      const keys = await env.DB.prepare(
        "SELECT id,userId,name,suffix,hash,credentialVersion,createdAt,lastUsedAt,expiresAt FROM capture_key WHERE userId=? ORDER BY createdAt,id",
      )
        .bind(input.userId)
        .all();
      return Response.json({ snapshot, keys: keys.results });
    }
    if (url.pathname === "/fixture/capture") {
      const fingerprint =
        input.fingerprint ??
        (await captureDigest(JSON.stringify([input.date, input.text, null])));
      return Response.json(
        await stub.captureDaily(
          {
            attemptId: input.attemptId!,
            date: input.date!,
            text: input.text!,
            fingerprint,
          },
          input.limit ?? null,
        ),
      );
    }
    if (url.pathname === "/fixture/edit") {
      const snapshot = await stub.exportSnapshot();
      const node = snapshot.nodes.find(
        (candidate) => candidate.id === input.nodeId,
      );
      if (!node) return Response.json({ edited: false });
      await stub.upsertNodes([
        {
          ...node,
          text: input.updatedText!,
          updatedAt: node.updatedAt + 1,
        } satisfies Node,
      ]);
      return Response.json({ edited: true });
    }
    if (url.pathname === "/fixture/delete") {
      await stub.deleteNodes([input.nodeId!]);
      return Response.json({ deleted: true });
    }
    if (url.pathname === "/fixture/upgrade") {
      return Response.json({
        upgraded: await stub.upgradeCaptureText(
          input.attemptId!,
          input.expected!,
          input.updatedText!,
        ),
      });
    }
    return new Response("not found", { status: 404 });
  },
};
