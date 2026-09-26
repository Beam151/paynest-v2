<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\AuthContext;
use App\Libraries\Db;
use App\Libraries\Money;
use App\Libraries\Period;
use App\Libraries\SignedUrl;

/**
 * แจ้งชำระเงิน — ร้านโอนแล้วแนบสลิป → รอตรวจ → ส่วนกลางยืนยัน (ตัดยอดทันที) หรือตีกลับพร้อมเหตุผล
 * เงินเข้าระบบได้ทางนี้ทางเดียว ทุกบาทที่ตัดยอดจึงมีสลิปและผู้อนุมัติกำกับเสมอ
 */
final class PaymentSubmissionService
{
    private const SELECT = '
        SELECT ps.*,
               i.invoice_no, i.net_total_satang, i.paid_satang, i.status AS invoice_status,
               f.username AS franchise_username,
               bp.code AS period_code,
               su.username AS submitted_by, ru.username AS reviewed_by
          FROM payment_submissions ps
          JOIN invoices i         ON i.id = ps.invoice_id
          JOIN franchises f       ON f.id = ps.franchise_id
          JOIN billing_periods bp ON bp.id = i.period_id
          LEFT JOIN users su      ON su.id = ps.submitted_by_user_id
          LEFT JOIN users ru      ON ru.id = ps.reviewed_by_user_id';

    /** ยอดที่ยังแจ้งค้างรอตรวจอยู่ — กันแจ้งซ้ำจนเกินยอดบิล */
    private static function pendingSatang(int $invoiceId, ?int $excludeId = null): int
    {
        return Db::int(
            "SELECT COALESCE(SUM(amount_satang), 0) FROM payment_submissions
              WHERE invoice_id = ? AND status = 'PENDING' AND (? IS NULL OR id <> ?)",
            [$invoiceId, $excludeId, $excludeId],
        );
    }

    /** ลูกค้าแจ้งชำระเงิน — ยังไม่ตัดยอดจนกว่า super admin จะยืนยัน */
    public static function submit(array $input, array $user): array
    {
        $inv = Db::one('SELECT * FROM invoices WHERE id = ?', [(int) $input['invoiceId']]) ?? throw ApiException::notFound('ไม่พบใบเรียกเก็บ');
        if (! AuthContext::isSuperAdmin($user) && (int) $inv['franchise_id'] !== (int) $user['franchise_id']) {
            throw ApiException::forbidden();
        }
        if ($inv['status'] === 'VOID') {
            throw ApiException::conflict('ใบเรียกเก็บนี้ถูกยกเลิกแล้ว');
        }
        if ($inv['status'] === 'PAID') {
            throw ApiException::conflict('ใบเรียกเก็บนี้ชำระครบแล้ว');
        }
        $amount = Money::toSatang($input['amount'] ?? null, 'amount');
        if ($amount <= 0) {
            throw ApiException::badRequest('amount: ต้องมากกว่า 0');
        }
        $outstanding = (int) $inv['net_total_satang'] - (int) $inv['paid_satang'];
        $pending     = self::pendingSatang((int) $inv['id']);
        $remaining   = $outstanding - $pending;
        if ($amount > $remaining) {
            throw ApiException::badRequest($pending > 0
                ? 'แจ้งได้ไม่เกิน ' . Money::toBaht($remaining) . ' บาท (ค้าง ' . Money::toBaht($outstanding) . ' บาท และมีรายการรอตรวจสอบอยู่อีก ' . Money::toBaht($pending) . ' บาท)'
                : 'แจ้งได้ไม่เกินยอดค้าง ' . Money::toBaht($remaining) . ' บาท');
        }
        $paidAt = Period::assertDate($input['paidAt'] ?? Period::today(), 'paidAt');
        if ($paidAt > Period::today()) {
            throw ApiException::badRequest('paidAt: วันที่โอนต้องไม่เป็นอนาคต');
        }
        // เวลาที่โอน (HH:MM) — ไม่บังคับ แต่ช่วยให้ตรวจเทียบกับรายการเดินบัญชีง่ายขึ้นมาก
        $paidTime = ! empty($input['paidTime']) ? trim((string) $input['paidTime']) : null;
        if ($paidTime !== null && ! preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $paidTime)) {
            throw ApiException::badRequest('paidTime: ต้องเป็นเวลารูปแบบ HH:MM');
        }
        $id = Db::insert(
            'INSERT INTO payment_submissions
               (invoice_id, franchise_id, amount_satang, paid_at, paid_time, method, reference, slip_url, note, submitted_by_user_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
            [$inv['id'], $inv['franchise_id'], $amount, $paidAt, $paidTime, $input['method'] ?? null, $input['reference'] ?? null, $input['slipUrl'] ?? null, $input['note'] ?? null, $user['id']],
        );
        Audit::write((int) $user['id'], 'payment.submit', 'payment_submission', $id, ['invoiceId' => (int) $inv['id'], 'amount' => $amount]);

        // ส่วนกลางรู้ทันทีว่ามีสลิปรอตรวจ ไม่ต้องคอยเปิดเว็บเช็ค
        $submission = self::get($id, $user);
        $amountText = Money::fmt(Money::toBaht($amount));
        $shop       = TelegramService::escapeHtml($submission['franchiseUsername']);
        $invoiceNo  = TelegramService::escapeHtml($submission['invoiceNo']);
        NotificationService::notify('payment.submitted', implode("\n", [
            '💳 <b>สลิปใหม่รอตรวจ</b>',
            "ร้าน: <b>{$shop}</b> · บิล {$invoiceNo}",
            "ยอดแจ้ง: <b>{$amountText} บาท</b> · โอนวันที่ {$paidAt}" . ($paidTime ? " {$paidTime} น." : ''),
        ]), ['line' => "{$shop} {$amountText} บาท (บิล {$invoiceNo})"]);

        return $submission;
    }

