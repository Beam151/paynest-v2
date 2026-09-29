<?php

namespace App\Commands;

use App\Libraries\Db;
use App\Libraries\Secrets;
use App\Services\BootstrapService;
use App\Services\FranchiseService;
use App\Services\NotificationService;
use App\Services\VersionService;
use CodeIgniter\CLI\BaseCommand;
use CodeIgniter\CLI\CLI;
use Config\Paynest;
use Config\Services;

/**
 * ติดตั้ง / อัปเดตระบบ — รันได้ซ้ำทุกครั้งหลัง git pull (ไม่ล้างข้อมูล)
 *   1) รัน migration ที่ค้าง
 *   2) สร้างกุญแจลับ (secrets.json) ถ้ายังไม่มี
 *   3) สร้างลิงก์เข้าระบบให้ร้านที่ยังไม่มี (ต้องมีกุญแจลับก่อน จึงทำใน migration ไม่ได้)
 *   4) สร้างแอดมินคนแรก (รหัสสุ่มลงไฟล์) ถ้ายังไม่มี
 *   5) จดรุ่นของระบบ + เวลาอัปเดต (ถ้ารุ่นเปลี่ยน)
 *   6) แจ้งกลุ่ม Telegram ว่าระบบเริ่มทำงานแล้ว พร้อมรุ่นที่เพิ่งอัปเดต (ถ้าตั้งไว้)
 */
class AppInstall extends BaseCommand
{
    protected $group       = 'PayNest';
    protected $name        = 'app:install';
    protected $description = 'ติดตั้ง/อัปเดต: รัน migration + สร้างกุญแจลับ + สร้างแอดมินคนแรก (รันซ้ำได้ ไม่ล้างข้อมูล)';

    public function run(array $params)
    {
        /*
         * ตรวจรุ่นฐานข้อมูลก่อนแตะอะไร — migration รุ่น 2.1.0 ถอด CHECK ด้วย DROP CONSTRAINT ที่ MySQL เพิ่งมีใน 8.0.19
         * บน MySQL 8.0.16–8.0.18 จะพังกลาง migration หลังเพิ่มคอลัมน์ไปแล้ว (DDL ย้อนไม่ได้) รันซ้ำก็ชนคอลัมน์ซ้ำ ต้องซ่อมมือ
         * MariaDB (10.4+) รับ DROP CONSTRAINT อยู่แล้ว
         */
        $version = (string) Db::val('SELECT VERSION()');
        if (stripos($version, 'mariadb') === false && version_compare(explode('-', $version)[0], '8.0.19', '<')) {
            CLI::error("ฐานข้อมูลเป็น MySQL {$version} — ระบบต้องใช้ MySQL 8.0.19 ขึ้นไป หรือ MariaDB 10.4 ขึ้นไป · ยังไม่ได้แก้อะไรในฐานข้อมูล อัปเดตฐานข้อมูลก่อนแล้วรันใหม่");

            return EXIT_ERROR;
        }

        $migrations = Services::migrations();
        $migrations->setNamespace(null);
        if (! $migrations->latest()) {
            CLI::error('รัน migration ไม่สำเร็จ — ดู log ใน writable/logs');

            return EXIT_ERROR;
        }
        CLI::write('✓ โครงสร้างฐานข้อมูลเป็นรุ่นล่าสุด', 'green');

        Secrets::load();
        CLI::write('✓ กุญแจลับพร้อม (' . Secrets::file() . ')', 'green');

        // ร้านที่เปิดก่อนมีระบบลิงก์ยังไม่มี key = ผู้ใช้ของร้านล็อกอินไม่ได้เลย — เติมให้ทุกครั้งที่อัปเดต (มีแล้วไม่แตะ)
        $keys = FranchiseService::ensureLoginKeys();
        CLI::write('✓ ลิงก์เข้าระบบของร้าน — ' . ($keys > 0 ? "สร้างให้ร้านที่ยังไม่มี {$keys} ร้าน (คัดลอกส่งร้านได้ที่หน้าร้านค้า)" : 'มีครบทุกร้านแล้ว'), 'green');

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

        // จดเมื่อทุกขั้นข้างบนผ่านแล้วเท่านั้น — พังกลางทาง = ยังไม่นับว่าอัปเดตสำเร็จ (หน้าตั้งค่ายังเตือนให้รันใหม่)
        $release = VersionService::record();
        CLI::write('✓ ระบบรุ่น ' . VersionService::label(VersionService::running()) . ' — ' . match (true) {
            $release === null             => 'รุ่นเดิม ไม่นับเป็นการอัปเดต',
            $release['previous'] === null => 'ติดตั้งครั้งแรก',
            default                       => 'อัปเดตจาก ' . VersionService::label($release['previous']),
        }, 'green');
        NotificationService::notifyStarted(null, $release);

        return EXIT_SUCCESS;
    }
}
