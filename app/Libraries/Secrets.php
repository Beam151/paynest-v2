<?php

namespace App\Libraries;

use Config\Paynest;
use RuntimeException;

/**
 * กุญแจลับ — ไม่ต้องตั้งเองก็ได้ ระบบสุ่มให้ครั้งแรกแล้วเก็บไว้ที่ writable/data/secrets.json
 * (อ่านได้เฉพาะเจ้าของไฟล์บนเซิร์ฟเวอร์) — แบบเดียวกับ Gitea / Jenkins
 * ตั้งใน .env ก็ได้ (paynest.jwtSecret / paynest.encryptionKey) ค่าใน env ชนะไฟล์เสมอ
 *
 * ไม่มีค่าสำรองที่เขียนตายในโค้ด — ใครอ่านโค้ดได้ต้องไม่เซ็น token เป็นแอดมินได้
 *
 * encryptionKey แยกจาก jwtSecret โดยตั้งใจ: เวลาฉุกเฉินเปลี่ยน jwtSecret (เตะทุกคนออก)
 * ได้โดยที่ 2FA ของทุกคนไม่พังตาม · ไฟล์ secrets.json ต้องสำรองไปพร้อมฐานข้อมูล
 */
final class Secrets
{
    private static ?array $loaded = null;

    public static function file(): string
    {
        return config(Paynest::class)->dataPath('secrets.json');
    }

    public static function jwtSecret(): string
    {
        return self::load()['jwtSecret'];
    }

    public static function encryptionKey(): string
    {
        return self::load()['encryptionKey'];
    }

    /** ล้างค่าที่จำไว้ (ใช้ในคำสั่งที่เปลี่ยนไฟล์กุญแจ) */
    public static function forget(): void
    {
        self::$loaded = null;
    }

    public static function load(): array
    {
        if (self::$loaded !== null) {
            return self::$loaded;
        }
        $config   = config(Paynest::class);
        $envJwt   = trim((string) $config->jwtSecret);
        $envKey   = trim((string) $config->encryptionKey);
        $fromFile = [];

        if ($envJwt === '' || $envKey === '') {
            $fromFile = self::loadOrCreateFile($envJwt === '', $envKey === '');
        }
        $secrets = [
            'jwtSecret'     => $envJwt !== '' ? $envJwt : $fromFile['jwtSecret'],
            'encryptionKey' => $envKey !== '' ? $envKey : $fromFile['encryptionKey'],
        ];

        foreach (['jwtSecret' => 'paynest.jwtSecret', 'encryptionKey' => 'paynest.encryptionKey'] as $key => $name) {
            if ($secrets[$key] === 'dev-only-change-me' || strlen($secrets[$key]) < 32) {
                throw new RuntimeException(
                    "{$name} สั้นกว่า 32 ตัวอักษรหรือเป็นค่าตัวอย่าง — ลบออกจาก .env ให้ระบบสุ่มให้ หรือใช้ openssl rand -base64 48",
                );
            }
        }

        return self::$loaded = $secrets;
    }

    private static function loadOrCreateFile(bool $needJwt, bool $needKey): array
    {
        $file   = self::file();
        $stored = [];
        if (is_file($file)) {
            $decoded = json_decode((string) file_get_contents($file), true);
            $stored  = is_array($decoded) ? $decoded : [];
        }
        $random = static fn (): string => base64_encode(random_bytes(48));
        $next   = [
            'jwtSecret'     => is_string($stored['jwtSecret'] ?? null) ? $stored['jwtSecret'] : $random(),
            'encryptionKey' => is_string($stored['encryptionKey'] ?? null) ? $stored['encryptionKey'] : $random(),
        ];
        $needsWrite = ($needJwt && ! isset($stored['jwtSecret'])) || ($needKey && ! isset($stored['encryptionKey']));
        if ($needsWrite) {
            self::writePrivate($file, json_encode($next, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        }

        return $next;
    }

    /** เขียนไฟล์ให้เจ้าของอ่านได้คนเดียว (600) — สร้างโฟลเดอร์ให้ถ้ายังไม่มี */
    public static function writePrivate(string $file, string $content): void
    {
        $dir = dirname($file);
        if (! is_dir($dir) && ! mkdir($dir, 0700, true) && ! is_dir($dir)) {
            throw new RuntimeException("สร้างโฟลเดอร์ {$dir} ไม่ได้ — ตรวจสิทธิ์การเขียนของโฟลเดอร์ writable/");
        }
        $old = umask(0077);
        try {
            if (file_put_contents($file, $content, LOCK_EX) === false) {
                throw new RuntimeException("เขียนไฟล์ {$file} ไม่ได้ — ตรวจสิทธิ์การเขียนของโฟลเดอร์ writable/");
            }
        } finally {
            umask($old);
        }
        @chmod($file, 0600);
    }
}
