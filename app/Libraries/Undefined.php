<?php

namespace App\Libraries;

/**
 * แทนค่า "ไม่ได้ส่งมา" (undefined ของ JavaScript) — ต่างจาก null ที่แปลว่า "ส่งมาว่าง ๆ"
 *
 * API เดิมแยกสองกรณีนี้ออกจากกัน เช่น endDate: null = ล้างวันสิ้นสุด แต่ไม่ส่ง endDate = ไม่แตะ
 * ใช้เฉพาะตอนตรวจ input เท่านั้น ข้อมูลหลังผ่าน Validator แล้วใช้ "ไม่มีคีย์" แทน
 */
final class Undefined
{
    private static ?self $instance = null;

    private function __construct()
    {
    }

    public static function get(): self
    {
        return self::$instance ??= new self();
    }
}
