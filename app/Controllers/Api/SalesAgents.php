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
            'periodCode'   => $this->q('periodCode'),
            'fromPeriod'   => $this->q('fromPeriod'),
            'toPeriod'     => $this->q('toPeriod'),
        ], $this->user()));
    }

    /* ── ค่าคอม ───────────────────────────────────────────────── */

    public function commissions()
    {
        return $this->json(SalesAgentService::listCommissions([
            'salesAgentId' => $this->q('salesAgentId'),
            'franchiseId'  => $this->q('franchiseId'),
            'status'       => $this->q('status'),
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

    /* ── ดีล: เซลคนไหนถือสินค้าไหน ──────────────────────── */

    private static function linkShape(): array
    {
        return [
            'salesAgentId'  => V::id(),
            'productId'     => V::id(),
            'basis'         => V::enum(['COMMISSION', 'GROSS'])->optional(),
            'commissionPct' => V::pct()->nullable()->optional(),
            'fixedAmount'   => V::amount()->nullable()->optional(),
            'startDate'     => V::date()->optional(),
            'endDate'       => V::date()->nullable()->optional(),
            'note'          => V::string()->optional(),
        ];
    }

    /**
     * ผูกดีลได้หลายสินค้าในครั้งเดียว — เงื่อนไขร่วม (เซล ฐานที่คิด ช่วงเวลา) อยู่ชั้นนอก
     * ส่วน % กับค่าคงที่แยกรายสินค้าได้ เพราะของบางชิ้นอาจตกลงกันคนละเรต
     */
    public function createLinks()
    {
        $body = V::parse(V::object([
            'salesAgentId' => V::id(),
            'basis'        => V::enum(['COMMISSION', 'GROSS'])->optional(),
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
            'username' => $block['username'],
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
}
