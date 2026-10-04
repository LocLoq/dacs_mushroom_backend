CREATE TABLE `roles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(50) NOT NULL,

    UNIQUE INDEX `roles_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(50) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `full_name` VARCHAR(100) NOT NULL,
    `phone_number` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `role_id` INTEGER NOT NULL,
    `tokenver` INTEGER NOT NULL,

    UNIQUE INDEX `users_username_key`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `mushroom_species` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `scientific_name` VARCHAR(191) NOT NULL,
    `common_name` VARCHAR(191) NOT NULL,
    `other_names` VARCHAR(191) NULL,
    `family` VARCHAR(191) NOT NULL,
    `genus` VARCHAR(191) NOT NULL,
    `cap_description` TEXT NULL,
    `gills_description` TEXT NULL,
    `stem_description` TEXT NULL,
    `spore_print_color` VARCHAR(191) NULL,
    `bruising_behavior` VARCHAR(191) NULL,
    `ecology_type` ENUM('SAPROBIC', 'MYCORRHIZAL', 'PARASITIC') NULL,
    `habitat` TEXT NULL,
    `fruiting_season` VARCHAR(191) NULL,
    `edibility_status` ENUM('CHOICE', 'EDIBLE', 'INEDIBLE', 'POISONOUS', 'DEADLY') NOT NULL,
    `toxicity_symptoms` TEXT NULL,
    `medicinal_properties` TEXT NULL,
    `cultivation_difficulty` ENUM('EASY', 'MEDIUM', 'HARD', 'UNCULTIVABLE') NULL,
    `image_url` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `mushroom_species_scientific_name_key`(`scientific_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `production_facilities` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `tax_code` VARCHAR(191) NULL,
    `address` VARCHAR(191) NOT NULL,
    `province` VARCHAR(191) NULL,
    `contact_phone` VARCHAR(191) NULL,
    `contact_email` VARCHAR(191) NULL,
    `facility_type` ENUM('HOUSEHOLD', 'COOPERATIVE', 'ENTERPRISE') NOT NULL,
    `capacity_tons_per_year` DOUBLE NULL,
    `total_area_sqm` DOUBLE NULL,
    `certifications` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `production_facilities_tax_code_key`(`tax_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `cultivation_batches` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `batch_code` VARCHAR(191) NOT NULL,
    `facility_id` INTEGER NOT NULL,
    `mushroom_id` INTEGER NOT NULL,
    `status` ENUM('PREPARATION', 'INCUBATION', 'FRUITING', 'HARVESTING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PREPARATION',
    `substrate_type` VARCHAR(191) NULL,
    `spawn_source` VARCHAR(191) NULL,
    `bag_quantity` INTEGER NULL,
    `start_date` DATETIME(3) NOT NULL,
    `expected_harvest_date` DATETIME(3) NULL,
    `end_date` DATETIME(3) NULL,
    `actual_yield_kg` DOUBLE NULL,
    `defect_rate` DOUBLE NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `cultivation_batches_batch_code_key`(`batch_code`),
    INDEX `cultivation_batches_start_date_idx`(`start_date`),
    INDEX `cultivation_batches_facility_id_start_date_idx`(`facility_id`, `start_date`),
    INDEX `cultivation_batches_mushroom_id_start_date_idx`(`mushroom_id`, `start_date`),
    INDEX `cultivation_batches_status_start_date_idx`(`status`, `start_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `tasks` (
    `id` VARCHAR(36) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `status` ENUM('TODO', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'TODO',
    `batch_id` INTEGER NULL,
    `assignee_user_id` INTEGER NULL,
    `created_by_user_id` INTEGER NULL,
    `due_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `tasks_status_due_at_idx`(`status`, `due_at`),
    INDEX `tasks_assignee_user_id_status_idx`(`assignee_user_id`, `status`),
    INDEX `tasks_batch_id_idx`(`batch_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `cultivation_care_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `batch_id` INTEGER NOT NULL,
    `action_type` VARCHAR(191) NOT NULL,
    `notes` TEXT NOT NULL,
    `recorded_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `growth_progress_records` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `batch_id` INTEGER NOT NULL,
    `stage` VARCHAR(191) NOT NULL,
    `notes` TEXT NOT NULL,
    `recorded_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `growth_progress_records_batch_id_recorded_at_idx`(`batch_id`, `recorded_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `growth_progress_images` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `growth_progress_id` INTEGER NOT NULL,
    `image_url` VARCHAR(255) NOT NULL,
    `original_name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `file_size` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `growth_progress_images_growth_progress_id_idx`(`growth_progress_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `harvest_records` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `batch_id` INTEGER NOT NULL,
    `harvested_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `total_yield_kg` DOUBLE NOT NULL,
    `quality_grade` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `harvest_records_harvested_at_idx`(`harvested_at`),
    INDEX `harvest_records_batch_id_harvested_at_idx`(`batch_id`, `harvested_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `classifier_lookups` (
    `id` VARCHAR(36) NOT NULL,
    `user_id` INTEGER NULL,
    `original_name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `file_size` INTEGER NOT NULL,
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
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `classifier_lookups_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `classifier_lookups_status_created_at_idx`(`status`, `created_at`),
    INDEX `classifier_lookups_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `audit_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `actor_user_id` INTEGER NULL,
    `actor_username` VARCHAR(50) NULL,
    `actor_role` VARCHAR(50) NULL,
    `action` VARCHAR(100) NOT NULL,
    `entity_type` VARCHAR(100) NULL,
    `entity_id` VARCHAR(100) NULL,
    `method` VARCHAR(10) NOT NULL,
    `path` VARCHAR(255) NOT NULL,
    `status_code` INTEGER NOT NULL,
    `outcome` ENUM('SUCCESS', 'FAILURE') NOT NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(512) NULL,
    `request_id` VARCHAR(36) NULL,
    `duration_ms` INTEGER NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_created_at_idx`(`created_at`),
    INDEX `audit_logs_actor_user_id_created_at_idx`(`actor_user_id`, `created_at`),
    INDEX `audit_logs_action_created_at_idx`(`action`, `created_at`),
    INDEX `audit_logs_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `_FacilityToMushroom` (
    `A` INTEGER NOT NULL,
    `B` INTEGER NOT NULL,

    UNIQUE INDEX `_FacilityToMushroom_AB_unique`(`A`, `B`),
    INDEX `_FacilityToMushroom_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `users` ADD CONSTRAINT `users_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `cultivation_batches` ADD CONSTRAINT `cultivation_batches_facility_id_fkey` FOREIGN KEY (`facility_id`) REFERENCES `production_facilities`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `cultivation_batches` ADD CONSTRAINT `cultivation_batches_mushroom_id_fkey` FOREIGN KEY (`mushroom_id`) REFERENCES `mushroom_species`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `tasks` ADD CONSTRAINT `tasks_batch_id_fkey` FOREIGN KEY (`batch_id`) REFERENCES `cultivation_batches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `tasks` ADD CONSTRAINT `tasks_assignee_user_id_fkey` FOREIGN KEY (`assignee_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `tasks` ADD CONSTRAINT `tasks_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `cultivation_care_logs` ADD CONSTRAINT `cultivation_care_logs_batch_id_fkey` FOREIGN KEY (`batch_id`) REFERENCES `cultivation_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `growth_progress_records` ADD CONSTRAINT `growth_progress_records_batch_id_fkey` FOREIGN KEY (`batch_id`) REFERENCES `cultivation_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `growth_progress_images` ADD CONSTRAINT `growth_progress_images_growth_progress_id_fkey` FOREIGN KEY (`growth_progress_id`) REFERENCES `growth_progress_records`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `harvest_records` ADD CONSTRAINT `harvest_records_batch_id_fkey` FOREIGN KEY (`batch_id`) REFERENCES `cultivation_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `classifier_lookups` ADD CONSTRAINT `classifier_lookups_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actor_user_id_fkey` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `_FacilityToMushroom` ADD CONSTRAINT `_FacilityToMushroom_A_fkey` FOREIGN KEY (`A`) REFERENCES `mushroom_species`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `_FacilityToMushroom` ADD CONSTRAINT `_FacilityToMushroom_B_fkey` FOREIGN KEY (`B`) REFERENCES `production_facilities`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

