import { Hono } from "hono";
import { z } from "zod";
import { DaemonEvent, DaemonPoll, Id, PriorWorkRequest, RecoverySummary } from "../../../packages/protocol";
import type { AppEnv } from "../auth";
import type { Database } from "../db";
import { applyEvent } from "../repository/daemon-events";
import { workContext, workMailbox, priorWork, taskSources } from "../repository/task-context";
import { context, mailbox, poll } from "../repository/runs";
import { enrollSchedule, ScheduleRequest } from "../repository/schedule-enrollment";
import { resumeRun } from "../repository/resume";
import {ComposingRequest} from "../../../packages/protocol/composing";
import {updateComposing} from "../repository/composing";
import { ComputerControlRequest, requestComputerControl } from "../repository/message-control";
import { NotifyUserRequest, notifyUser } from "../repository/notify-user";
import { SessionRegistration } from '../../../packages/protocol/parallel-runs';
import { acceptOffer, registerSession, fenceSession } from '../repository/daemon-session';
export function daemonRoutes(sql: Database, semanticEnabled = false, structureMode:'off'|'shadow'|'on'='off',treeMode:'off'|'shadow'|'on'='off') {
  const app = new Hono<AppEnv>();
  app.post('/session',async c=>{
    const request=SessionRegistration.parse(await c.req.json());
    return c.json(await sql.begin(tx=>registerSession(tx,c.get('principal'),request)));
  });
  app.post('/accept/:id',async c=>c.json(await sql.begin(tx=>acceptOffer(tx,c.get('principal'),c.get('principal').daemon_session_id,Id.parse(c.req.param('id'))))));
  app.post("/notify-user", async c => {
    const request = NotifyUserRequest.parse(await c.req.json());
    return c.json(await sql.begin(tx => notifyUser(tx, c.get("principal"), request)));
  });
  app.post("/computer-control", async c => {
    const request = ComputerControlRequest.parse(await c.req.json());
    return c.json(await sql.begin(tx => requestComputerControl(tx, c.get("principal"), request)));
  });
  app.post("/composing",async c=>{
    const event=ComposingRequest.parse(await c.req.json());
    return c.json(await sql.begin(tx=>updateComposing(tx,c.get("principal"),event)));
  });
  app.post("/resume/:id", async (c) => {
    const text = await c.req.text();
    const request = z.object({ checkpoint_cursor: z.number().int().nonnegative().optional(), recovery:RecoverySummary.optional(), desktop_control_scoped: z.boolean().default(false) }).refine(value=>!(value.recovery&&value.checkpoint_cursor!==undefined)).parse(text ? JSON.parse(text) : {});
    const assignment = await sql.begin(tx => resumeRun(tx, c.get("principal"), Id.parse(c.req.param("id")), request.checkpoint_cursor, request.desktop_control_scoped, request.recovery));
    return c.json({ assignment: {...assignment, ...(semanticEnabled ? {semantic_context_enabled: true} : {}),semantic_structure_mode:structureMode,...(treeMode!=='off'?{knowledge_tree_mode:treeMode}:{})} });
  });
  app.get("/poll", async (c) => {
    const run = Id.optional().parse(c.req.query("run_id"));
    const view = z.enum(["full", "commands", "work"]).parse(c.req.query("view") ?? "full");
    const scoped = z.enum(["true", "false"]).optional().parse(c.req.query("desktop_control_scoped")) === "true";
    const result = DaemonPoll.parse(await sql.begin((tx) => poll(tx, c.get("principal"), run, view, scoped)));
    if (semanticEnabled && result.assignment) result.assignment.semantic_context_enabled = true;
    if(result.assignment){result.assignment.semantic_structure_mode=structureMode;if(treeMode!=='off')result.assignment.knowledge_tree_mode=treeMode;}
    return c.json(result);
  });
  app.get("/context/:id", async (c) => {
    const id = Id.parse(c.req.param("id")),
      after = z.coerce
        .number()
        .int()
        .min(0)
        .parse(c.req.query("after") ?? 0);
    const view = z.enum(["full", "mailbox", "work", "work_mailbox", "task_sources"]).parse(c.req.query("view") ?? "full");
    if (view === "work") {
      const assignment = await sql.begin(tx => workContext(tx,c.get("principal"),id));
      return c.json({...assignment, ...(semanticEnabled ? {semantic_context_enabled: true} : {}),semantic_structure_mode:structureMode,...(treeMode!=='off'?{knowledge_tree_mode:treeMode}:{})});
    }
    if (view === "work_mailbox") return c.json(await sql.begin('read only',tx => workMailbox(tx,c.get("principal"),id,after)));
    if (view === "task_sources") return c.json(await sql.begin(tx => taskSources(tx,c.get("principal"),id,after)));
    if (view === "mailbox")
      return c.json(await sql.begin((tx) => mailbox(tx, c.get("principal"), { runId: id, after })));
    const result = await sql.begin((tx) => context(tx, c.get("principal"), id, after));
    return c.json({
      messages: result.messages,
      instructions: result.instructions,
      persona: result.persona,
      memory: result.memory,
    });
  });
  app.post("/context/:id/prior-work", async c => {
    const id=Id.parse(c.req.param("id")), request=PriorWorkRequest.parse(await c.req.json());
    return c.json(await sql.begin(tx=>priorWork(tx,c.get("principal"),id,request)));
  });
  app.post("/schedules", async (c) =>
    c.json({
      schedule: await enrollSchedule(
        sql,
        c.get("principal"),
        ScheduleRequest.parse(await c.req.json()),
      ),
    }),
  );
  app.post("/events", async (c) => {
    const event = DaemonEvent.parse(await c.req.json());
    await sql.begin((tx) => applyEvent(tx, c.get("principal"), event));
    return c.json({ accepted: true });
  });
  return app;
}
