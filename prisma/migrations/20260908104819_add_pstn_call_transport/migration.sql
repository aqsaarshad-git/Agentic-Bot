-- AlterTable
ALTER TABLE `calls` ADD COLUMN `from_number` VARCHAR(191) NULL,
    ADD COLUMN `provider_call_uuid` VARCHAR(191) NULL,
    ADD COLUMN `to_number` VARCHAR(191) NULL,
    ADD COLUMN `transport` ENUM('WEBRTC', 'PSTN') NOT NULL DEFAULT 'WEBRTC';

-- CreateIndex
CREATE UNIQUE INDEX `calls_provider_call_uuid_key` ON `calls`(`provider_call_uuid`);

