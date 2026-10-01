<?php

namespace App\Libraries;

use FilesystemIterator;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;

/**
 * ป้ายรุ่นของไฟล์หน้าเว็บ (js / css / ไอคอน) — กัน "อัปเดตแล้วแต่เบราว์เซอร์ยังใช้หน้าเก่า"
 *
 * เว็บเซิร์ฟเวอร์ (และ Cloudflare) ให้เบราว์เซอร์เก็บไฟล์ js ไว้ได้ราว 1 ชั่วโมง — รีเฟรชหลังอัปเดตแล้วยังได้โค้ดเก่า
 * หรือได้ครึ่งเก่าครึ่งใหม่ (ไฟล์ที่ import กันคนละรุ่น = หน้าพังแบบเดาไม่ได้)
 * แก้ด้วยการต่อ ?v=<ป้าย> ท้ายทุกไฟล์: ไฟล์เปลี่ยน = ที่อยู่เปลี่ยน = เบราว์เซอร์ต้องโหลดใหม่ · ไฟล์ที่ไม่เปลี่ยนยังใช้ของที่เก็บไว้ได้
 *
 * js เป็น ES module ที่ import กันเองด้วย './ui.js' (ไม่มี ?v=) — หน้า HTML จึงส่ง import map บอกเบราว์เซอร์ว่า
 * '/js/ui.js' ให้โหลดจาก '/js/ui.js?v=…' (เบราว์เซอร์เก่าที่ไม่รู้จัก import map ยังเปิดได้ปกติ แค่ไม่ได้ป้ายรุ่น)
 * import map เป็นสคริปต์ในหน้า — CSP อนุญาตด้วย hash ของเนื้อหาตรงตัว (importMapCsp) ไม่ต้องเปิด 'unsafe-inline'
 *
 * ป้าย = เวลาแก้ไข + ขนาดไฟล์ (git pull เขียนไฟล์ที่เปลี่ยนใหม่ทุกครั้ง) — ไม่อ่านเนื้อไฟล์ เพราะคิดทุก response
 * build() = ป้ายรวมของทุกไฟล์ ส่งไปกับทุก response (X-Paynest-Build) ให้หน้าที่เปิดค้างไว้รู้ว่ามีรุ่นใหม่แล้ว
 */
final class AssetVersion
{
    /** ไฟล์นอก js/ ที่หน้าเว็บอ้างถึงตรง ๆ */
    private const EXTRA = ['/styles.css', '/icons.svg'];

    private static ?array $tokens = null;

    /** @return array<string, string> '/js/ui.js' => 'a1b2c3d4e5' */
    public static function tokens(): array
    {
        if (self::$tokens !== null) {
            return self::$tokens;
        }
        $root  = rtrim(str_replace('\\', '/', FCPATH), '/');
        $paths = self::EXTRA;
        if (is_dir($root . '/js')) {
            $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/js', FilesystemIterator::SKIP_DOTS));
            foreach ($files as $file) {
                if ($file->isFile() && $file->getExtension() === 'js') {
                    $paths[] = substr(str_replace('\\', '/', $file->getPathname()), strlen($root));
                }
            }
        }
        sort($paths);

        $tokens = [];
        foreach ($paths as $path) {
            $stat = @stat($root . $path);
            if ($stat !== false) {
                $tokens[$path] = substr(md5($path . ':' . $stat['mtime'] . ':' . $stat['size']), 0, 10);
            }
        }

        return self::$tokens = $tokens;
    }

    /** '/js/app.js' → '/js/app.js?v=a1b2c3d4e5' (ไม่รู้จักไฟล์ = คืนที่อยู่เดิม) */
    public static function url(string $path): string
    {
        $token = self::tokens()[$path] ?? null;

        return $token === null ? $path : "{$path}?v={$token}";
    }

    /** ป้ายรวมของหน้าเว็บทั้งชุด — เปลี่ยนเมื่อไฟล์ใดไฟล์หนึ่งเปลี่ยน */
    public static function build(): string
    {
        return substr(md5(Json::encode(self::tokens())), 0, 12);
    }

    /** เนื้อหาของ <script type="importmap"> — ต้องเป็นข้อความเดียวกับที่คิด hash ใน importMapCsp ทุกตัวอักษร */
    public static function importMap(): string
    {
        $imports = [];
        foreach (self::tokens() as $path => $token) {
            if (str_ends_with($path, '.js')) {
                $imports[$path] = "{$path}?v={$token}";
            }
        }

        return json_encode(['imports' => $imports], JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_THROW_ON_ERROR);
    }

    /** ค่าใน script-src ที่อนุญาต import map ข้างบน (และไม่อนุญาตสคริปต์ในหน้าตัวอื่น) */
    public static function importMapCsp(): string
    {
        return "'sha256-" . base64_encode(hash('sha256', self::importMap(), true)) . "'";
    }
}
