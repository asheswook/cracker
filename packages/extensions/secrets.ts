import { z } from "zod";
import { DomainError } from "../protocol/index.ts";
const bytes = (value:string) => Uint8Array.from(atob(value),char=>char.charCodeAt(0));
const encoded = (value:Uint8Array) => btoa(Array.from(value,byte=>String.fromCharCode(byte)).join(""));
async function key(value:string|undefined) {
  if (!value) throw new DomainError("secret_storage_unavailable","MCP secret storage is not configured",503);
  const decoded = bytes(z.string().regex(/^[A-Za-z0-9+/]{43}=$/).parse(value));
  return crypto.subtle.importKey("raw",decoded,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
export async function seal(secrets:Readonly<Record<string,string>>, encryptionKey:string|undefined):Promise<string|null> {
  if (Object.keys(secrets).length===0) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({name:"AES-GCM",iv},await key(encryptionKey),new TextEncoder().encode(JSON.stringify(secrets)));
  return JSON.stringify({iv:encoded(iv),data:encoded(new Uint8Array(cipher))});
}
export async function unseal(cipher:string|null,encryptionKey:string|undefined):Promise<Record<string,string>> {
  if (!cipher) return {};
  const value=z.object({iv:z.string(),data:z.string()}).parse(JSON.parse(cipher));
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes(value.iv)},await key(encryptionKey),bytes(value.data));
  return z.record(z.string(),z.string()).parse(JSON.parse(new TextDecoder().decode(plain)));
}
