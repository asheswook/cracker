import { z } from 'zod';
import { Conversation, Id, Message, Persona } from './types';
import { AppearanceSettings } from './appearance/types';

const Snapshot = z.object({
  version: z.literal(1), savedAt: z.number().finite(), workspace: Id, assistantId: Id,
  persona: Persona, appearance: AppearanceSettings.shape.appearance,
  appearanceRevision: AppearanceSettings.shape.revision.nullable(),
  conversations: Conversation.array().max(200), messages: Message.array().max(60),
});
type Startup = z.infer<typeof Snapshot>;
type Content = Omit<Startup, 'version' | 'savedAt'>;
const key = (workspace: Id) => `assistant:startup:v1:${workspace}`;
const maximumCharacters = 500_000;

export function readStartupCache(workspace: Id): Content | null {
  try {
    const raw = localStorage.getItem(key(workspace));
    if (!raw || raw.length > maximumCharacters) return null;
    const parsed = Snapshot.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const value = parsed.data, age = Date.now() - value.savedAt;
    if (value.workspace !== workspace || age < -300_000 || age > 7 * 86400_000
      || value.messages.some(message => message.conversation_id !== value.assistantId)) return null;
    return value;
  } catch (error) { if (!(error instanceof Error)) throw error; return null; }
}

export function writeStartupCache(value: Content): void {
  let characters = 0;
  const messages: Message[] = [];
  for (const message of value.messages.slice(-60).reverse()) {
    if (characters + message.content.length > 200_000) break;
    characters += message.content.length; messages.unshift(message);
  }
  const serialized = JSON.stringify({ ...value, version: 1, savedAt: Date.now(),
    conversations: value.conversations.slice(0, 200), messages });
  if (serialized.length > maximumCharacters) return;
  try { localStorage.setItem(key(value.workspace), serialized); }
  catch (error) { if (!(error instanceof Error)) throw error; }
}

export function clearStartupCache(workspace: Id): void {
  try { localStorage.removeItem(key(workspace)); }
  catch (error) { if (!(error instanceof Error)) throw error; }
}
