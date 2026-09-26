<?php

namespace App\Libraries;

/**
 * เงินเก็บเป็นสตางค์ (integer) เสมอ · เปอร์เซ็นต์เก็บเป็น basis point (12.5% = 1250)
 * API รับ/ส่งเป็นบาททศนิยม 2 ตำแหน่ง — แปลงผ่านไฟล์นี้ที่เดียว ไม่ผ่าน float กลางทาง
 */
final class Money
{
    private const AMOUNT_RE = '/^-?\d+(\.\d{1,2})?$/';

    /**
     * แปลงจำนวนเงิน (บาท) เป็นสตางค์แบบไม่ผ่าน float
     * รับได้ทั้ง number และ string เช่น 1250.75 / "1250.75" / "1,250.75"
     */
    public static function toSatang(mixed $amount, string $field = 'amount'): int
    {
        if ($amount === null || $amount === '' || $amount instanceof Undefined) {
            throw ApiException::badRequest("{$field}: ต้องระบุจำนวนเงิน");
        }
        // ตัวเลขจาก JSON ปัดเป็น 2 ตำแหน่งแบบเดียวกับ toFixed(2) ของ JavaScript (ตัวเดิมรับแบบนี้)
        $raw = is_int($amount) || is_float($amount)
            ? (is_finite((float) $amount) ? sprintf('%.2F', $amount) : 'NaN')
            : str_replace(',', '', trim(Js::toString($amount)));

        if (! preg_match(self::AMOUNT_RE, $raw)) {
            throw ApiException::badRequest("{$field}: รูปแบบจำนวนเงินไม่ถูกต้อง (ทศนิยมไม่เกิน 2 ตำแหน่ง)");
        }
        $negative = str_starts_with($raw, '-');
        $parts    = explode('.', ltrim($raw, '-'));
        $satang   = (int) $parts[0] * 100 + (int) str_pad($parts[1] ?? '', 2, '0');

        return $negative ? -$satang : $satang;
    }

    /** สตางค์ -> บาท (ทศนิยม 2 ตำแหน่ง) สำหรับส่งออก API */
    public static function toBaht(int|float|string|null $satang): float
    {
        return round((float) ($satang ?? 0)) / 100;
    }

    /** เปอร์เซ็นต์ (12.5) -> basis point (1250) */
    public static function pctToBp(mixed $pct, string $field = 'commissionPct'): int
    {
        $n = is_string($pct) ? Js::toNumber(trim($pct)) : (is_int($pct) || is_float($pct) ? (float) $pct : NAN);
        if (! is_finite($n) || $n < 0 || $n > 100) {
            throw ApiException::badRequest("{$field}: ต้องเป็นตัวเลข 0–100");
        }
        $bp = (int) round($n * 100);
        if (abs($n * 100 - $bp) > 1e-6) {
            throw ApiException::badRequest("{$field}: รองรับทศนิยมไม่เกิน 2 ตำแหน่ง");
        }

        return $bp;
    }

    /** basis point (1250) -> เปอร์เซ็นต์ (12.5) */
    public static function bpToPct(int|string|null $bp): float
    {
        return ((int) ($bp ?? 0)) / 100;
    }

    /**
     * คิดส่วนต่างจากยอดเต็ม ปัดเป็นสตางค์แบบ half-up
     * ปัดครึ่งออกจากศูนย์ทั้งสองทิศ — ยอดคืน (ติดลบ) ต้องได้ส่วนต่างเท่ากับยอดขายที่เท่ากันแต่เป็นบวก
     * คิดด้วยจำนวนเต็มล้วน (ไม่ผ่าน float) จึงไม่มีเศษสตางค์หลงจากการปัด
     */
    public static function commissionOf(int $grossSatang, int $pctBp): int
    {
        $product = abs($grossSatang * $pctBp);
        $rounded = intdiv($product, 10000) + ($product % 10000 >= 5000 ? 1 : 0);

        return ($grossSatang * $pctBp) < 0 ? -$rounded : $rounded;
    }

    /** "1,234.50" — แบบ toLocaleString('th-TH', { minimumFractionDigits: 2 }) ที่ใช้ในข้อความ Telegram */
    public static function fmt(int|float $baht): string
    {
        return number_format((float) $baht, 2, '.', ',');
    }

    /** สตางค์ → ข้อความบาท "1,234.50" */
    public static function fmtSatang(int|string|null $satang): string
    {
        return self::fmt(self::toBaht($satang));
    }

    /** ปัดทศนิยม 2 ตำแหน่ง แบบ Number(x.toFixed(2)) */
    public static function round2(float|int $n): float
    {
        return (float) sprintf('%.2F', $n);
    }
}
