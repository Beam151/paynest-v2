<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\AuthContext;
use App\Libraries\Db;
use App\Libraries\Money;
use App\Libraries\Period;
use App\Libraries\SignedUrl;
use App\Libraries\Usd;
use Config\Paynest;
use Throwable;

/**
 * ใบเรียกเก็บ — 1 ร้าน 1 รอบ = ใบเดียว
 * ยอดที่ร้านต้องจ่าย = ส่วนต่าง + ค่าใช้จ่ายอื่น − ส่วนลด − ยอดยกมา
 */
final class InvoiceService
{
    private const SELECT_INVOICE = "
        SELECT i.*, f.username AS franchise_username,
               ba.bank_name, ba.account_name, ba.account_number, ba.branch AS bank_branch,
               ba.currency AS bank_currency, ba.qr_url AS bank_qr_url, ba.chain AS bank_chain,
               bp.code AS period_code, bp.start_date AS period_start, bp.end_date AS period_end,
               bp.usd_rate_satang AS period_usd_rate_satang,
               (SELECT COALESCE(SUM(fc.amount_satang), 0) FROM franchise_credits fc
                 WHERE fc.source_invoice_id = i.id AND fc.status <> 'CANCELLED') AS credit_created,
               (SELECT COUNT(*) FROM payment_submissions ps
                 WHERE ps.invoice_id = i.id AND ps.status = 'PENDING') AS pending_submissions,
               (SELECT COUNT(*) FROM sales_entries se
                 WHERE se.franchise_id = i.franchise_id AND se.period_id = i.period_id
                   AND se.status <> 'INVOICED') AS pending_entries,
               (SELECT COUNT(*) FROM invoice_attachments ia
                 WHERE ia.invoice_id = i.id AND ia.removed_at IS NULL) AS attachment_count,
               (SELECT COUNT(*) FROM invoice_adjustments iadj
                 WHERE iadj.invoice_id = i.id AND iadj.sales_commission_id IS NULL) AS adjustment_count,
               (SELECT COALESCE(SUM(sadj.amount_satang), 0) FROM invoice_adjustments sadj
                 WHERE sadj.invoice_id = i.id AND sadj.sales_commission_id IS NOT NULL) AS sales_deduction_satang
          FROM invoices i
          JOIN franchises f       ON f.id = i.franchise_id
          JOIN billing_periods bp ON bp.id = i.period_id
          LEFT JOIN bank_accounts ba ON ba.id = i.bank_account_id";

    private static function row(int $id): array
    {
        return Db::one('SELECT * FROM invoices WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบใบเรียกเก็บ');
    }

    /** รายการยอดขายที่ยังไม่ได้ขึ้นบิลของร้าน/รอบนั้น (+ sku ไว้ใช้ในข้อความ error รายสินค้า) */
    private static function pendingEntries(int $franchiseId, int $periodId): array
    {
        return Db::all(
            "SELECT se.*, p.sku FROM sales_entries se JOIN products p ON p.id = se.product_id
              WHERE se.franchise_id = ? AND se.period_id = ? AND se.status <> 'INVOICED'
              ORDER BY se.id",
            [$franchiseId, $periodId],
        );
    }

    /* ── คำนวณยอดรวมใหม่ทุกครั้งที่บิลเปลี่ยน ──────────────────── */

    /**
     * ยอดที่ต้องจ่ายจริง = ส่วนต่างจากยอดเต็ม + ค่าใช้จ่ายอื่น − ส่วนลด − ยอดยกมาจากรอบก่อน
     * เรียกซ้ำได้เสมอ และเป็นที่เดียวที่ตัดสินสถานะ OPEN/PARTIAL/PAID
     *
     * รอบไหนร้านคืนสินค้ามากกว่าขาย ยอดจะติดลบ = เราเป็นฝ่ายติดค้างร้าน
     * ไม่ได้โอนเงินคืน แต่จดเป็นเครดิตแล้วหักออกจากบิลรอบถัดไปให้เอง (ดู CreditService)
     */
    private static function recalc(int $invoiceId, ?array $user): int
    {
        $inv  = self::row($invoiceId);
        $sums = Db::one(
            "SELECT COALESCE(SUM(CASE WHEN kind = 'CHARGE'   THEN amount_satang ELSE 0 END), 0) AS charge,
                    COALESCE(SUM(CASE WHEN kind = 'DISCOUNT' THEN amount_satang ELSE 0 END), 0) AS discount
               FROM invoice_adjustments WHERE invoice_id = ?",
            [$invoiceId],
        );
        $charge   = (int) $sums['charge'];
        $discount = (int) $sums['discount'];

        /*
         * ตรวจก่อนแตะเครดิต เพื่อให้ error ไม่ทิ้งเครดิตค้างสถานะกลางทาง
         * ส่วนลดมากเกินยังเป็น error เพราะมันคือคนกรอกผิด ไม่ใช่ร้านคืนของ
         * ต่างจากส่วนต่างติดลบซึ่งเป็นเหตุการณ์ทางธุรกิจจริงที่ต้องยกยอดไป
         */
        $base = (int) $inv['commission_total_satang'] + $charge;
        if ($base >= 0 && $discount > $base) {
            // ค่าคอมเซลที่หักในบิล (R25) นับเป็นส่วนลดด้วย — บอกให้รู้ว่าตัวไหนทำให้เกิน ไม่งั้นคนกดไปไล่หาส่วนลดที่ไม่ได้ใส่
            $salesDeduction = Db::int('SELECT COALESCE(SUM(amount_satang), 0) FROM invoice_adjustments WHERE invoice_id = ? AND sales_commission_id IS NOT NULL', [$invoiceId]);

            throw ApiException::badRequest($salesDeduction > 0
                ? 'ค่าคอมเซลที่หัก (' . Money::fmtSatang($salesDeduction) . ' บาท) รวมกับส่วนลดอื่นแล้วมากกว่ายอดที่ร้านต้องจ่าย ('
                    . Money::fmtSatang($base) . ' บาท) — หักค่าคอมเซลจากบิลนี้ไม่ได้ ให้ทำบิลค่าคอมจ่ายเซลตามปกติแทน'
                : 'ส่วนลดรวมมากกว่ายอดที่ต้องจ่าย — ปรับส่วนลดลงก่อน');
        }
        if ($base < 0 && $discount > 0) {
            throw ApiException::badRequest(
                'รอบนี้ยอดติดลบอยู่แล้ว (' . Money::toBaht($base) . ' บาท — ร้านคืนมากกว่าที่ขายได้) '
                . 'ใส่ส่วนลดเพิ่มไม่ได้ ยอดทั้งก้อนจะถูกยกไปหักรอบหน้าให้อยู่แล้ว',
            );
        }

        // คิดใหม่จากเครดิตเต็มก้อนเสมอ — คืนของเก่าก่อน ไม่งั้นแก้บิลซ้ำจะหักซ้อนกัน
        CreditService::clearCreditsFrom($invoiceId);
        CreditService::releaseCreditsOf($invoiceId);

        $subtotal      = $base - $discount;
        $creditApplied = 0;
        if ($subtotal < 0) {
            // ติดค้างร้าน — รอบนี้ไม่ต้องเก็บอะไร แล้วยกทั้งก้อนไปหักรอบหน้า
            $net = 0;
            CreditService::create((int) $inv['franchise_id'], -$subtotal, $invoiceId, "ยอดติดลบจากบิล {$inv['invoice_no']}", isset($user['id']) ? (int) $user['id'] : null);
        } else {
            $creditApplied = CreditService::applyCreditsTo($invoiceId, (int) $inv['franchise_id'], $subtotal);
            $net           = $subtotal - $creditApplied;
        }

        $paid = Db::int('SELECT COALESCE(SUM(amount_satang), 0) FROM invoice_payments WHERE invoice_id = ?', [$invoiceId]);
        if ($paid > $net) {
            throw ApiException::badRequest('แก้ไม่ได้: ยอดที่ชำระแล้ว ' . Money::toBaht($paid) . ' บาท จะเกินยอดใหม่ ' . Money::toBaht($net) . ' บาท');
        }
        $status = $inv['status'] === 'VOID' ? 'VOID' : ($paid >= $net ? 'PAID' : ($paid === 0 ? 'OPEN' : 'PARTIAL'));

        Db::exec(
            'UPDATE invoices
                SET charge_total_satang = ?, discount_total_satang = ?, net_total_satang = ?,
                    credit_applied_satang = ?, paid_satang = ?, status = ?,
                    paid_at = CASE WHEN ? = \'PAID\' THEN COALESCE(paid_at, UTC_TIMESTAMP()) ELSE NULL END,
                    updated_at = UTC_TIMESTAMP()
              WHERE id = ?',
            [$charge, $discount, $net, $creditApplied, $paid, $status, $status, $invoiceId],
        );

        return $net;
    }

    /* ── ภาพรวมการออกบิลของรอบ (ออกทีละหลายร้าน) ───────────────────── */

    /**
     * แต่ละร้านในรอบนี้อยู่ขั้นไหน — ใช้หน้า "พร้อมออกบิล" และหน้าภาพรวม
     * ยอดที่ยังไม่ขึ้นบิล (pendingCommission) เป็นยอดที่ใช้ออกบิลจริงของแต่ละรายการ — รายการที่กรอกยอดส่วนต่างไว้ใช้ยอดนั้น (manualCount)
     *   NO_SALES   มีสินค้าต้องขายในรอบนี้ แต่ยังไม่มีการกรอกยอด
     *   READY      กรอกยอดแล้ว ยังไม่ได้ออกบิล
     *   INVOICED   ออกบิลแล้ว (addedLater = มียอดกรอกเพิ่มทีหลังที่ยังไม่ได้เพิ่มเข้าบิล)
     * ร้านที่ไม่มีสินค้าในรอบนี้และไม่มีข้อมูลเลยไม่ต้องขึ้น — ไม่มีอะไรต้องทำ
     */
    public static function readiness(string $periodCode): array
    {
        $p   = Period::fromCode($periodCode);
        $pid = (int) (Db::val('SELECT id FROM billing_periods WHERE code = ?', [$p['code']]) ?? -1);

        // "มีสินค้าต้องขาย" นับเฉพาะสินค้าที่ยังใช้งาน — ร้านที่เหลือแต่สินค้าปิดใช้งานกรอกยอดไม่ได้แล้ว ห้ามค้างเป็น "ยังไม่กรอกยอด"
        $rows = Db::all(
            "SELECT f.id, f.username,
                    (SELECT COUNT(*) FROM sales_entries se
                      WHERE se.franchise_id = f.id AND se.period_id = ? AND se.status <> 'INVOICED') AS pending_entries,
                    (SELECT COALESCE(SUM(se.commission_amount_satang), 0) FROM sales_entries se
                      WHERE se.franchise_id = f.id AND se.period_id = ? AND se.status <> 'INVOICED') AS pending_commission,
                    (SELECT COALESCE(SUM(se.gross_amount_satang), 0) FROM sales_entries se
                      WHERE se.franchise_id = f.id AND se.period_id = ? AND se.status <> 'INVOICED') AS pending_gross,
                    (SELECT COUNT(*) FROM sales_entries se
                      WHERE se.franchise_id = f.id AND se.period_id = ? AND se.status <> 'INVOICED'
                        AND se.bill_mode = 'MANUAL' AND se.manual_amount_satang IS NOT NULL
                        AND se.commission_amount_satang = se.manual_amount_satang) AS manual_entries,
                    i.id AS invoice_id, i.invoice_no, i.net_total_satang,
                    (SELECT COUNT(*) FROM product_assignments a
                       JOIN products p ON p.id = a.product_id AND p.status = 'ACTIVE'
                      WHERE a.franchise_id = f.id AND a.start_date <= ? AND (a.end_date IS NULL OR a.end_date >= ?)) AS assigned
               FROM franchises f
               LEFT JOIN invoices i ON i.franchise_id = f.id AND i.period_id = ? AND i.status <> 'VOID'
              WHERE f.status = 'ACTIVE'
              ORDER BY f.username",
            [$pid, $pid, $pid, $pid, $p['endDate'], $p['startDate'], $pid],
        );

        $items = [];
        foreach ($rows as $r) {
            $pending = (int) $r['pending_entries'];
            $status  = $r['invoice_id'] ? 'INVOICED' : ($pending > 0 ? 'READY' : 'NO_SALES');
            $item    = [
                'franchiseId'       => (int) $r['id'],
                'username'          => $r['username'],
                'status'            => $status,
                'pendingEntries'    => $pending,
                'pendingCommission' => Money::toBaht((int) $r['pending_commission']),
                'pendingGross'      => Money::toBaht((int) $r['pending_gross']),
                // รายการที่ยังไม่ขึ้นบิลซึ่งจะใช้ "ยอดส่วนต่างที่กรอกไว้" ที่หน้ายอดขาย (R21) — หน้าออกบิลหลายร้านใช้บอกผู้ใช้
                // pendingCommission ด้านบนรวมยอดพวกนี้แล้ว (เป็นยอดที่ใช้ออกบิลจริง)
                'manualCount'       => (int) $r['manual_entries'],
                'invoiceId'         => $r['invoice_id'] === null ? null : (int) $r['invoice_id'],
                'invoiceNo'         => $r['invoice_no'] ?? null,
                'invoiceNetTotal'   => $r['invoice_id'] ? Money::toBaht($r['net_total_satang']) : null,
                'addedLater'        => (bool) $r['invoice_id'] && $pending > 0,
                'assigned'          => (int) $r['assigned'] > 0,
            ];
            if ($item['assigned'] || $status !== 'NO_SALES') {
                $items[] = $item;
            }
        }
        $count = static fn (string $status) => count(array_filter($items, static fn ($r) => $r['status'] === $status));

        return [
            'periodCode' => $p['code'],
            'items'      => $items,
            'summary'    => [
                'ready'      => $count('READY'),
                'invoiced'   => $count('INVOICED'),
                'noSales'    => $count('NO_SALES'),
                'addedLater' => count(array_filter($items, static fn ($r) => $r['addedLater'])),
            ],
        ];
    }

