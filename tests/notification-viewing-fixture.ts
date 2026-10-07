import { createNotificationFixtures } from './native-notifications-fixture';
import { config, subscription } from './notifications-fixture';

export { config, subscription };
export function createViewingFixtures() {
  const base = createNotificationFixtures({ web: config });
  return { sql: base.sql, cleanup: base.cleanup, fixture: async () => {
    const f = await base.fixture();
    return { ...f, register: () => f.app.request('/v1/notifications/subscription', {
      method: 'PUT', headers: f.headers, body: JSON.stringify({ installation_id: f.installation, subscription }),
    }) };
  } };
}