    public static function get(int $id, array $user): array
    {
        $row = Db::one(self::SELECT . ' WHERE ps.id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการแจ้งชำระเงิน');
        if (! AuthContext::isSuperAdmin($user) && (int) $row['franchise_id'] !== (int) $user['franchise_id']) {
            throw ApiException::forbidden();
        }

        return self::serialize($row);
    }

    public static function list(array $filters, array $user): array
    {
        $where       = [];
        $params      = [];
        $franchiseId = AuthContext::isSuperAdmin($user) ? ($filters['franchiseId'] ?? null) : $user['franchise_id'];
        if ($franchiseId) {
            $where[]  = 'ps.franchise_id = ?';
            $params[] = (int) $franchiseId;
        }
        if (! empty($filters['status'])) {
            $where[]  = 'ps.status = ?';
            $params[] = $filters['status'];
        }
        if (! empty($filters['invoiceId'])) {
            $where[]  = 'ps.invoice_id = ?';
            $params[] = (int) $filters['invoiceId'];
        }
        if (! empty($filters['periodCode'])) {
            $where[]  = 'bp.code = ?';
            $params[] = $filters['periodCode'];
        }
        $rows = array_map([self::class, 'serialize'], Db::all(
            self::SELECT . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
            . " ORDER BY CASE ps.status WHEN 'PENDING' THEN 0 ELSE 1 END, ps.created_at DESC, ps.id DESC",
            $params,
        ));
        $sumOf = static fn (string $status) => array_sum(array_column(array_filter($rows, static fn ($r) => $r['status'] === $status), 'amount'));

        return [
            'items'   => $rows,
            'summary' => [
                'count'          => count($rows),
                'pendingCount'   => count(array_filter($rows, static fn ($r) => $r['status'] === 'PENDING')),
                'pendingAmount'  => Money::round2($sumOf('PENDING')),
                'approvedAmount' => Money::round2($sumOf('APPROVED')),
            ],
        ];
    }

