<?php

namespace App\Controllers\Api;

use App\Libraries\AuthContext;
use App\Libraries\Period;
use App\Libraries\V;
use App\Services\PeriodService;

/** รอบบิลครึ่งเดือน (H1 = 1–15, H2 = 16–สิ้นเดือน) และอัตรา USD — /api/periods */
class Periods extends BaseApiController
{
    /*
     * ขอช่วง from–to = สร้างรอบที่ยังไม่มีให้ครบช่วง — ให้เฉพาะส่วนกลาง
     * ร้านค้าได้แค่รอบที่มีอยู่แล้ว ไม่งั้นยิง GET ไม่กี่ครั้งก็ถมรอบบิลขยะเข้า dropdown ของทุกคน
     */
    public function index()
    {
        $rows = PeriodService::list($this->q('from'), $this->q('to'), $this->q('limit') ?? 24, AuthContext::isSuperAdmin($this->user()));

        return $this->json(['items' => array_map([PeriodService::class, 'serialize'], $rows)]);
    }

    /** รอบของวันนี้มีได้รอบเดียว สร้างให้ได้ — แต่ร้านเลือกวันที่เองไม่ได้ (กันสร้างรอบปี 2199) */
    public function current()
    {
        $date = AuthContext::isSuperAdmin($this->user()) && $this->q('date') ? $this->q('date') : Period::today();

        return $this->json(PeriodService::serialize(PeriodService::ensure(Period::fromDate($date))));
    }

    public function show(string $code)
    {
        return $this->json(PeriodService::serialize(PeriodService::getByCode($code)));
    }

    /**
     * อัตราแลกเปลี่ยนของรอบ — ตั้งก่อนออกบิล เพื่อให้บิลที่ออกในรอบนั้นตรึงอัตรานี้ไว้
     * ส่ง usdRate: null เพื่อล้างค่า (รอบที่ไม่มีอัตราก็แค่ไม่โชว์ยอดดอลลาร์)
     */
    public function usdRate(string $code)
    {
        $body = V::parse(V::object(['usdRate' => V::amount()->nullable()]), $this->body());
        PeriodService::ensure($code);

        return $this->json(PeriodService::serialize(PeriodService::setUsdRate($code, $body['usdRate'], (int) $this->user()['id'])));
    }

    public function status(string $code)
    {
        $body = V::parse(V::object(['status' => V::enum(['OPEN', 'LOCKED'])]), $this->body());
        PeriodService::ensure($code);

        return $this->json(PeriodService::serialize(PeriodService::setStatus($code, $body['status'])));
    }
}
