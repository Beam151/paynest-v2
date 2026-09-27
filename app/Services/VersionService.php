<?php

namespace App\Services;

use App\Libraries\Clock;
use App\Libraries\Json;
use Config\Paynest;

/**
 * รุ่นของระบบ + เวลาที่อัปเดตครั้งล่าสุด
 *
 * รุ่น = Paynest::VERSION (นักพัฒนาเลื่อนเอง) + commit ของ git ที่เครื่องนั้น pull มา
 * commit ทำให้รู้ว่าโค้ดเปลี่ยนแม้ลืมเลื่อนเลขรุ่น และบอกได้ตรงตัวว่าเครื่องจริงรันโค้ดชุดไหน
 *
 * เวลาอัปเดต = ตอนที่ app:install เห็นรุ่น/commit ต่างจากที่จดไว้ (ขั้นสุดท้ายของการอัปเดตใน DEPLOY.md)
 * ไม่ใช้เวลาของ commit — เขียนเสร็จวันจันทร์ ขึ้นเครื่องจริงวันศุกร์ได้ คนที่ถามอยากรู้วันศุกร์
 */
final class VersionService
{
    private const KEY = 'system.release';

    /** @return array{version: string, commit: ?string} รุ่นของโค้ดที่รันอยู่ตอนนี้ */
    public static function running(): array
    {
        return ['version' => Paynest::VERSION, 'commit' => self::gitCommit()];
    }

    /** "2.0.0 (a1b2c3d)" — ไม่ใช่ git checkout (อัปโหลดไฟล์เอง) ก็เหลือแค่เลขรุ่น */
    public static function label(array $release): string
    {
        return $release['version'] . ($release['commit'] ? " ({$release['commit']})" : '');
    }

    /**
     * จดรุ่นที่เพิ่งติดตั้ง — app:install เรียกหลัง migration ผ่านแล้ว
     * รุ่นเดิมทุกตัว (รัน app:install ซ้ำ / กู้ข้อมูลคืน) ไม่นับว่าอัปเดต เวลาเดิมคงไว้
     *
     * @return array{version: string, commit: ?string, previous: ?array}|null null = รุ่นเดิม
     */
    public static function record(): ?array
    {
        $now  = self::running();
        $last = self::recorded();
        if ($last !== null && $last['version'] === $now['version'] && $last['commit'] === $now['commit']) {
            return null;
        }
        $previous = $last === null ? null : ['version' => $last['version'], 'commit' => $last['commit']];
        SettingsService::set(self::KEY, Json::encode([...$now, 'at' => Clock::nowUtc(), 'previous' => $previous]));

        return [...$now, 'previous' => $previous];
    }

    /**
     * สำหรับหน้าเว็บ — ทุกคนเห็นเลขรุ่นกับวันที่อัปเดต (updatedAt = ตอนที่ app:install จดรุ่น installed)
     * commit / รุ่นที่จดไว้ / รุ่นก่อนหน้า / ยังไม่ได้รัน app:install เป็นเรื่องของคนดูแลระบบ ส่งให้ส่วนกลางเท่านั้น
     */
    public static function info(bool $detail): array
    {
        $now  = self::running();
        $last = self::recorded();
        $out  = ['version' => $now['version'], 'updatedAt' => $last['at'] ?? null];
        if (! $detail) {
            return $out;
        }

        return [
            ...$out,
            'commit'    => $now['commit'],
            'installed' => $last === null ? null : ['version' => $last['version'], 'commit' => $last['commit']],
            'previous'  => $last['previous'] ?? null,
            // git pull แล้วลืม app:install — โครงสร้างฐานข้อมูลอาจยังเป็นของรุ่นที่จดไว้ (installed) ไม่ใช่ของโค้ดที่รันอยู่
            'installPending' => $last === null || $last['version'] !== $now['version'] || $last['commit'] !== $now['commit'],
        ];
    }

    /** @return array{version: string, commit: ?string, at: string, previous: ?array}|null */
    private static function recorded(): ?array
    {
        $row = json_decode(SettingsService::get(self::KEY) ?? 'null', true);

        return is_array($row) && isset($row['version'], $row['at'])
            ? ['version' => (string) $row['version'], 'commit' => $row['commit'] ?? null, 'at' => (string) $row['at'], 'previous' => $row['previous'] ?? null]
            : null;
    }

    /**
     * commit ที่ checkout อยู่ (7 ตัวแรก) — อ่านไฟล์ใน .git ตรง ๆ ไม่เรียกคำสั่ง git
     * เพราะ aaPanel มักปิด exec/shell_exec และผู้ใช้เว็บ (www) อาจรัน git ไม่ได้ · ไม่ใช่ git checkout = null
     */
    private static function gitCommit(): ?string
    {
        $git  = ROOTPATH . '.git' . DIRECTORY_SEPARATOR;
        $head = @file_get_contents($git . 'HEAD');
        if ($head === false) {
            return null;
        }
        $head = trim($head);
        if (str_starts_with($head, 'ref: ')) {
            $ref  = substr($head, 5);
            $hash = @file_get_contents($git . $ref);
            if ($hash === false) {
                // หลัง git gc ref ถูกย้ายไปรวมใน packed-refs แทนไฟล์แยก
                $packed = @file_get_contents($git . 'packed-refs') ?: '';
                $hash   = preg_match('/^([0-9a-f]{40,64}) ' . preg_quote($ref, '/') . '$/m', $packed, $m) ? $m[1] : '';
            }
            $head = trim($hash);
        }

        return preg_match('/^[0-9a-f]{40,64}$/', $head) ? substr($head, 0, 7) : null;
    }
}
