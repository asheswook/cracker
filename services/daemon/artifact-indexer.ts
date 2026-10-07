import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import ky, { HTTPError, TimeoutError } from "ky";
import { z } from "zod";
import { DocumentLease, DocumentResult } from "../../packages/artifacts/document-types.ts";
import { DocumentProcessError, parseDocument, saveDocument } from "./document-parser.ts";

const Settings = z.object({ CONTROL_URL:z.url(), VM_TOKEN:z.string().min(20), DOCUMENT_TEMP_ROOT:z.string().default("/tmp") });
const claimed = z.object({ job:DocumentLease.nullable() });
const renewed = z.object({ continue:z.boolean() });

export async function indexerPreflight(): Promise<void> {
  if (process.platform !== "linux") throw new DocumentProcessError("unavailable");
  const membership = (await readFile("/proc/self/cgroup","utf8")).split("\n").find(line => line.startsWith("0::"))?.slice(3);
  if (!membership || membership.includes("..")) throw new DocumentProcessError("unavailable");
  const directory = `/sys/fs/cgroup${membership}`;
  const [cpu,memory,tasks] = await Promise.all(["cpu.max","memory.max","pids.max"].map(name => readFile(join(directory,name),"utf8")));
  const [quota,period] = (cpu ?? "").trim().split(/\s+/).map(Number);
  if (!quota || !period || quota / period > 0.2 || !memory || Number(memory) > 268435456 || !Number.isFinite(Number(memory)) || !tasks || Number(tasks) > 16 || !Number.isFinite(Number(tasks))) throw new DocumentProcessError("unavailable");
  for (const binary of ["/usr/bin/python3","/usr/bin/pdfinfo","/usr/bin/pdftotext"]) {
    if (!await Bun.file(binary).exists()) throw new DocumentProcessError("unavailable");
  }
}

export async function runIndexer(signal: AbortSignal): Promise<void> {
  const settings = Settings.parse(process.env);
  const endpoint = new URL(settings.CONTROL_URL);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1","localhost"].includes(endpoint.hostname))) throw new DocumentProcessError("unavailable");
  const http = ky.create({ prefixUrl:settings.CONTROL_URL, headers:{ Authorization:`Bearer ${settings.VM_TOKEN}` }, timeout:10000, retry:0, redirect:"error" });
  while (!signal.aborted) {
    try {
      const job = claimed.parse(await http.post("v1/daemon/artifact-index/claim",{signal}).json()).job;
      if (job) {
        const identity = { lease_id:job.lease_id, version:job.version };
        const task = new AbortController(), done = new AbortController();
        const stop = (): void => task.abort();
        signal.addEventListener("abort",stop,{once:true});
        if (signal.aborted) task.abort();
        const renewal = (async () => {
          try {
            while (!done.signal.aborted && !task.signal.aborted) {
              await delay(1000,undefined,{signal:done.signal});
              if (!renewed.parse(await http.post(`v1/daemon/artifact-index/${job.artifact_id}/lease`,{json:identity,signal:task.signal,timeout:1000}).json()).continue) task.abort();
            }
          } catch (error) {
            if (error instanceof Error) { if (!done.signal.aborted) task.abort(); }
            else throw error;
          }
        })();
        let directory: string | undefined;
        try {
          directory = await mkdtemp(join(resolve(settings.DOCUMENT_TEMP_ROOT),"assistant-document-"));
          await chmod(directory,0o700);
          const path = join(directory,"input");
          const response = await http.get(`v1/daemon/artifact-index/${job.artifact_id}/content`,{
            signal:task.signal,headers:{"X-Document-Lease":job.lease_id,"X-Document-Version":String(job.version)},
          });
          const declaredLength = response.headers.get("Content-Length");
          if (!response.body || (declaredLength !== null && Number(declaredLength) !== job.bytes)) throw new DocumentProcessError("integrity");
          await saveDocument(response.body,{path,bytes:job.bytes,sha256:job.sha256},task.signal);
          const outcome = await parseDocument({path,directory,format:job.format},task.signal);
          const result = outcome.code === "parser_unavailable"
            ? DocumentResult.parse({...identity,kind:"retry",code:"parser_unavailable"})
            : DocumentResult.parse({...identity,...outcome,sha256:job.sha256});
          done.abort(); await renewal;
          task.signal.throwIfAborted();
          await http.post(`v1/daemon/artifact-index/${job.artifact_id}/result`,{json:result,signal,retry:{limit:2,methods:["post"]}});
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          done.abort(); await renewal;
          if (!task.signal.aborted && !signal.aborted) {
            const code = error instanceof DocumentProcessError && error.code === "integrity" ? "integrity" : error instanceof DocumentProcessError ? "parser_unavailable" : "transport";
            await http.post(`v1/daemon/artifact-index/${job.artifact_id}/result`,{json:{...identity,kind:"retry",code},signal});
          }
        } finally {
          done.abort(); task.abort(); await renewal;
          signal.removeEventListener("abort",stop);
          if (directory) await rm(directory,{recursive:true,force:true});
        }
      }
    } catch (error) {
      if (signal.aborted) break;
      if (!(error instanceof HTTPError || error instanceof TimeoutError || error instanceof DocumentProcessError || error instanceof TypeError)) throw error;
      console.error(JSON.stringify({event:"document_index.retry",type:error.name}));
    }
    try { await delay(5000 + Math.floor(Math.random()*1000),undefined,{signal}); }
    catch (error) { if (!(error instanceof Error && error.name === "AbortError")) throw error; }
  }
}

if (import.meta.main) {
  const shutdown = new AbortController();
  process.once("SIGTERM",() => shutdown.abort());
  process.once("SIGINT",() => shutdown.abort());
  try {
    await indexerPreflight();
    if (!process.argv.includes("--preflight")) await runIndexer(shutdown.signal);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(JSON.stringify({event:"document_index.stopped",type:error.name}));
    process.exitCode = 1;
  }
}
