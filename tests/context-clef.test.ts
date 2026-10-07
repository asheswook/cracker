import { expect, test } from 'bun:test';
import { clefContextDecision, clefContextInput, createClefClassifier, ClefContextError } from '../packages/context/clef';
import { PrepareResult, SemanticNote } from '../packages/context/schema';

const first = crypto.randomUUID(), second = crypto.randomUUID();
function fixture() {
  return PrepareResult.parse({
    source: {message_id: crypto.randomUUID(), task_id: null, sequence: 20, role: 'user', content: '아까 인증서 문제로 돌아가자', truncated: false, sha256: 'a'.repeat(64), attachments: [], retention_allowed: true},
    retention_context: {sources: [], decisions: []}, neighbors: [], candidates: [
      {context_id: first, title: 'Office VPN', scope: 'Office gateway authentication', revision: 1, source_sequence: 2, notes: [], recent_messages: [], files: []},
      {context_id: second, title: 'Book', scope: 'Reading discussion', revision: 1, source_sequence: 8, notes: [], recent_messages: [], files: []},
    ], linked: null, history: {messages: [], next_after_sequence: null, has_more: false},
  });
}
function response(probabilities: Record<string, number>, choice = 'context_0') {
  return {model: 'clef', answers: {context: {type: 'choice', choice, probabilities, confidence: 0.99}}};
}
test('selects the referenced candidate rather than the most recent one', () => {
  const input = fixture();
  const decision = clefContextDecision(input, response({context_0: 0.94, context_1: 0.02, new_context: 0.02, uncertain: 0.02}));
  expect(decision.context_id).toBe(first);
  expect(decision.outcome).toBe('existing');
});
test('defers ambiguous scores despite a high reported confidence', () => {
  const input = fixture();
  const decision = clefContextDecision(input, response({context_0: 0.49, context_1: 0.45, new_context: 0.03, uncertain: 0.03}));
  expect(decision.outcome).toBe('uncertain');
  expect(decision.context_id).toBeNull();
});
test('creates a new context only when that choice wins', () => {
  const decision = clefContextDecision(fixture(), response({context_0: 0.02, context_1: 0.02, new_context: 0.94, uncertain: 0.02}, 'new_context'));
  expect(decision.outcome).toBe('new');
  expect(decision.context_id).toBeNull();
});
test('rejects candidate injection outside the offered set', () => {
  expect(() => clefContextDecision(fixture(), response({context_0: 0.01, context_1: 0.01, context_2: 0.96, new_context: 0.01, uncertain: 0.01}, 'context_2'))).toThrow(ClefContextError);
});
test('rejects inconsistent probabilities or the wrong winning option', () => {
  expect(() => clefContextDecision(fixture(), response({context_0: 0.94, context_1: 0.92, new_context: 0.02, uncertain: 0.02}))).toThrow(ClefContextError);
  expect(() => clefContextDecision(fixture(), response({context_0: 0.02, context_1: 0.94, new_context: 0.02, uncertain: 0.02}))).toThrow(ClefContextError);
});
test('bounds long incoming content and makes truncation explicit', () => {
  const input = fixture(); input.source.content = 'x'.repeat(20000);
  const prepared = clefContextInput(input, 'clef');
  expect(prepared.state.incoming.text.length).toBe(16000);
  expect(prepared.state.incoming.truncated).toBe(true);
});
test('avoids a model call when there are no candidate contexts', async () => {
  const input = fixture(); input.candidates = [];
  let calls = 0;
  const classifier = createClefClassifier(async () => { calls++; throw new Error('unexpected model request'); });
  const decision = await classifier(input);
  expect(decision.outcome).toBe('new'); expect(calls).toBe(0);
});
test('denied historical neighbors cannot influence durable routing metadata',()=>{
  const input=fixture();
  input.neighbors=[{...input.source,message_id:crypto.randomUUID(),content:'Nonretained confidential detail',retention_allowed:false},{...input.source,message_id:crypto.randomUUID(),content:'Retained earlier question'}];
  const prepared=clefContextInput(input,'clef');
  expect(prepared.state.recent_turns.map(source=>source.text)).toEqual(['Retained earlier question']);
  expect(JSON.stringify(prepared)).not.toContain('Nonretained confidential detail');
});
test('historical routing retains original times rather than the replay date',()=>{
  const input=fixture();input.source.created_at='2025-02-01T09:00:00.000Z';
  const historical={...input.source,created_at:'2024-12-01T01:00:00.000Z'};
  input.neighbors=[historical];
  const candidate=input.candidates[0];if(!candidate)throw new Error('Missing fixture');candidate.recent_messages=[historical];
  const prepared=clefContextInput(input,'clef');
  expect(prepared.state.incoming.created_at).toBe('2025-02-01T09:00:00.000Z');
  expect(prepared.state.recent_turns[0]?.created_at).toBe('2024-12-01T01:00:00.000Z');
  expect(prepared.state.contexts[0]?.recent_turns[0]?.created_at).toBe('2024-12-01T01:00:00.000Z');
});

test('routing keeps the highest retrieval matches even when lower ranked evidence is newer',()=>{
  const input=fixture(),candidate=input.candidates[0];if(!candidate)throw new TypeError('Missing candidate');
  candidate.notes=Array.from({length:5},(_,index)=>SemanticNote.parse({id:crypto.randomUUID(),kind:'fact',text:`Evidence ${index}`,evidence:[{message_id:input.source.message_id,quote:'evidence'}],source_message_id:input.source.message_id,source_sequence:index+1,source_sha256:input.source.sha256,context_revision:1,basis:'user_statement',superseded_by:null,recorded_at:'2025-01-01T00:00:00Z'}));
  candidate.recent_messages=Array.from({length:4},(_,index)=>({...input.source,message_id:crypto.randomUUID(),sequence:index+1,content:`Source ${index}`}));
  candidate.retrieval={note_ids:candidate.notes.map(note=>note.id),source_windows:candidate.recent_messages.map(source=>({message_id:source.message_id,start:0,end:source.content.length}))};
  const packed=clefContextInput(input,'clef').state.contexts[0];
  expect(packed?.notes.map(note=>note.text)).toEqual(['Evidence 0','Evidence 1','Evidence 2']);
  expect(packed?.recent_turns.map(source=>source.text)).toEqual(['Source 0']);
});

test('routing uses recency for unranked evidence and excludes denied or superseded records',()=>{
  const input=fixture(),candidate=input.candidates[0];if(!candidate)throw new TypeError('Missing candidate');
  candidate.notes=Array.from({length:5},(_,index)=>SemanticNote.parse({id:crypto.randomUUID(),kind:'fact',text:`Evidence ${index}`,evidence:[{message_id:input.source.message_id,quote:'evidence'}],source_message_id:input.source.message_id,source_sequence:index+1,source_sha256:input.source.sha256,context_revision:1,basis:'user_statement',superseded_by:index===4?crypto.randomUUID():null,recorded_at:'2025-01-01T00:00:00Z'}));
  candidate.recent_messages=Array.from({length:4},(_,index)=>({...input.source,message_id:crypto.randomUUID(),sequence:index+1,content:`Source ${index}`,retention_allowed:index!==3}));
  const packed=clefContextInput(input,'clef').state.contexts[0];
  expect(packed?.notes.map(note=>note.text)).toEqual(['Evidence 3','Evidence 2','Evidence 1']);
  expect(packed?.recent_turns.map(source=>source.text)).toEqual(['Source 2']);
});
