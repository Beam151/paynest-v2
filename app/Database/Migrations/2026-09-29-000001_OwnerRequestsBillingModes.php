<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

/**
 * คำขอเจ้าของระบบ (ก.ย. 2569) — วิธีคิดยอดรายสินค้าในบิล · บิลค่าคอมเซล · รูปประกอบบิล · เลขบัญชีที่แจ้งร้านทาง Telegram
 *
 * ⚠ ไฟล์นี้ถูกแก้ตรง ๆ (ไม่ได้เพิ่ม migration ใหม่) ในรอบที่ 2 ของคำขอเดียวกัน — ทำได้เพราะยังไม่เคยขึ้นเครื่องจริง
 *   เคยรันแค่บนฐานข้อมูลทดสอบที่ทิ้งไปแล้ว · ฐานข้อมูลไหนเคยรันรุ่นแรกไว้ ให้ rollback แล้ว migrate ใหม่
 *   รอบ 2 เปลี่ยน: ถอดค่าคอมเซลอัตโนมัติรายบิลร้าน (sales_entries.agent_* ทิ้งทั้งชุด)
 *   → ค่าคอมเซลกลายเป็น "บิลค่าคอม" ที่ส่วนกลางทำเองทีหลัง ติ๊กเลือกรายการจากบิลร้านที่ออกไปแล้ว
 *
 * sales_entries (1 รายการ = 1 บรรทัดในบิล)
 *   bill_mode          ส่วนต่างของบรรทัดนี้มาจากไหน: PCT = คิดตาม % · MANUAL = กรอกยอดเอง
 *                      แถวเดิมทั้งหมดได้ 'PCT' — ก่อนหน้านี้ระบบคิดตาม % อย่างเดียวจริง ๆ
 *                      ตัวเลขที่ใช้เก็บเงินยังเป็น commission_amount_satang ช่องเดิม ของที่อ่านช่องนั้นอยู่จึงไม่ต้องแก้
 *
 * sales_commissions — แถวใหม่ kind = 'BILL' คือ "หัวบิลค่าคอม" หนึ่งใบ (ไม่ผูกร้าน/รอบ/บิลร้าน เพราะหนึ่งใบรวมได้หลายร้านหลายรอบ)
 *   bill_no            เลขบิลค่าคอม COM-YYYYMMDD-เซล (ห้ามซ้ำ) · แถวเก่า (DEAL/MANUAL) เป็น NULL
 *   period_id          ยอม NULL — บิลค่าคอมไม่มีรอบ (แถวเก่ายังมีรอบเหมือนเดิม)
 *   voided_at / void_reason   ยกเลิกเมื่อไร เพราะอะไร (ยกเลิกเองหรือบิลร้านถูกยกเลิกจนไม่เหลือรายการ)
 *   แถว DEAL/MANUAL ที่เกิดก่อนหน้านี้ยังอ่าน จ่าย และยกเลิกได้ตามเดิม
 *
 * sales_commission_lines — รายการในบิลค่าคอม
 *   ITEM   สินค้าหนึ่งบรรทัดของบิลร้าน (% ของยอดเต็ม หรือกรอกเอง) · base = ยอดขายเต็มของบรรทัดนั้น ณ ตอนทำบิล
 *   FIXED  "เหมาต่อรอบ" ของดีล — ครั้งเดียวต่อ เซล × ร้าน × รอบ
 *   OTHER  ค่าคอมอื่น ๆ ที่พิมพ์เอง (ติดลบได้ = หักคืน) ไม่มีรอบ ไม่มีร้าน
 *   active_entry_id / active_fixed_key = ค่าเดียวกับรายการ/คีย์เหมา "ตราบที่บรรทัดนี้ยังมีผล" (บิล PENDING/PAID)
 *     ยกเลิกบิลค่าคอมแล้วล้างเป็น NULL → รายการกลับไปติ๊กได้ใหม่
 *     UNIQUE สองตัวนี้คือด่านชั้นฐานข้อมูล: บรรทัดเดียวของบิลร้านจ่ายเป็นค่าคอมได้ครั้งเดียว ต่อให้กดพร้อมกันสองจอ
 *   ลบหัวบิลแล้วรายการหายตาม (CASCADE) · ลบรายการยอดขาย (หลังยกเลิกบิลร้าน) แล้วแค่ตัดลิงก์ (SET NULL)
 *   สองช่องนี้จึงห้ามถูกอ้างใน CHECK (ข้อจำกัดของ MySQL)
 *
 * invoice_attachments — รูป/PDF ประกอบบิล ลบแบบซ่อน (removed_at) ไฟล์จริงไม่ถูกลบ เพราะเป็นหลักฐานและสำรองไว้แล้ว
 *   ไม่มี CASCADE — บิลไม่เคยถูกลบ
 *
 * invoices.notified_bank / notified_bank_at — บัญชีที่ "ส่งเข้า Telegram ของร้านล่าสุด" (JSON snapshot)
 *   ไว้เทียบกับบัญชีที่บิลชี้อยู่ตอนนี้ ถ้าไม่ตรง = มีคนเปลี่ยนบัญชีหลังแจ้งร้าน ร้านต้องไม่โอน
 *
 * payment_submissions.bank_snapshot / account_confirmed_at — ตอนร้านแจ้งชำระ บิลชี้บัญชีไหน (เก็บเป็นค่า ไม่ใช่ id
 *   เพราะบัญชีแก้ทีหลังได้) และร้านติ๊กยืนยันว่าตรวจเลขบัญชีกับ Telegram แล้วหรือยัง — หลักฐานเวลามีข้อโต้แย้งเรื่องโอนผิดบัญชี
 *
 * ทุก CHECK / FK ตั้งชื่อไว้ เพื่อให้ down() ถอดทีละตัวได้
 * MariaDB 10.4: ลบคอลัมน์ที่ถูกอ้างใน CHECK หลายคอลัมน์ไม่ได้ และไม่มีคำสั่ง DROP CHECK
 *   → ต้อง DROP CONSTRAINT ทั้งหมดพร้อม DROP COLUMN ในคำสั่งเดียว · FK ต้องถอดก่อนเป็นคำสั่งแยก
 * MySQL เพิ่งมี DROP CONSTRAINT ใน 8.0.19 (8.0.16–8.0.18 มีแค่ DROP CHECK) — ไม่มีคำสั่งเดียวที่ใช้ได้ทั้งสองฝั่ง
 *   จึงยกขั้นต่ำเป็น MySQL 8.0.19 และ app:install ตรวจรุ่นก่อนรัน migration (DDL ของ MySQL ย้อนไม่ได้ —
 *   ถ้าปล่อยให้พังที่คำสั่งที่ 3 คอลัมน์ที่เพิ่มไปแล้วค้าง รันซ้ำก็ชน "Duplicate column" ต้องซ่อมมือ)
 */
