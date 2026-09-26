<?php

namespace App\Controllers\Api;

use App\Libraries\V;
use App\Services\AnnouncementService;
use App\Services\NotificationService;

/** ประกาศถึงร้าน · ใครอ่านแล้ว — /api/announcements (ทุกบทบาทอ่านได้ · ร้านเห็นเฉพาะที่อยู่ในช่วงเผยแพร่) */
class Announcements extends BaseApiController
{
    private static function schema()
    {
        return V::object([
            'title'    => V::string()->trim()->min(1, 'ต้องมีหัวข้อ')->max(120),
            'body'     => V::string()->trim()->min(1, 'ต้องมีรายละเอียด')->max(2000),
            'category' => V::enum(['NEWS', 'PROMO', 'PRODUCT', 'HOLIDAY'])->optional(),
            'pinned'   => V::boolean()->optional(),
            'startsAt' => V::date()->optional(),
            'endsAt'   => V::date()->nullable()->optional(),
        ]);
    }

    public function index()
    {
        return $this->json(AnnouncementService::list($this->user()));
    }

    public function read(string $id)
    {
        return $this->json(AnnouncementService::markRead(V::parseId($id), $this->user()));
    }

    public function create()
    {
        $created = AnnouncementService::create(V::parse(self::schema(), $this->body()), $this->user());
        // เริ่มแสดงวันนี้ = ส่งเข้า Telegram ของร้านทันที · ตั้งเวลาไว้ = ส่งตอนถึงวัน
        NotificationService::runAnnouncementPushes();

        return $this->json($created, 201);
    }

    public function readers(string $id)
    {
        return $this->json(AnnouncementService::readers(V::parseId($id), $this->user()));
    }

    public function update(string $id)
    {
        $announcementId = V::parseId($id);

        return $this->json(AnnouncementService::update($announcementId, V::parse(self::schema()->partial(), $this->body()), $this->user()));
    }

    public function delete(string $id)
    {
        return $this->json(AnnouncementService::delete(V::parseId($id), $this->user()));
    }
}
