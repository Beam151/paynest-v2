<?php

namespace App\Commands;

use App\Libraries\Clock;
use App\Libraries\Db;
use App\Libraries\Json;
use App\Libraries\Secrets;
use App\Services\InvoiceService;
use App\Services\NotificationService;
use App\Services\SalesAgentService;
use App\Services\TelegramService;
use CodeIgniter\CLI\BaseCommand;
use CodeIgniter\CLI\CLI;
use Config\Paynest;
use Throwable;

/**
 * ตัวช่วยของเทสต์ end-to-end — เรียกงานเบื้องหลังที่ปกติ cron เป็นคนเรียก โดยกำหนดเวลาเองได้
 * เปิดใช้เฉพาะตอนตั้ง PAYNEST_E2E=1
 *
 *   PAYNEST_E2E=1 php spark e2e:call '{"fn":"runDueReminders","now":"2026-09-26T10:00:00"}'
 *   now = เวลาตามนาฬิกาไทย
 *
 * งานพร้อมกันหลายจอ (php -S ของชุดเทสต์รับทีละคำขอ จึงจำลองด้วยหลายโปรเซส):
 *   holdRowLock          ถือล็อกแถว (FOR UPDATE) ค้างไว้ n วินาที แล้วเขียนไฟล์ marker เมื่อได้ล็อก
 *                        → เทสต์ปล่อยงานสองโปรเซสเข้ามาชนกันระหว่างนั้น ทั้งคู่จะอ่านข้อมูลก่อนล็อกแล้วไปรอล็อกพร้อมกัน
 *   createCommissionBill / updateInvoiceLine   เรียก service ตรง ๆ ในนามแอดมิน
 *   txProbe              คำสั่งที่พังกลาง Db::tx ต้องโยน error และไม่เหลืออะไรถูก commit
 */
class E2eCall extends BaseCommand
{
    protected $group       = 'Testing';
    protected $name        = 'e2e:call';
    protected $description = '[เทสต์เท่านั้น] เรียกงานเบื้องหลัง/แจ้งเตือนโดยกำหนดเวลาเอง (ต้องตั้ง PAYNEST_E2E=1)';

    public function run(array $params)
    {
        if (getenv('PAYNEST_E2E') !== '1') {
            CLI::error('ใช้ได้เฉพาะชุดเทสต์ (PAYNEST_E2E=1)');

            return EXIT_ERROR;
        }
        $in  = json_decode($params[0] ?? '{}', true) ?: [];
        $now = isset($in['now']) ? Clock::thaiAt($in['now']) : null;
        try {
            $result = match ($in['fn'] ?? '') {
                'flush'                 => TelegramService::flush(),
                'poll'                  => (TelegramService::poll() ?? true),
                'notify'                => (NotificationService::notify($in['key'], $in['text'], $in['opts'] ?? []) ?? true),
                'notifyShop'            => NotificationService::notifyShop((int) $in['franchiseId'], $in['text'], $in['key'] ?? null),
                'runDigestIfDue'        => NotificationService::runDigestIfDue($now),
                'runDueReminders'       => NotificationService::runDueReminders($now),
                'runOverdueNudges'      => NotificationService::runOverdueNudges($now),
                'runAnnouncementPushes' => NotificationService::runAnnouncementPushes($now),
                'notifyStarted'         => (NotificationService::notifyStarted($now) ?? true),
                'notifySystemError'     => NotificationService::notifySystemError($in['message'], $in['method'] ?? null, $in['path'] ?? null),
                'checkDiskSpace'        => NotificationService::checkDiskSpace(config(Paynest::class)->dataPath(), $in['fake'] ?? null),
                'secrets'               => ['file' => Secrets::file(), 'jwtSecret' => Secrets::jwtSecret()],
                'holdRowLock'           => self::holdRowLock($in),
                'createCommissionBill'  => SalesAgentService::createCommissionBill((int) $in['agentId'], $in['input'] ?? [], self::admin()),
                'updateInvoiceLine'     => InvoiceService::updateLine((int) $in['invoiceId'], (int) $in['entryId'], $in['input'] ?? [], self::admin()),
                'txProbe'               => self::txProbe(),
                default                 => throw new \InvalidArgumentException('unknown fn: ' . ($in['fn'] ?? '')),
            };
            $out = ['result' => $result];
        } catch (Throwable $e) {
            $out = ['error' => $e->getMessage()];
        }
        fwrite(STDOUT, Json::encode($out));

        return isset($out['error']) ? EXIT_ERROR : EXIT_SUCCESS;
    }

    /** แอดมินคนแรก — งานที่เรียก service ตรง ๆ ทำในนามคนนี้ */
    private static function admin(): array
    {
        return Db::one("SELECT * FROM users WHERE role = 'SUPER_ADMIN' ORDER BY id LIMIT 1") ?? throw new \RuntimeException('ไม่พบแอดมิน');
    }

    private static function holdRowLock(array $in): bool
    {
        // ชื่อตารางมาจากเทสต์ — รับเฉพาะที่รู้จัก ไม่ต่อสตริงตรง ๆ
        $table = match ($in['table'] ?? '') {
            'invoices'     => 'invoices',
            'sales_agents' => 'sales_agents',
            default        => throw new \InvalidArgumentException('holdRowLock: ตารางไม่รองรับ'),
        };
        Db::tx(static function () use ($table, $in): void {
            Db::one("SELECT id FROM {$table} WHERE id = ? FOR UPDATE", [(int) $in['id']]);
            file_put_contents((string) $in['marker'], '1');
            usleep((int) (((float) ($in['seconds'] ?? 3)) * 1_000_000));
        });

        return true;
    }

    /** @return array{threw: bool, leftover: int} */
    private static function txProbe(): array
    {
        $name  = 'e2e.txProbe.' . bin2hex(random_bytes(4));
        $threw = false;
        try {
            Db::tx(static function () use ($name): void {
                Db::exec('INSERT INTO app_settings (name, value) VALUES (?, ?)', [$name, 'first']);
                Db::exec('INSERT INTO app_settings (name, value) VALUES (?, ?)', [$name, 'duplicate']); // ชน PRIMARY KEY
                Db::exec('INSERT INTO app_settings (name, value) VALUES (?, ?)', [$name . '.after', 'after']);
            });
        } catch (Throwable) {
            $threw = true;
        }

        return [
            'threw'    => $threw,
            'leftover' => Db::int('SELECT COUNT(*) FROM app_settings WHERE name IN (?, ?)', [$name, $name . '.after']),
        ];
    }
}
