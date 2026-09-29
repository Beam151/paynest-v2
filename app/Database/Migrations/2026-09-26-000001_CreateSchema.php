<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use Throwable;

/**
 * โครงสร้างฐานข้อมูลตั้งต้น (MariaDB 10.4+ / MySQL 8.0.19+ — ไฟล์นี้เองใช้ได้ตั้งแต่ 8.0.16 แต่ migration รุ่น 2.1.0 ต้อง 8.0.19) — ตรงกับระบบเดิมหลัง migration 034
 *
 * ข้อตกลง (อย่าเปลี่ยน):
 *   - เงินเป็นสตางค์ BIGINT · % เป็น basis point (1250 = 12.5%)
 *   - เวลาประทับเป็น UTC (DATETIME) · วันที่ทางธุรกิจเป็น DATE
 *   - invoice_payments.paid_at / sales_commissions.paid_at เก็บเป็นข้อความ เพราะมีได้ทั้ง
 *     'YYYY-MM-DD' (วันที่โอนตามสลิป) และ 'YYYY-MM-DD HH:MM:SS' (เวลาที่ระบบประทับ) — หน้าเว็บแสดงสองแบบต่างกัน
 *
 * ดัชนีแบบมีเงื่อนไขของ SQLite (UNIQUE … WHERE …) MySQL ไม่มี — ใช้คอลัมน์ที่คำนวณเอง (generated) แทน
 *   ค่าเป็น NULL เมื่อไม่เข้าเงื่อนไข · UNIQUE ยอมให้ NULL ซ้ำได้ จึงได้ผลเท่ากัน
 * คอลัมน์ที่ถูกใช้ใน CHECK หรือเป็นฐานของ generated column ห้ามมี ON DELETE CASCADE (ข้อจำกัดของ MySQL)
 * ระบบไม่เคยลบเซล/บิล จึงไม่เสียอะไร — ร้านและสินค้าลบได้ตั้งแต่ 30 ก.ย. 69 (R19/R20): โค้ดลบของที่ผูกอยู่เองก่อน
 * แล้วให้ FK ตัดสินว่ามีประวัติอ้างถึงไหม (มี = ลบแบบซ่อนแทน · Db::hardOrSoft) — ไม่พึ่ง CASCADE
 * (แก้เฉพาะคอมเมนต์นี้หลังรันไปแล้ว — ไม่มีผลกับโครงสร้าง)
 *
 * เพิ่ม/แก้โครงสร้างทีหลัง: สร้างไฟล์ migration ใหม่ (php spark make:migration) — ห้ามแก้ไฟล์นี้หลังขึ้นระบบจริง
 */
class CreateSchema extends Migration
{
    private const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

    public function up(): void
    {
        foreach ($this->tables() as $sql) {
            $this->db->query($sql . ' ' . self::TABLE_OPTIONS);
        }
        foreach ($this->indexes() as $sql) {
            $this->db->query($sql);
        }
        $this->seedChargeItems();
        $this->createTriggers();
    }

    public function down(): void
    {
        $this->db->query('SET FOREIGN_KEY_CHECKS = 0');
        foreach (array_reverse($this->tableNames()) as $table) {
            $this->db->query("DROP TABLE IF EXISTS `{$table}`");
        }
        $this->db->query('SET FOREIGN_KEY_CHECKS = 1');
    }

    private function tableNames(): array
    {
        return [
            'franchises', 'sales_agents', 'users', 'products', 'product_assignments', 'billing_periods',
            'bank_accounts', 'charge_items', 'invoices', 'sales_entries', 'invoice_adjustments', 'invoice_payments',
            'payment_submissions', 'product_sales_links', 'sales_commissions', 'franchise_credits', 'credit_usages',
            'ledger_entries', 'audit_logs', 'bank_account_changes', 'bank_account_change_acks', 'telegram_outbox',
            'app_settings', 'user_backup_codes', 'notification_digest', 'telegram_known_chats', 'telegram_link_codes',
            'announcements', 'announcement_reads', 'rate_limits',
        ];
    }

    private function tables(): array
    {
        return [
            "CREATE TABLE franchises (
                id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                username     VARCHAR(100) NOT NULL,
                contact_name TEXT NULL,
                phone        TEXT NULL,
                email        TEXT NULL,
                address      TEXT NULL,
                note         TEXT NULL,
                status       VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
                created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_franchises_username (username),
                CONSTRAINT ck_franchises_status CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED'))
            )",

            "CREATE TABLE sales_agents (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                username   VARCHAR(100) NOT NULL,
                name       TEXT         NOT NULL,
                phone      TEXT NULL,
                email      TEXT NULL,
                note       TEXT NULL,
                status     VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
                created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_sales_agents_username (username),
                CONSTRAINT ck_sales_agents_status CHECK (status IN ('ACTIVE', 'INACTIVE'))
            )",

