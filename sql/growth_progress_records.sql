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

ALTER TABLE `growth_progress_records`
    ADD COLUMN IF NOT EXISTS `updated_at` DATETIME(3) NOT NULL
        DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

ALTER TABLE `growth_progress_records`
    ADD INDEX IF NOT EXISTS `growth_progress_records_batch_id_recorded_at_idx`
        (`batch_id`, `recorded_at`);
