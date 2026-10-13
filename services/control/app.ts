import { notificationRoutes } from "../../packages/notifications/routes.ts";
import { proactiveRoutes } from "../../packages/proactive/routes.ts";
import { modelClientRoutes, modelDaemonRoutes } from "../../packages/models/routes.ts";
import { accountClientRoutes, accountDaemonRoutes } from "../../packages/models/account-routes.ts";
import type { NotificationConfig } from "../../packages/notifications/config.ts";
import type { PushConfig } from "../../packages/notifications/schema.ts";
import { extensionClientRoutes, extensionDaemonRoutes } from "../../packages/extensions/routes";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { artifactRoutes } from "../../packages/artifacts/routes";
import type { ArtifactStore } from "../../packages/artifacts/store";
import { memoryDaemonRoutes } from "../../packages/memory/persist";
import {
  responsibilityClientRoutes,
  responsibilityDaemonRoutes,
} from "../../packages/memory/responsibility-routes";
import { DomainError } from "../../packages/protocol";
import { type AppEnv, authenticate, requireOrigin } from "./auth";
import type { Database } from "./db";
import { clientRoutes } from "./routes/client";
import { daemonRoutes } from "./routes/daemon";
import { sessionRoutes } from "./routes/session";
import { workSearchRoutes } from "./routes/work-search.ts";
import { screenIceRoutes, type ScreenTurnSettings } from "./screen-ice";
import { semanticContextRoutes, semanticContextClientRoutes } from "./routes/semantic-context";
import { semanticStructureRoutes } from "./routes/semantic-structure";
import type { SemanticClassifier, SemanticRetriever } from "../../packages/context/schema";
export function createApp(
  sql: Database,
  options: {
    readonly allowedOrigins?: readonly string[];
    readonly artifactStore?: ArtifactStore;
    readonly extensionKey?: string;
    readonly notificationConfig?: PushConfig | NotificationConfig;
    readonly screenTurn?: ScreenTurnSettings;
  readonly semanticContexts?: { readonly classify?: SemanticClassifier; readonly retrieve?: SemanticRetriever };
  readonly semanticStructureMode?: 'off'|'shadow'|'on';
  } = {},
) {
  const allowedOrigins = options.allowedOrigins ?? [];
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.origin !== origin
    )
      throw new TypeError("Only explicit loopback development origins are supported");
  }
  const app = new Hono<AppEnv>();
  if (allowedOrigins.length > 0)
    app.use(
      "/v1/*",
      cors({
        origin: (origin) => (allowedOrigins.includes(origin) ? origin : undefined),
        credentials: true,
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "X-Artifact-Id", "X-Artifact-Name", "X-Artifact-Bytes", "X-Artifact-SHA256"],
      }),
    );
  app.use(
    "/v1/session",
    bodyLimit({
      maxSize: 4096,
      onError: (c) =>
        c.json({ error: { code: "body_too_large", message: "Sign-in body exceeds limit" } }, 413),
    }),
  );
  app.use("*", async (c, next) => {
    if (
      c.req.method === "POST" &&
      /^\/v1\/(?:daemon\/)?conversations\/[^/]+\/artifacts$/.test(c.req.path)
    )
      return next();
    return bodyLimit({
      maxSize: c.req.method === "POST" && /^\/v1\/daemon\/artifact-index\/[0-9a-f-]+\/result$/.test(c.req.path) ? 1250000 : 200000,
      onError: (c) =>
        c.json({ error: { code: "body_too_large", message: "Request body exceeds limit" } }, 413),
    })(c, next);
  });
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", async (c) => {
    await sql`SELECT 1`;
    return c.json({ status: "ready" });
  });
  app.use("/v1/*", async (c, next) => {
    const login = c.req.path === "/v1/session" && c.req.method === "POST";
    const cookieAuthentication = !c.req.header("Authorization") && Boolean(c.req.header("Cookie"));
    if (login || (cookieAuthentication && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)))
      requireOrigin(c.req.raw, allowedOrigins);
    if (login) {
      await next();
      return;
    }
    const principal = await authenticate(
      sql,
      c.req.header("Authorization"),
      c.req.header("Cookie"),
    );
    const daemon = c.req.path.startsWith("/v1/daemon/");
    if ((daemon && principal.role !== "vm") || (!daemon && principal.role !== "client"))
      throw new DomainError("forbidden", "Credential audience does not permit this route", 403);
    c.set("principal", principal);
    await next();
  });
  app.route("/v1/notifications", notificationRoutes(sql, options.notificationConfig));
  app.route("/v1", screenIceRoutes(sql, options.screenTurn));
  app.route("/v1/daemon", screenIceRoutes(sql, options.screenTurn));
  app.route("/v1/daemon/proactive-work", proactiveRoutes(sql));
  app.route("/v1/model-settings", modelClientRoutes(sql, options.extensionKey));
  app.route("/v1/model-account", accountClientRoutes(sql, options.extensionKey));
  app.route("/v1/daemon/model-account", accountDaemonRoutes(sql, options.extensionKey));
  app.route("/v1/daemon/model-settings", modelDaemonRoutes(sql, options.extensionKey));
  app.route("/v1/extensions", extensionClientRoutes(sql, options.extensionKey));
  app.route("/v1/daemon/extensions", extensionDaemonRoutes(sql, options.extensionKey));
  app.route("/v1/daemon", artifactRoutes(sql, options.artifactStore, true));
  app.route("/v1/daemon", workSearchRoutes(sql, options.artifactStore, true));
  app.route("/v1", workSearchRoutes(sql, options.artifactStore));
  app.route("/v1", artifactRoutes(sql, options.artifactStore));
  app.route("/v1/responsibilities", responsibilityClientRoutes(sql));
  app.route("/v1/daemon/responsibilities", responsibilityDaemonRoutes(sql));
  app.route("/v1/session", sessionRoutes(sql));
  app.route("/v1/daemon/memory", memoryDaemonRoutes(sql));
  if (options.semanticContexts) {
  app.route("/v1/daemon", semanticContextRoutes(sql, options.semanticContexts));
    app.route("/v1", semanticContextClientRoutes(sql));
  }
  app.route("/v1/daemon", semanticStructureRoutes(sql));
  app.route("/v1/daemon", daemonRoutes(sql, Boolean(options.semanticContexts), options.semanticStructureMode));
  app.route("/v1", clientRoutes(sql));
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));
  app.onError((error, c) => {
    if (error instanceof DomainError)
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json(
        { error: { code: "invalid_request", message: "Request does not match schema" } },
        400,
      );
    console.error(
      JSON.stringify({
        event: "control.request.failed",
        type: error.name,
        code: "code" in error && typeof error.code === "string" ? error.code : null,
        path: c.req.path,
      }),
    );
    return c.json({ error: { code: "internal_error", message: "Request failed" } }, 500);
  });
  return app;
}
