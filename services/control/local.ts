import { notificationConfig } from "../../packages/notifications/config.ts";
import { dispatchNotifications } from "../../packages/notifications/dispatch.ts";
import { z } from "zod";
import { LocalArtifactStore } from "../../packages/artifacts/local-store";
import { cleanupArtifacts } from "../../packages/artifacts/cleanup";
import { createApp } from "./app";
import { createDatabase } from "./db";
import { dispatchDueSchedules } from "./repository/schedules";
import { quarantineStaleRuns } from "./repository/recovery";

const config = z.object({ DATABASE_URL: z.string().url(), PORT: z.coerce.number().int().min(1).max(65535).default(8787), SEMANTIC_STRUCTURE_MODE:z.enum(['off','shadow','on']).default('off'), KNOWLEDGE_TREE_MODE:z.enum(['off','shadow','on']).default('off') }).parse(process.env);
const sql = createDatabase(config.DATABASE_URL);
const artifactStore = new LocalArtifactStore(".local/artifacts");
const extensionKey = process.env["EXTENSION_ENCRYPTION_KEY"];
const push = notificationConfig(process.env);
const screenTurn = { SCREEN_TURN_KEY_ID: process.env["SCREEN_TURN_KEY_ID"], SCREEN_TURN_API_TOKEN: process.env["SCREEN_TURN_API_TOKEN"] };
const app = createApp(sql, { semanticStructureMode:config.SEMANTIC_STRUCTURE_MODE, knowledgeTreeMode:config.KNOWLEDGE_TREE_MODE, screenTurn, notificationConfig: push, artifactStore, ...(extensionKey ? { extensionKey } : {}), allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"] });
const server = Bun.serve({ hostname: "127.0.0.1", port: config.PORT, fetch: app.fetch });
let scheduling = false;
let lastCleanup = 0;
const timer = setInterval(async () => {
  if (scheduling) return;
  scheduling = true;
  try {
    await quarantineStaleRuns(sql); await dispatchDueSchedules(sql);
    await dispatchNotifications(sql, push);
    if (Date.now() - lastCleanup >= 60000) {
      lastCleanup = Date.now();
      await cleanupArtifacts(sql, artifactStore);
    }
  }
  catch (error) {
    if (error instanceof Error) console.error(JSON.stringify({ event: "schedule.dispatch.failed", type: error.name }));
    else throw error;
  } finally { scheduling = false; }
}, 1000);
console.log(`Control service listening on ${server.url}`);
const stop = async () => { clearInterval(timer); await server.stop(); await sql.end(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
