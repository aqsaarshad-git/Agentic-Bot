-- AlterTable
ALTER TABLE `statement_requests` ADD COLUMN `conversation_id` VARCHAR(191) NULL,
    ADD COLUMN `email_sent_at` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `statement_requests_conversation_id_idx` ON `statement_requests`(`conversation_id`);

-- AddForeignKey
ALTER TABLE `statement_requests` ADD CONSTRAINT `statement_requests_conversation_id_fkey` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