            // แต่ละบทบาทต้องผูกกับเจ้าของข้อมูลให้ถูกช่องเท่านั้น
            "CREATE TABLE users (
                id                   INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                username             VARCHAR(100) NOT NULL,
                password_hash        VARCHAR(255) NOT NULL,
                display_name         TEXT NULL,
                role                 VARCHAR(16)  NOT NULL,
                franchise_id         INT UNSIGNED NULL,
                sales_agent_id       INT UNSIGNED NULL,
                status               VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
                last_login_at        DATETIME NULL,
                is_franchise_owner   TINYINT      NOT NULL DEFAULT 0,
                permissions          TEXT NULL,
                token_version        INT          NOT NULL DEFAULT 0,
                totp_secret          TEXT NULL,
                totp_pending_secret  TEXT NULL,
                totp_enabled_at      DATETIME NULL,
                totp_last_step       BIGINT       NOT NULL DEFAULT 0,
                must_change_password TINYINT      NOT NULL DEFAULT 0,
                onboarding           TEXT NULL,
                telegram_chat_id     VARCHAR(32) NULL,
                notify_prefs         TEXT NULL,
                created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_users_username (username),
                KEY idx_users_franchise (franchise_id),
                KEY idx_users_agent (sales_agent_id),
                KEY idx_users_owner (franchise_id, is_franchise_owner),
                CONSTRAINT fk_users_franchise FOREIGN KEY (franchise_id) REFERENCES franchises (id),
                CONSTRAINT fk_users_agent FOREIGN KEY (sales_agent_id) REFERENCES sales_agents (id),
                CONSTRAINT ck_users_role CHECK (role IN ('SUPER_ADMIN', 'FRANCHISE', 'SALES')),
                CONSTRAINT ck_users_status CHECK (status IN ('ACTIVE', 'DISABLED')),
                CONSTRAINT ck_users_owner CHECK (is_franchise_owner IN (0, 1)),
                CONSTRAINT ck_users_scope CHECK (
                    (role = 'SUPER_ADMIN' AND franchise_id IS NULL     AND sales_agent_id IS NULL) OR
                    (role = 'FRANCHISE'   AND franchise_id IS NOT NULL AND sales_agent_id IS NULL) OR
                    (role = 'SALES'       AND franchise_id IS NULL     AND sales_agent_id IS NOT NULL)
                )
            )",

            "CREATE TABLE products (
                id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                sku                VARCHAR(100) NOT NULL,
                name               TEXT         NOT NULL,
                description        TEXT NULL,
                commission_pct_bp  INT          NOT NULL DEFAULT 0,
                status             VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
                created_by_user_id INT UNSIGNED NULL,
                created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_products_sku (sku),
                CONSTRAINT fk_products_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id),
                CONSTRAINT ck_products_pct CHECK (commission_pct_bp BETWEEN 0 AND 10000),
                CONSTRAINT ck_products_status CHECK (status IN ('ACTIVE', 'ARCHIVED'))
            )",

            // สินค้า 1 ชิ้น = ร้านเดียวต่อช่วงเวลา · สัญญาที่ยังไม่มีวันสิ้นสุดมีได้ทีละหนึ่ง (open_product_id)
            "CREATE TABLE product_assignments (
                id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                product_id         INT UNSIGNED NOT NULL,
                franchise_id       INT UNSIGNED NOT NULL,
                start_date         DATE         NOT NULL,
                end_date           DATE NULL,
                note               TEXT NULL,
                created_by_user_id INT UNSIGNED NULL,
                created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                open_product_id    INT UNSIGNED GENERATED ALWAYS AS (IF(end_date IS NULL, product_id, NULL)) STORED,
                UNIQUE KEY uq_assign_open_ended (open_product_id),
                KEY idx_assign_franchise (franchise_id, start_date),
                KEY idx_assign_product (product_id, start_date),
                CONSTRAINT fk_assign_product FOREIGN KEY (product_id) REFERENCES products (id),
                CONSTRAINT fk_assign_franchise FOREIGN KEY (franchise_id) REFERENCES franchises (id),
                CONSTRAINT fk_assign_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id),
                CONSTRAINT ck_assign_range CHECK (end_date IS NULL OR end_date >= start_date)
            )",

            "CREATE TABLE billing_periods (
                id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                code            VARCHAR(10)  NOT NULL,
                year            SMALLINT     NOT NULL,
                month           TINYINT      NOT NULL,
                half            TINYINT      NOT NULL,
                start_date      DATE         NOT NULL,
                end_date        DATE         NOT NULL,
                status          VARCHAR(8)   NOT NULL DEFAULT 'OPEN',
                usd_rate_satang BIGINT NULL,
                created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_periods_code (code),
                UNIQUE KEY uq_periods_ymh (year, month, half),
                KEY idx_periods_range (start_date, end_date),
                CONSTRAINT ck_periods_month CHECK (month BETWEEN 1 AND 12),
                CONSTRAINT ck_periods_half CHECK (half IN (1, 2)),
                CONSTRAINT ck_periods_status CHECK (status IN ('OPEN', 'LOCKED')),
                CONSTRAINT ck_periods_rate CHECK (usd_rate_satang IS NULL OR usd_rate_satang > 0)
            )",

            // บัญชีหลักมีได้บัญชีเดียว (default_flag) · ธนาคาร+เลขบัญชีห้ามซ้ำ
            "CREATE TABLE bank_accounts (
                id             INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                bank_name      VARCHAR(150) NOT NULL,
                account_name   TEXT         NOT NULL,
                account_number VARCHAR(32)  NOT NULL,
                branch         TEXT NULL,
                note           TEXT NULL,
                is_default     TINYINT      NOT NULL DEFAULT 0,
                status         VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
                currency       CHAR(3)      NOT NULL DEFAULT 'THB',
                qr_url         VARCHAR(255) NULL,
                created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                default_flag   TINYINT GENERATED ALWAYS AS (IF(is_default = 1, 1, NULL)) STORED,
                UNIQUE KEY uq_bank_default (default_flag),
                UNIQUE KEY uq_bank_number (bank_name, account_number),
                CONSTRAINT ck_bank_default CHECK (is_default IN (0, 1)),
                CONSTRAINT ck_bank_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
                CONSTRAINT ck_bank_currency CHECK (currency IN ('THB', 'USD')),
                CONSTRAINT ck_bank_qr CHECK (qr_url IS NULL OR qr_url LIKE '/api/uploads/%')
            )",

            "CREATE TABLE charge_items (
                id                    INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                name                  VARCHAR(191) NOT NULL,
                kind                  VARCHAR(8)   NOT NULL,
                default_amount_satang BIGINT NULL,
                default_pct_bp        INT NULL,
                description           TEXT NULL,
                status                VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
                created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_charge_items_name (name),
                CONSTRAINT ck_charge_kind CHECK (kind IN ('CHARGE', 'DISCOUNT')),
                CONSTRAINT ck_charge_amount CHECK (default_amount_satang >= 0),
                CONSTRAINT ck_charge_pct CHECK (default_pct_bp BETWEEN 0 AND 10000),
                CONSTRAINT ck_charge_status CHECK (status IN ('ACTIVE', 'ARCHIVED'))
            )",

            // 1 ร้าน 1 รอบ = บิลใบเดียวที่ยังไม่ยกเลิก (active_franchise_id + period_id)
            // บิลดอลลาร์ต้องมีอัตราแลกเปลี่ยนตรึงไว้เสมอ (ck_invoices_usd_rate)
            "CREATE TABLE invoices (
                id                      INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                invoice_no              VARCHAR(191) NOT NULL,
                franchise_id            INT UNSIGNED NOT NULL,
                period_id               INT UNSIGNED NOT NULL,
                gross_total_satang      BIGINT       NOT NULL DEFAULT 0,
                commission_total_satang BIGINT       NOT NULL DEFAULT 0,
                charge_total_satang     BIGINT       NOT NULL DEFAULT 0,
                discount_total_satang   BIGINT       NOT NULL DEFAULT 0,
                net_total_satang        BIGINT       NOT NULL DEFAULT 0,
                credit_applied_satang   BIGINT       NOT NULL DEFAULT 0,
                paid_satang             BIGINT       NOT NULL DEFAULT 0,
                status                  VARCHAR(8)   NOT NULL DEFAULT 'OPEN',
                issued_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                due_date                DATE NULL,
                paid_at                 DATETIME NULL,
                note                    TEXT NULL,
                bank_account_id         INT UNSIGNED NULL,
                usd_rate_satang         BIGINT NULL,
                currency                CHAR(3)      NOT NULL DEFAULT 'THB',
                reminded_at             DATETIME NULL,
                overdue_nudges          INT          NOT NULL DEFAULT 0,
                created_by_user_id      INT UNSIGNED NULL,
                created_at              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                active_franchise_id     INT UNSIGNED GENERATED ALWAYS AS (IF(status <> 'VOID', franchise_id, NULL)) STORED,
                UNIQUE KEY uq_invoices_no (invoice_no),
                UNIQUE KEY uq_invoice_active_period (active_franchise_id, period_id),
                KEY idx_invoice_franchise_period (franchise_id, period_id, status),
                CONSTRAINT fk_invoices_franchise FOREIGN KEY (franchise_id) REFERENCES franchises (id),
                CONSTRAINT fk_invoices_period FOREIGN KEY (period_id) REFERENCES billing_periods (id),
                CONSTRAINT fk_invoices_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts (id),
                CONSTRAINT fk_invoices_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id),
                CONSTRAINT ck_invoices_status CHECK (status IN ('OPEN', 'PARTIAL', 'PAID', 'VOID')),
                CONSTRAINT ck_invoices_currency CHECK (currency IN ('THB', 'USD')),
                CONSTRAINT ck_invoices_rate CHECK (usd_rate_satang IS NULL OR usd_rate_satang > 0),
                CONSTRAINT ck_invoices_usd_rate CHECK (currency <> 'USD' OR usd_rate_satang IS NOT NULL)
            )",

            // 1 สินค้า / 1 รอบ = 1 รายการ · ยอดติดลบได้ (คืนสินค้า)
            "CREATE TABLE sales_entries (
                id                       INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                period_id                INT UNSIGNED NOT NULL,
                franchise_id             INT UNSIGNED NOT NULL,
                product_id               INT UNSIGNED NOT NULL,
                assignment_id            INT UNSIGNED NULL,
                units                    INT NULL,
                gross_amount_satang      BIGINT       NOT NULL,
                commission_pct_bp        INT          NOT NULL,
                commission_amount_satang BIGINT       NOT NULL,
                note                     TEXT NULL,
                status                   VARCHAR(16)  NOT NULL DEFAULT 'DRAFT',
                invoice_id               INT UNSIGNED NULL,
                submitted_at             DATETIME NULL,
                approved_at              DATETIME NULL,
                created_by_user_id       INT UNSIGNED NULL,
                updated_by_user_id       INT UNSIGNED NULL,
                created_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_entries_period_product (period_id, product_id),
                KEY idx_entries_franchise_period (franchise_id, period_id),
                KEY idx_entries_status (status),
                KEY idx_entries_invoice (invoice_id),
                CONSTRAINT fk_entries_period FOREIGN KEY (period_id) REFERENCES billing_periods (id),
                CONSTRAINT fk_entries_franchise FOREIGN KEY (franchise_id) REFERENCES franchises (id),
                CONSTRAINT fk_entries_product FOREIGN KEY (product_id) REFERENCES products (id),
                CONSTRAINT fk_entries_assignment FOREIGN KEY (assignment_id) REFERENCES product_assignments (id),
                CONSTRAINT fk_entries_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE SET NULL,
                CONSTRAINT fk_entries_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id),
                CONSTRAINT fk_entries_updater FOREIGN KEY (updated_by_user_id) REFERENCES users (id),
                CONSTRAINT ck_entries_pct CHECK (commission_pct_bp BETWEEN 0 AND 10000),
                CONSTRAINT ck_entries_status CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'INVOICED'))
            )",

            "CREATE TABLE invoice_adjustments (
                id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                invoice_id         INT UNSIGNED NOT NULL,
                charge_item_id     INT UNSIGNED NULL,
                kind               VARCHAR(8)   NOT NULL,
                label              TEXT         NOT NULL,
                pct_bp             INT NULL,
                amount_satang      BIGINT       NOT NULL,
                note               TEXT NULL,
                created_by_user_id INT UNSIGNED NULL,
                created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_adjust_invoice (invoice_id),
                CONSTRAINT fk_adjust_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE,
                CONSTRAINT fk_adjust_item FOREIGN KEY (charge_item_id) REFERENCES charge_items (id),
                CONSTRAINT fk_adjust_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id),
                CONSTRAINT ck_adjust_kind CHECK (kind IN ('CHARGE', 'DISCOUNT')),
                CONSTRAINT ck_adjust_pct CHECK (pct_bp BETWEEN 0 AND 10000),
                CONSTRAINT ck_adjust_amount CHECK (amount_satang >= 0)
            )",

            "CREATE TABLE invoice_payments (
                id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                invoice_id         INT UNSIGNED NOT NULL,
                amount_satang      BIGINT       NOT NULL,
                paid_at            VARCHAR(19)  NOT NULL,
                method             TEXT NULL,
                reference          TEXT NULL,
                note               TEXT NULL,
                created_by_user_id INT UNSIGNED NULL,
                created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_payments_invoice (invoice_id),
                CONSTRAINT fk_payments_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE,
                CONSTRAINT fk_payments_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id),
                CONSTRAINT ck_payments_amount CHECK (amount_satang > 0)
            )",

            "CREATE TABLE payment_submissions (
                id                   INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                invoice_id           INT UNSIGNED NOT NULL,
                franchise_id         INT UNSIGNED NOT NULL,
                amount_satang        BIGINT       NOT NULL,
                paid_at              DATE         NOT NULL,
                paid_time            VARCHAR(5) NULL,
                method               TEXT NULL,
                reference            TEXT NULL,
                slip_url             VARCHAR(255) NULL,
                note                 TEXT NULL,
                status               VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
                reject_reason        TEXT NULL,
                review_note          TEXT NULL,
                payment_id           INT UNSIGNED NULL,
                submitted_by_user_id INT UNSIGNED NULL,
                reviewed_by_user_id  INT UNSIGNED NULL,
                reviewed_at          DATETIME NULL,
                created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_paysub_invoice (invoice_id),
                KEY idx_paysub_status (status, created_at),
                KEY idx_paysub_franchise (franchise_id),
                CONSTRAINT fk_paysub_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE,
                CONSTRAINT fk_paysub_franchise FOREIGN KEY (franchise_id) REFERENCES franchises (id),
                CONSTRAINT fk_paysub_payment FOREIGN KEY (payment_id) REFERENCES invoice_payments (id) ON DELETE SET NULL,
                CONSTRAINT fk_paysub_submitter FOREIGN KEY (submitted_by_user_id) REFERENCES users (id),
                CONSTRAINT fk_paysub_reviewer FOREIGN KEY (reviewed_by_user_id) REFERENCES users (id),
                CONSTRAINT ck_paysub_amount CHECK (amount_satang > 0),
                CONSTRAINT ck_paysub_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'))
            )",

            // เซลเจ้าของดีลของสินค้าหนึ่งชิ้นมีได้คนเดียวต่อช่วงเวลา
            "CREATE TABLE product_sales_links (
                id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                product_id         INT UNSIGNED NOT NULL,
                sales_agent_id     INT UNSIGNED NOT NULL,
                basis              VARCHAR(16)  NOT NULL DEFAULT 'COMMISSION',
                commission_pct_bp  INT NULL,
                fixed_satang       BIGINT NULL,
                start_date         DATE         NOT NULL,
                end_date           DATE NULL,
                note               TEXT NULL,
                created_by_user_id INT UNSIGNED NULL,
                created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                open_product_id    INT UNSIGNED GENERATED ALWAYS AS (IF(end_date IS NULL, product_id, NULL)) STORED,
                UNIQUE KEY uq_prod_link_open_ended (open_product_id),
                KEY idx_prod_link_agent (sales_agent_id, start_date),
                KEY idx_prod_link_product (product_id, start_date),
                CONSTRAINT fk_link_product FOREIGN KEY (product_id) REFERENCES products (id),
                CONSTRAINT fk_link_agent FOREIGN KEY (sales_agent_id) REFERENCES sales_agents (id),
                CONSTRAINT fk_link_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id),
                CONSTRAINT ck_link_basis CHECK (basis IN ('COMMISSION', 'GROSS')),
                CONSTRAINT ck_link_pct CHECK (commission_pct_bp BETWEEN 0 AND 10000),
                CONSTRAINT ck_link_fixed CHECK (fixed_satang >= 0),
                CONSTRAINT ck_link_range CHECK (end_date IS NULL OR end_date >= start_date),
                CONSTRAINT ck_link_amount CHECK (commission_pct_bp IS NOT NULL OR fixed_satang IS NOT NULL)
            )",

            // บิลใบหนึ่งคิดคอมให้เซลคนหนึ่งได้แถวเดียว · รายการที่พิมพ์เอง (invoice_id NULL) ซ้ำได้
            "CREATE TABLE sales_commissions (
                id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                sales_agent_id     INT UNSIGNED NOT NULL,
                franchise_id       INT UNSIGNED NULL,
                period_id          INT UNSIGNED NOT NULL,
                invoice_id         INT UNSIGNED NULL,
                kind               VARCHAR(8)   NOT NULL DEFAULT 'DEAL',
                label              TEXT NULL,
                basis              VARCHAR(16)  NOT NULL,
                base_amount_satang BIGINT       NOT NULL DEFAULT 0,
                commission_pct_bp  INT NULL,
                pct_amount_satang  BIGINT       NOT NULL DEFAULT 0,
                fixed_satang       BIGINT       NOT NULL DEFAULT 0,
                total_satang       BIGINT       NOT NULL DEFAULT 0,
                status             VARCHAR(8)   NOT NULL DEFAULT 'PENDING',
                paid_at            VARCHAR(19) NULL,
                note               TEXT NULL,
                created_by_user_id INT UNSIGNED NULL,
                created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_sales_comm_invoice_agent (invoice_id, sales_agent_id),
                KEY idx_sales_comm_agent (sales_agent_id, period_id),
                KEY idx_sales_comm_kind (kind, period_id),
                KEY idx_sales_comm_status (status),
                CONSTRAINT fk_comm_agent FOREIGN KEY (sales_agent_id) REFERENCES sales_agents (id),
                CONSTRAINT fk_comm_franchise FOREIGN KEY (franchise_id) REFERENCES franchises (id),
                CONSTRAINT fk_comm_period FOREIGN KEY (period_id) REFERENCES billing_periods (id),
                CONSTRAINT fk_comm_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id),
                CONSTRAINT fk_comm_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id),
                CONSTRAINT ck_comm_kind CHECK (kind IN ('DEAL', 'MANUAL')),
                CONSTRAINT ck_comm_status CHECK (status IN ('PENDING', 'PAID', 'VOID')),
                CONSTRAINT ck_comm_manual CHECK (kind <> 'MANUAL' OR (label IS NOT NULL AND invoice_id IS NULL)),
                CONSTRAINT ck_comm_deal CHECK (kind <> 'DEAL' OR franchise_id IS NOT NULL)
            )",

            // ยอดที่ส่วนกลางติดค้างร้าน (รอบที่ติดลบ) — ยกไปหักบิลรอบถัดไป
            "CREATE TABLE franchise_credits (
                id                INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                franchise_id      INT UNSIGNED NOT NULL,
                amount_satang     BIGINT       NOT NULL,
                remaining_satang  BIGINT       NOT NULL,
                source_invoice_id INT UNSIGNED NULL,
                status            VARCHAR(16)  NOT NULL DEFAULT 'OPEN',
                note              TEXT NULL,
                created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_credit_open (franchise_id, status),
                KEY idx_credit_source (source_invoice_id),
                CONSTRAINT fk_credit_franchise FOREIGN KEY (franchise_id) REFERENCES franchises (id) ON DELETE CASCADE,
                CONSTRAINT fk_credit_source FOREIGN KEY (source_invoice_id) REFERENCES invoices (id) ON DELETE SET NULL,
                CONSTRAINT ck_credit_amount CHECK (amount_satang > 0),
                CONSTRAINT ck_credit_remaining CHECK (remaining_satang >= 0 AND remaining_satang <= amount_satang),
                CONSTRAINT ck_credit_status CHECK (status IN ('OPEN', 'USED', 'CANCELLED'))
            )",

            "CREATE TABLE credit_usages (
                id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                credit_id     INT UNSIGNED NOT NULL,
                invoice_id    INT UNSIGNED NOT NULL,
                amount_satang BIGINT       NOT NULL,
                created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_credit_usage_invoice (invoice_id),
                CONSTRAINT fk_usage_credit FOREIGN KEY (credit_id) REFERENCES franchise_credits (id) ON DELETE CASCADE,
                CONSTRAINT fk_usage_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE,
                CONSTRAINT ck_usage_amount CHECK (amount_satang > 0)
            )",

            // สมุดรายรับ-รายจ่ายของส่วนกลาง (ไม่เกี่ยวกับบิลของร้าน)
            "CREATE TABLE ledger_entries (
                id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                period_id          INT UNSIGNED NOT NULL,
                kind               VARCHAR(8)   NOT NULL,
                label              TEXT         NOT NULL,
                amount_satang      BIGINT       NOT NULL,
                spent_on           DATE NULL,
                note               TEXT NULL,
                created_by_user_id INT UNSIGNED NULL,
                created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_ledger_period (period_id, kind),
                CONSTRAINT fk_ledger_period FOREIGN KEY (period_id) REFERENCES billing_periods (id) ON DELETE CASCADE,
                CONSTRAINT fk_ledger_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id),
                CONSTRAINT ck_ledger_kind CHECK (kind IN ('EXPENSE', 'INCOME')),
                CONSTRAINT ck_ledger_amount CHECK (amount_satang >= 0)
            )",

            "CREATE TABLE audit_logs (
                id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                actor_user_id INT UNSIGNED NULL,
                action        VARCHAR(64)  NOT NULL,
                entity        VARCHAR(64) NULL,
                entity_id     INT UNSIGNED NULL,
                detail        MEDIUMTEXT NULL,
                created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_audit_created (created_at),
                KEY idx_audit_action (action),
                CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users (id)
            )",

            // ประวัติแก้บัญชีรับเงิน — เพิ่มได้อย่างเดียว (trigger กันแก้/ลบ) · ไม่ผูก FK กับบัญชี: บัญชีที่ถูกลบต้องยังเห็นว่าใครลบ
            "CREATE TABLE bank_account_changes (
                id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                bank_account_id INT UNSIGNED NULL,
                account_label   TEXT         NOT NULL,
                kind            VARCHAR(8)   NOT NULL,
                changes         MEDIUMTEXT   NOT NULL,
                open_invoices   INT          NOT NULL DEFAULT 0,
                actor_user_id   INT UNSIGNED NULL,
                created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_bank_change_created (created_at),
                CONSTRAINT fk_bank_change_actor FOREIGN KEY (actor_user_id) REFERENCES users (id),
                CONSTRAINT ck_bank_change_kind CHECK (kind IN ('CREATE', 'UPDATE', 'DELETE'))
            )",

            "CREATE TABLE bank_account_change_acks (
                change_id INT UNSIGNED NOT NULL,
                user_id   INT UNSIGNED NOT NULL,
                acked_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (change_id, user_id),
                CONSTRAINT fk_ack_change FOREIGN KEY (change_id) REFERENCES bank_account_changes (id),
                CONSTRAINT fk_ack_user FOREIGN KEY (user_id) REFERENCES users (id)
            )",

            // PENDING = รอส่ง/กำลังลองใหม่ · SENT = ส่งแล้ว · FAILED = ลองครบแล้วยังไม่ผ่าน · chat_id NULL = กลุ่มของส่วนกลาง
            "CREATE TABLE telegram_outbox (
                id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                text            MEDIUMTEXT   NOT NULL,
                change_id       INT UNSIGNED NULL,
                status          VARCHAR(8)   NOT NULL DEFAULT 'PENDING',
                attempts        INT          NOT NULL DEFAULT 0,
                last_error      TEXT NULL,
                next_attempt_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                sent_at         DATETIME NULL,
                chat_id         VARCHAR(32) NULL,
                created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_telegram_change (change_id),
                KEY idx_telegram_due (status, next_attempt_at),
                CONSTRAINT fk_outbox_change FOREIGN KEY (change_id) REFERENCES bank_account_changes (id),
                CONSTRAINT ck_outbox_status CHECK (status IN ('PENDING', 'SENT', 'FAILED'))
            )",

            // ค่าตั้งระบบแบบ key/value ที่แอดมินตั้งในหน้าเว็บ (Telegram, เรื่องที่แจ้งเตือน, สถานะสำรองข้อมูล …)
            'CREATE TABLE app_settings (
                name       VARCHAR(100) NOT NULL PRIMARY KEY,
                value      MEDIUMTEXT NULL,
                updated_by INT UNSIGNED NULL,
                updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users (id)
            )',

            'CREATE TABLE user_backup_codes (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                user_id    INT UNSIGNED NOT NULL,
                code_hash  CHAR(64)     NOT NULL,
                used_at    DATETIME NULL,
                created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_backup_codes_user (user_id),
                CONSTRAINT fk_backup_codes_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )',

            'CREATE TABLE notification_digest (
                id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                event_key  VARCHAR(64)  NOT NULL,
                line       TEXT         NOT NULL,
                created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                sent_at    DATETIME NULL,
                KEY idx_digest_unsent (sent_at)
            )',

            'CREATE TABLE telegram_known_chats (
                chat_id VARCHAR(32) NOT NULL PRIMARY KEY,
                title   TEXT NULL,
                type    VARCHAR(32) NULL,
                seen_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
            )',

            // รหัสผูกแชต Telegram — ตัวพิมพ์เล็ก/ใหญ่ต่างกัน (ascii_bin)
            'CREATE TABLE telegram_link_codes (
                code       VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
                user_id    INT UNSIGNED NOT NULL,
                expires_at DATETIME     NOT NULL,
                KEY idx_link_codes_user (user_id),
                CONSTRAINT fk_link_codes_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )',

            "CREATE TABLE announcements (
                id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                title        VARCHAR(191) NOT NULL,
                body         TEXT         NOT NULL,
                category     VARCHAR(16)  NOT NULL DEFAULT 'NEWS',
                pinned       TINYINT      NOT NULL DEFAULT 0,
                starts_at    DATE         NOT NULL,
                ends_at      DATE NULL,
                announced_at DATETIME NULL,
                created_by   INT UNSIGNED NULL,
                created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_announcements_start (starts_at),
                CONSTRAINT fk_announcements_author FOREIGN KEY (created_by) REFERENCES users (id),
                CONSTRAINT ck_announcements_category CHECK (category IN ('NEWS', 'PROMO', 'PRODUCT', 'HOLIDAY'))
            )",

            'CREATE TABLE announcement_reads (
                announcement_id INT UNSIGNED NOT NULL,
                user_id         INT UNSIGNED NOT NULL,
                read_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (announcement_id, user_id),
                KEY idx_reads_user (user_id),
                CONSTRAINT fk_reads_announcement FOREIGN KEY (announcement_id) REFERENCES announcements (id) ON DELETE CASCADE,
                CONSTRAINT fk_reads_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )',

            // ตัวนับกันเดารหัส/ถมดิสก์ (PHP ไม่มีหน่วยความจำข้ามคำขอ) — k เป็น hash ของคีย์ ความยาวคงที่
            'CREATE TABLE rate_limits (
                k        CHAR(64) CHARACTER SET ascii NOT NULL PRIMARY KEY,
                hits     INT      NOT NULL DEFAULT 0,
                reset_at BIGINT   NOT NULL,
                KEY idx_rate_limits_reset (reset_at)
            )',
        ];
    }

    private function indexes(): array
    {
        return [];
    }

    /** รายการค่าใช้จ่าย/ส่วนลดตั้งต้น (เหมือนที่ระบบเดิมใส่ไว้ตอนติดตั้ง) */
    private function seedChargeItems(): void
    {
        $rows = [
            ['ค่าการตลาดส่วนกลาง', 'CHARGE', null, 200, 'คิด 2% ของส่วนแบ่งในรอบนั้น'],
            ['ค่าระบบ/ซอฟต์แวร์', 'CHARGE', 50000, null, 'เหมาจ่าย 500 บาทต่อรอบ'],
            ['ค่าขนส่งสินค้า', 'CHARGE', null, null, 'กรอกจำนวนเงินตามจริงแต่ละรอบ'],
            ['ค่าปรับส่งยอดล่าช้า', 'CHARGE', 20000, null, 'เหมาจ่าย 200 บาท'],
            ['ส่วนลดโปรโมชัน', 'DISCOUNT', null, null, 'กรอกจำนวนเงินตามข้อตกลง'],
            ['ส่วนลดชำระก่อนกำหนด', 'DISCOUNT', null, 100, 'ลด 1% ของส่วนแบ่ง'],
        ];
        foreach ($rows as [$name, $kind, $amount, $pct, $description]) {
            $this->db->query(
                'INSERT INTO charge_items (name, kind, default_amount_satang, default_pct_bp, description) VALUES (?, ?, ?, ?, ?)',
                [$name, $kind, $amount, $pct, $description],
            );
        }
    }

    /**
     * ประวัติแก้บัญชีรับเงินต้องแก้/ลบไม่ได้ ต่อให้เข้าฐานข้อมูลได้ตรง ๆ ผ่านแอป
     * โฮสต์บางแห่งไม่ให้สร้าง trigger (ต้องมีสิทธิ์ SUPER เมื่อเปิด binary log) — สร้างไม่ได้ก็ข้าม
     * เพราะแอปเองไม่เคยแก้/ลบตารางนี้อยู่แล้ว trigger เป็นแค่ด่านสำรอง
     */
    private function createTriggers(): void
    {
        foreach (['UPDATE' => 'no_update', 'DELETE' => 'no_delete'] as $event => $suffix) {
            try {
                $this->db->query(
                    "CREATE TRIGGER bank_account_changes_{$suffix} BEFORE {$event} ON bank_account_changes FOR EACH ROW
                     SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bank_account_changes is append-only'",
                );
            } catch (Throwable $e) {
                log_message('warning', "สร้าง trigger bank_account_changes_{$suffix} ไม่ได้ (ข้าม): " . $e->getMessage());
            }
        }
    }
}
