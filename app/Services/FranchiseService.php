<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Clock;
use App\Libraries\Db;

final class FranchiseService
{
    /**
     * สร้างร้านค้า
     * username ตัวเดียวทำหน้าที่ทั้ง "ตัวระบุร้านค้า" และ "ชื่อผู้ใช้สำหรับเข้าระบบ"
     * (คอลัมน์ franchises.username เก็บค่าเดียวกับ users.username ของเจ้าของบัญชี)
     */
    public static function create(array $input, int $actorUserId): array
    {
        $username = trim($input['username']);
        if (Db::one('SELECT 1 FROM franchises WHERE LOWER(username) = LOWER(?)', [$username])) {
            throw ApiException::conflict("username \"{$username}\" ถูกใช้ไปแล้ว");
        }

        return Db::tx(static function () use ($input, $username, $actorUserId) {
            $franchiseId = Db::insert(
                'INSERT INTO franchises (username, contact_name, phone, email, address, note, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
                [$username, $input['contactName'] ?? null, $input['phone'] ?? null, $input['email'] ?? null, $input['address'] ?? null, $input['note'] ?? null],
            );

            // ยูสเซอร์เดียวที่ super admin สร้างให้ = เจ้าของบัญชีร้าน
            // ผู้ช่วยคนถัด ๆ ไป เจ้าของบัญชีเป็นคนเพิ่มเองจากหน้า "บัญชีของฉัน"
            $user = UserService::create([
                'username'    => $username,
                'password'    => $input['password'],
                'displayName' => $input['contactName'] ?? $username,
                'role'        => 'FRANCHISE',
                'franchiseId' => $franchiseId,
                'isOwner'     => true,
            ]);

            Audit::write($actorUserId, 'franchise.create', 'franchise', $franchiseId, ['username' => $username]);

            return ['franchise' => self::get($franchiseId), 'user' => UserService::serialize($user)];
        });
    }

    public static function get(?int $id): array
    {
        $row = $id ? Db::one('SELECT * FROM franchises WHERE id = ?', [$id]) : null;

        return self::serialize($row ?? throw ApiException::notFound('ไม่พบร้านค้า'));
    }

    public static function list(?string $status = null, ?string $q = null): array
    {
        $where  = [];
        $params = [Clock::todayUtc()];
        if ($status) {
            $where[]  = 'f.status = ?';
            $params[] = $status;
        }
        if ($q) {
            $where[]  = 'f.username LIKE ?';
            $params[] = "%{$q}%";
        }

        return array_map([self::class, 'serialize'], Db::all(
            'SELECT f.*,
                    (SELECT COUNT(*) FROM users u WHERE u.franchise_id = f.id) AS user_count,
                    (SELECT COUNT(*) FROM product_assignments a
                      WHERE a.franchise_id = f.id AND (a.end_date IS NULL OR a.end_date >= ?)) AS active_product_count
               FROM franchises f
               ' . ($where ? 'WHERE ' . implode(' AND ', $where) : '') . '
              ORDER BY f.username',
            $params,
        ));
    }

    private const UPDATABLE = [
        'contactName' => 'contact_name',
        'phone'       => 'phone',
        'email'       => 'email',
        'address'     => 'address',
        'note'        => 'note',
        'status'      => 'status',
    ];

    public static function update(int $id, array $patch, int $actorUserId): array
    {
        self::get($id);
        $sets   = [];
        $params = [];
        foreach (self::UPDATABLE as $key => $column) {
            if (array_key_exists($key, $patch)) {
                $sets[]   = "{$column} = ?";
                $params[] = $patch[$key];
            }
        }
        if ($sets === []) {
            return self::get($id);
        }
        $sets[]   = 'updated_at = UTC_TIMESTAMP()';
        $params[] = $id;
        Db::exec('UPDATE franchises SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
        Audit::write($actorUserId, 'franchise.update', 'franchise', $id, $patch);

        return self::get($id);
    }

    public static function serialize(?array $row): ?array
    {
        if ($row === null) {
            return null;
        }

        $out = [
            'id'          => (int) $row['id'],
            'username'    => $row['username'],
            'contactName' => $row['contact_name'],
            'phone'       => $row['phone'],
            'email'       => $row['email'],
            'address'     => $row['address'],
            'note'        => $row['note'],
            'status'      => $row['status'],
        ];
        // นับผู้ใช้/สินค้ามีเฉพาะตอนดึงเป็นรายการ — ดึงร้านเดียวไม่ส่งคีย์นี้ (แบบเดิม)
        if (array_key_exists('user_count', $row)) {
            $out['userCount'] = (int) $row['user_count'];
        }
        if (array_key_exists('active_product_count', $row)) {
            $out['activeProductCount'] = (int) $row['active_product_count'];
        }
        $out['createdAt'] = $row['created_at'];

        return $out;
    }
}
