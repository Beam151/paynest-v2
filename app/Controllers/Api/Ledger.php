<?php

namespace App\Controllers\Api;

use App\Libraries\V;
use App\Services\LedgerService;

/** สมุดรายรับ-รายจ่ายของส่วนกลาง — /api/ledger · ร้านค้าและเซลไม่ควรเห็นต้นทุนฝั่งเรา */
class Ledger extends BaseApiController
{
    private static function shape(): array
    {
        return [
            'periodCode' => V::periodCode(),
            'kind'       => V::enum(['EXPENSE', 'INCOME'])->optional(),
            'label'      => V::string()->min(1, 'ต้องระบุชื่อรายการ'),
            'amount'     => V::amount(),
            'spentOn'    => V::string()->regex(V::DATE_RE, 'ต้องเป็นวันที่รูปแบบ YYYY-MM-DD')->optional(),
            'note'       => V::string()->optional(),
        ];
    }

    public function create()
    {
        return $this->json(LedgerService::create(V::parse(V::object(self::shape()), $this->body()), (int) $this->user()['id']), 201);
    }

    public function index()
    {
        return $this->json(LedgerService::list($this->q('periodCode')));
    }

    public function update(string $id)
    {
        $entryId = V::parseId($id);
        $body    = V::parse(V::object(self::shape())->partial()->omit(['periodCode']), $this->body());

        return $this->json(LedgerService::update($entryId, $body, (int) $this->user()['id']));
    }

    public function delete(string $id)
    {
        return $this->json(LedgerService::delete(V::parseId($id), (int) $this->user()['id']));
    }
}
