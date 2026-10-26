-- A date the user promised in their own reply ("금요일까지 보내 드리겠습니다") is its own kind of item, so the feed reads it
-- as "약속한 기한" instead of a new request from the other side.
ALTER TABLE attention_source_items DROP CONSTRAINT attention_source_items_category_check;
ALTER TABLE attention_source_items ADD CONSTRAINT attention_source_items_category_check CHECK (category IN ('request','deadline','overdue','waiting','alert','promise'));