    /** super admin ยืนยันว่าเงินเข้าจริง → ตัดยอดในใบเรียกเก็บทันที */
    public static function approve(int $id, array $input, array $user): array
    {
        $row = Db::one('SELECT * FROM payment_submissions WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการแจ้งชำระเงิน');
        if ($row['status'] !== 'PENDING') {
            throw ApiException::conflict("รายการนี้ถูกตรวจสอบไปแล้ว (สถานะ {$row['status']})");
        }
        $note = $input['note'] ?? null;

        return Db::tx(static function () use ($id, $row, $note, $user) {
            $result = InvoiceService::addPayment((int) $row['invoice_id'], [
                'amount'    => Money::toBaht($row['amount_satang']),
                'paidAt'    => $row['paid_at'],
                'method'    => $row['method'],
                'reference' => $row['reference'],
                'note'      => $note ?? $row['note'],
            ], $user, $id);

            Db::exec(
                "UPDATE payment_submissions
                    SET status = 'APPROVED', payment_id = ?, review_note = ?, reviewed_by_user_id = ?,
                        reviewed_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
                  WHERE id = ?",
                [$result['paymentId'], $note, $user['id'], $id],
            );
            Audit::write((int) $user['id'], 'payment.approve', 'payment_submission', $id);
            $done = self::get($id, $user);
            // ขอบคุณร้านทันทีที่ยืนยันรับเงิน — ใช้คำว่า "ทางเรา" ให้รู้สึกเป็นคู่ค้า
            NotificationService::notifyShop((int) $row['franchise_id'], implode("\n", [
                '🎉 <b>ขอบคุณครับ ทางเราได้รับเงินแล้ว</b>',
                NotificationService::baht($done['amount']) . ' บาท · บิล ' . TelegramService::escapeHtml($done['invoiceNo']),
                $done['invoiceOutstanding'] > 0
                    ? 'ยอดคงเหลือของบิลนี้ ' . NotificationService::baht($done['invoiceOutstanding']) . ' บาท'
                    : 'บิลนี้ชำระครบแล้ว ✓ ดูใบรับเงินได้ในระบบ',
            ]), 'payment.received');

            return $done;
        });
    }

    /** ปฏิเสธ เช่น สลิปไม่ชัด ยอดไม่ตรง หรือหาเงินเข้าไม่เจอ */
    public static function reject(int $id, array $input, array $user): array
    {
        $row = Db::one('SELECT * FROM payment_submissions WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการแจ้งชำระเงิน');
        if ($row['status'] !== 'PENDING') {
            throw ApiException::conflict("รายการนี้ถูกตรวจสอบไปแล้ว (สถานะ {$row['status']})");
        }
        $reason = $input['reason'] ?? '';
        if ($reason === '') {
            throw ApiException::badRequest('ต้องระบุเหตุผลที่ปฏิเสธ เพื่อให้ลูกค้าแก้ไขได้ถูก');
        }
        Db::exec(
            "UPDATE payment_submissions
                SET status = 'REJECTED', reject_reason = ?, reviewed_by_user_id = ?,
                    reviewed_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
              WHERE id = ?",
            [$reason, $user['id'], $id],
        );
        Audit::write((int) $user['id'], 'payment.reject', 'payment_submission', $id, ['reason' => $reason]);
        $rejected = self::get($id, $user);
        NotificationService::notifyShop($rejected['franchiseId'], implode("\n", [
            '📝 <b>สลิปต้องแก้ไขเล็กน้อย</b>',
            NotificationService::baht($rejected['amount']) . ' บาท · บิล ' . TelegramService::escapeHtml($rejected['invoiceNo']),
            'เหตุผล: ' . TelegramService::escapeHtml($reason),
            '',
            'ตรวจสอบแล้วแจ้งชำระใหม่ในระบบได้เลยครับ',
        ]), 'payment.rejected');

        return $rejected;
    }

    /** ลูกค้ายกเลิกรายการที่ตัวเองแจ้งไว้ ถ้ายังไม่ถูกตรวจ */
    public static function cancel(int $id, array $user): array
    {
        $row = Db::one('SELECT * FROM payment_submissions WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการแจ้งชำระเงิน');
        if (! AuthContext::isSuperAdmin($user) && (int) $row['franchise_id'] !== (int) $user['franchise_id']) {
            throw ApiException::forbidden();
        }
        if ($row['status'] !== 'PENDING') {
            throw ApiException::conflict('ยกเลิกได้เฉพาะรายการที่ยังรอตรวจสอบ');
        }
        Db::exec("UPDATE payment_submissions SET status = 'CANCELLED', updated_at = UTC_TIMESTAMP() WHERE id = ?", [$id]);
        Audit::write((int) $user['id'], 'payment.cancel', 'payment_submission', $id);

        return self::get($id, $user);
    }

