<?php

namespace App\Controllers\Api;

use App\Libraries\ApiException;
use App\Libraries\Db;
use App\Libraries\V;
use App\Services\SalesService;
use Throwable;

/** ยอดขายรายครึ่งเดือน — /api/sales-entries · งานของส่วนกลางล้วน ๆ (ร้านมีหน้าที่ดูบิลแล้วชำระเท่านั้น) */
class SalesEntries extends BaseApiController
{
    private static function upsertSchema()
    {
        return V::object([
            'periodCode'  => V::periodCode(),
            'productId'   => V::id(),
            'grossAmount' => V::amount(), // ยอดเงินเต็มจากการขาย
            /*
             * ยอดส่วนต่างที่กรอกเอง (R21 · ไม่บังคับ) — ยอดบิลที่คิดมาแล้ว ออกบิลจะใช้ยอดนี้เป็นค่าตั้งต้น (เปลี่ยนเป็น % ได้ตอนออกบิล)
             * ไม่ส่งคีย์ = ค่าเดิมของรายการ · null = ล้าง · ตัวเลข = ตั้งใหม่ (0 ถึงยอดเต็ม เครื่องหมายเดียวกัน · ไม่เกิน 100 ล้านบาท)
             */
            'manualAmount' => V::amount()->nullable()->optional(),
            'units'       => V::coerceNumber()->int()->min(0)->optional(),
            'note'        => V::string()->optional(),
            'franchiseId' => V::id()->optional(),
        ]);
    }

    /** บันทึกยอดขายรายครึ่งเดือน — เรียกซ้ำด้วย periodCode + productId เดิมคือการแก้ไข */
    public function upsert()
    {
        return $this->json(SalesService::upsert(V::parse(self::upsertSchema(), $this->body()), $this->user()), 201);
    }

    public function bulk()
    {
        $items   = V::parse(V::object(['items' => V::array(self::upsertSchema())->min(1)->max(200)]), $this->body())['items'];
        $results = [];
        $errors  = [];
        foreach ($items as $index => $item) {
            try {
                $results[] = SalesService::upsert($item, $this->user());
            } catch (ApiException $e) {
                $errors[] = ['index' => $index, 'productId' => $item['productId'], 'message' => $e->getMessage(), 'code' => $e->errorCode];
            } catch (Throwable $e) {
                $constraint = Db::isConstraintError($e);
                $errors[]   = [
                    'index'     => $index,
                    'productId' => $item['productId'],
                    'message'   => $constraint ? 'ข้อมูลขัดกับข้อกำหนดของระบบ' : 'เกิดข้อผิดพลาดภายในระบบ',
                    'code'      => $constraint ? 'CONSTRAINT_VIOLATION' : 'INTERNAL_ERROR',
                ];
            }
        }

        return $this->json(['saved' => $results, 'errors' => $errors], $errors ? 207 : 201);
    }

    public function index()
    {
        return $this->json(SalesService::list([
            'franchiseId' => $this->q('franchiseId'),
            'productId'   => $this->q('productId'),
            'status'      => $this->q('status'),
            'periodCode'  => $this->q('periodCode'),
            'fromPeriod'  => $this->q('fromPeriod'),
            'toPeriod'    => $this->q('toPeriod'),
        ], $this->user()));
    }

    public function show(string $id)
    {
        return $this->json(SalesService::get(V::parseId($id), $this->user()));
    }

    public function approve(string $id)
    {
        return $this->json(SalesService::approve(V::parseId($id), $this->user()));
    }

    /** กลับเป็นร่างเพื่อแก้ยอดใหม่ (ใช้เมื่ออนุมัติไปแล้วแต่เลขผิด) */
    public function reopen(string $id)
    {
        return $this->json(SalesService::reopen(V::parseId($id), $this->user()));
    }

    public function delete(string $id)
    {
        return $this->json(SalesService::delete(V::parseId($id), $this->user()));
    }
}