    /**
     * ออกบิลหลายร้านในครั้งเดียว — แต่ละร้านแยกกัน ร้านไหนติดปัญหา ร้านอื่นยังออกได้
     * ใช้ค่าตั้งต้นทั้งหมด (บัญชีหลัก บาท ครบกำหนดตามรอบ) — ร้านที่ต้องใส่ส่วนลดค่อยแก้บิลทีหลัง
     */
    public static function generateBulk(array $input, array $user): array
    {
        $created = [];
        $errors  = [];
        foreach (array_values(array_unique(array_map('intval', $input['franchiseIds']))) as $franchiseId) {
            try {
                $inv       = self::generate(['franchiseId' => $franchiseId, 'periodCode' => $input['periodCode'], 'dueDate' => $input['dueDate'] ?? null], $user);
                $created[] = [
                    'franchiseId' => $franchiseId,
                    'invoiceId'   => $inv['id'],
                    'invoiceNo'   => $inv['invoiceNo'],
                    'netTotal'    => $inv['netTotal'],
                    'dueDate'     => $inv['dueDate'],
                    'periodCode'  => $inv['periodCode'],
                ];
            } catch (Throwable $e) {
                $f        = Db::one('SELECT username FROM franchises WHERE id = ?', [$franchiseId]);
                $errors[] = [
                    'franchiseId' => $franchiseId,
                    'username'    => $f['username'] ?? (string) $franchiseId,
                    'message'     => $e instanceof ApiException ? $e->getMessage() : (Db::isConstraintError($e) ? 'ข้อมูลขัดกับข้อกำหนดของระบบ' : 'เกิดข้อผิดพลาดภายในระบบ'),
                ];
            }
        }

        return ['created' => $created, 'errors' => $errors];
    }

    /* ── ออกใบเรียกเก็บ ─────────────────────────────────────────── */

    public static function generate(array $input, array $user): array
    {
        $period    = PeriodService::getByCode($input['periodCode']);
        $franchise = Db::one('SELECT * FROM franchises WHERE id = ?', [(int) $input['franchiseId']]) ?? throw ApiException::notFound('ไม่พบร้านค้า');
        $currency  = $input['currency'] ?? 'THB';
        // ลบได้เฉพาะตอนไม่มียอดค้างออกบิล และหลังลบก็บันทึกยอดใหม่ไม่ได้ — มาถึงตรงนี้ได้แค่จากหน้าเว็บที่ค้างของเก่า
        self::assertShopNotDeleted($franchise);

        // 1 ร้าน / 1 รอบบิล = ใบเดียว — รายการที่ยังไม่ได้เรียกเก็บให้เพิ่มเข้าใบเดิมแทน
        $active = Db::one("SELECT * FROM invoices WHERE franchise_id = ? AND period_id = ? AND status <> 'VOID' LIMIT 1", [$franchise['id'], $period['id']]);
        if ($active !== null) {
            throw ApiException::conflict(
                "ร้าน {$franchise['username']} ออกใบเรียกเก็บของรอบ {$period['code']} ไปแล้ว ({$active['invoice_no']}) — "
                . 'หนึ่งรอบบิลออกได้ใบเดียว ถ้ามีรายการตกหล่นให้กด "เพิ่มรายการเข้าบิล" ที่ใบเดิม '
                . 'หรือยกเลิกใบเดิมก่อนแล้วออกใหม่',
            );
        }

        /*
         * สกุลเงินที่ให้ร้านจ่าย — ยอดในฐานข้อมูลยังเป็นบาทเสมอ
         * ตัวนี้บอกแค่ว่าจะให้ร้านเห็นและโอนเป็นสกุลไหน แล้วแปลงด้วยอัตราที่ตรึงไว้
         * บิลดอลลาร์ที่ไม่มีอัตราแปลงไม่ได้ จึงต้องกันไว้ตั้งแต่ต้น
         */
        if (! in_array($currency, ['THB', 'USD'], true)) {
            throw ApiException::badRequest('currency: ต้องเป็น THB หรือ USD');
        }
        if ($currency === 'USD' && ! $period['usd_rate_satang']) {
            throw ApiException::badRequest("รอบ {$period['code']} ยังไม่ได้ตั้งอัตราแลกเปลี่ยน — ออกบิลเป็นดอลลาร์ไม่ได้ ให้ตั้งอัตราที่แถบรอบบิลก่อน");
        }

        // ไม่ได้เลือกมา = ใช้บัญชีหลักที่รับสกุลเดียวกับบิล (ยังไม่มีบัญชีเลยก็ปล่อยว่างไว้ได้ ค่อยไปเพิ่มทีหลัง)
        $bankAccount = ($input['bankAccountId'] ?? null) === null
            ? BankAccountService::defaultId($currency)
            : BankAccountService::assertUsable((int) $input['bankAccountId'], $currency);

        // ยอดที่บันทึกแล้วพร้อมเรียกเก็บทันที ไม่ต้องรออนุมัติซ้ำ
        $available = self::pendingEntries((int) $franchise['id'], (int) $period['id']);
        if ($available === []) {
            $existing = array_column(Db::all("SELECT invoice_no FROM invoices WHERE franchise_id = ? AND period_id = ? AND status <> 'VOID' ORDER BY id", [$franchise['id'], $period['id']]), 'invoice_no');

            throw ApiException::badRequest($existing
                ? "ออกใบเรียกเก็บของรอบ {$period['code']} ครบแล้ว (" . implode(', ', $existing) . ') — ไม่มียอดที่ยังไม่ได้เรียกเก็บเหลืออยู่'
                : "ยังไม่มียอดขายที่บันทึกไว้ในรอบ {$period['code']} — ไปกรอกยอดที่หน้า \"ยอดขายรายรอบ\" ก่อน");
        }

        // เลือกเฉพาะบางรายการได้ — ที่ไม่ได้เลือกยังคงรออกใบถัดไปได้
        $entries = $available;
        if (array_key_exists('entryIds', $input)) {
            $wanted = array_values(array_unique(array_map('intval', $input['entryIds'])));
            if ($wanted === []) {
                throw ApiException::badRequest('ต้องเลือกอย่างน้อยหนึ่งรายการที่จะเรียกเก็บ');
            }
            $byId    = array_column($available, null, 'id');
            $missing = array_values(array_filter($wanted, static fn ($id) => ! isset($byId[$id])));
            if ($missing !== []) {
                throw ApiException::badRequest("รายการที่เลือกบางรายการไม่อยู่ในรอบ {$period['code']} ของร้านนี้ หรือออกบิลไปแล้ว (id: " . implode(', ', $missing) . ')');
            }
            $entries = array_map(static fn ($id) => $byId[$id], $wanted);
        }

        /*
         * วิธีคิดยอดรายบรรทัด (กรอกยอดเอง / คิดตาม %) ตรวจให้ครบก่อนเปิด transaction
         * ยอดรวมต้องมาจากยอดที่ "ใช้จริง" หลังเลือกวิธีคิดแล้ว — ค่าใช้จ่าย % ที่แนบมาตอนออกบิลคิดจากก้อนนี้
         * บรรทัดที่ไม่ได้ส่งมาใช้ค่าที่เก็บไว้กับรายการ — ค่าตั้งต้นจากหน้ายอดขาย (กรอกยอดส่วนต่างไว้ = ใช้ยอดนั้น
         * ไม่ได้กรอก = คิดตาม %) หรือค่าที่เลือกไว้ก่อนยกเลิกบิลใบเดิม · ออกบิลหลายร้าน (generateBulk) จึงใช้ยอดที่กรอกไว้ให้เอง
         */
        $plan            = self::planLineModes(array_column($entries, null, 'id'), $input['lines'] ?? []);
        $effective       = $plan['entries'];
        $grossTotal      = array_sum(array_map(static fn ($e) => (int) $e['gross_amount_satang'], $effective));
        $commissionTotal = array_sum(array_map(static fn ($e) => (int) $e['commission_amount_satang'], $effective));
        $due             = ! empty($input['dueDate'])
            ? Period::assertDate($input['dueDate'], 'dueDate')
            : Period::addDays($period['end_date'], config(Paynest::class)->invoiceDueDays);
        $invoiceNo   = self::nextInvoiceNo($period['code'], $franchise['username']);
        $adjustments = $input['adjustments'] ?? [];
        $attachments = InvoiceAttachmentService::prepare(null, $input['attachments'] ?? []);
        $deductions  = self::uniqueSalesDeductions($input['salesDeductions'] ?? []);

        /*
         * ออกบิลร้านไม่สร้างค่าคอมเซลเอง — ส่วนกลางทำ "บิลค่าคอม" ให้เซลทีหลัง โดยติ๊กเลือกบรรทัดจากบิลร้านที่ออกไปแล้ว
         * (SalesAgentService::createCommissionBill) เจ้าของระบบ: แต่ละรอบจ่ายค่าคอมไม่เหมือนกัน
         * ยกเว้นเซลที่ติ๊ก "หักค่าคอมเซล" มา (salesDeductions · R25): ร้านเป็นคนจ่ายเซลเอง จึงหักออกจากบิลนี้และทำบิลค่าคอมสถานะจ่ายแล้วให้เลย
         */
        return Db::tx(static function () use ($invoiceNo, $franchise, $period, $grossTotal, $commissionTotal, $due, $input, $bankAccount, $currency, $user, $entries, $adjustments, $plan, $attachments, $deductions) {
            $invoiceId = Db::insert(
                'INSERT INTO invoices
                   (invoice_no, franchise_id, period_id, gross_total_satang, commission_total_satang,
                    net_total_satang, due_date, note, bank_account_id, usd_rate_satang, currency,
                    created_by_user_id, issued_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())',
                [
                    $invoiceNo, $franchise['id'], $period['id'], $grossTotal, $commissionTotal, $commissionTotal,
                    $due, $input['note'] ?? null, $bankAccount, $period['usd_rate_satang'] ?? null, $currency, $user['id'],
                ],
            );
            foreach ($entries as $e) {
                Db::exec("UPDATE sales_entries SET status = 'INVOICED', invoice_id = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", [$invoiceId, $e['id']]);
            }
            // สินค้ากลุ่ม: จดว่าในชุดมีอะไร ณ วันที่ออกบิล — แก้รายการย่อยทีหลังบิลใบนี้ไม่เปลี่ยน
            SalesService::snapshotComponents($entries);
            self::writeLineModes($plan['changes'], (int) $user['id']);

            /*
             * ค่าใช้จ่ายอื่น/ส่วนลดที่แนบมาพร้อมตอนออกบิล — คิด % จากยอดที่ใช้จริงแล้ว
             * ไม่ใช้ refreshTotals ที่นี่ เพราะมันคิด % ใหม่ทับจำนวนเงินที่พิมพ์มาพร้อม % ตอนออกบิล
             */
            foreach ($adjustments as $adj) {
                self::insertAdjustment($invoiceId, $commissionTotal, $adj, $user);
            }
            // หลังรายการขึ้นบิลแล้ว — ค่าคอมที่หักคิดจากรายการของบิลใบนี้จริง ๆ (ตัวเดียวกับที่บิลค่าคอมล็อกไว้)
            $deducted = self::applySalesDeductions(
                ['id' => $invoiceId, 'invoice_no' => $invoiceNo, 'franchise_id' => (int) $franchise['id'], 'period_id' => (int) $period['id']],
                $deductions,
                $user,
            );
            self::recalc($invoiceId, $user);

            InvoiceAttachmentService::insert($invoiceId, $attachments, (int) $user['id']);

            Audit::write((int) $user['id'], 'invoice.create', 'invoice', $invoiceId, [
                'invoiceNo'   => $invoiceNo,
                'lines'       => count($entries),
                'adjustments' => count($adjustments),
                'lineModes'   => $plan['audit'],
                'attachments' => ['count' => count($attachments), 'urls' => array_column($attachments, 'url')],
                ...($deducted !== [] ? ['salesDeductions' => $deducted] : []),
            ]);

            return self::get($invoiceId, $user);
        });
    }

