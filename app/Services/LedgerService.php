<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Db;
use App\Libraries\Money;
use App\Libraries\Period;
use App\Libraries\Usd;

/**
 * สมุดรายรับ-รายจ่ายของส่วนกลาง แยกตามรอบบิล
 *
 * ไม่เกี่ยวกับบิลของร้าน — รายการในนี้ไม่ไปโผล่ในใบเรียกเก็บใด ๆ
 * ใช้ตอบคำถามว่า "รอบนี้เก็บส่วนต่างมาได้เท่านี้ หักค่าใช้จ่ายของเราแล้วเหลือเท่าไร"
 */
final class LedgerService
{
    private const SELECT = '
        SELECT l.*, bp.code AS period_code, bp.usd_rate_satang AS period_usd_rate_satang, u.username AS created_by
          FROM ledger_entries l
          JOIN billing_periods bp ON bp.id = l.period_id
          LEFT JOIN users u       ON u.id = l.created_by_user_id';

    public static function create(array $input, int $actorUserId): array
    {
        $period = PeriodService::ensure($input['periodCode']);
        $kind   = $input['kind'] ?? 'EXPENSE';
        if (! in_array($kind, ['EXPENSE', 'INCOME'], true)) {
            throw ApiException::badRequest('kind: ต้องเป็น EXPENSE หรือ INCOME');
        }
        $label = trim((string) ($input['label'] ?? ''));
        if ($label === '') {
            throw ApiException::badRequest('ต้องระบุชื่อรายการ');
        }
        $satang = Money::toSatang($input['amount'] ?? null, 'amount');
        if ($satang < 0) {
            throw ApiException::badRequest('amount: ต้องไม่ติดลบ — ถ้าเป็นเงินเข้าให้เลือกประเภท "รายรับ" แทน');
        }
        $spentOn = ! empty($input['spentOn']) ? Period::assertDate($input['spentOn'], 'spentOn') : null;
        $id      = Db::insert(
            'INSERT INTO ledger_entries (period_id, kind, label, amount_satang, spent_on, note, created_by_user_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
            [$period['id'], $kind, $label, $satang, $spentOn, $input['note'] ?? null, $actorUserId],
        );
        Audit::write($actorUserId, 'ledger.create', 'ledger_entry', $id, [
            'periodCode' => $period['code'],
            'kind'       => $kind,
            'label'      => $label,
            'amount'     => Money::toBaht($satang),
        ]);

        return self::get($id);
    }

    public static function get(int $id): array
    {
        return self::serialize(Db::one(self::SELECT . ' WHERE l.id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการ'));
    }

