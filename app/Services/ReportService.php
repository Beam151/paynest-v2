<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Clock;
use App\Libraries\Db;
use App\Libraries\Money;
use App\Libraries\Period;

/** รายงาน: รายรอบ · รายเดือน · เทียบช่วง · จัดอันดับ · หน้าแรก · ภาพของร้าน */
final class ReportService
{
    private const ALL_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'INVOICED'];

    private static function normalizeStatuses(mixed $statuses): array
    {
        if (! $statuses) {
            return self::ALL_STATUSES;
        }
        $list  = is_array($statuses) ? $statuses : explode(',', (string) $statuses);
        $clean = array_values(array_filter(array_map(static fn ($s) => strtoupper(trim((string) $s)), $list), static fn ($s) => $s !== ''));
        $bad   = array_values(array_filter($clean, static fn ($s) => ! in_array($s, self::ALL_STATUSES, true)));
        if ($bad !== []) {
            throw ApiException::badRequest('status ไม่ถูกต้อง: ' . implode(', ', $bad));
        }

        return $clean !== [] ? $clean : self::ALL_STATUSES;
    }

    private const GROUPS = [
        'period'    => ['select' => 'bp.code AS bucket, NULL AS bucket_label, MIN(bp.start_date) AS bucket_start, MAX(bp.end_date) AS bucket_end', 'by' => 'bp.code'],
        'month'     => ['select' => "CONCAT(LPAD(bp.year, 4, '0'), '-', LPAD(bp.month, 2, '0')) AS bucket, NULL AS bucket_label, MIN(bp.start_date) AS bucket_start, MAX(bp.end_date) AS bucket_end", 'by' => 'bp.year, bp.month'],
        'franchise' => ['select' => 'f.username AS bucket, NULL AS bucket_label, NULL AS bucket_start, NULL AS bucket_end', 'by' => 'f.id, f.username'],
        'product'   => ['select' => 'p.sku AS bucket, p.name AS bucket_label, NULL AS bucket_start, NULL AS bucket_end', 'by' => 'p.id, p.sku, p.name'],
    ];

    /**
     * รวมยอดตามเงื่อนไข — ใช้ช่วงวันที่ของรอบบิลเป็นตัวกรอง
     * (รอบบิลที่ "อยู่ในช่วง" คือรอบที่ทั้งรอบอยู่ภายใน start–end)
     * ยอดของสินค้า/ร้านที่ลบแล้วนับเสมอ (เงินเกิดขึ้นจริง ออกบิลแล้ว — ตัดทิ้งแล้วยอดรวมไม่ตรงกับบิล)
     * ยกเว้น $liveProductsOnly: การจัดอันดับที่หน้าแรก — สินค้าที่ลบแล้วไม่ควรขึ้นเป็น "สินค้าขายดี" ของรอบนี้
     */
    private static function aggregate(string $start, string $end, mixed $franchiseId = null, mixed $productId = null, mixed $statuses = null, ?string $groupBy = null, bool $liveProductsOnly = false): array
    {
        $where  = ['bp.start_date >= ?', 'bp.end_date <= ?'];
        $params = [$start, $end];
        if ($liveProductsOnly) {
            $where[] = "p.status <> 'DELETED'";
        }
        $where[]  = 'se.status IN ?';
        $params[] = self::normalizeStatuses($statuses);
        if ($franchiseId) {
            $where[]  = 'se.franchise_id = ?';
            $params[] = (int) $franchiseId;
        }
        if ($productId) {
            $where[]  = 'se.product_id = ?';
            $params[] = (int) $productId;
        }
        $metrics = '
            COUNT(*)                                       AS entry_count,
            COUNT(DISTINCT se.product_id)                  AS product_count,
            COUNT(DISTINCT se.franchise_id)                AS franchise_count,
            COALESCE(SUM(se.gross_amount_satang), 0)       AS gross_satang,
            COALESCE(SUM(se.commission_amount_satang), 0)  AS commission_satang';
        $from = '
            FROM sales_entries se
            JOIN billing_periods bp ON bp.id = se.period_id
            JOIN franchises f       ON f.id = se.franchise_id
            JOIN products p         ON p.id = se.product_id
           WHERE ' . implode(' AND ', $where);

        if ($groupBy === null) {
            return self::toTotals(Db::one("SELECT {$metrics} {$from}", $params));
        }
        $g = self::GROUPS[$groupBy] ?? throw ApiException::badRequest("groupBy ไม่รองรับ: {$groupBy} (period | month | franchise | product)");

        return array_map(static fn ($row) => [
            'bucket'    => $row['bucket'],
            'label'     => $row['bucket_label'] ?? $row['bucket'],
            'startDate' => $row['bucket_start'],
            'endDate'   => $row['bucket_end'],
            ...self::toTotals($row),
        ], Db::all("SELECT {$g['select']}, {$metrics} {$from} GROUP BY {$g['by']} ORDER BY bucket", $params));
    }

    private static function toTotals(?array $row): array
    {
        $gross      = (int) ($row['gross_satang'] ?? 0);
        $commission = (int) ($row['commission_satang'] ?? 0);

        return [
            'entryCount'             => (int) ($row['entry_count'] ?? 0),
            'productCount'           => (int) ($row['product_count'] ?? 0),
            'franchiseCount'         => (int) ($row['franchise_count'] ?? 0),
            'grossAmount'            => Money::toBaht($gross),
            'commissionAmount'       => Money::toBaht($commission),
            'netAmount'              => Money::toBaht($gross - $commission),
            'effectiveCommissionPct' => $gross > 0 ? Money::round2(($commission / $gross) * 100) : null,
        ];
    }

    private static function emptyRow(string $bucket, ?string $start, ?string $end): array
    {
        return ['bucket' => $bucket, 'label' => $bucket, 'startDate' => $start, 'endDate' => $end, ...self::toTotals(null)];
    }

    private static function diffOf(array $current, array $previous): array
    {
        $growth = static fn ($a, $b) => $b == 0 ? null : Money::round2((($a - $b) / $b) * 100);

        return [
            'grossAmount'         => Money::round2($current['grossAmount'] - $previous['grossAmount']),
            'commissionAmount'    => Money::round2($current['commissionAmount'] - $previous['commissionAmount']),
            'entryCount'          => $current['entryCount'] - $previous['entryCount'],
            'grossGrowthPct'      => $growth($current['grossAmount'], $previous['grossAmount']),
            'commissionGrowthPct' => $growth($current['commissionAmount'], $previous['commissionAmount']),
        ];
    }

    /** รายงานรายรอบบิล (ครึ่งเดือน) ตั้งแต่ from ถึง to */
    public static function byPeriod(mixed $fromPeriod, mixed $toPeriod, mixed $franchiseId, mixed $productId, mixed $statuses): array
    {
        $range  = Period::between($fromPeriod, $toPeriod);
        $start  = $range[0]['startDate'];
        $end    = end($range)['endDate'];
        $byCode = array_column(self::aggregate($start, $end, $franchiseId, $productId, $statuses, 'period'), null, 'bucket');

        return [
            'scope' => ['fromPeriod' => $range[0]['code'], 'toPeriod' => end($range)['code'], 'franchiseId' => $franchiseId ?: null, 'productId' => $productId ?: null],
            // เติมรอบที่ยังไม่มียอดให้ครบ เพื่อให้กราฟไม่ขาดช่วง
            'rows'  => array_map(static fn ($p) => $byCode[$p['code']] ?? self::emptyRow($p['code'], $p['startDate'], $p['endDate']), $range),
            'total' => self::aggregate($start, $end, $franchiseId, $productId, $statuses),
        ];
    }

    /** รายงานรายเดือน พร้อมแยกครึ่งเดือน H1/H2 ในแต่ละเดือน */
    public static function byMonth(mixed $fromMonth, mixed $toMonth, mixed $franchiseId, mixed $productId, mixed $statuses): array
    {
        $months     = Period::monthsBetween($fromMonth, $toMonth);
        $start      = Period::monthRange($months[0])['start'];
        $end        = Period::monthRange(end($months))['end'];
        $monthRows  = array_column(self::aggregate($start, $end, $franchiseId, $productId, $statuses, 'month'), null, 'bucket');
        $periodRows = array_column(self::aggregate($start, $end, $franchiseId, $productId, $statuses, 'period'), null, 'bucket');

        return [
            'scope' => ['fromMonth' => $months[0], 'toMonth' => end($months), 'franchiseId' => $franchiseId ?: null, 'productId' => $productId ?: null],
            'rows'  => array_map(static function ($m) use ($monthRows, $periodRows) {
                $range  = Period::monthRange($m);
                $base   = $monthRows[$m] ?? self::emptyRow($m, $range['start'], $range['end']);
                $halves = array_map(static fn ($p) => $periodRows[$p['code']] ?? self::emptyRow($p['code'], $p['startDate'], $p['endDate']), Period::ofMonth($m));

                return [...$base, 'halves' => $halves];
            }, $months),
            'total' => self::aggregate($start, $end, $franchiseId, $productId, $statuses),
        ];
    }

    /**
     * เทียบสองช่วง โดยอ้างอิง "รอบบิล" หรือ "เดือน"
     *   granularity=period  current=2026-09-H1  previous=2026-08-H1
     *   granularity=month   current=2026-09     previous=2026-08 (ไม่ระบุ = รอบ/เดือนก่อนหน้า)
     */
    public static function compare(string $granularity, mixed $current, mixed $previous, mixed $franchiseId, mixed $productId, mixed $statuses): array
    {
        if (! $current) {
            throw ApiException::badRequest('ต้องระบุ current');
        }
        if ($granularity === 'period') {
            $cur  = Period::fromCode($current);
            $prev = $previous ? Period::fromCode($previous) : Period::shift($cur, -1);
            $a    = ['key' => $cur['code'], 'start' => $cur['startDate'], 'end' => $cur['endDate']];
            $b    = ['key' => $prev['code'], 'start' => $prev['startDate'], 'end' => $prev['endDate']];
        } elseif ($granularity === 'month') {
            $curRange  = Period::monthRange($current);
            $prevKey   = $previous ?: Period::shiftMonth($current, -1);
            $prevRange = Period::monthRange($prevKey);
            $a         = ['key' => $current, 'start' => $curRange['start'], 'end' => $curRange['end']];
            $b         = ['key' => $prevKey, 'start' => $prevRange['start'], 'end' => $prevRange['end']];
        } else {
            throw ApiException::badRequest('granularity: ต้องเป็น month หรือ period');
        }
        $currentTotals  = self::aggregate($a['start'], $a['end'], $franchiseId, $productId, $statuses);
        $previousTotals = self::aggregate($b['start'], $b['end'], $franchiseId, $productId, $statuses);

        return [
            'granularity' => $granularity,
            'current'     => ['key' => $a['key'], 'startDate' => $a['start'], 'endDate' => $a['end'], ...$currentTotals],
            'previous'    => ['key' => $b['key'], 'startDate' => $b['start'], 'endDate' => $b['end'], ...$previousTotals],
            'diff'        => self::diffOf($currentTotals, $previousTotals),
            'breakdown'   => [
                'current'  => self::aggregate($a['start'], $a['end'], $franchiseId, $productId, $statuses, 'period'),
                'previous' => self::aggregate($b['start'], $b['end'], $franchiseId, $productId, $statuses, 'period'),
            ],
        ];
    }

    /** รอบบิลที่ตกอยู่ในช่วงวันที่ + รอบที่คาบเกี่ยวแต่ไม่เต็มรอบ (แจ้งเตือน) */
    private static function periodCoverage(string $start, string $end): array
    {
        return [
            'included' => array_column(Db::all('SELECT code FROM billing_periods WHERE start_date >= ? AND end_date <= ? ORDER BY start_date', [$start, $end]), 'code'),
            'partial'  => array_column(Db::all(
                'SELECT code FROM billing_periods
                  WHERE start_date <= ? AND end_date >= ?
                    AND NOT (start_date >= ? AND end_date <= ?)
                  ORDER BY start_date',
                [$end, $start, $start, $end],
            ), 'code'),
        ];
    }

    /**
     * เทียบ "ช่วงวันที่เดียวกัน" ระหว่างสองช่วงเวลา
     *   ระบุเอง: aStart/aEnd + bStart/bEnd
     *   หรือระบุช่วง A แล้วให้ระบบเลื่อน: against = prev_month | prev_quarter | prev_year
     * นับเฉพาะรอบบิลที่อยู่ในช่วงเต็มรอบ (รอบที่คาบเกี่ยวบางส่วนจะรายงานไว้ใน warnings)
     */
    public static function compareRange(array $q, mixed $franchiseId, mixed $productId, mixed $statuses): array
    {
        $start = Period::assertDate($q['aStart'] ?? null, 'aStart');
        $end   = Period::assertDate($q['aEnd'] ?? null, 'aEnd');
        if ($end < $start) {
            throw ApiException::badRequest('aEnd ต้องไม่น้อยกว่า aStart');
        }
        if (! empty($q['bStart']) && ! empty($q['bEnd'])) {
            $prevStart = Period::assertDate($q['bStart'], 'bStart');
            $prevEnd   = Period::assertDate($q['bEnd'], 'bEnd');
            if ($prevEnd < $prevStart) {
                throw ApiException::badRequest('bEnd ต้องไม่น้อยกว่า bStart');
            }
        } else {
            $shift = ['prev_month' => -1, 'prev_quarter' => -3, 'prev_year' => -12][$q['against'] ?? 'prev_month'] ?? null;
            if ($shift === null) {
                throw ApiException::badRequest('against: ต้องเป็น prev_month, prev_quarter หรือ prev_year');
            }
            $prevStart = Period::addMonthsToDate($start, $shift);
            $prevEnd   = Period::addMonthsToDate($end, $shift);
        }
        $currentTotals  = self::aggregate($start, $end, $franchiseId, $productId, $statuses);
        $previousTotals = self::aggregate($prevStart, $prevEnd, $franchiseId, $productId, $statuses);
        $coverageA      = self::periodCoverage($start, $end);
        $coverageB      = self::periodCoverage($prevStart, $prevEnd);
        $warnings       = [];
        if ($coverageA['partial'] !== []) {
            $warnings[] = 'ช่วง A มีรอบบิลที่คาบเกี่ยวไม่เต็มรอบและไม่ถูกนับ: ' . implode(', ', $coverageA['partial']);
        }
        if ($coverageB['partial'] !== []) {
            $warnings[] = 'ช่วง B มีรอบบิลที่คาบเกี่ยวไม่เต็มรอบและไม่ถูกนับ: ' . implode(', ', $coverageB['partial']);
        }

        return [
            'current'  => ['startDate' => $start, 'endDate' => $end, 'periods' => $coverageA['included'], ...$currentTotals],
            'previous' => ['startDate' => $prevStart, 'endDate' => $prevEnd, 'periods' => $coverageB['included'], ...$previousTotals],
            'diff'     => self::diffOf($currentTotals, $previousTotals),
            'warnings' => $warnings,
        ];
    }

    /** ตารางจัดอันดับตามร้าน/สินค้า ในช่วงรอบบิลที่กำหนด */
    public static function breakdown(mixed $fromPeriod, mixed $toPeriod, string $groupBy, mixed $franchiseId, mixed $productId, mixed $statuses): array
    {
        $range = Period::between($fromPeriod, $toPeriod);
        $start = $range[0]['startDate'];
        $end   = end($range)['endDate'];
        $rows  = self::aggregate($start, $end, $franchiseId, $productId, $statuses, $groupBy);
        usort($rows, static fn ($x, $y) => $y['grossAmount'] <=> $x['grossAmount']);

        return [
            'scope' => ['fromPeriod' => $range[0]['code'], 'toPeriod' => end($range)['code'], 'groupBy' => $groupBy],
            'rows'  => $rows,
            'total' => self::aggregate($start, $end, $franchiseId, $productId, $statuses),
        ];
    }

    /** สรุปหน้าแรก: รอบปัจจุบัน เทียบรอบก่อน + ยอดค้างชำระ */
    public static function dashboard(string $periodCode, ?int $franchiseId): array
    {
        $cur        = Period::fromCode($periodCode);
        $prev       = Period::shift($cur, -1);
        $curTotals  = self::aggregate($cur['startDate'], $cur['endDate'], $franchiseId);
        $prevTotals = self::aggregate($prev['startDate'], $prev['endDate'], $franchiseId);
        $where      = $franchiseId ? 'AND i.franchise_id = ?' : '';
        $params     = $franchiseId ? [$franchiseId] : [];
        // ยอดค้างคิดจาก net_total (รวมค่าใช้จ่ายอื่นและหักส่วนลดแล้ว)
        $outstanding = Db::one(
            "SELECT COALESCE(SUM(i.net_total_satang - i.paid_satang), 0) AS amount, COUNT(*) AS invoices
               FROM invoices i
              WHERE i.status IN ('OPEN', 'PARTIAL') {$where}",
            $params,
        );
        $pending = Db::one(
            "SELECT COUNT(*) AS n, COALESCE(SUM(ps.amount_satang), 0) AS amount
               FROM payment_submissions ps
               JOIN invoices i ON i.id = ps.invoice_id
              WHERE ps.status = 'PENDING' {$where}",
            $params,
        );
        $top = self::aggregate($cur['startDate'], $cur['endDate'], $franchiseId, null, null, 'product', true);
        usort($top, static fn ($a, $b) => $b['grossAmount'] <=> $a['grossAmount']);

        return [
            'period'          => ['code' => $cur['code'], 'startDate' => $cur['startDate'], 'endDate' => $cur['endDate']],
            'current'         => $curTotals,
            'previousPeriod'  => ['key' => $prev['code'], ...$prevTotals],
            'diff'            => self::diffOf($curTotals, $prevTotals),
            'outstanding'     => ['amount' => Money::toBaht((int) $outstanding['amount']), 'invoices' => (int) $outstanding['invoices']],
            'pendingPayments' => ['count' => (int) $pending['n'], 'amount' => Money::toBaht((int) $pending['amount'])],
            'topProducts'     => array_slice($top, 0, 5),
        ];
    }

    /**
     * ภาพของร้านในเครือ — สิ่งที่ทำให้ร้านรู้สึกว่าระบบมีค่ากับเขา ไม่ใช่แค่ที่ทวงเงิน
     *
     *   rank          อันดับยอดขายเต็มของรอบนี้ เทียบทุกสาขาที่มียอด (บอกแค่อันดับ ไม่บอกร้านอื่นหรือยอดของใคร)
     *   onTimeStreak  จ่ายครบภายในวันครบกำหนดติดกันกี่รอบล่าสุด (บิลที่ยังไม่ถึงกำหนดไม่นับ ไม่ตัดสาย)
     *   recentlyPaid  บิลที่ปิดยอดครบภายใน 7 วัน — ไว้ขึ้นข้อความขอบคุณ
     */
    public static function shopStanding(int $franchiseId, string $periodCode): array
    {
        $periodId = Db::val('SELECT id FROM billing_periods WHERE code = ?', [$periodCode]);
        // อันดับเทียบเฉพาะร้านที่ยังอยู่ — ร้านที่ลบแล้วไม่ใช่คู่เทียบของใคร (ยอดของมันยังอยู่ในรายงานตามปกติ)
        $totals   = $periodId === null ? [] : Db::all(
            "SELECT se.franchise_id, SUM(se.gross_amount_satang) AS gross
               FROM sales_entries se
               JOIN franchises f ON f.id = se.franchise_id AND f.status <> 'DELETED'
              WHERE se.period_id = ?
              GROUP BY se.franchise_id HAVING SUM(se.gross_amount_satang) > 0 ORDER BY gross DESC, se.franchise_id",
            [$periodId],
        );
        $position = null;
        foreach ($totals as $i => $r) {
            if ((int) $r['franchise_id'] === $franchiseId) {
                $position = $i;
                break;
            }
        }
        $bills = Db::all(
            "SELECT i.id, i.invoice_no, i.status, i.due_date, i.paid_at, i.net_total_satang, bp.code AS period_code
               FROM invoices i JOIN billing_periods bp ON bp.id = i.period_id
              WHERE i.franchise_id = ? AND i.status <> 'VOID'
              ORDER BY bp.start_date DESC, i.id DESC",
            [$franchiseId],
        );
        $todayIso = Clock::todayThai();
        $toThaiDate = static function (?string $utc): ?string {
            $epoch = Clock::utcToEpoch($utc);

            return $epoch === null ? null : gmdate('Y-m-d', $epoch + 7 * 3600);
        };
        $streak = 0;
        foreach ($bills as $b) {
            if ($b['status'] === 'PAID') {
                // บิลยอด 0 (หักยอดยกมาหมด) ไม่ได้จ่ายอะไร — ไม่นับทั้งได้และเสีย
                if ((int) $b['net_total_satang'] === 0) {
                    continue;
                }
                $paidIso = $toThaiDate($b['paid_at']);
                if ($paidIso !== null && $paidIso <= $b['due_date']) {
                    $streak++;
                } else {
                    break;
                }
            } elseif ($b['due_date'] < $todayIso) {
                break; // ค้างเลยกำหนด = สายตัด
            }
        }
        $recent = null;
        foreach ($bills as $b) {
            $paidEpoch = Clock::utcToEpoch($b['paid_at']);
            if ($b['status'] === 'PAID' && (int) $b['net_total_satang'] > 0 && $paidEpoch !== null && time() - $paidEpoch < 7 * 86400) {
                $recent = $b;
                break;
            }
        }

        return [
            'rank'         => $position !== null ? ['position' => $position + 1, 'of' => count($totals)] : null,
            'onTimeStreak' => $streak,
            'recentlyPaid' => $recent
                ? ['invoiceId' => (int) $recent['id'], 'invoiceNo' => $recent['invoice_no'], 'periodCode' => $recent['period_code'], 'amount' => Money::toBaht($recent['net_total_satang']), 'paidAt' => $recent['paid_at']]
                : null,
        ];
    }
}
