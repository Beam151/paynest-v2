<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Db;
use App\Libraries\SecretBox;
use Config\Paynest;
use RuntimeException;
use stdClass;
use Throwable;

/**
 * แจ้งเตือนออกนอกระบบทาง Telegram
 *
 * ใช้กับเรื่องที่แถบเตือนในระบบไม่พอ — คนที่ได้ session แอดมินไปกดรับทราบในระบบเองได้
 * แต่ลบข้อความที่ส่งเข้า Telegram ไปแล้วไม่ได้
 *
 * ทุกข้อความลง outbox ก่อน (telegram_outbox) แล้วค่อยส่ง:
 *   - ส่งทันทีหลังตอบผู้ใช้เสร็จ (PHP-FPM: fastcgi_finish_request — ผู้ใช้ไม่ต้องรอ Telegram)
 *   - ส่งไม่ผ่าน → ลองใหม่ 1, 2, 4, 8 … สูงสุด 60 นาที โดยงานตั้งเวลา (php spark schedule:run ทุกนาที)
 * ตั้งค่าในหน้าตั้งค่าแจ้งเตือน โดยต้องใส่รหัส 6 หลักก่อน (เส้นทางใช้ elevated)
 * เปลี่ยนหรือปิดเมื่อไหร่ กลุ่มเดิมได้รับข้อความทันที — คนร้ายย้ายปลายทางแจ้งเตือนแบบเงียบ ๆ ไม่ได้
 */
final class TelegramService
{
    private const MAX_ATTEMPTS = 8;

    private static ?array $settingsCache = null;
    private static bool $flushScheduled  = false;

    public static function settings(): array
    {
        if (self::$settingsCache === null) {
            $sealed              = SettingsService::get('telegram.botToken');
            self::$settingsCache = [
                'botToken' => $sealed ? SecretBox::open($sealed) : null,
                'chatId'   => SettingsService::get('telegram.chatId'),
            ];
        }

        return self::$settingsCache;
    }

    /** อ่านค่าตั้งใหม่จากฐานข้อมูลครั้งหน้า (โปรเซสที่รันค้าง เช่น schedule:work) */
    public static function refresh(): void
    {
        self::$settingsCache = null;
    }

    public static function isConfigured(): bool
    {
        $cfg = self::settings();

        return (bool) $cfg['botToken'] && (bool) $cfg['chatId'];
    }

    /** ข้อความที่ใส่ใน HTML ของ Telegram — ชื่อบัญชีมาจากคนพิมพ์ ต้อง escape ก่อน */
    public static function escapeHtml(mixed $value): string
    {
        return str_replace(['&', '<', '>'], ['&amp;', '&lt;', '&gt;'], (string) ($value ?? ''));
    }

    /** error ของการเชื่อมต่อบางตัวแนบ URL มาด้วย ซึ่งมี bot token อยู่ในนั้น — ห้ามเก็บลง DB หรือส่งกลับหน้าเว็บ */
    public static function scrub(?string $message, ?string ...$tokens): string
    {
        $text = $message ?? 'unknown error';
        try {
            $tokens[] = self::settings()['botToken'];
        } catch (Throwable) {
            // อ่านกุญแจไม่ได้ก็ขัดเฉพาะ token ที่ส่งมา
        }
        foreach ($tokens as $token) {
            if ($token) {
                $text = str_replace($token, '***', $text);
            }
        }

        return $text;
    }

