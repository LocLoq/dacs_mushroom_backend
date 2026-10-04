ALTER TABLE `tasks` MODIFY `status` ENUM('TODO', 'IN_PROGRESS', 'PENDING_REVIEW', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'TODO', ADD COLUMN `version` INT NOT NULL DEFAULT 0;

ALTER TABLE `cultivation_care_logs` ADD COLUMN `created_by_user_id` INT NULL, ADD COLUMN `updated_by_user_id` INT NULL;
ALTER TABLE `growth_progress_records` ADD COLUMN `created_by_user_id` INT NULL, ADD COLUMN `updated_by_user_id` INT NULL;
ALTER TABLE `harvest_records` ADD COLUMN `created_by_user_id` INT NULL, ADD COLUMN `updated_by_user_id` INT NULL;

CREATE TABLE `task_submissions` (
    `id` VARCHAR(36) NOT NULL,
    `task_id` VARCHAR(36) NOT NULL,
    `submitted_by_user_id` INTEGER NULL,
    `reviewed_by_user_id` INTEGER NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `evidence` JSON NOT NULL,
    `notes` TEXT NULL,
    `reason` TEXT NULL,
    `submitted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reviewed_at` DATETIME(3) NULL,

    INDEX `task_submissions_task_id_submitted_at_idx`(`task_id`, `submitted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `task_submission_images` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `submission_id` VARCHAR(36) NOT NULL,
    `image_url` VARCHAR(255) NOT NULL,

    INDEX `task_submission_images_image_url_idx`(`image_url`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `batch_expenses` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `batch_id` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `category` ENUM('MATERIAL', 'TOOL', 'FERTILIZER', 'OTHER') NOT NULL,
    `quantity` DECIMAL(12, 3) NOT NULL,
    `unit` VARCHAR(50) NOT NULL,
    `unit_price` DECIMAL(18, 2) NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `incurred_at` DATETIME(3) NOT NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by_user_id` INTEGER NULL,
    `updated_by_user_id` INTEGER NULL,

    INDEX `batch_expenses_batch_id_incurred_at_idx`(`batch_id`, `incurred_at`),
    INDEX `batch_expenses_incurred_at_idx`(`incurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `batch_sales` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `batch_id` INTEGER NOT NULL,
    `quantity_kg` DECIMAL(12, 3) NOT NULL,
    `unit_price` DECIMAL(18, 2) NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `sold_at` DATETIME(3) NOT NULL,
    `buyer` VARCHAR(255) NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by_user_id` INTEGER NULL,
    `updated_by_user_id` INTEGER NULL,

    INDEX `batch_sales_batch_id_sold_at_idx`(`batch_id`, `sold_at`),
    INDEX `batch_sales_sold_at_idx`(`sold_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `facility_images` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `facility_id` INTEGER NOT NULL,
    `image_url` VARCHAR(255) NOT NULL,
    `original_name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `file_size` INTEGER NOT NULL,
    `caption` VARCHAR(500) NULL,
    `is_cover` BOOLEAN NOT NULL DEFAULT false,
    `uploaded_by_user_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `facility_images_facility_id_created_at_idx`(`facility_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `mushroom_images` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `mushroom_id` INTEGER NOT NULL,
    `image_url` VARCHAR(255) NOT NULL,
    `original_name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `file_size` INTEGER NOT NULL,
    `caption` VARCHAR(500) NULL,
    `is_cover` BOOLEAN NOT NULL DEFAULT false,
    `uploaded_by_user_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `mushroom_images_mushroom_id_created_at_idx`(`mushroom_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `batch_images` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `batch_id` INTEGER NOT NULL,
    `image_url` VARCHAR(255) NOT NULL,
    `original_name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `file_size` INTEGER NOT NULL,
    `caption` VARCHAR(500) NULL,
    `is_cover` BOOLEAN NOT NULL DEFAULT false,
    `uploaded_by_user_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `batch_images_batch_id_created_at_idx`(`batch_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `cultivation_care_logs` ADD CONSTRAINT `cultivation_care_logs_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `cultivation_care_logs` ADD CONSTRAINT `cultivation_care_logs_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `growth_progress_records` ADD CONSTRAINT `growth_progress_records_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `growth_progress_records` ADD CONSTRAINT `growth_progress_records_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `harvest_records` ADD CONSTRAINT `harvest_records_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `harvest_records` ADD CONSTRAINT `harvest_records_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `task_submissions` ADD CONSTRAINT `task_submissions_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `task_submissions` ADD CONSTRAINT `task_submissions_submitted_by_user_id_fkey` FOREIGN KEY (`submitted_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `task_submissions` ADD CONSTRAINT `task_submissions_reviewed_by_user_id_fkey` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `task_submission_images` ADD CONSTRAINT `task_submission_images_submission_id_fkey` FOREIGN KEY (`submission_id`) REFERENCES `task_submissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `batch_expenses` ADD CONSTRAINT `batch_expenses_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `batch_expenses` ADD CONSTRAINT `batch_expenses_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `batch_expenses` ADD CONSTRAINT `batch_expenses_batch_id_fkey` FOREIGN KEY (`batch_id`) REFERENCES `cultivation_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `batch_sales` ADD CONSTRAINT `batch_sales_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `batch_sales` ADD CONSTRAINT `batch_sales_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `batch_sales` ADD CONSTRAINT `batch_sales_batch_id_fkey` FOREIGN KEY (`batch_id`) REFERENCES `cultivation_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `facility_images` ADD CONSTRAINT `facility_images_facility_id_fkey` FOREIGN KEY (`facility_id`) REFERENCES `production_facilities`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `facility_images` ADD CONSTRAINT `facility_images_uploaded_by_user_id_fkey` FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `mushroom_images` ADD CONSTRAINT `mushroom_images_mushroom_id_fkey` FOREIGN KEY (`mushroom_id`) REFERENCES `mushroom_species`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `mushroom_images` ADD CONSTRAINT `mushroom_images_uploaded_by_user_id_fkey` FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `batch_images` ADD CONSTRAINT `batch_images_batch_id_fkey` FOREIGN KEY (`batch_id`) REFERENCES `cultivation_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `batch_images` ADD CONSTRAINT `batch_images_uploaded_by_user_id_fkey` FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

