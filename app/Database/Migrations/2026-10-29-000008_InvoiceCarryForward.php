<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use RuntimeException;

/**
 * คำขอเจ้าของระบบ (29 ต.ค. 2569) — ตอนปิดยอดเลือกได้ว่ายอดค้างเป็น "ส่วนลด" (ไม่เก็บ) หรือ "ยกไปเก็บงวดถัดไป"
 *
 * invoice_adjustments.carry_forward — บรรทัดปิดยอด (closes_balance = 1) ที่ยกยอดไปเก็บงวดถัดไป
 *   บิลต้นทางยังคิดเหมือนปิดยอดเดิมทุกอย่าง (ส่วนลดเท่ายอดค้าง → ชำระครบ) ต่างกันแค่ยอดนี้ยังเป็นหนี้ของร้านอยู่
 * invoice_adjustments.carried_from_id — บรรทัด "ยอดค้างยกมา" (kind CHARGE) ในบิลงวดถัดไป ชี้กลับไปบรรทัดปิดยอดต้นทาง
 *   ยอดยกไปที่ยังไม่มีบรรทัดชี้กลับจากบิลที่ไม่ถูกยกเลิก = รอขึ้นบิลถัดไป (ยกเลิกบิลที่รับไป ยอดก็กลับมารอเอง ไม่ต้องมีสถานะแยก)
 *   ไม่ใส่ UNIQUE เพราะบิลที่ถูกยกเลิกยังเก็บบรรทัดเดิมไว้เป็นประวัติ — ใบที่ออกใหม่ต้องชี้ต้นทางเดียวกันได้
 *
 * CHECK อ้างสองคอลัมน์ — MariaDB 10.4 ลบคอลัมน์ที่ถูกอ้างใน CHECK หลายคอลัมน์ไม่ได้ down() จึงถอด CHECK พร้อมคอลัมน์ในคำสั่งเดียว
 */
class InvoiceCarryForward extends Migration
{
    public function up(): void
    {
        $this->db->query(
            "ALTER TABLE invoice_adjustments
                ADD COLUMN carry_forward TINYINT(1) NOT NULL DEFAULT 0 AFTER closes_balance,
                ADD COLUMN carried_from_id INT UNSIGNED NULL AFTER carry_forward,
                ADD CONSTRAINT fk_adjust_carried_from FOREIGN KEY (carried_from_id) REFERENCES invoice_adjustments (id),
                ADD CONSTRAINT ck_adjust_carry_forward CHECK (carry_forward = 0 OR closes_balance = 1),
                ADD CONSTRAINT ck_adjust_carried_from CHECK (carried_from_id IS NULL OR kind = 'CHARGE')",
        );
    }

    /** ย้อนได้เฉพาะตอนยังไม่มีการยกยอด — ถอดออกแล้ว บรรทัดยกไปจะกลายเป็นส่วนลดที่ไม่มีใครเก็บ และบรรทัดยกมาเป็นค่าใช้จ่ายลอย ๆ */
    public function down(): void
    {
        $used = (int) $this->db->query('SELECT COUNT(*) AS n FROM invoice_adjustments WHERE carry_forward = 1 OR carried_from_id IS NOT NULL')->getRow()->n;
        if ($used > 0) {
            throw new RuntimeException("ย้อน migration นี้ไม่ได้: มีบรรทัดยกยอดไปงวดถัดไป/ยอดค้างยกมาแล้ว {$used} รายการ");
        }
        $this->db->query('ALTER TABLE invoice_adjustments DROP FOREIGN KEY fk_adjust_carried_from');
        $this->db->query(
            'ALTER TABLE invoice_adjustments
                DROP CONSTRAINT ck_adjust_carried_from,
                DROP CONSTRAINT ck_adjust_carry_forward,
                DROP COLUMN carried_from_id,
                DROP COLUMN carry_forward',
        );
    }
}
