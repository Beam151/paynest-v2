<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Db;
use App\Libraries\Money;

/**
 * ยอดที่ส่วนกลางติดค้างร้าน แล้วยกไปหักบิลรอบถัดไป
 *
 * เกิดเมื่อรอบไหนร้านคืนสินค้ามากกว่าที่ขายได้ ส่วนต่างรวมจึงติดลบ
 * แทนที่จะโอนเงินคืนร้าน (ซึ่งต้องเก็บเลขบัญชีร้าน = ความเสี่ยงที่ไม่จำเป็น)
 * ระบบจดไว้เป็นเครดิต แล้วหักออกจากบิลใบถัดไปให้เองจนหมด
 *
 * เครดิตก้อนเดียวหักได้หลายรอบ — ติดค้าง 5,000 แต่รอบหน้าบิลแค่ 2,000
 * ก็หัก 2,000 แล้วเหลือ 3,000 ยกไปรอบถัดไปอีก
 */
final class CreditService
{
    /** เครดิตที่ยังเหลือของร้าน เรียงเก่าก่อน — ก้อนที่ค้างนานที่สุดต้องได้คืนก่อน */
    public static function openCredits(int $franchiseId): array
    {
        return Db::all(
            "SELECT * FROM franchise_credits
              WHERE franchise_id = ? AND status = 'OPEN' AND remaining_satang > 0
              ORDER BY id",
            [$franchiseId],
        );
    }

    /** ยอดรวมที่ยังติดค้างร้านอยู่ (สตางค์) */
    public static function openTotal(int $franchiseId): int
    {
        return Db::int("SELECT COALESCE(SUM(remaining_satang), 0) FROM franchise_credits WHERE franchise_id = ? AND status = 'OPEN'", [$franchiseId]);
    }

    /**
     * คืนเครดิตที่บิลใบนี้เคยหักไปทั้งหมด
     * ต้องเรียกก่อนคำนวณยอดใหม่ทุกครั้ง เพื่อให้คิดจากเครดิตเต็มก้อนเสมอ ไม่งั้นแก้บิลสองรอบติดกันจะหักซ้ำซ้อน
     */
    public static function releaseCreditsOf(int $invoiceId): void
    {
        $usages = Db::all('SELECT * FROM credit_usages WHERE invoice_id = ?', [$invoiceId]);
        if ($usages === []) {
            return;
        }
        foreach ($usages as $u) {
            Db::exec(
                "UPDATE franchise_credits
                    SET remaining_satang = remaining_satang + ?, status = 'OPEN', updated_at = UTC_TIMESTAMP()
                  WHERE id = ?",
                [$u['amount_satang'], $u['credit_id']],
            );
        }
        Db::exec('DELETE FROM credit_usages WHERE invoice_id = ?', [$invoiceId]);
    }

    /**
     * หักเครดิตที่ร้านมีอยู่ออกจากยอดที่ต้องจ่าย — คืนจำนวนที่หักได้จริง
     * หักได้ไม่เกินยอดบิล ที่เหลือค้างไว้รอรอบถัดไป
     */
    public static function applyCreditsTo(int $invoiceId, int $franchiseId, int $payableSatang): int
    {
        if ($payableSatang <= 0) {
            return 0;
        }
        $left = $payableSatang;
        $used = 0;
        foreach (self::openCredits($franchiseId) as $credit) {
            if ($left <= 0) {
                break;
            }
            $amount = min((int) $credit['remaining_satang'], $left);
            Db::exec(
                "UPDATE franchise_credits
                    SET status = CASE WHEN remaining_satang - ? = 0 THEN 'USED' ELSE 'OPEN' END,
                        remaining_satang = remaining_satang - ?,
                        updated_at = UTC_TIMESTAMP()
                  WHERE id = ?",
                [$amount, $amount, $credit['id']],
            );
            Db::exec('INSERT INTO credit_usages (credit_id, invoice_id, amount_satang, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())', [$credit['id'], $invoiceId, $amount]);
            $left -= $amount;
            $used += $amount;
        }

        return $used;
    }

    /** จดยอดที่ติดลบไว้เป็นเครดิตของร้าน (เรียกตอนบิลออกมาแล้วยอดติดลบ) */
    public static function create(int $franchiseId, int $amountSatang, ?int $sourceInvoiceId, ?string $note, ?int $actorUserId): int
    {
        $id = Db::insert(
            'INSERT INTO franchise_credits (franchise_id, amount_satang, remaining_satang, source_invoice_id, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
            [$franchiseId, $amountSatang, $amountSatang, $sourceInvoiceId, $note],
        );
        Audit::write($actorUserId, 'credit.create', 'franchise_credit', $id, [
            'franchiseId'     => $franchiseId,
            'amount'          => Money::toBaht($amountSatang),
            'sourceInvoiceId' => $sourceInvoiceId,
        ]);

        return $id;
    }

