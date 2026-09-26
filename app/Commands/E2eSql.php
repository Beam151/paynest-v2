<?php

namespace App\Commands;

use App\Libraries\Db;
use App\Libraries\Json;
use CodeIgniter\CLI\BaseCommand;
use CodeIgniter\CLI\CLI;
use Throwable;

/**
 * ตัวช่วยของเทสต์ end-to-end (tests/e2e) — รัน SQL แล้วพิมพ์ผลเป็น JSON
 * เปิดใช้เฉพาะตอนตั้ง PAYNEST_E2E=1 (ชุดเทสต์ตั้งให้เอง) — เครื่องจริงเรียกไม่ได้
 *
 *   PAYNEST_E2E=1 php spark e2e:sql '{"sql":"SELECT 1 AS n","params":[],"mode":"get"}'
 */
class E2eSql extends BaseCommand
{
    protected $group       = 'Testing';
    protected $name        = 'e2e:sql';
    protected $description = '[เทสต์เท่านั้น] รัน SQL แล้วคืนผลเป็น JSON (ต้องตั้ง PAYNEST_E2E=1)';

    public function run(array $params)
    {
        if (getenv('PAYNEST_E2E') !== '1') {
            CLI::error('ใช้ได้เฉพาะชุดเทสต์ (PAYNEST_E2E=1)');

            return EXIT_ERROR;
        }
        $input = json_decode($params[0] ?? '{}', true) ?: [];
        try {
            $sql  = (string) ($input['sql'] ?? '');
            $args = $input['params'] ?? [];
            $out  = match ($input['mode'] ?? 'all') {
                'get'   => ['row' => Db::one($sql, $args)],
                'run'   => ['changes' => Db::exec($sql, $args)],
                default => ['rows' => Db::all($sql, $args)],
            };
        } catch (Throwable $e) {
            $out = ['error' => $e->getMessage()];
        }
        fwrite(STDOUT, Json::encode($out));

        return EXIT_SUCCESS;
    }
}
