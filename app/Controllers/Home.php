<?php

namespace App\Controllers;

use App\Libraries\ApiResponse;
use App\Services\Scheduler;
use Throwable;

/**
 * หน้าเว็บหลังบ้าน (SPA ไม่ต้อง build) + จุดตรวจสุขภาพ
 * ไฟล์ js/css/รูป เว็บเซิร์ฟเวอร์เสิร์ฟตรงจาก public/ — ตรงนี้ส่งแค่หน้า HTML หลัก
 */
class Home extends BaseController
{
    public function index()
    {
        return $this->response
            ->setContentType('text/html', 'utf-8')
            ->setBody(view('spa'));
    }

    /**
     * ให้ตัวตรวจภายนอก (UptimeRobot ฯลฯ) เรียกทุก 5 นาที — ต้องลองแตะฐานข้อมูลจริง
     * ไม่งั้นแอปยังตอบได้แต่ฐานข้อมูลพัง ตัวตรวจจะนึกว่าปกติ · ไม่บอกเวอร์ชัน/รายละเอียดภายใน
     *
     * ตรวจงานตั้งเวลาด้วย: ระบบเดิมรันงานเบื้องหลังในโปรเซสเดียวกับเว็บ (เว็บขึ้น = งานเดิน)
     * รุ่นนี้พึ่ง cron — cron หยุดแล้วเว็บยังตอบปกติ แต่ไม่มีสำรองข้อมูล/เตือนร้าน และไม่มีใครรู้ตัว
     * เคยเดินแล้วเงียบไปเกิน 10 นาที = ล่ม · ยังไม่เคยเดินเลย = เพิ่งติดตั้ง ยังไม่ได้ตั้ง cron (ไม่นับ)
     */
    public function health()
    {
        try {
            $beat    = Scheduler::lastHeartbeat();
            $failing = $beat !== null && time() - $beat > Scheduler::DOWNTIME_SECONDS ? 'schedule' : null;
        } catch (Throwable) {
            $failing = 'database';
        }
        $response = $failing === null
            ? ApiResponse::json(['ok' => true, 'service' => 'paynest-backend'], 200, $this->response)
            : ApiResponse::json(['ok' => false, 'failing' => $failing], 503, $this->response);

        return $response->removeHeader('Cache-Control')->setHeader('Cache-Control', 'no-store');
    }

    /** เส้นทางที่ไม่มีอยู่ — ตอบ JSON เหมือน API (ไม่เผยหน้า error ของเฟรมเวิร์ก) */
    public function notFound()
    {
        return ApiResponse::errorOf(
            404,
            'ROUTE_NOT_FOUND',
            'ไม่พบ endpoint: ' . $this->request->getMethod() . ' /' . ltrim($this->request->getUri()->getPath(), '/'),
            $this->response,
        );
    }
}
