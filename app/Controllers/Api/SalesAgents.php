<?php

namespace App\Controllers\Api;

use App\Libraries\ApiException;
use App\Libraries\AuthContext;
use App\Libraries\V;
use App\Services\SalesAgentService;
use App\Services\UserService;

/** เซล · ดีล · ค่าคอม — /api/sales-agents (ส่วนกลาง + เซล) */
class SalesAgents extends BaseApiController
{
    private static function userBlock(): array
    {
        return [
            'username'    => V::string()->min(3)->regex('/^[a-zA-Z0-9._-]+$/', 'ใช้ได้เฉพาะ a-z 0-9 . _ -'),
            'password'    => V::string()->min(8, 'รหัสผ่านอย่างน้อย 8 ตัวอักษร'),
            'displayName' => V::string()->optional(),
        ];
    }

    /**
     * เซลดูของตัวเอง / super admin ดูของเซลคนไหนก็ได้ด้วย ?salesAgentId=
     * (ใช้กับปุ่ม "ดูมุมมองนี้" ในหน้าเซล)
     */
    private function scopedAgentId(): int
    {
        $user = $this->user();
        if (! AuthContext::isSuperAdmin($user)) {
            return (int) $user['sales_agent_id'];
        }
        if (! $this->q('salesAgentId')) {
            throw ApiException::forbidden('super admin ต้องระบุ salesAgentId ว่าจะดูของเซลคนไหน');
        }

        return V::parseId($this->q('salesAgentId'));
    }

    public function me()
    {
        return $this->json(SalesAgentService::dashboard($this->scopedAgentId()));
    }

    public function myCommissions()
    {
        return $this->json(SalesAgentService::listCommissions([
            'salesAgentId' => $this->scopedAgentId(),
            'status'       => $this->q('status'),
            'kind'         => $this->q('kind'),
            'periodCode'   => $this->q('periodCode'),
            'fromPeriod'   => $this->q('fromPeriod'),
            'toPeriod'     => $this->q('toPeriod'),
        ], $this->user()));
    }

    /* ── ค่าคอม ───────────────────────────────────────────────── */

    /** kind = BILL (บิลค่าคอม) / DEAL / MANUAL (แบบเก่า) · periodCode, fromPeriod กรองได้เฉพาะแถวเก่า (บิลค่าคอมไม่มีรอบ) */
    public function commissions()
    {
        return $this->json(SalesAgentService::listCommissions([
            'salesAgentId' => $this->q('salesAgentId'),
            'franchiseId'  => $this->q('franchiseId'),
            'status'       => $this->q('status'),
            'kind'         => $this->q('kind'),
            'periodCode'   => $this->q('periodCode'),
            'fromPeriod'   => $this->q('fromPeriod'),
            'toPeriod'     => $this->q('toPeriod'),
        ], $this->user()));
    }

    private static function manualShape(): array
    {
        return [
            'salesAgentId' => V::id(),
            'periodCode'   => V::periodCode(),
            'label'        => V::string()->min(1, 'ต้องระบุชื่อรายการ'),
            'amount'       => V::amount(),
            'note'         => V::string()->optional(),
        ];
    }

    public function createManual()
    {
        $body = V::parse(V::object(self::manualShape()), $this->body());

        return $this->json(SalesAgentService::createManual($body, (int) $this->user()['id']), 201);
    }

    public function updateManual(string $id)
    {
        $body = V::parse(V::object(self::manualShape())->partial()->omit(['salesAgentId']), $this->body());

        return $this->json(SalesAgentService::updateManual(V::parseId($id), $body, (int) $this->user()['id']));
    }

    public function deleteManual(string $id)
    {
        return $this->json(SalesAgentService::deleteManual(V::parseId($id), (int) $this->user()['id']));
    }

    public function commission(string $id)
    {
        return $this->json(SalesAgentService::getCommission(V::parseId($id), $this->user()));
    }

    public function payCommission(string $id)
    {
        $body = V::parse(V::object(['paidAt' => V::date()->optional(), 'note' => V::string()->optional()]), $this->bodyOrEmpty());

        return $this->json(SalesAgentService::markPaid(V::parseId($id), $body, $this->user()));
    }

    /**
     * รายการที่ติ๊กทำบิลค่าคอมให้เซลคนนี้ได้ — บรรทัดบิลร้าน (สินค้าที่เซลถือดีล) + เหมาต่อรอบ
     */
    public function commissionCandidates(string $id)
    {
        return $this->json(SalesAgentService::commissionCandidates(V::parseId($id)));
    }

