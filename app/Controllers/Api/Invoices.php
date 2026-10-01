<?php

namespace App\Controllers\Api;

use App\Filters\ApiGuard;
use App\Libraries\Money;
use App\Libraries\V;
use App\Services\InvoiceAttachmentService;
use App\Services\InvoiceService;
use App\Services\NotificationService;
use App\Services\TelegramService;
use Throwable;

/**
 * บิล · ค่าใช้จ่ายอื่น/ส่วนลดในบิล — /api/invoices
 *
 * ไม่มี endpoint ให้ส่วนกลาง "บันทึกรับชำระ" เองโดยตรง — ตั้งใจเอาออก
 * เงินเข้าระบบได้ทางเดียว: ร้านแจ้งชำระพร้อมสลิปที่ POST /api/payments
 * แล้วส่วนกลางตรวจและอนุมัติที่ POST /api/payments/:id/approve
 * ทุกบาทที่ตัดยอดจึงมีสลิปและผู้อนุมัติกำกับเสมอ ตรวจย้อนหลังได้
 */
class Invoices extends BaseApiController
{
    /** รายการค่าใช้จ่ายอื่น/ส่วนลด: เลือกจากรายการตั้งต้น (chargeItemId) หรือพิมพ์เองก็ได้ */
    private static function adjustmentSchema()
    {
        return V::object([
            'chargeItemId' => V::id()->optional(),
            'kind'         => V::enum(['CHARGE', 'DISCOUNT'])->optional(),
            'label'        => V::string()->min(1)->optional(),
            'amount'       => V::amount()->optional(),
            'pct'          => V::pct()->optional(),
            'note'         => V::string()->optional(),
        ]);
    }

    /**
     * วิธีคิดยอดรายบรรทัด — PCT คิดตาม % (ไม่ส่ง pct = % เดิมของรายการ) · MANUAL กรอกยอดที่เรียกเก็บเอง
     * (MANUAL ไม่ส่ง amount = ใช้ยอดส่วนต่างที่กรอกไว้ที่หน้ายอดขาย · ไม่มีที่กรอกไว้ = 400)
     * ไม่ส่งบรรทัดไหนมา = บรรทัดนั้นใช้ค่าที่เก็บไว้กับรายการ (ค่าตั้งต้นจากหน้ายอดขาย)
     */
    private static function lineModesSchema()
    {
        return V::array(V::object([
            'entryId' => V::id(),
            'mode'    => V::enum(['PCT', 'MANUAL']),
            'pct'     => V::pct()->optional(),
            'amount'  => V::amount()->optional(),
        ]))->max(500);
    }

    /** รูป/PDF ประกอบบิล — อัปโหลดผ่าน /api/uploads ก่อน แล้วส่ง url มา (ไม่รับลิงก์ภายนอก) */
    private static function attachmentsSchema()
    {
        return V::array(V::object([
            'url'     => V::string()->regex(InvoiceAttachmentService::UPLOAD_RE, 'ต้องแนบไฟล์ที่อัปโหลดผ่านระบบ (ไม่รับลิงก์ภายนอก)'),
            'caption' => V::string()->max(200, 'คำอธิบายรูปยาวได้ไม่เกิน 200 ตัวอักษร')->nullable()->optional(),
        ]));
    }

    /** ออกบิลหลายใบพร้อมกัน = ข้อความเดียว ไม่ท่วมกลุ่มทีละร้าน · แต่ละร้านได้ข้อความของตัวเอง */
    private function notifyIssued(array $list): void
    {
        foreach ($list as $inv) {
            if (empty($inv['franchiseId']) || $inv['netTotal'] <= 0) {
                continue; // บิล 0 บาท (หักยอดยกมาหมด) ไม่ต้องให้ร้านจ่าย
            }
            /*
             * ข้อความถึงร้านมีเลขบัญชีสำหรับโอน + คำเตือนให้ตรวจก่อนโอน — ร้านใช้ข้อความนี้เทียบกับหน้าเว็บทุกครั้ง
             * NotificationService โหลดบิลเอง (ผลของออกหลายร้านมีแค่ id ไม่มีบัญชี/สกุลเงิน)
             * บิลออกไปแล้วจริง ส่งข้อความพลาดต้องไม่ทำให้หน้าจอขึ้นว่าออกบิลไม่สำเร็จ (กดซ้ำจะชน "ออกไปแล้ว")
             * ส่วนกลางยังกด "ส่งเลขบัญชีให้ร้าน" ที่บิลซ้ำได้
             */
            try {
                NotificationService::notifyBillIssued((int) ($inv['invoiceId'] ?? $inv['id']), (int) $this->user()['id']);
            } catch (Throwable $e) {
                log_message('error', '[notifyBillIssued] ' . $e::class . ': ' . $e->getMessage());
                NotificationService::notifySystemError($e, $this->request->getMethod(), '/' . ltrim($this->request->getUri()->getPath(), '/'));
            }
        }
        $total = array_sum(array_map(static fn ($x) => (float) ($x['netTotal'] ?? 0), $list));
        $names = implode(', ', array_map(static fn ($x) => TelegramService::escapeHtml($x['invoiceNo']), $list));
        NotificationService::notify('invoice.issued', implode("\n", [
            '🧾 <b>ออกบิลใหม่ ' . count($list) . ' ใบ</b> รวม ' . Money::fmt($total) . ' บาท',
            $names,
            'โดย: ' . TelegramService::escapeHtml($this->user()['username']),
        ]), ['line' => count($list) . ' ใบ รวม ' . Money::fmt($total) . " บาท ({$names})"]);
    }

