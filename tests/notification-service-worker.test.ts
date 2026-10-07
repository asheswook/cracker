import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const script = readFileSync(
  new URL("../apps/web/public/notification-sw.js", import.meta.url),
  "utf8",
);
function fixture(windows: unknown[] = []) {
  const listeners = new Map<string, (event: unknown) => void>(),
    opened: string[] = [],
    shown: unknown[] = [];
  runInNewContext(script, {
    URL,
    SyntaxError,
    TypeError,
    self: {
      location: { origin: "https://assistant.example" },
      addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn),
      registration: {
        showNotification: async (...args: unknown[]) => {
          shown.push(args);
        },
      },
      clients: {
        matchAll: async () => windows,
        openWindow: async (url: string) => {
          opened.push(url);
        },
      },
    },
  });
  return {
    opened,
    shown,
    async fire(type: string, extra: object) {
      let work = Promise.resolve();
      listeners.get(type)?.({
        ...extra,
        waitUntil: (promise: Promise<void>) => {
          work = promise;
        },
      });
      await work;
    },
  };
}
test("notification result focuses and messages existing app without reloading pending drafts", async () => {
  const messages: unknown[] = [],
    url =
      "/?conversation=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&message=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let focused = 0,
    navigated = 0;
  const f = fixture([
    {
      url: "https://assistant.example/",
      focus: async () => {
        focused++;
      },
      navigate: async () => {
        navigated++;
      },
      postMessage: (data: unknown) => messages.push(data),
    },
  ]);
  await f.fire("notificationclick", { notification: { data: { url }, close() {} } });
  expect(focused).toBe(1);
  expect(navigated).toBe(0);
  expect(messages).toEqual([{ type: "assistant-result", url }]);
  expect(f.opened).toEqual([]);
});
test("notification links reject cross-origin/unexpected paths and preserve message presentation", async () => {
  const f = fixture([
    {
      url: "https://assistant.example/other",
      focus() {
        throw new Error("wrong surface");
      },
    },
  ]);
  await f.fire("notificationclick", {
    notification: { data: { url: "https://attacker.example/" }, close() {} },
  });
  expect(f.opened).toEqual(["https://assistant.example/"]);
  await f.fire("push", {
    data: {
      json: () => ({ title: "private secret", body: "private content", url: "/?token=secret" }),
    },
  });
  expect(JSON.stringify(f.shown)).not.toContain("token=");
  expect(f.shown).toEqual([
    [
      "private secret",
      {
        body: "private content",
        tag: "assistant-result",
        renotify: false,
        data: { url: "/" },
      },
    ],
  ]);
});

test("content-hidden push preserves sender and neutral body", async () => {
  const f = fixture();
  const url = "/?conversation=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&message=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await f.fire("push", { data: { json: () => ({ title: "내 비서", body: "새 메시지", url }) } });
  expect(f.shown).toEqual([["내 비서", { body: "새 메시지", tag: "assistant-result", renotify: false, data: { url } }]]);
});
