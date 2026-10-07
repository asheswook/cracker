import postgres from "postgres";
import { z } from "zod";
import controlMigration from "../migrations/001_control.sql";
import memoryMigration from "../migrations/002_memory.sql";
import scopeMigration from "../migrations/003_outbox_scope.sql";
import sessionsMigration from "../migrations/004_sessions.sql";
import responsibilitiesMigration from "../migrations/005_responsibilities.sql";
import responsibilityActionsMigration from "../migrations/006_responsibility_actions.sql";
import artifactsMigration from "../migrations/007_artifacts.sql";
import scheduleSourcesMigration from "../migrations/008_schedule_sources.sql";
import extensionsMigration from "../migrations/009_extensions.sql";
import assistantMigration from "../migrations/010_assistant.sql";
import messengerMigration from "../migrations/011_messenger.sql";
import dailyWorkMigration from "../migrations/012_daily_work.sql";
import artifactSearchMigration from "../migrations/013_artifact_search.sql";
import wakeProvenanceMigration from "../migrations/014_wake_provenance.sql";
import memoryCorrectionsMigration from "../migrations/015_memory_corrections.sql";
import memoryVersionLineageMigration from "../migrations/016_memory_version_lineage.sql";
import notificationsMigration from "../migrations/017_notifications.sql";
import skillVersionsMigration from "../migrations/018_skill_versions.sql";
import replyComposingMigration from "../migrations/019_reply_composing.sql";
import modelSettingsMigration from "../migrations/020_model_settings.sql";
import proactiveManagementMigration from "../migrations/021_proactive_management.sql";
import proactiveRevisionsMigration from "../migrations/022_proactive_revisions.sql";
import nativeNotificationsMigration from "../migrations/023_native_notifications.sql";
import artifactDocumentMigration from "../migrations/024_artifact_document_index.sql";
import settingsRevisionMigration from "../migrations/025_settings_revision.sql";
import messageNotificationsMigration from "../migrations/026_message_notifications.sql";
import assistantAppearanceMigration from "../migrations/027_assistant_appearance.sql";
import notificationViewingMigration from "../migrations/028_notification_viewing.sql";
import replyHandoffMigration from "../migrations/029_reply_handoff.sql";
import assistantMessagePhaseMigration from "../migrations/030_assistant_message_phase.sql";
import memoryRetentionMigration from "../migrations/031_memory_retention.sql";
import artifactSizeMigration from "../migrations/032_artifact_size.sql";

type Environment = { readonly DATABASE: Hyperdrive; readonly PROVISION_TOKEN: string };
const Setup = z.object({ workspace_id: z.uuid(), vm_id: z.uuid(), client_hash: z.string().regex(/^[a-f0-9]{64}$/), vm_hash: z.string().regex(/^[a-f0-9]{64}$/), revoke_client_hash: z.string().regex(/^[a-f0-9]{64}$/).optional() });

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    if (!env.PROVISION_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.PROVISION_TOKEN}`) return new Response("Unauthorized", { status: 401 });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/install") return new Response("Not found", { status: 404 });
    const parsed = Setup.safeParse(await request.json());
    if (!parsed.success) return new Response("Invalid setup", { status: 400 });
    const setup = parsed.data;
    const sql = postgres(env.DATABASE.connectionString, { max: 1, prepare: false });
    try {
      await sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(619083002)`;
        await tx`CREATE SCHEMA IF NOT EXISTS assistant`;
        await tx`SET LOCAL search_path TO assistant,public`;
        await tx`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
        for (const [name, source] of [["001_control.sql", controlMigration], ["002_memory.sql", memoryMigration], ["003_outbox_scope.sql", scopeMigration], ["004_sessions.sql", sessionsMigration], ["005_responsibilities.sql", responsibilitiesMigration], ["006_responsibility_actions.sql", responsibilityActionsMigration], ["007_artifacts.sql", artifactsMigration], ["008_schedule_sources.sql", scheduleSourcesMigration], ["009_extensions.sql", extensionsMigration], ["010_assistant.sql", assistantMigration], ["011_messenger.sql", messengerMigration], ["012_daily_work.sql", dailyWorkMigration], ["013_artifact_search.sql", artifactSearchMigration], ["014_wake_provenance.sql", wakeProvenanceMigration], ["015_memory_corrections.sql", memoryCorrectionsMigration], ["016_memory_version_lineage.sql", memoryVersionLineageMigration], ["017_notifications.sql", notificationsMigration], ["018_skill_versions.sql", skillVersionsMigration], ["019_reply_composing.sql", replyComposingMigration], ["020_model_settings.sql", modelSettingsMigration], ["021_proactive_management.sql", proactiveManagementMigration], ["022_proactive_revisions.sql", proactiveRevisionsMigration], ["023_native_notifications.sql", nativeNotificationsMigration], ["024_artifact_document_index.sql", artifactDocumentMigration], ["025_settings_revision.sql", settingsRevisionMigration], ["026_message_notifications.sql", messageNotificationsMigration], ["027_assistant_appearance.sql", assistantAppearanceMigration], ["028_notification_viewing.sql", notificationViewingMigration], ["029_reply_handoff.sql", replyHandoffMigration], ["030_assistant_message_phase.sql", assistantMessagePhaseMigration], ["031_memory_retention.sql", memoryRetentionMigration], ["032_artifact_size.sql", artifactSizeMigration]]) {
        if (!name || !source) throw new ProvisionError("missing_migration");
        const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)));
        const checksum = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
        const [prior] = await tx`SELECT checksum FROM schema_migrations WHERE name=${name}`;
        if (prior && prior["checksum"] !== checksum) throw new ProvisionError("migration_checksum");
        if (!prior) {
          await tx.unsafe(source);
          await tx`INSERT INTO schema_migrations(name,checksum) VALUES(${name},${checksum})`;
        }
        }
        await tx`INSERT INTO workspaces(id,name) VALUES(${setup.workspace_id},'Personal') ON CONFLICT(id) DO NOTHING`;
        await tx`INSERT INTO vms(id,workspace_id,name) VALUES(${setup.vm_id},${setup.workspace_id},'Assistant computer') ON CONFLICT(id) DO NOTHING`;
        await tx`INSERT INTO credentials(token_hash,workspace_id,role,vm_id) VALUES(${setup.client_hash},${setup.workspace_id},'client',NULL),(${setup.vm_hash},${setup.workspace_id},'vm',${setup.vm_id}) ON CONFLICT(token_hash) DO NOTHING`;
        if (setup.revoke_client_hash) await tx`UPDATE credentials SET revoked_at=now() WHERE token_hash=${setup.revoke_client_hash} AND workspace_id=${setup.workspace_id} AND role='client'`;
      });
      const migrations = z.array(z.object({ name: z.string(), applied_at: z.string() })).parse(await sql`SELECT name,applied_at::text FROM assistant.schema_migrations ORDER BY name`);
      return Response.json({ installed: true, workspace_id: setup.workspace_id, migrations });
    } catch (error) {
      if (error instanceof Error) return Response.json({ error: "provision_failed", type: error.name }, { status: 500 });
      throw error;
    } finally { await sql.end(); }
  }
} satisfies ExportedHandler<Environment>;

class ProvisionError extends Error { constructor(readonly code: string) { super(code); this.name = "ProvisionError"; } }
