UPDATE messages m
SET role='system'
FROM responsibility_actions a
WHERE a.task_id=m.task_id AND a.workspace_id=m.workspace_id
  AND m.role='user' AND m.client_message_id IS NULL
  AND m.sequence=(SELECT min(first.sequence) FROM messages first
    WHERE first.task_id=m.task_id AND first.workspace_id=m.workspace_id);
