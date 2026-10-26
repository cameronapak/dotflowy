import { Schema } from "effect";

import { resolveUserId } from "../../worker/identity.ts";
// Test-only entry. No auth bypass: every normal request uses the real Worker.
import productionWorker from "../../worker/index.ts";
export { ShardDO, UserOutlineDO } from "../../worker/index.ts";

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/__worker_browser/")) {
      if (request.headers.get("x-fixture-key") !== env.FIXTURE_KEY)
        return new Response(null, { status: 404 });
      const input = Schema.decodeUnknownSync(
        Schema.Struct({ userId: Schema.String }),
      )(await request.json());
      if (path === "/__worker_browser/inspect") {
        const stub = env.USER_OUTLINE.get(
          env.USER_OUTLINE.idFromName(resolveUserId(input.userId, env)),
        );
        return Response.json(await stub.exportSnapshot());
      }
      return new Response(null, { status: 404 });
    }
    return productionWorker.fetch(request, env, ctx);
  },
};
