import ky from "ky";
import { z } from "zod";

const config = await Bun.file("infra/provision/.dev.vars").text();
const token = z.string().min(32).parse(config.trim().split("=")[1]);
const payload: unknown = await Bun.file(".local/provision-request.json").json();
const result: unknown = await ky.post("http://127.0.0.1:8789/install", { headers: { Authorization: `Bearer ${token}` }, json: payload, retry: 0, timeout: 60000 }).json();
console.log(JSON.stringify(result));
