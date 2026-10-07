import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../services/control/auth.ts";
import type { Database } from "../../services/control/db.ts";
import { appendMessage } from "../../services/control/repository/common.ts";
import { DomainError, Task } from "../protocol/index.ts";
import { bindSkill, ownedVersion, Version } from "./versions.ts";
const TestInput = z
  .object({
    revision: z.number().int().positive(),
    client_execution_id: z.uuid(),
    input: z.string().trim().min(1).max(100000),
  })
  .strict();
const Check = z
  .object({
    client_check_id: z.uuid(),
    criterion: z.string().trim().min(1).max(2000),
    observed: z.string().trim().min(1).max(4000),
    status: z.enum(["pass", "fail", "unknown"]),
    source_message_id: z.uuid(),
  })
  .strict();
export function workflowRoutes(sql: Database) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/:id/versions", async (c) => {
    const workspace = c.get("principal").workspace_id,
      id = z.uuid().parse(c.req.param("id")),
      before = z.coerce.number().int().positive().optional().parse(c.req.query("before"));
    const rows =
      await sql`SELECT * FROM assistant.skill_versions WHERE workspace_id=${workspace} AND skill_id=${id} AND (${before ?? null}::int IS NULL OR revision<${before ?? null}) ORDER BY revision DESC LIMIT 51`;
    if (!rows.length) throw new DomainError("not_found", "Skill not found", 404);
    const page = z.array(Version).parse(rows.slice(0, 50));
    return c.json({
      versions: page,
      next_revision: rows.length > 50 ? page.at(-1)?.revision : null,
    });
  });
  app.get("/:id/versions/:revision", async (c) =>
    c.json({
      version: await ownedVersion(
        sql,
        c.get("principal").workspace_id,
        z.uuid().parse(c.req.param("id")),
        z.coerce.number().int().positive().parse(c.req.param("revision")),
      ),
    }),
  );
  app.post("/:id/tests", async (c) => {
    const workspace = c.get("principal").workspace_id,
      id = z.uuid().parse(c.req.param("id")),
      body = TestInput.parse(await c.req.json());
    const result = await sql.begin(async (tx) => {
      await tx`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`;
      const version = await ownedVersion(tx, workspace, id, body.revision);
      const prior =
        await tx`SELECT e.*,m.content,t.conversation_id,to_jsonb(t) AS task FROM assistant.skill_executions e JOIN assistant.tasks t ON t.id=e.task_id JOIN assistant.messages m ON m.id=e.input_message_id WHERE e.workspace_id=${workspace} AND e.client_execution_id=${body.client_execution_id}`;
      if (prior[0]) {
        const row = z
          .object({
            id: z.uuid(),
            skill_id: z.uuid(),
            revision: z.number(),
            content: z.string(),
            conversation_id: z.uuid(),
            task: Task,
          })
          .parse(prior[0]);
        if (row.skill_id !== id || row.revision !== body.revision || row.content !== body.input)
          throw new DomainError("idempotency_conflict", "Execution key reused", 409);
        return {
          execution_id: row.id,
          conversation_id: row.conversation_id,
          task: Task.parse((await tx`SELECT * FROM assistant.tasks WHERE id=${row.task.id}`)[0]),
        };
      }
      const conversation = z
        .object({ id: z.uuid() })
        .parse(
          (
            await tx`INSERT INTO assistant.conversations(workspace_id,title) VALUES(${workspace},${version.name.slice(0, 180) + " · test"}) RETURNING id`
          )[0],
        );
      const { task, message } = await appendMessage(tx, {
        workspace,
        conversation: conversation.id,
        content: body.input,
        clientId: body.client_execution_id,
      });
      const execution = await bindSkill(tx, {
        workspace,
        task: task.id,
        message: message.id,
        skill: id,
        revision: body.revision,
        kind: "test",
        clientId: body.client_execution_id,
      });
      return { execution_id: execution.id, conversation_id: conversation.id, task };
    });
    return c.json(result, 201);
  });
  app.get("/:id/executions", async (c) => {
    const workspace = c.get("principal").workspace_id,
      id = z.uuid().parse(c.req.param("id")),
      before = z.uuid().optional().parse(c.req.query("before"));
    const rows =
      await sql`SELECT e.id,e.revision,e.kind,e.input_message_id,e.loaded_at,e.loaded_run_id,e.created_at,t.conversation_id,to_jsonb(t) AS task,
   (SELECT m.id FROM assistant.messages m WHERE m.task_id=t.id AND m.role='assistant' ORDER BY m.sequence DESC LIMIT 1) AS result_message_id,
   COALESCE((SELECT jsonb_agg(to_jsonb(ch) ORDER BY ch.created_at,ch.id) FROM assistant.skill_execution_checks ch WHERE ch.execution_id=e.id),'[]'::jsonb) AS checks
   FROM assistant.skill_executions e JOIN assistant.tasks t ON t.id=e.task_id WHERE e.workspace_id=${workspace} AND e.skill_id=${id}
   AND (${before ?? null}::uuid IS NULL OR (e.created_at,e.id)<(SELECT created_at,id FROM assistant.skill_executions WHERE id=${before ?? null} AND workspace_id=${workspace} AND skill_id=${id})) ORDER BY e.created_at DESC,e.id DESC LIMIT 51`;
    const page = rows.slice(0, 50);
    return c.json({ executions: page, next_cursor: rows.length > 50 ? page.at(-1)?.["id"] : null });
  });
  app.post("/:id/executions/:execution/checks", async (c) => {
    const workspace = c.get("principal").workspace_id,
      id = z.uuid().parse(c.req.param("id")),
      execution = z.uuid().parse(c.req.param("execution")),
      body = Check.parse(await c.req.json());
    const result = await sql.begin(async (tx) => {
      const rows =
        await tx`SELECT e.id FROM assistant.skill_executions e JOIN assistant.messages m ON m.task_id=e.task_id AND m.workspace_id=e.workspace_id WHERE e.id=${execution} AND e.workspace_id=${workspace} AND e.skill_id=${id} AND m.id=${body.source_message_id} AND m.role='assistant' AND e.loaded_at IS NOT NULL FOR UPDATE OF e`;
      if (!rows.length)
        throw new DomainError(
          "invalid_evidence",
          "Loaded execution and its assistant result source required",
          409,
        );
      const prior =
        await tx`SELECT * FROM assistant.skill_execution_checks WHERE id=${body.client_check_id}`;
      if (prior[0]) {
        const saved = prior[0];
        if (
          saved["workspace_id"] !== workspace ||
          saved["execution_id"] !== execution ||
          saved["criterion"] !== body.criterion ||
          saved["observed"] !== body.observed ||
          saved["status"] !== body.status ||
          saved["source_message_id"] !== body.source_message_id
        )
          throw new DomainError("idempotency_conflict", "Check key reused", 409);
        return saved;
      }
      return (
        await tx`INSERT INTO assistant.skill_execution_checks(id,workspace_id,execution_id,criterion,observed,status,source_message_id) VALUES(${body.client_check_id},${workspace},${execution},${body.criterion},${body.observed},${body.status},${body.source_message_id}) RETURNING *`
      )[0];
    });
    return c.json({ check: result }, 201);
  });
  return app;
}