    public static function update(int $id, array $patch, int $actorUserId): array
    {
        Db::one('SELECT * FROM ledger_entries WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการ');
        $sets   = [];
        $params = [];
        if (array_key_exists('kind', $patch)) {
            if (! in_array($patch['kind'], ['EXPENSE', 'INCOME'], true)) {
                throw ApiException::badRequest('kind: ต้องเป็น EXPENSE หรือ INCOME');
            }
            $sets[]   = 'kind = ?';
            $params[] = $patch['kind'];
        }
        if (array_key_exists('label', $patch)) {
            $label = trim((string) $patch['label']);
            if ($label === '') {
                throw ApiException::badRequest('ต้องระบุชื่อรายการ');
            }
            $sets[]   = 'label = ?';
            $params[] = $label;
        }
        if (array_key_exists('amount', $patch)) {
            $satang = Money::toSatang($patch['amount'], 'amount');
            if ($satang < 0) {
                throw ApiException::badRequest('amount: ต้องไม่ติดลบ');
            }
            $sets[]   = 'amount_satang = ?';
            $params[] = $satang;
        }
        if (array_key_exists('spentOn', $patch)) {
            $sets[]   = 'spent_on = ?';
            $params[] = $patch['spentOn'] === null ? null : Period::assertDate($patch['spentOn'], 'spentOn');
        }
        if (array_key_exists('note', $patch)) {
            $sets[]   = 'note = ?';
            $params[] = $patch['note'];
        }
        if ($sets === []) {
            return self::get($id);
        }
        $sets[]   = 'updated_at = UTC_TIMESTAMP()';
        $params[] = $id;
        Db::exec('UPDATE ledger_entries SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
        Audit::write($actorUserId, 'ledger.update', 'ledger_entry', $id, $patch);

        return self::get($id);
    }

    public static function delete(int $id, int $actorUserId): array
    {
        $row = Db::one('SELECT * FROM ledger_entries WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการ');
        Db::exec('DELETE FROM ledger_entries WHERE id = ?', [$id]);
        Audit::write($actorUserId, 'ledger.delete', 'ledger_entry', $id, ['label' => $row['label'], 'amount' => Money::toBaht($row['amount_satang'])]);

        return ['deleted' => true, 'id' => $id];
    }

    /**
     * รายการของรอบบิลหนึ่ง พร้อมสรุปกำไรจริงของรอบนั้น
     * "ส่วนต่างที่เรียกเก็บ" นับเฉพาะใบที่ไม่ได้ยกเลิก
     * ส่วน "เก็บเงินได้จริง" คือยอดที่ตัดแล้วจริง ๆ — สองตัวนี้ไม่เท่ากันถ้าร้านยังจ่ายไม่ครบ
     */
    public static function list(?string $periodCode): array
    {
        $where  = [];
        $params = [];
        $period = null;
        if ($periodCode) {
            $period   = PeriodService::ensure($periodCode);
            $where[]  = 'l.period_id = ?';
            $params[] = $period['id'];
        }
        $items = array_map([self::class, 'serialize'], Db::all(
            self::SELECT . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY COALESCE(l.spent_on, l.created_at) DESC, l.id DESC',
            $params,
        ));
        $expenses  = array_filter($items, static fn ($i) => $i['kind'] === 'EXPENSE');
        $incomes   = array_filter($items, static fn ($i) => $i['kind'] === 'INCOME');
        $expense   = array_sum(array_column($expenses, 'amount'));
        $income    = array_sum(array_column($incomes, 'amount'));
        $billed    = 0;
        $collected = 0;
        $row       = null;
        $carry     = null;
        if ($period !== null) {
            // ดอลลาร์ของเงินจากบิล: ปัดทีละบิลตามอัตราที่ตรึงไว้กับบิลนั้น (ไม่มี = อัตราของรอบ) — ตรงกับยอดที่หน้าบิลรวม
            $billedCents    = Usd::sqlCents('i.commission_total_satang', 'i.usd_rate_satang', 'bp.usd_rate_satang');
            $collectedCents = Usd::sqlCents('i.paid_satang', 'i.usd_rate_satang', 'bp.usd_rate_satang');
            $row            = Db::one(
                "SELECT COALESCE(SUM(i.commission_total_satang), 0) AS billed,
                        COALESCE(SUM(i.paid_satang), 0)             AS collected,
                        SUM(ROUND({$billedCents}))                  AS billed_usd_cents,
                        SUM(ROUND({$collectedCents}))               AS collected_usd_cents
                   FROM invoices i
                   JOIN billing_periods bp ON bp.id = i.period_id
                  WHERE i.period_id = ? AND i.status <> 'VOID'",
                [$period['id']],
            );
            $billed    = Money::toBaht((int) $row['billed']);
            $collected = Money::toBaht((int) $row['collected']);
            /*
             * ยอดค้างที่ปิดแบบยกไปเก็บงวดถัดไป — เงินส่วนนี้นับเป็น "เก็บได้จริง" ของรอบบิลที่รับยอดไป ไม่ใช่รอบต้นทาง
             * รอบต้นทางจึงเก็บได้น้อยกว่าที่เรียกเก็บ ส่วนรอบที่รับอาจเก็บได้มากกว่า — สองตัวนี้ไว้บอกที่มาของส่วนต่าง
             */
            $carry = Db::one(
                "SELECT COALESCE(SUM(CASE WHEN a.carry_forward = 1 THEN a.amount_satang END), 0)            AS carried_out,
                        COALESCE(SUM(CASE WHEN a.carried_from_id IS NOT NULL THEN a.amount_satang END), 0) AS carried_in
                   FROM invoice_adjustments a
                   JOIN invoices i ON i.id = a.invoice_id
                  WHERE i.period_id = ? AND i.status <> 'VOID'",
                [$period['id']],
            );
        }
        $expenseUsd   = Usd::sum($expenses, 'amount');
        $incomeUsd    = Usd::sum($incomes, 'amount');
        $collectedUsd = Usd::fromCents($row['collected_usd_cents'] ?? null);

        return [
            'items'   => $items,
            'summary' => [
                'expense'   => Money::round2($expense),
                'income'    => Money::round2($income),
                'billed'    => $billed,
                'collected' => $collected,
                // ยกไป = บิลรอบนี้ปิดยอดค้างไปเก็บงวดถัดไป · ยกมา = บิลรอบนี้รับยอดค้างของงวดก่อนมาเก็บ
                'carriedOut' => Money::toBaht((int) ($carry['carried_out'] ?? 0)),
                'carriedIn'  => Money::toBaht((int) ($carry['carried_in'] ?? 0)),
                // กำไรจริง = เงินที่เก็บเข้ามาได้จริง + รายรับอื่น − รายจ่าย
                'net' => Money::round2($collected + $income - $expense),
                // สมดุลของสมุดเอง = รายรับอื่น − รายจ่าย (ไม่นับเงินจากบิล) — การ์ด "รายรับ-รายจ่าย" หน้าภาพรวม
                'balance' => Money::round2($income - $expense),
                // ยอดเทียบดอลลาร์ของตัวบน (null = ยังไม่เคยตั้งอัตรา) — ดู App\Libraries\Usd
                'expenseUsd'   => $expenseUsd,
                'incomeUsd'    => $incomeUsd,
                'billedUsd'    => Usd::fromCents($row['billed_usd_cents'] ?? null),
                'collectedUsd' => $collectedUsd,
                'netUsd'       => $collectedUsd === null ? null : Money::round2($collectedUsd + $incomeUsd - $expenseUsd),
                'balanceUsd'   => $incomeUsd === null ? null : Money::round2($incomeUsd - $expenseUsd),
            ],
        ];
    }

    public static function serialize(array $row): array
    {
        $amount = (int) $row['amount_satang'];

        return [
            'id'           => (int) $row['id'],
            'periodCode'   => $row['period_code'],
            'kind'         => $row['kind'],
            'kindLabel'    => $row['kind'] === 'INCOME' ? 'รายรับ' : 'รายจ่าย',
            'label'        => $row['label'],
            'amount'       => Money::toBaht($amount),
            'signedAmount' => Money::toBaht($row['kind'] === 'INCOME' ? $amount : -$amount),
            // บาทต่อ 1 ดอลลาร์ที่ใช้เทียบยอดนี้ในสรุป: อัตราของรอบ ไม่มี = อัตราล่าสุด
            'fxRate'       => Usd::rate($row['period_usd_rate_satang'] ?? null),
            'spentOn'      => $row['spent_on'],
            'note'         => $row['note'],
            'createdBy'    => $row['created_by'],
            'createdAt'    => $row['created_at'],
        ];
    }
}
