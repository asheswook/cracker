import type { KyInstance } from "ky";
import { semanticReference, secondaryReferenceContexts } from "../../packages/context/reference.ts";
import { z } from "zod";
import { LinkResult, NotesResult, PrepareResult, SemanticContext, SemanticRetentionResult, type SemanticChoice } from "../../packages/context/schema.ts";
import type { Provider, ResponseInputItem } from "../../packages/provider/index.ts";
import { SemanticModel, SemanticModelError } from "./semantic-context-model.ts";
import type { SemanticCheckpoint } from "./semantic-context-state.ts";

const Snapshot = z.object({ context: SemanticContext });
export class SemanticIndexError extends Error {
  constructor(readonly code: "retrieval_unavailable" | "source_boundary_unavailable") { super(code); this.name = "SemanticIndexError"; }
}
export class SemanticContexts {
  private state: SemanticCheckpoint;
  private readonly model: SemanticModel;
  constructor(private readonly scope: { readonly http: KyInstance; readonly runId: string; readonly taskId: string; readonly provider: Provider; readonly mode?: "live" | "backfill"; readonly endpoint?: string; readonly deliveryIds?: boolean; readonly persist?: () => void }, checkpoint?: SemanticCheckpoint) {
    this.state = { ...(checkpoint ?? { active: null, pending: [], fresh_sources: [] }), delivery_ids: scope.deliveryIds ?? checkpoint?.delivery_ids ?? !checkpoint };
    this.model = new SemanticModel(scope.provider);
  }
  checkpoint(): SemanticCheckpoint { return this.state; }
  get tracksDeliveryIds(): boolean { return this.state.delivery_ids === true; }
  get contextId(): string | undefined { return this.state.active?.context_id; }
  get sourceMessageId(): string | undefined { return this.state.active?.message_id; }
  get finalCursor(): number | undefined { return this.state.final_cursor; }
  private path(action: string): string { return `${this.scope.endpoint ?? `v1/daemon/context/${this.scope.runId}/semantic`}/${action}`; }
  async select(messageId: string, signal: AbortSignal): Promise<ResponseInputItem> {
    const primary = await this.index(messageId, signal);
    return this.reference(primary, signal, messageId);
  }
  async index(messageId: string, signal: AbortSignal): Promise<z.infer<typeof SemanticContext> | null> {
    const { reference: _reference, ...withoutReference } = this.state; this.state = withoutReference;
    const request = { message_id: messageId, mode: this.scope.mode ?? "live" };
    let prepared = PrepareResult.parse(await this.scope.http.post(this.path("prepare"), { json: request, signal }).json());
    while (prepared.retention_context.sources.length) {
      const assessment = await this.model.retention(prepared.retention_context, signal);
      SemanticRetentionResult.parse(await this.scope.http.post(this.path("retention"), { json: { ...request, assessment }, signal }).json());
      prepared = PrepareResult.parse(await this.scope.http.post(this.path("prepare"), { json: request, signal }).json());
    }
    if (prepared.decision?.model === "retrieval-unavailable") throw new SemanticIndexError("retrieval_unavailable");
    const { final_cursor: _final, ...previous } = this.state;
    this.state = { ...previous, active: null };
    if (!prepared.source.retention_allowed) return null;
    const fresh = !prepared.linked || this.state.unindexed?.includes(messageId);
    if (fresh && !this.state.unindexed?.includes(messageId)) {
      this.state = { ...this.state, unindexed: [...(this.state.unindexed ?? []), messageId] };
      this.scope.persist?.();
    }
    const linked = prepared.candidates.find(context => context.context_id === prepared.linked?.context_id);
    let context = linked;
    let selectionStatus: "confirmed" | "provisional" | "none" = prepared.linked?.status ?? "none";
    if (!context) {
      let choice: z.infer<typeof SemanticChoice>;
      let status: "provisional" | "confirmed" = "confirmed";
      const suggested = prepared.decision?.outcome === "existing" ? prepared.candidates.find(candidate => candidate.context_id === prepared.decision?.context_id) : undefined;
      if (suggested) choice = { kind: "existing", context_id: suggested.context_id, expected_context_revision: suggested.revision };
      else {
        try {
          const result = await this.model.route(prepared, signal);
          const existing = prepared.candidates.find(candidate => candidate.context_id === result.context_id);
          choice = existing ? { kind: "existing", context_id: existing.context_id, expected_context_revision: existing.revision } : { kind: "new", title: result.title, scope: result.scope };
          status = result.confirmed && prepared.decision?.outcome !== "uncertain" ? "confirmed" : "provisional";
        } catch (error) {
          if (!(error instanceof SemanticModelError)) throw error;
          choice = { kind: "new", title: "Unclassified conversation", scope: "Topic selection is provisional; inspect the original source before reusing this context." };
          status = "provisional";
        }
      }
      const quote = prepared.source.content.slice(0, 1000) || prepared.source.attachments[0]?.name;
      if (!quote) {
        this.state = { ...this.state, reference: { message_id: messageId, source_sha256: prepared.source.sha256, primary_context_id: null, primary_retrieval: { note_ids: [], source_windows: [] }, selection: { status: "none", uncertain: true }, alternatives: secondaryReferenceContexts(prepared.candidates, null).map(candidate => ({ context_id: candidate.context_id, ...candidate.retrieval })) } };
        return null;
      }
      const retrieval = choice.kind === "existing" ? prepared.candidates.find(candidate => candidate.context_id === choice.context_id)?.retrieval : undefined;
      if (choice.kind === "existing" && retrieval) { this.rememberNotes(choice.context_id, retrieval.note_ids); this.scope.persist?.(); }
      const result = LinkResult.parse(await this.scope.http.post(this.path("link"), { json: {
        operation_id: crypto.randomUUID(), message_id: messageId, mode: this.scope.mode ?? "live", source_sha256: prepared.source.sha256,
        expected_link_revision: prepared.linked?.revision ?? 0, choice, status, evidence: [{ message_id: messageId, quote }],
        ...retrieval,
      }, signal }).json());
      context = result.context; selectionStatus = result.link.status;
    }
    this.state = { ...this.state, reference: { message_id: messageId, source_sha256: prepared.source.sha256, primary_retrieval: context.retrieval, primary_context_id: context.context_id, selection: { status: selectionStatus, uncertain: prepared.decision?.outcome === "uncertain" || selectionStatus !== "confirmed" }, alternatives: secondaryReferenceContexts(prepared.candidates, context.context_id).map(candidate => ({ context_id: candidate.context_id, ...candidate.retrieval })) } };
    this.rememberNotes(context.context_id, context.retrieval.note_ids);
    if (fresh) this.rememberSource(context.context_id, messageId);
    this.state = { ...this.state, active: { context_id: context.context_id, message_id: messageId }, fresh_sources: this.state.fresh_sources ?? [], unindexed: this.state.unindexed?.filter(id => id !== messageId) ?? [] };
    this.scope.persist?.();
    return context;
  }
  private async reference(primary: z.infer<typeof SemanticContext> | null, signal: AbortSignal, messageId?: string): Promise<ResponseInputItem> {
    const reference = this.state.reference;
    const snapshots = await Promise.allSettled((reference?.alternatives ?? []).map(async candidate => Snapshot.parse(await this.scope.http.post(this.path("snapshot"), { json: { ...candidate, mode: this.scope.mode ?? "live" }, signal }).json()).context));
    signal.throwIfAborted();
    const alternatives: z.infer<typeof SemanticContext>[] = [], unavailable: string[] = [];
    for (const [index, result] of snapshots.entries()) {
      if (result.status === "fulfilled" && result.value.context_id === reference?.alternatives[index]?.context_id) alternatives.push(result.value);
      else { const id = reference?.alternatives[index]?.context_id; if (id) unavailable.push(id); }
    }
    return { role: "user", content: JSON.stringify(semanticReference({ message_id: reference?.message_id ?? messageId ?? null, ...(reference ? { source_sha256: reference.source_sha256 } : {}), primary, alternatives, selection: reference?.selection ?? { status: "none", uncertain: true }, unavailable_context_ids: unavailable })) };
  }
  async refreshReference(signal: AbortSignal): Promise<ResponseInputItem | null> {
    const reference = this.state.reference;
    if (!reference) return null;
    try {
      const prepared = PrepareResult.parse(await this.scope.http.post(this.path("prepare"), { json: { message_id: reference.message_id, mode: this.scope.mode ?? "live" }, signal }).json());
      if (!prepared.source.retention_allowed || prepared.source.sha256 !== reference.source_sha256) {
        const { reference: _reference, ...rest } = this.state; this.state = { ...rest, active: null };
        return { role: "user", content: JSON.stringify(semanticReference({ message_id: reference.message_id, primary: null, alternatives: [], selection: { status: "none", uncertain: true } })) };
      }
      let primary = prepared.candidates.find(candidate => candidate.context_id === prepared.linked?.context_id) ?? null;
      if (primary?.context_id === reference.primary_context_id && (reference.primary_retrieval.note_ids.length || reference.primary_retrieval.source_windows.length)) primary = Snapshot.parse(await this.scope.http.post(this.path("snapshot"), { json: { context_id: primary.context_id, ...reference.primary_retrieval, mode: this.scope.mode ?? "live" }, signal }).json()).context;
      this.state = { ...this.state, active: primary ? { context_id: primary.context_id, message_id: reference.message_id } : null, reference: { ...reference, primary_context_id: primary?.context_id ?? null, primary_retrieval: primary?.retrieval ?? { note_ids: [], source_windows: [] }, alternatives: reference.alternatives.filter(candidate => candidate.context_id !== primary?.context_id), selection: { status: prepared.linked?.status ?? "none", uncertain: reference.selection.uncertain || prepared.linked?.status !== "confirmed" } } };
      return this.reference(primary, signal);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      signal.throwIfAborted();
      const { reference: _reference, ...rest } = this.state; this.state = { ...rest, active: null };
      return { role: "user", content: JSON.stringify(semanticReference({ message_id: reference.message_id, source_sha256: reference.source_sha256, primary: null, alternatives: [], selection: { status: "none", uncertain: true }, unavailable_context_ids: [...(reference.primary_context_id ? [reference.primary_context_id] : []), ...reference.alternatives.map(candidate => candidate.context_id)] })) };
    }
  }

