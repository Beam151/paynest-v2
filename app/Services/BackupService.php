<?php

namespace App\Services;

use App\Libraries\Clock;
use App\Libraries\Db;
use App\Libraries\Json;
use App\Libraries\Secrets;
use Config\Paynest;
use RuntimeException;
use Throwable;

/**
 * สำรองข้อมูลอัตโนมัติ — ระบบทำให้เองทุกคืน (ตี 3 ครึ่ง เวลาไทย) ผ่านงานตั้งเวลา
 *
 * <dataDir>/backups/
 *   db/paynest-2026-09-25_0330.sql.gz   ฐานข้อมูลรายวัน เก็บย้อนหลัง 30 วัน (paynest.backupKeepDays)
 *   secrets.json                        กุญแจลับ — หายแล้ว Google Authenticator ของทุกคนใช้ไม่ได้
 *   uploads/                            รูปสลิป/QR — ไฟล์ไม่เคยถูกแก้ จึงคัดลอกเฉพาะไฟล์ใหม่
 *
 * dump ด้วย PHP เองในธุรกรรมแบบ consistent snapshot — ได้ภาพเดียวกันทั้งฐานแม้มีคนใช้งานอยู่
 * และไม่ต้องพึ่งโปรแกรม mysqldump บนเครื่อง (โฮสต์หลายแห่งไม่ให้ exec)
 * กู้คืน: gunzip -c ไฟล์.sql.gz | mysql -u <user> -p <database>
 *
 * ⚠ อยู่บนดิสก์เดียวกับเซิร์ฟเวอร์ — ดิสก์พังก็หายด้วยกัน ต้องคัดลอกโฟลเดอร์นี้ออกไปที่อื่นอีกชั้น (ดู DEPLOY.md)
 */
final class BackupService
{
    public const RUN_AT = '03:30';
    private const FILE_RE = '/^paynest-.*\.sql\.gz$/';

    public static function dir(): string
    {
        return config(Paynest::class)->backupPath();
    }

    private static function keepDays(): int
    {
        return max(1, config(Paynest::class)->backupKeepDays);
    }

    /** คัดลอกไฟล์ใหม่ในโฟลเดอร์ต้นทางที่ปลายทางยังไม่มี — คืนจำนวนไฟล์ที่คัดลอก */
    private static function mirrorNewFiles(string $from, string $to): int
    {
        if (! is_dir($from)) {
            return 0;
        }
        if (! is_dir($to)) {
            mkdir($to, 0700, true);
        }
        $copied = 0;
        foreach (scandir($from) ?: [] as $name) {
            $src  = $from . DIRECTORY_SEPARATOR . $name;
            $dest = $to . DIRECTORY_SEPARATOR . $name;
            if ($name === '.' || $name === '..' || ! is_file($src) || file_exists($dest)) {
                continue;
            }
            copy($src, $dest);
            $copied++;
        }

        return $copied;
    }

    public static function run(?string $dir = null): array
    {
        $dir ??= self::dir();
        $dbDir = $dir . DIRECTORY_SEPARATOR . 'db';
        // ในนี้มีทั้งฐานข้อมูลและกุญแจลับ — ให้เจ้าของไฟล์อ่านได้คนเดียว
        if (! is_dir($dbDir) && ! mkdir($dbDir, 0700, true) && ! is_dir($dbDir)) {
            throw new RuntimeException("สร้างโฟลเดอร์ {$dbDir} ไม่ได้ — ตรวจสิทธิ์การเขียน");
        }
        @chmod($dir, 0700);

        $file = $dbDir . DIRECTORY_SEPARATOR . 'paynest-' . Clock::thaiNow()->format('Y-m-d_Hi') . '.sql.gz';
        self::dumpDatabase($file);
        @chmod($file, 0600);

        $secrets = Secrets::file();
        if (is_file($secrets)) {
            copy($secrets, $dir . DIRECTORY_SEPARATOR . 'secrets.json');
            @chmod($dir . DIRECTORY_SEPARATOR . 'secrets.json', 0600);
        }
        $uploadsCopied = self::mirrorNewFiles(config(Paynest::class)->uploadPath(), $dir . DIRECTORY_SEPARATOR . 'uploads');

        // ลบสำเนาฐานข้อมูลที่เก่ากว่ากำหนด — รูปสลิปไม่ลบ (บิลเก่ายังต้องเปิดดูสลิปได้)
        $cutoff  = time() - self::keepDays() * 86400;
        $removed = 0;
        foreach (scandir($dbDir) ?: [] as $name) {
            $path = $dbDir . DIRECTORY_SEPARATOR . $name;
            if (preg_match(self::FILE_RE, $name) && $path !== $file && filemtime($path) < $cutoff) {
                unlink($path);
                $removed++;
            }
        }
        clearstatcache();
        $result = ['file' => $file, 'size' => filesize($file), 'uploadsCopied' => $uploadsCopied, 'removed' => $removed, 'at' => gmdate('Y-m-d\TH:i:s.v\Z')];
        SettingsService::set('backup.last', Json::encode($result));

        return $result;
    }

    public static function status(): array
    {
        $dir       = self::dir();
        $dbDir     = $dir . DIRECTORY_SEPARATOR . 'db';
        $snapshots = is_dir($dbDir) ? array_values(array_filter(scandir($dbDir) ?: [], static fn ($n) => (bool) preg_match(self::FILE_RE, $n))) : [];
        sort($snapshots);
        $last = json_decode(SettingsService::get('backup.last') ?? 'null', true);

        return [
            'dir'      => $dir,
            'keepDays' => self::keepDays(),
            'runAt'    => self::RUN_AT,
            'count'    => count($snapshots),
            'oldest'   => $snapshots[0] ?? null,
            'last'     => is_array($last) ? ['at' => $last['at'] ?? null, 'file' => basename((string) ($last['file'] ?? '')), 'size' => $last['size'] ?? null] : null,
            'error'    => SettingsService::get('backup.error') ?: null,
        ];
    }

