import { PersistentDesktop } from "../../services/daemon/desktop-session";

const directory = process.argv[2];
if (!directory) throw new Error("Missing test workspace");
const session = new PersistentDesktop();
await session.reset(directory);
await session.run(
  JSON.stringify({
    code: `
const native=state.constructor.constructor("return process")();
const child=native.getBuiltinModule("node:child_process").spawn("xdotool",["mousedown","1","sleep","60"],{stdio:"ignore"});
native.getBuiltinModule("node:fs").writeFileSync("worker.json",JSON.stringify({worker:native.pid,child:child.pid}));
while(true){}
`,
    timeout_ms: 15000,
  }),
  new AbortController().signal,
);
