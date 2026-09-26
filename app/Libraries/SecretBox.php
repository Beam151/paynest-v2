<?php

namespace App\Libraries;

use RuntimeException;

/**
 * เข้ารหัสข้อมูลลับก่อนเก็บลงฐานข้อมูล (secret ของ 2FA, bot token ของ Telegram)
 *
 * AES-256-GCM — ถ้ามีคนแก้ข้อมูลที่เข้ารหัสไว้ ถอดรหัสจะล้มทันที ไม่ได้ค่าผิด ๆ กลับมา
 * กุญแจอยู่นอกฐานข้อมูล (paynest.encryptionKey หรือ secrets.json) — dump ฐานข้อมูลหลุดไปอย่างเดียวยังอ่านไม่ได้
 * รูปแบบ v1:iv:tag:data (base64) เดียวกับระบบเดิม — ย้ายข้อมูลข้ามมาได้ถ้าใช้กุญแจเดิม
 */
final class SecretBox
{
    private static function key(): string
    {
        return hash('sha256', Secrets::encryptionKey(), true);
    }

    public static function seal(string $plain): string
    {
        $iv   = random_bytes(12);
        $tag  = '';
        $data = openssl_encrypt($plain, 'aes-256-gcm', self::key(), OPENSSL_RAW_DATA, $iv, $tag, '', 16);
        if ($data === false) {
            throw new RuntimeException('encrypt failed');
        }

        return implode(':', ['v1', base64_encode($iv), base64_encode($tag), base64_encode($data)]);
    }

    public static function open(string $stored): string
    {
        $parts = explode(':', $stored);
        if (count($parts) !== 4 || $parts[0] !== 'v1') {
            throw new RuntimeException('unknown sealed format');
        }
        [, $iv, $tag, $data] = $parts;
        $plain = openssl_decrypt(
            (string) base64_decode($data, true),
            'aes-256-gcm',
            self::key(),
            OPENSSL_RAW_DATA,
            (string) base64_decode($iv, true),
            (string) base64_decode($tag, true),
        );
        if ($plain === false) {
            throw new RuntimeException('decrypt failed');
        }

        return $plain;
    }
}
