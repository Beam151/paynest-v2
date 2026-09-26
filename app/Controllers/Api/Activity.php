<?php

namespace App\Controllers\Api;

use App\Services\ActivityService;

/**
 * ประวัติรายการ — /api/activity
 * เป็นของส่วนกลางล้วน ๆ (เห็นความเคลื่อนไหวของทุกร้านรวมกัน) จึงไม่เปิดให้ร้าน/เซลอ่าน
 */
class Activity extends BaseApiController
{
    public function index()
    {
        // actions=invoice,payment → จับทุก action ที่ขึ้นต้นด้วยคำเหล่านี้
        $raw     = $this->q('actions');
        $actions = $raw ? array_values(array_filter(array_map('trim', explode(',', $raw)), static fn ($s) => $s !== '')) : null;

        return $this->json(ActivityService::list($actions, $this->q('limit') ?? 20, $this->q('offset') ?? 0));
    }
}
