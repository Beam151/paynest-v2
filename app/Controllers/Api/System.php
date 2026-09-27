<?php

namespace App\Controllers\Api;

use App\Services\VersionService;

/**
 * รุ่นของระบบ + เวลาอัปเดตล่าสุด — /api/system/version · ท้ายเมนูซ้าย และหน้าตั้งค่าของส่วนกลาง
 *
 * ต้องล็อกอินก่อน — /health ที่เปิดให้คนนอกเรียกไม่บอกรุ่นโดยตั้งใจ (คนนอกรู้รุ่นแล้วเลือกช่องโหว่ได้ตรงขึ้น)
 * ใช้บทบาทจริงของผู้ใช้ (ไม่ใช่มุมที่กำลังสวม) ตัดสินว่าได้รายละเอียดไหม
 */
class System extends BaseApiController
{
    public function version()
    {
        return $this->json(VersionService::info($this->user()['role'] === 'SUPER_ADMIN'));
    }
}