    /**
     * เพิ่มรายการยอดขายที่ยังไม่ได้เรียกเก็บเข้าใบเดิมของรอบนั้น
     *
     * มีเพราะหนึ่งรอบบิลออกได้ใบเดียว — ถ้ากรอกยอดเพิ่มทีหลังหรือตอนออกบิลไม่ได้ติ๊กครบ
     * รายการที่เหลือต้องมีทางขึ้นบิล ไม่งั้นจะค้างเก็บเงินไม่ได้ตลอดไป
     * ค่าใช้จ่าย/ส่วนลดที่คิดเป็น % ถูกคำนวณใหม่ตามส่วนต่างก้อนใหม่
     * เลือกวิธีคิดยอด (lines) ของรายการที่กำลังเพิ่มได้ เหมือนตอนออกบิล
     * รายการที่เพิ่มเข้ามาไปโผล่ในหน้า "ทำบิลค่าคอม" ของเซลที่ถือดีลเอง — ไม่มีค่าคอมเกิดตรงนี้
     */
    public static function addEntries(int $invoiceId, ?array $entryIds, array $user, array $lines = []): array
    {
        // ตรวจรอบแรกนอกทรานแซกชัน = ตอบ error ได้ทันทีไม่ต้องรอล็อก · ตัวที่ตัดสินจริงคือรอบหลังล็อกบิลข้างล่าง
        $inv = self::row($invoiceId);
        self::assertEditable($inv);
        self::planLineModes(array_column(self::pickPending($inv, $entryIds), null, 'id'), $lines);

        return Db::tx(static function () use ($invoiceId, $entryIds, $user, $lines) {
            /*
             * ล็อกบิลก่อน แล้วเลือกรายการ/คิดยอดใหม่จากข้อมูลหลังได้ล็อก — อีกจอที่เพิ่มรายการเดียวกันเข้าบิลนี้
             * commit ไปแล้วก็เห็น (ไม่งั้นรายการเดียวถูกนับสองครั้ง หรือยอดรวมทับกันเหลือของจอเดียว)
             */
            $inv    = self::lockEditable($invoiceId);
            $picked = self::pickPending($inv, $entryIds);
            $plan   = self::planLineModes(array_column($picked, null, 'id'), $lines);
            foreach ($picked as $e) {
                // บิลใบอื่น (ออกบิลใหม่ของรอบเดียวกัน) ไม่ได้ล็อกบิลใบนี้ — กันรายการที่เพิ่งขึ้นบิลอื่นไปแล้วถูกย้ายมาเงียบ ๆ
                $moved = Db::exec(
                    "UPDATE sales_entries SET status = 'INVOICED', invoice_id = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND status <> 'INVOICED'",
                    [$invoiceId, $e['id']],
                );
                if ($moved !== 1) {
                    throw ApiException::conflict("รายการ {$e['sku']} เพิ่งถูกออกบิลไปแล้ว — โหลดหน้าใหม่แล้วลองอีกครั้ง");
                }
            }
            SalesService::snapshotComponents($picked); // เหมือนตอนออกบิล — จดรายการย่อยของสินค้ากลุ่ม ณ ตอนเพิ่มเข้าบิล
            self::writeLineModes($plan['changes'], (int) $user['id']);

            // รวมยอดใหม่จากรายการในบิลทั้งหมด (ไม่บวกต่อจากยอดเดิม) — % ค่าใช้จ่ายเดินตามส่วนต่างก้อนใหม่ในนั้นด้วย
            self::refreshTotals($invoiceId, $user);

            $fresh = self::row($invoiceId);
            Audit::write((int) $user['id'], 'invoice.add_lines', 'invoice', $invoiceId, [
                'added'      => count($picked),
                'gross'      => (int) $fresh['gross_total_satang'],
                'commission' => (int) $fresh['commission_total_satang'],
                'lineModes'  => $plan['audit'],
            ]);

            return self::get($invoiceId, $user);
        });
    }

    /**
     * แก้วิธีคิดยอดของบรรทัดเดียวในบิลที่ยังแก้ได้ (ยังไม่มีเงินเข้า · ไม่มีสลิปรอตรวจ · ไม่ถูกยกเลิก)
     * บรรทัดต้องเป็นของบิลใบนี้จริง — ไม่งั้นแค่ใส่ id บิลที่แก้ได้ ก็เอื้อมไปแก้บรรทัดของบิลที่จ่ายแล้วได้
     */
    public static function updateLine(int $invoiceId, int $entryId, array $input, array $user): array
    {
        self::assertEditable(self::row($invoiceId));

        return Db::tx(static function () use ($invoiceId, $entryId, $input, $user) {
            // ล็อกบิลก่อนแตะบรรทัด — สองจอแก้คนละบรรทัดของบิลเดียวพร้อมกัน ยอดรวมต้องรวมของทั้งสองจอ (ดู lockEditable)
            self::lockEditable($invoiceId);
            $entry = Db::one(
                'SELECT se.*, p.sku FROM sales_entries se JOIN products p ON p.id = se.product_id
                  WHERE se.id = ? AND se.invoice_id = ? FOR UPDATE',
                [$entryId, $invoiceId],
            ) ?? throw ApiException::notFound('ไม่พบรายการนี้ในบิล');

            $plan = self::planLineModes([$entryId => $entry], [['entryId' => $entryId, ...$input]]);
            if ($plan['changes'] === []) {
                return self::get($invoiceId, $user); // ค่าเดิมทุกอย่าง ไม่ต้องคิดใหม่หรือจดประวัติ
            }
            /*
             * ไม่แตะบิลค่าคอมเซล — ค่าคอมคิดจากยอดขายเต็ม (ไม่ใช่ส่วนต่างที่แก้ตรงนี้) และบรรทัดในบิลค่าคอมเก็บยอดเต็มไว้แล้ว
             * ยอดเต็มของบรรทัดที่อยู่ในบิลร้านแก้ไม่ได้อยู่แล้ว (ต้องยกเลิกบิลร้านก่อน)
             */
            self::writeLineModes($plan['changes'], (int) $user['id']);
            self::refreshTotals($invoiceId, $user);

            Audit::write((int) $user['id'], 'invoice.line.update', 'invoice', $invoiceId, $plan['audit'][0]);

            return self::get($invoiceId, $user);
        });
    }

    /* ── วิธีคิดยอดรายบรรทัด (กรอกยอดเอง / คิดตาม %) ─────────────────── */

