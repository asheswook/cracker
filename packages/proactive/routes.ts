import { Hono } from "hono";
import { type AppEnv } from "../../services/control/auth.ts";
import type { Database } from "../../services/control/db.ts";
import { CancelRequest, ListRequest, UpdateRequest } from "./schema.ts";
import { listFutureWork, mutateFutureWork } from "./store.ts";

export function proactiveRoutes(sql: Database) {
  const app = new Hono<AppEnv>();
  app.post("/list", async (c) =>
    c.json(await listFutureWork(sql, c.get("principal"), ListRequest.parse(await c.req.json()))),
  );
  app.post("/update", async (c) =>
    c.json(
      await mutateFutureWork(sql, c.get("principal"), {
        kind: "update",
        body: UpdateRequest.parse(await c.req.json()),
      }),
    ),
  );
  app.post("/cancel", async (c) =>
    c.json(
      await mutateFutureWork(sql, c.get("principal"), {
        kind: "cancel",
        body: CancelRequest.parse(await c.req.json()),
      }),
    ),
  );
  return app;
}
