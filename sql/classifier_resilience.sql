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
