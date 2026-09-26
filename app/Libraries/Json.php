<?php

namespace App\Libraries;

use stdClass;

/**
 * JSON ที่ส่งออกทาง API — หน้าตาเดียวกับ JSON.stringify ของระบบเดิม
 * (ภาษาไทยไม่ถูก escape, / ไม่ถูก escape, 12.0 ออกเป็น 12, NaN ออกเป็น null)
 */
final class Json
{
    public static function encode(mixed $data): string
    {
        return json_encode(
            self::prepare($data),
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR,
        );
    }

    /** ตัวว่างที่ต้องออกเป็น {} ไม่ใช่ [] */
    public static function obj(array $map = []): array|stdClass
    {
        return $map === [] ? new stdClass() : $map;
    }

    private static function prepare(mixed $value): mixed
    {
        if (is_float($value)) {
            if (! is_finite($value)) {
                return null;
            }

            return $value == 0.0 ? 0 : $value; // -0 → 0
        }
        if (is_array($value)) {
            foreach ($value as $k => $v) {
                if (is_array($v) || is_float($v)) {
                    $value[$k] = self::prepare($v);
                }
            }
        }

        return $value;
    }
}