    /**
     * ทำบิลค่าคอม — ITEM: PCT ส่ง pct · MANUAL ส่ง amount (ส่งเฉพาะช่องของวิธีที่เลือก)
     * fixed: ไม่ส่ง amount = ใช้ยอดเหมาของดีล · others: ค่าคอมอื่น ๆ (ติดลบได้ = หักคืน) ไม่มีรอบ
     */
    public function createCommissionBill(string $id)
    {
        $body = V::parse(V::object([
            'items' => V::array(V::object([
                'entryId' => V::id(),
                'mode'    => V::enum(['PCT', 'MANUAL']),
                'pct'     => V::pct()->optional(),
                'amount'  => V::amount()->optional(),
            ]))->max(500, 'ทำบิลได้ครั้งละไม่เกิน 500 รายการ')->optional(),
            'fixed' => V::array(V::object([
                'key'    => V::string()->min(1)->max(64),
                'amount' => V::amount()->optional(),
            ]))->max(200, 'เหมาต่อรอบได้ครั้งละไม่เกิน 200 รายการ')->optional(),
            'others' => V::array(V::object([
                'label'  => V::string()->trim()->min(1, 'ต้องระบุชื่อรายการ')->max(200, 'ชื่อรายการยาวได้ไม่เกิน 200 ตัวอักษร'),
                'amount' => V::amount(),
            ]))->max(50, 'ค่าคอมอื่น ๆ ได้ครั้งละไม่เกิน 50 รายการ')->optional(),
            'note' => V::string()->max(500, 'หมายเหตุยาวได้ไม่เกิน 500 ตัวอักษร')->optional(),
        ]), $this->body());

        return $this->json(SalesAgentService::createCommissionBill(V::parseId($id), $body, $this->user()), 201);
    }

    /** ยกเลิกบิลค่าคอมที่ยังไม่จ่าย — รายการกลับไปให้ติ๊กทำบิลใหม่ได้ */
    public function voidCommission(string $id)
    {
        $body = V::parse(V::object([
            'reason' => V::string()->trim()->min(3, 'ต้องระบุเหตุผลที่ยกเลิก (อย่างน้อย 3 ตัวอักษร)')->max(500, 'เหตุผลยาวได้ไม่เกิน 500 ตัวอักษร'),
        ]), $this->bodyOrEmpty());

        return $this->json(SalesAgentService::voidCommission(V::parseId($id), $body['reason'], $this->user()));
    }

    /* ── ดีล: เซลคนไหนถือสินค้าไหน ──────────────────────── */

    private static function linkShape(): array
    {
        return [
            'salesAgentId'  => V::id(),
            'productId'     => V::id(),
            'commissionPct' => V::pct()->nullable()->optional(),
            'fixedAmount'   => V::amount()->nullable()->optional(),
            'startDate'     => V::date()->optional(),
            'endDate'       => V::date()->nullable()->optional(),
            'note'          => V::string()->optional(),
        ];
    }

    /**
     * ผูกดีลได้หลายสินค้าในครั้งเดียว — เซล (และหมายเหตุ) อยู่ชั้นนอก
     * ส่วน % กับเหมาต่อรอบแยกรายสินค้าได้ เพราะของบางชิ้นอาจตกลงกันคนละเรต
     * ไม่ต้องส่งวันที่ (เริ่มวันนี้ เปิดไว้จนกดปิดดีล) · % คิดจากยอดขายเต็มเสมอ — ส่ง basis มาก็ถูกตัดทิ้ง (V ไม่รับคีย์ที่ไม่รู้จัก)
     */
    public function createLinks()
    {
        $body = V::parse(V::object([
            'salesAgentId' => V::id(),
            'startDate'    => V::date()->optional(),
            'endDate'      => V::date()->nullable()->optional(),
            'note'         => V::string()->optional(),
            'items'        => V::array(V::object([
                'productId'     => V::id(),
                'commissionPct' => V::pct()->nullable()->optional(),
                'fixedAmount'   => V::amount()->nullable()->optional(),
            ]))->min(1, 'ต้องเลือกสินค้าอย่างน้อยหนึ่งรายการ'),
        ]), $this->body());
        $items = SalesAgentService::linkProducts($body, (int) $this->user()['id']);

        return $this->json(['items' => $items, 'count' => count($items)], 201);
    }

