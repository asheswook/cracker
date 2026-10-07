import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AppearanceSettings, AppearanceUpdate } from '../../../packages/appearance/schema';
import { DomainError } from '../../../packages/protocol';
import type { AppEnv } from '../auth';
import type { Database } from '../db';

export function appearanceRoutes(sql: Database) {
  const app = new Hono<AppEnv>();
  app.use('/appearance', bodyLimit({ maxSize: 4096,
    onError: c => c.json({ error: { code: 'body_too_large', message: 'Appearance request exceeds limit' } }, 413),
  }));
  app.get('/appearance', async c => {
    const rows = await sql`SELECT appearance,appearance_revision AS revision FROM assistant.workspaces WHERE id=${c.get('principal').workspace_id}`;
    if (!rows[0]) throw new DomainError('not_found', 'Workspace not found', 404);
    c.header('Cache-Control', 'no-store');
    return c.json(AppearanceSettings.parse(rows[0]));
  });
  app.put('/appearance', async c => {
    const body = AppearanceUpdate.parse(await c.req.json());
    const workspace = c.get('principal').workspace_id;
    const result = await sql.begin(async tx => {
      const rows = await tx`SELECT appearance,appearance_revision AS revision FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`;
      if (!rows[0]) throw new DomainError('not_found', 'Workspace not found', 404);
      const current = AppearanceSettings.parse(rows[0]);
      if (JSON.stringify(body.appearance) === JSON.stringify(current.appearance))
        return { body: current, status: 200 as const };
      if (body.expected_revision !== current.revision)
        return { body: { error: { code: 'appearance_conflict', message: 'Appearance changed on another device' }, current }, status: 409 as const };
      const updated = await tx`UPDATE assistant.workspaces SET appearance=${JSON.stringify(body.appearance)}::text::jsonb,appearance_revision=gen_random_uuid() WHERE id=${workspace} RETURNING appearance,appearance_revision AS revision`;
      return { body: AppearanceSettings.parse(updated[0]), status: 200 as const };
    });
    c.header('Cache-Control', 'no-store');
    return c.json(result.body, result.status);
  });
  return app;
}
