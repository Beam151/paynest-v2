<?php

namespace App\Libraries;

use Config\Paynest;

/**
 * JWT แบบ HS256 — token เข้าระบบ และ token ใช้งานเฉพาะอย่าง (purpose)
 *
 *   เข้าระบบ  { sub, role, franchiseId, salesAgentId, tv }        อายุตาม paynest.jwtExpiresIn
 *   mfa       { sub, purpose: 'mfa', tv }       ผ่านรหัสผ่านแล้ว รอรหัส 6 หลัก (5 นาที)
 *   elevate   { sub, purpose: 'elevate', tv }   เพิ่งยืนยันรหัส 6 หลัก ทำเรื่องอันตรายได้ (5 นาที)
 *
 * tv = token_version ของผู้ใช้ — เปลี่ยนรหัสผ่าน/เปิด-ปิด 2FA แล้ว token เก่าทุกใบใช้ไม่ได้ทันที
 * รับเฉพาะ HS256 เท่านั้น (alg=none หรืออัลกอริทึมอื่นถูกปฏิเสธ)
 */
final class Jwt
{
    public static function sign(array $payload, int $ttlSeconds): string
    {
        $now            = time();
        $payload['iat'] = $now;
        $payload['exp'] = $now + $ttlSeconds;

        $head = self::b64(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
        $body = self::b64(json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));

        return "{$head}.{$body}." . self::b64(hash_hmac('sha256', "{$head}.{$body}", Secrets::jwtSecret(), true));
    }

    /** token เข้าระบบของผู้ใช้ */
    public static function forUser(array $user): string
    {
        return self::sign([
            'sub'          => (int) $user['id'],
            'role'         => $user['role'],
            'franchiseId'  => isset($user['franchise_id']) ? (int) $user['franchise_id'] : null,
            'salesAgentId' => isset($user['sales_agent_id']) ? (int) $user['sales_agent_id'] : null,
            'tv'           => (int) ($user['token_version'] ?? 0),
        ], config(Paynest::class)->jwtTtl());
    }

    /** token ใช้งานเฉพาะอย่าง (อายุสั้น) */
    public static function forPurpose(array $user, string $purpose, int $ttlSeconds = 300): string
    {
        return self::sign(['sub' => (int) $user['id'], 'purpose' => $purpose, 'tv' => (int) ($user['token_version'] ?? 0)], $ttlSeconds);
    }

    /** คืน payload ถ้าลายเซ็นถูกและยังไม่หมดอายุ · ไม่งั้น null */
    public static function verify(mixed $token): ?array
    {
        if (! is_string($token) || $token === '') {
            return null;
        }
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            return null;
        }
        [$head, $body, $sig] = $parts;
        $header = json_decode((string) self::unb64($head), true);
        if (! is_array($header) || ($header['alg'] ?? null) !== 'HS256') {
            return null;
        }
        $expected = self::b64(hash_hmac('sha256', "{$head}.{$body}", Secrets::jwtSecret(), true));
        if (! hash_equals($expected, $sig)) {
            return null;
        }
        $payload = json_decode((string) self::unb64($body), true);
        if (! is_array($payload)) {
            return null;
        }
        $now = time();
        if (array_key_exists('exp', $payload) && (! is_int($payload['exp']) && ! is_float($payload['exp']) || $now >= $payload['exp'])) {
            return null;
        }
        if (array_key_exists('nbf', $payload) && (! is_int($payload['nbf']) && ! is_float($payload['nbf']) || $now < $payload['nbf'])) {
            return null;
        }

        return $payload;
    }

    /** token ใช้งานเฉพาะอย่าง — ต้องตรง purpose ที่ต้องการ */
    public static function verifyPurpose(mixed $token, string $purpose): ?array
    {
        $payload = self::verify($token);

        return $payload !== null && ($payload['purpose'] ?? null) === $purpose ? $payload : null;
    }

    /** อ่าน sub จาก token โดยไม่ตรวจลายเซ็น — ใช้แค่เป็นคีย์ของ rate limit (token ปลอมตกที่ขั้นตรวจลายเซ็นอยู่แล้ว) */
    public static function peekSubject(mixed $token): string
    {
        if (! is_string($token)) {
            return 'x';
        }
        $parts   = explode('.', $token);
        $payload = isset($parts[1]) ? json_decode((string) self::unb64($parts[1]), true) : null;
        $sub     = is_array($payload) ? ($payload['sub'] ?? null) : null;

        return is_scalar($sub) ? (string) $sub : 'x';
    }

    private static function b64(string $raw): string
    {
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }

    private static function unb64(string $text): string|false
    {
        return base64_decode(strtr($text, '-_', '+/'), true);
    }
}
