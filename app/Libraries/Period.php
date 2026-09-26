<?php

namespace App\Libraries;

/**
 * รอบบิลครึ่งเดือน — รหัส YYYY-MM-H1 (1–15) และ YYYY-MM-H2 (16–สิ้นเดือน)
 * รอบในหน่วยความจำเป็นอาเรย์ ['code','year','month','half','startDate','endDate']
 */
final class Period
{
    private const DATE_RE   = '/^\d{4}-\d{2}-\d{2}$/';
    private const MONTH_RE  = '/^\d{4}-\d{2}$/';
    private const PERIOD_RE = '/^(\d{4})-(\d{2})-H([12])$/';

    private static function pad(int $n): string
    {
        return str_pad((string) $n, 2, '0', STR_PAD_LEFT);
    }

    public static function daysInMonth(int $year, int $month): int
    {
        return (int) gmdate('t', gmmktime(0, 0, 0, $month, 1, $year));
    }

    public static function assertDate(mixed $value, string $field = 'date'): string
    {
        if (! is_string($value) || ! preg_match(self::DATE_RE, $value)) {
            throw ApiException::badRequest("{$field}: ต้องเป็นวันที่รูปแบบ YYYY-MM-DD");
        }
        [$y, $m, $d] = array_map('intval', explode('-', $value));
        if ($m < 1 || $m > 12 || $d < 1 || $d > self::daysInMonth($y, $m)) {
            throw ApiException::badRequest("{$field}: วันที่ไม่ถูกต้อง ({$value})");
        }

        return $value;
    }

    public static function assertMonth(mixed $value, string $field = 'month'): string
    {
        if (! is_string($value) || ! preg_match(self::MONTH_RE, $value)) {
            throw ApiException::badRequest("{$field}: ต้องเป็นเดือนรูปแบบ YYYY-MM");
        }
        $m = (int) substr($value, 5, 2);
        if ($m < 1 || $m > 12) {
            throw ApiException::badRequest("{$field}: เดือนไม่ถูกต้อง ({$value})");
        }

        return $value;
    }

    /** "วันนี้" ตามเวลาไทย ไม่ใช่ UTC */
    public static function today(): string
    {
        return Clock::todayThai();
    }

    public static function addDays(string $date, int $days): string
    {
        [$y, $m, $d] = array_map('intval', explode('-', self::assertDate($date)));

        return gmdate('Y-m-d', gmmktime(0, 0, 0, $m, $d + $days, $y));
    }

    /** จำนวนวันจาก from ถึง to (ติดลบถ้า to มาก่อน) — ใช้นับว่าเลยกำหนดมากี่วัน */
    public static function daysBetween(?string $from, ?string $to): int
    {
        if (! $from || ! $to) {
            return 0;
        }
        $a = self::epochOfDate($from);
        $b = self::epochOfDate($to);

        return $a === null || $b === null ? 0 : (int) round(($b - $a) / 86400);
    }

    private static function epochOfDate(string $date): ?int
    {
        if (! preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $date, $m)) {
            return null;
        }

