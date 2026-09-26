<?php

namespace App\Libraries;

/**
 * ตัวนับ rate limit เก็บในฐานข้อมูล (ตาราง rate_limits) — PHP ไม่มีหน่วยความจำข้ามคำขอ
 * และใช้ได้แม้รันหลาย process/หลายเครื่องที่ชี้ฐานข้อมูลเดียวกัน
 *
 * หน้าต่างเวลาแบบคงที่ต่อคีย์: เริ่มนับตอนโดนครั้งแรก ครบเวลาแล้วเริ่มใหม่
 * คีย์เก็บเป็น sha256 — ชื่อผู้ใช้ที่คนร้ายส่งมายาวเท่าไรก็ได้ ต้องไม่ทำให้คอลัมน์ล้น
 */
final class RateLimiter
{
    /** นับเพิ่มหนึ่งครั้ง แล้วคืนจำนวนครั้งในหน้าต่างปัจจุบัน */
    public static function hit(string $key, int $windowSeconds): int
    {
        $key   = hash('sha256', $key);
        $now   = time();
        $reset = $now + $windowSeconds;
        Db::exec(
            'INSERT INTO rate_limits (k, hits, reset_at) VALUES (?, 1, ?)
             ON DUPLICATE KEY UPDATE hits = IF(reset_at <= ?, 1, hits + 1),
                                     reset_at = IF(reset_at <= ?, ?, reset_at)',
            [$key, $reset, $now, $now, $reset],
        );

        return Db::int('SELECT hits FROM rate_limits WHERE k = ?', [$key]);
    }

    /** คืนครั้งที่นับไป (คำขอนั้นสำเร็จ — นับเฉพาะครั้งที่ล้มเหลว) */
    public static function undo(string $key): void
    {
        $key = hash('sha256', $key);
        Db::exec('UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE k = ? AND reset_at > ?', [$key, time()]);
    }

    /** ล้างตัวนับที่หมดเวลาไปนานแล้ว (เรียกจากงานตั้งเวลา) */
    public static function prune(): int
    {
        return Db::exec('DELETE FROM rate_limits WHERE reset_at < ?', [time() - 86400]);
    }
}
