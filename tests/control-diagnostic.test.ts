import { expect, test } from "bun:test";
import ky, { HTTPError, TimeoutError } from "ky";
import { controlErrorCode, controlErrorSummary } from "../services/daemon/control-diagnostic";

async function httpError(response: Response): Promise<HTTPError> {
  try {
    await ky("https://invalid.example/private?token=secret-value", {
      retry: 0,
      headers: { Authorization: "Bearer secret-value" },
      fetch: async () => response,
    });
  } catch (error) {
    if (error instanceof HTTPError) return error;
    throw error;
  }
  throw new Error("Expected HTTPError");
}
test("logs safe HTTP status and allowlisted code without request or response secrets", async () => {
  const error = await httpError(
    Response.json(
      { error: { code: "internal_error", message: "secret-value" }, private: "secret-value" },
      { status: 500 },
    ),
  );
  expect(controlErrorSummary(error)).toEqual({
    event: "daemon.control.unavailable",
    type: "HTTPError",
    status: 500,
  });
  expect(await controlErrorCode(error)).toBe("internal_error");
  expect(JSON.stringify(controlErrorSummary(error))).not.toContain("secret-value");
  expect(await error.response.json()).toHaveProperty("private", "secret-value");
});
test("unknown code, malformed body, huge payload and hanging stream emit no body data", async () => {
  for (const body of ['{"error":{"code":"secret-value"}}', "not-json", "x".repeat(5000)]) {
    expect(
      await controlErrorCode(await httpError(new Response(body, { status: 502 }))),
    ).toBeUndefined();
  }
  const error = await httpError(
    new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 503 }),
  );
  const start = Date.now();
  expect(await controlErrorCode(error)).toBeUndefined();
  expect(Date.now() - start).toBeLessThan(1000);
});
test("network categories ignore attacker-controlled Error name and message", async () => {
  const error = new Error("secret-value");
  error.name = "secret-value";
  expect(controlErrorSummary(error).type).toBe("Error");
  expect(controlErrorSummary(new TypeError("secret-value")).type).toBe("TypeError");
  expect(
    controlErrorSummary(new TimeoutError(new Request("https://invalid.example/?secret=value")))
      .type,
  ).toBe("TimeoutError");
  expect(await controlErrorCode(error)).toBeUndefined();
});
