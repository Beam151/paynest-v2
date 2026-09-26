<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\AuthContext;
use App\Libraries\Db;
use App\Libraries\Money;
use App\Libraries\Period;

/**
 * ยอดขายรายครึ่งเดือน — กรอกโดยส่วนกลางเท่านั้น (1 สินค้า / 1 รอบ = 1 รายการ)
 */
final class SalesService
{
    private const EDITABLE_STATUSES = ['DRAFT', 'SUBMITTED'];

    public const SELECT_ENTRY = '
        SELECT se.*,
               bp.code AS period_code, bp.start_date AS period_start, bp.end_date AS period_end,
               bp.year AS period_year, bp.month AS period_month, bp.half AS period_half,
               bp.status AS period_status,
               p.sku, p.name AS product_name,
               f.username AS franchise_username,
               i.invoice_no
          FROM sales_entries se
          JOIN billing_periods bp ON bp.id = se.period_id
          JOIN products p         ON p.id = se.product_id
          JOIN franchises f       ON f.id = se.franchise_id
          LEFT JOIN invoices i    ON i.id = se.invoice_id';

    public static function get(int $id, array $user): array
    {
        $row = Db::one(self::SELECT_ENTRY . ' WHERE se.id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการยอดขาย');
        if (! AuthContext::isSuperAdmin($user) && (int) $row['franchise_id'] !== (int) $user['franchise_id']) {
            throw ApiException::forbidden();
        }

        return self::serialize($row);
    }

