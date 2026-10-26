-- 087 also retired drafts whose reply had already gone out (a draft stays ready after its send). Put those back: their
-- card is resolved and their send settled, so nothing is sent again; only the draft row's state is restored.
UPDATE attention_source_drafts d SET state='ready'
  FROM card_states c WHERE c.message_id=d.card_message_id AND d.state='withdrawn' AND c.state='resolved'
    AND EXISTS(SELECT 1 FROM attention_source_sends e WHERE e.card_message_id=d.card_message_id AND e.state='sent');
