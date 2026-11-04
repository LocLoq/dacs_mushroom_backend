-- Additive, rerunnable upgrade for existing classifier history.
SET @classifier_input_path_exists = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'classifier_lookups' AND COLUMN_NAME = 'input_path'
);
SET @classifier_input_path_sql = IF(@classifier_input_path_exists = 0,
    'ALTER TABLE `classifier_lookups` ADD COLUMN `input_path` VARCHAR(1024) NULL', 'SELECT 1');
PREPARE classifier_input_path_statement FROM @classifier_input_path_sql;
EXECUTE classifier_input_path_statement;
DEALLOCATE PREPARE classifier_input_path_statement;

SET @classifier_updated_index_exists = (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'classifier_lookups'
      AND INDEX_NAME = 'classifier_lookups_status_updated_at_id_idx'
);
SET @classifier_updated_index_sql = IF(@classifier_updated_index_exists = 0,
    'CREATE INDEX `classifier_lookups_status_updated_at_id_idx` ON `classifier_lookups` (`status`, `updated_at`, `id`)', 'SELECT 1');
PREPARE classifier_updated_index_statement FROM @classifier_updated_index_sql;
EXECUTE classifier_updated_index_statement;
DEALLOCATE PREPARE classifier_updated_index_statement;

SET @classifier_started_index_exists = (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'classifier_lookups'
      AND INDEX_NAME = 'classifier_lookups_status_started_at_id_idx'
);
SET @classifier_started_index_sql = IF(@classifier_started_index_exists = 0,
    'CREATE INDEX `classifier_lookups_status_started_at_id_idx` ON `classifier_lookups` (`status`, `started_at`, `id`)', 'SELECT 1');
PREPARE classifier_started_index_statement FROM @classifier_started_index_sql;
EXECUTE classifier_started_index_statement;
DEALLOCATE PREPARE classifier_started_index_statement;
