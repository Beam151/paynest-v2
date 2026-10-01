<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\AuthContext;
use App\Libraries\Db;
use App\Libraries\Json;
use App\Libraries\Money;
use App\Libraries\Period;

/**
 * ยอดขายรายครึ่งเดือน — กรอกโดยส่วนกลางเท่านั้น (1 สินค้า / 1 รอบ = 1 รายการ)
 */
final class SalesService
{
    private const EDITABLE_STATUSES = ['DRAFT', 'SUBMITTED'];

    /**
     * ยอดที่กรอกเอง (หน้ายอดขาย และตอนออกบิล) ไม่เกินนี้ — กันตัวเลขยาวผิดปกติ
     * Money::toSatang กับเลขที่เกิน int64 พังเป็น 500 แทนที่จะบอกผู้ใช้
     */
    public const MAX_MANUAL_BAHT = 100_000_000;

    public const SELECT_ENTRY = '
        SELECT se.*,
               bp.code AS period_code, bp.start_date AS period_start, bp.end_date AS period_end,
               bp.year AS period_year, bp.month AS period_month, bp.half AS period_half,
               bp.status AS period_status,
               p.sku, p.name AS product_name, p.is_group AS product_is_group, p.status AS product_status,
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

        return self::serializeMany([$row])[0];
    }

    /**
     * บันทึกยอดขายของสินค้าในรอบบิล (เรียกซ้ำด้วย periodCode + productId เดิม = แก้ไข)
     * กรอก "ยอดเงินเต็ม" ระบบคิดส่วนต่างตามเปอร์เซ็นต์ที่ตั้งไว้ให้เอง
     *
     * R21: กรอก "ยอดส่วนต่างที่กรอกเอง" (manualAmount) ไว้ด้วยก็ได้ — ยอดบิลที่คิดมาแล้ว ไม่ต้องคิดจาก %
     *   ไม่ส่งคีย์มา = ใช้ค่าเดิมของรายการ (รายการใหม่ = ไม่มี) · null = ล้าง · ตัวเลข = ตั้งใหม่
     *   ยอดเต็มยังบังคับกรอก — รายงาน อันดับ และค่าคอมเซล (% ของยอดเต็ม) ใช้ยอดเต็มเสมอ
     * ค่าที่ใช้ออกบิล (bill_mode + commission_amount_satang) ตั้งเป็นค่าตั้งต้นของหน้ายอดขายทุกครั้งที่บันทึก:
     *   มียอดที่กรอกไว้ = MANUAL ตามยอดนั้น · ไม่มี = PCT (ยอดเต็ม × % ของสินค้า) — ตอนออกบิลเปลี่ยนรายบรรทัดได้
     */
    public static function upsert(array $input, array $user): array
    {
        $period  = PeriodService::ensure($input['periodCode']);
        $isSuper = AuthContext::isSuperAdmin($user);
        if ($period['status'] === 'LOCKED' && ! $isSuper) {
            throw ApiException::conflict("รอบบิล {$period['code']} ถูกปิดแล้ว ไม่สามารถแก้ไขยอดได้");
        }
        $product = ProductService::getRow((int) $input['productId']);
        // สินค้าที่ปิดใช้งาน/ลบแล้วรับยอดใหม่ไม่ได้ (ยอดที่บันทึกไว้ก่อนปิดยังออกบิลได้ตามปกติ · ลบได้เฉพาะตอนไม่มียอดค้างออกบิล)
        ProductService::assertActive($product, 'บันทึกยอด');
        // สัญญาของร้านที่ถูกลบไม่ถูกนับ (AssignmentService::overlapping) — ร้านที่ลบแล้วจึงรับยอดใหม่ไม่ได้ทุกรอบ แม้รอบเก่าที่เคยถือ
        $assignment = AssignmentService::resolveForPeriod((int) $product['id'], $period, $isSuper ? null : (int) $user['franchise_id']);

        if (! empty($input['franchiseId']) && (int) $input['franchiseId'] !== (int) $assignment['franchise_id']) {
            throw ApiException::badRequest("สินค้า {$product['sku']} ในรอบ {$period['code']} เป็นของร้าน {$assignment['franchise_username']}");
        }

        // % มาจากสินค้าชิ้นนั้น แล้วเก็บ snapshot ไว้กับรายการนี้ (แก้ % ภายหลังไม่ย้อนไปกระทบยอดเก่า)
        $pctBp = AssignmentService::effectiveCommissionBp($product);
        // ยอดติดลบได้ — ใช้ตอนมีการคืนสินค้า หรือปรับยอดที่กรอกเกินในรอบก่อน
        $grossSatang = Money::toSatang($input['grossAmount'] ?? null, 'grossAmount');

        $existing = Db::one('SELECT * FROM sales_entries WHERE period_id = ? AND product_id = ?', [$period['id'], $product['id']]);
        if ($existing !== null) {
            if (! in_array($existing['status'], self::EDITABLE_STATUSES, true) && ! $isSuper) {
                throw ApiException::conflict("รายการนี้สถานะ {$existing['status']} แล้ว แก้ไขไม่ได้ (ติดต่อผู้ดูแลระบบเพื่อเปิดแก้ไข)");
            }
            if ($existing['status'] === 'INVOICED') {
                throw ApiException::conflict('รายการนี้ถูกออกใบเรียกเก็บแล้ว ต้องยกเลิกใบเรียกเก็บก่อนจึงจะแก้ไขได้');
            }
        }

        $manualSatang = self::resolveManual($input, $existing, $grossSatang, (string) $product['sku']);
        // ค่าตั้งต้นของหน้ายอดขาย: มียอดที่กรอกไว้ = ใช้ยอดนั้น · ไม่มี = ยอดเต็ม × %
        $billMode         = $manualSatang === null ? 'PCT' : 'MANUAL';
        $commissionSatang = $manualSatang ?? Money::commissionOf($grossSatang, $pctBp);

        if ($existing !== null) {
            $oldManual = $existing['manual_amount_satang'] === null ? null : (int) $existing['manual_amount_satang'];
            $oldMode   = $existing['bill_mode'] ?? 'PCT';
            /*
             * บันทึกยอดใหม่ = เริ่มจากค่าตั้งต้นทั้งหมด: % ของสินค้า · วิธีคิดตามยอดที่กรอกไว้ (มี = ใช้ยอดนั้น · ไม่มี = คิดตาม %)
             * วิธีคิดที่เลือกตอนออกบิลผูกกับยอดเดิม — บันทึกยอดใหม่แล้วต้องเลือกใหม่ตอนออกบิล
             * (มาถึงตรงนี้ได้เฉพาะรายการที่ยังไม่ขึ้นบิล คือยังไม่เคยออก หรือบิลเดิมถูกยกเลิกแล้ว)
             * ค่าคอมเซลไม่ได้เก็บที่รายการนี้แล้ว — อยู่ในบิลค่าคอม (sales_commission_lines) ซึ่งเก็บยอดเต็ม ณ ตอนทำบิลไว้เอง
             */
            Db::exec(
                'UPDATE sales_entries
                    SET units = ?, gross_amount_satang = ?, commission_pct_bp = ?, commission_amount_satang = ?,
                        manual_amount_satang = ?, bill_mode = ?,
                        note = ?, assignment_id = ?, updated_by_user_id = ?, updated_at = UTC_TIMESTAMP()
                  WHERE id = ?',
                [
                    array_key_exists('units', $input) ? $input['units'] : $existing['units'],
                    $grossSatang,
                    $pctBp,
                    $commissionSatang,
                    $manualSatang,
                    $billMode,
                    array_key_exists('note', $input) ? $input['note'] : $existing['note'],
                    $assignment['id'],
                    $user['id'],
                    $existing['id'],
                ],
            );
            Audit::write((int) $user['id'], 'entry.update', 'sales_entry', (int) $existing['id'], [
                'grossSatang'  => $grossSatang,
                'pctBp'        => $pctBp,
                'manualSatang' => $manualSatang,
                /*
                 * ให้ประวัติบอกได้ว่าวิธีคิดที่เลือกไว้ตอนออกบิล (บิลเดิมถูกยกเลิก) ถูกล้างกลับเป็นค่าตั้งต้นของหน้ายอดขาย
                 * เพราะการแก้ครั้งนี้: กรอกยอดเองตอนออกบิล (ไม่ใช่ยอดที่กรอกไว้) หรือเลือกคิดตาม % ทั้งที่มียอดที่กรอกไว้
                 */
                'modesReset' => $oldMode === 'MANUAL'
                    ? $oldManual === null || (int) $existing['commission_amount_satang'] !== $oldManual
                    : $oldManual !== null,
            ]);

            return self::get((int) $existing['id'], $user);
        }

        $id = Db::insert(
            "INSERT INTO sales_entries
               (period_id, franchise_id, product_id, assignment_id, units, gross_amount_satang,
                commission_pct_bp, commission_amount_satang, manual_amount_satang, bill_mode,
                note, status, created_by_user_id, updated_by_user_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
            [
                $period['id'], $assignment['franchise_id'], $product['id'], $assignment['id'],
                $input['units'] ?? null, $grossSatang, $pctBp, $commissionSatang, $manualSatang, $billMode,
                $input['note'] ?? null, $user['id'], $user['id'],
            ],
        );
        Audit::write((int) $user['id'], 'entry.create', 'sales_entry', $id, [
            'periodCode'   => $period['code'],
            'productId'    => (int) $product['id'],
            'manualSatang' => $manualSatang,
        ]);

        return self::get($id, $user);
    }

    /* ── ยอดส่วนต่างที่กรอกเอง (R21) ─────────────────────────────── */

    /**
     * ยอดส่วนต่างที่กรอกเองของรายการหลังบันทึกครั้งนี้ (สตางค์ · null = ไม่มี)
     *   ไม่ส่งคีย์มา = ค่าเดิมของรายการ · null = ล้าง · ตัวเลข = ตั้งใหม่
     * ตรวจกับยอดเต็ม "ใหม่" เสมอ — แก้ยอดเต็มจนยอดที่กรอกไว้เกิน/คนละเครื่องหมาย ต้องให้คนแก้หรือล้าง ห้ามเก็บค่าที่ใช้ไม่ได้ไว้เงียบ ๆ
     */
    private static function resolveManual(array $input, ?array $existing, int $grossSatang, string $sku): ?int
    {
        if (! array_key_exists('manualAmount', $input)) {
            $kept = $existing['manual_amount_satang'] ?? null;
            if ($kept === null) {
                return null;
            }
            $kept = (int) $kept;
            if (! self::manualFits($kept, $grossSatang)) {
                throw ApiException::badRequest(
                    "สินค้า {$sku}: ยอดเงินเต็มใหม่ " . Money::fmtSatang($grossSatang) . ' บาท ใช้กับยอดส่วนต่างที่กรอกไว้ '
                    . Money::fmtSatang($kept) . ' บาท ไม่ได้ (ยอดส่วนต่างต้องอยู่ระหว่าง 0 ถึงยอดเงินเต็ม) — '
                    . 'แก้ช่อง "ยอดส่วนต่างที่กรอกเอง" หรือล้างช่องนั้นแล้วบันทึกใหม่',
                );
            }

            return $kept;
        }
        if ($input['manualAmount'] === null) {
            return null;
        }
        $manual = self::manualSatang($input['manualAmount'], $sku, 'ยอดส่วนต่างที่กรอกเอง', 'manualAmount');
        if (! self::manualFits($manual, $grossSatang)) {
            throw ApiException::badRequest(
                "สินค้า {$sku}: ยอดส่วนต่างที่กรอกเองต้องอยู่ระหว่าง 0 ถึงยอดเงินเต็ม (" . Money::fmtSatang($grossSatang) . ' บาท) '
                . 'และเป็นบวก/ลบตามยอดเงินเต็ม',
            );
        }

        return $manual;
    }

    /**
     * จำนวนเงินที่กรอกเอง → สตางค์ (ช่อง "ยอดส่วนต่างที่กรอกเอง" ของหน้ายอดขาย และ "กรอกยอดเอง" ตอนออกบิล)
     * กันตัวเลขยาวผิดปกติก่อนแปลง — เกิน int64 แล้ว Money::toSatang พังเป็น 500
     *
     * @param string $what  ชื่อช่องในข้อความ error ("จำนวนเงิน" / "ยอดส่วนต่างที่กรอกเอง")
     * @param string $field ชื่อช่องสำหรับข้อความรูปแบบผิดของ Money::toSatang
     */
    public static function manualSatang(mixed $amount, string $sku, string $what, string $field): int
    {
        $tooBig = "สินค้า {$sku}: {$what}เกินกำหนด (ไม่เกิน " . Money::fmt(self::MAX_MANUAL_BAHT) . ' บาท)';
        $raw    = is_string($amount) ? str_replace(',', '', trim($amount)) : $amount;
        if (is_numeric($raw) && abs((float) $raw) > self::MAX_MANUAL_BAHT) {
            throw ApiException::badRequest($tooBig);
        }
        $satang = Money::toSatang($amount, $field);
        if (abs($satang) > self::MAX_MANUAL_BAHT * 100) {
            throw ApiException::badRequest($tooBig);
        }

        return $satang;
    }

    /**
     * ยอดส่วนต่างที่กำหนดเองใช้กับยอดเต็มนี้ได้ไหม: 0 ได้เสมอ · ไม่งั้นเครื่องหมายเดียวกับยอดเต็ม และไม่เกินยอดเต็ม
     * กันพิมพ์ "-" หลงบนบรรทัดขายปกติ — ยอดบิลติดลบกลายเป็นเครดิตที่เราติดค้างร้านจริง ๆ
     * กติกาเดียวกับ CHECK ck_entries_manual ของฐานข้อมูล (migration 000005)
     */
    public static function manualFits(int $amount, int $grossSatang): bool
    {
        return $amount === 0 || (($amount > 0) === ($grossSatang > 0) && abs($amount) <= abs($grossSatang));
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

        $rows = self::serializeMany(Db::all(
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

    /* ── สินค้ากลุ่ม: รายการย่อยที่โชว์ใต้บรรทัด ─────────────────────── */

    /**
     * จดรายการย่อยของสินค้ากลุ่มไว้กับรายการยอดขายตอนขึ้นบิล (InvoiceService::generate / addEntries เรียกใน transaction เดียวกัน)
     * บิลเก่าจึงโชว์ว่าในชุดมีอะไร ณ วันที่ออกบิล แม้ภายหลังจะแก้รายการย่อยของกลุ่ม
     * ทับค่าเก่าเสมอ (สินค้าที่ไม่ใช่กลุ่ม = NULL) — รายการจากบิลที่ถูกยกเลิกแล้วออกใหม่ต้องได้รายการย่อย ณ ตอนออกใหม่
     * รายการย่อยทั้งหมดดึงคิวรีเดียว + UPDATE คำสั่งเดียว ไม่ว่าจะกี่บรรทัด
     *
     * @param list<array> $entries แถว sales_entries (ต้องมี id, product_id, components_snapshot)
     */
    public static function snapshotComponents(array $entries): void
    {
        if ($entries === []) {
            return;
        }
        /*
         * สินค้าที่ลบแล้ว (แบบซ่อน) ไม่มีรายการย่อย "ตอนนี้" ให้จด — ProductService::delete ล้างรายการย่อยของกลุ่มทิ้ง
         * ยอดของมันขึ้นบิลได้อีกทางเดียวคือบิลเดิมถูกยกเลิก (ลบได้เฉพาะตอนไม่มียอดค้างออกบิล) ซึ่งยังถือ snapshot ของบิลเดิมอยู่
         * (ยกเลิกบิลไม่ล้าง) → ไม่แตะแถวพวกนี้ ไม่งั้นออกบิลใหม่แล้วชุดนั้นกลายเป็นสินค้าธรรมดา "ประกอบด้วย" หายจากบิล
         */
        $deleted = array_flip(array_map('intval', array_column(Db::all(
            "SELECT id FROM products WHERE id IN ? AND status = 'DELETED'",
            [array_values(array_unique(array_map(static fn ($e) => (int) $e['product_id'], $entries)))],
        ), 'id')));
        $entries = array_values(array_filter($entries, static fn ($e) => ! isset($deleted[(int) $e['product_id']])));
        if ($entries === []) {
            return;
        }
        $items  = ProductService::itemsOf(array_map(static fn ($e) => (int) $e['product_id'], $entries));
        $ids    = array_map(static fn ($e) => (int) $e['id'], $entries);
        $cases  = [];
        $params = [];
        foreach ($entries as $e) {
            $list = $items[(int) $e['product_id']] ?? [];
            if ($list === []) {
                continue;
            }
            $cases[] = 'WHEN ? THEN ?';
            array_push($params, (int) $e['id'], Json::encode(array_map(
                static fn ($c) => ['id' => $c['id'], 'sku' => $c['sku'], 'name' => $c['name']],
                $list,
            )));
        }
        if ($cases === []) {
            // ไม่มีสินค้ากลุ่มในชุดนี้ — ล้างเฉพาะแถวที่ยังมีค่าค้างจากบิลที่ถูกยกเลิก (ส่วนใหญ่ไม่มีเลย)
            Db::exec('UPDATE sales_entries SET components_snapshot = NULL WHERE id IN ? AND components_snapshot IS NOT NULL', [$ids]);

            return;
        }
        Db::exec(
            'UPDATE sales_entries SET components_snapshot = CASE id ' . implode(' ', $cases) . ' ELSE NULL END WHERE id IN ?',
            [...$params, $ids],
        );
    }

    /**
     * รายการย่อยที่จดไว้ตอนขึ้นบิล → [{sku, name}] · null = ตอนขึ้นบิลไม่ใช่สินค้ากลุ่ม
     * (SalesAgentService ใช้ตัวเดียวกันกับรายการที่ติ๊กทำบิลค่าคอม — เป็นบรรทัดของบิลร้านเหมือนกัน)
     */
    public static function billedComponents(?string $snapshot): ?array
    {
        $list = $snapshot === null ? null : json_decode($snapshot, true);

        return is_array($list)
            ? array_map(static fn ($c) => ['sku' => (string) ($c['sku'] ?? ''), 'name' => (string) ($c['name'] ?? '')], $list)
            : null;
    }

    /**
     * serialize หลายแถว — รายการย่อยของสินค้ากลุ่มที่ยังไม่ขึ้นบิลดึงคิวรีเดียวทั้งชุด (แถวที่อยู่ในบิลใช้ snapshot ไม่ต้องดึง)
     *
     * @param list<array> $rows
     */
    public static function serializeMany(array $rows): array
    {
        $groupIds = [];
        foreach ($rows as $r) {
            if ($r['invoice_id'] === null && (int) ($r['product_is_group'] ?? 0) === 1) {
                $groupIds[] = (int) $r['product_id'];
            }
        }
        $items = ProductService::itemsOf($groupIds);

        return array_map(static fn ($r) => self::serialize($r, $items), $rows);
    }

    /**
     * @param array<int, list<array>>|null $itemsByGroup รายการย่อยปัจจุบันที่ดึงรวบไว้แล้ว (serializeMany) · null = ดึงเองถ้าจำเป็น
     */
    public static function serialize(array $row, ?array $itemsByGroup = null): array
    {
        /*
         * สินค้ากลุ่ม + รายการย่อยที่โชว์ใต้ชื่อสินค้า
         * อยู่ในบิลแล้ว → ตามที่จดไว้ตอนขึ้นบิลเท่านั้น (บิลต้องโชว์เหมือนวันที่ออก แม้ภายหลังแก้รายการย่อย
         *   หรือเปลี่ยนสินค้าเป็น/เลิกเป็นกลุ่ม) · ยังไม่ขึ้นบิล → ตามสินค้าตอนนี้
         * ร้านเห็นด้วย — เป็นสิ่งที่ร้านขายจริง
         */
        if ($row['invoice_id'] !== null || ($row['product_status'] ?? null) === 'DELETED') {
            // สินค้าที่ลบแล้วไม่มีรายการย่อยปัจจุบัน (ล้างตอนลบ) — ยอดที่กลับมายังไม่ขึ้นบิล (บิลเดิมถูกยกเลิก) ใช้ที่จดไว้ตอนออกบิลเดิม
            $components = self::billedComponents($row['components_snapshot'] ?? null);
            $isGroup    = $components !== null;
        } else {
            $productId = (int) $row['product_id'];
            $isGroup   = (int) ($row['product_is_group'] ?? Db::val('SELECT is_group FROM products WHERE id = ?', [$productId])) === 1;
            if ($isGroup) {
                $itemsByGroup ??= ProductService::itemsOf([$productId]);
            }
            $components = $isGroup
                ? array_map(static fn ($c) => ['sku' => $c['sku'], 'name' => $c['name']], $itemsByGroup[$productId] ?? [])
                : null;
        }

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
            // ยอดที่ใช้ออกบิลจริง (ตามวิธีคิดใน billMode)
            'commissionAmount'  => Money::toBaht($row['commission_amount_satang']),
            // PCT = ส่วนต่างคิดจาก % · MANUAL = ส่วนกลางกำหนดยอดเอง (% ด้านบนเป็นแค่ค่าเดิมที่เก็บไว้)
            // ห้ามใส่ข้อมูลค่าคอมเซลที่นี่ — ร้านเห็นบรรทัดบิลผ่านตัวนี้ (ค่าคอมอยู่ในบิลค่าคอมแยกต่างหาก)
            'billMode'          => $row['bill_mode'] ?? 'PCT',
            /*
             * สองตัวเลือกตอนออกบิล (R21) ให้หน้าเว็บโชว์คู่กันได้โดยไม่ต้องคิดเอง
             *   manualAmount = ยอดส่วนต่างที่กรอกไว้ที่หน้ายอดขาย (null = ไม่ได้กรอก) — ส่วนกลางเท่านั้น
             *                  InvoiceService::get ถอดออกจากบรรทัดบิลที่ร้านเห็น (ยอดที่ไม่ได้เลือกใช้ไม่ใช่เรื่องของร้าน)
             *   pctAmount    = ยอดที่ได้ถ้าเลือก "คิดจากยอดเต็ม × %" (ยอดเต็ม × % ที่เก็บไว้กับรายการ)
             */
            'manualAmount'      => ($row['manual_amount_satang'] ?? null) === null ? null : Money::toBaht($row['manual_amount_satang']),
            'pctAmount'         => Money::toBaht(Money::commissionOf((int) $row['gross_amount_satang'], (int) $row['commission_pct_bp'])),
            'isGroup'           => $isGroup,
            'components'        => $components ?? [],
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
