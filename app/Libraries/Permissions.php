<?php

namespace App\Libraries;

/**
 * สิทธิ์รายข้อของผู้ช่วยร้านค้า
 *
 * ใช้กับผู้ช่วย (FRANCHISE ที่ไม่ใช่เจ้าของ) เท่านั้น
 * เจ้าของร้าน / super admin / เซล ไม่ถูกจำกัดด้วยชุดนี้
 *
 * เพิ่มข้อใหม่ได้โดยเติมใน PERMISSIONS แล้วไปใส่ perm.<key> ที่เส้นทางที่เกี่ยวข้อง (Config/Routes.php)
 * ของเก่าที่ permissions เป็น NULL จะยังทำได้ทุกอย่างเหมือนเดิม ไม่ต้องไล่อัปเดตข้อมูล
 */
final class Permissions
{
    public const PERMISSIONS = [
        ['key' => 'bills', 'label' => 'ดูบิลและยอดที่ต้องจ่าย', 'hint' => 'เห็นใบเรียกเก็บ ยอดค้าง และประวัติการชำระของร้าน'],
        ['key' => 'pay', 'label' => 'แจ้งชำระเงิน', 'hint' => 'กดชำระเงิน แนบสลิป และยกเลิกรายการที่ยังรอตรวจ'],
        ['key' => 'reports', 'label' => 'ดูรายงานและยอดขาย', 'hint' => 'เห็นภาพรวม ยอดขายย้อนหลัง และรายงานเปรียบเทียบ'],
        ['key' => 'products', 'label' => 'ดูรายการสินค้า', 'hint' => 'เห็นสินค้าที่ร้านถือสิทธิ์ขายและเปอร์เซ็นต์ส่วนต่าง'],
    ];

    public const KEYS = ['bills', 'pay', 'reports', 'products'];

    /** ชุดสิทธิ์ตั้งต้นของผู้ช่วยที่เพิ่งสร้าง — ดูได้หมดแต่ยังแตะเงินไม่ได้ */
    public const DEFAULT_STAFF = ['bills', 'reports', 'products'];

    public static function labelOf(string $key): string
    {
        foreach (self::PERMISSIONS as $p) {
            if ($p['key'] === $key) {
                return $p['label'];
            }
        }

        return $key;
    }

    /**
     * อ่านค่าจากคอลัมน์ permissions ให้เป็นอาเรย์
     * null / พัง / ไม่ใช่อาเรย์ = ไม่จำกัดสิทธิ์ (คืน null)
     */
    public static function parse(?string $raw): ?array
    {
        if ($raw === null || $raw === '') {
            return null;
        }
        $parsed = json_decode($raw, true);
        if (! is_array($parsed) || ! array_is_list($parsed)) {
            return null;
        }

        return array_values(array_filter($parsed, static fn ($key) => in_array($key, self::KEYS, true)));
    }

    /** เก็บเฉพาะคีย์ที่รู้จัก เรียงตามลำดับที่ประกาศไว้ เพื่อให้ค่าที่เก็บคงที่ */
    public static function normalize(?array $list): ?array
    {
        if ($list === null) {
            return null;
        }
        $set = array_flip(array_filter($list, 'is_string'));
        // จ่ายเงินได้แต่ดูบิลไม่ได้ = ทางตัน (หน้าจ่ายเงินอยู่ในหน้าบิล) — ให้ดูบิลตามไปด้วยเสมอ
        if (isset($set['pay'])) {
            $set['bills'] = true;
        }

        return array_values(array_filter(self::KEYS, static fn ($key) => isset($set[$key])));
    }

    /**
     * ผู้ใช้รายนี้ทำสิ่งนี้ได้ไหม
     *
     * ใครที่ไม่ใช่ผู้ช่วยร้านค้า (เจ้าของร้าน/super/เซล) ผ่านหมด
     * เพราะชุดสิทธิ์นี้ออกแบบมาเพื่อจำกัดผู้ช่วยโดยเฉพาะ
     */
    public static function has(?array $user, string $key): bool
    {
        if ($user === null) {
            return false;
        }
        if (($user['role'] ?? null) !== 'FRANCHISE') {
            return true;
        }
        if ((int) ($user['is_franchise_owner'] ?? 0) === 1) {
            return true;
        }
        $list = self::parse($user['permissions'] ?? null);

        return $list === null || in_array($key, $list, true);
    }
}
