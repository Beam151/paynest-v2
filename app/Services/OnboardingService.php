<?php

namespace App\Services;

use App\Libraries\Db;
use App\Libraries\Json;
use App\Libraries\Permissions;

/**
 * เช็กลิสต์ตอนเข้าระบบครั้งแรกของร้าน — พาไปลองของจริงทีละขั้น
 * ข้อที่ทำแล้วดูจากข้อมูลจริง (มีสลิป / มีผู้ช่วย / ผูก Telegram) ไม่ต้องให้ร้านมาติ๊กเอง
 * ขั้นที่ไม่เกี่ยวกับผู้ใช้คนนั้นไม่ต้องขึ้น (ผู้ช่วยไม่ต้องเพิ่มผู้ช่วย, ไม่มีสิทธิ์จ่ายไม่ต้องลองจ่าย)
 */
final class OnboardingService
{
    private static function flags(?array $user): array
    {
        $flags = json_decode((string) ($user['onboarding'] ?? '{}'), true);

        return is_array($flags) ? $flags : [];
    }

    public static function status(int $userId): ?array
    {
        $user = Db::one('SELECT * FROM users WHERE id = ?', [$userId]);
        if ($user === null || $user['role'] !== 'FRANCHISE') {
            return null;
        }
        $flags = self::flags($user);
        $steps = [
            ['key' => 'viewBill', 'label' => 'เปิดดูบิลของร้าน', 'hint' => 'ดูว่ายอดมาจากสินค้าอะไรบ้าง', 'href' => '#/invoices', 'done' => ! empty($flags['viewedBill'])],
        ];
        if (Permissions::has($user, 'pay')) {
            $paid    = Db::one("SELECT 1 FROM payment_submissions WHERE franchise_id = ? AND status <> 'CANCELLED' LIMIT 1", [$user['franchise_id']]);
            $steps[] = ['key' => 'pay', 'label' => 'แจ้งชำระครั้งแรก', 'hint' => 'โอนแล้วแนบสลิป ทางเราตรวจแล้วตัดยอดให้', 'href' => '#/invoices', 'done' => $paid !== null];
        }
        if (TelegramService::isConfigured()) {
            $steps[] = ['key' => 'telegram', 'label' => 'เชื่อม Telegram รับแจ้งเตือน', 'hint' => 'รู้ทันทีเมื่อบิลออกหรือได้รับเงินแล้ว', 'href' => '#/account', 'done' => (bool) $user['telegram_chat_id']];
        }
        if ((int) $user['is_franchise_owner'] === 1) {
            $staff   = Db::one('SELECT 1 FROM users WHERE franchise_id = ? AND is_franchise_owner = 0 LIMIT 1', [$user['franchise_id']]);
            $steps[] = ['key' => 'staff', 'label' => 'เพิ่มผู้ช่วย (ถ้ามี)', 'hint' => 'ให้พนักงานช่วยดูบิล/แจ้งชำระ โดยกำหนดสิทธิ์เองได้', 'href' => '#/account', 'done' => $staff !== null];
        }
        $done = count(array_filter($steps, static fn ($s) => $s['done']));

        return ['steps' => $steps, 'done' => $done, 'total' => count($steps), 'complete' => $done === count($steps), 'dismissed' => ! empty($flags['dismissed'])];
    }

    public static function update(int $userId, array $patch): ?array
    {
        $user  = Db::one('SELECT onboarding FROM users WHERE id = ?', [$userId]);
        $flags = self::flags($user);
        if (! empty($patch['viewedBill'])) {
            $flags['viewedBill'] = true;
        }
        // ซ่อนแล้วเปิดกลับได้จากหน้าบัญชีของฉัน
        if (array_key_exists('dismissed', $patch)) {
            $flags['dismissed'] = $patch['dismissed'];
        }
        Db::exec('UPDATE users SET onboarding = ? WHERE id = ?', [Json::encode(Json::obj($flags)), $userId]);

        return self::status($userId);
    }
}
