window.fixture = {
  mode: new URLSearchParams(location.search).get('mode') || 'hold',
  calls: [], pending: [], events: 0,
  state: { version: 1, platform: 'ios', installation_id: '77777777-7777-4777-8777-777777777777', configured: true, permission: 'default', token: null },
  update() {
    const output = document.querySelector('#fixture-counts');
    if (output) output.textContent = JSON.stringify({ mode: this.mode, calls: this.calls, events: this.events, pending: this.pending.length }, null, 2);
  },
  event(count = 1) {
    for (let i = 0; i < count; i++) { this.events++; dispatchEvent(new Event('assistant-native-notification-state')); }
    this.update();
  },
  success() { this.mode = 'success'; this.event(); },
  fail() { this.pending.shift()?.reject(new Error('synthetic rejection')); this.update(); },
  release() { this.pending.shift()?.resolve({ ...this.state }); this.update(); },
  hold() { this.mode = 'hold'; this.event(); },
  controls() {
    const panel = document.createElement('aside');
    panel.id = 'fixture-controls';
    panel.style = 'position:fixed;bottom:0;right:0;z-index:10000;background:#fff;color:#111;border:2px solid #333;padding:12px;max-width:380px;font:12px monospace;max-height:230px;overflow:auto';
    panel.innerHTML = '<strong>SYNTHETIC BRIDGE / REAL 30s DEADLINE</strong><p>Held requests time out naturally. Success sends a new state event.</p><button id="fixture-success">Success + event</button> <button id="fixture-event">Queue event</button> <button id="fixture-fail">Reject held request</button> <button id="fixture-hold">Hold + event</button> <button id="fixture-release">Release held success</button><pre id="fixture-counts"></pre>';
    document.body.append(panel);
    document.querySelector('#fixture-success').onclick = () => this.success();
    document.querySelector('#fixture-event').onclick = () => this.event();
    document.querySelector('#fixture-fail').onclick = () => this.fail();
    document.querySelector('#fixture-hold').onclick = () => this.hold();
    document.querySelector('#fixture-release').onclick = () => this.release();
    this.update();
  },
};
window.webkit = { messageHandlers: { assistantNative: { postMessage({ method }) {
  fixture.calls.push({ method, at: performance.now() });
  fixture.update();
  if (method === 'ready') return new URLSearchParams(location.search).has('readyError') ? Promise.reject(new Error('synthetic ready failure')) : Promise.resolve(null);
  if (method !== 'getNotificationState') return Promise.resolve(null);
  if (fixture.mode === 'success') return Promise.resolve({ ...fixture.state });
  if (fixture.mode === 'fail') return Promise.reject(new Error('synthetic status failure'));
  return new Promise((resolve, reject) => { fixture.pending.push({ resolve, reject }); fixture.update(); });
} } } };
