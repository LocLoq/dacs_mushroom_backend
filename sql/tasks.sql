CREATE TABLE IF NOT EXISTS `tasks` (
    `id` VARCHAR(36) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `status` ENUM('TODO', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'TODO',
    `batch_id` INT NULL,
    `assignee_user_id` INT NULL,
    `created_by_user_id` INT NULL,
    `due_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    INDEX `tasks_status_due_at_idx` (`status`, `due_at`),
    INDEX `tasks_assignee_user_id_status_idx` (`assignee_user_id`, `status`),
    INDEX `tasks_batch_id_idx` (`batch_id`),
    CONSTRAINT `tasks_batch_id_fkey` FOREIGN KEY (`batch_id`) REFERENCES `cultivation_batches` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT `tasks_assignee_user_id_fkey` FOREIGN KEY (`assignee_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT `tasks_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
