import { z } from "zod";
import { ScreenError } from "./protocol";
export type ScreenStage =
  | "frame_parse"
  | "peer_close"
  | "peer_create"
  | "signal_apply"
  | "offer_remote_description"
  | "answer_create"
  | "answer_local_description"
  | "answer_send"
  | "ice_add";
const known = new Map([
  ["m line not found", "sdp_media_missing"],
  ["invalid sessionDescription", "sdp_invalid"],
  ["invalid media kind", "sdp_media_invalid"],
  ["remote fingerprint not exist", "dtls_fingerprint_missing"],
  ["no supported remote fingerprint algorithms", "dtls_fingerprint_unsupported"],
  ["remote certificate fingerprint mismatch", "dtls_fingerprint_mismatch"],
  ["candidate is required", "ice_candidate_required"],
  ["RTCIceTransport is closed", "ice_closed"],
  ["createAnswer failed", "answer_failed"],
]);
export function screenFailure(
  error: Error,
  context: {
    readonly stage: ScreenStage;
    readonly frame?: "offer" | "ice" | "peer_left" | "peer_ready" | "peer_waiting";
    readonly empty_candidate?: boolean;
  },
) {
  const code =
    error instanceof ScreenError && ["invalid_signal", "answer_unavailable"].includes(error.code)
      ? error.code
      : known.get(error.message);
  return {
    event: "screen.signaling.failed",
    ...context,
    type:
      error instanceof ScreenError
        ? "ScreenError"
        : error instanceof z.ZodError
          ? "ZodError"
          : error instanceof SyntaxError
            ? "SyntaxError"
            : error instanceof TypeError
              ? "TypeError"
              : error instanceof RangeError
                ? "RangeError"
                : "Error",
    ...(code ? { code } : {}),
  };
}