    public function links()
    {
        // เซลเห็นเฉพาะดีลของตัวเอง
        $user = $this->user();

        return $this->json(['items' => SalesAgentService::listLinks(
            AuthContext::isSuperAdmin($user) ? $this->q('salesAgentId') : $user['sales_agent_id'],
            $this->q('productId'),
            $this->q('franchiseId'),
            $this->q('activeOn'),
        )]);
    }

    public function link(string $id)
    {
        return $this->json(SalesAgentService::getLink(V::parseId($id)));
    }

    public function updateLink(string $id)
    {
        $body = V::parse(V::object(self::linkShape())->partial()->omit(['salesAgentId', 'productId']), $this->body());

        return $this->json(SalesAgentService::updateLink(V::parseId($id), $body, (int) $this->user()['id']));
    }

    public function endLink(string $id)
    {
        $body = V::parse(V::object(['endDate' => V::date()->optional()]), $this->bodyOrEmpty());

        return $this->json(SalesAgentService::endLink(V::parseId($id), $body['endDate'] ?? null, (int) $this->user()['id']));
    }

    /* ── จัดการเซล (super admin) ───────────────────────────────── */

    public function create()
    {
        $block = self::userBlock();
        $body  = V::parse(V::object([
            // username เดียวใช้ทั้งเป็นตัวระบุเซลและชื่อผู้ใช้สำหรับเข้าระบบ
            // เพดาน 40 ตัว: ชื่อเซลเป็นส่วนหนึ่งของเลขบิลค่าคอม (COM-YYYYMMDD-ชื่อ-N ต้องพอดี VARCHAR(64))
            'username' => $block['username']->max(40, 'ชื่อผู้ใช้เซลยาวได้ไม่เกิน 40 ตัวอักษร'),
            'password' => $block['password'],
            'name'     => V::string()->min(1),
            'phone'    => V::string()->optional(),
            'email'    => V::string()->optional(),
            'note'     => V::string()->optional(),
        ]), $this->body());

        return $this->json(SalesAgentService::create($body, (int) $this->user()['id']), 201);
    }

    public function index()
    {
        return $this->json(['items' => SalesAgentService::list($this->q('status'), $this->q('q'))]);
    }

    public function show(string $id)
    {
        $agentId = V::parseId($id);

        return $this->json([
            ...SalesAgentService::get($agentId),
            'links' => SalesAgentService::listLinks($agentId),
            'users' => array_map([UserService::class, 'serialize'], UserService::list(null, $agentId)),
        ]);
    }

    public function update(string $id)
    {
        $agentId = V::parseId($id);
        $body    = V::parse(V::object([
            'name'   => V::string()->min(1)->optional(),
            'phone'  => V::string()->nullable()->optional(),
            'email'  => V::string()->nullable()->optional(),
            'note'   => V::string()->nullable()->optional(),
            'status' => V::enum(['ACTIVE', 'INACTIVE'])->optional(),
        ]), $this->body());

        return $this->json(SalesAgentService::update($agentId, $body, (int) $this->user()['id']));
    }

    public function addUser(string $id)
    {
        $agentId = V::parseId($id);
        SalesAgentService::get($agentId);
        $body = V::parse(V::object(self::userBlock()), $this->body());

        return $this->json(UserService::serialize(UserService::create([...$body, 'role' => 'SALES', 'salesAgentId' => $agentId])), 201);
    }

    /**
     * ตั้งรหัสผ่านใหม่ให้ยูสเซอร์ของเซล (super) — หน้าเว็บสุ่มรหัส แล้วคัดลอกชุดเข้าระบบส่งให้เซล
     * mustChange = ให้เซลตั้งรหัสเองตอนเข้าครั้งแรก
     */
    public function resetUserPassword(string $id, string $userId)
    {
        $body = V::parse(V::object([
            'newPassword' => V::string()->min(8, 'รหัสผ่านอย่างน้อย 8 ตัวอักษร'),
            'mustChange'  => V::boolean()->optional(),
        ]), $this->body());

        return $this->json(SalesAgentService::resetUserPassword(
            V::parseId($id),
            V::parseId($userId),
            $body['newPassword'],
            ($body['mustChange'] ?? false) === true,
            (int) $this->user()['id'],
        ));
    }
}
