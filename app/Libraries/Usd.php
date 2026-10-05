<?php

namespace App\Libraries;

/**
 * ยอดเทียบดอลลาร์ของตัวเลขสรุป (รุ่น 2.6.0) — เงินในระบบเป็นบาททุกที่ ดอลลาร์เป็นแค่ตัวเทียบให้อ่านคู่กัน
 *
 * อัตราของแต่ละยอด (บาทต่อ 1 ดอลลาร์) เลือกตามลำดับ:
 *   1. อัตราที่ตรึงไว้กับบิล — ร้านที่จ่ายเป็น USD โอนตามอัตรานี้จริง ยอดรวมจึงต้องเท่ากับผลบวกของบิลทีละใบ
 *   2. อัตราของรอบบิลที่ยอดนั้นอยู่
 *   3. อัตราล่าสุดที่ตั้งไว้ — รอบที่ยังไม่ได้ตั้ง / บิลค่าคอมที่ไม่มีรอบ ยังได้ตัวเลขประมาณ แทนยอดรวมที่ขาดไปบางส่วน
 * ยังไม่เคยตั้งอัตราเลย = null ทุกที่ (หน้าเว็บไม่โชว์บรรทัดดอลลาร์)
 *
 * เอกสารที่มีตัวตน (บิล สลิป เงินรับ บิลค่าคอม) ปัดเป็นเซนต์ทีละใบก่อนรวม
 * ยอดขายรายบรรทัดรวมก่อนแล้วค่อยปัด — ปัดทีละบรรทัดเศษจะสะสมตามจำนวนบรรทัด
 */
final class Usd
{
    private static bool $loaded = false;

    private static ?int $latest = null;

    /** อัตราล่าสุดที่ตั้งไว้ (สตางค์ต่อ 1 ดอลลาร์) — อ่านครั้งเดียวต่อคำขอ */
    public static function latestRate(): ?int
    {
        if (! self::$loaded) {
            $rate = Db::val('SELECT usd_rate_satang FROM billing_periods WHERE usd_rate_satang IS NOT NULL ORDER BY start_date DESC LIMIT 1')
                // ล้างอัตราของทุกรอบไปแล้วแต่ยังมีบิลที่ตรึงอัตราไว้ — ใช้ของบิลล่าสุด ยอดรวมจะได้ไม่ขาดไปบางใบ
                ?? Db::val('SELECT usd_rate_satang FROM invoices WHERE usd_rate_satang IS NOT NULL ORDER BY id DESC LIMIT 1');
            self::$latest = $rate === null ? null : (int) $rate;
            self::$loaded = true;
        }

        return self::$latest;
    }

    /** เรียกหลังตั้ง/ล้างอัตราของรอบ — คำตอบของคำขอเดียวกันต้องใช้อัตราใหม่ */
    public static function forget(): void
    {
        self::$loaded = false;
        self::$latest = null;
    }

    /** อัตราของยอดหนึ่ง (สตางค์ต่อ 1 ดอลลาร์): ตัวแรกที่มีค่า ไม่มีเลย = อัตราล่าสุด */
    public static function pick(mixed ...$rates): ?int
    {
        foreach ($rates as $rate) {
            if ($rate !== null && (int) $rate > 0) {
                return (int) $rate;
            }
        }

        return self::latestRate();
    }

    /** แบบส่งออก API (ช่อง fxRate ของแต่ละแถว): บาทต่อ 1 ดอลลาร์ */
    public static function rate(mixed ...$rates): ?float
    {
        $rate = self::pick(...$rates);

        return $rate === null ? null : Money::toBaht($rate);
    }

    /** บาท → ดอลลาร์ตาม fxRate ของแถว — ตัวเดียวกับ usdOf() ของหน้าเว็บ */
    public static function of(float|int $baht, ?float $fxRate): ?float
    {
        return $fxRate ? Money::round2($baht / $fxRate) : null;
    }

    /**
     * รวมยอดดอลลาร์ของแถวที่ serialize แล้ว (แต่ละแถวมี fxRate ของตัวเอง) — ปัดทีละแถวก่อนรวม
     * ไม่มีแถว = 0 · null เฉพาะเมื่อยังไม่เคยตั้งอัตรา
     */
    public static function sum(array $rows, string $key): ?float
    {
        if (self::latestRate() === null) {
            return null;
        }
        $total = 0.0;
        foreach ($rows as $row) {
            $total += self::of($row[$key], $row['fxRate'] ?? null) ?? 0.0;
        }

        return Money::round2($total);
    }

    /**
     * นิพจน์ SQL: ยอดสตางค์ → เซนต์ดอลลาร์ (ยังไม่ปัด) ตามอัตราตัวแรกที่มีค่า ไม่มีเลย = อัตราล่าสุด
     * คนเรียกครอบเองตามชนิดยอด: เอกสารทีละใบ SUM(ROUND(…)) · ยอดขายรายบรรทัด SUM(…) แล้วปัดตอน fromCents()
     * $rateExprs เป็นชื่อคอลัมน์/คิวรีย่อยที่เขียนในโค้ดเท่านั้น — ห้ามรับค่าจากผู้ใช้
     */
    public static function sqlCents(string $satangExpr, string ...$rateExprs): string
    {
        $latest = self::latestRate();
        if ($latest !== null) {
            $rateExprs[] = (string) $latest;
        }
        if ($rateExprs === []) {
            return 'NULL';
        }
        $rate = count($rateExprs) === 1 ? $rateExprs[0] : 'COALESCE(' . implode(', ', $rateExprs) . ')';

        return "(({$satangExpr}) * 100 / {$rate})";
    }

    /** ผล SUM ของ sqlCents() → ดอลลาร์ทศนิยม 2 ตำแหน่ง (ไม่มีแถว = 0 · null เฉพาะเมื่อยังไม่เคยตั้งอัตรา) */
    public static function fromCents(mixed $cents): ?float
    {
        return self::latestRate() === null ? null : round((float) ($cents ?? 0)) / 100;
    }
}
