<?php

namespace App\Commands;

use App\Libraries\Secrets;
use App\Services\BootstrapService;
use App\Services\NotificationService;
use CodeIgniter\CLI\BaseCommand;
use CodeIgniter\CLI\CLI;
use Config\Paynest;
use Config\Services;

/**
 * ติดตั้ง / อัปเดตระบบ — รันได้ซ้ำทุกครั้งหลัง git pull (ไม่ล้างข้อมูล)
 *   1) รัน migration ที่ค้าง
 *   2) สร้างกุญแจลับ (secrets.json) ถ้ายังไม่มี
 *   3) สร้างแอดมินคนแรก (รหัสสุ่มลงไฟล์) ถ้ายังไม่มี
 *   4) แจ้งกลุ่ม Telegram ว่าระบบเริ่มทำงานแล้ว (ถ้าตั้งไว้)
 */
class AppInstall extends BaseCommand
{
    protected $group       = 'PayNest';
    protected $name        = 'app:install';
    protected $description = 'ติดตั้ง/อัปเดต: รัน migration + สร้างกุญแจลับ + สร้างแอดมินคนแรก (รันซ้ำได้ ไม่ล้างข้อมูล)';

    public function run(array $params)
    {
        $migrations = Services::migrations();
        $migrations->setNamespace(null);
        if (! $migrations->latest()) {
            CLI::error('รัน migration ไม่สำเร็จ — ดู log ใน writable/logs');

            return EXIT_ERROR;
        }
        CLI::write('✓ โครงสร้างฐานข้อมูลเป็นรุ่นล่าสุด', 'green');

        Secrets::load();
        CLI::write('✓ กุญแจลับพร้อม (' . Secrets::file() . ')', 'green');

        $admin = BootstrapService::ensureSuperAdmin();
        if ($admin !== null) {
            $config = config(Paynest::class);
            // ไม่พิมพ์รหัสออกหน้าจอ — log/หน้าจอมักถูกเก็บไว้ที่อื่นที่คนเข้าถึงได้มากกว่า
            CLI::write('✓ สร้างแอดมินคนแรก: ' . $admin['username'], 'green');
            CLI::write($config->seedSuperAdminPass !== ''
                ? '  รหัสผ่านตามที่ตั้งใน paynest.seedSuperAdminPass'
                : '  รหัสผ่านอยู่ในไฟล์ ' . BootstrapService::initialPasswordFile() . ' (ล็อกอินครั้งแรกแล้วระบบให้เปลี่ยน · แล้วลบไฟล์ทิ้ง)');
        } else {
            CLI::write('✓ มีแอดมินอยู่แล้ว');
        }

        if (ENVIRONMENT !== 'production') {
            CLI::write('⚠ CI_ENVIRONMENT = ' . ENVIRONMENT . ' — ไม่บังคับ Google Authenticator กับบัญชีส่วนกลาง (เซิร์ฟเวอร์จริงต้องเป็น production)', 'yellow');
        }
        NotificationService::notifyStarted();

        return EXIT_SUCCESS;
    }
}
