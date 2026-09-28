<?php

namespace App\Services;

use App\Libraries\Clock;
use App\Libraries\Db;
use App\Libraries\Js;
use App\Libraries\Json;
use App\Libraries\Money;
use App\Libraries\Period;
use App\Libraries\Permissions;
use DateTimeImmutable;
use Throwable;

/**
 * แจ้งเตือนส่วนกลาง — จุดเดียวที่ตัดสินว่าเรื่องไหนส่งเมื่อไร
 *
 * แต่ละเรื่องเลือกได้ในหน้าตั้งค่า: แจ้งทันที / รวมในสรุปรายวัน / ไม่แจ้ง
 * + ช่วงห้ามรบกวน (ข้อความ "ทันที" ที่เกิดในช่วงนั้นเลื่อนไปส่งตอนพ้นช่วง)
 *
 * เรื่องความปลอดภัย (locked) แจ้งทันทีเสมอ ไม่สนช่วงห้ามรบกวน และปิดไม่ได้
 * สิ่งแรกที่คนได้บัญชีแอดมินไปมักทำคือปิดการแจ้งเตือน — จึงไม่ให้ปิดเรื่องพวกนี้ตั้งแต่ต้น
 */
final class NotificationService
{
    public const EVENTS = [
        ['key' => 'bank_account.change', 'group' => 'security', 'label' => 'บัญชีรับเงินถูกเพิ่ม / แก้ / ลบ', 'locked' => true],
        ['key' => 'security.code_lockout', 'group' => 'security', 'label' => 'ใส่รหัส 6 หลักผิดจนถูกล็อก', 'locked' => true],
        ['key' => 'security.backup_code', 'group' => 'security', 'label' => 'ส่วนกลางล็อกอินด้วยรหัสสำรอง', 'locked' => true],
        ['key' => 'security.2fa_reset', 'group' => 'security', 'label' => 'ปลด Google Authenticator ของผู้ใช้', 'locked' => true],
        ['key' => 'security.captcha', 'group' => 'security', 'label' => 'เปิด / ปิด captcha หน้าเข้าสู่ระบบ', 'locked' => true],

        ['key' => 'security.login_lockout', 'group' => 'login', 'label' => 'มีคนเดารหัสผ่านจนถูกล็อก', 'default' => 'instant'],
        ['key' => 'security.login_captcha', 'group' => 'login', 'label' => 'บัญชีถูกใส่รหัสผิดหลายครั้ง จนต้องผ่าน captcha', 'default' => 'instant'],
        ['key' => 'login.admin', 'group' => 'login', 'label' => 'บัญชีส่วนกลางเข้าสู่ระบบ', 'default' => 'instant'],
        ['key' => 'login.shop', 'group' => 'login', 'label' => 'ร้านค้า / เซลเข้าสู่ระบบ', 'default' => 'off'],

        ['key' => 'payment.submitted', 'group' => 'money', 'label' => 'ร้านแจ้งชำระ (ส่งสลิป)', 'default' => 'instant'],
        ['key' => 'invoice.issued', 'group' => 'money', 'label' => 'ออกบิลใหม่', 'default' => 'digest'],
        ['key' => 'invoice.voided', 'group' => 'money', 'label' => 'ยกเลิกบิล', 'default' => 'instant'],

        ['key' => 'system.started', 'group' => 'system', 'label' => 'ระบบเริ่มทำงานใหม่ (เปิดเครื่อง / รีสตาร์ต / ล่มแล้วฟื้น)', 'default' => 'instant'],
        ['key' => 'system.error', 'group' => 'system', 'label' => 'ระบบขัดข้อง (เกิดข้อผิดพลาดที่ไม่คาดคิด)', 'default' => 'instant'],
        ['key' => 'system.disk', 'group' => 'system', 'label' => 'พื้นที่เก็บข้อมูลบนเซิร์ฟเวอร์ใกล้เต็ม', 'default' => 'instant'],
        // สำรองพังแล้วเงียบ = รู้ตัวตอนต้องกู้ข้อมูล ซึ่งสายไปแล้ว — ปิดไม่ได้
        ['key' => 'system.backup_failed', 'group' => 'system', 'label' => 'สำรองข้อมูลรายวันไม่สำเร็จ', 'locked' => true],

        ['key' => 'summary.overdue', 'group' => 'summary', 'label' => 'บิลที่เลยกำหนด (ยอดรวมและร้านที่ค้าง)', 'default' => 'digest', 'digestOnly' => true],
        ['key' => 'summary.pending_slips', 'group' => 'summary', 'label' => 'สลิปที่ยังรอตรวจ', 'default' => 'digest', 'digestOnly' => true],
    ];