    /**
     * ถึงเวลาสำรองของวันนี้แล้วยังไม่ได้ทำ = ทำเลย (เซิร์ฟเวอร์ปิดอยู่ตอนตี 3 ครึ่ง เปิดมาทีหลังก็ยังได้สำรองของวันนั้น)
     * พังแล้วแจ้งกลุ่ม — สำรองเงียบ ๆ ไม่ได้มาหลายวันแล้วเพิ่งรู้ตอนต้องใช้ แย่ที่สุด
     */
    public static function runIfDue(): ?array
    {
        $now   = Clock::thaiNow();
        $today = $now->format('Y-m-d');
        if ($now->format('H:i') < self::RUN_AT || SettingsService::get('backup.date') === $today) {
            return null;
        }
        SettingsService::set('backup.date', $today); // กันทำซ้ำถ้ารอบนี้ช้า — พังแล้วพรุ่งนี้ลองใหม่ (และแจ้งแล้ว)
        try {
            $result = self::run();
            SettingsService::set('backup.error', null);

            return $result;
        } catch (Throwable $e) {
            log_message('error', '[backup] ' . $e->getMessage());
            SettingsService::set('backup.error', mb_substr($e->getMessage(), 0, 300));
            NotificationService::notify('system.backup_failed', "❌ <b>สำรองข้อมูลรายวันไม่สำเร็จ</b>\n" . TelegramService::escapeHtml($e->getMessage())
                . "\nเช็กพื้นที่ดิสก์และสิทธิ์โฟลเดอร์ " . TelegramService::escapeHtml(self::dir()));

            return null;
        }
    }

    /* ── dump ฐานข้อมูลเป็นไฟล์ SQL (gzip) ─────────────────────────── */

    private static function dumpDatabase(string $file): void
    {
        $db  = Db::conn();
        $out = gzopen($file . '.part', 'wb6');
        if ($out === false) {
            throw new RuntimeException("เขียนไฟล์ {$file} ไม่ได้ — ตรวจพื้นที่ดิสก์และสิทธิ์โฟลเดอร์");
        }
        try {
            $w = static function (string $text) use ($out): void {
                if (gzwrite($out, $text) === false) {
                    throw new RuntimeException('เขียนไฟล์สำรองไม่สำเร็จ (ดิสก์เต็ม?)');
                }
            };
            $database = (string) Db::val('SELECT DATABASE()');
            $w("-- PayNest backup · database `{$database}` · " . gmdate('Y-m-d H:i:s') . " UTC\n");
            $w("-- กู้คืน: gunzip -c <ไฟล์> | mysql -u <user> -p <database>\n\n");
            $w("SET NAMES utf8mb4;\nSET time_zone = '+00:00';\nSET FOREIGN_KEY_CHECKS = 0;\nSET UNIQUE_CHECKS = 0;\n\n");

            // ภาพเดียวกันทั้งฐาน — แถวที่ถูกเขียนระหว่าง dump ไม่ปนเข้ามาครึ่ง ๆ
            $db->query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            $db->query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
            try {
                $tables = array_column(Db::all("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"), 't');
                foreach ($tables as $table) {
                    $create = Db::one("SHOW CREATE TABLE `{$table}`");
                    $w("DROP TABLE IF EXISTS `{$table}`;\n" . $create['Create Table'] . ";\n\n");

                    // คอลัมน์ที่คำนวณเอง (generated) ใส่ค่าไม่ได้ — ข้ามไป ให้ฐานข้อมูลคำนวณใหม่ตอนกู้
                    $columns = array_column(Db::all(
                        "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
                          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COALESCE(GENERATION_EXPRESSION, '') = ''
                          ORDER BY ORDINAL_POSITION",
                        [$table],
                    ), 'c');
                    $list   = '`' . implode('`, `', $columns) . '`';
                    $offset = 0;
                    do {
                        $rows = Db::all("SELECT {$list} FROM `{$table}` LIMIT 500 OFFSET {$offset}");
                        if ($rows !== []) {
                            $values = array_map(static fn ($row) => '(' . implode(', ', array_map(static fn ($v) => $v === null ? 'NULL' : $db->escape($v), $row)) . ')', $rows);
                            $w("INSERT INTO `{$table}` ({$list}) VALUES\n" . implode(",\n", $values) . ";\n");
                        }
                        $offset += 500;
                    } while (count($rows) === 500);
                    $w("\n");
                }
                foreach (Db::all('SHOW TRIGGERS') as $trigger) {
                    $name = $trigger['Trigger'];
                    $w("DROP TRIGGER IF EXISTS `{$name}`;\nDELIMITER ;;\n"
                        . "CREATE TRIGGER `{$name}` {$trigger['Timing']} {$trigger['Event']} ON `{$trigger['Table']}` FOR EACH ROW {$trigger['Statement']};;\n"
                        . "DELIMITER ;\n\n");
                }
            } finally {
                $db->query('COMMIT');
            }
            $w("SET UNIQUE_CHECKS = 1;\nSET FOREIGN_KEY_CHECKS = 1;\n-- จบไฟล์สำรอง\n");
        } catch (Throwable $e) {
            gzclose($out);
            @unlink($file . '.part');

            throw $e;
        }
        gzclose($out);
        if (! rename($file . '.part', $file)) {
            throw new RuntimeException("ย้ายไฟล์สำรองไปที่ {$file} ไม่ได้");
        }
    }
}
