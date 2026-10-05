<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Db;
use App\Libraries\Money;
use App\Libraries\Period;
use App\Libraries\Usd;

final class PeriodService
{
    /** สร้างรอบบิลถ้ายังไม่มี แล้วคืนแถวจากฐานข้อมูล */
    public static function ensure(string|array $codeOrPeriod): array
    {
        $p = is_string($codeOrPeriod) ? Period::fromCode($codeOrPeriod) : $codeOrPeriod;
        Db::exec(
            'INSERT INTO billing_periods (code, year, month, half, start_date, end_date, created_at)
             VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
             ON DUPLICATE KEY UPDATE code = code',
            [$p['code'], $p['year'], $p['month'], $p['half'], $p['startDate'], $p['endDate']],
        );

        return Db::one('SELECT * FROM billing_periods WHERE code = ?', [$p['code']]);
    }

    public static function ensureForDate(string $date): array
    {
        return self::ensure(Period::fromDate($date));
    }

    public static function getByCode(mixed $code): array
    {
        $row = Db::one('SELECT * FROM billing_periods WHERE code = ?', [Period::fromCode($code)['code']]);

        return $row ?? throw ApiException::notFound('ยังไม่มีรอบบิล ' . (is_string($code) ? $code : '') . ' ในระบบ');
    }

    public static function list(?string $from, ?string $to, mixed $limit = 24, bool $create = false): array
    {
        if ($from && $to) {
            $range = Period::between($from, $to);
            if ($create) {
                return array_map([self::class, 'ensure'], $range);
            }

            return Db::all('SELECT * FROM billing_periods WHERE code IN ? ORDER BY start_date', [array_column($range, 'code')]);
        }
        $n = (int) $limit;

        return Db::all('SELECT * FROM billing_periods ORDER BY start_date DESC LIMIT ?', [min($n > 0 ? $n : 24, 240)]);
    }

    public static function setStatus(string $code, string $status): array
    {
        if (! in_array($status, ['OPEN', 'LOCKED'], true)) {
            throw ApiException::badRequest('status: ต้องเป็น OPEN หรือ LOCKED');
        }
        $period = self::getByCode($code);
        Db::exec('UPDATE billing_periods SET status = ? WHERE id = ?', [$status, $period['id']]);

        return [...$period, 'status' => $status];
    }

    /**
     * ตั้งอัตราแลกเปลี่ยนของรอบบิล (บาทต่อ 1 ดอลลาร์)
     * ส่ง null มาเพื่อล้างค่า — รอบที่ไม่ได้ตั้งอัตราไว้ก็แค่ไม่โชว์ยอดดอลลาร์
     * บิลที่ออกไปแล้วไม่ถูกแตะ — แต่ละใบตรึงอัตรา ณ ตอนออกไว้ของตัวเอง
     */
    public static function setUsdRate(string $code, mixed $rate, int $actorUserId): array
    {
        $period = self::getByCode($code);
        $satang = $rate === null || $rate === '' ? null : Money::toSatang($rate, 'usdRate');
        if ($satang !== null && $satang <= 0) {
            throw ApiException::badRequest('usdRate: อัตราแลกเปลี่ยนต้องมากกว่า 0');
        }
        Db::exec('UPDATE billing_periods SET usd_rate_satang = ? WHERE id = ?', [$satang, $period['id']]);
        Usd::forget();
        Audit::write($actorUserId, 'period.usd_rate', 'billing_period', (int) $period['id'], [
            'periodCode' => $period['code'],
            'usdRate'    => $satang === null ? null : Money::toBaht($satang),
        ]);

        return self::getByCode($code);
    }

    public static function serialize(?array $row): ?array
    {
        if ($row === null) {
            return null;
        }

        return [
            'id'        => (int) $row['id'],
            'code'      => $row['code'],
            'year'      => (int) $row['year'],
            'month'     => (int) $row['month'],
            'half'      => (int) $row['half'],
            'startDate' => $row['start_date'],
            'endDate'   => $row['end_date'],
            'status'    => $row['status'],
            // บาทต่อ 1 ดอลลาร์ — null = รอบนี้ยังไม่ได้ตั้งอัตรา
            'usdRate'   => $row['usd_rate_satang'] === null ? null : Money::toBaht($row['usd_rate_satang']),
            // อัตราที่ใช้เทียบยอดของรอบนี้เป็นดอลลาร์ในสรุป: ของรอบเอง ไม่มี = อัตราล่าสุดที่ตั้งไว้ (null = ยังไม่เคยตั้งเลย)
            'fxRate'    => Usd::rate($row['usd_rate_satang']),
        ];
    }
}
