<?php

namespace App\Controllers\Api;

use App\Libraries\AuthContext;
use App\Libraries\V;
use App\Services\AssignmentService;

/** การมอบหมายสินค้าให้ร้าน — /api/assignments · สินค้าชิ้นเดียวซ้อนสองร้านในช่วงเวลาเดียวกันไม่ได้ */
class Assignments extends BaseApiController
{
    public function create()
    {
        $body = V::parse(V::object([
            'productId'   => V::id(),
            'franchiseId' => V::id(),
            'startDate'   => V::date()->optional(),
            'endDate'     => V::date()->nullable()->optional(),
            'note'        => V::string()->optional(),
        ]), $this->body());

        return $this->json(AssignmentService::assign($body, (int) $this->user()['id']), 201);
    }

    public function index()
    {
        $productId = $this->q('productId');

        return $this->json(['items' => AssignmentService::list(
            $productId ? (int) $productId : null,
            AuthContext::franchiseScope($this->user(), $this->q('franchiseId')),
            $this->q('activeOn'),
        )]);
    }

    public function show(string $id)
    {
        return $this->json(AssignmentService::get(V::parseId($id)));
    }

    public function update(string $id)
    {
        $assignmentId = V::parseId($id);
        $body         = V::parse(V::object([
            'startDate' => V::date()->optional(),
            'endDate'   => V::date()->nullable()->optional(),
            'note'      => V::string()->nullable()->optional(),
        ]), $this->body());

        return $this->json(AssignmentService::update($assignmentId, $body, (int) $this->user()['id']));
    }

    /** ปิดสัญญา เพื่อย้ายสินค้าไปให้ร้านอื่นต่อได้ */
    public function end(string $id)
    {
        $body = V::parse(V::object(['endDate' => V::date()->optional()]), $this->bodyOrEmpty());

        return $this->json(AssignmentService::end(V::parseId($id), $body['endDate'] ?? null, (int) $this->user()['id']));
    }
}
