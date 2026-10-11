-- Run once on databases that already have the three gallery tables.
-- Existing images become private until a manager/admin publishes them.
ALTER TABLE `facility_images` ADD COLUMN `is_public` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `mushroom_images` ADD COLUMN `is_public` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `batch_images` ADD COLUMN `is_public` BOOLEAN NOT NULL DEFAULT false;
