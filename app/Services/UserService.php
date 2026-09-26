<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Db;
use App\Libraries\Json;
use App\Libraries\Permissions;

final class UserService
{
    private const COST = 10;

    /*
     * ใช้ตอนไม่พบชื่อผู้ใช้ — เทียบกับ hash หลอกให้เสียเวลาเท่าชื่อที่มีจริง
     * ไม่งั้นจับเวลาตอบกลับ (~2ms vs ~50ms) ก็รู้แล้วว่าชื่อไหนมีบัญชีอยู่
     * (bcrypt cost 10 ของคำว่า 'timing-equalizer' — ค่าคงที่ ไม่ต้องคำนวณใหม่ทุกคำขอ)
     */
    private const DUMMY_HASH = '$2y$10$FbLMBQUYDWqf4Td/rsWlnexGlw6VCbe3WXRDkQya1a.F6PvBIToXS';

    public static function hashPassword(string $plain): string
    {
        return password_hash($plain, PASSWORD_BCRYPT, ['cost' => self::COST]);
    }

    public static function verifyPassword(string $plain, string $hash): bool
    {
        return password_verify($plain, $hash);
    }

    public static function burnPasswordCheck(string $plain): void
    {
        password_verify($plain, self::DUMMY_HASH);
    }

    /**
     * @param array{username: string, password: string, displayName?: ?string, role: string,
     *              franchiseId?: ?int, salesAgentId?: ?int, isOwner?: bool, permissions?: ?array} $input
     */
    public static function create(array $input): array
    {
        $username = $input['username'];
        if (Db::one('SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)', [$username])) {
            throw ApiException::conflict("ชื่อผู้ใช้ \"{$username}\" ถูกใช้ไปแล้ว");
        }
        $permissions = $input['permissions'] ?? null;
        $id          = Db::insert(
            'INSERT INTO users (username, password_hash, display_name, role, franchise_id, sales_agent_id,
                                is_franchise_owner, permissions, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
            [
                $username,
                self::hashPassword($input['password']),
                $input['displayName'] ?? null,
                $input['role'],
                $input['franchiseId'] ?? null,
                $input['salesAgentId'] ?? null,
                ! empty($input['isOwner']) ? 1 : 0,
                // null = ไม่จำกัดสิทธิ์ (เจ้าของร้าน/super/เซล) ส่วนผู้ช่วยจะถูกส่งชุดสิทธิ์มาเสมอ
                $permissions === null ? null : Json::encode(Permissions::normalize($permissions) ?? []),
            ],
        );

        return self::getById($id);
    }

    // join เจ้าของข้อมูลมาด้วยเสมอ เพื่อให้ serialize มีชื่อ/รหัสให้หน้าเว็บใช้
    private const SELECT_USER = '
        SELECT u.*,
               f.username AS franchise_username,
               a.username AS agent_username,     a.name AS agent_name
          FROM users u
          LEFT JOIN franchises f   ON f.id = u.franchise_id
          LEFT JOIN sales_agents a ON a.id = u.sales_agent_id';

    public static function getById(int $id): array
    {
        return Db::one(self::SELECT_USER . ' WHERE u.id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบผู้ใช้');
    }

    public static function findByUsername(string $username): ?array
    {
        return Db::one(self::SELECT_USER . ' WHERE LOWER(u.username) = LOWER(?)', [$username]);
    }

    public static function list(?int $franchiseId = null, ?int $salesAgentId = null): array
    {
        $where  = [];
        $params = [];
        if ($franchiseId) {
            $where[]  = 'u.franchise_id = ?';
            $params[] = $franchiseId;
        }
        if ($salesAgentId) {
            $where[]  = 'u.sales_agent_id = ?';
            $params[] = $salesAgentId;
        }

        return Db::all(self::SELECT_USER . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY u.id', $params);
    }

    public static function setStatus(int $id, string $status): array
    {
        self::getById($id);
        Db::exec('UPDATE users SET status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [$status, $id]);

        return self::getById($id);
    }

    /** เปลี่ยนชุดสิทธิ์ของผู้ช่วย — เจ้าของร้านเป็นคนกด */
    public static function setPermissions(int $id, ?array $permissions): array
    {
        self::getById($id);
        Db::exec(
            'UPDATE users SET permissions = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
            [$permissions === null ? null : Json::encode(Permissions::normalize($permissions) ?? []), $id],
        );

        return self::getById($id);
    }

    /** ตั้งรหัสใหม่ + ทำให้ token ที่ออกไปก่อนหน้าทั้งหมดใช้ไม่ได้ (token_version) */
    public static function setPassword(int $id, string $password): void
    {
        self::getById($id);
        Db::exec(
            'UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = UTC_TIMESTAMP() WHERE id = ?',
            [self::hashPassword($password), $id],
        );
    }

    public static function touchLogin(int $id): void
    {
        Db::exec('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [$id]);
    }

    public static function serialize(?array $row): ?array
    {
        if ($row === null) {
            return null;
        }
        $out = [
            'id'           => (int) $row['id'],
            'username'     => $row['username'],
            'displayName'  => $row['display_name'],
            'role'         => $row['role'],
            'franchiseId'  => $row['franchise_id'] === null ? null : (int) $row['franchise_id'],
        ];
        // ช่องที่ไม่มีค่าไม่ส่งออกเลย (แบบ undefined ของตัวเดิม)
        if (($row['franchise_username'] ?? null) !== null) {
            $out['franchiseUsername'] = $row['franchise_username'];
        }
        if (($row['sales_agent_id'] ?? null) !== null) {
            $out['salesAgentId'] = (int) $row['sales_agent_id'];
        }
        if (($row['agent_username'] ?? null) !== null) {
            $out['agentUsername'] = $row['agent_username'];
        }
        if (($row['agent_name'] ?? null) !== null) {
            $out['agentName'] = $row['agent_name'];
        }

        return [
            ...$out,
            'isOwner'            => (int) $row['is_franchise_owner'] === 1,
            // null = ทำได้ทุกอย่าง · อาเรย์ = ทำได้เฉพาะที่ระบุ
            'permissions'        => Permissions::parse($row['permissions'] ?? null),
            'status'             => $row['status'],
            'lastLoginAt'        => $row['last_login_at'],
            'twoFactorEnabled'   => (bool) ($row['totp_enabled_at'] ?? null),
            'mustChangePassword' => (int) ($row['must_change_password'] ?? 0) === 1,
            'createdAt'          => $row['created_at'],
        ];
    }
}