    public const GROUPS = [
        'security' => 'ความปลอดภัย — แจ้งทันทีเสมอ',
        'login'    => 'การเข้าระบบ',
        'money'    => 'บิลและการชำระ',
        'system'   => 'ระบบ / เซิร์ฟเวอร์',
        'summary'  => 'สรุปประจำวัน',
    ];

    private const MODES         = ['instant', 'digest', 'off'];
    private const DEFAULT_QUIET = ['enabled' => false, 'from' => '22:00', 'to' => '07:00'];
    private const MODE_LABEL    = ['instant' => 'แจ้งทันที', 'digest' => 'สรุปรายวัน', 'off' => 'ไม่แจ้ง'];

    public static function event(string $key): ?array
    {
        foreach (self::EVENTS as $ev) {
            if ($ev['key'] === $key) {
                return $ev;
            }
        }

        return null;
    }

    /** @return list<string> เรื่องที่แอดมินเลือกได้ (ไม่ล็อก) */
    public static function configurableKeys(): array
    {
        return array_values(array_map(static fn ($e) => $e['key'], array_filter(self::EVENTS, static fn ($e) => empty($e['locked']))));
    }

    public static function getPrefs(): array
    {
        $stored = json_decode(SettingsService::get('notify.prefs') ?? '{}', true);
        $stored = is_array($stored) ? $stored : [];

        return [
            'events'     => is_array($stored['events'] ?? null) ? $stored['events'] : [],
            'quietHours' => [...self::DEFAULT_QUIET, ...(is_array($stored['quietHours'] ?? null) ? $stored['quietHours'] : [])],
            'digestTime' => is_string($stored['digestTime'] ?? null) ? $stored['digestTime'] : '08:00',
        ];
    }

    public static function modeOf(string $key, ?array $prefs = null): string
    {
        $ev = self::event($key);
        if ($ev === null) {
            return 'off';
        }
        if (! empty($ev['locked'])) {
            return 'instant';
        }
        $prefs ??= self::getPrefs();
        $mode = $prefs['events'][$key] ?? $ev['default'];
        if (! empty($ev['digestOnly']) && $mode === 'instant') {
            return 'digest';
        }

        return in_array($mode, self::MODES, true) ? $mode : $ev['default'];
    }

    /* ── เวลาไทย ─────────────────────────────────────────────────── */

    private static function hhmm(DateTimeImmutable $at): string
    {
        return $at->setTimezone(Clock::thaiZone())->format('H:i');
    }

    private static function thaiDate(DateTimeImmutable $at): string
    {
        return $at->setTimezone(Clock::thaiZone())->format('Y-m-d');
    }

    private static function inWindow(string $t, string $from, string $to): bool
    {
        if ($from === $to) {
            return false;
        }

        // ข้ามเที่ยงคืนได้ เช่น 22:00–07:00
        return $from < $to ? ($t >= $from && $t < $to) : ($t >= $from || $t < $to);
    }

    /** อยู่ในช่วงห้ามรบกวน = คืนเวลาที่พ้นช่วง (UTC) · ไม่อยู่ = null */
    public static function quietUntil(?array $prefs = null, ?DateTimeImmutable $now = null): ?string
    {
        $prefs ??= self::getPrefs();
        $now = ($now ?? Clock::thaiNow())->setTimezone(Clock::thaiZone());
        $q   = $prefs['quietHours'];
        if (empty($q['enabled']) || ! self::inWindow(self::hhmm($now), (string) $q['from'], (string) $q['to'])) {
            return null;
        }
        [$h, $m] = array_map('intval', explode(':', (string) $q['to']));
        $end     = $now->setTime($h, $m, 0);
        if ($end <= $now) {
            $end = $end->modify('+1 day');
        }

        return Clock::toUtcString($end);
    }

    /**
     * แจ้งเรื่องหนึ่ง
     *   $text  ข้อความเต็ม (HTML ของ Telegram — ค่าที่มาจากผู้ใช้ต้อง escape มาแล้ว)
     *   line   สรุปหนึ่งบรรทัดสำหรับรวมในสรุปรายวัน (ไม่ใส่ = ใช้บรรทัดแรกของ text)
     */
    public static function notify(string $key, string $text, array $opts = []): void
    {
        if (! TelegramService::isConfigured()) {
            return;
        }
        $prefs = self::getPrefs();
        $mode  = self::modeOf($key, $prefs);
        if ($mode === 'off') {
            return;
        }
        if ($mode === 'digest') {
            Db::insert(
                'INSERT INTO notification_digest (event_key, line, created_at) VALUES (?, ?, UTC_TIMESTAMP())',
                [$key, $opts['line'] ?? explode("\n", $text)[0]],
            );

            return;
        }
        $locked = ! empty(self::event($key)['locked']);
        TelegramService::queue($text, $opts['changeId'] ?? null, $locked ? null : self::quietUntil($prefs));
    }

