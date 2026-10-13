-- AlterTable
ALTER TABLE `cultivation_care_logs` MODIFY `action_type` VARCHAR(255) NOT NULL;

-- AlterTable
ALTER TABLE `classifier_lookups` ADD COLUMN `attempt` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `max_attempts` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `next_retry_at` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `facility_staff` (
    `facility_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,
    `granted_by_user_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `facility_staff_user_id_idx`(`user_id`),
    PRIMARY KEY (`facility_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `batch_staff` (
    `batch_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,
    `granted_by_user_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `batch_staff_user_id_idx`(`user_id`),
    PRIMARY KEY (`batch_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `care_log_images` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `care_log_id` INTEGER NOT NULL,
    `image_url` VARCHAR(255) NOT NULL,
    `original_name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `file_size` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `care_log_images_care_log_id_idx`(`care_log_id`),
    INDEX `care_log_images_image_url_idx`(`image_url`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` VARCHAR(36) NOT NULL,
    `user_id` INTEGER NOT NULL,
    `event_key` VARCHAR(191) NOT NULL,
    `type` VARCHAR(50) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `task_id` VARCHAR(36) NULL,
    `batch_id` INTEGER NULL,
    `read_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `notifications_user_id_read_at_idx`(`user_id`, `read_at`),
    UNIQUE INDEX `notifications_user_id_event_key_key`(`user_id`, `event_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `push_devices` (
    `id` VARCHAR(36) NOT NULL,
    `user_id` INTEGER NOT NULL,
    `token` VARCHAR(512) NOT NULL,
    `platform` VARCHAR(10) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `push_devices_token_key`(`token`),
    INDEX `push_devices_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `push_deliveries` (
    `id` VARCHAR(36) NOT NULL,
    `notification_id` VARCHAR(36) NOT NULL,
    `device_id` VARCHAR(36) NOT NULL,
    `sent_at` DATETIME(3) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `next_attempt_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_error` VARCHAR(255) NULL,

    INDEX `push_deliveries_sent_at_next_attempt_at_idx`(`sent_at`, `next_attempt_at`),
    UNIQUE INDEX `push_deliveries_notification_id_device_id_key`(`notification_id`, `device_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `facility_staff` ADD CONSTRAINT `facility_staff_facility_id_fkey` FOREIGN KEY (`facility_id`) REFERENCES `production_facilities`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `facility_staff` ADD CONSTRAINT `facility_staff_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `facility_staff` ADD CONSTRAINT `facility_staff_granted_by_user_id_fkey` FOREIGN KEY (`granted_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `batch_staff` ADD CONSTRAINT `batch_staff_batch_id_fkey` FOREIGN KEY (`batch_id`) REFERENCES `cultivation_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `batch_staff` ADD CONSTRAINT `batch_staff_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `batch_staff` ADD CONSTRAINT `batch_staff_granted_by_user_id_fkey` FOREIGN KEY (`granted_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `care_log_images` ADD CONSTRAINT `care_log_images_care_log_id_fkey` FOREIGN KEY (`care_log_id`) REFERENCES `cultivation_care_logs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `push_devices` ADD CONSTRAINT `push_devices_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `push_deliveries` ADD CONSTRAINT `push_deliveries_notification_id_fkey` FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `push_deliveries` ADD CONSTRAINT `push_deliveries_device_id_fkey` FOREIGN KEY (`device_id`) REFERENCES `push_devices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

