<?php

namespace App\Commands;

use App\Services\BackupService;
use CodeIgniter\CLI\BaseCommand;
use CodeIgniter\CLI\CLI;

/**
 * สำรองข้อมูลทันที — ปกติงานตั้งเวลาทำให้ทุกคืนอยู่แล้ว ใช้คำสั่งนี้ก่อนอัปเดตระบบหรือก่อนย้ายเครื่อง
 * กู้คืนดู DEPLOY.md หัวข้อ "กู้ข้อมูลคืน"
 */
class AppBackup extends BaseCommand
{
    protected $group       = 'PayNest';
    protected $name        = 'app:backup';
    protected $description = 'สำรองฐานข้อมูล + กุญแจลับ + รูปสลิป ทันที (ปกติทำเองทุกคืน ตี 3 ครึ่ง)';

    public function run(array $params)
    {
        $result = BackupService::run();
        $status = BackupService::status();
        CLI::write('สำรองแล้ว: ' . $result['file'] . ' (' . number_format($result['size'] / 1024) . ' KB)', 'green');
        CLI::write("รูปสลิปใหม่ที่คัดลอก: {$result['uploadsCopied']} ไฟล์ · ลบสำเนาเก่าเกิน {$status['keepDays']} วัน: {$result['removed']} ไฟล์");
        CLI::write("ตอนนี้มีสำเนาฐานข้อมูล {$status['count']} ชุด ที่ {$status['dir']}");

        return EXIT_SUCCESS;
    }
}