        return gmmktime(0, 0, 0, (int) $m[2], (int) $m[3], (int) $m[1]);
    }

    /** เลื่อนเดือนของวันที่ โดยหนีบวันที่ไม่ให้เกินสิ้นเดือนปลายทาง (31 ม.ค. +1 เดือน = 28 ก.พ.) */
    public static function addMonthsToDate(string $date, int $months): string
    {
        [$y, $m, $d] = array_map('intval', explode('-', self::assertDate($date)));
        $total = ($y * 12 + ($m - 1)) + $months;
        $ny    = intdiv($total, 12);
        $nm    = ($total % 12) + 1;

        return $ny . '-' . self::pad($nm) . '-' . self::pad(min($d, self::daysInMonth($ny, $nm)));
    }

    /** สร้างข้อมูลรอบบิลครึ่งเดือน (H1 = 1–15, H2 = 16–สิ้นเดือน) */
    public static function make(int $year, int $month, int $half): array
    {
        if ($half !== 1 && $half !== 2) {
            throw ApiException::badRequest('half: ต้องเป็น 1 หรือ 2');
        }
        $start = $half === 1 ? 1 : 16;
        $end   = $half === 1 ? 15 : self::daysInMonth($year, $month);
        $ym    = $year . '-' . self::pad($month);

        return [
            'code'      => "{$ym}-H{$half}",
            'year'      => $year,
            'month'     => $month,
            'half'      => $half,
            'startDate' => "{$ym}-" . self::pad($start),
            'endDate'   => "{$ym}-" . self::pad($end),
        ];
    }

    public static function fromCode(mixed $code): array
    {
        $text = trim(Js::toString($code ?? ''));
        if ($code instanceof Undefined) {
            $text = 'undefined';
        }
        if (! preg_match(self::PERIOD_RE, $text, $m)) {
            $shown = $code instanceof Undefined ? 'undefined' : ($code === null ? 'null' : Js::toString($code));
            throw ApiException::badRequest("periodCode: ต้องเป็นรูปแบบ YYYY-MM-H1 หรือ YYYY-MM-H2 (ได้รับ \"{$shown}\")");
        }
        $month = (int) $m[2];
        if ($month < 1 || $month > 12) {
            throw ApiException::badRequest("periodCode: เดือนไม่ถูกต้อง ({$text})");
        }

        return self::make((int) $m[1], $month, (int) $m[3]);
    }

    public static function fromDate(string $date): array
    {
        [$y, $m, $d] = array_map('intval', explode('-', self::assertDate($date)));

        return self::make($y, $m, $d <= 15 ? 1 : 2);
    }

    /** ดัชนีรอบบิลแบบต่อเนื่อง ใช้คำนวณระยะห่าง/เลื่อนรอบ */
    private static function index(array $p): int
    {
        return ($p['year'] * 12 + ($p['month'] - 1)) * 2 + ($p['half'] - 1);
    }

    private static function fromIndex(int $index): array
    {
        $half       = ($index % 2) + 1;
        $monthTotal = intdiv($index, 2);

        return self::make(intdiv($monthTotal, 12), ($monthTotal % 12) + 1, $half);
    }

    public static function shift(array $period, int $steps): array
    {
        return self::fromIndex(self::index($period) + $steps);
    }

    /** ไล่รอบบิลตั้งแต่ from ถึง to (รวมปลายทั้งสองข้าง) */
    public static function between(mixed $fromCode, mixed $toCode): array
    {
        $from = self::fromCode($fromCode);
        $to   = self::fromCode($toCode);
        if (self::index($from) > self::index($to)) {
            throw ApiException::badRequest('from ต้องไม่มากกว่า to');
        }
        if (self::index($to) - self::index($from) + 1 > 240) {
            throw ApiException::badRequest('ช่วงรอบบิลกว้างเกินไป (สูงสุด 240 รอบ)');
        }
        $out = [];
        for ($i = self::index($from); $i <= self::index($to); $i++) {
            $out[] = self::fromIndex($i);
        }

        return $out;
    }

    public static function ofMonth(string $monthKey): array
    {
        [$y, $m] = array_map('intval', explode('-', self::assertMonth($monthKey)));

        return [self::make($y, $m, 1), self::make($y, $m, 2)];
    }

    public static function monthRange(mixed $monthKey): array
    {
        [$y, $m] = array_map('intval', explode('-', self::assertMonth($monthKey)));
        $ym      = $y . '-' . self::pad($m);

        return ['start' => "{$ym}-01", 'end' => "{$ym}-" . self::pad(self::daysInMonth($y, $m))];
    }

    public static function monthsBetween(mixed $fromMonth, mixed $toMonth): array
    {
        [$fy, $fm] = array_map('intval', explode('-', self::assertMonth($fromMonth, 'fromMonth')));
        [$ty, $tm] = array_map('intval', explode('-', self::assertMonth($toMonth, 'toMonth')));
        $start     = $fy * 12 + ($fm - 1);
        $end       = $ty * 12 + ($tm - 1);
        if ($start > $end) {
            throw ApiException::badRequest('fromMonth ต้องไม่มากกว่า toMonth');
        }
        if ($end - $start > 120) {
            throw ApiException::badRequest('ช่วงเดือนกว้างเกินไป (สูงสุด 120 เดือน)');
        }
        $out = [];
        for ($i = $start; $i <= $end; $i++) {
            $out[] = intdiv($i, 12) . '-' . self::pad(($i % 12) + 1);
        }

        return $out;
    }

    public static function shiftMonth(string $monthKey, int $steps): string
    {
        [$y, $m] = array_map('intval', explode('-', self::assertMonth($monthKey)));
        $total   = $y * 12 + ($m - 1) + $steps;

        return intdiv($total, 12) . '-' . self::pad(($total % 12) + 1);
    }

    /** ชื่อเดือนย่อภาษาไทย ใช้ในข้อความถึงร้าน */
    public const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

    /** '2026-09-15' → '15 ก.ย. 69' */
    public static function thDate(?string $iso): string
    {
        [$y, $m, $d] = array_map('intval', explode('-', substr((string) $iso, 0, 10)) + [0, 1, 1]);

        return $d . ' ' . (self::THAI_MONTHS[$m - 1] ?? '') . ' ' . str_pad((string) (($y + 543) % 100), 2, '0', STR_PAD_LEFT);
    }

    /** ชื่อรอบแบบคนอ่าน "1–15 ก.ย. 69" สำหรับข้อความถึงร้าน */
    public static function text(string $code): string
    {
        $p = self::fromCode($code);

        return ((int) substr($p['startDate'], 8)) . '–' . self::thDate($p['endDate']);
    }
}