    /* ── สรุปรายวัน ─────────────────────────────────────────────── */

    /** ประกอบข้อความสรุป — คืน null ถ้าไม่มีอะไรจะสรุป (ไม่ส่งข้อความว่าง ๆ ให้รำคาญ) */
    public static function buildDigest(?array $prefs = null, ?DateTimeImmutable $now = null): ?array
    {
        $prefs ??= self::getPrefs();
        $now ??= Clock::thaiNow();
        $parts   = [];
        $pending = Db::all('SELECT * FROM notification_digest WHERE sent_at IS NULL ORDER BY id');

        foreach (self::EVENTS as $ev) {
            $rows = array_values(array_filter($pending, static fn ($r) => $r['event_key'] === $ev['key']));
            if ($rows === []) {
                continue;
            }
            $parts[] = '<b>' . TelegramService::escapeHtml($ev['label']) . '</b> (' . count($rows) . ')';
            foreach (array_slice($rows, 0, 8) as $r) {
                $parts[] = '• ' . $r['line'];
            }
            if (count($rows) > 8) {
                $parts[] = '• …และอีก ' . (count($rows) - 8) . ' รายการ';
            }
            $parts[] = '';
        }

        if (self::modeOf('summary.overdue', $prefs) === 'digest') {
            $overdue = Db::all(
                "SELECT f.username, SUM(i.net_total_satang - i.paid_satang) AS owed, COUNT(*) AS n
                   FROM invoices i JOIN franchises f ON f.id = i.franchise_id
                  WHERE i.status IN ('OPEN', 'PARTIAL') AND i.due_date < ?
                  GROUP BY f.id, f.username ORDER BY owed DESC",
                [Period::today()],
            );
            if ($overdue !== []) {
                $total   = array_sum(array_map(static fn ($r) => (int) $r['owed'], $overdue));
                $parts[] = '<b>บิลเลยกำหนด</b> ' . count($overdue) . ' ร้าน รวม ' . Money::fmtSatang($total) . ' บาท';
                foreach (array_slice($overdue, 0, 8) as $r) {
                    $parts[] = '• ' . TelegramService::escapeHtml($r['username']) . ' ' . Money::fmtSatang((int) $r['owed']) . " บาท ({$r['n']} ใบ)";
                }
                $parts[] = '';
            }
        }

        if (self::modeOf('summary.pending_slips', $prefs) === 'digest') {
            $slips = Db::one("SELECT COUNT(*) AS n, COALESCE(SUM(amount_satang), 0) AS total FROM payment_submissions WHERE status = 'PENDING'");
            if ((int) $slips['n'] > 0) {
                $parts[] = "<b>สลิปรอตรวจ</b> {$slips['n']} ใบ รวม " . Money::fmtSatang((int) $slips['total']) . ' บาท';
                $parts[] = '';
            }
        }

        if ($parts === []) {
            return null;
        }

        return [
            'text' => trim(implode("\n", ['📋 <b>สรุปประจำวัน ' . self::thaiDate($now) . '</b>', '', ...$parts])),
            'ids'  => array_map(static fn ($r) => (int) $r['id'], $pending),
        ];
    }

    /** ถึงเวลาสรุปแล้วและวันนี้ยังไม่ได้ส่ง = ส่ง (เซิร์ฟเวอร์ดับตอนถึงเวลา ก็ส่งตามทีหลังในวันเดียวกัน) */
    public static function runDigestIfDue(?DateTimeImmutable $now = null): bool
    {
        if (! TelegramService::isConfigured()) {
            return false;
        }
        $now ??= Clock::thaiNow();
        $prefs = self::getPrefs();
        $date  = self::thaiDate($now);
        if (self::hhmm($now) < $prefs['digestTime'] || SettingsService::get('notify.lastDigest') === $date) {
            return false;
        }
        SettingsService::set('notify.lastDigest', $date);
        $digest = self::buildDigest($prefs, $now);
        if ($digest === null) {
            return false;
        }
        TelegramService::queue($digest['text']);
        if ($digest['ids'] !== []) {
            Db::exec('UPDATE notification_digest SET sent_at = UTC_TIMESTAMP() WHERE id IN ?', [$digest['ids']]);
        }

        return true;
    }

