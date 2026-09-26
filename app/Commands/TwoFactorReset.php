<?php

namespace App\Commands;

use App\Libraries\ApiException;
use App\Services\NotificationService;
use App\Services\TelegramService;
use App\Services\TwoFactorService;
use CodeIgniter\CLI\BaseCommand;
use CodeIgniter\CLI\CLI;

/**
 * ปลด Google Authenticator ของผู้ใช้ — ทางสุดท้ายเมื่อแอดมินคนเดียวทำมือถือหายและรหัสสำรองหมด
 * ใช้ได้เฉพาะคนที่เข้าเซิร์ฟเวอร์ได้ (คนที่ไว้ใจได้อยู่แล้ว) — ไม่มีทางเรียกผ่านหน้าเว็บ
 * ผู้ใช้ล็อกอินด้วยรหัสผ่านได้ แล้วระบบจะบังคับตั้งใหม่ (ถ้าเป็นบัญชีส่วนกลาง)
 */
class TwoFactorReset extends BaseCommand
{
    protected $group       = 'PayNest';
    protected $name        = '2fa:reset';
    protected $description = 'ปลด Google Authenticator ของผู้ใช้ (กรณีทำมือถือหายและไม่มีแอดมินอื่นช่วยปลด)';
    protected $usage       = '2fa:reset <username>';
    protected $arguments   = ['username' => 'ชื่อผู้ใช้ที่จะปลด'];

    public function run(array $params)
    {
        $username = $params[0] ?? null;
        if (! $username) {
            CLI::error('ใช้: php spark 2fa:reset <username>');

            return EXIT_ERROR;
        }
        try {
            $user = TwoFactorService::resetByUsername($username);
        } catch (ApiException $e) {
            CLI::error($e->getMessage());

            return EXIT_ERROR;
        }
        // เรื่องใหญ่ — ต้องมีคนรู้ ต่อให้เป็นคนดูแลเซิร์ฟเวอร์ทำเอง
        NotificationService::notify('security.2fa_reset', "🔓 <b>ปลด Google Authenticator ผ่านคำสั่งบนเซิร์ฟเวอร์</b>\nผู้ใช้: <b>" . TelegramService::escapeHtml($user['username']) . '</b>');
        TelegramService::flush();
        CLI::write("ปลด 2FA ของ {$user['username']} แล้ว — session เดิมทุกเครื่องถูกออกจากระบบ", 'green');

        return EXIT_SUCCESS;
    }
}
