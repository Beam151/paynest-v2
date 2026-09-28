<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Db;
use App\Libraries\SecretBox;
use Config\Paynest;
use RuntimeException;

/**
 * captcha หน้าเข้าสู่ระบบ (Cloudflare Turnstile) — โผล่เฉพาะบัญชีที่กำลังถูกเดารหัส ไม่ใช่ทุกคนทุกครั้ง
 *
 * ด่าน rate limit เดิมนับตาม IP — คนร้ายที่มีหลาย IP (botnet) ได้ลองคนละ 10 ครั้ง รวมกันแล้วเดาได้ไม่จำกัด
 * ด่านนี้นับตามชื่อบัญชีอย่างเดียว (ด่าน limit.login ใน ApiGuard) ใส่ผิดเกินกำหนดแล้วต้องผ่าน captcha ก่อน
 * ไม่ล็อกบัญชี — ไม่งั้นคนร้ายยิงรหัสผิดใส่ superadmin แล้วเจ้าของเข้าระบบไม่ได้แทน
 *
 * คีย์ตั้งในหน้าตั้งค่า (ต้องใส่รหัส 6 หลัก) · secret เข้ารหัสก่อนลงฐานข้อมูลเหมือน bot token ของ Telegram
 * ยังไม่ได้ตั้ง = ไม่มี captcha (ด่านอื่นยังทำงานครบ)
 */
final class TurnstileService
{
    /**
     * ใส่รหัสผิดเกินเท่านี้ภายใน 1 ชั่วโมง (รวมทุก IP) บัญชีนั้นต้องผ่าน captcha ก่อนล็อกอิน
     * เจ้าของระบบเลือก 5 — ต่ำกว่าด่านล็อก 10 ครั้งต่อ IP คนพิมพ์ผิดบ่อยจึงเจอ captcha ก่อนโดนล็อก
     */
    public const LOGIN_THRESHOLD = 4;
    public const LOGIN_WINDOW    = 3600;

    /** token ยาวสุด 2,048 ตัวตามเอกสารของ Cloudflare (ยาวกว่าเพดานข้อความทั่วไปของ JsonBody) */
    public const MAX_TOKEN = 2048;

    private static ?array $settingsCache = null;

    public static function settings(): array
    {
        if (self::$settingsCache === null) {
            $sealed              = SettingsService::get('turnstile.secret');
            self::$settingsCache = [
                'siteKey' => SettingsService::get('turnstile.siteKey'),
                'secret'  => $sealed ? SecretBox::open($sealed) : null,
            ];
        }

        return self::$settingsCache;
    }

    public static function isConfigured(): bool
    {
        $cfg = self::settings();

        return (bool) $cfg['siteKey'] && (bool) $cfg['secret'];
    }

    public static function status(): array
    {
        self::$settingsCache = null;
        $configured          = self::isConfigured();

        return [
            'configured' => $configured,
            // site key อยู่ในหน้าเว็บของทุกคนอยู่แล้ว (ไม่ลับ) · secret ไม่ส่งออกไปเลย
            'siteKey'   => $configured ? self::settings()['siteKey'] : null,
            'updatedAt' => $configured ? Db::val("SELECT updated_at FROM app_settings WHERE name = 'turnstile.secret'") : null,
            'threshold' => self::LOGIN_THRESHOLD,
        ];
    }