  private rememberNotes(contextId: string, selected: readonly string[]): void {
    const remembered = this.state.retrieved_notes ?? [];
    const noteIds = [...new Set([...selected, ...(remembered.find(item => item.context_id === contextId)?.note_ids ?? [])])].slice(0, 16);
    if (noteIds.length) {
      const next = [{ context_id: contextId, note_ids: noteIds }, ...remembered.filter(item => item.context_id !== contextId)];
      this.state = { ...this.state, retrieved_notes: [...next.filter(item => this.state.pending.includes(item.context_id)), ...next.filter(item => !this.state.pending.includes(item.context_id))].slice(0, 100) };
    }
  }
  private rememberSource(contextId: string, messageId: string): void {
    const sources = this.state.fresh_sources ?? [], current = sources.find(item => item.context_id === contextId);
    const ids = [...new Set([...(current?.message_ids ?? []), messageId])];
    if (ids.length > 2000 || (!current && sources.length >= 100)) throw new SemanticModelError("invalid_metadata");
    this.state = { ...this.state, fresh_sources: [...sources.filter(item => item.context_id !== contextId), { context_id: contextId, message_ids: ids }] };
  }
  delivered(contextId: string | undefined, messageId?: string): void {
    if (contextId && messageId) this.rememberSource(contextId, messageId);
    if (contextId && !this.state.pending.includes(contextId)) this.state = { ...this.state, pending: [...this.state.pending, contextId] };
  }
  final(cursor: number): void { this.state = { ...this.state, final_cursor: cursor }; }
  clearFinal(): void { const { final_cursor: _final, ...rest } = this.state; this.state = rest; }
  deferSource(messageId: string): ResponseInputItem {
    this.clearFinal();
    const { reference: _reference, ...rest } = this.state;
    this.state = { ...rest, active: null, unindexed: [...new Set([...(this.state.unindexed ?? []), messageId])] };
    return { role: "user", content: JSON.stringify(semanticReference({ message_id: messageId, primary: null, alternatives: [], selection: { status: "none", uncertain: true } })) };
  }
  refreshNotes(): void { const { mutation: _mutation, ...rest } = this.state; this.state = rest; }
  private forgetDeliveredNotes(contextIds: readonly string[]): void {
    if (this.state.retrieved_notes) this.state = { ...this.state, retrieved_notes: this.state.retrieved_notes.filter(item => !contextIds.includes(item.context_id) || item.context_id === this.state.active?.context_id) };
  }
  detachNotes(): void {
    this.forgetDeliveredNotes(this.state.pending);
    const { mutation: _mutation, note_batch: _batch, unindexed: _unindexed, ...rest } = this.state; this.state = { ...rest, pending: [], fresh_sources: [] };
  }
  async drain(signal: AbortSignal, save: () => void): Promise<void> {
    await this.drainFresh(signal, save);
    for (const messageId of this.state.unindexed ?? []) {
      const context = await this.index(messageId, signal);
      this.delivered(context?.context_id);
      this.state = { ...this.state, unindexed: this.state.unindexed?.filter(id => id !== messageId) ?? [] };
      save();
      await this.drainFresh(signal, save);
    }
  }
  private async drainFresh(signal: AbortSignal, save: () => void): Promise<void> {
    const contexts = [...new Set([...(this.state.mutation ? [this.state.mutation.context_id] : this.state.note_batch ? [this.state.note_batch.context_id] : []), ...this.state.pending, ...(this.state.fresh_sources ?? []).map(item => item.context_id)])];
    for (const contextId of contexts) {
      do {
        if (!this.state.mutation) {
          const noteIds = this.state.retrieved_notes?.find(item => item.context_id === contextId)?.note_ids ?? [];
          const ids = this.state.note_batch?.context_id === contextId ? this.state.note_batch.message_ids
            : this.state.fresh_sources?.find(item => item.context_id === contextId)?.message_ids.slice(0, 8)
              ?? [];
          this.state = { ...this.state, note_batch: { context_id: contextId, message_ids: ids } };
          save();
          const { context } = Snapshot.parse(await this.scope.http.post(this.path("snapshot"), { json: { context_id: contextId, mode: this.scope.mode ?? "live", ...(noteIds.length ? { note_ids: noteIds } : {}), ...(ids.length ? { source_ids: ids } : {}) }, signal }).json());
          if (this.state.fresh_sources === undefined && context.recent_messages.some(message => message.retention_allowed && message.linked_context_id === contextId)) throw new SemanticIndexError("source_boundary_unavailable");
          const retained = context.recent_messages.filter(message => ids.includes(message.message_id) && message.retention_allowed && message.linked_context_id === context.context_id);
          const source = retained.filter(message => this.scope.mode === "backfill" || message.task_id === this.scope.taskId).at(-1);
          if (source) {
            const files = context.files.filter(file => retained.some(message => message.attachments.some(attachment => attachment.id === file.id)));
            const notes = await this.model.notes({ ...context, recent_messages: retained, files }, signal);
            if (notes.length) {
              this.state = { ...this.state, mutation: { operation_id: crypto.randomUUID(), context_id: contextId, expected_revision: context.revision,
                source_message_id: source.message_id, source_sha256: source.sha256, mode: this.scope.mode ?? "live", notes: notes.map(note => ({ ...note, id: crypto.randomUUID() })) } };
              save();
            }
          }
        }
        if (this.state.mutation) NotesResult.parse(await this.scope.http.post(this.path("notes"), { json: this.state.mutation, signal }).json());
        const completed = this.state.note_batch?.message_ids ?? [];
        const fresh = (this.state.fresh_sources ?? []).map(item => item.context_id === contextId ? { ...item, message_ids: item.message_ids.filter(id => !completed.includes(id)) } : item).filter(item => item.message_ids.length);
        const { mutation: _mutation, note_batch: _batch, ...rest } = this.state;
        this.state = { ...rest, ...(this.state.fresh_sources === undefined ? {} : { fresh_sources: fresh }) };
        save();
      } while (this.state.fresh_sources?.some(item => item.context_id === contextId));
      this.forgetDeliveredNotes([contextId]);
      this.state = { ...this.state, pending: this.state.pending.filter(id => id !== contextId) };
      save();
    }
  }
}
