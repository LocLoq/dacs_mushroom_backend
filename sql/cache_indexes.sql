CREATE INDEX `bench_care_batch_recorded_id` ON `cultivation_care_logs` (`batch_id`, `recorded_at`, `id`);
CREATE INDEX `bench_growth_batch_recorded_id` ON `growth_progress_records` (`batch_id`, `recorded_at`, `id`);
CREATE INDEX `bench_batch_facility_start_id` ON `cultivation_batches` (`facility_id`, `start_date`, `id`);
CREATE INDEX `bench_task_assignee_status_due` ON `tasks` (`assignee_user_id`, `status`, `due_at`);
