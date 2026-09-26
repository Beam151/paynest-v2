<?php

namespace App\Libraries;

/**
 * แปลงค่าแบบ JavaScript — API นี้พอร์ตมาจากระบบเดิมที่เขียนด้วย Node
 * จุดที่ตัวเดิมพึ่งพฤติกรรมของภาษา (Number("") = 0, ความยาวสตริงนับแบบ UTF-16) ต้องได้ผลเท่ากัน
 * ไม่งั้นหน้าเว็บตัวเดิมที่ไม่ได้แก้เลยจะเจอกฎการตรวจที่ต่างไปโดยไม่รู้ตัว
 */
final class Js
{
    /** Number(string) — '' = 0, รับ 1e3 / 0x10 / Infinity, นอกนั้น NaN */
    public static function toNumber(string $s): float
    {
        $t = self::trim($s);
        if ($t === '') {
            return 0.0;
        }
        if (preg_match('/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/', $t)) {
            return (float) $t;
        }
        if (preg_match('/^([+-]?)Infinity$/', $t, $m)) {
            return $m[1] === '-' ? -INF : INF;
        }
        if (preg_match('/^0[xX]([0-9a-fA-F]+)$/', $t, $m)) {
            return (float) hexdec($m[1]);
        }
        if (preg_match('/^0[oO]([0-7]+)$/', $t, $m)) {
            return (float) octdec($m[1]);
        }
        if (preg_match('/^0[bB]([01]+)$/', $t, $m)) {
            return (float) bindec($m[1]);
        }

        return NAN;
    }

    /** Number(value) สำหรับค่าที่มาจาก JSON (z.coerce.number()) */
    public static function coerceNumber(mixed $value): float
    {
        return match (true) {
            $value === null                  => 0.0,
            $value instanceof Undefined      => NAN,
            is_bool($value)                  => $value ? 1.0 : 0.0,
            is_int($value), is_float($value) => (float) $value,
            is_string($value)                => self::toNumber($value),
            // อาเรย์แปลงผ่าน String() ก่อน: [] = 0, [5] = 5, [1,2] = NaN — ตามกติกา ToPrimitive
            is_array($value) && array_is_list($value) => self::toNumber(self::arrayToString($value)),
            default => NAN,
        };
    }

    private static function arrayToString(array $list): string
    {
        return implode(',', array_map(
            static fn ($v) => $v === null ? '' : (is_array($v) && array_is_list($v) ? self::arrayToString($v) : self::toString($v)),
            $list,
        ));
    }

    /** String(value) ของค่าพื้นฐาน */
    public static function toString(mixed $value): string
    {
        return match (true) {
            is_string($value)           => $value,
            $value === null             => 'null',
            $value instanceof Undefined => 'undefined',
            is_bool($value)             => $value ? 'true' : 'false',
            is_int($value)              => (string) $value,
            is_float($value)            => self::numberToString($value),
            default                     => '[object Object]',
        };
    }

    public static function numberToString(float $n): string
    {
        if (is_nan($n)) {
            return 'NaN';
        }
        if (is_infinite($n)) {
            return $n > 0 ? 'Infinity' : '-Infinity';
        }
        if ($n == floor($n) && abs($n) < 1e21) {
            return sprintf('%.0F', $n);
        }

        return json_encode($n);
    }

    /** ความยาวสตริงแบบ JavaScript (นับหน่วย UTF-16) — ใช้กับกฎ min/max ของข้อความ */
    public static function len(string $s): int
    {
        if ($s === '' || ! preg_match('/[^\x00-\x7F]/', $s)) {
            return strlen($s);
        }

        return intdiv(strlen(mb_convert_encoding($s, 'UTF-16LE', 'UTF-8')), 2);
    }

    /** ตัดช่องว่างหัวท้ายแบบ String.prototype.trim (รวมช่องว่าง Unicode) */
    public static function trim(string $s): string
    {
        return preg_replace('/^[\s\x{FEFF}\x{A0}]+|[\s\x{FEFF}\x{A0}]+$/u', '', $s) ?? trim($s);
    }

    /** encodeURIComponent — rawurlencode แต่เว้น ! * ' ( ) ไว้เหมือนเบราว์เซอร์ */
    public static function encodeURIComponent(string $s): string
    {
        return strtr(rawurlencode($s), ['%21' => '!', '%2A' => '*', '%27' => "'", '%28' => '(', '%29' => ')']);
    }
}