    /**
     * ตัวเลขข้างเมนู "บิลและการชำระ" — ต้องเบาเพราะโหลดทุกครั้งที่เปลี่ยนหน้า
     * ส่วนกลาง: สลิปรอตรวจ (งานที่ต้องทำ) · ร้าน: บิลที่ยังต้องจ่าย (แดงถ้ามีใบเลยกำหนด)
     */
    public static function navCounts(array $user): array
    {
        if (AuthContext::isSuperAdmin($user)) {
            $n = Db::int("SELECT COUNT(*) FROM payment_submissions WHERE status = 'PENDING'");

            return ['invoices' => ['count' => $n, 'urgent' => false, 'title' => "สลิปรอตรวจ {$n} รายการ"]];
        }
        $row     = Db::one(
            "SELECT COUNT(*) AS n, SUM(CASE WHEN due_date < ? THEN 1 ELSE 0 END) AS overdue
               FROM invoices WHERE franchise_id = ? AND status IN ('OPEN', 'PARTIAL')",
            [Period::today(), $user['franchise_id']],
        );
        $n       = (int) $row['n'];
        $overdue = (int) ($row['overdue'] ?? 0);

        return ['invoices' => [
            'count'  => $n,
            'urgent' => $overdue > 0,
            'title'  => $overdue ? "บิลค้าง {$n} ใบ (เลยกำหนด {$overdue})" : "บิลที่ต้องจ่าย {$n} ใบ",
        ]];
    }

    /** หน้าชำระเงินของลูกค้า: ใบที่ยังค้าง + ประวัติการแจ้ง */
    public static function center(array $user, mixed $franchiseFilter = null): array
    {
        $franchiseId = AuthContext::isSuperAdmin($user) ? $franchiseFilter : $user['franchise_id'];
        $ids         = array_column(Db::all(
            "SELECT i.id FROM invoices i
              WHERE i.status IN ('OPEN', 'PARTIAL') " . ($franchiseId ? 'AND i.franchise_id = ?' : '') . '
              ORDER BY i.due_date, i.id',
            $franchiseId ? [(int) $franchiseId] : [],
        ), 'id');
        $invoices    = array_map(static fn ($id) => InvoiceService::get((int) $id, $user), $ids);
        $submissions = self::list(['franchiseId' => $franchiseId], $user);

        return [
            'outstandingInvoices' => $invoices,
            'totalOutstanding'    => Money::round2(array_sum(array_column($invoices, 'outstanding'))),
            'submissions'         => $submissions['items'],
            'summary'             => $submissions['summary'],
        ];
    }

    public static function serialize(array $row): array
    {
        return [
            'id'                 => (int) $row['id'],
            'invoiceId'          => (int) $row['invoice_id'],
            'invoiceNo'          => $row['invoice_no'],
            'invoiceStatus'      => $row['invoice_status'],
            'invoiceNetTotal'    => Money::toBaht($row['net_total_satang']),
            'invoiceOutstanding' => Money::toBaht((int) $row['net_total_satang'] - (int) $row['paid_satang']),
            'periodCode'         => $row['period_code'],
            'franchiseId'        => (int) $row['franchise_id'],
            'franchiseUsername'  => $row['franchise_username'],
            'amount'             => Money::toBaht($row['amount_satang']),
            'paidAt'             => $row['paid_at'],
            'paidTime'           => $row['paid_time'] ?? null,
            'method'             => $row['method'],
            'reference'          => $row['reference'],
            'slipUrl'            => SignedUrl::sign($row['slip_url']),
            'note'               => $row['note'],
            'status'             => $row['status'],
            'rejectReason'       => $row['reject_reason'],
            'reviewNote'         => $row['review_note'] ?? null,
            'submittedBy'        => $row['submitted_by'],
            'reviewedBy'         => $row['reviewed_by'],
            'reviewedAt'         => $row['reviewed_at'],
            'createdAt'          => $row['created_at'],
        ];
    }
}