    /**
     * บันทึกยอดขายของสินค้าในรอบบิล (เรียกซ้ำด้วย periodCode + productId เดิม = แก้ไข)
     * กรอก "ยอดเงินเต็ม" ระบบคิดส่วนต่างตามเปอร์เซ็นต์ที่ตั้งไว้ให้เอง
     */
    public static function upsert(array $input, array $user): array
    {
        $period  = PeriodService::ensure($input['periodCode']);
        $isSuper = AuthContext::isSuperAdmin($user);
        if ($period['status'] === 'LOCKED' && ! $isSuper) {
            throw ApiException::conflict("รอบบิล {$period['code']} ถูกปิดแล้ว ไม่สามารถแก้ไขยอดได้");
        }
        $product    = ProductService::getRow((int) $input['productId']);
        $assignment = AssignmentService::resolveForPeriod((int) $product['id'], $period, $isSuper ? null : (int) $user['franchise_id']);

        if (! empty($input['franchiseId']) && (int) $input['franchiseId'] !== (int) $assignment['franchise_id']) {
            throw ApiException::badRequest("สินค้า {$product['sku']} ในรอบ {$period['code']} เป็นของร้าน {$assignment['franchise_username']}");
        }

        // % มาจากสินค้าชิ้นนั้น แล้วเก็บ snapshot ไว้กับรายการนี้ (แก้ % ภายหลังไม่ย้อนไปกระทบยอดเก่า)
        $pctBp = AssignmentService::effectiveCommissionBp($product);
        // ยอดติดลบได้ — ใช้ตอนมีการคืนสินค้า หรือปรับยอดที่กรอกเกินในรอบก่อน
        $grossSatang      = Money::toSatang($input['grossAmount'] ?? null, 'grossAmount');
        $commissionSatang = Money::commissionOf($grossSatang, $pctBp);

        $existing = Db::one('SELECT * FROM sales_entries WHERE period_id = ? AND product_id = ?', [$period['id'], $product['id']]);
        if ($existing !== null) {
            if (! in_array($existing['status'], self::EDITABLE_STATUSES, true) && ! $isSuper) {
                throw ApiException::conflict("รายการนี้สถานะ {$existing['status']} แล้ว แก้ไขไม่ได้ (ติดต่อผู้ดูแลระบบเพื่อเปิดแก้ไข)");
            }
            if ($existing['status'] === 'INVOICED') {
                throw ApiException::conflict('รายการนี้ถูกออกใบเรียกเก็บแล้ว ต้องยกเลิกใบเรียกเก็บก่อนจึงจะแก้ไขได้');
            }
            Db::exec(
                'UPDATE sales_entries
                    SET units = ?, gross_amount_satang = ?, commission_pct_bp = ?, commission_amount_satang = ?,
                        note = ?, assignment_id = ?, updated_by_user_id = ?, updated_at = UTC_TIMESTAMP()
                  WHERE id = ?',
                [
                    array_key_exists('units', $input) ? $input['units'] : $existing['units'],
                    $grossSatang,
                    $pctBp,
                    $commissionSatang,
                    array_key_exists('note', $input) ? $input['note'] : $existing['note'],
                    $assignment['id'],
                    $user['id'],
                    $existing['id'],
                ],
            );
            Audit::write((int) $user['id'], 'entry.update', 'sales_entry', (int) $existing['id'], ['grossSatang' => $grossSatang, 'pctBp' => $pctBp]);

            return self::get((int) $existing['id'], $user);
        }

        $id = Db::insert(
            "INSERT INTO sales_entries
               (period_id, franchise_id, product_id, assignment_id, units, gross_amount_satang,
                commission_pct_bp, commission_amount_satang, note, status, created_by_user_id, updated_by_user_id,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
            [
                $period['id'], $assignment['franchise_id'], $product['id'], $assignment['id'],
                $input['units'] ?? null, $grossSatang, $pctBp, $commissionSatang,
                $input['note'] ?? null, $user['id'], $user['id'],
            ],
        );
        Audit::write((int) $user['id'], 'entry.create', 'sales_entry', $id, ['periodCode' => $period['code'], 'productId' => (int) $product['id']]);

        return self::get($id, $user);
    }

    public static function list(array $filters, array $user): array
    {
        $where       = [];
        $params      = [];
        $franchiseId = AuthContext::isSuperAdmin($user) ? ($filters['franchiseId'] ?? null) : $user['franchise_id'];
        if ($franchiseId) {
            $where[]  = 'se.franchise_id = ?';
            $params[] = (int) $franchiseId;
        }
        if (! empty($filters['productId'])) {
            $where[]  = 'se.product_id = ?';
            $params[] = (int) $filters['productId'];
        }
        if (! empty($filters['status'])) {
            $where[]  = 'se.status = ?';
            $params[] = $filters['status'];
        }
        if (! empty($filters['periodCode'])) {
            // ใช้ fromCode (ไม่ใช่ getByCode) เพราะการ "ดู" รอบที่ยังไม่มีข้อมูลควรได้ผลลัพธ์ว่าง ไม่ใช่ 404
            $where[]  = 'bp.code = ?';
            $params[] = Period::fromCode($filters['periodCode'])['code'];
        } elseif (! empty($filters['fromPeriod']) && ! empty($filters['toPeriod'])) {
            $where[]  = 'bp.code IN ?';
            $params[] = array_column(Period::between($filters['fromPeriod'], $filters['toPeriod']), 'code');
        }

        $rows = array_map([self::class, 'serialize'], Db::all(
            self::SELECT_ENTRY . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY bp.start_date DESC, p.sku',
            $params,
        ));

        return [
            'items'   => $rows,
            'summary' => [
                'count'           => count($rows),
                'grossTotal'      => Money::round2(array_sum(array_column($rows, 'grossAmount'))),
                'commissionTotal' => Money::round2(array_sum(array_column($rows, 'commissionAmount'))),
            ],
        ];
    }

    private static function transition(int $id, array $user, array $from, string $to, ?string $stampColumn, string $action): array
    {
        $row = Db::one('SELECT * FROM sales_entries WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการยอดขาย');
        if (! AuthContext::isSuperAdmin($user)) {
            throw ApiException::forbidden();
        }
        if (! in_array($row['status'], $from, true)) {
            throw ApiException::conflict("เปลี่ยนสถานะไม่ได้: ปัจจุบันคือ {$row['status']} (ต้องเป็น " . implode(' หรือ ', $from) . ')');
        }
        $stamp = $stampColumn ? ", {$stampColumn} = UTC_TIMESTAMP()" : '';
        Db::exec("UPDATE sales_entries SET status = ?, updated_by_user_id = ?, updated_at = UTC_TIMESTAMP(){$stamp} WHERE id = ?", [$to, $user['id'], $id]);
        Audit::write((int) $user['id'], $action, 'sales_entry', $id, ['from' => $row['status'], 'to' => $to]);

        return self::get($id, $user);
    }

    /** ส่วนกลางอนุมัติยอด ('SUBMITTED' รองรับข้อมูลเก่าที่ยังค้างอยู่) */
    public static function approve(int $id, array $user): array
    {
        return self::transition($id, $user, ['DRAFT', 'SUBMITTED'], 'APPROVED', 'approved_at', 'entry.approve');
    }

    /** ส่วนกลางเปิดให้แก้ไขใหม่ */
    public static function reopen(int $id, array $user): array
    {
        return self::transition($id, $user, ['SUBMITTED', 'APPROVED'], 'DRAFT', null, 'entry.reopen');
    }

    public static function delete(int $id, array $user): array
    {
        $row = Db::one('SELECT * FROM sales_entries WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการยอดขาย');
        $isSuper = AuthContext::isSuperAdmin($user);
        if (! $isSuper && (int) $row['franchise_id'] !== (int) $user['franchise_id']) {
            throw ApiException::forbidden();
        }
        if ($row['status'] === 'INVOICED') {
            throw ApiException::conflict('รายการที่ออกใบเรียกเก็บแล้วลบไม่ได้');
        }
        if ($row['status'] === 'APPROVED' && ! $isSuper) {
            throw ApiException::conflict('รายการที่อนุมัติแล้วลบไม่ได้');
        }
        Db::exec('DELETE FROM sales_entries WHERE id = ?', [$id]);
        Audit::write((int) $user['id'], 'entry.delete', 'sales_entry', $id);

        return ['deleted' => true, 'id' => $id];
    }

    public static function serialize(array $row): array
    {
        return [
            'id'     => (int) $row['id'],
            'period' => [
                'id'        => (int) $row['period_id'],
                'code'      => $row['period_code'],
                'startDate' => $row['period_start'],
                'endDate'   => $row['period_end'],
                'year'      => (int) $row['period_year'],
                'month'     => (int) $row['period_month'],
                'half'      => (int) $row['period_half'],
                'status'    => $row['period_status'],
            ],
            'franchiseId'       => (int) $row['franchise_id'],
            'franchiseUsername' => $row['franchise_username'],
            'productId'         => (int) $row['product_id'],
            'sku'               => $row['sku'],
            'productName'       => $row['product_name'],
            'assignmentId'      => $row['assignment_id'] === null ? null : (int) $row['assignment_id'],
            'units'             => $row['units'] === null ? null : (int) $row['units'],
            'grossAmount'       => Money::toBaht($row['gross_amount_satang']),
            'commissionPct'     => Money::bpToPct($row['commission_pct_bp']),
            'commissionAmount'  => Money::toBaht($row['commission_amount_satang']),
            'netAmount'         => Money::toBaht((int) $row['gross_amount_satang'] - (int) $row['commission_amount_satang']),
            'note'              => $row['note'],
            'status'            => $row['status'],
            'invoiceId'         => $row['invoice_id'] === null ? null : (int) $row['invoice_id'],
            'invoiceNo'         => $row['invoice_no'],
            'submittedAt'       => $row['submitted_at'],
            'approvedAt'        => $row['approved_at'],
            'updatedAt'         => $row['updated_at'],
        ];
    }
}
