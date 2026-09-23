CREATE TABLE IF NOT EXISTS `classifier_lookups` (
    `id` VARCHAR(36) NOT NULL,
    `user_id` INT NULL,
    `original_name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `file_size` INT NOT NULL,
    `status` ENUM('QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `result` JSON NULL,
    `predicted_name` VARCHAR(191) NULL,
    `edibility` VARCHAR(100) NULL,
    `confidence` DOUBLE NULL,
    `error_message` TEXT NULL,
    `queued_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `started_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    INDEX `classifier_lookups_user_id_created_at_idx` (`user_id`, `created_at`),
    INDEX `classifier_lookups_status_created_at_idx` (`status`, `created_at`),
    INDEX `classifier_lookups_created_at_idx` (`created_at`),
    CONSTRAINT `classifier_lookups_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `audit_logs` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `actor_user_id` INT NULL,
    `actor_username` VARCHAR(50) NULL,
    `actor_role` VARCHAR(50) NULL,
    `action` VARCHAR(100) NOT NULL,
    `entity_type` VARCHAR(100) NULL,
    `entity_id` VARCHAR(100) NULL,
    `method` VARCHAR(10) NOT NULL,
    `path` VARCHAR(255) NOT NULL,
    `status_code` INT NOT NULL,
    `outcome` ENUM('SUCCESS', 'FAILURE') NOT NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(512) NULL,
    `request_id` VARCHAR(36) NULL,
    `duration_ms` INT NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    INDEX `audit_logs_created_at_idx` (`created_at`),
    INDEX `audit_logs_actor_user_id_created_at_idx` (`actor_user_id`, `created_at`),
    INDEX `audit_logs_action_created_at_idx` (`action`, `created_at`),
    INDEX `audit_logs_entity_type_entity_id_idx` (`entity_type`, `entity_id`),
    CONSTRAINT `audit_logs_actor_user_id_fkey` FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `harvest_records` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `batch_id` INT NOT NULL,
    `harvested_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `total_yield_kg` DOUBLE NOT NULL,
    `quality_grade` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    CONSTRAINT `harvest_records_batch_id_fkey` FOREIGN KEY (`batch_id`) REFERENCES `cultivation_batches` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @reporting_index_sql = (
    SELECT IF(COUNT(*) = 0, 'ALTER TABLE `cultivation_batches` ADD INDEX `cultivation_batches_start_date_idx` (`start_date`)', 'SELECT 1')
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cultivation_batches' AND INDEX_NAME = 'cultivation_batches_start_date_idx'
);
PREPARE reporting_index_statement FROM @reporting_index_sql;
EXECUTE reporting_index_statement;
DEALLOCATE PREPARE reporting_index_statement;

SET @reporting_index_sql = (
    SELECT IF(COUNT(*) = 0, 'ALTER TABLE `cultivation_batches` ADD INDEX `cultivation_batches_facility_id_start_date_idx` (`facility_id`, `start_date`)', 'SELECT 1')
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cultivation_batches' AND INDEX_NAME = 'cultivation_batches_facility_id_start_date_idx'
);
PREPARE reporting_index_statement FROM @reporting_index_sql;
EXECUTE reporting_index_statement;
DEALLOCATE PREPARE reporting_index_statement;

SET @reporting_index_sql = (
    SELECT IF(COUNT(*) = 0, 'ALTER TABLE `cultivation_batches` ADD INDEX `cultivation_batches_mushroom_id_start_date_idx` (`mushroom_id`, `start_date`)', 'SELECT 1')
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cultivation_batches' AND INDEX_NAME = 'cultivation_batches_mushroom_id_start_date_idx'
);
PREPARE reporting_index_statement FROM @reporting_index_sql;
EXECUTE reporting_index_statement;
DEALLOCATE PREPARE reporting_index_statement;

SET @reporting_index_sql = (
    SELECT IF(COUNT(*) = 0, 'ALTER TABLE `cultivation_batches` ADD INDEX `cultivation_batches_status_start_date_idx` (`status`, `start_date`)', 'SELECT 1')
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cultivation_batches' AND INDEX_NAME = 'cultivation_batches_status_start_date_idx'
);
PREPARE reporting_index_statement FROM @reporting_index_sql;
EXECUTE reporting_index_statement;
DEALLOCATE PREPARE reporting_index_statement;

SET @reporting_index_sql = (
    SELECT IF(COUNT(*) = 0, 'ALTER TABLE `harvest_records` ADD INDEX `harvest_records_harvested_at_idx` (`harvested_at`)', 'SELECT 1')
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'harvest_records' AND INDEX_NAME = 'harvest_records_harvested_at_idx'
);
PREPARE reporting_index_statement FROM @reporting_index_sql;
EXECUTE reporting_index_statement;
DEALLOCATE PREPARE reporting_index_statement;

SET @reporting_index_sql = (
    SELECT IF(COUNT(*) = 0, 'ALTER TABLE `harvest_records` ADD INDEX `harvest_records_batch_id_harvested_at_idx` (`batch_id`, `harvested_at`)', 'SELECT 1')
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'harvest_records' AND INDEX_NAME = 'harvest_records_batch_id_harvested_at_idx'
);
PREPARE reporting_index_statement FROM @reporting_index_sql;
EXECUTE reporting_index_statement;
DEALLOCATE PREPARE reporting_index_statement;
