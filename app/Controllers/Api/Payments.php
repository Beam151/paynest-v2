<?php

namespace App\Controllers\Api;

use App\Libraries\V;
use App\Services\InvoiceService;
use App\Services\PaymentSubmissionService;

/** แจ้งชำระ · ตรวจสลิป · เงินที่รับแล้ว — /api/payments */
class Payments extends BaseApiController
{
    /** ตัวเลขงานค้างข้างเมนู */
    public function navCounts()
    {
        return $this->json(PaymentSubmissionService::navCounts($this->user()));
    }

    /** หน้าชำระเงินของลูกค้า: ใบที่ค้างอยู่ + ประวัติการแจ้งชำระ */
    public function center()
    {
        return $this->json(PaymentSubmissionService::center($this->user(), $this->q('franchiseId')));
    }

    /** เงินที่รับเข้ามาจริงแล้ว (คนละเรื่องกับ "แจ้งชำระ" ที่ยังรอตรวจ) */
    public function received()
    {
        return $this->json(InvoiceService::listReceivedPayments([
            'franchiseId' => $this->q('franchiseId'),
            'periodCode'  => $this->q('periodCode'),
        ], $this->user()));
    }

    /** ใบที่ออกไปแล้วแต่ยังเก็บเงินไม่ได้ครบ */
    public function outstanding()
    {
        return $this->json(InvoiceService::list([
            'franchiseId' => $this->q('franchiseId'),
            'periodCode'  => $this->q('periodCode'),
            'unpaidOnly'  => true,
        ], $this->user()));
    }

    /** ลูกค้าแจ้งชำระเงิน (ยังไม่ตัดยอดจนกว่า super admin จะยืนยัน) */
    public function submit()
    {
        $body = V::parse(V::object([
            'invoiceId' => V::id(),
            'amount'    => V::amount(),
            'paidAt'    => V::date()->optional(),
            'paidTime'  => V::string()->regex(V::HHMM_RE, 'ต้องเป็นเวลารูปแบบ HH:MM')->optional(),
            'method'    => V::string()->optional(),
            'reference' => V::string()->optional(),
            /*
             * รับเฉพาะไฟล์ที่อัปโหลดผ่านระบบเท่านั้น ไม่รับลิงก์ภายนอก
             * ลิงก์ภายนอกพังได้ทุกเมื่อ แล้วหลักฐานการโอนก็หายไป — บังคับให้มีเสมอ
             */
            'slipUrl' => V::string()->regex('/^\/api\/uploads\/[0-9a-f]{32}\.(jpg|png|gif|webp|pdf)$/', 'ต้องแนบไฟล์สลิปที่อัปโหลดผ่านระบบ (ไม่รับลิงก์ภายนอก)'),
            'note'    => V::string()->optional(),
        ]), $this->body());

        return $this->json(PaymentSubmissionService::submit($body, $this->user()), 201);
    }

    public function index()
    {
        return $this->json(PaymentSubmissionService::list([
            'status'      => $this->q('status'),
            'franchiseId' => $this->q('franchiseId'),
            'invoiceId'   => $this->q('invoiceId'),
            'periodCode'  => $this->q('periodCode'),
        ], $this->user()));
    }

    public function show(string $id)
    {
        return $this->json(PaymentSubmissionService::get(V::parseId($id), $this->user()));
    }

    public function approve(string $id)
    {
        $body = V::parse(V::object(['note' => V::string()->optional()]), $this->bodyOrEmpty());

        return $this->json(PaymentSubmissionService::approve(V::parseId($id), $body, $this->user()));
    }

    public function reject(string $id)
    {
        $body = V::parse(V::object(['reason' => V::string()->min(1, 'ต้องระบุเหตุผล')]), $this->body());

        return $this->json(PaymentSubmissionService::reject(V::parseId($id), $body, $this->user()));
    }

    /** ลูกค้ายกเลิกรายการที่ยังรอตรวจ */
    public function cancel(string $id)
    {
        return $this->json(PaymentSubmissionService::cancel(V::parseId($id), $this->user()));
    }
}
