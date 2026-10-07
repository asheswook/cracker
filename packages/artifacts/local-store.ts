import { chmod, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DomainError } from "../protocol";
import type { ArtifactStorageMetadata, ArtifactStore, StoredArtifact } from "./store";

const Key = z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}
  async put(
    key: string,
    body: ReadableStream<Uint8Array>,
    metadata: ArtifactStorageMetadata,
  ): Promise<void> {
    const target = join(this.root, Key.parse(key)),
      temp = `${target}.${crypto.randomUUID()}.tmp`;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      const writer = Bun.file(temp).writer();
      const reader = body.getReader();
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          writer.write(part.value);
          size += part.value.byteLength;
          await writer.flush();
        }
      } finally { reader.releaseLock(); await writer.end(); }
      await chmod(temp, 0o600);
      if (size !== metadata.bytes)
        throw new DomainError("storage_size_mismatch", "Stored file size differs", 503);
      await rename(temp, target);
    } catch (error) {
      await this.removeFile(temp);
      throw error;
    }
  }
  async get(key: string): Promise<StoredArtifact | null> {
    const file = Bun.file(join(this.root, Key.parse(key)));
    if (!(await file.exists())) return null;
    return { body: file.stream(), size: file.size };
  }
  async delete(key: string): Promise<void> {
    await this.removeFile(join(this.root, Key.parse(key)));
  }
  private async removeFile(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}
