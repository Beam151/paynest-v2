<?php

namespace App\Commands;

use App\Libraries\Db;
use App\Services\BackupService;
use CodeIgniter\CLI\BaseCommand;
use CodeIgniter\CLI\CLI;
use Throwable;

/**
 * ลบตารางทั้งหมดของฐานข้อมูลนี้ — ใช้ในเครื่องนักพัฒนาเท่านั้น
 *
 * กันพลาด 3 ชั้น (พิมพ์ผิดบนเซิร์ฟเวอร์จริงทีเดียว ข้อมูลทุกร้านหาย):
 *   1. CI_ENVIRONMENT = production → ไม่ทำเลย
 *   2. ฐานข้อมูลมีบิลจริงอยู่ → ต้องพิมพ์ --yes-delete-everything ต่อท้ายเอง
 *   3. ก่อนลบ สำรองเก็บไว้เสมอ
 */
class AppReset extends BaseCommand
{
    protected $group       = 'PayNest';
    protected $name        = 'app:reset';
    protected $description = 'ลบตารางทั้งหมด (เครื่อง dev เท่านั้น · มีบิลอยู่ต้องใส่ --yes-delete-everything · สำรองให้ก่อนลบเสมอ)';
    protected $options     = ['--yes-delete-everything' => 'ยืนยันว่าลบได้แม้มีบิลอยู่'];

    public function run(array $params)
    {
        if (ENVIRONMENT === 'production') {
            CLI::error('✗ ไม่ลบ: CI_ENVIRONMENT = production (เซิร์ฟเวอร์จริง) — ถ้าต้องล้างจริง ๆ ให้ DROP DATABASE เองด้วยมือ');

            return EXIT_ERROR;
        }
        $invoices = 0;
        try {
            $invoices = Db::int('SELECT COUNT(*) FROM invoices');
        } catch (Throwable) {
            // ยังไม่มีตาราง = ฐานข้อมูลเปล่า
        }
        if ($invoices > 0 && CLI::getOption('yes-delete-everything') === null) {
            CLI::error("✗ ไม่ลบ: ในฐานข้อมูลมีบิล {$invoices} ใบ");
            CLI::write('  ถ้าแน่ใจว่าเป็นเครื่อง dev ให้รัน: php spark app:reset --yes-delete-everything');

            return EXIT_ERROR;
        }
        if ($invoices > 0) {
            $backup = BackupService::run();
            CLI::write('สำรองไว้ก่อนลบ: ' . $backup['file']);
        }
        $tables = array_column(Db::all("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'"), 't');
        Db::exec('SET FOREIGN_KEY_CHECKS = 0');
        foreach ($tables as $table) {
            Db::exec("DROP TABLE IF EXISTS `{$table}`");
        }
        Db::exec('SET FOREIGN_KEY_CHECKS = 1');
        CLI::write('ลบตารางแล้ว ' . count($tables) . ' ตาราง — รัน php spark app:install เพื่อสร้างใหม่', 'green');

        return EXIT_SUCCESS;
    }
}