    /* ── แจ้งร้าน (แชตส่วนตัวที่ผูกไว้) ──────────────────────────── */

    /** ตัวเลขบาทในข้อความถึงร้าน "1,234.50" */
    public static function baht(int|float $n): string
    {
        return Money::fmt($n);
    }

    /*
     * เรื่องที่ร้านเลือกรับได้เอง (หน้าบัญชีของฉัน) — ค่าตั้งต้นรับทุกเรื่อง
     * requires = ต้องมีสิทธิ์นี้ถึงจะได้ (ผู้ช่วยที่ดูบิลไม่ได้ ไม่ควรรู้ยอดบิลทาง Telegram)
     */
    public const SHOP_EVENTS = [
        ['key' => 'bill.issued', 'label' => 'บิลรอบใหม่ออกแล้ว', 'hint' => 'ยอดที่ต้องชำระและวันครบกำหนด', 'requires' => 'bills'],
        ['key' => 'bill.due', 'label' => 'เตือนก่อนครบกำหนด 2 วัน', 'hint' => 'ส่งหลัง 09:00 น. ครั้งเดียวต่อบิล', 'requires' => 'bills'],
        ['key' => 'bill.overdue', 'label' => 'ทักเมื่อเลยกำหนด', 'hint' => 'หลังเลยกำหนด 3 วัน และ 7 วัน (ครั้งละข้อความเดียว)', 'requires' => 'bills'],
        ['key' => 'payment.received', 'label' => 'ทางเราได้รับเงินแล้ว', 'hint' => 'ยืนยันทุกครั้งที่ตรวจสลิปผ่าน พร้อมยอดคงเหลือ', 'requires' => 'bills'],
        ['key' => 'payment.rejected', 'label' => 'สลิปต้องแก้ไข', 'hint' => 'บอกเหตุผล จะได้แจ้งใหม่ได้ถูก', 'requires' => 'bills'],
        ['key' => 'announcement', 'label' => 'ประกาศใหม่จากทางเรา', 'hint' => 'โปรโมชั่น สินค้าใหม่ วันหยุด'],
    ];

    /** @return list<string> */
    public static function shopEventKeys(): array
    {
        return array_map(static fn ($e) => $e['key'], self::SHOP_EVENTS);
    }

    private static function shopEvent(?string $key): ?array
    {
        foreach (self::SHOP_EVENTS as $e) {
            if ($e['key'] === $key) {
                return $e;
            }
        }

        return null;
    }

    /**
     * ส่งถึงทุกคนในร้านที่ผูก Telegram ไว้และมีสิทธิ์ดูบิล — คืนจำนวนคนที่ส่งถึง
     * ข้อความถึงร้านใช้คำว่า "ทางเรา" ไม่ใช่ "ส่วนกลาง" — ให้รู้สึกเป็นคู่ค้า ไม่ใช่ถูกสั่ง
     */
    public static function notifyShop(int $franchiseId, string $text, ?string $eventKey = null): int
    {
        if (! TelegramService::isConfigured()) {
            return 0;
        }
        $event = self::shopEvent($eventKey);
        $users = array_filter(
            Db::all(
                "SELECT id, role, is_franchise_owner, permissions, telegram_chat_id, notify_prefs FROM users
                  WHERE franchise_id = ? AND status = 'ACTIVE' AND telegram_chat_id IS NOT NULL",
                [$franchiseId],
            ),
            static fn ($u) => (empty($event['requires']) || Permissions::has($u, $event['requires']))
                && (self::shopPrefsOf($u)[$eventKey] ?? null) !== false,
        );
        foreach ($users as $u) {
            TelegramService::queue($text, chatId: (string) $u['telegram_chat_id']);
        }

        return count($users);
    }

    /** ค่าที่ผู้ใช้เลือกไว้ — ไม่มีคีย์ = เปิด */
    public static function shopPrefsOf(?array $user): array
    {
        $saved = json_decode((string) ($user['notify_prefs'] ?? '{}'), true);
        $saved = is_array($saved) ? $saved : [];
        $out   = [];
        foreach (self::SHOP_EVENTS as $e) {
            $out[$e['key']] = ($saved[$e['key']] ?? null) !== false;
        }

        return $out;
    }

