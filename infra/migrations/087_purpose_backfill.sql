-- Drafts and sends written before purposes existed: an unsent draft on a wait or a promise is retired (rewritten with
-- its purpose); sends keep 'reply' (a reply never closes a wait or a promise anyway).
UPDATE attention_source_drafts d SET state='withdrawn',finished_at=now() FROM attention_source_items i
  WHERE i.id=d.item_id AND d.state IN ('dispatched','ready') AND d.purpose='reply' AND i.category IN ('waiting','promise');
