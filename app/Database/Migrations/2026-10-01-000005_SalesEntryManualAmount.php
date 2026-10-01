<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

/**
 * คำขอเจ้าของระบบ (1 ต.ค. 2569 · R21) — กรอก "ยอดส่วนต่างที่กรอกเอง" ไว้ล่วงหน้าที่หน้ายอดขายรายรอบ แล้วเลือกตอนออกบิล
 * ว่าบรรทัดนั้นจะใช้ยอดที่กรอกไว้ หรือคิดจากยอดเต็ม × %
 *
 * sales_entries.manual_amount_satang — ยอดส่วนต่างที่ส่วนกลางกรอกไว้ที่หน้ายอดขาย (NULL = ไม่ได้กรอก)
 *   เป็น "ค่าของหน้ายอดขาย" เท่านั้น — ยอดที่ใช้เก็บเงินจริงยังเป็น commission_amount_satang + bill_mode ช่องเดิม
 *   (บันทึกยอดแล้วตั้งค่าตั้งต้นให้: มียอดที่กรอกไว้ = MANUAL ตามยอดนั้น · ไม่มี = PCT)
 *   เลือกวิธีคิดตอนออกบิลไม่แตะช่องนี้ ของที่อ่าน commission_amount_satang อยู่จึงไม่ต้องแก้
 *   แถวเดิมทั้งหมดได้ NULL — ก่อนหน้านี้ไม่มีช่องให้กรอก
 *
 * ck_entries_manual — ด่านชั้นฐานข้อมูลของกติกาเดียวกับ SalesService::manualFits:
 *   เป็น 0 ได้เสมอ · ไม่งั้นต้องเครื่องหมายเดียวกับยอดเต็ม และไม่เกินยอดเต็ม (บันทึกยอดเต็มใหม่ที่ทำให้ยอดที่กรอกไว้เกิน = 400 ก่อนถึงตรงนี้)
 *   อ้างสองคอลัมน์ — MariaDB 10.4 ลบคอลัมน์ที่ถูกอ้างใน CHECK หลายคอลัมน์ไม่ได้ down() จึงถอด CHECK พร้อมคอลัมน์ในคำสั่งเดียว
 */
class SalesEntryManualAmount extends Migration
{
    public function up(): void
    {
        $this->db->query(
            'ALTER TABLE sales_entries
                ADD COLUMN manual_amount_satang BIGINT NULL AFTER commission_amount_satang,
                ADD CONSTRAINT ck_entries_manual CHECK (
                    manual_amount_satang IS NULL OR manual_amount_satang = 0
                    OR (SIGN(manual_amount_satang) = SIGN(gross_amount_satang)
                        AND ABS(manual_amount_satang) <= ABS(gross_amount_satang))
                )',
        );
    }

    /**
     * ย้อนได้เสมอ — ยอดที่ใช้เก็บเงิน (commission_amount_satang + bill_mode) ไม่ได้อยู่ในคอลัมน์นี้
     * สิ่งที่หายคือ "ยอดที่กรอกไว้ล่วงหน้า" ของรายการที่ยังไม่ออกบิล: บรรทัดที่ตั้งเป็น MANUAL ไว้แล้วยังเก็บยอดนั้นต่อ
     */
    public function down(): void
    {
        $this->db->query(
            'ALTER TABLE sales_entries
                DROP CONSTRAINT ck_entries_manual,
                DROP COLUMN manual_amount_satang',
        );
    }
}
