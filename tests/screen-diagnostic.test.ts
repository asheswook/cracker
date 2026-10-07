import { expect, test } from "bun:test";
import { screenFailure } from "../packages/screen/diagnostic";
import { ScreenError } from "../packages/screen/protocol";

test("screen diagnostic reports fixed category/stage and empty candidate without raw data", () => {
  const error = new TypeError("secret SDP candidate token");
  error.name = "secret-value";
  expect(screenFailure(error, { stage: "ice_add", frame: "ice", empty_candidate: true })).toEqual({
    event: "screen.signaling.failed",
    stage: "ice_add",
    frame: "ice",
    empty_candidate: true,
    type: "TypeError",
  });
  expect(
    screenFailure(new Error("remote fingerprint not exist"), { stage: "offer_remote_description" })
      .code,
  ).toBe("dtls_fingerprint_missing");
  expect(
    screenFailure(new ScreenError("secret-value"), { stage: "frame_parse" }).code,
  ).toBeUndefined();
});
