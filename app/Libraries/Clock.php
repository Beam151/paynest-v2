<?php

namespace App\Libraries;

use DateTimeImmutable;
use DateTimeZone;

/**
 * เวลาของระบบ
 *
 * ฐานข้อมูลเก็บเวลาเป็น UTC รูปแบบ 'YYYY-MM-DD HH:MM:SS' (แบบเดียวกับตัวเดิม — หน้าเว็บอ่านเป็น UTC)
 * ตรรกะที่ขึ้นกับ "วันนี้" ใช้เวลาไทย (UTC+7 ตลอดปี ไม่มี DST) ไม่ผูกกับ timezone ของเครื่อง
 */
final class Clock
{
    public const THAI_TZ = 'Asia/Bangkok';

    private static ?DateTimeZone $thai = null;
    private static ?DateTimeZone $utc  = null;

    public static function thaiZone(): DateTimeZone
    {
        return self::$thai ??= new DateTimeZone(self::THAI_TZ);
    }

    public static function utcZone(): DateTimeZone
    {
        return self::$utc ??= new DateTimeZone('UTC');
    }

    /** เวลาปัจจุบันแบบ UTC 'Y-m-d H:i:s' — แทน datetime('now') */
    public static function nowUtc(): string
    {
        return gmdate('Y-m-d H:i:s');
    }

    /** เวลา UTC ที่เลื่อนไปจากตอนนี้ เช่น '+15 minutes' — แทน datetime('now', '+15 minutes') */
    public static function utcShift(string $modify): string
    {
        return (new DateTimeImmutable('now', self::utcZone()))->modify($modify)->format('Y-m-d H:i:s');
    }

    /** วันที่ UTC — แทน date('now') ของ SQLite (บางจุดของตัวเดิมตั้งใจใช้วันแบบ UTC) */
    public static function todayUtc(): string
    {
        return gmdate('Y-m-d');
    }

    /** เวลาไทยตอนนี้ */
    public static function thaiNow(): DateTimeImmutable
    {
        return new DateTimeImmutable('now', self::thaiZone());
    }

    /** "วันนี้" ตามเวลาไทย — ร้านที่แจ้งโอนตอนตีหนึ่งต้องไม่โดนหาว่าโอนวันพรุ่งนี้ */
    public static function todayThai(): string
    {
        return self::thaiNow()->format('Y-m-d');
    }

    /**
     * เวลาไทยจากข้อความ เช่น '2026-09-20T10:00' (ใช้กับ --now ของคำสั่งตั้งเวลา)
     * ไม่ระบุ = ตอนนี้
     */
    public static function thaiAt(?string $wallClock): DateTimeImmutable
    {
        if ($wallClock === null || $wallClock === '') {
            return self::thaiNow();
        }

        return new DateTimeImmutable(str_replace('T', ' ', $wallClock), self::thaiZone());
    }

    /** แปลงเวลาใด ๆ เป็น UTC 'Y-m-d H:i:s' สำหรับเก็บลงฐานข้อมูล */
    public static function toUtcString(DateTimeImmutable $at): string
    {
        return $at->setTimezone(self::utcZone())->format('Y-m-d H:i:s');
    }

    /** เวลา UTC ในฐานข้อมูล → epoch วินาที (null = ไม่มีค่า/อ่านไม่ออก) */
    public static function utcToEpoch(?string $utc): ?int
    {
        if ($utc === null || $utc === '') {
            return null;
        }
        $at = DateTimeImmutable::createFromFormat('Y-m-d H:i:s', substr($utc, 0, 19), self::utcZone());

        return $at === false ? null : $at->getTimestamp();
    }
}
