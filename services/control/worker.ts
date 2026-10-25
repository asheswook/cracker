import { tickAttention } from "../../packages/attention/coordinator";
import { tickSources } from "../../packages/attention/sources";
import { notificationConfig } from "../../packages/notifications/config.ts";
import { dispatchNotifications } from "../../packages/notifications/dispatch.ts";
import { createApp } from "./app";
import { authenticate, requireOrigin } from "./auth";
import { createDatabase } from "./db";
import { dispatchDueSchedules } from "./repository/schedules";
import { quarantineStaleRuns } from "./repository/recovery";
import { AssistantRoom } from "./room";
import { ScreenRoom } from "./screen-room";
import { DomainError, Id } from "../../packages/protocol";
import type { ArtifactStore } from "../../packages/artifacts/store";
import { cleanupArtifacts } from "../../packages/artifacts/cleanup";
import { createClefClassifier } from "../../packages/context/clef";
import type { SemanticClassifier } from "../../packages/context/schema";
import { CONTEXT_EMBEDDING_MODEL, createSemanticRetriever } from "../../packages/context/recall";
import { synchronizeContextIndex } from "../../packages/context/recall-index";
import type { KnowledgeTreeAi } from "../../packages/knowledge-tree/ai";
import { z } from 'zod';
import { screenUpgrade } from './screen-upgrade';

export { AssistantRoom, ScreenRoom };
type Environment = {
  readonly ASSETS: Fetcher;
  readonly ARTIFACTS: R2Bucket;
  readonly DATABASE: Hyperdrive;
  readonly ROOMS: DurableObjectNamespace<AssistantRoom>;
  readonly SCREENS: DurableObjectNamespace<ScreenRoom>;
  readonly EXTENSION_ENCRYPTION_KEY?: string;
  readonly VAPID_PUBLIC_KEY?: string;
  readonly VAPID_PRIVATE_KEY?: string;
  readonly VAPID_SUBJECT?: string;
  readonly FCM_SERVICE_ACCOUNT_JSON?: string;
  readonly SCREEN_TURN_KEY_ID?: string;
  readonly SCREEN_TURN_API_TOKEN?: string;
  readonly AI?: Ai;
  readonly SEMANTIC_STRUCTURE_MODE?: string;
  readonly KNOWLEDGE_TREE_MODE?: string;
};

function semanticClassifier(ai: Ai): SemanticClassifier {
  const classify = createClefClassifier((model, input, signal) => ai.run(model, input, {signal}));
  return async input => {
    try { return await classify(input); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      console.warn(JSON.stringify({event: "context.classifier_unavailable", type: error.name}));
      return {context_id: null, outcome: "uncertain", scores: [], model: "clef_unavailable"};
    }
  };
}

function knowledgeTreeAi(ai: Ai): KnowledgeTreeAi {
  return {
    embed: (texts, signal) => ai.run(CONTEXT_EMBEDDING_MODEL, {text: [...texts], truncate_inputs: false}, {signal}),
    clef: (input, signal) => ai.run('@cf/cloudflare/clef', input, {signal}),
  };
}

export function createArtifactStore(bucket: R2Bucket): ArtifactStore {
  return {
    async put(key, body, metadata) {
      const fixed = new FixedLengthStream(metadata.bytes);
      const abort = new AbortController();
      const writing = body.pipeTo(fixed.writable, { signal: abort.signal });
      const storing = bucket.put(key, fixed.readable, {
        httpMetadata: { contentType: metadata.mediaType },
        customMetadata: { sha256: metadata.sha256 },
      });
      try {
        const [stored] = await Promise.all([storing, writing]);
        if (!stored || stored.size !== metadata.bytes) throw new DomainError("storage_size_mismatch", "Stored file size differs", 503);
      } catch (error) {
        abort.abort(error);
        await Promise.allSettled([storing, writing]);
        throw error;
      }
    },
    async get(key) {
      const stored = await bucket.get(key);
      return stored ? { body: stored.body, size: stored.size } : null;
    },
    async delete(key) { await bucket.delete(key); },
  };
}