    /**
     * ตรวจ token ตอนล็อกอิน — ไม่ผ่านโยน ApiException ที่มี siteKey ใน details ให้หน้าเว็บวาดช่อง captcha
     *
     * ติดต่อ Cloudflare ไม่ได้ = ไม่ให้ผ่าน: กระทบเฉพาะบัญชีที่กำลังถูกเดารหัส
     * ถ้าปล่อยผ่าน คนร้ายได้ช่องเดาต่อทุกครั้งที่เน็ตฝั่งเซิร์ฟเวอร์สะดุด
     */
    public static function verifyLogin(mixed $token): void
    {
        $cfg     = self::settings();
        $details = ['siteKey' => $cfg['siteKey']];
        if (! is_string($token) || trim($token) === '') {
            throw new ApiException(403, 'CAPTCHA_REQUIRED', 'บัญชีนี้มีการใส่รหัสผิดหลายครั้ง — ยืนยันว่าไม่ใช่บอทก่อนเข้าสู่ระบบ', $details);
        }
        try {
            $result = self::siteverify((string) $cfg['secret'], $token);
        } catch (RuntimeException $e) {
            log_message('error', '[turnstile] ตรวจ token ไม่ได้: ' . $e->getMessage());

            throw new ApiException(503, 'CAPTCHA_UNAVAILABLE', 'ตรวจว่าไม่ใช่บอทไม่ได้ชั่วคราว — รอสักครู่แล้วลองใหม่', $details);
        }
        if (self::badSecret($result)) {
            // widget ถูกลบ/เปลี่ยน secret ใน Cloudflare โดยไม่ได้มาตั้งใหม่ที่นี่
            log_message('error', '[turnstile] secret key ใช้ไม่ได้แล้ว — ตั้งคีย์ใหม่ที่หน้าตั้งค่า');

            throw new ApiException(503, 'CAPTCHA_UNAVAILABLE', 'ระบบยืนยันว่าไม่ใช่บอทตั้งค่าไม่ถูกต้อง — แจ้งผู้ดูแลระบบ', $details);
        }
        if (! self::passed($result, 'login', (string) $cfg['secret'])) {
            throw new ApiException(403, 'CAPTCHA_INVALID', 'ยืนยันว่าไม่ใช่บอทไม่ผ่านหรือหมดเวลา — ลองใหม่อีกครั้ง', $details);
        }
    }

    /* ── ตั้งค่าจากหน้าเว็บ (เส้นทางต้องผ่าน elevated ก่อนเสมอ) ──────── */

    /**
     * บันทึกคีย์ — ต้องผ่านช่อง captcha จริงบนโดเมนนี้ด้วยคีย์ชุดใหม่ก่อน
     * site key ผิด / ยังไม่ได้ใส่โดเมนใน Cloudflare / คีย์คนละ widget = รู้ตอนตั้งค่า
     * ไม่ใช่ไปรู้ตอนร้านที่ถูกเดารหัสล็อกอินไม่ได้
     */
    public static function save(array $input, array $actor): array
    {
        $siteKey = trim((string) $input['siteKey']);
        $secret  = trim((string) $input['secret']);
        if (ENVIRONMENT === 'production' && self::isTestSecret($secret)) {
            throw ApiException::badRequest('นี่คือคีย์ทดสอบของ Cloudflare ซึ่งปล่อยผ่านทุกคน — ใช้บนเซิร์ฟเวอร์จริงไม่ได้ ให้สร้าง widget ของตัวเอง');
        }
        try {
            $result = self::siteverify($secret, (string) $input['captchaToken']);
        } catch (RuntimeException $e) {
            throw ApiException::badRequest('ติดต่อ Cloudflare ไม่ได้: ' . $e->getMessage() . ' — ลองใหม่อีกครั้ง');
        }
        if (self::badSecret($result)) {
            throw ApiException::badRequest('Secret key ไม่ถูกต้อง — คัดลอกจากหน้า widget ใน Cloudflare อีกครั้ง');
        }
        if (! self::passed($result, 'setup', $secret)) {
            throw ApiException::badRequest('ตรวจไม่ผ่าน — site key กับ secret key ต้องมาจาก widget เดียวกัน แล้วลองใหม่อีกครั้ง');
        }

        $actorId = (int) $actor['id'];
        SettingsService::set('turnstile.siteKey', $siteKey, $actorId);
        SettingsService::set('turnstile.secret', SecretBox::seal($secret), $actorId);
        self::$settingsCache = null;
        Audit::write($actorId, 'turnstile.configure', 'setting', null, ['siteKey' => $siteKey]);
        NotificationService::notify('security.captcha', implode("\n", [
            '🧩 <b>เปิด captcha หน้าเข้าสู่ระบบ</b>',
            'โดย: ' . self::who($actor),
            'บัญชีที่ถูกใส่รหัสผิดเกิน ' . self::LOGIN_THRESHOLD . ' ครั้งใน 1 ชั่วโมง ต้องยืนยันว่าไม่ใช่บอทก่อนเข้าระบบ',
        ]));

        return self::status();
    }

