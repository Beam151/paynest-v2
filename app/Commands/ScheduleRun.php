<?php

namespace App\Commands;

use App\Services\Scheduler;
use CodeIgniter\CLI\BaseCommand;
use CodeIgniter\CLI\CLI;

/**
 * งานตั้งเวลา — ให้ cron เรียกทุกนาที:
 *   * * * * *  cd /www/wwwroot/paynest && php spark schedule:run >> /dev/null 2>&1
 */
class ScheduleRun extends BaseCommand
{
    protected $group       = 'PayNest';
    protected $name        = 'schedule:run';
    protected $description = 'งานตั้งเวลา (cron ทุกนาที): ส่ง Telegram ที่ค้าง · อ่านข้อความถึงบอท · สรุปรายวัน · เตือนร้าน · สำรองข้อมูลตี 3 ครึ่ง';
    protected $usage       = 'schedule:run [--verbose]';
    protected $options     = ['--verbose' => 'พิมพ์ผลของแต่ละงาน'];

    public function run(array $params)
    {
        $result = Scheduler::tick();
        if (CLI::getOption('verbose')) {
            foreach ($result as $task => $value) {
                CLI::write(str_pad($task, 16) . ' ' . (is_scalar($value) || $value === null ? var_export($value, true) : json_encode($value, JSON_UNESCAPED_UNICODE)));
            }
        }

        return EXIT_SUCCESS;
    }
}
