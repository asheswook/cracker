-- A routine that runs only until a date ("매일 6시에, 금요일까지"): after it, the routine is complete on its own.
ALTER TABLE responsibilities ADD COLUMN until_at timestamptz;
