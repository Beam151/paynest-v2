<?php

namespace App\Services;

use App\Libraries\Db;
use App\Libraries\Json;

/**
 * ประวัติการทำรายการ (audit log) — ทุกการแก้ข้อมูลสำคัญต้องเรียกตัวนี้
 * ขึ้นในหน้า "ประวัติรายการ" (ActivityService แปลงเป็นข้อความภาษาคน)
 */
final class Audit
{
    public static function write(?int $actorUserId, string $action, ?string $entity = null, ?int $entityId = null, mixed $detail = null): void
    {
        Db::exec(
            'INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())',
            [$actorUserId, $action, $entity, $entityId, $detail === null ? null : Json::encode(is_array($detail) ? Json::obj($detail) : $detail)],
        );
    }
}
