import { useEffect, useMemo, useRef, useState } from 'react';
import { read } from '../api';
import { ConversationTopics, type TopicNode } from './types';

/**
 * Topic (knowledge node) per message of the open conversation. Read-only; refreshed when the latest message changes and
 * once more a little later, because tree growth assigns new exchanges in the background after the reply.
 */
export function useConversationTopics(conversation: string | null, latest: string | undefined) {
  const [state, setState] = useState<{ conversation: string | null; byMessage: Map<string, { node: string; inherited: boolean }>; nodes: Map<string, TopicNode> }>({ conversation: null, byMessage: new Map(), nodes: new Map() });
  const generation = useRef(0);
  useEffect(() => {
    if (!conversation) return;
    const mine = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const result = await read(`/v1/conversations/${conversation}/topics`, ConversationTopics);
        if (mine !== generation.current) return;
        setState({
          conversation,
          byMessage: new Map(result.assignments.map(a => [a.message_id, { node: a.node_id, inherited: a.inherited }])),
          nodes: new Map(result.nodes.map(n => [n.id, n])),
        });
      } catch { /* chips are decoration; the conversation stays usable without them */ }
    };
    void load();
    timer = setTimeout(() => void load(), 25_000);
    return () => { if (timer) clearTimeout(timer); };
  }, [conversation, latest]);
  return useMemo(() => (state.conversation === conversation ? state : { conversation, byMessage: new Map(), nodes: new Map() }), [state, conversation]);
}
