<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use RuntimeException;

/**
 * คำขอเจ้าของระบบรอบสอง (29 ก.ย. 2569) — ลิงก์เข้าระบบเฉพาะร้าน · บัญชีรับเงิน USD แบบกระเป๋าคริปโต · ค่าคอมเซลคิดจากยอดเต็มเสมอ
 *
 * franchises.login_key_hash / login_key_enc / login_key_rotated_at  (R7)
 *   ผู้ใช้ของร้านเข้าระบบได้เฉพาะผ่านลิงก์ของร้านตัวเอง (/#/s/<key>) — รหัสผ่านหลุด/ถูกเดาอย่างเดียวยังเข้าไม่ได้
 *   hash = sha256 ของ key ใช้ตรวจตอนล็อกอิน (unique — สองร้านไม่มีทางได้ key เดียวกัน)
 *   enc  = key ที่เข้ารหัสด้วย SecretBox ไว้ให้ส่วนกลาง/เจ้าของร้านเปิดดูและคัดลอกลิงก์ซ้ำได้
 *   ⚠ ไม่สร้าง key ใน migration นี้: SecretBox ต้องใช้ secrets.json ซึ่งติดตั้งใหม่แล้ว app:install สร้าง "หลัง" รัน migration
 *     → FranchiseService::ensureLoginKeys() สร้างให้ร้านที่ยังไม่มี (app:install เรียกทุกครั้ง + ตอนเปิดดูลิงก์)
 *
 * bank_accounts.account_number ขยายเป็น 128 ตัว + คอลัมน์ chain  (R9)
 *   บัญชี USD คือกระเป๋าคริปโต: ที่อยู่กระเป๋ายาว 34–64+ ตัว (เก็บในช่องเลขบัญชีเดิม) และต้องรู้เครือข่าย (chain)
 *   แถว USD เก็บ bank_name = chain ด้วย (BankAccountService ทำให้) — uq_bank_number (bank_name, account_number)
 *   จึงยังหมายถึง "เครือข่าย + ที่อยู่" ซ้ำไม่ได้ และทุกที่ที่พิมพ์ bank_name อยู่แล้วจะโชว์เครือข่ายเอง
 *   แถว USD ที่มีอยู่ก่อน (ข้อมูลตัวอย่าง/ทดสอบ) ยังไม่มี chain → เติมจาก bank_name ก่อนใส่ CHECK ไม่งั้น CHECK ใส่ไม่ผ่าน
 *
 * product_sales_links.basis = 'GROSS' ทุกแถว  (R10)
 *   เจ้าของระบบให้ % ค่าคอมเซลคิดจากยอดขายเต็มเสมอ ไม่มีให้เลือก · ระบบยังไม่ขึ้นใช้งานจริง จึงแปลงดีลเดิมทั้งหมดได้เลย
 *   คอลัมน์และ CHECK เดิมคงไว้ (ค่าคอมที่คิดไปแล้วบางแถวยังเขียนว่า COMMISSION และต้องแสดงผลได้)
 *   เปลี่ยนค่าตั้งต้นของคอลัมน์เป็น GROSS ด้วย — INSERT ที่ลืมใส่ basis จะได้ไม่กลับไปเป็นแบบที่เลิกใช้แล้ว
 *
 * MariaDB 10.4: ลบคอลัมน์ที่ถูกอ้างใน CHECK หลายคอลัมน์ต้อง DROP CONSTRAINT พร้อม DROP COLUMN ในคำสั่งเดียว (ดู migration 000001)
 */
class ShopLoginLinksUsdWallets extends Migration
{
    public function up(): void
    {
        $this->db->query(
            'ALTER TABLE franchises
                ADD COLUMN login_key_hash       CHAR(64) NULL AFTER status,
                ADD COLUMN login_key_enc        TEXT     NULL AFTER login_key_hash,
                ADD COLUMN login_key_rotated_at DATETIME NULL AFTER login_key_enc,
                ADD UNIQUE KEY uq_franchises_login_key (login_key_hash)',
        );

        $this->db->query(
            'ALTER TABLE bank_accounts
                MODIFY account_number VARCHAR(128) NOT NULL,
                ADD COLUMN chain VARCHAR(32) NULL AFTER currency',
        );
        // LEFT(…, 32): ชื่อธนาคารเดิมยาวได้ 150 ตัว — ตัดให้พอดีช่อง ดีกว่า migration ล้มกลางทางบน STRICT mode
        // (แถวแบบนี้แก้ครั้งถัดไประบบจะให้กรอกเครือข่ายให้ถูกรูปแบบเอง)
        $this->db->query("UPDATE bank_accounts SET chain = LEFT(bank_name, 32) WHERE currency = 'USD' AND chain IS NULL");
        $this->db->query("ALTER TABLE bank_accounts ADD CONSTRAINT ck_bank_chain CHECK (currency <> 'USD' OR chain IS NOT NULL)");

        $this->db->query("UPDATE product_sales_links SET basis = 'GROSS' WHERE basis <> 'GROSS'");
        $this->db->query("ALTER TABLE product_sales_links ALTER COLUMN basis SET DEFAULT 'GROSS'");
    }

    public function down(): void
    {
        // ตรวจก่อนแตะอะไร — ที่อยู่กระเป๋ายาวเกิน 32 ตัวย่อกลับไม่ได้ (STRICT จะล้มกลางทางแล้วค้างครึ่ง ๆ)
        $long = (int) ($this->db->query('SELECT COUNT(*) AS n FROM bank_accounts WHERE CHAR_LENGTH(account_number) > 32')->getRow()->n ?? 0);
        if ($long > 0) {
            throw new RuntimeException("ย้อน migration นี้ไม่ได้: มีบัญชีรับเงิน {$long} บัญชีที่เลขบัญชี/ที่อยู่กระเป๋ายาวเกิน 32 ตัว — ลบหรือแก้บัญชีเหล่านั้นก่อน");
        }

        // ดีลที่ถูกแปลงเป็น GROSS แล้วย้อนกลับไม่ได้ (ไม่ได้จดว่าเดิมเป็นแบบไหน) — คืนแค่ค่าตั้งต้นของคอลัมน์
        $this->db->query("ALTER TABLE product_sales_links ALTER COLUMN basis SET DEFAULT 'COMMISSION'");

        $this->db->query(
            'ALTER TABLE bank_accounts
                DROP CONSTRAINT ck_bank_chain,
                DROP COLUMN chain,
                MODIFY account_number VARCHAR(32) NOT NULL',
        );

        $this->db->query(
            'ALTER TABLE franchises
                DROP INDEX uq_franchises_login_key,
                DROP COLUMN login_key_rotated_at,
                DROP COLUMN login_key_enc,
                DROP COLUMN login_key_hash',
        );
    }
}
