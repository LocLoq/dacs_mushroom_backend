-- Preserve history. Legacy registrations must re-register.
ALTER TABLE `push_devices` DROP INDEX `push_devices_token_key`, MODIFY `token` TEXT NOT NULL,
 ADD COLUMN `identity_hash` CHAR(64) NULL,
 ADD COLUMN `provider` VARCHAR(20) NOT NULL DEFAULT 'legacy',
 ADD COLUMN `p256dh` VARCHAR(100) NULL,
 ADD COLUMN `auth` VARCHAR(50) NULL,
 ADD COLUMN `apns_environment` VARCHAR(10) NULL,
 ADD COLUMN `active` BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN `registration_id` VARCHAR(36) NULL;
UPDATE `push_devices` SET `identity_hash` = SHA2(CONCAT('legacy:',id),256), `registration_id` = UUID();
ALTER TABLE `push_devices` MODIFY `identity_hash` CHAR(64) NOT NULL, MODIFY `registration_id` VARCHAR(36) NOT NULL, ADD UNIQUE INDEX `push_devices_identity_hash_key` (`identity_hash`);
ALTER TABLE `push_deliveries` ADD COLUMN `cancelled_at` DATETIME(3) NULL;
UPDATE `push_deliveries` d JOIN `push_devices` p ON p.id=d.device_id SET d.cancelled_at=NOW(3) WHERE d.sent_at IS NULL AND p.provider='legacy' AND d.cancelled_at IS NULL;