class OwnerRequestsBillingModes extends Migration
{
    private const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

    public function up(): void
    {
        $this->db->query(
            "ALTER TABLE sales_entries
                ADD COLUMN bill_mode VARCHAR(8) NOT NULL DEFAULT 'PCT' AFTER commission_amount_satang,
                ADD CONSTRAINT ck_entries_bill_mode CHECK (bill_mode IN ('PCT', 'MANUAL'))",
        );

        /*
         * period_id มี FK — แก้ NULL/NOT NULL ต้องเป็นคำสั่งเดี่ยว (ALTER ที่ต้องคัดลอกตาราง เช่นพ่วงเพิ่ม CHECK
         * ถูก MariaDB ปฏิเสธด้วย 1832 "used in a foreign key constraint")
         * ck_comm_kind เดิมรับแค่ DEAL/MANUAL — ต้องถอดแล้วใส่ใหม่ (แก้ CHECK ในที่ไม่ได้)
         */
        $this->db->query('ALTER TABLE sales_commissions MODIFY period_id INT UNSIGNED NULL');
        $this->db->query(
            'ALTER TABLE sales_commissions
                ADD COLUMN bill_no     VARCHAR(64) NULL AFTER kind,
                ADD COLUMN voided_at   DATETIME    NULL AFTER paid_at,
                ADD COLUMN void_reason TEXT        NULL AFTER voided_at,
                ADD UNIQUE KEY uq_comm_bill_no (bill_no),
                DROP CONSTRAINT ck_comm_kind',
        );
        $this->db->query(
            "ALTER TABLE sales_commissions
                ADD CONSTRAINT ck_comm_kind CHECK (kind IN ('DEAL', 'MANUAL', 'BILL')),
                ADD CONSTRAINT ck_comm_bill CHECK (kind <> 'BILL' OR bill_no IS NOT NULL)",
        );

        $this->db->query(
            "CREATE TABLE sales_commission_lines (
                id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                commission_id      INT UNSIGNED NOT NULL,
                kind               VARCHAR(8)   NOT NULL,
                sales_entry_id     INT UNSIGNED NULL,
                invoice_id         INT UNSIGNED NULL,
                franchise_id       INT UNSIGNED NULL,
                period_id          INT UNSIGNED NULL,
                product_id         INT UNSIGNED NULL,
                link_id            INT UNSIGNED NULL,
                label              VARCHAR(200) NULL,
                mode               VARCHAR(8)   NULL,
                base_amount_satang BIGINT       NOT NULL DEFAULT 0,
                pct_bp             INT          NULL,
                amount_satang      BIGINT       NOT NULL,
                active_entry_id    INT UNSIGNED NULL,
                active_fixed_key   VARCHAR(64)  NULL,
                created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_scl_active_entry (active_entry_id),
                UNIQUE KEY uq_scl_active_fixed (active_fixed_key),
                KEY idx_scl_commission (commission_id),
                KEY idx_scl_entry (sales_entry_id),
                KEY idx_scl_invoice (invoice_id),
                CONSTRAINT fk_scl_commission FOREIGN KEY (commission_id) REFERENCES sales_commissions (id) ON DELETE CASCADE,
                CONSTRAINT fk_scl_entry FOREIGN KEY (sales_entry_id) REFERENCES sales_entries (id) ON DELETE SET NULL,
                CONSTRAINT fk_scl_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id),
                CONSTRAINT fk_scl_franchise FOREIGN KEY (franchise_id) REFERENCES franchises (id),
                CONSTRAINT fk_scl_period FOREIGN KEY (period_id) REFERENCES billing_periods (id),
                CONSTRAINT fk_scl_product FOREIGN KEY (product_id) REFERENCES products (id),
                CONSTRAINT fk_scl_link FOREIGN KEY (link_id) REFERENCES product_sales_links (id),
                CONSTRAINT ck_scl_kind CHECK (kind IN ('ITEM', 'FIXED', 'OTHER')),
                CONSTRAINT ck_scl_mode CHECK (mode IS NULL OR mode IN ('PCT', 'MANUAL')),
                CONSTRAINT ck_scl_pct CHECK (pct_bp IS NULL OR pct_bp BETWEEN 0 AND 10000),
                CONSTRAINT ck_scl_item_mode CHECK (kind <> 'ITEM' OR mode IS NOT NULL),
                CONSTRAINT ck_scl_other_label CHECK (kind <> 'OTHER' OR label IS NOT NULL),
                CONSTRAINT ck_scl_active CHECK ((active_entry_id IS NULL OR kind = 'ITEM') AND (active_fixed_key IS NULL OR kind = 'FIXED'))
            ) " . self::TABLE_OPTIONS,
        );

        $this->db->query(
            "CREATE TABLE invoice_attachments (
                id                  INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                invoice_id          INT UNSIGNED NOT NULL,
                file_url            VARCHAR(255) NOT NULL,
                caption             VARCHAR(200) NULL,
                uploaded_by_user_id INT UNSIGNED NULL,
                created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                removed_at          DATETIME     NULL,
                removed_by_user_id  INT UNSIGNED NULL,
                KEY idx_inv_att_invoice (invoice_id, removed_at),
                CONSTRAINT fk_inv_att_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id),
                CONSTRAINT fk_inv_att_user FOREIGN KEY (uploaded_by_user_id) REFERENCES users (id),
                CONSTRAINT fk_inv_att_remover FOREIGN KEY (removed_by_user_id) REFERENCES users (id),
                CONSTRAINT ck_inv_att_url CHECK (file_url LIKE '/api/uploads/%')
            ) " . self::TABLE_OPTIONS,
        );

        $this->db->query(
            'ALTER TABLE invoices
                ADD COLUMN notified_bank    TEXT     NULL AFTER bank_account_id,
                ADD COLUMN notified_bank_at DATETIME NULL AFTER notified_bank',
        );

        $this->db->query(
            'ALTER TABLE payment_submissions
                ADD COLUMN bank_snapshot        TEXT     NULL AFTER slip_url,
                ADD COLUMN account_confirmed_at DATETIME NULL AFTER bank_snapshot',
        );
    }

    public function down(): void
    {
        $this->db->query('DROP TABLE IF EXISTS sales_commission_lines');
        $this->db->query('DROP TABLE IF EXISTS invoice_attachments');
        $this->db->query('ALTER TABLE payment_submissions DROP COLUMN bank_snapshot, DROP COLUMN account_confirmed_at');
        $this->db->query('ALTER TABLE invoices DROP COLUMN notified_bank, DROP COLUMN notified_bank_at');

        /*
         * บิลค่าคอม (BILL) ไม่มีที่อยู่ในโครงสร้างเดิม (ไม่มีรอบ · kind ไม่อยู่ใน CHECK เดิม) — ถอยกลับ = ทิ้งทั้งหมด
         * รายการของมันถูกลบไปพร้อมตารางด้านบนแล้ว · แถว DEAL/MANUAL เดิมไม่แตะ (มีรอบครบทุกแถว)
         */
        $this->db->query("DELETE FROM sales_commissions WHERE kind = 'BILL'");
        $this->db->query(
            'ALTER TABLE sales_commissions
                DROP CONSTRAINT ck_comm_bill,
                DROP CONSTRAINT ck_comm_kind,
                DROP INDEX uq_comm_bill_no,
                DROP COLUMN bill_no,
                DROP COLUMN voided_at,
                DROP COLUMN void_reason',
        );
        $this->db->query('ALTER TABLE sales_commissions MODIFY period_id INT UNSIGNED NOT NULL'); // คำสั่งเดี่ยว — ดู up()
        $this->db->query("ALTER TABLE sales_commissions ADD CONSTRAINT ck_comm_kind CHECK (kind IN ('DEAL', 'MANUAL'))");

        // CHECK ต้องถอดพร้อมคอลัมน์ในคำสั่งเดียว — ดูหมายเหตุบนหัวไฟล์
        $this->db->query(
            'ALTER TABLE sales_entries
                DROP CONSTRAINT ck_entries_bill_mode,
                DROP COLUMN bill_mode',
        );
    }
}
