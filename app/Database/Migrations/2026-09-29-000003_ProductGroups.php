<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

/**
 * คำขอเจ้าของระบบรอบสาม (29 ก.ย. 2569) — สินค้ากลุ่ม (ชุด)  (R14)
 *
 * เจ้าของระบบเลือกให้ "กลุ่ม = สินค้าหนึ่งชิ้น": มี SKU / % / สถานะ / ร้านที่ถือ / ยอดขาย / ดีลเซล ของตัวเองครบ
 * กรอกยอดขายเป็นยอดรวมก้อนเดียว บิลคิด % ของกลุ่มบรรทัดเดียว — ของเดิมทุกอย่างทำงานกับสินค้ากลุ่มได้โดยไม่ต้องแก้
 * สินค้าย่อยเป็นแค่รายการที่ติ๊กไว้ว่า "ในชุดมีอะไร" (ข้อมูลประกอบ ไม่มียอดขายแยกรายชิ้น)
 *
 * products.is_group — 1 = สินค้ากลุ่ม · แถวเดิมทั้งหมดได้ 0 (ก่อนหน้านี้ไม่มีสินค้ากลุ่ม)
 *
 * product_group_items — สินค้าย่อยของแต่ละกลุ่ม (sort_order = ลำดับที่ติ๊กไว้)
 *   สินค้าชิ้นเดียวอยู่ได้หลายกลุ่ม (แก้วใบเดียวกันอยู่ในสองชุด) · กลุ่มซ้อนกลุ่มไม่ได้ — ProductService กันไว้
 *   ไม่มี CASCADE — ตอนเขียนสินค้ายังลบไม่ได้ (R5) · ตั้งแต่ R19 ProductService::delete ลบแถวในตารางนี้เองก่อนลบ/ซ่อนสินค้า
 *
 * sales_entries.components_snapshot — JSON [{id, sku, name}] ของสินค้าย่อย ณ ตอนที่รายการนี้ขึ้นบิล
 *   บิลเก่าจึงโชว์ว่าในชุดมีอะไร "ตามวันที่ออกบิล" แม้ภายหลังจะแก้รายการย่อยของกลุ่ม
 *   NULL = ตอนขึ้นบิลไม่ใช่สินค้ากลุ่ม (หรือยังไม่เคยขึ้นบิล) — เก็บเป็นค่า ไม่ใช่ id เพราะรายการย่อยแก้ทีหลังได้
 *
 * ทุก CHECK / FK / KEY ตั้งชื่อไว้ เพื่อให้ down() ถอดทีละตัวได้
 * MariaDB 10.4: ลบคอลัมน์ที่ถูกอ้างใน CHECK ต้อง DROP CONSTRAINT พร้อม DROP COLUMN ในคำสั่งเดียว (ดู migration 000001)
 */
class ProductGroups extends Migration
{
    private const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

    public function up(): void
    {
        $this->db->query(
            'ALTER TABLE products
                ADD COLUMN is_group TINYINT NOT NULL DEFAULT 0 AFTER status,
                ADD CONSTRAINT ck_products_is_group CHECK (is_group IN (0, 1))',
        );

        $this->db->query(
            'CREATE TABLE product_group_items (
                group_product_id INT UNSIGNED NOT NULL,
                item_product_id  INT UNSIGNED NOT NULL,
                sort_order       INT          NOT NULL DEFAULT 0,
                created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (group_product_id, item_product_id),
                KEY idx_pgi_item (item_product_id),
                CONSTRAINT fk_pgi_group FOREIGN KEY (group_product_id) REFERENCES products (id),
                CONSTRAINT fk_pgi_item FOREIGN KEY (item_product_id) REFERENCES products (id)
            ) ' . self::TABLE_OPTIONS,
        );

        $this->db->query('ALTER TABLE sales_entries ADD COLUMN components_snapshot TEXT NULL AFTER bill_mode');
    }

    /**
     * ถอยกลับแล้วสินค้ากลุ่มกลายเป็นสินค้าธรรมดา (ยอดขาย/บิล/ดีลของมันยังอยู่ครบ เพราะเป็นสินค้าชิ้นหนึ่งอยู่แล้ว)
     * ที่หายคือรายการย่อยและ snapshot บนบิลเก่า — ไม่มีเงินตัวไหนอ้างถึงสองอย่างนี้ จึงไม่ต้องกันการถอยกลับ
     */
    public function down(): void
    {
        $this->db->query('ALTER TABLE sales_entries DROP COLUMN components_snapshot');
        $this->db->query('DROP TABLE IF EXISTS product_group_items');
        // CHECK ต้องถอดพร้อมคอลัมน์ในคำสั่งเดียว — ดูหมายเหตุบนหัวไฟล์
        $this->db->query(
            'ALTER TABLE products
                DROP CONSTRAINT ck_products_is_group,
                DROP COLUMN is_group',
        );
    }
}
