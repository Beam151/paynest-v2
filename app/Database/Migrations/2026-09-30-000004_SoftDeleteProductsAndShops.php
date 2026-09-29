<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use RuntimeException;

/**
 * คำขอเจ้าของระบบ (30 ก.ย. 2569) — สินค้าลบได้อีกครั้ง (R19 · กลับคำตัดสิน R5) และร้านค้าลบได้ (R20)
 *
 * ลบ = ลองลบจริงก่อน ถ้ามีประวัติอ้างถึง (บิล ยอดขาย ประวัติรายการของผู้ใช้ร้าน …) FK ของฐานข้อมูลจะกันไว้
 * แล้วระบบเปลี่ยนเป็น "ลบแบบซ่อน" แทน (Db::hardOrSoft) — แถวยังอยู่ให้บิลเก่า join ชื่อ/รหัสได้ แต่หายจากทุกรายการ/ตัวเลือก
 *
 * products.status เพิ่มค่า 'DELETED' · deleted_at (UTC) · deleted_by_user_id (ใครกดลบ)
 * franchises.status เพิ่มค่า 'DELETED' · deleted_at · deleted_by_user_id
 *   ต่างจาก ARCHIVED (ปิดใช้งาน) / SUSPENDED / CLOSED ที่เปิดกลับได้ — DELETED ย้อนกลับไม่ได้ทั้งหน้าเว็บและ API
 *   รหัสสินค้า (SKU) / ชื่อร้าน (username) ของแถวที่ลบแบบซ่อนจึงใช้ซ้ำไม่ได้ (UNIQUE เดิม และบิลเก่ายังอ้างถึงชื่อนั้น)
 *
 * CHECK แก้ในที่ไม่ได้ — ถอดแล้วใส่ใหม่ชื่อเดิมในคำสั่งเดียว (MariaDB 10.4 / MySQL 8.0.19+ รับ DROP CONSTRAINT)
 * FK เพิ่มเป็นคำสั่งแยก: ALTER ที่พ่วงการเพิ่ม FK ต้องคัดลอกทั้งตาราง แยกไว้ให้คำสั่งแรกเบาและให้ error ชี้ชัดว่าพังที่ขั้นไหน
 * ⚠ DDL ของ MySQL ย้อนไม่ได้ — ลำดับคำสั่งเรียงให้ down() ถอดได้ทีละขั้น ลองกับสำเนาฐานข้อมูลก่อนเสมอ (HANDOVER)
 */
class SoftDeleteProductsAndShops extends Migration
{
    public function up(): void
    {
        $this->db->query(
            "ALTER TABLE products
                ADD COLUMN deleted_at         DATETIME     NULL AFTER updated_at,
                ADD COLUMN deleted_by_user_id INT UNSIGNED NULL AFTER deleted_at,
                DROP CONSTRAINT ck_products_status,
                ADD CONSTRAINT ck_products_status CHECK (status IN ('ACTIVE', 'ARCHIVED', 'DELETED'))",
        );
        $this->db->query('ALTER TABLE products ADD CONSTRAINT fk_products_deleter FOREIGN KEY (deleted_by_user_id) REFERENCES users (id)');

        $this->db->query(
            "ALTER TABLE franchises
                ADD COLUMN deleted_at         DATETIME     NULL AFTER updated_at,
                ADD COLUMN deleted_by_user_id INT UNSIGNED NULL AFTER deleted_at,
                DROP CONSTRAINT ck_franchises_status,
                ADD CONSTRAINT ck_franchises_status CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED', 'DELETED'))",
        );
        $this->db->query('ALTER TABLE franchises ADD CONSTRAINT fk_franchises_deleter FOREIGN KEY (deleted_by_user_id) REFERENCES users (id)');
    }

    /**
     * ถอยกลับได้เฉพาะตอนยังไม่มีอะไรถูกลบแบบซ่อน — สถานะ DELETED ไม่มีที่อยู่ในโครงสร้างเดิม
     * และแปลงกลับเป็นสถานะอื่นเองไม่ได้ (ARCHIVED/CLOSED เปิดกลับได้ = ของที่ลบไปแล้วโผล่กลับมาขายต่อ/เข้าระบบได้)
     * ตรวจก่อนแตะอะไร — ถ้าปล่อยให้ CHECK ใหม่ล้มกลางทาง คอลัมน์ที่ถอดไปแล้วจะค้างครึ่ง ๆ (DDL ย้อนไม่ได้)
     */
    public function down(): void
    {
        $products = (int) ($this->db->query("SELECT COUNT(*) AS n FROM products WHERE status = 'DELETED'")->getRow()->n ?? 0);
        $shops    = (int) ($this->db->query("SELECT COUNT(*) AS n FROM franchises WHERE status = 'DELETED'")->getRow()->n ?? 0);
        if ($products > 0 || $shops > 0) {
            throw new RuntimeException(
                "ย้อน migration นี้ไม่ได้: มีสินค้าที่ลบแล้ว {$products} รายการ และร้านที่ลบแล้ว {$shops} ร้าน (ลบแบบซ่อน บิลเก่ายังอ้างถึง) — "
                . 'โครงสร้างเดิมไม่มีสถานะ "ลบแล้ว" ให้เก็บ · กู้จากไฟล์สำรองก่อนอัปเดตแทน',
            );
        }

        // FK ต้องถอดเป็นคำสั่งแยกก่อนลบคอลัมน์ (ดู migration 000001) · ดัชนีที่ FK สร้างไว้หายไปพร้อมคอลัมน์
        $this->db->query('ALTER TABLE franchises DROP FOREIGN KEY fk_franchises_deleter');
        $this->db->query(
            "ALTER TABLE franchises
                DROP CONSTRAINT ck_franchises_status,
                DROP COLUMN deleted_by_user_id,
                DROP COLUMN deleted_at,
                ADD CONSTRAINT ck_franchises_status CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED'))",
        );

        $this->db->query('ALTER TABLE products DROP FOREIGN KEY fk_products_deleter');
        $this->db->query(
            "ALTER TABLE products
                DROP CONSTRAINT ck_products_status,
                DROP COLUMN deleted_by_user_id,
                DROP COLUMN deleted_at,
                ADD CONSTRAINT ck_products_status CHECK (status IN ('ACTIVE', 'ARCHIVED'))",
        );
    }
}
