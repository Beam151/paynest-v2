<?php

namespace App\Commands;

use App\Libraries\Db;
use App\Services\Scheduler;
use App\Services\TelegramService;
use CodeIgniter\CLI\BaseCommand;
use CodeIgniter\CLI\CLI;
use Throwable;

/**
 * งานตั้งเวลาแบบรันค้างไว้ — ใช้แทน cron เมื่ออยากให้ร้านได้ผลผูก Telegram เร็วขึ้น
 * (อ่านข้อความถึงบอททุก 10 วินาที เหมือนระบบเดิม) — รันผ่าน supervisor / systemd / pm2 ให้เปิดใหม่เองเมื่อหลุด
 *
 *   pm2 start "php spark schedule:work" --name paynest-worker
 *
 * ใช้คู่กับ cron schedule:run ได้ (มีล็อกกันทำงานซ้ำ) แต่ใช้อย่างใดอย่างหนึ่งก็พอ
 */
class ScheduleWork extends BaseCommand
{
    protected $group       = 'PayNest';
    protected $name        = 'schedule:work';
    protected $description = 'รันงานตั้งเวลาค้างไว้ (แทน cron): งานรายนาที + อ่านข้อความถึงบอท Telegram ทุก 10 วินาที';

    public function run(array $params)
    {
        CLI::write('schedule:work เริ่มทำงาน — กด Ctrl+C เพื่อหยุด');
        $lastMinute = '';
        while (true) {
            try {
                $minute = gmdate('Y-m-d H:i');
                if ($minute !== $lastMinute) {
                    $lastMinute = $minute;
                    Scheduler::tick();
                } else {
                    TelegramService::poll();
                    TelegramService::flush();
                }
            } catch (Throwable $e) {
                // ฐานข้อมูลรีสตาร์ต / connection หลุด — ต่อใหม่รอบหน้า
                CLI::error('[schedule:work] ' . $e->getMessage());
                Db::reset();
            }
            sleep(10);
        }
    }
}
