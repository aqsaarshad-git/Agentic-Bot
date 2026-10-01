-- AlterTable
ALTER TABLE `transactions` ADD COLUMN `related_transaction_id` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `transfers` ADD COLUMN `fee` DECIMAL(18, 2) NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX `transactions_related_transaction_id_idx` ON `transactions`(`related_transaction_id`);

-- AddForeignKey
ALTER TABLE `transactions` ADD CONSTRAINT `transactions_related_transaction_id_fkey` FOREIGN KEY (`related_transaction_id`) REFERENCES `transactions`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

