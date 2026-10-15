import { expect, test } from "bun:test";
import { activityCategory } from "../services/daemon/runtime";

test("activity categories cover built-in tools including read-only looks", () => {
  for (const name of ["computer", "computer_exec", "request_computer_control", "desktop_list_apps", "desktop_get_app_state", "desktop_click"])
    expect(activityCategory(name)).toBe("computer");
  for (const name of ["browser_snapshot", "browser_click", "browser_tabs"])
    expect(activityCategory(name)).toBe("web");
  for (const name of ["shell", "shell_start", "shell_session", "publish_artifact"])
    expect(activityCategory(name)).toBe("code");
  for (const name of ["load_skill", "save_skill", "retrieve_prior_work", "search_prior_work", "read_prior_source"])
    expect(activityCategory(name)).toBe("memory");
  for (const name of ["notify_user", "web_search", "unknown"])
    expect(activityCategory(name)).toBeNull();
});

test("MCP activity uses configured categories without inferring from tool names", () => {
  for (const category of ["web", "computer", "code", "memory"] as const)
    expect(activityCategory("mcp_cfg_fixture_browser_click_hash", category)).toBe(category);
  for (const category of ["other", null] as const)
    expect(activityCategory("mcp_cfg_fixture_browser_click_hash", category)).toBeNull();
  expect(activityCategory("unknown", "web")).toBeNull();
  expect(activityCategory("shell", "web")).toBe("code");
});
