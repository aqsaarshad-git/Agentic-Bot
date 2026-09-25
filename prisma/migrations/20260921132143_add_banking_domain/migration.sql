-- AlterTable
ALTER TABLE `customers` ADD COLUMN `failed_login_attempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `online_banking_locked` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `online_banking_locked_at` DATETIME(3) NULL,
    ADD COLUMN `password_hash` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `tickets` ADD COLUMN `account_id` VARCHAR(191) NULL,
    ADD COLUMN `card_id` VARCHAR(191) NULL,
    ADD COLUMN `dispute_amount` DECIMAL(18, 2) NULL,
    ADD COLUMN `subcategory` VARCHAR(191) NULL,
    ADD COLUMN `transaction_id` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `accounts` (
    `id` VARCHAR(191) NOT NULL,
    `account_number` VARCHAR(191) NOT NULL,
    `customer_id` VARCHAR(191) NOT NULL,
    `account_type` ENUM('CHECKING', 'SAVINGS', 'BUSINESS') NOT NULL DEFAULT 'CHECKING',
    `status` ENUM('ACTIVE', 'DORMANT', 'SUSPENDED', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `currency` VARCHAR(191) NOT NULL DEFAULT 'SAR',
    `balance` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `available_balance` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `daily_transfer_limit` DECIMAL(18, 2) NOT NULL DEFAULT 50000,
    `daily_withdrawal_limit` DECIMAL(18, 2) NOT NULL DEFAULT 10000,
    `status_reason` VARCHAR(191) NULL,
    `opened_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `accounts_account_number_key`(`account_number`),
    INDEX `accounts_customer_id_idx`(`customer_id`),
    INDEX `accounts_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `transactions` (
    `id` VARCHAR(191) NOT NULL,
    `transaction_ref` VARCHAR(191) NOT NULL,
    `account_id` VARCHAR(191) NOT NULL,
    `card_id` VARCHAR(191) NULL,
    `type` ENUM('DEBIT', 'CREDIT') NOT NULL,
    `channel` ENUM('CARD_PURCHASE', 'POS', 'ONLINE', 'ATM_WITHDRAWAL', 'ATM_DEPOSIT', 'TRANSFER', 'FEE', 'REFUND', 'DIRECT_DEBIT', 'OTHER') NOT NULL DEFAULT 'OTHER',
    `amount` DECIMAL(18, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'SAR',
    `status` ENUM('PENDING', 'COMPLETED', 'FAILED', 'REVERSED') NOT NULL DEFAULT 'PENDING',
    `failure_reason` ENUM('INSUFFICIENT_FUNDS', 'CARD_EXPIRED', 'CARD_BLOCKED', 'ACCOUNT_SUSPENDED', 'LIMIT_EXCEEDED', 'INCORRECT_PIN', 'ISSUER_DECLINED', 'NETWORK_ERROR', 'FRAUD_SUSPECTED', 'OTHER') NULL,
    `description` VARCHAR(191) NULL,
    `merchant_name` VARCHAR(191) NULL,
    `posted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `settled_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `transactions_transaction_ref_key`(`transaction_ref`),
    INDEX `transactions_account_id_idx`(`account_id`),
    INDEX `transactions_account_id_posted_at_idx`(`account_id`, `posted_at`),
    INDEX `transactions_status_idx`(`status`),
    INDEX `transactions_card_id_idx`(`card_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cards` (
    `id` VARCHAR(191) NOT NULL,
    `card_number_masked` VARCHAR(191) NOT NULL,
    `account_id` VARCHAR(191) NOT NULL,
    `card_type` ENUM('DEBIT', 'CREDIT', 'PREPAID') NOT NULL DEFAULT 'DEBIT',
    `status` ENUM('ACTIVE', 'BLOCKED', 'EXPIRED', 'LOST', 'STOLEN', 'PENDING_ACTIVATION', 'PENDING_REPLACEMENT') NOT NULL DEFAULT 'PENDING_ACTIVATION',
    `expiry_month` INTEGER NOT NULL,
    `expiry_year` INTEGER NOT NULL,
    `daily_purchase_limit` DECIMAL(18, 2) NOT NULL DEFAULT 5000,
    `daily_atm_limit` DECIMAL(18, 2) NOT NULL DEFAULT 3000,
    `pin_hash` VARCHAR(255) NULL,
    `pin_set_at` DATETIME(3) NULL,
    `pin_failed_attempts` INTEGER NOT NULL DEFAULT 0,
    `pin_blocked_at` DATETIME(3) NULL,
    `activated_at` DATETIME(3) NULL,
    `blocked_at` DATETIME(3) NULL,
    `block_reason` VARCHAR(191) NULL,
    `lost_reported_at` DATETIME(3) NULL,
    `stolen_reported_at` DATETIME(3) NULL,
    `replaces_card_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `cards_replaces_card_id_key`(`replaces_card_id`),
    INDEX `cards_account_id_idx`(`account_id`),
    INDEX `cards_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `beneficiaries` (
    `id` VARCHAR(191) NOT NULL,
    `customer_id` VARCHAR(191) NOT NULL,
    `nickname` VARCHAR(191) NULL,
    `beneficiary_name` VARCHAR(191) NOT NULL,
    `account_number` VARCHAR(191) NOT NULL,
    `bank_name` VARCHAR(191) NULL,
    `bank_code` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'PENDING_VERIFICATION', 'BLOCKED', 'REMOVED') NOT NULL DEFAULT 'ACTIVE',
    `added_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `removed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `beneficiaries_customer_id_status_idx`(`customer_id`, `status`),
    UNIQUE INDEX `beneficiaries_customer_id_account_number_key`(`customer_id`, `account_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `transfers` (
    `id` VARCHAR(191) NOT NULL,
    `transfer_reference` VARCHAR(191) NOT NULL,
    `customer_id` VARCHAR(191) NOT NULL,
    `conversation_id` VARCHAR(191) NOT NULL,
    `verification_session_id` VARCHAR(191) NULL,
    `from_account_id` VARCHAR(191) NOT NULL,
    `to_account_id` VARCHAR(191) NULL,
    `beneficiary_id` VARCHAR(191) NULL,
    `type` ENUM('INTERNAL', 'BENEFICIARY') NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'SAR',
    `reason` VARCHAR(191) NULL,
    `status` ENUM('PENDING_CONFIRMATION', 'CONFIRMED', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED') NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    `failure_reason` ENUM('INSUFFICIENT_FUNDS', 'CARD_EXPIRED', 'CARD_BLOCKED', 'ACCOUNT_SUSPENDED', 'LIMIT_EXCEEDED', 'INCORRECT_PIN', 'ISSUER_DECLINED', 'NETWORK_ERROR', 'FRAUD_SUSPECTED', 'OTHER') NULL,
    `resulting_transaction_id` VARCHAR(191) NULL,
    `confirmation_expires_at` DATETIME(3) NOT NULL,
    `confirmed_at` DATETIME(3) NULL,
    `executed_at` DATETIME(3) NULL,
    `provider_reference` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `transfers_transfer_reference_key`(`transfer_reference`),
    UNIQUE INDEX `transfers_resulting_transaction_id_key`(`resulting_transaction_id`),
    INDEX `transfers_customer_id_idx`(`customer_id`),
    INDEX `transfers_from_account_id_idx`(`from_account_id`),
    INDEX `transfers_conversation_id_status_idx`(`conversation_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `statement_requests` (
    `id` VARCHAR(191) NOT NULL,
    `request_number` VARCHAR(191) NOT NULL,
    `customer_id` VARCHAR(191) NOT NULL,
    `account_id` VARCHAR(191) NOT NULL,
    `period_start` DATETIME(3) NOT NULL,
    `period_end` DATETIME(3) NOT NULL,
    `format` VARCHAR(191) NOT NULL DEFAULT 'PDF',
    `status` ENUM('PENDING', 'READY', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `download_url` VARCHAR(191) NULL,
    `requested_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ready_at` DATETIME(3) NULL,

    UNIQUE INDEX `statement_requests_request_number_key`(`request_number`),
    INDEX `statement_requests_customer_id_idx`(`customer_id`),
    INDEX `statement_requests_account_id_idx`(`account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `verification_sessions` (
    `id` VARCHAR(191) NOT NULL,
    `customer_id` VARCHAR(191) NOT NULL,
    `conversation_id` VARCHAR(191) NULL,
    `purpose` ENUM('IDENTITY', 'PIN_RESET', 'PASSWORD_RESET') NOT NULL DEFAULT 'IDENTITY',
    `target_ref` VARCHAR(191) NULL,
    `method` ENUM('OTP_SMS', 'OTP_EMAIL') NOT NULL DEFAULT 'OTP_SMS',
    `code_hash` VARCHAR(255) NULL,
    `status` ENUM('VERIFICATION_IN_PROGRESS', 'VERIFIED', 'VERIFICATION_FAILED', 'LOCKED') NOT NULL DEFAULT 'VERIFICATION_IN_PROGRESS',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `max_attempts` INTEGER NOT NULL DEFAULT 3,
    `expires_at` DATETIME(3) NOT NULL,
    `verified_at` DATETIME(3) NULL,
    `consumed_at` DATETIME(3) NULL,
    `locked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `verification_sessions_customer_id_created_at_idx`(`customer_id`, `created_at`),
    INDEX `verification_sessions_conversation_id_created_at_idx`(`conversation_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `tickets_account_id_idx` ON `tickets`(`account_id`);

-- CreateIndex
CREATE INDEX `tickets_card_id_idx` ON `tickets`(`card_id`);

-- CreateIndex
CREATE INDEX `tickets_transaction_id_idx` ON `tickets`(`transaction_id`);

-- AddForeignKey
ALTER TABLE `tickets` ADD CONSTRAINT `tickets_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tickets` ADD CONSTRAINT `tickets_card_id_fkey` FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tickets` ADD CONSTRAINT `tickets_transaction_id_fkey` FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `accounts` ADD CONSTRAINT `accounts_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transactions` ADD CONSTRAINT `transactions_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transactions` ADD CONSTRAINT `transactions_card_id_fkey` FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cards` ADD CONSTRAINT `cards_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cards` ADD CONSTRAINT `cards_replaces_card_id_fkey` FOREIGN KEY (`replaces_card_id`) REFERENCES `cards`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `beneficiaries` ADD CONSTRAINT `beneficiaries_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transfers` ADD CONSTRAINT `transfers_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transfers` ADD CONSTRAINT `transfers_conversation_id_fkey` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transfers` ADD CONSTRAINT `transfers_verification_session_id_fkey` FOREIGN KEY (`verification_session_id`) REFERENCES `verification_sessions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transfers` ADD CONSTRAINT `transfers_from_account_id_fkey` FOREIGN KEY (`from_account_id`) REFERENCES `accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transfers` ADD CONSTRAINT `transfers_to_account_id_fkey` FOREIGN KEY (`to_account_id`) REFERENCES `accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transfers` ADD CONSTRAINT `transfers_beneficiary_id_fkey` FOREIGN KEY (`beneficiary_id`) REFERENCES `beneficiaries`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transfers` ADD CONSTRAINT `transfers_resulting_transaction_id_fkey` FOREIGN KEY (`resulting_transaction_id`) REFERENCES `transactions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `statement_requests` ADD CONSTRAINT `statement_requests_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `statement_requests` ADD CONSTRAINT `statement_requests_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `verification_sessions` ADD CONSTRAINT `verification_sessions_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `verification_sessions` ADD CONSTRAINT `verification_sessions_conversation_id_fkey` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

