<?php

namespace App\Libraries;

/**
 * ลิงก์ไฟล์อัปโหลด (สลิป / QR) แบบมีลายเซ็นและหมดอายุ — แบบ presigned URL ของ S3
 *
 * <img src> แนบ token เข้าระบบไม่ได้ จึงเปิดไฟล์ด้วย Authorization header ไม่ได้
 * แทนที่จะปล่อยให้ใครมีลิงก์ก็เปิดได้ตลอดไป: API เซ็นลิงก์ให้เฉพาะคนที่มีสิทธิ์เห็นข้อมูลนั้น
 * (ตรวจสิทธิ์ที่ตัว API ที่ส่งลิงก์ออกมาอยู่แล้ว) และลิงก์ใช้ได้แค่ชั่วคราว
 *
 * หมดอายุปัดขึ้นเป็นต้นชั่วโมงถัดไป + 1 ชม. — ลิงก์เดิมตลอดชั่วโมง เบราว์เซอร์จึง cache รูปได้
 * กุญแจแยกจาก jwtSecret: เปลี่ยน jwtSecret ตอนฉุกเฉินก็ไม่ทำให้ลิงก์ที่เพิ่งออกไปพังโดยไม่จำเป็น
 */
final class SignedUrl
{
    private const HOUR = 3600;

    private static function mac(string $name, int $exp): string
    {
        $key = hash('sha256', 'uploads:' . Secrets::encryptionKey(), true);

        return substr(self::b64url(hash_hmac('sha256', "{$name}|{$exp}", $key, true)), 0, 32);
    }

    private static function b64url(string $raw): string
    {
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }

    /** '/api/uploads/abc.png' → '/api/uploads/abc.png?exp=…&sig=…' (null ผ่านได้) */
    public static function sign(?string $url): ?string
    {
        if ($url === null || $url === '') {
            return $url === '' ? '' : null;
        }
        $parts = explode('/', $url);
        $name  = end($parts);
        $exp   = ((int) ceil(microtime(true) / self::HOUR) + 1) * self::HOUR;

        return "/api/uploads/{$name}?exp={$exp}&sig=" . self::mac($name, $exp);
    }

    public static function verify(string $name, mixed $exp, mixed $sig): bool
    {
        if (! is_string($sig) || ! is_string($exp) || ! preg_match('/^\d{1,12}$/', $exp)) {
            return false;
        }
        $e = (int) $exp;
        if ($e < time()) {
            return false;
        }

        return hash_equals(self::mac($name, $e), $sig);
    }
}