export default {
  async fetch(request: Request, env: Environment, context: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith("/v1/") && pathname !== "/health" && pathname !== "/ready")
      return env.ASSETS.fetch(request);
    const sql = createDatabase(env.DATABASE.connectionString);
    try {
      const screenPath = /^\/v1\/vms\/([^/]+)\/screen$/.exec(new URL(request.url).pathname);
      if (screenPath) {
        const vm = Id.parse(screenPath[1]);
        return await screenUpgrade(sql,request,vm,(key,upgrade)=>env.SCREENS.getByName(key).fetch(upgrade));
      }
      if (new URL(request.url).pathname === "/v1/connect") {
        const authorization = request.headers.get("Authorization") ?? undefined;
        if (!authorization) requireOrigin(request);
        const principal = await authenticate(
          sql,
          authorization,
          request.headers.get("Cookie") ?? undefined,
        );
        const headers = new Headers(request.headers);
        headers.delete("Authorization");
        headers.delete("Cookie");
        headers.set("X-Assistant-Principal", JSON.stringify(principal));
        return await env.ROOMS.getByName(principal.workspace_id).fetch(
          new Request(request, { headers }),
        );
      }
      const push=notificationConfig(env);
      const response = await createApp(sql, {
        semanticStructureMode: z.enum(['off','shadow','on']).default('off').parse(env.SEMANTIC_STRUCTURE_MODE),
        knowledgeTreeMode: z.enum(['off','shadow','on']).default('off').parse(env.KNOWLEDGE_TREE_MODE),
        ...(env.AI ? { knowledgeTree: knowledgeTreeAi(env.AI) } : {}),
        semanticContexts: env.AI ? {
          classify: semanticClassifier(env.AI),
          retrieve: createSemanticRetriever(sql, (texts, signal) => {
            const ai = env.AI;
            if (!ai) throw new DomainError("context_embedding_unavailable", "Context search unavailable", 503);
            return ai.run(CONTEXT_EMBEDDING_MODEL, {text: [...texts], truncate_inputs: false}, {signal});
          }),
        } : {},
        screenTurn: { SCREEN_TURN_KEY_ID: env.SCREEN_TURN_KEY_ID, SCREEN_TURN_API_TOKEN: env.SCREEN_TURN_API_TOKEN },
        ...(push?{notificationConfig:push}:{}),
        artifactStore: createArtifactStore(env.ARTIFACTS),
        ...(env.EXTENSION_ENCRYPTION_KEY ? { extensionKey: env.EXTENSION_ENCRYPTION_KEY } : {}),
      }).fetch(request);
      if (response.ok && request.method === "POST" && pathname === "/v1/daemon/events") {
        context.waitUntil((async () => {
          const deliverySql = createDatabase(env.DATABASE.connectionString);
          try { await dispatchNotifications(deliverySql, push); }
          catch (error) {
            if (!(error instanceof Error)) throw error;
            console.error(JSON.stringify({ event: "notifications.dispatch_failed", type: error.name }));
          } finally { await deliverySql.end(); }
        })());
      }
      return response;
    } catch (error) {
      if (error instanceof DomainError)
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: error.status },
        );
      if (error instanceof Error)
        console.error(JSON.stringify({ event: "worker.request.failed", type: error.name }));
      else throw error;
      return Response.json(
        { error: { code: "unavailable", message: "Service unavailable" } },
        { status: 503 },
      );
    } finally {
      context.waitUntil(sql.end());
    }
  },
  async scheduled(_controller: ScheduledController, env: Environment): Promise<void> {
    const sql = createDatabase(env.DATABASE.connectionString);
    try {
      await quarantineStaleRuns(sql);
      await dispatchDueSchedules(sql);
      try { await tickAttention(sql); await tickSources(sql); }
      catch (error) { if (!(error instanceof Error)) throw error; console.error(JSON.stringify({ event: 'attention.tick_failed', type: error.name, message: error.message.slice(0, 200) })); }
      const rows = await sql<
        { id: string; workspace_id: string }[]
      >`SELECT id::text, workspace_id FROM assistant.outbox WHERE delivered_at IS NULL ORDER BY id LIMIT 100`;
      for (const row of rows) {
        await env.ROOMS.getByName(row.workspace_id).notify();
        await sql`UPDATE assistant.outbox SET delivered_at=now() WHERE id=${row.id}`;
      }
      await cleanupArtifacts(sql, createArtifactStore(env.ARTIFACTS));
      if(env.AI) {
        const ai=env.AI;
        try {await synchronizeContextIndex(sql,(texts,signal)=>ai.run(CONTEXT_EMBEDDING_MODEL,{text:[...texts],truncate_inputs:false},{signal}),undefined,Number.MAX_SAFE_INTEGER,8);}
        catch(error) {if(!(error instanceof Error))throw error;console.warn(JSON.stringify({event:'context.index_deferred',type:error.name}));}
      }
    } finally {
      try {
        const push=notificationConfig(env);
        if(push) await dispatchNotifications(sql,push);
      } catch(error) {
        if(!(error instanceof Error))throw error;
        console.error(JSON.stringify({event:"notifications.dispatch_failed",type:error.name}));
      } finally {
        await sql.end();
      }
    }
  },
} satisfies ExportedHandler<Environment>;
