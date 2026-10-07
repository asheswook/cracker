export { MAX_ARTIFACT_BYTES, WORKSPACE_ARTIFACT_BYTES } from './limits';
export type StoredArtifact = { readonly body: ReadableStream<Uint8Array>; readonly size: number };
export type ArtifactStorageMetadata = {
  readonly bytes: number;
  readonly mediaType: string;
  readonly sha256: string;
};
export interface ArtifactStore {
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    metadata: ArtifactStorageMetadata,
  ): Promise<void>;
  get(key: string): Promise<StoredArtifact | null>;
  delete(key: string): Promise<void>;
}
