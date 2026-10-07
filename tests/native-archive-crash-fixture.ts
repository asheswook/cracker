import { Database } from "bun:sqlite";
import { writeSync } from "node:fs";
import { RunCheckpoint } from "../services/daemon/active-context.ts";
import { NativeContextArchive } from "../services/daemon/native-context-archive.ts";
const [path, candidatePath] = process.argv.slice(2);
if (!path || !candidatePath) throw new TypeError("fixture args");
const db = new Database(path),
  archive = new NativeContextArchive(db);
const candidate = RunCheckpoint.parse(await Bun.file(candidatePath).json());
archive.commit(candidate, new AbortController().signal, () => {
  writeSync(1, "archive insert completed; process exits before checkpoint write/commit\n");
  process.exit(73);
});
throw new TypeError("crash injection did not execute");
