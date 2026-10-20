DROP INDEX run_task_active;
CREATE UNIQUE INDEX run_task_active ON runs(task_id)
WHERE state NOT IN ('cancelled','succeeded','failed','unknown');
