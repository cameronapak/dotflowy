/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

/** Storage custodian for the retired backend. Keep the deployed class name and
 * binding until deletion of retained data is separately approved. No schema
 * initialization, export, mutation, or scheduler from the old runtime runs. */
export class ShardDO extends DurableObject {
  fetch(): Response {
    return new Response("not found", { status: 404 });
  }

  // Consume old alarms without running retired jobs or changing stored rows.
  alarm(): void {}

  /** Called only by the authenticated account-deletion lifecycle. */
  async wipe(): Promise<void> {
    for (const socket of this.ctx.getWebSockets())
      socket.close(1000, "deleted");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
