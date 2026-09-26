<?php

namespace App\Controllers\Api;

use App\Libraries\V;
use App\Services\ChargeItemService;

/** ค่าใช้จ่าย/ส่วนลดตั้งต้น — /api/charge-items · ร้านค้าอ่านได้ เพื่อให้เห็นว่ารายการที่โดนเรียกเก็บคืออะไร */
class ChargeItems extends BaseApiController
{
    public function index()
    {
        return $this->json(['items' => ChargeItemService::list($this->q('kind'), $this->q('status') ?? 'ACTIVE')]);
    }

    public function show(string $id)
    {
        return $this->json(ChargeItemService::get(V::parseId($id)));
    }

    public function create()
    {
        $body = V::parse(V::object([
            'name' => V::string()->min(1),
            'kind' => V::enum(['CHARGE', 'DISCOUNT']),
            // ตั้งได้อย่างเดียว อีกช่องส่ง null มาได้เพื่อบอกว่า "ไม่ใช้วิธีนี้"
            'defaultAmount' => V::amount()->nullable()->optional(),
            'defaultPct'    => V::pct()->nullable()->optional(),
            'description'   => V::string()->optional(),
        ]), $this->body());

        return $this->json(ChargeItemService::create($body, (int) $this->user()['id']), 201);
    }

    public function update(string $id)
    {
        $itemId = V::parseId($id);
        $body   = V::parse(V::object([
            'name'          => V::string()->min(1)->optional(),
            'description'   => V::string()->nullable()->optional(),
            'defaultAmount' => V::amount()->nullable()->optional(),
            'defaultPct'    => V::pct()->nullable()->optional(),
            'status'        => V::enum(['ACTIVE', 'ARCHIVED'])->optional(),
        ]), $this->body());

        return $this->json(ChargeItemService::update($itemId, $body, (int) $this->user()['id']));
    }
}