    /**
     * เครดิตที่บิลใบนี้สร้างไว้ถูกหักไปใช้กับใบอื่นหรือยัง — ถ้าใช่ แก้/ยกเลิกใบนี้ไม่ได้
     * ไม่งั้นใบที่หักไปแล้วจะกลายเป็นเก็บเงินขาดย้อนหลังโดยไม่มีใครรู้
     */
    private static function assertUntouched(array $credits): void
    {
        foreach ($credits as $credit) {
            if ((int) $credit['remaining_satang'] >= (int) $credit['amount_satang']) {
                continue;
            }
            $users = array_column(Db::all(
                "SELECT i.invoice_no FROM credit_usages u
                   JOIN invoices i ON i.id = u.invoice_id
                  WHERE u.credit_id = ? AND i.status <> 'VOID'",
                [$credit['id']],
            ), 'invoice_no');

            throw ApiException::conflict(
                'ยอดยกไป ' . Money::toBaht($credit['amount_satang']) . ' บาท ของใบนี้ ถูกหักไปใช้กับบิล '
                . implode(', ', $users) . ' แล้ว — ต้องยกเลิกใบนั้นก่อน แล้วค่อยกลับมาจัดการใบนี้',
            );
        }
    }

    /**
     * ล้างเครดิตที่บิลใบนี้เคยสร้างไว้ เพื่อคิดใหม่ตั้งแต่ต้น
     * ใช้ตอนคำนวณยอดใหม่เท่านั้น จึงลบทิ้งเลย — ก้อนที่กำลังจะถูกสร้างแทนคือ "ตัวเดิมที่คิดใหม่"
     */
    public static function clearCreditsFrom(int $invoiceId): void
    {
        $credits = Db::all("SELECT * FROM franchise_credits WHERE source_invoice_id = ? AND status <> 'CANCELLED'", [$invoiceId]);
        if ($credits === []) {
            return;
        }
        self::assertUntouched($credits);
        Db::exec("DELETE FROM franchise_credits WHERE source_invoice_id = ? AND status <> 'CANCELLED'", [$invoiceId]);
    }

    /**
     * ยกเลิกเครดิตที่เกิดจากบิลใบนี้ (ใช้ตอนยกเลิกบิล)
     * ถ้าเครดิตถูกหักไปใช้กับบิลใบอื่นแล้ว ยกเลิกไม่ได้ — ให้ไปยกเลิกใบที่หักไปก่อน
     */
    public static function cancelCreditsFrom(int $invoiceId, int $actorUserId): void
    {
        $credits = Db::all("SELECT * FROM franchise_credits WHERE source_invoice_id = ? AND status <> 'CANCELLED'", [$invoiceId]);
        if ($credits === []) {
            return;
        }
        self::assertUntouched($credits);
        foreach ($credits as $credit) {
            Db::exec("UPDATE franchise_credits SET status = 'CANCELLED', remaining_satang = 0, updated_at = UTC_TIMESTAMP() WHERE id = ?", [$credit['id']]);
            Audit::write($actorUserId, 'credit.cancel', 'franchise_credit', (int) $credit['id'], ['reason' => 'ยกเลิกบิลต้นทาง', 'invoiceId' => $invoiceId]);
        }
    }

    public static function serialize(array $row): array
    {
        return [
            'id'              => (int) $row['id'],
            'franchiseId'     => (int) $row['franchise_id'],
            'amount'          => Money::toBaht($row['amount_satang']),
            'remaining'       => Money::toBaht($row['remaining_satang']),
            'used'            => Money::toBaht((int) $row['amount_satang'] - (int) $row['remaining_satang']),
            'sourceInvoiceId' => $row['source_invoice_id'] === null ? null : (int) $row['source_invoice_id'],
            'sourceInvoiceNo' => $row['source_invoice_no'] ?? null,
            'status'          => $row['status'],
            'note'            => $row['note'],
            'createdAt'       => $row['created_at'],
        ];
    }

    /** รายการเครดิตทั้งหมดของร้าน พร้อมเลขบิลต้นทาง ไว้โชว์ให้ร้านตรวจได้ว่ายอดมาจากไหน */
    public static function list(int $franchiseId): array
    {
        $rows = array_map([self::class, 'serialize'], Db::all(
            'SELECT c.*, i.invoice_no AS source_invoice_no
               FROM franchise_credits c
               LEFT JOIN invoices i ON i.id = c.source_invoice_id
              WHERE c.franchise_id = ?
              ORDER BY c.id DESC',
            [$franchiseId],
        ));

        return [
            'items'   => $rows,
            'summary' => [
                'open'  => Money::toBaht(self::openTotal($franchiseId)),
                'count' => count(array_filter($rows, static fn ($r) => $r['status'] === 'OPEN')),
            ],
        ];
    }
}