    /** ร้านไหนพร้อมออกบิล / ออกแล้ว / ยังไม่กรอกยอด ในรอบนี้ */
    public function readiness()
    {
        return $this->json(InvoiceService::readiness(V::parse(V::periodCode(), $this->q('periodCode'))));
    }

    /** ออกบิลหลายร้านพร้อมกัน — 207 เมื่อบางร้านไม่ผ่าน (ร้านที่ผ่านออกไปแล้วจริง) */
    public function generateBulk()
    {
        $body = V::parse(V::object([
            'periodCode'   => V::periodCode(),
            'franchiseIds' => V::array(V::id())->min(1, 'เลือกอย่างน้อยหนึ่งร้าน')->max(200),
            'dueDate'      => V::string()->regex(V::DATE_RE)->optional(),
        ]), $this->body());
        $result = InvoiceService::generateBulk($body, $this->user());
        if ($result['created'] !== []) {
            $this->notifyIssued(array_map(static fn ($c) => [...$c, 'periodCode' => $body['periodCode']], $result['created']));
        }

        return $this->json($result, $result['errors'] ? 207 : 201);
    }

    /** ออกใบเรียกเก็บของรอบบิล (รวมทุกรายการของร้านนั้นที่บันทึกไว้และยังไม่ถูกออกบิล) */
    public function generate()
    {
        $body = V::parse(V::object([
            'franchiseId' => V::id(),
            'periodCode'  => V::string()->regex(V::PERIOD_RE),
            'dueDate'     => V::string()->regex(V::DATE_RE)->optional(),
            'note'        => V::string()->optional(),
            'adjustments' => V::array(self::adjustmentSchema())->max(50)->optional(),
            // เลือกเฉพาะบางรายการ — ไม่ส่งมา = เอาทุกรายการที่ยังไม่ถูกออกบิลในรอบนั้น
            'entryIds' => V::array(V::id())->optional(),
            // บัญชีที่ให้ร้านโอนเข้า — ไม่ส่งมา = ใช้บัญชีหลัก
            'bankAccountId' => V::id()->optional(),
            // สกุลที่ให้ร้านจ่าย — ยอดในระบบยังเป็นบาทเสมอ
            'currency' => V::enum(['THB', 'USD'])->optional(),
            'lines'       => self::lineModesSchema()->optional(),
            'attachments' => self::attachmentsSchema()->max(InvoiceAttachmentService::MAX_PER_INVOICE, 'แนบได้สูงสุด 10 รูปต่อบิล')->optional(),
            // ค่าคอมเซลไม่ได้เลือกตอนออกบิลร้านแล้ว — ทำ "บิลค่าคอม" ทีหลัง (POST /api/sales-agents/:id/commission-bills)
        ]), $this->body());
        $inv = InvoiceService::generate($body, $this->user());
        $this->notifyIssued([$inv]);

        // อ่านบิลใหม่หลังส่ง Telegram — ตอนส่งระบบจดว่าแจ้งเลขบัญชีร้านแล้ว ถ้าตอบบิลก่อนส่ง accountCheck จะค้างเป็น "ยังไม่เคยแจ้ง"
        return $this->json(InvoiceService::get((int) $inv['id'], $this->user()), 201);
    }

    /**
     * แก้หัวบิล — บัญชีปลายทาง / วันครบกำหนด / หมายเหตุ (ตัวเลขในบิลแก้ผ่าน /adjustments)
     * เปลี่ยนบัญชีปลายทาง = เปลี่ยนว่าเงินของร้านไปเข้าที่ไหน ต้องยืนยันรหัส 6 หลักก่อน (แบบเดียวกับแก้บัญชีรับเงิน)
     * แก้แค่วันครบกำหนด/หมายเหตุไม่ต้องยืนยัน
     */
    public function update(string $id)
    {
        $invoiceId = V::parseId($id);
        $body      = V::parse(V::object([
            'bankAccountId' => V::id()->nullable()->optional(),
            'currency'      => V::enum(['THB', 'USD'])->optional(),
            'dueDate'       => V::string()->regex(V::DATE_RE)->optional(),
            'note'          => V::string()->optional(),
        ]), $this->body());
        if (InvoiceService::changesBankAccount($invoiceId, $body)) {
            ApiGuard::assertElevated($this->request);
        }

        return $this->json(InvoiceService::updateHeader($invoiceId, $body, $this->user()));
    }

