<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use RuntimeException;

/**
 * คำขอเจ้าของระบบ (5 ต.ค. 2569 · R25) — ตอนออกบิลร้าน ติ๊ก "หักค่าคอมเซล" ได้เลย: ร้านเป็นคนจ่ายค่าคอมให้เซลเอง
 * ยอดค่าคอมของเซลคนนั้น (ทุกรายการของเซลในบิลใบนั้น) จึงถูกหักออกจากยอดที่ร้านต้องจ่าย และถือว่าเซลได้รับแล้ว
 *
 * invoice_adjustments.sales_commission_id — บรรทัด "หักค่าคอมเซล" ในบิลร้าน ชี้ไปบิลค่าคอม (sales_commissions) ที่ระบบทำให้ตอนหัก
 *   บรรทัดนี้เป็น kind DISCOUNT ตามเดิม — ยอดรวม/ยอดยกมา/สถานะของบิลร้านคิดทางเดิมทั้งหมด ไม่มีสูตรใหม่
 *   NULL = ค่าใช้จ่าย/ส่วนลดธรรมดา (แถวเดิมทุกแถว) · หนึ่งบิลค่าคอมถูกหักได้จากบรรทัดเดียว (UNIQUE)
 *   ลิงก์นี้คือที่เดียวที่บอกว่าบิลค่าคอมใบไหน "ร้านเป็นคนจ่าย" (SalesAgentService อ่านผ่าน JOIN — ไม่มีคอลัมน์ซ้ำฝั่ง sales_commissions)
 *
 * ck_adjust_sales_commission อ้างสองคอลัมน์ — MariaDB 10.4 ลบคอลัมน์ที่ถูกอ้างใน CHECK หลายคอลัมน์ไม่ได้ down() จึงถอด CHECK พร้อมคอลัมน์ในคำสั่งเดียว
 */
class InvoiceSalesDeductions extends Migration
{
    public function up(): void
    {
        $this->db->query(
            "ALTER TABLE invoice_adjustments
                ADD COLUMN sales_commission_id INT UNSIGNED NULL AFTER charge_item_id,
                ADD UNIQUE KEY uq_adjust_sales_commission (sales_commission_id),
                ADD CONSTRAINT fk_adjust_sales_commission FOREIGN KEY (sales_commission_id) REFERENCES sales_commissions (id),
                ADD CONSTRAINT ck_adjust_sales_commission CHECK (sales_commission_id IS NULL OR kind = 'DISCOUNT')",
        );
    }

    /**
     * ย้อนได้เฉพาะตอนยังไม่มีบิลไหนหักค่าคอมเซล — ถ้ามีแล้ว ถอดลิงก์ออกจะเหลือ "ส่วนลด" ลอย ๆ ในบิลร้าน
     * กับบิลค่าคอมสถานะจ่ายแล้วที่ไม่มีใครรู้ว่าร้านเป็นคนจ่าย (ยกเลิกบิลร้านแล้วบิลค่าคอมจะไม่ถูกยกเลิกตาม)
     */
    public function down(): void
    {
        $linked = (int) $this->db->query('SELECT COUNT(*) AS n FROM invoice_adjustments WHERE sales_commission_id IS NOT NULL')->getRow()->n;
        if ($linked > 0) {
            throw new RuntimeException("ย้อน migration นี้ไม่ได้: มีรายการหักค่าคอมเซลในบิลร้านแล้ว {$linked} รายการ — ต้องถอนการหัก (หรือยกเลิกบิลร้านพวกนั้น) ก่อน");
        }
        $this->db->query('ALTER TABLE invoice_adjustments DROP FOREIGN KEY fk_adjust_sales_commission');
        $this->db->query(
            'ALTER TABLE invoice_adjustments
                DROP CONSTRAINT ck_adjust_sales_commission,
                DROP INDEX uq_adjust_sales_commission,
                DROP COLUMN sales_commission_id',
        );
    }
}
