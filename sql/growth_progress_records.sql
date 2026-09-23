CREATE TABLE IF NOT EXISTS `growth_progress_records` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `batch_id` INT NOT NULL,
    `stage` VARCHAR(191) NOT NULL,
    `notes` TEXT NOT NULL,
    `recorded_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    INDEX `growth_progress_records_batch_id_recorded_at_idx` (`batch_id`, `recorded_at`),
    CONSTRAINT `growth_progress_records_batch_id_fkey`
        FOREIGN KEY (`batch_id`) REFERENCES `cultivation_batches` (`id`)
        ON DELETE CASCADE
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @growth_progress_add_updated_at = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE `growth_progress_records` ADD COLUMN `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)',
        'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'growth_progress_records' AND COLUMN_NAME = 'updated_at'
);
PREPARE growth_progress_updated_at_statement FROM @growth_progress_add_updated_at;
EXECUTE growth_progress_updated_at_statement;
DEALLOCATE PREPARE growth_progress_updated_at_statement;

SET @growth_progress_add_index = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE `growth_progress_records` ADD INDEX `growth_progress_records_batch_id_recorded_at_idx` (`batch_id`, `recorded_at`)',
        'SELECT 1')
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'growth_progress_records' AND INDEX_NAME = 'growth_progress_records_batch_id_recorded_at_idx'
);
PREPARE growth_progress_index_statement FROM @growth_progress_add_index;
EXECUTE growth_progress_index_statement;
DEALLOCATE PREPARE growth_progress_index_statement;

CREATE TABLE IF NOT EXISTS `cultivation_care_logs` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `batch_id` INT NOT NULL,
    `action_type` VARCHAR(191) NOT NULL,
    `notes` TEXT NOT NULL,
    `recorded_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    CONSTRAINT `cultivation_care_logs_batch_id_fkey`
        FOREIGN KEY (`batch_id`) REFERENCES `cultivation_batches` (`id`)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `growth_progress_images` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `growth_progress_id` INT NOT NULL,
    `image_url` VARCHAR(255) NOT NULL,
    `original_name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `file_size` INT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    INDEX `growth_progress_images_growth_progress_id_idx` (`growth_progress_id`),
    CONSTRAINT `growth_progress_images_growth_progress_id_fkey`
        FOREIGN KEY (`growth_progress_id`) REFERENCES `growth_progress_records` (`id`)
        ON DELETE CASCADE
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