    /** ปิด — บอกกลุ่มทุกครั้ง (คนร้ายที่ได้บัญชีแอดมินไปอาจปิดก่อนไล่เดารหัสร้านอื่น) */
    public static function disable(array $actor): array
    {
        $actorId = (int) $actor['id'];
        SettingsService::set('turnstile.siteKey', null, $actorId);
        SettingsService::set('turnstile.secret', null, $actorId);
        self::$settingsCache = null;
        Audit::write($actorId, 'turnstile.disable', 'setting');
        NotificationService::notify('security.captcha', implode("\n", [
            '⚠️ <b>ปิด captcha หน้าเข้าสู่ระบบ</b>',
            'โดย: ' . self::who($actor),
            '',
            'ถ้าไม่ได้ตั้งใจปิด: เปลี่ยนรหัสผ่านแอดมินทันที แล้วเปิดกลับ',
        ]));

        return self::status();
    }

    /* ── ภายใน ─────────────────────────────────────────────────── */

    /**
     * ถาม Cloudflare ว่า token นี้ผ่านจริงไหม (token ใช้ได้ครั้งเดียว อายุ 5 นาที)
     * ไม่ส่ง remoteip — ถ้าตั้ง trustProxy ผิด IP จะไม่ตรงแล้วคนจริงโดนปฏิเสธ
     *
     * @return array{success?: bool, action?: string, error-codes?: list<string>}
     */
    private static function siteverify(string $secret, string $token): array
    {
        if (strlen($token) > self::MAX_TOKEN) {
            return ['success' => false, 'error-codes' => ['invalid-input-response']];
        }
        $ch = curl_init(config(Paynest::class)->turnstileVerifyUrl);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode(['secret' => $secret, 'response' => $token], JSON_UNESCAPED_SLASHES),
            CURLOPT_HTTPHEADER     => ['content-type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT        => 10,
        ]);
        $raw = curl_exec($ch);
        if ($raw === false) {
            $error = curl_error($ch);

            throw new RuntimeException($error !== '' ? $error : 'network error');
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $body   = json_decode((string) $raw, true);
        if ($status !== 200 || ! is_array($body) || in_array('internal-error', (array) ($body['error-codes'] ?? []), true)) {
            throw new RuntimeException("HTTP {$status}");
        }

        return $body;
    }

    private static function badSecret(array $result): bool
    {
        return array_intersect(['invalid-input-secret', 'missing-input-secret'], (array) ($result['error-codes'] ?? [])) !== [];
    }

    /**
     * ผ่าน + ออกมาจากช่อง captcha ของขั้นนี้จริง (login / setup) — token จากช่องตั้งค่าเอามาล็อกอินไม่ได้
     * คีย์ทดสอบของ Cloudflare ไม่ผูก action จึงข้ามการเทียบ (บนเซิร์ฟเวอร์จริงบันทึกคีย์ทดสอบไม่ได้อยู่แล้ว)
     */
    private static function passed(array $result, string $action, string $secret): bool
    {
        if (($result['success'] ?? false) !== true) {
            return false;
        }

        return self::isTestSecret($secret) || ($result['action'] ?? null) === $action;
    }

    /** secret สำหรับทดสอบของ Cloudflare: 1x…AA ผ่านเสมอ · 2x… ไม่ผ่านเสมอ · 3x… token ถูกใช้ไปแล้ว */
    private static function isTestSecret(string $secret): bool
    {
        return (bool) preg_match('/^[123]x0+AA$/', $secret);
    }

    private static function who(array $actor): string
    {
        return TelegramService::escapeHtml(($actor['display_name'] ?? '') ?: $actor['username']);
    }
}
