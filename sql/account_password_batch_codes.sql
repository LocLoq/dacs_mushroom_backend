-- Run once on an existing database, before starting the updated API.
ALTER TABLE `users` ADD COLUMN `must_change_password` BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE `batch_code_counters` (
  `facility_id` INTEGER NOT NULL,
  `year` INTEGER NOT NULL,
  `last_number` INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (`facility_id`, `year`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- Parse the issued code, rather than current facility/start_date: batches can move.
INSERT INTO `batch_code_counters` (`facility_id`, `year`, `last_number`)
SELECT CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(UPPER(`batch_code`), '-', 2), 'CS', -1) AS UNSIGNED),
       CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(UPPER(`batch_code`), '-', 3), '-', -1) AS UNSIGNED),
       MAX(CAST(SUBSTRING_INDEX(UPPER(`batch_code`), '-', -1) AS UNSIGNED))
FROM `cultivation_batches`
WHERE `batch_code` REGEXP '^LO-CS[1-9][0-9]*-[0-9]{4}-[0-9]{3,}$'
GROUP BY 1, 2;
