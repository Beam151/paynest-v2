<?php

namespace App\Services;

use App\Libraries\Db;
use App\Libraries\Secrets;
use Config\Paynest;
use RuntimeException;

/**
 * แอดมินคนแรกของระบบ
 *
 * ไม่ตั้ง paynest.seedSuperAdminPass = สุ่มรหัสให้แล้วเขียนลงไฟล์ (แบบ Jenkins)
 * ไม่พิมพ์รหัสออก log — log มักถูกส่งไปเก็บที่อื่นที่คนเข้าถึงได้มากกว่า
 * ล็อกอินครั้งแรกต้องเปลี่ยนรหัส แล้วตั้ง Google Authenticator ก่อนถึงจะใช้งานได้
 *
 * ไม่มีรหัสสำรองในโค้ด — เซิร์ฟเวอร์ใหม่ที่เปิดพร้อม superadmin/admin1234 คือโดนยึดในนาทีแรก
 */
final class BootstrapService
{
    // รหัสที่เคยอยู่ใน README / เอกสาร — ถือว่าคนทั้งโลกรู้แล้ว
    private const PUBLISHED_PASSWORDS = ['admin1234', 'franchise1234', 'staff123456', 'sale1234567', 'password', '12345678'];

    public static function initialPasswordFile(): string
    {
        return config(Paynest::class)->dataPath('initial-admin-password.txt');
    }

    /** สร้าง super admin ตัวแรกถ้ายังไม่มี — คืนแถวผู้ใช้ที่สร้าง (มีอยู่แล้ว = null) */
    public static function ensureSuperAdmin(?string $password = null): ?array
    {
        if (Db::int("SELECT COUNT(*) FROM users WHERE role = 'SUPER_ADMIN'") > 0) {
            return null;
        }
        $config   = config(Paynest::class);
        $password ??= $config->seedSuperAdminPass !== '' ? $config->seedSuperAdminPass : null;
        $initial  = $password;
        if ($initial === null) {
            $initial = rtrim(strtr(base64_encode(random_bytes(12)), '+/', '-_'), '=');
            Secrets::writePrivate(self::initialPasswordFile(), $initial . "\n");
        } elseif (strlen($initial) < 12 || in_array($initial, self::PUBLISHED_PASSWORDS, true)) {
            throw new RuntimeException('paynest.seedSuperAdminPass ต้องยาวอย่างน้อย 12 ตัวอักษร และห้ามใช้รหัสตัวอย่าง — หรือลบออกให้ระบบสุ่มให้');
        }
        $user = UserService::create([
            'username'    => $config->seedSuperAdminUser,
            'password'    => $initial,
            'displayName' => 'ผู้ดูแลระบบส่วนกลาง',
            'role'        => 'SUPER_ADMIN',
        ]);
        Db::exec('UPDATE users SET must_change_password = 1 WHERE id = ?', [$user['id']]);

        return $user;
    }
}