    /** หนึ่งรอบออกได้ใบเดียว — รายการที่ตกหล่นจึงเพิ่มเข้าใบเดิมแทนการออกใบใหม่ */
    public function addLines(string $id)
    {
        $body = V::parse(V::object([
            'entryIds' => V::array(V::id())->optional(),
            'lines'    => self::lineModesSchema()->optional(),
        ]), $this->bodyOrEmpty());

        return $this->json(InvoiceService::addEntries(
            V::parseId($id),
            $body['entryIds'] ?? null,
            $this->user(),
            $body['lines'] ?? [],
        ));
    }

    /** แก้วิธีคิดยอดของบรรทัดเดียว (กรอกยอดเอง / คิดตาม %) ในบิลที่ยังไม่มีเงินเข้า · MANUAL ไม่ส่ง amount = ยอดที่กรอกไว้ที่หน้ายอดขาย */
    public function updateLine(string $id, string $entryId)
    {
        $body = V::parse(V::object([
            'mode'   => V::enum(['PCT', 'MANUAL']),
            'pct'    => V::pct()->optional(),
            'amount' => V::amount()->optional(),
        ]), $this->body());

        return $this->json(InvoiceService::updateLine(V::parseId($id), V::parseId($entryId), $body, $this->user()));
    }

    /** แนบรูป/PDF ประกอบบิลเพิ่ม (หลังร้านจ่ายแล้วก็แนบได้ — รูปไม่เปลี่ยนตัวเลขในบิล) */
    public function addAttachments(string $id)
    {
        $body = V::parse(V::object([
            'files' => self::attachmentsSchema()
                ->min(1, 'เลือกไฟล์อย่างน้อย 1 ไฟล์')
                ->max(InvoiceAttachmentService::MAX_PER_INVOICE, 'แนบได้สูงสุด 10 รูปต่อบิล'),
        ]), $this->body());

        return $this->json(InvoiceAttachmentService::add(V::parseId($id), $body['files'], $this->user()), 201);
    }

    public function removeAttachment(string $id, string $attachmentId)
    {
        return $this->json(InvoiceAttachmentService::remove(V::parseId($id), V::parseId($attachmentId), $this->user()));
    }

    /** ส่งเลขบัญชีปัจจุบันของบิลให้ร้านทาง Telegram (route บังคับยืนยันรหัส 6 หลัก) */
    public function notifyAccount(string $id)
    {
        return $this->json(InvoiceService::notifyAccount(V::parseId($id), $this->user()));
    }

    public function index()
    {
        return $this->json(InvoiceService::list([
            'franchiseId' => $this->q('franchiseId'),
            'status'      => $this->q('status'),
            'periodCode'  => $this->q('periodCode'),
            'unpaidOnly'  => $this->q('unpaidOnly'),
        ], $this->user()));
    }

    public function show(string $id)
    {
        return $this->json(InvoiceService::get(V::parseId($id), $this->user()));
    }

    /** ค่าใช้จ่ายอื่น / ส่วนลด ในใบเรียกเก็บ */
    public function addAdjustment(string $id)
    {
        $invoiceId = V::parseId($id);
        $body      = V::parse(self::adjustmentSchema(), $this->body());

        return $this->json(InvoiceService::addAdjustment($invoiceId, $body, $this->user()), 201);
    }

    public function removeAdjustment(string $id, string $adjustmentId)
    {
        return $this->json(InvoiceService::removeAdjustment(V::parseId($id), V::parseId($adjustmentId), $this->user()));
    }

    public function void(string $id)
    {
        // เหตุผลบังคับ — ประวัติต้องบอกได้ว่ายกเลิกเพราะอะไร (ออกผิดร้าน? ยอดผิด? ร้านปิด?)
        $body = V::parse(V::object([
            'reason' => V::string()->trim()->min(3, 'ต้องระบุเหตุผลที่ยกเลิก (อย่างน้อย 3 ตัวอักษร)'),
        ]), $this->bodyOrEmpty());
        $inv = InvoiceService::void(V::parseId($id), $body['reason'], $this->user());
        NotificationService::notify('invoice.voided', implode("\n", [
            '🗑 <b>ยกเลิกบิล</b>',
            'บิล <b>' . TelegramService::escapeHtml($inv['invoiceNo']) . '</b> · ร้าน ' . TelegramService::escapeHtml($inv['franchiseUsername']) . ' · ' . Money::fmt($inv['netTotal']) . ' บาท',
            'เหตุผล: ' . TelegramService::escapeHtml($body['reason']),
            'โดย: ' . TelegramService::escapeHtml($this->user()['username']),
        ]), ['line' => TelegramService::escapeHtml($inv['invoiceNo']) . ' (' . TelegramService::escapeHtml($inv['franchiseUsername']) . ') — ' . TelegramService::escapeHtml($body['reason'])]);

        return $this->json($inv);
    }
}