    private static function callApi(string $botToken, string $method, array $payload = []): mixed
    {
        $url = rtrim(config(Paynest::class)->telegramApiBase, '/') . "/bot{$botToken}/{$method}";
        $ch  = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode($payload === [] ? new stdClass() : $payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
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
        $body = json_decode((string) $raw, true);
        if ($status < 200 || $status >= 300 || ! is_array($body) || empty($body['ok'])) {
            throw new RuntimeException(is_array($body) && isset($body['description']) ? (string) $body['description'] : "HTTP {$status}");
        }

        return $body['result'] ?? null;
    }

    private static function send(string $text, ?array $cfg = null): void
    {
        $cfg ??= self::settings();
        self::callApi((string) $cfg['botToken'], 'sendMessage', [
            'chat_id'                  => (string) $cfg['chatId'],
            'text'                     => $text,
            'parse_mode'               => 'HTML',
            'disable_web_page_preview' => true,
        ]);
    }

    /**
     * จดข้อความลง outbox แล้วส่งหลังตอบผู้ใช้เสร็จ — ไม่ถ่วงคำขอของผู้ใช้
     * ยังไม่ได้ตั้งค่า Telegram = ไม่จดเลย (ไม่งั้นพอตั้งค่าทีหลังจะได้ข้อความเก่าท่วมทีเดียว)
     *
     * sendAfter (UTC 'Y-m-d H:i:s') = เลื่อนไปส่งทีหลัง เช่นพ้นช่วงห้ามรบกวน
     * chatId = ส่งถึงแชตส่วนตัว (ร้าน) · ไม่ใส่ = กลุ่มของส่วนกลาง
     */
    public static function queue(string $text, ?int $changeId = null, ?string $sendAfter = null, ?string $chatId = null): void
    {
        if (! self::isConfigured()) {
            return;
        }
        Db::insert(
            'INSERT INTO telegram_outbox (text, change_id, next_attempt_at, chat_id, created_at)
             VALUES (?, ?, COALESCE(?, UTC_TIMESTAMP()), ?, UTC_TIMESTAMP())',
            [$text, $changeId, $sendAfter, $chatId],
        );
        if ($sendAfter === null) {
            self::scheduleFlush();
        }
    }

    /**
     * ส่งตอนจบคำขอ — รอให้ transaction ที่เรียกเรา commit ก่อน แล้วปล่อยผู้ใช้ไปก่อนค่อยส่ง
     */
    private static function scheduleFlush(): void
    {
        if (self::$flushScheduled) {
            return;
        }
        self::$flushScheduled = true;
        register_shutdown_function(static function (): void {
            if (PHP_SAPI !== 'cli' && function_exists('fastcgi_finish_request')) {
                fastcgi_finish_request();
            }
            ignore_user_abort(true);
            try {
                self::flush();
            } catch (Throwable $e) {
                log_message('error', '[telegram] ' . self::scrub($e->getMessage()));
            }
        });
    }

    /**
     * ส่งข้อความที่ถึงคิว — หลาย process เรียกพร้อมกันได้โดยไม่ส่งซ้ำ (ล็อกระดับฐานข้อมูล)
     * ใครได้ล็อกคนนั้นส่งจนคิวหมด คนที่รอล็อกอยู่จะมาไล่ส่งของที่เหลือต่อ
     */
    public static function flush(): int
    {
        self::$settingsCache = null;
        if (! self::isConfigured()) {
            return 0;
        }
        if (! Db::lock('telegram.flush', 5)) {
            return 0;
        }
        $sent = 0;
        try {
            for ($round = 0; $round < 50; $round++) {
                [$tried, $ok] = self::drainDue();
                $sent += $ok;
                if ($tried < 20) {
                    break;
                }
            }
        } finally {
            Db::unlock('telegram.flush');
        }

        return $sent;
    }

    /** @return array{0: int, 1: int} [จำนวนที่ลองส่ง, จำนวนที่ส่งสำเร็จ] */
    private static function drainDue(): array
    {
        $due = Db::all(
            "SELECT * FROM telegram_outbox
              WHERE status = 'PENDING' AND next_attempt_at <= UTC_TIMESTAMP()
              ORDER BY id LIMIT 20",
        );
        $ok = 0;
        foreach ($due as $row) {
            try {
                $cfg = self::settings();
                if ($row['chat_id']) {
                    $cfg['chatId'] = $row['chat_id'];
                }
                self::send($row['text'], $cfg);
                Db::exec(
                    "UPDATE telegram_outbox SET status = 'SENT', attempts = attempts + 1, sent_at = UTC_TIMESTAMP(), last_error = NULL WHERE id = ?",
                    [$row['id']],
                );
                $ok++;
            } catch (Throwable $e) {
                $attempts = (int) $row['attempts'] + 1;
                // รอ 1, 2, 4, 8 … สูงสุด 60 นาที — Telegram ล่มครึ่งวันก็ยังส่งตามไปถึง
                $waitMin = min(2 ** ($attempts - 1), 60);
                Db::exec(
                    'UPDATE telegram_outbox
                        SET attempts = ?, last_error = ?, status = ?, next_attempt_at = UTC_TIMESTAMP() + INTERVAL ? MINUTE
                      WHERE id = ?',
                    [$attempts, self::scrub($e->getMessage()), $attempts >= self::MAX_ATTEMPTS ? 'FAILED' : 'PENDING', $waitMin, $row['id']],
                );
                log_message('error', "[telegram] ส่งไม่สำเร็จ (ครั้งที่ {$attempts}): " . self::scrub($e->getMessage()));
            }
        }

        return [count($due), $ok];
    }

    /*
     * อ่านข้อความที่มีคนส่งถึงบอท (getUpdates) — ไม่ต้องมี webhook จึงใช้ได้ทุกเครื่อง
     *   /start <รหัส> ในแชตส่วนตัว = ร้านกดลิงก์ผูกแชต → จับคู่กับบัญชีผู้ใช้
     *   ข้อความในกลุ่ม = จดกลุ่มไว้ให้ส่วนกลางเลือกตอนตั้งค่า
     */
    public static function poll(): void
    {
        self::$settingsCache = null;
        if (! self::isConfigured() || ! Db::lock('telegram.poll', 0)) {
            return;
        }
        try {
            $cfg     = self::settings();
            $offset  = (int) (SettingsService::get('telegram.updateOffset') ?? 0);
            $updates = self::callApi((string) $cfg['botToken'], 'getUpdates', [
                'offset'          => $offset,
                'timeout'         => 0,
                'allowed_updates' => ['message', 'my_chat_member'],
            ]);
            $updates = is_array($updates) ? $updates : [];
            foreach ($updates as $u) {
                $msg  = $u['message'] ?? null;
                $chat = $msg['chat'] ?? ($u['my_chat_member']['chat'] ?? null);
                if (is_array($chat) && ($chat['type'] ?? null) !== 'private') {
                    Db::exec(
                        'INSERT INTO telegram_known_chats (chat_id, title, type, seen_at) VALUES (?, ?, ?, UTC_TIMESTAMP())
                         ON DUPLICATE KEY UPDATE title = VALUES(title), type = VALUES(type), seen_at = UTC_TIMESTAMP()',
                        [(string) $chat['id'], $chat['title'] ?? null, $chat['type'] ?? null],
                    );
                }
                if (($msg['chat']['type'] ?? null) === 'private'
                    && preg_match('/^\/start\s+([A-Za-z0-9]{8,32})$/', trim((string) ($msg['text'] ?? '')), $m)) {
                    self::linkChatByCode($m[1], (string) $msg['chat']['id']);
                }
            }
            if ($updates !== []) {
                SettingsService::set('telegram.updateOffset', (string) ((int) end($updates)['update_id'] + 1));
            }
        } catch (Throwable $e) {
            log_message('error', '[telegram] อ่านข้อความไม่ได้: ' . self::scrub($e->getMessage()));
        } finally {
            Db::unlock('telegram.poll');
        }
    }

    /** ผูกแชตส่วนตัวกับผู้ใช้ตามรหัสที่ระบบออกให้ (อายุ 15 นาที ใช้ได้ครั้งเดียว) */
    private static function linkChatByCode(string $code, string $chatId): void
    {
        $row = Db::one('SELECT * FROM telegram_link_codes WHERE code = ? AND expires_at > UTC_TIMESTAMP()', [$code]);
        if ($row === null) {
            self::queue('ลิงก์นี้หมดอายุหรือใช้ไปแล้ว — กด "เชื่อม Telegram" ในหน้าบัญชีของฉันอีกครั้งครับ', chatId: $chatId);

            return;
        }
        $userId = (int) $row['user_id'];
        Db::exec('DELETE FROM telegram_link_codes WHERE code = ?', [$code]);
        Db::exec('UPDATE users SET telegram_chat_id = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [$chatId, $userId]);
        $user = Db::one(
            'SELECT u.username, u.display_name, f.username AS shop FROM users u LEFT JOIN franchises f ON f.id = u.franchise_id WHERE u.id = ?',
            [$userId],
        );
        Audit::write($userId, 'telegram.link', 'user', $userId);
        $name = ($user['display_name'] ?? '') ?: ($user['username'] ?? '');
        self::queue(implode("\n", [
            '✅ <b>เชื่อมต่อแล้ว</b>',
            'บัญชี ' . self::escapeHtml($name) . (! empty($user['shop']) ? ' · ร้าน ' . self::escapeHtml($user['shop']) : ''),
            '',
            'ต่อจากนี้จะแจ้งเมื่อ: บิลใหม่ออก · ใกล้ครบกำหนด · ทางเราได้รับเงินแล้ว · สลิปต้องแก้ไข',
        ]), chatId: $chatId);
    }

    /** สร้างลิงก์ผูกแชตให้ผู้ใช้ — กดแล้วเปิด Telegram กด Start ครั้งเดียวจบ */
    public static function createLinkCode(int $userId): array
    {
        if (! self::isConfigured()) {
            throw ApiException::badRequest('ยังไม่ได้เปิดระบบแจ้งเตือน Telegram — ติดต่อผู้ดูแลระบบ');
        }
        $botUsername = SettingsService::get('telegram.botUsername');
        if (! $botUsername) {
            throw ApiException::badRequest('ระบบยังไม่รู้ชื่อบอท — ให้ผู้ดูแลระบบบันทึกการตั้งค่า Telegram อีกครั้ง');
        }
        $code = substr(preg_replace('/[^A-Za-z0-9]/', '', rtrim(strtr(base64_encode(random_bytes(12)), '+/', '-_'), '=')) ?? '', 0, 16);
        Db::exec('DELETE FROM telegram_link_codes WHERE user_id = ?', [$userId]);
        Db::exec('INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL 15 MINUTE)', [$code, $userId]);

        return ['url' => "https://t.me/{$botUsername}?start={$code}", 'botUsername' => $botUsername];
    }

    /** ปุ่ม "ส่งข้อความทดสอบ" — ส่งตรงไม่ผ่าน outbox เพื่อให้เห็นผลทันทีว่าตั้งค่าถูกไหม */
    public static function sendTestMessage(array $actor): array
    {
        if (! self::isConfigured()) {
            return ['ok' => false, 'error' => 'ยังไม่ได้ตั้งค่า Telegram'];
        }
        try {
            self::send("✅ <b>ทดสอบการแจ้งเตือน</b>\nระบบจัดการร้านส่งข้อความเข้ากลุ่มนี้ได้แล้ว\nกดทดสอบโดย: " . self::who($actor));

            return ['ok' => true];
        } catch (Throwable $e) {
            return ['ok' => false, 'error' => self::scrub($e->getMessage())];
        }
    }

    public static function status(): array
    {
        self::$settingsCache = null;
        $configured          = self::isConfigured();
        $counts              = Db::one(
            "SELECT SUM(status = 'PENDING') AS pending, SUM(status = 'FAILED') AS failed, MAX(sent_at) AS last_sent_at
               FROM telegram_outbox",
        ) ?? [];
        $lastError = Db::val("SELECT last_error FROM telegram_outbox WHERE status <> 'SENT' AND last_error IS NOT NULL ORDER BY id DESC LIMIT 1");
        $chat      = (string) (SettingsService::get('telegram.chatId') ?? '');

        return [
            'configured' => $configured,
            // token ไม่ส่งออกไปเลย · chat โชว์แค่ชื่อกลุ่ม + ท้าย id พอให้รู้ว่าส่งเข้ากลุ่มไหน
            'chatHint'    => $configured ? '…' . substr($chat, -4) : null,
            'chatTitle'   => $configured ? SettingsService::get('telegram.chatTitle') : null,
            'botUsername' => $configured ? SettingsService::get('telegram.botUsername') : null,
            'pending'     => (int) ($counts['pending'] ?? 0),
            'failed'      => (int) ($counts['failed'] ?? 0),
            'lastSentAt'  => $counts['last_sent_at'] ?? null,
            'lastError'   => $lastError,
        ];
    }

    /* ── ตั้งค่าจากหน้าเว็บ (เส้นทางต้องผ่าน elevated ก่อนเสมอ) ──────── */

    private static function who(array $actor): string
    {
        return self::escapeHtml(($actor['display_name'] ?? '') ?: $actor['username']);
    }

    /**
     * หากลุ่มที่บอทอยู่ — คนตั้งค่าไม่ต้องไปเปิด getUpdates หา chat id เอง
     * ต้องมีคนพิมพ์อะไรสักอย่างในกลุ่มก่อน บอทถึงจะเห็นกลุ่มนั้น
     */
    public static function discoverChats(?string $botTokenInput): array
    {
        $current  = self::settings()['botToken'];
        $botToken = $botTokenInput ?: $current;
        if (! $botToken) {
            throw ApiException::badRequest('ใส่ bot token ก่อน');
        }
        try {
            $me      = self::callApi($botToken, 'getMe');
            $updates = self::callApi($botToken, 'getUpdates', ['limit' => 100, 'allowed_updates' => ['message', 'my_chat_member']]);
            $chats   = [];
            if (! $botTokenInput || $botTokenInput === $current) {
                foreach (Db::all('SELECT * FROM telegram_known_chats ORDER BY seen_at DESC') as $k) {
                    $chats['c' . $k['chat_id']] = ['id' => $k['chat_id'], 'title' => $k['title'] ?? '(ไม่มีชื่อ)', 'type' => $k['type']];
                }
            }
            foreach (is_array($updates) ? $updates : [] as $u) {
                $chat = $u['message']['chat'] ?? ($u['my_chat_member']['chat'] ?? null);
                if (is_array($chat) && ($chat['type'] ?? null) !== 'private') {
                    $id                = (string) $chat['id'];
                    $chats['c' . $id] = ['id' => $id, 'title' => $chat['title'] ?? '(ไม่มีชื่อ)', 'type' => $chat['type']];
                }
            }

            return ['botUsername' => $me['username'] ?? null, 'chats' => array_values($chats)];
        } catch (Throwable $e) {
            throw ApiException::badRequest('เชื่อมต่อบอทไม่ได้: ' . self::scrub($e->getMessage(), $botToken) . ' — ตรวจ token อีกครั้ง');
        }
    }

    /**
     * บันทึกปลายทาง — ต้องส่งข้อความเข้ากลุ่มใหม่ได้จริงก่อนถึงจะบันทึก
     * แล้วบอกกลุ่มเดิมว่าย้ายไปแล้ว (ถ้าคนร้ายย้าย กลุ่มเดิมจะรู้ทันที)
     */
    public static function saveSettings(array $input, array $actor): array
    {
        $old  = self::settings();
        $next = [
            'botToken' => ($input['botToken'] ?? '') ?: $old['botToken'],
            'chatId'   => trim((string) ($input['chatId'] ?? '')),
        ];
        if (! $next['botToken']) {
            throw ApiException::badRequest('ใส่ bot token ก่อน');
        }
        if (! preg_match('/^-?\d+$/', $next['chatId'])) {
            throw ApiException::badRequest('chat id ต้องเป็นตัวเลข (กลุ่มขึ้นต้นด้วย -)');
        }
        try {
            $me          = self::callApi($next['botToken'], 'getMe');
            $botUsername = $me['username'] ?? null;
            self::send("✅ <b>เชื่อมต่อแล้ว</b>\nกลุ่มนี้จะได้รับแจ้งเตือนเมื่อบัญชีรับเงินถูกเปลี่ยน\nตั้งค่าโดย: " . self::who($actor), $next);
        } catch (Throwable $e) {
            throw ApiException::badRequest('ส่งข้อความเข้ากลุ่มนี้ไม่ได้: ' . self::scrub($e->getMessage(), $next['botToken']) . ' — ตรวจว่าเพิ่มบอทเข้ากลุ่มแล้ว');
        }

        $moved = $old['botToken'] && $old['chatId'] && ($old['chatId'] !== $next['chatId'] || $old['botToken'] !== $next['botToken']);
        if ($moved) {
            try {
                self::send('⚠️ <b>ปลายทางแจ้งเตือนถูกย้ายออกจากกลุ่มนี้</b>' . "\nโดย: " . self::who($actor)
                    . "\n\nถ้าไม่ได้ตั้งใจย้าย: เปลี่ยนรหัสผ่านแอดมินทันที แล้วตั้งค่ากลับ", $old);
            } catch (Throwable $e) {
                log_message('error', '[telegram] แจ้งกลุ่มเดิมไม่ได้: ' . self::scrub($e->getMessage(), $old['botToken']));
            }
        }

        $actorId = (int) $actor['id'];
        SettingsService::set('telegram.botToken', SecretBox::seal($next['botToken']), $actorId);
        SettingsService::set('telegram.chatId', $next['chatId'], $actorId);
        SettingsService::set('telegram.chatTitle', isset($input['chatTitle']) ? (string) $input['chatTitle'] : null, $actorId);
        SettingsService::set('telegram.botUsername', $botUsername !== null ? (string) $botUsername : null, $actorId);
        self::$settingsCache = null;
        Audit::write($actorId, 'telegram.configure', 'setting', null, ['chatId' => $next['chatId'], 'moved' => (bool) $moved]);

        return self::status();
    }

    /** ปิดการแจ้งเตือน — บอกกลุ่มก่อนปิด (คนร้ายมักปิดแจ้งเตือนก่อนลงมือ) */
    public static function disable(array $actor): array
    {
        $old = self::settings();
        if ($old['botToken'] && $old['chatId']) {
            try {
                self::send('⛔ <b>การแจ้งเตือนบัญชีรับเงินถูกปิด</b>' . "\nโดย: " . self::who($actor)
                    . "\n\nถ้าไม่ได้ตั้งใจปิด: เปลี่ยนรหัสผ่านแอดมินทันที แล้วเปิดกลับ", $old);
            } catch (Throwable $e) {
                log_message('error', '[telegram] แจ้งกลุ่มเดิมไม่ได้: ' . self::scrub($e->getMessage(), $old['botToken']));
            }
        }
        foreach (['telegram.botToken', 'telegram.chatId', 'telegram.chatTitle', 'telegram.botUsername'] as $key) {
            SettingsService::set($key, null, (int) $actor['id']);
        }
        self::$settingsCache = null;
        // ข้อความค้างส่งของปลายทางเดิมไม่ต้องส่งแล้ว
        Db::exec("UPDATE telegram_outbox SET status = 'FAILED', last_error = 'ปิดการแจ้งเตือนแล้ว' WHERE status = 'PENDING'");
        Audit::write((int) $actor['id'], 'telegram.disable', 'setting');

        return self::status();
    }
}