    /**
     * ตรวจและคิดยอดของแต่ละบรรทัดตามวิธีที่เลือก — ยังไม่เขียนอะไรลงฐานข้อมูล
     * แยกตัวคิดกับตัวเขียน เพื่อให้ตรวจ input ครบทุกบรรทัดก่อนเปิด transaction
     * และให้ generate เอายอดที่ใช้จริงไปตั้งยอดรวมได้ตั้งแต่ INSERT แรก
     *
     *   PCT     ส่วนต่าง = ยอดเต็ม × % (ไม่ส่ง % = ใช้ % ที่เก็บไว้กับรายการ)
     *   MANUAL  ส่วนต่าง = จำนวนที่กรอก · % เดิมเก็บไว้เฉย ๆ เป็นข้อมูลประกอบ
     *           ไม่ส่งจำนวนเงิน = ใช้ "ยอดส่วนต่างที่กรอกเอง" ที่กรอกไว้ที่หน้ายอดขาย (R21) · ไม่มีที่กรอกไว้ = 400
     * เลือกวิธีคิดตรงนี้ไม่แตะ manual_amount_satang — นั่นคือค่าของหน้ายอดขาย ตรงนี้ตั้งแค่ยอดที่ใช้ออกบิล
     *
     * @param array<int, array>                                                     $entriesById แถว sales_entries (+ sku) ของบรรทัดที่กำลังออกบิล/แก้
     * @param list<array{entryId: int, mode: string, pct?: mixed, amount?: mixed}> $lines
     *
     * @return array{entries: array<int, array>, changes: list<array>, audit: list<array>}
     */
    private static function planLineModes(array $entriesById, array $lines): array
    {
        $entries = $entriesById;
        $changes = [];
        $audit   = [];
        $seen    = [];
        foreach ($lines as $line) {
            $id = (int) $line['entryId'];
            if (! isset($entries[$id])) {
                throw ApiException::badRequest("รายการ id {$id} ไม่ได้อยู่ในรายการที่เลือกออกบิล");
            }
            if (isset($seen[$id])) {
                throw ApiException::badRequest("รายการ id {$id} ถูกส่งมาซ้ำ — แต่ละบรรทัดเลือกวิธีคิดยอดได้ครั้งเดียว");
            }
            $seen[$id] = true;
            $e         = $entries[$id];
            $sku       = $e['sku'] ?? "id {$id}";
            $gross     = (int) $e['gross_amount_satang'];
            $mode      = $line['mode'];
            $pctBp     = (int) $e['commission_pct_bp'];

            if ($mode === 'PCT') {
                if (array_key_exists('amount', $line)) {
                    throw ApiException::badRequest("สินค้า {$sku}: เลือก \"คิดตาม %\" ไม่ต้องใส่จำนวนเงิน — ถ้าจะกำหนดยอดเองให้เลือก \"กรอกยอดเอง\"");
                }
                if (array_key_exists('pct', $line)) {
                    $pctBp = Money::pctToBp($line['pct'], "pct (สินค้า {$sku})");
                }
                $amount = Money::commissionOf($gross, $pctBp);
            } elseif ($mode === 'MANUAL') {
                if (array_key_exists('pct', $line)) {
                    throw ApiException::badRequest("สินค้า {$sku}: เลือก \"กรอกยอดเอง\" ไม่ต้องใส่ % — ใส่แค่จำนวนเงินที่เรียกเก็บ");
                }
                $preset = ($e['manual_amount_satang'] ?? null) === null ? null : (int) $e['manual_amount_satang'];
                if (array_key_exists('amount', $line)) {
                    $amount = SalesService::manualSatang($line['amount'], $sku, 'จำนวนเงิน', "amount (สินค้า {$sku})");
                } elseif ($preset !== null) {
                    $amount = $preset; // ยอดส่วนต่างที่กรอกไว้ที่หน้ายอดขาย
                } else {
                    throw ApiException::badRequest("สินค้า {$sku}: เลือก \"กรอกยอดเอง\" ต้องใส่จำนวนเงิน");
                }
                /*
                 * ยอดที่กรอกต้องอยู่ระหว่าง 0 ถึงยอดเต็ม และเครื่องหมายเดียวกับยอดเต็ม (SalesService::manualFits)
                 * กันพิมพ์ "-" หลงบนบรรทัดขายปกติ — ยอดบิลติดลบกลายเป็นเครดิตที่เราติดค้างร้านจริง ๆ
                 * และพอเครดิตถูกหักไปใช้ บิลใบนี้จะแก้/ยกเลิกไม่ได้อีก
                 */
                if (! SalesService::manualFits($amount, $gross)) {
                    throw ApiException::badRequest("สินค้า {$sku}: ยอดที่เรียกเก็บต้องอยู่ระหว่าง 0 ถึงยอดเงินเต็ม (" . Money::fmtSatang($gross) . ' บาท)');
                }
            } else {
                throw ApiException::badRequest("สินค้า {$sku}: วิธีคิดยอดต้องเป็น PCT หรือ MANUAL");
            }

            $from = (int) $e['commission_amount_satang'];
            if ($mode === ($e['bill_mode'] ?? 'PCT') && $pctBp === (int) $e['commission_pct_bp'] && $amount === $from) {
                continue; // ค่าเดิม — ไม่ต้องเขียนหรือจดประวัติ
            }
            $changes[] = ['id' => $id, 'bill_mode' => $mode, 'commission_pct_bp' => $pctBp, 'commission_amount_satang' => $amount];
            $audit[]   = [
                'entryId'    => $id,
                'sku'        => $sku,
                'mode'       => $mode,
                'fromMode'   => $e['bill_mode'] ?? 'PCT',
                'pctBp'      => $mode === 'PCT' ? $pctBp : null,
                'amount'     => Money::toBaht($amount),
                'fromAmount' => Money::toBaht($from),
                // ใช้ยอดส่วนต่างที่กรอกไว้ที่หน้ายอดขาย (ไม่ได้พิมพ์จำนวนเงินมาตอนออกบิล/แก้บรรทัด)
                'preset'     => $mode === 'MANUAL' && ! array_key_exists('amount', $line),
            ];
            $entries[$id] = [...$e, 'bill_mode' => $mode, 'commission_pct_bp' => $pctBp, 'commission_amount_satang' => $amount];
        }

        return ['entries' => $entries, 'changes' => $changes, 'audit' => $audit];
    }

    /** เขียนผลของ planLineModes — เรียกภายใน transaction เท่านั้น */
    private static function writeLineModes(array $changes, int $actorUserId): void
    {
        foreach ($changes as $c) {
            Db::exec(
                'UPDATE sales_entries
                    SET bill_mode = ?, commission_pct_bp = ?, commission_amount_satang = ?,
                        updated_by_user_id = ?, updated_at = UTC_TIMESTAMP()
                  WHERE id = ?',
                [$c['bill_mode'], $c['commission_pct_bp'], $c['commission_amount_satang'], $actorUserId, $c['id']],
            );
        }
    }

