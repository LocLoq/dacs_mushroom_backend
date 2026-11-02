-- Additive migration. Existing managers must be assigned explicitly by an admin.
CREATE TABLE IF NOT EXISTS `facility_managers` (
  `facility_id` INTEGER NOT NULL,
  `user_id` INTEGER NOT NULL,
  `granted_by_user_id` INTEGER NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`facility_id`, `user_id`),
  INDEX `facility_managers_user_id_idx` (`user_id`),
  CONSTRAINT `facility_managers_facility_id_fkey` FOREIGN KEY (`facility_id`) REFERENCES `production_facilities` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `facility_managers_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `facility_managers_granted_by_user_id_fkey` FOREIGN KEY (`granted_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
