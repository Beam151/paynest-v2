<?php

namespace App\Controllers\Api;

use App\Libraries\V;
use App\Services\Audit;
use App\Services\BackupService;
use App\Services\NotificationService;
use App\Services\TelegramService;
use App\Services\TurnstileService;

/**
 * หน้าตั้งค่าของส่วนกลาง — ช่องทางแจ้งเตือน (Telegram) เรื่องที่จะแจ้ง captcha หน้าเข้าสู่ระบบ และสำรองข้อมูล — /api/settings
 *
 * ทุกอย่างที่ "แก้" ต้องใส่รหัส 6 หลักก่อน (guard: elevated)
 * เพราะปิด/ย้ายการแจ้งเตือนได้ = คนร้ายที่ได้ session ไปจะปิดตาทุกคนก่อนลงมือ
 */
class Settings extends BaseApiController
{
    public function notifications()
    {
        return $this->json([...NotificationService::settingsView(), 'telegram' => TelegramService::status()]);
    }

    public function saveNotifications()
    {
        $hhmm = V::string()->regex(V::HHMM_RE, 'ต้องเป็นเวลา HH:MM');
        $body = V::parse(V::object([
            // ส่งมาเฉพาะเรื่องที่แก้ก็ได้ · เรื่องความปลอดภัย (ล็อกไว้) ไม่อยู่ในชุดที่แก้ได้
            'events'     => V::partialRecord(V::enum(NotificationService::configurableKeys()), V::enum(['instant', 'digest', 'off']))->optional(),
            'quietHours' => V::object(['enabled' => V::boolean(), 'from' => $hhmm, 'to' => $hhmm])->optional(),
            'digestTime' => $hhmm->optional(),
        ]), $this->body());

        return $this->json([...NotificationService::saveSettings($body, $this->user()), 'telegram' => TelegramService::status()]);
    }

    /* ── Telegram ─────────────────────────────────────────────── */

    private function telegramBody(): array
    {
        return V::parse(V::object([
            'botToken'  => V::string()->regex('/^\d+:[\w-]+$/', 'bot token ไม่ถูกรูปแบบ (ได้จาก @BotFather เช่น 123456:ABC-...)')->optional(),
            'chatId'    => V::string()->optional(),
            'chatTitle' => V::string()->optional(),
        ]), $this->body());
    }

    public function telegram()
    {
        return $this->json(TelegramService::status());
    }

    public function telegramTest()
    {
        return $this->json(TelegramService::sendTestMessage($this->user()));
    }

    public function telegramDiscover()
    {
        return $this->json(TelegramService::discoverChats($this->telegramBody()['botToken'] ?? null));
    }

    public function saveTelegram()
    {
        return $this->json(TelegramService::saveSettings($this->telegramBody(), $this->user()));
    }

    public function disableTelegram()
    {
        return $this->json(TelegramService::disable($this->user()));
    }

    /* ── captcha หน้าเข้าสู่ระบบ (Cloudflare Turnstile) ─────────────── */

    public function turnstile()
    {
        return $this->json(TurnstileService::status());
    }

    /** ต้องแนบ captchaToken จากช่องที่วาดด้วย site key ใหม่ — พิสูจน์ว่าคีย์คู่นี้ใช้กับโดเมนนี้ได้จริง */
    public function saveTurnstile()
    {
        $key  = V::string()->regex('/^[\w-]{10,200}$/', 'คีย์ไม่ถูกรูปแบบ — คัดลอกจากหน้า widget ใน Cloudflare');
        $body = V::parse(V::object([
            'siteKey'      => $key,
            'secret'       => $key,
            'captchaToken' => V::string()->min(1, 'ติ๊กช่องยืนยันก่อนบันทึก'),
        ]), $this->body());

        return $this->json(TurnstileService::save($body, $this->user()));
    }

    public function disableTurnstile()
    {
        return $this->json(TurnstileService::disable($this->user()));
    }

    /* ── สำรองข้อมูล — ดูสถานะ / สั่งสำรองทันที (เช่นก่อนอัปเดตระบบ) ── */

    public function backup()
    {
        return $this->json(BackupService::status());
    }

    public function runBackup()
    {
        $result = BackupService::run();
        Audit::write((int) $this->user()['id'], 'backup.run', 'backup', null, ['file' => $result['file']]);

        return $this->json([...BackupService::status(), 'justRan' => ['uploadsCopied' => $result['uploadsCopied'], 'removed' => $result['removed']]]);
    }
}
