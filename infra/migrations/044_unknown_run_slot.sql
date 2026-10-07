DROP INDEX run_vm_active;
CREATE UNIQUE INDEX run_vm_active ON runs(vm_id)
  WHERE state NOT IN ('cancelled','succeeded','failed','unknown');
