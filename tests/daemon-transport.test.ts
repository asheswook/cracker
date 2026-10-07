import { expect, test } from "bun:test";
import { parseDaemonConfig } from "../services/daemon/main";

const environment = {
  CONTROL_URL: "https://control.example",
  VM_TOKEN: "fixture-vm-token",
  PROVIDER_MODE: "api",
  OPENAI_MODEL: "gpt-6-astra",
  OPENAI_API_KEY: "fixture-api-key",
};

test("an explicit unsupported transport fails before daemon startup", () => {
  const configured = { ...environment, OPENAI_TRANSPORT: "udp" };
  expect(() => parseDaemonConfig(configured)).toThrow();
});

test("a socket option cannot change a ChatGPT account into API mode", () => {
  const configured = {
    ...environment,
    PROVIDER_MODE: "chatgpt",
    CHATGPT_TOKEN_FILE: "/private/fixture.json",
    OPENAI_TRANSPORT: "websocket",
  };
  const parsed = parseDaemonConfig(configured);
  expect(parsed.PROVIDER_MODE).toBe("chatgpt");
  expect(parsed.OPENAI_TRANSPORT).toBe("websocket");
  expect(parsed.CHATGPT_TOKEN_FILE).toBe("/private/fixture.json");
});

test("HTTP remains the default transport in either authentication mode", () => {
  expect(parseDaemonConfig(environment).OPENAI_TRANSPORT).toBe("http");
  expect(parseDaemonConfig({...environment, PROVIDER_MODE:"chatgpt", CHATGPT_TOKEN_FILE:"/private/fixture.json"}).OPENAI_TRANSPORT).toBe("http");
});
