<?php

namespace App\Controllers\Api;

use App\Libraries\ApiException;
use App\Libraries\AuthContext;
use App\Libraries\Clock;
use App\Libraries\Period;
use App\Services\ReportService;

/** รายงาน · หน้าแรก · อันดับร้าน — /api/reports (ส่วนกลาง + ร้านที่มีสิทธิ์ดูรายงาน) */
class Reports extends BaseApiController
{
    /** ตัวกรองร่วม + บังคับขอบเขตร้านค้าตามสิทธิ์ผู้เรียก */
    private function common(): array
    {
        $productId = $this->q('productId');

        return [
            AuthContext::franchiseScope($this->user(), $this->q('franchiseId')),
            $productId ? (int) $productId : null,
            $this->qRaw('status'),
        ];
    }

    /** รายรอบบิล (ครึ่งเดือน) */
    public function byPeriod()
    {
        [$franchiseId, $productId, $statuses] = $this->common();

        return $this->json(ReportService::byPeriod($this->q('from'), $this->q('to'), $franchiseId, $productId, $statuses));
    }

    /** รายเดือน พร้อมแยก H1/H2 ในแต่ละเดือน */
    public function byMonth()
    {
        [$franchiseId, $productId, $statuses] = $this->common();

        return $this->json(ReportService::byMonth($this->q('from'), $this->q('to'), $franchiseId, $productId, $statuses));
    }

    /** เทียบเดือนต่อเดือน หรือรอบบิลต่อรอบบิล */
    public function compare()
    {
        [$franchiseId, $productId, $statuses] = $this->common();

        return $this->json(ReportService::compare($this->q('granularity') ?? 'month', $this->q('current'), $this->q('previous'), $franchiseId, $productId, $statuses));
    }

    /** เทียบช่วงวันที่เดียวกันข้ามเดือน/ข้ามปี */
    public function compareRange()
    {
        [$franchiseId, $productId, $statuses] = $this->common();
        $q = [];
        foreach (['aStart', 'aEnd', 'bStart', 'bEnd', 'against'] as $key) {
            $q[$key] = $this->q($key);
        }

        return $this->json(ReportService::compareRange($q, $franchiseId, $productId, $statuses));
    }

    /** จัดอันดับตามร้าน / สินค้า */
    public function breakdown()
    {
        [$franchiseId, $productId, $statuses] = $this->common();

        return $this->json(ReportService::breakdown($this->q('from'), $this->q('to'), $this->q('groupBy') ?? 'franchise', $franchiseId, $productId, $statuses));
    }

    public function dashboard()
    {
        // ไม่ระบุรอบ = รอบของวันนี้ (นับวันแบบ UTC ตามตัวเดิม)
        $periodCode = $this->q('periodCode') ?? Period::fromDate(Clock::todayUtc())['code'];

        return $this->json(ReportService::dashboard($periodCode, AuthContext::franchiseScope($this->user(), $this->q('franchiseId'))));
    }

    /** ภาพของร้านในเครือ (อันดับ · จ่ายตรงเวลา · บิลที่เพิ่งจ่ายครบ) — ของร้านตัวเองเท่านั้น */
    public function standing()
    {
        $franchiseId = AuthContext::franchiseScope($this->user(), $this->q('franchiseId'));
        if (! $franchiseId) {
            throw ApiException::forbidden('ต้องระบุร้าน');
        }
        $periodCode = $this->q('periodCode') ?? Period::fromDate(Clock::todayUtc())['code'];

        return $this->json(ReportService::shopStanding($franchiseId, $periodCode));
    }
}
