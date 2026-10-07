import assert from 'node:assert/strict';
const origin = process.env.FOREGROUND_FIXTURE_ORIGIN;
assert(origin, 'FOREGROUND_FIXTURE_ORIGIN is required');
process.argv[2] = origin;
await import('./notification-cross-device.browser.mjs');