    /** เรื่องที่ผู้ใช้คนนี้เลือกได้ (ตัดเรื่องที่ไม่มีสิทธิ์รู้ออก) พร้อมค่าปัจจุบัน */
    public static function shopNotifyOptions(array $user): array
    {
        $prefs = self::shopPrefsOf($user);
        $out   = [];
        foreach (self::SHOP_EVENTS as $e) {
            if (! empty($e['requires']) && ! Permissions::has($user, $e['requires'])) {
                continue;
            }
            $out[] = ['key' => $e['key'], 'label' => $e['label'], 'hint' => $e['hint'], 'enabled' => $prefs[$e['key']]];
        }

        return $out;
    }

    public static function saveShopPrefs(int $userId, array $patch): array
    {
        $user = Db::one('SELECT * FROM users WHERE id = ?', [$userId]);
        $next = [...self::shopPrefsOf($user), ...$patch];
        Db::exec('UPDATE users SET notify_prefs = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [Json::encode($next), $userId]);

        return self::shopNotifyOptions([...$user, 'notify_prefs' => Json::encode($next)]);
    }

    private const ANNOUNCE_ICON = ['NEWS' => '📣', 'PROMO' => '🏷️', 'PRODUCT' => '📦', 'HOLIDAY' => '📅'];

    /**
     * ส่งประกาศที่ถึงวันเริ่มแล้วเข้า Telegram ของร้าน — ครั้งเดียวต่อประกาศ
     * เรียกทันทีหลังสร้างประกาศ และทุกนาที (ประกาศที่ตั้งเวลาไว้จะส่งตอนถึงวัน หลัง 09:00 น.)
     * ถ้ายังไม่ได้ตั้งบอท ก็ถือว่าส่งแล้ว — ไม่งั้นตั้งบอทวันหลังจะส่งประกาศเก่าทั้งหมดไปทีเดียว
     */
    public static function runAnnouncementPushes(?DateTimeImmutable $now = null): int
    {
        $now ??= Clock::thaiNow();
        $todayIso = self::thaiDate($now);
        $due      = Db::all(
            'SELECT * FROM announcements
              WHERE announced_at IS NULL AND starts_at <= ? AND (ends_at IS NULL OR ends_at >= ?)',
            [$todayIso, $todayIso],
        );
        if ($due === []) {
            return 0;
        }
        // ประกาศตั้งเวลาล่วงหน้า ส่งตอนเช้า ไม่ใช่เที่ยงคืน · ประกาศที่เพิ่งสร้างวันนี้ส่งเลย
        $ready = array_filter($due, static fn ($a) => self::hhmm($now) >= '09:00'
            || substr((string) ($a['created_at'] ?? ''), 0, 10) === gmdate('Y-m-d'));
        $users = TelegramService::isConfigured()
            ? array_filter(
                Db::all("SELECT id, telegram_chat_id, notify_prefs FROM users
                          WHERE role = 'FRANCHISE' AND status = 'ACTIVE' AND telegram_chat_id IS NOT NULL"),
                static fn ($u) => self::shopPrefsOf($u)['announcement'],
            )
            : [];
        foreach ($ready as $a) {
            $body = Js::len($a['body']) > 600 ? mb_substr($a['body'], 0, 600) . '…' : $a['body'];
            $text = implode("\n", [
                (self::ANNOUNCE_ICON[$a['category']] ?? '📣') . ' <b>ประกาศจากทางเรา</b>',
                '<b>' . TelegramService::escapeHtml($a['title']) . '</b>',
                TelegramService::escapeHtml($body),
                '',
                'ดูประกาศทั้งหมดได้ที่หน้าแรกในระบบครับ',
            ]);
            foreach ($users as $u) {
                TelegramService::queue($text, chatId: (string) $u['telegram_chat_id']);
            }
            Db::exec('UPDATE announcements SET announced_at = UTC_TIMESTAMP() WHERE id = ?', [$a['id']]);
        }

        return count($ready);
    }

    /**
     * เตือนร้านล่วงหน้า 2 วันก่อนครบกำหนด แบบสุภาพ — ครั้งเดียวต่อบิล
     * ส่งหลัง 09:00 น. ไม่ปลุกใครตอนเช้ามืด
     */
    public static function runDueReminders(?DateTimeImmutable $now = null): int
    {
        $now ??= Clock::thaiNow();
        if (! TelegramService::isConfigured() || self::hhmm($now) < '09:00') {
            return 0;
        }
        $todayIso = self::thaiDate($now);
        $limit    = self::thaiDate($now->modify('+2 days'));
        $due      = Db::all(
            "SELECT i.id, i.invoice_no, i.franchise_id, i.due_date, i.net_total_satang - i.paid_satang AS owed, bp.code AS period_code
               FROM invoices i JOIN billing_periods bp ON bp.id = i.period_id
              WHERE i.status IN ('OPEN', 'PARTIAL') AND i.reminded_at IS NULL AND i.due_date BETWEEN ? AND ?",
            [$todayIso, $limit],
        );
        foreach ($due as $inv) {
            $days = Period::daysBetween($todayIso, $inv['due_date']);
            self::notifyShop((int) $inv['franchise_id'], implode("\n", [
                '🔔 <b>แจ้งเตือนล่วงหน้า</b>',
                'บิล ' . TelegramService::escapeHtml($inv['invoice_no']) . ' ยอดคงเหลือ <b>' . self::baht(Money::toBaht($inv['owed'])) . ' บาท</b>',
                'ครบกำหนด ' . Period::thDate($inv['due_date']) . ($days === 0 ? ' (วันนี้)' : " (อีก {$days} วัน)"),
                '',
                'โอนแล้วแนบสลิปในระบบได้เลย ขอบคุณที่ชำระตรงเวลาครับ 🙏',
            ]), 'bill.due');
            Db::exec('UPDATE invoices SET reminded_at = UTC_TIMESTAMP() WHERE id = ?', [$inv['id']]);
        }

        return count($due);
    }

    /**
     * ทักร้านหลังเลยกำหนด — สองครั้งพอ (3 วัน และ 7 วัน) ไม่ทวงทุกวัน
     * ภาษาเหมือนเพื่อนเตือน ไม่ใช่จดหมายทวงหนี้: อาจลืม หรือโอนแล้วแต่ยังไม่ได้แนบสลิป
     * บิลที่มีสลิปรอตรวจอยู่ไม่ทัก — ร้านจ่ายแล้ว เรายังตรวจไม่เสร็จเอง
     */
    private const OVERDUE_STAGES = [['days' => 3, 'stage' => 1], ['days' => 7, 'stage' => 2]];

    public static function runOverdueNudges(?DateTimeImmutable $now = null): int
    {
        $now ??= Clock::thaiNow();
        if (! TelegramService::isConfigured() || self::hhmm($now) < '09:00') {
            return 0;
        }
        $todayIso = self::thaiDate($now);
        $rows     = Db::all(
            "SELECT i.id, i.invoice_no, i.franchise_id, i.due_date, i.overdue_nudges,
                    i.net_total_satang - i.paid_satang AS owed
               FROM invoices i
              WHERE i.status IN ('OPEN', 'PARTIAL') AND i.due_date < ? AND i.overdue_nudges < 2
                AND NOT EXISTS (SELECT 1 FROM payment_submissions ps WHERE ps.invoice_id = i.id AND ps.status = 'PENDING')",
            [$todayIso],
        );
        $sent = 0;
        foreach ($rows as $inv) {
            $late    = Period::daysBetween($inv['due_date'], $todayIso);
            $reached = 0;
            foreach (self::OVERDUE_STAGES as $s) {
                if ($late >= $s['days']) {
                    $reached = $s['stage'];
                }
            }
            if ($reached <= (int) $inv['overdue_nudges']) {
                continue;
            }
            $no    = TelegramService::escapeHtml($inv['invoice_no']);
            $owed  = self::baht(Money::toBaht($inv['owed']));
            $lines = $reached === 1
                ? [
                    '🙏 <b>แจ้งเพื่อทราบครับ</b>',
                    "บิล {$no} ครบกำหนดเมื่อ " . Period::thDate($inv['due_date']) . " (ผ่านมา {$late} วัน)",
                    "ยอดคงเหลือ <b>{$owed} บาท</b>",
                    '',
                    'ถ้าโอนแล้ว รบกวนแนบสลิปในระบบด้วยนะครับ ทางเราจะตัดยอดให้ทันที',
                ]
                : [
                    '📌 <b>บิลยังค้างอยู่ครับ</b>',
                    "บิล {$no} เลยกำหนดมา {$late} วัน · คงเหลือ <b>{$owed} บาท</b>",
                    '',
                    'ถ้ามีเหตุขัดข้องหรืออยากขอแบ่งจ่าย ทักทางเราได้เลยครับ ยินดีช่วยหาทางออก',
                ];
            self::notifyShop((int) $inv['franchise_id'], implode("\n", $lines), 'bill.overdue');
            Db::exec('UPDATE invoices SET overdue_nudges = ? WHERE id = ?', [$reached, $inv['id']]);
            $sent++;
        }

        return $sent;
    }

    /* ── สุขภาพของเซิร์ฟเวอร์ ─────────────────────────────────────
     * เว็บล่มทั้งตัว ระบบแจ้งเองไม่ได้ (ตายไปแล้ว) — งานนั้นเป็นของตัวตรวจภายนอก (UptimeRobot → /health)
     * ส่วนนี้แจ้งสิ่งที่ระบบยังรู้ตัวอยู่: เพิ่งฟื้นจากล่ม · มีข้อผิดพลาดแปลก ๆ · ดิสก์ใกล้เต็ม
     */
    private const ERROR_COOLDOWN = 15 * 60;

    /**
     * ข้อผิดพลาดที่ไม่คาดคิด — แจ้งไม่เกิน 1 ข้อความต่อ 15 นาที (พังรัว ๆ กลุ่มต้องไม่ถูกถล่ม)
     * จำเวลาไว้ในฐานข้อมูล เพราะ PHP แต่ละคำขอไม่มีหน่วยความจำร่วมกัน
     */
    public static function notifySystemError(Throwable|string $error, ?string $method = null, ?string $path = null): bool
    {
        try {
            $last = (int) (SettingsService::get('notify.lastErrorAt') ?? 0);
            if (time() - $last < self::ERROR_COOLDOWN) {
                SettingsService::set('notify.suppressedErrors', (string) ((int) (SettingsService::get('notify.suppressedErrors') ?? 0) + 1));

                return false;
            }
            SettingsService::set('notify.lastErrorAt', (string) time());
            $suppressed = (int) (SettingsService::get('notify.suppressedErrors') ?? 0);
            SettingsService::set('notify.suppressedErrors', null);
            $message = $error instanceof Throwable ? $error->getMessage() : $error;
            $lines   = array_filter([
                '🚨 <b>ระบบขัดข้อง</b>',
                $method !== null ? TelegramService::escapeHtml($method) . ' ' . TelegramService::escapeHtml(explode('?', (string) $path)[0]) : null,
                // ข้อความ error ตัดสั้น — รายละเอียดเต็มอยู่ใน log ของเซิร์ฟเวอร์
                TelegramService::escapeHtml(mb_substr($message, 0, 200)),
            ], static fn ($l) => $l !== null);
            self::notify('system.error', implode("\n", $lines) . ($suppressed ? "\n(ช่วง 15 นาทีก่อนหน้าเกิดอีก {$suppressed} ครั้ง)" : ''));

            return true;
        } catch (Throwable) {
            return false; // ฐานข้อมูลเองพัง — แจ้งไม่ได้ (UptimeRobot จะจับได้จาก /health)
        }
    }

    /**
     * ระบบกลับมาทำงาน — ถ้าไม่ได้สั่งรีสตาร์ต/อัปเดตเอง แปลว่าเพิ่งล่มไป
     * $release = รุ่นที่ app:install เพิ่งจด (ดู VersionService::record) → รู้แน่ว่าเป็นการอัปเดต ไม่ต้องให้กลุ่มเดา
     */
    public static function notifyStarted(?DateTimeImmutable $now = null, ?array $release = null): void
    {
        $now ??= Clock::thaiNow();
        self::notify('system.started', implode("\n", [
            '🟢 <b>ระบบเริ่มทำงานแล้ว</b>',
            'เวลา ' . self::hhmm($now) . ' น.',
            ...match (true) {
                $release === null => [
                    'รุ่น ' . VersionService::label(VersionService::running()),
                    'ถ้าไม่ได้สั่งรีสตาร์ตหรืออัปเดตเอง แปลว่าระบบเพิ่งล่มแล้วฟื้นกลับมา — ลองเช็ก log',
                ],
                $release['previous'] === null => ['🆕 ติดตั้งรุ่น <b>' . VersionService::label($release) . '</b>'],
                default                       => ['🆕 อัปเดตเป็นรุ่น <b>' . VersionService::label($release) . '</b> (เดิม ' . VersionService::label($release['previous']) . ')'],
            },
        ]));
    }

    private const DISK_MIN_FREE_BYTES = 2 * 1024 ** 3;
    private const DISK_MIN_FREE_RATIO = 0.1;

    /**
     * ดิสก์ที่เก็บข้อมูล/สลิปใกล้เต็ม — เตือนวันละครั้งพอ (ดิสก์เต็ม = บันทึกอะไรไม่ได้ทั้งระบบ)
     *
     * @param array{free: float|int, total: float|int}|null $fake ใช้ในเทสต์แทนการอ่านดิสก์จริง
     */
    public static function checkDiskSpace(string $dir, ?array $fake = null): ?array
    {
        $free  = $fake['free'] ?? @disk_free_space($dir);
        $total = $fake['total'] ?? @disk_total_space($dir);
        if ($free === false || $total === false || ! $total) {
            return null;
        }
        $low = $free < self::DISK_MIN_FREE_BYTES || $free / $total < self::DISK_MIN_FREE_RATIO;
        if (! $low) {
            return ['low' => false, 'free' => $free, 'total' => $total];
        }
        $today = Period::today();
        if (SettingsService::get('notify.diskWarned') === $today) {
            return ['low' => true, 'free' => $free, 'total' => $total, 'warned' => false];
        }
        SettingsService::set('notify.diskWarned', $today);
        $gb = static fn ($n) => sprintf('%.1F', $n / 1024 ** 3);
        self::notify('system.disk', implode("\n", [
            '💾 <b>พื้นที่บนเซิร์ฟเวอร์ใกล้เต็ม</b>',
            'เหลือ ' . $gb($free) . ' GB จาก ' . $gb($total) . ' GB (' . round(($free / $total) * 100) . '%)',
            'ดิสก์เต็มแล้วระบบจะบันทึกอะไรไม่ได้เลย — ลบไฟล์สำรองเก่าหรือขยายดิสก์',
        ]));

        return ['low' => true, 'free' => $free, 'total' => $total, 'warned' => true];
    }

    /* ── หน้าตั้งค่า ────────────────────────────────────────────── */

    public static function settingsView(): array
    {
        $prefs = self::getPrefs();

        return [
            'events'     => array_map(static fn ($e) => [...$e, 'mode' => self::modeOf($e['key'], $prefs)], self::EVENTS),
            'groups'     => self::GROUPS,
            'quietHours' => $prefs['quietHours'],
            'digestTime' => $prefs['digestTime'],
        ];
    }

    /**
     * บันทึก — เส้นทางต้องผ่าน elevated ก่อน (ปิดการแจ้งเตือนได้ = เรื่องอันตราย)
     * ทุกครั้งที่แก้ กลุ่มได้ข้อความบอกว่าใครแก้อะไร (แจ้งทันทีเสมอ ไม่ผ่านค่าตั้งที่เพิ่งแก้)
     */
    public static function saveSettings(array $input, array $actor): array
    {
        $before = self::getPrefs();
        $events = [];
        foreach (self::EVENTS as $ev) {
            if (! empty($ev['locked'])) {
                continue;
            }
            $mode               = $input['events'][$ev['key']] ?? self::modeOf($ev['key'], $before);
            $events[$ev['key']] = ! empty($ev['digestOnly']) && $mode === 'instant' ? 'digest' : $mode;
        }
        $next = [
            'events'     => $events,
            'quietHours' => [...$before['quietHours'], ...($input['quietHours'] ?? [])],
            'digestTime' => $input['digestTime'] ?? $before['digestTime'],
        ];
        SettingsService::set('notify.prefs', Json::encode($next), (int) $actor['id']);

        $changes = [];
        foreach (self::EVENTS as $ev) {
            if (! empty($ev['locked'])) {
                continue;
            }
            $a = self::modeOf($ev['key'], $before);
            $b = self::modeOf($ev['key'], $next);
            if ($a !== $b) {
                $changes[] = TelegramService::escapeHtml($ev['label']) . ': ' . self::MODE_LABEL[$a] . ' → <b>' . self::MODE_LABEL[$b] . '</b>';
            }
        }
        $q0 = $before['quietHours'];
        $q1 = $next['quietHours'];
        if ((bool) $q0['enabled'] !== (bool) $q1['enabled'] || $q0['from'] !== $q1['from'] || $q0['to'] !== $q1['to']) {
            $changes[] = 'ช่วงห้ามรบกวน: <b>' . ($q1['enabled'] ? "{$q1['from']}–{$q1['to']}" : 'ปิด') . '</b>';
        }
        if ($before['digestTime'] !== $next['digestTime']) {
            $changes[] = "เวลาสรุปรายวัน: <b>{$next['digestTime']}</b>";
        }

        if ($changes !== []) {
            TelegramService::queue(implode("\n", [
                '⚙️ <b>การตั้งค่าแจ้งเตือนถูกเปลี่ยน</b>',
                'โดย: <b>' . TelegramService::escapeHtml(($actor['display_name'] ?? '') ?: $actor['username']) . '</b>',
                '',
                ...$changes,
            ]));
        }
        Audit::write((int) $actor['id'], 'notify.configure', 'setting', null, $next);

        return self::settingsView();
    }
}
