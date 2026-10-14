import { expect, test } from "bun:test";
import { parseAtSpiBus, desktopTool, desktopReadOnly, desktopResult } from "../services/daemon/builtin-desktop";
import { desktopCapture } from "../services/daemon/runtime";

test("parses the X root AT-SPI address without accepting missing or unrelated properties", () => {
  expect(parseAtSpiBus('AT_SPI_BUS(STRING) = "unix:path=/run/user/1000/at-spi/bus_99"\n')).toBe("unix:path=/run/user/1000/at-spi/bus_99");
  for (const output of ['AT_SPI_BUS:  no such atom on any window.', 'AT_SPI_BUS(STRING) = ""', 'OTHER(STRING) = "unix:path=/tmp/bus"', 'AT_SPI_BUS(STRING) = unix:path=/tmp/bus']) expect(parseAtSpiBus(output)).toBeUndefined();
});

test("prefixes provider tools and preserves schemas and MCP descriptions", () => {
  const inputSchema = { type: "object", properties: { app: { type: "string" } }, required: ["app"] };
  expect(desktopTool({ name: "click", description: "Click an element", inputSchema })).toEqual({ type: "function", name: "desktop_click", description: "Click an element", strict: false, parameters: inputSchema });
  expect(desktopTool({ name: "get_app_state", description: "Original description", inputSchema }).description).toBe("Returns the window's accessibility tree with element indexes plus a screenshot; prefer element_index targets over coordinates. Original description");
});

test("only desktop observations are read-only; captures include state and mutations", () => {
  for (const name of ["list_apps", "get_app_state", "query"]) expect(desktopReadOnly(`desktop_${name}`)).toBe(true);
  for (const name of ["click", "drag", "perform_secondary_action", "press_key", "scroll", "set_value", "type_text", "future_action"]) {
    expect(desktopReadOnly(`desktop_${name}`)).toBe(false);
    expect(desktopCapture(`desktop_${name}`)).toBe(true);
  }
  for (const name of ["computer", "computer_exec", "desktop_get_app_state"]) expect(desktopCapture(name)).toBe(true);
  for (const name of ["desktop_list_apps", "desktop_query", "browser_snapshot", "shell"]) expect(desktopCapture(name)).toBe(false);
});

test("extracts images as data URLs and retains non-image output and error state", () => {
  const result = desktopResult({ isError: true, content: [{ type: "text", text: "tree" }, { type: "image", data: "cG5n", mimeType: "image/png" }, { type: "image", data: "anBn", mimeType: "image/jpeg" }, { type: "image", data: "missing mime" }] });
  expect(result.images).toEqual(["data:image/png;base64,cG5n", "data:image/jpeg;base64,anBn"]);
  expect(JSON.parse(result.text)).toEqual({ isError: true, content: [{ type: "text", text: "tree" }] });
  expect(desktopResult({ content: [] })).toEqual({ text: '{"isError":false,"content":[]}', images: [] });
});

test("truncates text beyond 100000 characters without dropping images", () => {
  const result = desktopResult({ content: [{ type: "text", text: "x".repeat(100001) }, { type: "image", data: "cG5n", mimeType: "image/png" }] });
  expect(JSON.parse(result.text).truncated).toBe(true);
  expect(JSON.parse(result.text).output.length).toBe(100000);
  expect(result.images).toEqual(["data:image/png;base64,cG5n"]);
});
