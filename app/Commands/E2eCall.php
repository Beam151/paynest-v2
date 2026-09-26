<?php

namespace App\Commands;

use App\Libraries\Clock;
use App\Libraries\Json;
use App\Libraries\Secrets;
use App\Services\NotificationService;
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
                default                 => throw new \InvalidArgumentException('unknown fn: ' . ($in['fn'] ?? '')),
            };
            $out = ['result' => $result];
        } catch (Throwable $e) {
            $out = ['error' => $e->getMessage()];
        }
        fwrite(STDOUT, Json::encode($out));

        return isset($out['error']) ? EXIT_ERROR : EXIT_SUCCESS;
    }
}
