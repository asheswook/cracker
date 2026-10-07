import { z } from "zod";

const source = new URL("../../services/control/worker.ts", import.meta.url);
const module = z.object({ default: z.object({ fetch: z.custom<(
  request: Request,
  environment: object,
  context: { waitUntil(work: Promise<unknown>): void },
) => Promise<Response>>((value) => typeof value === "function") }) }).parse(await import(source.href));
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env["PORT"]),
  fetch: async (request) => {
    const pending: Promise<unknown>[] = [];
    const response = await module.default.fetch(request, {
      DATABASE: { connectionString: process.env["DATABASE_URL"] },
      SCREEN_TURN_KEY_ID: process.env["SCREEN_TURN_KEY_ID"],
      SCREEN_TURN_API_TOKEN: process.env["SCREEN_TURN_API_TOKEN"],
    }, { waitUntil: (work) => pending.push(work) });
    await Promise.all(pending);
    return response;
  },
});
console.log(`Worker fixture listening on ${server.url}`);
