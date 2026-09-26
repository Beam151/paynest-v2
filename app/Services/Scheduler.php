<?php

namespace App\Services;

use App\Libraries\Clock;
use App\Libraries\Db;
use App\Libraries\RateLimiter;
use Config\Paynest;
use DateTimeImmutable;
use Throwable;

/**
 * งานเบื้องหลังทั้งหมด — ระบบเดิมใช้ตัวจับเวลาในโปรเซส Node · PHP ใช้ cron เรียกทุกนาทีแทน
 *
 *   * * * * *  php /path/to/spark schedule:run      (ดู DEPLOY.md)
 *
 * แต่ละงานแยก try/catch — งานหนึ่งพังต้องไม่ทำให้งานอื่นไม่ได้ทำ
 * ทุกงานตัดสินเองว่าถึงเวลาหรือยัง (สรุปรายวัน 1 ครั้ง/วัน, สำรองหลัง 03:30 ฯลฯ) จึงเรียกถี่เกินก็ไม่ทำซ้ำ
 */
final class Scheduler
{
    /** ห่างจากรอบก่อนเกินนี้ = cron/เซิร์ฟเวอร์หยุดไป (/health ใช้ค่าเดียวกันตัดสินว่างานตั้งเวลาล่ม) */
    public const DOWNTIME_SECONDS = 10 * 60;

    /** เวลา (unix) ที่งานตั้งเวลาเดินรอบล่าสุด — null = ยังไม่เคยเดิน (เพิ่งติดตั้ง ยังไม่ได้ตั้ง cron) */
    public static function lastHeartbeat(): ?int
    {
        $beat = (int) (SettingsService::get('system.heartbeat') ?? 0);

        return $beat > 0 ? $beat : null;
    }

    /** @return array<string, mixed> ผลของแต่ละงาน (ไว้พิมพ์ตอนรันด้วยมือ) */
    public static function tick(?DateTimeImmutable $now = null): array
    {
        $now ??= Clock::thaiNow();
        TelegramService::refresh();
        $out = [];
        $run = static function (string $name, callable $task) use (&$out): void {
            try {
                $out[$name] = $task();
            } catch (Throwable $e) {
                $out[$name] = 'error: ' . $e->getMessage();
                log_message('error', "[schedule:{$name}] " . $e->getMessage());
            }
        };

        // ชีพจรเขียนทุกครั้งที่ถูกเรียก = cron ยังเดิน (/health ดูค่านี้) แม้รอบนี้ต้องข้ามงานข้างล่าง
        $run('heartbeat', static fn () => self::heartbeat());

        /*
         * งานข้างล่างทำทีละโปรเซส — cron เรียกทุกนาทีแม้รอบก่อนยังไม่จบ (เช่น สำรองฐานข้อมูลใหญ่)
         * และ schedule:work อาจเดินพร้อม cron · สองรอบซ้อนกัน = ร้านได้ข้อความเตือนซ้ำ
         */
        $locked = false;
        $run('lock', static function () use (&$locked) {
            $locked = Db::lock('schedule.tick');

            return $locked ? 'ok' : 'skip: รอบก่อนยังทำงานไม่เสร็จ';
        });
        if (! $locked) {
            return $out;
        }
        try {
            $run('telegram.poll', static function () {
                TelegramService::poll();

                return 'ok';
            });
            $run('digest', static fn () => NotificationService::runDigestIfDue($now));
            $run('dueReminders', static fn () => NotificationService::runDueReminders($now));
            $run('overdueNudges', static fn () => NotificationService::runOverdueNudges($now));
            $run('announcements', static fn () => NotificationService::runAnnouncementPushes($now));
            $run('hourly', static fn () => self::hourly($now));
            $run('backup', static fn () => BackupService::runIfDue());
            // ส่งทุกอย่างที่งานข้างบนเพิ่งจดลง outbox + ข้อความที่ล้มเหลวรอบก่อนแล้วถึงคิวลองใหม่
            $run('telegram.flush', static fn () => TelegramService::flush());
        } finally {
            $run('unlock', static function () {
                Db::unlock('schedule.tick');

                return 'ok';
            });
        }

        return $out;
    }

    /**
     * ระบบเดิมแจ้ง "ระบบเริ่มทำงานแล้ว" ทุกครั้งที่โปรเซสเปิดใหม่ (รีสตาร์ต/ล่มแล้วฟื้น)
     * PHP ไม่มีโปรเซสค้าง — ใช้การหายไปของงานตั้งเวลาแทน: เงียบไปเกิน 10 นาทีแล้วกลับมา = เซิร์ฟเวอร์เพิ่งฟื้น
     */
    private static function heartbeat(): string
    {
        $previous = self::lastHeartbeat();
        SettingsService::set('system.heartbeat', (string) time());
        if ($previous !== null && time() - $previous > self::DOWNTIME_SECONDS) {
            NotificationService::notifyStarted();

            return 'resumed after ' . (time() - $previous) . 's';
        }

        return 'ok';
    }

    /** งานชั่วโมงละครั้ง: ดิสก์ใกล้เต็ม · ล้างตัวนับ rate limit ที่หมดเวลา */
    private static function hourly(DateTimeImmutable $now): string
    {
        $hour = $now->format('Y-m-d H');
        if (SettingsService::get('schedule.lastHourly') === $hour) {
            return 'skip';
        }
        SettingsService::set('schedule.lastHourly', $hour);
        NotificationService::checkDiskSpace(config(Paynest::class)->dataPath());
        RateLimiter::prune();

        return 'ok';
    }
}
