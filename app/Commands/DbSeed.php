<?php

namespace App\Commands;

use CodeIgniter\CLI\CLI;
use CodeIgniter\Commands\Database\Seed;
use CodeIgniter\Database\Seeder;
use Config\Database;
use Throwable;

/**
 * php spark db:seed ตัวเดิมของเฟรมเวิร์ก — ต่างกันแค่ seed ไม่สำเร็จแล้วจบด้วย exit code 1
 *
 * ตัวของเฟรมเวิร์กพิมพ์ error แล้วจบด้วย 0 เสมอ: สคริปต์ deploy / CI ที่เช็กผลด้วย && จะนึกว่าสำเร็จ
 * (เช่นเผลอรัน DemoSeeder บน production — seeder ปฏิเสธแล้ว แต่สคริปต์ยังเดินต่อเหมือนไม่มีอะไรเกิดขึ้น)
 * คำสั่งใน app/Commands ถูกค้นเจอก่อนของเฟรมเวิร์ก ชื่อเดียวกันจึงใช้ตัวนี้แทน
 */
class DbSeed extends Seed
{
    public function run(array $params)
    {
        $seeder   = new Seeder(new Database());
        $seedName = array_shift($params);

        if (empty($seedName)) {
            $seedName = CLI::prompt(lang('Migrations.migSeeder'), null, 'required'); // @codeCoverageIgnore
        }

        try {
            $seeder->call($seedName);
        } catch (Throwable $e) {
            $this->showError($e);

            return EXIT_ERROR;
        }

        return EXIT_SUCCESS;
    }
}