    /**
     * รวมยอดเต็ม/ส่วนต่างของบิลใหม่จากรายการในบิลทั้งหมด แล้วคิดยอดสุทธิใหม่
     * ใช้หลังรายการในบิลเปลี่ยน (เพิ่มรายการ · แก้วิธีคิดยอด)
     *
     * ค่าใช้จ่าย/ส่วนลดที่ตั้งเป็น % ถูกคิดใหม่จากส่วนต่างก้อนใหม่ทุกแถว — รวมแถวที่ตอนเพิ่มพิมพ์จำนวนเงินมาพร้อม %
     * (ทับจำนวนที่พิมพ์ แบบเดียวกับการเพิ่มรายการที่ทำมาแต่เดิม)
     * รอบที่ส่วนต่างติดลบ % ของมันเป็น 0 — ค่าใช้จ่าย/ส่วนลดติดลบไม่มีความหมาย (และฐานข้อมูลไม่รับ)
     */
    private static function refreshTotals(int $invoiceId, ?array $user): void
    {
        $sums = Db::one(
            'SELECT COALESCE(SUM(gross_amount_satang), 0) AS gross, COALESCE(SUM(commission_amount_satang), 0) AS commission
               FROM sales_entries WHERE invoice_id = ?',
            [$invoiceId],
        );
        $gross      = (int) $sums['gross'];
        $commission = (int) $sums['commission'];
        Db::exec('UPDATE invoices SET gross_total_satang = ?, commission_total_satang = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [$gross, $commission, $invoiceId]);

        foreach (Db::all('SELECT id, pct_bp FROM invoice_adjustments WHERE invoice_id = ? AND pct_bp IS NOT NULL', [$invoiceId]) as $a) {
            Db::exec('UPDATE invoice_adjustments SET amount_satang = ? WHERE id = ?', [max(0, Money::commissionOf($commission, (int) $a['pct_bp'])), $a['id']]);
        }
        self::recalc($invoiceId, $user);
    }

    private static function nextInvoiceNo(string $periodCode, string $franchiseUsername): string
    {
        $base  = 'INV-' . str_replace('-', '', $periodCode) . "-{$franchiseUsername}";
        $taken = Db::int('SELECT COUNT(*) FROM invoices WHERE invoice_no LIKE ?', [self::likePrefix($base)]);

        return $taken === 0 ? $base : "{$base}-R{$taken}";
    }

    /** LIKE 'prefix%' โดย escape % _ \ ในชื่อร้าน (ชื่อร้านมี _ ได้) */
    private static function likePrefix(string $prefix): string
    {
        return addcslashes($prefix, '\\%_') . '%';
    }

    /* ── ค่าใช้จ่ายอื่น / ส่วนลด ─────────────────────────────────── */

    /**
     * แปลง input หนึ่งรายการเป็นแถวใน invoice_adjustments
     * - อ้าง chargeItemId เพื่อดึงชื่อ/ค่าตั้งต้นจากรายการตั้งต้น หรือพิมพ์ label เองก็ได้
     * - ระบุ pct = คิดเป็น % ของส่วนต่างในรอบนั้น (เก็บทั้ง % และจำนวนเงินที่คำนวณได้)
     */
    private static function insertAdjustment(int $invoiceId, int $commissionTotal, array $input, array $user): int
    {
        $kind   = $input['kind'] ?? null;
        $label  = $input['label'] ?? null;
        $pctBp  = ($input['pct'] ?? null) === null ? null : Money::pctToBp($input['pct'], 'pct');
        $satang = ($input['amount'] ?? null) === null ? null : Money::toSatang($input['amount'], 'amount');

        if (! empty($input['chargeItemId'])) {
            $item = Db::one('SELECT * FROM charge_items WHERE id = ?', [(int) $input['chargeItemId']])
                ?? throw ApiException::notFound("ไม่พบรายการค่าใช้จ่าย id {$input['chargeItemId']}");
            $kind = $item['kind'];
            $label ??= $item['name'];
            if ($pctBp === null && $satang === null) {
                $pctBp  = $item['default_pct_bp'] === null ? null : (int) $item['default_pct_bp'];
                $satang = $item['default_amount_satang'] === null ? null : (int) $item['default_amount_satang'];
            }
        }
        if (! in_array($kind, ['CHARGE', 'DISCOUNT'], true)) {
            throw ApiException::badRequest('kind: ต้องเป็น CHARGE หรือ DISCOUNT');
        }
        if (! $label) {
            throw ApiException::badRequest('ต้องระบุชื่อรายการ (label) หรือเลือก chargeItemId');
        }
        if ($pctBp !== null && $satang === null) {
            $satang = Money::commissionOf($commissionTotal, $pctBp);
        }
        if ($satang === null) {
            throw ApiException::badRequest("รายการ \"{$label}\": ต้องระบุจำนวนเงินหรือเปอร์เซ็นต์");
        }
        if ($satang < 0) {
            throw ApiException::badRequest("รายการ \"{$label}\": จำนวนเงินต้องไม่ติดลบ");
        }

        return Db::insert(
            'INSERT INTO invoice_adjustments (invoice_id, charge_item_id, kind, label, pct_bp, amount_satang, note, created_by_user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
            [$invoiceId, ! empty($input['chargeItemId']) ? (int) $input['chargeItemId'] : null, $kind, $label, $pctBp, $satang, $input['note'] ?? null, $user['id']],
        );
    }

    /**
     * ล็อกหัวบิลเป็นคำสั่งแรกของทรานแซกชันที่แก้ยอด แล้วตรวจว่ายังแก้ได้จากแถวที่ล็อกแล้ว — ใช้กับทุกทางที่เรียก refreshTotals/recalc
     *
     * ทำไมต้องเป็นคำสั่งแรก: InnoDB (REPEATABLE READ) สร้างภาพข้อมูลของทรานแซกชันตอน SELECT ธรรมดาครั้งแรก
     * ถ้าอ่านอะไรก่อนได้ล็อก ยอดที่ SUM ทีหลังจะไม่เห็นของอีกจอที่เพิ่ง commit — สองจอแก้คนละบรรทัดพร้อมกัน
     * จอหลังเขียนยอดรวมทับด้วยตัวเลขที่ขาดบรรทัดของจอแรก (บิลเก็บเงินร้านผิดจนกว่าจะมีคนแก้บิลอีกครั้ง)
     * ยกเลิกบิล (void) ล็อกแถวเดียวกันนี้ จึงเข้าคิวกันหมด
     */
    private static function lockEditable(int $invoiceId): array
    {
        $inv = Db::one('SELECT * FROM invoices WHERE id = ? FOR UPDATE', [$invoiceId]) ?? throw ApiException::notFound('ไม่พบใบเรียกเก็บ');
        self::assertEditable($inv);

        return $inv;
    }

    /**
     * รายการที่จะเติมเข้าบิล: ไม่ส่ง entryIds = ทุกรายการที่ยังไม่ขึ้นบิลของร้าน/รอบนี้ · ส่งมา = ต้องอยู่ในนั้นทุกตัว
     * เรียกสองรอบ (ก่อนและหลังล็อกบิล) — รอบหลังคือตัวตัดสิน
     */
    private static function pickPending(array $inv, ?array $entryIds): array
    {
        $pending = self::pendingEntries((int) $inv['franchise_id'], (int) $inv['period_id']);
        if ($pending === []) {
            throw ApiException::badRequest('ไม่มีรายการที่ยังไม่ได้เรียกเก็บในรอบนี้');
        }
        if ($entryIds === null) {
            return $pending;
        }
        $wanted = array_values(array_unique(array_map('intval', $entryIds)));
        if ($wanted === []) {
            throw ApiException::badRequest('ต้องเลือกอย่างน้อยหนึ่งรายการ');
        }
        $byId    = array_column($pending, null, 'id');
        $missing = array_values(array_filter($wanted, static fn ($id) => ! isset($byId[$id])));
        if ($missing !== []) {
            throw ApiException::badRequest('รายการที่เลือกไม่อยู่ในรอบนี้ของร้านนี้ หรือออกบิลไปแล้ว (id: ' . implode(', ', $missing) . ')');
        }

        return array_map(static fn ($id) => $byId[$id], $wanted);
    }

    /**
     * บิลที่ส่งไปแล้วและมีความเคลื่อนไหวเรื่องเงินแล้ว ห้ามแก้ยอด
     * ไม่งั้นสิ่งที่ร้านเห็นตอนจ่าย กับยอดในระบบจะไม่ตรงกัน แล้วตามหลังยาก
     */
    private static function assertEditable(array $inv): void
    {
        if ($inv['status'] === 'VOID') {
            throw ApiException::conflict('ใบเรียกเก็บนี้ถูกยกเลิกแล้ว');
        }
        self::assertShopNotDeleted(Db::one('SELECT username, status FROM franchises WHERE id = ?', [$inv['franchise_id']]) ?? []);
        /*
         * PAID ที่ยังไม่มีเงินเข้าเลย = บิลยอด 0 (รอบที่ติดลบ หรือยอดยกมาหักจนหมดพอดี)
         * ใบพวกนี้ต้องแก้ได้ ไม่งั้นยอดบวกที่เข้ามาทีหลังในรอบเดียวกันจะขึ้นบิลไม่ได้เลย
         * ด่านจริงคือ paid_satang > 0 — "เงินขยับแล้ว" ต่างหากที่ห้ามแก้
         */
        $paid = (int) $inv['paid_satang'];
        if ($inv['status'] === 'PAID' && $paid > 0) {
            throw ApiException::conflict('ใบที่ชำระครบแล้วแก้รายการไม่ได้');
        }
        if ($paid > 0) {
            throw ApiException::conflict('ร้านจ่ายมาแล้ว ' . Money::fmt(Money::toBaht($paid)) . ' บาท — แก้ข้อมูลในบิลไม่ได้ ถ้าผิดต้องยกเลิกใบนี้แล้วออกใบใหม่');
        }
        if (Db::int("SELECT COUNT(*) FROM payment_submissions WHERE invoice_id = ? AND status = 'PENDING'", [$inv['id']]) > 0) {
            throw ApiException::conflict('มีสลิปรอตรวจสอบอยู่ — ตรวจให้เสร็จ หรือให้ร้านยกเลิกการแจ้งก่อนจึงจะแก้บิลได้');
        }
    }

    /**
     * ร้านที่ลบแล้ว: บิลเก่าเป็นประวัติอ่านอย่างเดียว — ลบได้เฉพาะตอนไม่มีบิลค้าง จึงเหลือแค่บิลที่จ่ายครบ/ยอด 0/ยกเลิกแล้ว
     * แก้/เพิ่มยอดทีหลัง = สร้างหนี้ให้ร้านที่ไม่มีใครเข้าระบบมาจ่ายได้
     */
    private static function assertShopNotDeleted(array $franchise): void
    {
        if (($franchise['status'] ?? null) === 'DELETED') {
            throw ApiException::conflict("ร้าน {$franchise['username']} ถูกลบแล้ว — บิลของร้านนี้เก็บไว้เป็นประวัติ ออกใหม่/แก้/ยกเลิกไม่ได้");
        }
    }

    public static function addAdjustment(int $invoiceId, array $input, array $user): array
    {
        self::assertEditable(self::row($invoiceId));

        return Db::tx(static function () use ($invoiceId, $input, $user) {
            // % คิดจากส่วนต่างของแถวที่ล็อกแล้ว — ไม่ใช่ค่าที่อ่านก่อนเปิดทรานแซกชัน (อีกจออาจเพิ่งแก้บรรทัดไป)
            $inv = self::lockEditable($invoiceId);
            $id  = self::insertAdjustment($invoiceId, (int) $inv['commission_total_satang'], $input, $user);
            self::recalc($invoiceId, $user);
            Audit::write((int) $user['id'], 'invoice.adjustment.add', 'invoice', $invoiceId, ['adjustmentId' => $id, 'label' => $input['label'] ?? null]);

            return self::get($invoiceId, $user);
        });
    }

    /**
     * การแก้หัวบิลครั้งนี้เปลี่ยนบัญชีที่ให้ร้านโอนเข้าไหม — controller ใช้ตัดสินว่าต้องยืนยันรหัส 6 หลักก่อนหรือไม่
     * (แบบเดียวกับ BankAccountService::changes) ส่งค่าเดิมมาหรือไม่ได้ส่งมา = ไม่เปลี่ยน
     */
    public static function changesBankAccount(int $id, array $patch): bool
    {
        if (! array_key_exists('bankAccountId', $patch)) {
            return false;
        }
        $current = self::row($id)['bank_account_id'];

        return ($patch['bankAccountId'] === null ? null : (int) $patch['bankAccountId']) !== ($current === null ? null : (int) $current);
    }

    /**
     * แก้ข้อมูลหัวบิลที่ไม่เกี่ยวกับตัวเลขยอดขาย — บัญชีปลายทาง วันครบกำหนด หมายเหตุ สกุลที่ให้จ่าย
     * กติกาเดียวกับการแก้ยอด: แก้ได้เฉพาะตอนที่ยังไม่มีเงินเข้าและไม่มีสลิปรอตรวจ
     * (ถ้าร้านโอนไปแล้ว การเปลี่ยนบัญชีปลายทางจะทำให้สลิปที่ถืออยู่ไม่ตรงกับบิล)
     *
     * เปลี่ยนบัญชีปลายทาง = เปลี่ยนว่าเงินไปเข้าที่ไหน จึงแจ้งกลุ่ม Telegram ส่วนกลาง (ปิดไม่ได้) และขึ้นแถบเตือนในเว็บ
     * แต่ "ไม่" ส่งเลขบัญชีใหม่ให้ร้านเอง — ข้อความ Telegram ที่ร้านถืออยู่คือหลักฐานนอกระบบที่ร้านใช้เทียบก่อนโอน
     * ถ้าระบบส่งบัญชีใหม่ให้ทันที คนที่ยึดบัญชีแอดมินได้ก็ใช้ระบบบอกร้านให้โอนเข้าบัญชีตัวเองได้ในคลิกเดียว
     * ร้านจึงเห็น "ไม่ตรงกับ Telegram" จนกว่าส่วนกลางตรวจแล้วกด "ส่งเลขบัญชีให้ร้าน" เอง (notifyAccount)
     */
    public static function updateHeader(int $id, array $patch, array $user): array
    {
        $inv = self::row($id);
        self::assertEditable($inv);
        $sets        = [];
        $params      = [];
        $bankChanged = false;
        $newBankId   = null;

        /*
         * เปลี่ยนสกุลที่ให้ร้านจ่าย — ยอดในฐานข้อมูลยังเป็นบาทเท่าเดิม แค่เปลี่ยนตัวที่ร้านเห็นและโอน
         * บิลดอลลาร์ต้องมีอัตราตรึงไว้ ใบที่ออกตอนรอบยังไม่ได้ตั้งอัตราจะไม่มี ต้องหยิบจากรอบมาเติมตอนนี้
         */
        $currency = $patch['currency'] ?? $inv['currency'] ?? 'THB';
        if (array_key_exists('currency', $patch) && $patch['currency'] !== $inv['currency']) {
            $rate = $inv['usd_rate_satang'];
            if ($currency === 'USD' && ! $rate) {
                $rate = Db::val('SELECT usd_rate_satang FROM billing_periods WHERE id = ?', [$inv['period_id']]);
                if (! $rate) {
                    throw ApiException::badRequest('รอบบิลนี้ยังไม่ได้ตั้งอัตราแลกเปลี่ยน — เปลี่ยนเป็นสกุลดอลลาร์ไม่ได้ ให้ตั้งอัตราที่แถบรอบบิลก่อน');
                }
                $sets[]   = 'usd_rate_satang = ?';
                $params[] = $rate;
            }
            $sets[]   = 'currency = ?';
            $params[] = $currency;
        }

        /*
         * บัญชีปลายทางต้องรับสกุลเดียวกับบิลเสมอ
         * เปลี่ยนสกุลอย่างเดียวโดยไม่เลือกบัญชีใหม่ = บัญชีเดิมต้องผ่านด่านนี้ด้วย ไม่งั้นบิลจะชี้บัญชีผิดสกุล
         */
        if (array_key_exists('bankAccountId', $patch)) {
            $newBankId   = $patch['bankAccountId'] === null ? null : BankAccountService::assertUsable((int) $patch['bankAccountId'], $currency);
            $bankChanged = $newBankId !== ($inv['bank_account_id'] === null ? null : (int) $inv['bank_account_id']);
            $sets[]      = 'bank_account_id = ?';
            $params[]    = $newBankId;
        } elseif ($currency !== $inv['currency'] && $inv['bank_account_id']) {
            // เช็กแค่สกุล ไม่เช็กสถานะ เพราะบัญชีที่ปิดใช้งานทีหลังไม่ใช่ความผิดของบิลใบนี้
            $cur = Db::one('SELECT * FROM bank_accounts WHERE id = ?', [$inv['bank_account_id']]);
            if ($cur !== null && $cur['currency'] !== $currency) {
                throw ApiException::badRequest(
                    'บิลใบนี้ผูกบัญชี' . BankAccountService::CURRENCY_LABEL[$cur['currency']] . ' (' . BankAccountService::labelOf($cur) . ') อยู่ '
                    . '— เปลี่ยนเป็นสกุล' . BankAccountService::CURRENCY_LABEL[$currency] . ' ต้องเลือกบัญชีที่รับสกุลนั้นพร้อมกันด้วย',
                );
            }
        }
        if (array_key_exists('dueDate', $patch)) {
            $sets[]   = 'due_date = ?';
            $params[] = Period::assertDate($patch['dueDate'], 'dueDate');
            // เลื่อนวันครบกำหนด = นับการเตือนใหม่ตามวันใหม่
            array_push($sets, 'reminded_at = NULL', 'overdue_nudges = 0');
        }
        if (array_key_exists('note', $patch)) {
            $sets[]   = 'note = ?';
            $params[] = $patch['note'] ?: null;
        }
        if ($sets === []) {
            return self::get($id, $user);
        }
        $sets[]   = 'updated_at = UTC_TIMESTAMP()';
        $params[] = $id;
        // แถวก่อนแก้ (มีชื่อร้าน/บัญชีเดิม) ไว้เขียนข้อความแจ้งเตือนว่า "จากอะไร เป็นอะไร"
        $before = $bankChanged ? Db::one(self::SELECT_INVOICE . ' WHERE i.id = ?', [$id]) : null;

        Db::tx(static function () use ($id, $sets, $params, $patch, $user, $inv, $bankChanged, $newBankId, $before) {
            Db::exec('UPDATE invoices SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
            Audit::write((int) $user['id'], 'invoice.update', 'invoice', $id, $patch);
            if (! $bankChanged) {
                return;
            }
            $oldBank = $inv['bank_account_id'] ? Db::one('SELECT * FROM bank_accounts WHERE id = ?', [$inv['bank_account_id']]) : null;
            $newBank = $newBankId ? Db::one('SELECT * FROM bank_accounts WHERE id = ?', [$newBankId]) : null;
            Audit::write((int) $user['id'], 'invoice.bank_account', 'invoice', $id, [
                'fromId'    => $oldBank === null ? null : (int) $oldBank['id'],
                'fromLabel' => $oldBank === null ? null : NotificationService::snapshotLabel(NotificationService::bankSnapshotFromRow($oldBank)),
                'toId'      => $newBankId,
                'toLabel'   => $newBank === null ? null : NotificationService::snapshotLabel(NotificationService::bankSnapshotFromRow($newBank)),
            ]);
            // ในทรานแซกชันเดียวกัน — แถวแจ้งเตือนในเว็บต้องมีเสมอเมื่อการเปลี่ยนบัญชีบันทึกสำเร็จ
            NotificationService::invoiceAccountChanged($before, $oldBank, $newBank, $user);
        });

        return self::get($id, $user);
    }

    /**
     * ส่งเลขบัญชีปัจจุบันของบิลให้ร้านทาง Telegram — ส่วนกลางกดเองหลังตรวจแล้วว่าบัญชีถูกต้อง
     * (ต้องยืนยันรหัส 6 หลัก: ข้อความนี้คือสิ่งที่ร้านใช้ตัดสินว่าจะโอนเข้าบัญชีไหน)
     * ถ้าบัญชีต่างจากที่เคยแจ้งร้าน NotificationService แจ้งกลุ่มส่วนกลางด้วย ว่ามีการส่งบัญชีใหม่ออกไปแล้ว
     */
    public static function notifyAccount(int $id, array $user): array
    {
        $inv = self::row($id);
        if ($inv['status'] === 'VOID') {
            throw ApiException::conflict('บิลนี้ถูกยกเลิกแล้ว — ไม่ต้องส่งเลขบัญชีให้ร้าน');
        }
        if ((int) $inv['net_total_satang'] - (int) $inv['paid_satang'] <= 0) {
            throw ApiException::conflict('บิลนี้ไม่มียอดค้างแล้ว — ไม่ต้องส่งเลขบัญชีให้ร้าน');
        }
        if (! TelegramService::isConfigured()) {
            throw ApiException::badRequest('ยังไม่ได้ตั้งค่า Telegram ของระบบ — ตั้งค่าที่หน้า "ตั้งค่าแจ้งเตือน" ก่อน หรือแจ้งเลขบัญชีกับร้านโดยตรง');
        }
        $result = NotificationService::notifyBillAccount($id, $user);
        Audit::write((int) $user['id'], 'invoice.notify_account', 'invoice', $id, [
            'sent'     => $result['sent'],
            'changed'  => $result['changed'],
            'account'  => $result['current'],
            'previous' => $result['previous'],
        ]);

        return ['sent' => $result['sent'], 'changed' => $result['changed'], 'invoice' => self::get($id, $user)];
    }

    public static function removeAdjustment(int $invoiceId, int $adjustmentId, array $user): array
    {
        self::assertEditable(self::row($invoiceId));

        return Db::tx(static function () use ($invoiceId, $adjustmentId, $user) {
            $inv = self::lockEditable($invoiceId);
            // อ่านหลังล็อก — อีกจอเพิ่งลบแถวนี้ไปแล้ว = 404 ไม่ใช่คิดยอดใหม่ซ้ำ
            $row = Db::one('SELECT * FROM invoice_adjustments WHERE id = ? AND invoice_id = ?', [$adjustmentId, $invoiceId])
                ?? throw ApiException::notFound('ไม่พบรายการในใบเรียกเก็บนี้');
            Db::exec('DELETE FROM invoice_adjustments WHERE id = ?', [$adjustmentId]);
            // บรรทัด "หักค่าคอมเซล": ถอนการหัก = บิลค่าคอมที่เกิดจากการหักถูกยกเลิก รายการกลับไปรอทำบิลค่าคอม/หักใหม่
            $salesCommissionId = $row['sales_commission_id'] === null ? null : (int) $row['sales_commission_id'];
            if ($salesCommissionId !== null) {
                SalesAgentService::unsettleFromInvoice($salesCommissionId, "ถอนการหักค่าคอมจากบิลร้าน {$inv['invoice_no']}", (int) $user['id']);
            }
            self::recalc($invoiceId, $user);
            Audit::write(
                (int) $user['id'],
                $salesCommissionId === null ? 'invoice.adjustment.remove' : 'invoice.sales_deduction.remove',
                'invoice',
                $invoiceId,
                ['label' => $row['label'], ...($salesCommissionId === null ? [] : ['amount' => Money::toBaht($row['amount_satang']), 'salesCommissionId' => $salesCommissionId])],
            );

            return self::get($invoiceId, $user);
        });
    }

    /* ── หักค่าคอมเซลจากบิลร้าน (R25) ─────────────────────────────── */

    /** รายการเซลที่ติ๊กมา — เซลคนเดียวซ้ำสองครั้งไม่ได้ (หักทีเดียวทั้งคนอยู่แล้ว) */
    private static function uniqueSalesDeductions(array $deductions): array
    {
        $seen = [];
        foreach ($deductions as $d) {
            $agentId = (int) $d['salesAgentId'];
            if (isset($seen[$agentId])) {
                throw ApiException::badRequest('หักค่าคอมเซล: เซลคนเดียวกันถูกเลือกซ้ำ — หนึ่งคนหักได้ครั้งเดียวต่อบิล');
            }
            $seen[$agentId] = true;
        }

        return $deductions;
    }

    /**
     * หักค่าคอมของเซลที่เลือกออกจากบิลร้าน — เรียกในทรานแซกชันหลังสร้าง/ล็อกบิลแล้ว และก่อน recalc
     * ต่อเซลหนึ่งคน: SalesAgentService ทำบิลค่าคอมสถานะจ่ายแล้วจากทุกรายการของเซลคนนั้นในบิลนี้
     * แล้วเพิ่มบรรทัดส่วนลด "หักค่าคอมเซล" ที่ผูกกับบิลค่าคอมใบนั้น (sales_commission_id) — ยอดสองฝั่งมาจากตัวเลขเดียวกันเสมอ
     * ยอดรวมของบิล (รวมด่าน "ส่วนลดเกินยอด") ให้ recalc ของคนเรียกคิดทางเดิม
     *
     * @param array{id: int, invoice_no: string, franchise_id: int, period_id: int} $inv
     *
     * @return list<array> สิ่งที่หักไป (ลงประวัติ)
     */
    private static function applySalesDeductions(array $inv, array $deductions, array $user): array
    {
        $done = [];
        foreach ($deductions as $d) {
            $expected = ($d['amount'] ?? null) === null ? null : Money::toSatang($d['amount'], 'salesDeductions.amount');
            $settled  = SalesAgentService::settleFromInvoice($inv, (int) $d['salesAgentId'], $expected, $user);
            $agent    = $settled['agent'];
            Db::insert(
                "INSERT INTO invoice_adjustments
                   (invoice_id, charge_item_id, sales_commission_id, kind, label, pct_bp, amount_satang, note, created_by_user_id, created_at)
                 VALUES (?, NULL, ?, 'DISCOUNT', ?, NULL, ?, ?, ?, UTC_TIMESTAMP())",
                [
                    $inv['id'], $settled['commissionId'], "หักค่าคอมเซล {$agent['username']}", $settled['total_satang'],
                    "ร้านจ่ายค่าคอมให้เซล {$agent['name']} เอง · บิลค่าคอม {$settled['billNo']}", $user['id'],
                ],
            );
            $done[] = ['agent' => $agent['username'], 'billNo' => $settled['billNo'], 'amount' => Money::toBaht($settled['total_satang'])];
        }

        return $done;
    }

    /** เซลที่ยังหักค่าคอมจากบิลใบนี้ได้ + ยอดของแต่ละคน — หน้าต่างแก้บิลของส่วนกลาง (คนที่หักไปแล้วไม่โผล่ รายการถูกล็อกแล้ว) */
    public static function salesDeductible(int $invoiceId): array
    {
        $inv = self::row($invoiceId);
        if ($inv['status'] === 'VOID') {
            return ['items' => []];
        }
        $entryIds = array_column(Db::all('SELECT id FROM sales_entries WHERE invoice_id = ?', [$invoiceId]), 'id');

        return ['items' => SalesAgentService::serializeDealCommissions(
            SalesAgentService::dealCommissions((int) $inv['franchise_id'], (int) $inv['period_id'], $entryIds),
        )];
    }

    /**
     * พรีวิวก่อนออกบิล: รายการยอดขายที่ยังไม่ขึ้นบิลของร้าน/รอบนี้ (ทั้งหมด หรือเฉพาะที่ติ๊กไว้) มีเซลคนไหนได้ค่าคอมเท่าไร
     * ตัวเลขจากตัวคิดเดียวกับตอนหักจริง — หน้าต่างออกบิลส่งยอดที่เห็นกลับมาให้เทียบอีกครั้งตอนกดออกบิล
     */
    public static function salesDeductionPreview(int $franchiseId, string $periodCode, ?array $entryIds): array
    {
        $period = Db::one('SELECT id FROM billing_periods WHERE code = ?', [Period::fromCode($periodCode)['code']]);
        if ($period === null) {
            return ['items' => []];
        }
        $pending = array_map('intval', array_column(self::pendingEntries($franchiseId, (int) $period['id']), 'id'));
        $wanted  = $entryIds === null ? $pending : array_values(array_intersect($pending, array_map('intval', $entryIds)));

        return ['items' => SalesAgentService::serializeDealCommissions(
            SalesAgentService::dealCommissions($franchiseId, (int) $period['id'], $wanted),
        )];
    }

    /** หักค่าคอมเซลเพิ่มในบิลที่ออกไปแล้วและยังแก้ได้ (ลืมติ๊กตอนออก / เพิ่มรายการเข้าบิลทีหลัง) */
    public static function addSalesDeduction(int $invoiceId, array $input, array $user): array
    {
        self::assertEditable(self::row($invoiceId));

        return Db::tx(static function () use ($invoiceId, $input, $user) {
            $inv  = self::lockEditable($invoiceId);
            $done = self::applySalesDeductions($inv, [$input], $user);
            self::recalc($invoiceId, $user);
            Audit::write((int) $user['id'], 'invoice.sales_deduction.add', 'invoice', $invoiceId, $done[0]);

            return self::get($invoiceId, $user);
        });
    }

    /* ── อ่านข้อมูล ────────────────────────────────────────────── */

    public static function get(int $id, array $user): array
    {
        $row = Db::one(self::SELECT_INVOICE . ' WHERE i.id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบใบเรียกเก็บ');
        if (! AuthContext::isSuperAdmin($user) && (int) $row['franchise_id'] !== (int) $user['franchise_id']) {
            throw ApiException::forbidden();
        }

        $isSuper = AuthContext::isSuperAdmin($user);
        $lines   = array_map([SalesService::class, 'serialize'], Db::all(
            'SELECT se.*, bp.code AS period_code, bp.start_date AS period_start, bp.end_date AS period_end,
                    bp.year AS period_year, bp.month AS period_month, bp.half AS period_half, bp.status AS period_status,
                    p.sku, p.name AS product_name, f.username AS franchise_username,
                    i.invoice_no
               FROM sales_entries se
               JOIN billing_periods bp ON bp.id = se.period_id
               JOIN products p         ON p.id = se.product_id
               JOIN franchises f       ON f.id = se.franchise_id
               JOIN invoices i         ON i.id = se.invoice_id
              WHERE se.invoice_id = ?
              ORDER BY p.sku',
            [$id],
        ));
        if (! $isSuper) {
            // ยอดส่วนต่างที่กรอกไว้ที่หน้ายอดขายเป็นข้อมูลภายในของส่วนกลาง — ร้านเห็นแค่ยอดที่ใช้ออกบิลจริง (commissionAmount + billMode)
            $lines = array_map(static function (array $l): array {
                unset($l['manualAmount']);

                return $l;
            }, $lines);
        }
        $adjustments = array_map([self::class, 'serializeAdjustment'], Db::all(
            'SELECT * FROM invoice_adjustments WHERE invoice_id = ? ORDER BY kind DESC, id',
            [$id],
        ));
        $payments = array_map(static fn ($p) => [
            'id'        => (int) $p['id'],
            'amount'    => Money::toBaht($p['amount_satang']),
            'paidAt'    => $p['paid_at'],
            'method'    => $p['method'],
            'reference' => $p['reference'],
            'note'      => $p['note'],
        ], Db::all('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY paid_at, id', [$id]));
        $submissions = array_map(static fn ($s) => [
            'id'           => (int) $s['id'],
            'amount'       => Money::toBaht($s['amount_satang']),
            'paidAt'       => $s['paid_at'],
            'method'       => $s['method'],
            'reference'    => $s['reference'],
            'slipUrl'      => SignedUrl::sign($s['slip_url']),
            'status'       => $s['status'],
            'rejectReason' => $s['reject_reason'],
            'createdAt'    => $s['created_at'],
            // ร้านยืนยันว่าตรวจเลขบัญชีกับ Telegram แล้ว + บัญชีที่บิลชี้อยู่ตอนแจ้ง — หลักฐานเวลามีข้อโต้แย้งเรื่องโอนผิดบัญชี
            'accountConfirmedAt' => $s['account_confirmed_at'] ?? null,
            'bankAccountLabel'   => PaymentSubmissionService::bankLabelOf($s['bank_snapshot'] ?? null),
        ], Db::all('SELECT * FROM payment_submissions WHERE invoice_id = ? ORDER BY created_at DESC, id DESC', [$id]));

        $out = [
            ...self::serialize($row),
            'lines'       => $lines,
            'adjustments' => $adjustments,
            'payments'    => $payments,
            'submissions' => $submissions,
            // get() ตรวจแล้วว่าเป็นบิลของร้านนี้ ร้านจึงได้ลิงก์เฉพาะรูปของบิลตัวเอง
            'attachments' => InvoiceAttachmentService::listFor($id),
        ];
        if ($isSuper) {
            $out['telegramAccount'] = self::telegramAccount($row);
        }

        return $out;
    }

    /**
     * บัญชีที่ส่งเข้า Telegram ของร้านล่าสุด เทียบกับบัญชีที่บิลชี้อยู่ตอนนี้ — ส่วนกลางเท่านั้น
     * null = ยังไม่เคยส่งเลขบัญชีของบิลนี้ให้ร้านเลย (ร้านอาจยังไม่ได้เชื่อม Telegram)
     * "ส่งแล้ว" คือเข้าคิวส่งแล้ว ไม่ได้แปลว่าร้านเปิดอ่านแล้ว
     */
    private static function telegramAccount(array $row): ?array
    {
        $snapshot = NotificationService::notifiedSnapshot($row);
        if ($snapshot === null) {
            return null;
        }

        return [
            'sentAt'  => $row['notified_bank_at'],
            'matches' => NotificationService::accountCheck($row) === 'MATCH',
            'account' => $snapshot,
            'label'   => NotificationService::snapshotLabel($snapshot),
        ];
    }

    public static function list(array $filters, array $user): array
    {
        $where       = [];
        $params      = [];
        $franchiseId = AuthContext::isSuperAdmin($user) ? ($filters['franchiseId'] ?? null) : $user['franchise_id'];
        if ($franchiseId) {
            $where[]  = 'i.franchise_id = ?';
            $params[] = (int) $franchiseId;
        }
        if (! empty($filters['status'])) {
            $where[]  = 'i.status = ?';
            $params[] = $filters['status'];
        }
        if (! empty($filters['periodCode'])) {
            $where[]  = 'bp.code = ?';
            $params[] = Period::fromCode($filters['periodCode'])['code'];
        }
        if (($filters['unpaidOnly'] ?? null) === true || ($filters['unpaidOnly'] ?? null) === 'true') {
            $where[] = "i.status IN ('OPEN', 'PARTIAL')";
        }
        $rows = array_map([self::class, 'serialize'], Db::all(
            self::SELECT_INVOICE . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY bp.start_date DESC, i.id DESC',
            $params,
        ));
        $live = array_filter($rows, static fn ($r) => $r['status'] !== 'VOID');

        return [
            'items'   => $rows,
            'summary' => [
                'count'              => count($rows),
                'netTotal'           => Money::round2(array_sum(array_column($live, 'netTotal'))),
                'outstanding'        => Money::round2(array_sum(array_column($live, 'outstanding'))),
                'pendingSubmissions' => array_sum(array_column($rows, 'pendingSubmissions')),
                // ยอดเทียบดอลลาร์ของสองยอดบน — รวมจาก fxRate ของแต่ละบิล (null = ยังไม่เคยตั้งอัตรา)
                'netTotalUsd'    => Usd::sum($live, 'netTotal'),
                'outstandingUsd' => Usd::sum($live, 'outstanding'),
            ],
        ];
    }

    /**
     * เงินที่ "รับเข้ามาจริง" ทั้งหมด — ใช้ที่หน้าชำระเงินเพื่อแยกให้ชัดว่า
     * อันไหนได้เงินแล้ว ต่างจากใบที่ออกไปแล้วแต่ยังไม่ได้รับ
     */
    public static function listReceivedPayments(array $filters, array $user): array
    {
        $where       = [];
        $params      = [];
        $franchiseId = AuthContext::isSuperAdmin($user) ? ($filters['franchiseId'] ?? null) : $user['franchise_id'];
        if ($franchiseId) {
            $where[]  = 'i.franchise_id = ?';
            $params[] = (int) $franchiseId;
        }
        if (! empty($filters['periodCode'])) {
            $where[]  = 'bp.code = ?';
            $params[] = Period::fromCode($filters['periodCode'])['code'];
        }
        $items = array_map(static fn ($r) => [
            'id'                => (int) $r['id'],
            'invoiceId'         => (int) $r['invoice_id'],
            'invoiceNo'         => $r['invoice_no'],
            'franchiseUsername' => $r['franchise_username'],
            'periodCode'        => $r['period_code'],
            'amount'            => Money::toBaht($r['amount_satang']),
            'paidAt'            => $r['paid_at'],
            'method'            => $r['method'],
            'reference'         => $r['reference'],
            'note'              => $r['note'],
            'recordedBy'        => $r['recorded_by'],
            // เงินที่รับเทียบดอลลาร์ด้วยอัตราของบิลที่เงินก้อนนั้นตัดยอด
            'fxRate'            => Usd::rate($r['invoice_usd_rate_satang'], $r['period_usd_rate_satang']),
        ], Db::all(
            'SELECT p.*, i.invoice_no, i.net_total_satang, f.username AS franchise_username,
                    i.usd_rate_satang AS invoice_usd_rate_satang, bp.usd_rate_satang AS period_usd_rate_satang,
                    bp.code AS period_code, u.username AS recorded_by
               FROM invoice_payments p
               JOIN invoices i         ON i.id = p.invoice_id
               JOIN franchises f       ON f.id = i.franchise_id
               JOIN billing_periods bp ON bp.id = i.period_id
               LEFT JOIN users u       ON u.id = p.created_by_user_id
              ' . ($where ? 'WHERE ' . implode(' AND ', $where) : '') . '
              ORDER BY p.paid_at DESC, p.id DESC',
            $params,
        ));

        return [
            'items'   => $items,
            'summary' => [
                'count'    => count($items),
                'total'    => Money::round2(array_sum(array_column($items, 'amount'))),
                'totalUsd' => Usd::sum($items, 'amount'),
            ],
        ];
    }

    /* ── การชำระเงิน ───────────────────────────────────────────── */

    /**
     * ตัดยอดเงินเข้าในบิล
     * เรียกได้จากขั้นตอนอนุมัติการแจ้งชำระเท่านั้น (PaymentSubmissionService::approve)
     * ไม่มีเส้นทางไหนเปิดให้เรียกตรง ๆ เพราะส่วนกลางไม่มีสิทธิ์จ่ายแทนร้าน
     */
    public static function addPayment(int $invoiceId, array $input, array $user, ?int $submissionId = null): array
    {
        $inv = self::row($invoiceId);
        if ($inv['status'] === 'VOID') {
            throw ApiException::conflict('ใบเรียกเก็บนี้ถูกยกเลิกแล้ว');
        }
        $amount = Money::toSatang($input['amount'] ?? null, 'amount');
        if ($amount <= 0) {
            throw ApiException::badRequest('amount: ต้องมากกว่า 0');
        }
        $outstanding = (int) $inv['net_total_satang'] - (int) $inv['paid_satang'];
        if ($amount > $outstanding) {
            throw ApiException::badRequest('ยอดชำระเกินยอดค้าง (ค้างอยู่ ' . Money::toBaht($outstanding) . ' บาท)');
        }

        return Db::tx(static function () use ($invoiceId, $input, $amount, $user, $submissionId) {
            $paymentId = Db::insert(
                'INSERT INTO invoice_payments (invoice_id, amount_satang, paid_at, method, reference, note, created_by_user_id, created_at)
                 VALUES (?, ?, COALESCE(?, UTC_TIMESTAMP()), ?, ?, ?, ?, UTC_TIMESTAMP())',
                [$invoiceId, $amount, $input['paidAt'] ?? null, $input['method'] ?? null, $input['reference'] ?? null, $input['note'] ?? null, $user['id']],
            );
            self::recalc($invoiceId, $user);
            Audit::write((int) $user['id'], 'invoice.payment', 'invoice', $invoiceId, ['amount' => $amount, 'submissionId' => $submissionId]);

            return ['paymentId' => $paymentId, 'invoice' => self::get($invoiceId, $user)];
        });
    }

    /**
     * ยกเลิกใบเรียกเก็บ คืนรายการยอดขายเป็น APPROVED และจัดการค่าคอมเซลที่อ้างบิลนี้
     * (แถวแบบเก่ายกเลิกตาม · บิลค่าคอมที่ยังไม่จ่ายถูกถอดรายการของบิลนี้ออก · บิลค่าคอมที่จ่ายแล้วไม่แตะ)
     */
    public static function void(int $id, string $reason, array $user): array
    {
        $inv = self::row($id);
        if ($inv['status'] === 'VOID') {
            throw ApiException::conflict('ใบเรียกเก็บนี้ถูกยกเลิกไปแล้ว');
        }
        if ((int) $inv['paid_satang'] > 0) {
            throw ApiException::conflict('ใบเรียกเก็บที่มีการชำระแล้วยกเลิกไม่ได้');
        }
        // บิลยอด 0 ของร้านที่ลบแล้ว — ยกเลิกแล้วยอดขายจะกลับไปเป็น "ยังไม่ออกบิล" ของร้านที่ไม่มีอยู่ (ไม่มีใครออกบิลใหม่ได้อีก)
        self::assertShopNotDeleted(Db::one('SELECT username, status FROM franchises WHERE id = ?', [$inv['franchise_id']]) ?? []);

        return Db::tx(static function () use ($id, $reason, $inv, $user) {
            /*
             * ล็อกบิลก่อนอย่างอื่น — การทำบิลค่าคอมล็อกบิลร้านเดียวกันก่อนเพิ่มรายการ
             * สองทางนี้จึงเข้าคิวกัน ไม่มีรายการค่าคอมผูกกับบิลที่เพิ่งถูกยกเลิกค้างอยู่
             */
            Db::one('SELECT id FROM invoices WHERE id = ? FOR UPDATE', [$id]);
            Db::exec("UPDATE sales_entries SET status = 'APPROVED', invoice_id = NULL, updated_at = UTC_TIMESTAMP() WHERE invoice_id = ?", [$id]);
            Db::exec("UPDATE payment_submissions SET status = 'CANCELLED', updated_at = UTC_TIMESTAMP() WHERE invoice_id = ? AND status = 'PENDING'", [$id]);
            SalesAgentService::onInvoiceVoided($id, (int) $user['id']);
            /*
             * เครดิตสองทางต้องจัดการคนละแบบ
             *   ใบนี้ "หัก" เครดิตไป → คืนกลับให้ร้าน ยังใช้กับใบอื่นได้
             *   ใบนี้ "สร้าง" เครดิต → ยกเลิกทิ้ง (แต่ถ้าถูกหักไปใช้แล้วจะโยน error ให้ไปจัดการใบนั้นก่อน)
             */
            CreditService::releaseCreditsOf($id);
            CreditService::cancelCreditsFrom($id, (int) $user['id']);
            Db::exec("UPDATE invoices SET status = 'VOID', note = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", [$reason !== '' ? $reason : $inv['note'], $id]);
            Audit::write((int) $user['id'], 'invoice.void', 'invoice', $id, ['reason' => $reason]);

            return self::get($id, $user);
        });
    }

    /* ── serializers ───────────────────────────────────────────── */

    public static function serializeAdjustment(array $row): array
    {
        $amount = (int) $row['amount_satang'];
        // บรรทัด "หักค่าคอมเซล" (R25) — เป็นส่วนลดในทางคิดเงิน แต่ลบแล้วบิลค่าคอมของเซลถูกยกเลิกตาม หน้าเว็บจึงต้องแยกออก
        $salesCommissionId = ($row['sales_commission_id'] ?? null) === null ? null : (int) $row['sales_commission_id'];

        return [
            'id'           => (int) $row['id'],
            'chargeItemId' => $row['charge_item_id'] === null ? null : (int) $row['charge_item_id'],
            'salesCommissionId' => $salesCommissionId,
            'isSalesDeduction'  => $salesCommissionId !== null,
            'kind'         => $row['kind'],
            'kindLabel'    => $salesCommissionId !== null ? 'หักค่าคอมเซล' : ($row['kind'] === 'DISCOUNT' ? 'ส่วนลด' : 'ค่าใช้จ่าย'),
            'label'        => $row['label'],
            'pct'          => $row['pct_bp'] === null ? null : Money::bpToPct($row['pct_bp']),
            'amount'       => Money::toBaht($amount),
            // เครื่องหมายที่ควรแสดงในบิล: ค่าใช้จ่าย = +, ส่วนลด = −
            'signedAmount' => Money::toBaht($row['kind'] === 'DISCOUNT' ? -$amount : $amount),
            'note'         => $row['note'],
            'createdAt'    => $row['created_at'],
        ];
    }

    /**
     * บัญชีของบิล (คอลัมน์ ba.* จาก SELECT_INVOICE)
     * บัญชี USD คือกระเป๋าคริปโต: เลขบัญชี = ที่อยู่กระเป๋า · bank_name = เครือข่าย (chain) — ป้ายชื่อใช้ตัวช่วยกลางตัวเดียวทั้งระบบ
     * ร้านต้องเห็น chain ชัด ๆ เพราะโอนผิดเครือข่ายเงินหายกู้คืนไม่ได้
     */
    private static function serializeBank(array $row, string $invoiceCurrency): array
    {
        $bankCurrency = $row['bank_currency'] ?? 'THB';
        $isWallet     = $bankCurrency === 'USD';

        return [
            'id'              => (int) $row['bank_account_id'],
            'bankName'        => $row['bank_name'],
            'accountName'     => $row['account_name'],
            'accountNumber'   => $row['account_number'],
            'branch'          => $row['bank_branch'],
            'currency'        => $bankCurrency,
            'chain'           => $isWallet ? ($row['bank_chain'] ?? $row['bank_name']) : null,
            'isWallet'        => $isWallet,
            'qrUrl'           => SignedUrl::sign($row['bank_qr_url']),
            'currencyMatches' => $bankCurrency === $invoiceCurrency,
            'label'           => BankAccountService::labelOf([
                'bank_name'      => $row['bank_name'],
                'account_number' => $row['account_number'],
                'account_name'   => $row['account_name'],
                'currency'       => $bankCurrency,
                'chain'          => $row['bank_chain'] ?? null,
            ]),
        ];
    }

    public static function serialize(array $row): array
    {
        $net      = (int) $row['net_total_satang'];
        $paid     = (int) $row['paid_satang'];
        $applied  = (int) ($row['credit_applied_satang'] ?? 0);
        $rate     = $row['usd_rate_satang'] === null ? null : (int) $row['usd_rate_satang'];
        $currency = $row['currency'] ?? 'THB';
        $void     = $row['status'] === 'VOID';
        $today    = Period::today();
        $usd      = static fn (int $satang) => Money::round2($satang / $rate);

        return [
            'id'                => (int) $row['id'],
            'invoiceNo'         => $row['invoice_no'],
            'franchiseId'       => (int) $row['franchise_id'],
            'franchiseUsername' => $row['franchise_username'],
            'periodCode'        => $row['period_code'],
            'periodStart'       => $row['period_start'],
            'periodEnd'         => $row['period_end'],
            'grossTotal'        => Money::toBaht($row['gross_total_satang']),
            'commissionTotal'   => Money::toBaht($row['commission_total_satang']),
            'chargeTotal'       => Money::toBaht($row['charge_total_satang']),
            'discountTotal'     => Money::toBaht($row['discount_total_satang']),
            /*
             * ค่าคอมเซลที่หักในบิลนี้ (R25) — เป็น "ส่วนหนึ่งของ discountTotal" ไม่ใช่ยอดเพิ่ม
             * แยกมาให้หน้าของร้านเขียนได้ถูก: ก้อนนี้ร้านต้องจ่ายให้เซลเอง ไม่ใช่ส่วนลดจากทางเรา และไม่ใช่เงินที่ร้านเก็บไว้
             */
            'salesDeductionTotal' => Money::toBaht((int) ($row['sales_deduction_satang'] ?? 0)),
            /*
             * ยอดยกมาจากรอบก่อนที่ถูกหักออกจากใบนี้ (เราเคยติดค้างร้านไว้)
             * แยกจาก discountTotal เพราะคนละความหมาย — ส่วนลดคือเราลดให้
             * ส่วนยอดยกมาคือเงินของร้านที่ค้างอยู่กับเรามาตั้งแต่รอบก่อน
             */
            'creditApplied' => Money::toBaht($applied),
            // ใบนี้ยอดติดลบ จึงยกยอดนี้ไปหักรอบหน้าแทนการโอนคืนร้าน
            'creditCarried' => Money::toBaht((int) ($row['credit_created'] ?? 0)),
            // ยอดก่อนหักยอดยกมา — ไว้ให้บิลโชว์ได้ว่าหักอะไรออกไปบ้าง
            'subtotal'    => Money::toBaht($net + $applied),
            'netTotal'    => Money::toBaht($net),
            'paid'        => Money::toBaht($paid),
            // ใบที่ยกเลิกแล้วไม่มีใครต้องจ่าย
            'outstanding'        => $void ? 0 : Money::toBaht($net - $paid),
            'status'             => $row['status'],
            'pendingSubmissions' => (int) ($row['pending_submissions'] ?? 0),
            'pendingEntries'     => (int) ($row['pending_entries'] ?? 0),
            'issuedAt'           => $row['issued_at'],
            'dueDate'            => $row['due_date'],
            // เลยกำหนดชำระ = ยังค้างเงินอยู่ และวันครบกำหนดผ่านไปแล้ว (ใบที่ยกเลิกไม่นับ)
            'isOverdue'   => ! $void && $net > $paid && $row['due_date'] !== null && $row['due_date'] < $today,
            'daysOverdue' => Period::daysBetween($row['due_date'], $today),
            'paidAt'      => $row['paid_at'],
            'note'        => $row['note'],
            // จำนวนรูปประกอบ — รายการบิลโชว์ 📎 N ได้โดยไม่ต้องเซ็นลิงก์ทุกรูปของทุกใบ
            'attachmentCount' => (int) ($row['attachment_count'] ?? 0),
            // จำนวนค่าใช้จ่าย/ส่วนลดในบิล — ตอนออกบิลใหม่ใช้หาบิลเก่าที่มีรายการให้ดึงมาอ้างอิง (นับตามแถว รายการ 0 บาทก็นับ)
            // ไม่นับบรรทัด "หักค่าคอมเซล" — ดึงไปใช้กับบิลอื่นไม่ได้ (ผูกกับบิลค่าคอมของบิลใบนั้น)
            'adjustmentCount' => (int) ($row['adjustment_count'] ?? 0),
            /*
             * บัญชีที่บิลชี้อยู่ตรงกับที่ส่งเข้า Telegram ของร้านล่าสุดไหม (ไม่มีข้อมูลบัญชีในนี้ ร้านเห็นได้)
             *   MATCH ตรงกัน · NOT_SENT ยังไม่เคยส่ง · CHANGED บัญชีเปลี่ยนหลังส่ง → หน้าแจ้งชำระเตือนร้านห้ามโอน
             */
            'accountCheck' => NotificationService::accountCheck($row),
            /*
             * สกุลที่ให้ร้านจ่าย + ยอดในสกุลนั้น
             * payAmount/payOutstanding คือตัวเลขที่เอาไปโชว์บนบิลและในฟอร์มจ่ายได้เลย
             */
            'currency'       => $currency,
            'isUsd'          => $currency === 'USD',
            'usdRate'        => $rate ? Money::toBaht($rate) : null,
            'netTotalUsd'    => $rate ? $usd($net) : null,
            'outstandingUsd' => $rate && ! $void ? $usd($net - $paid) : null,
            'payAmount'      => $currency === 'USD' && $rate ? $usd($net) : Money::toBaht($net),
            'payOutstanding' => $currency === 'USD' && $rate
                ? ($void ? 0 : $usd($net - $paid))
                : ($void ? 0 : Money::toBaht($net - $paid)),
            /*
             * บาทต่อ 1 ดอลลาร์ที่ใช้เทียบยอดของบิลนี้ในการ์ดสรุป: อัตราที่ตรึงไว้ → อัตราของรอบ → อัตราล่าสุด (App\Libraries\Usd)
             * คนละตัวกับ usdRate ด้านบน ซึ่งมีเฉพาะบิลที่ตรึงอัตราไว้ตอนออก (ตัวที่ร้านจ่ายจริงเมื่อบิลเป็น USD)
             */
            'fxRate' => Usd::rate($rate, $row['period_usd_rate_satang'] ?? null),
            // บัญชีที่ให้ร้านโอนเข้า ตรึงไว้ตั้งแต่ตอนออกบิล ถึงเปลี่ยนบัญชีหลักทีหลังก็ไม่กระทบใบเก่า
            'bankAccount' => $row['bank_account_id'] ? self::serializeBank($row, $currency) : null,
        ];
    }
}
