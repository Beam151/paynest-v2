<?php

namespace App\Libraries;

/**
 * body ของคำขอที่แปลง JSON แล้ว (ตั้งโดย JsonBodyFilter)
 * object = stdClass, อาเรย์ = list · ไม่มี body / ไม่ใช่ JSON = Undefined
 */
final class RequestBody
{
    private static mixed $value = null;
    private static bool $set    = false;

    public static function set(mixed $value): void
    {
        self::$value = $value;
        self::$set   = true;
    }

    public static function get(): mixed
    {
        return self::$set ? self::$value : Undefined::get();
    }

    /** body หรือ {} ถ้าไม่ได้ส่งมา — ตรงกับ req.body ?? {} ของตัวเดิม */
    public static function orEmpty(): mixed
    {
        $value = self::get();

        return $value instanceof Undefined || $value === null ? new \stdClass() : $value;
    }

    /** อ่านช่องหนึ่งจาก body (ใช้กับคีย์ของ rate limit ก่อนผ่านการตรวจ) */
    public static function field(string $key): mixed
    {
        $value = self::get();
        if ($value instanceof \stdClass) {
            return $value->{$key} ?? null;
        }

        return is_array($value) ? ($value[$key] ?? null) : null;
    }
}
