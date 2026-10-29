<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use RuntimeException;

/**
 * คำขอเจ้าของระบบ (29 ต.ค. 2569) — ส่วนกลาง "ปิดยอด" บิลที่ร้านทยอยจ่ายแล้วเหลือเศษค้าง (เช่นเศษจากอัตราแลกเปลี่ยนตอนโอนเหรียญ) พร้อมหมายเหตุ
 *
 * invoice_adjustments.closes_balance — บรรทัด "ปิดยอด": ส่วนลดเท่ากับยอดค้างตอนกด บิลจึงกลายเป็นชำระครบ
 *   เป็น kind DISCOUNT ตามเดิม — ยอดรวม/สถานะคิดทางเดิมทั้งหมด ไม่มีสูตรใหม่ · ไม่ใช่เงินเข้า (invoice_payments ไม่ถูกแตะ)
 *   รายงานเงินที่ได้รับจริงจึงไม่เพี้ยน · ต้องแยกจากส่วนลดธรรมดาเพราะดึงไปใช้ซ้ำในบิลอื่นไม่ได้ (เป็นเรื่องเฉพาะบิลใบนั้น)
 *   0 = ค่าใช้จ่าย/ส่วนลดธรรมดา (แถวเดิมทุกแถว)
 */
class InvoiceCloseBalance extends Migration
{
    public function up(): void
    {
        $this->db->query(
            "ALTER TABLE invoice_adjustments
                ADD COLUMN closes_balance TINYINT(1) NOT NULL DEFAULT 0 AFTER sales_commission_id,
                ADD CONSTRAINT ck_adjust_closes_balance CHECK (closes_balance = 0 OR kind = 'DISCOUNT')",
        );
    }

    /** ย้อนได้เฉพาะตอนยังไม่มีบิลไหนถูกปิดยอด — ถอดคอลัมน์ออกบรรทัดนั้นจะกลายเป็นส่วนลดธรรมดาที่ดึงไปใช้กับบิลอื่นได้ */
    public function down(): void
    {
        $closed = (int) $this->db->query('SELECT COUNT(*) AS n FROM invoice_adjustments WHERE closes_balance = 1')->getRow()->n;
        if ($closed > 0) {
            throw new RuntimeException("ย้อน migration นี้ไม่ได้: มีบิลที่ปิดยอดไปแล้ว {$closed} ใบ");
        }
        $this->db->query('ALTER TABLE invoice_adjustments DROP CONSTRAINT ck_adjust_closes_balance, DROP COLUMN closes_balance');
    }
}
