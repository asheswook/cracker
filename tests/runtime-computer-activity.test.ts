import { expect, test } from "bun:test";
import { computerActivityTool } from "../services/daemon/runtime";

test("computer activity covers desktop, computer and shared-browser tools, including read-only looks", () => {
  for (const name of ["computer", "computer_exec", "desktop_list_apps", "desktop_get_app_state", "desktop_click", "browser_snapshot", "browser_click"])
    expect(computerActivityTool(name)).toBe(true);
  for (const name of ["shell", "save_skill", "search_prior_work", "notify_user", "web_search"])
    expect(computerActivityTool(name)).toBe(false);
});
