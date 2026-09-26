<?php

namespace App\Services;

use App\Libraries\Db;

/** ค่าตั้งระบบแบบ key/value — ที่เดียวสำหรับค่าที่แอดมินตั้งเองในหน้าเว็บ */
final class SettingsService
{
    public static function get(string $key): ?string
    {
        $value = Db::val('SELECT value FROM app_settings WHERE name = ?', [$key]);

        return $value === null ? null : (string) $value;
    }

    /** null = ลบค่าทิ้ง */
    public static function set(string $key, ?string $value, ?int $actorUserId = null): void
    {
        if ($value === null) {
            Db::exec('DELETE FROM app_settings WHERE name = ?', [$key]);

            return;
        }
        Db::exec(
            'INSERT INTO app_settings (name, value, updated_by, updated_at) VALUES (?, ?, ?, UTC_TIMESTAMP())
             ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)',
            [$key, $value, $actorUserId],
        );
    }
}
