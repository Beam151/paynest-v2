<?php

namespace App\Libraries;

/**
 * ผู้ใช้ของคำขอนี้ (แถวจากตาราง users + สถานะร้าน/เซล) — ตั้งโดย ApiGuard หลังตรวจ token แล้ว
 * ค่าในนี้อยู่แค่คำขอเดียว (PHP เริ่มใหม่ทุกคำขอ)
 */
final class AuthContext
{
    private static ?array $user = null;

    public static function set(?array $user): void
    {
        self::$user = $user;
    }

    public static function user(): ?array
    {
        return self::$user;
    }

    public static function require(): array
    {
        if (self::$user === null) {
            throw ApiException::unauthorized();
        }

        return self::$user;
    }

    public static function isSuperAdmin(?array $user): bool
    {
        return ($user['role'] ?? null) === 'SUPER_ADMIN';
    }

    public static function isSales(?array $user): bool
    {
        return ($user['role'] ?? null) === 'SALES';
    }

    /** เจ้าของบัญชีร้าน = ยูสเซอร์แรกที่ super admin สร้างให้ตอนเปิดสาขา (คนเดียวที่จัดการผู้ช่วยได้) */
    public static function isFranchiseOwner(?array $user, int|string|null $franchiseId = null): bool
    {
        return ($user['role'] ?? null) === 'FRANCHISE'
            && (int) ($user['is_franchise_owner'] ?? 0) === 1
            && ($franchiseId === null || (int) $user['franchise_id'] === (int) $franchiseId);
    }

    /**
     * หาขอบเขตร้านที่ผู้เรียกมีสิทธิ์
     * - super admin: ได้ตามที่ขอ (ไม่ระบุ = ทุกร้าน → null)
     * - user ร้านค้า: ถูกบังคับเป็นของตัวเองเสมอ
     * - เซล: ไม่มีสิทธิ์ในเส้นทางนี้ (ใช้ /api/sales-agents/me แทน)
     */
    public static function franchiseScope(array $user, mixed $requestedId): ?int
    {
        $requested = $requestedId === null || $requestedId === '' || $requestedId instanceof Undefined
            ? null
            : Js::coerceNumber($requestedId);

        if (self::isSuperAdmin($user)) {
            // Number('abc') = NaN ในตัวเดิมก็คือหาไม่เจอ — ส่ง 0 ให้คิวรีไม่เจออะไรแทน
            return $requested === null ? null : (is_nan($requested) ? 0 : (int) $requested);
        }
        if (self::isSales($user)) {
            throw ApiException::forbidden('บัญชีเซลไม่มีสิทธิ์ดูข้อมูลยอดขายของร้าน');
        }
        if ($requested !== null && $requested !== (float) (int) $user['franchise_id']) {
            throw ApiException::forbidden('เข้าถึงข้อมูลของร้านอื่นไม่ได้');
        }

        return (int) $user['franchise_id'];
    }
}
