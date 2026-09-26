<?php

namespace App\Database\Seeds;

use Config\Paynest;

/**
 * รูปสลิป/QR ตัวอย่างสำหรับข้อมูลทดสอบ — กดเปิดดูในหน้าจอได้จริง (ไม่ใช่ลิงก์ปลอมที่รูปไม่ขึ้น)
 * วาดด้วย GD ที่มากับ PHP
 */
final class SampleImages
{
    /** รูปสลิปจำลอง: พื้นขาว แถบสีด้านบน (คนละใบคนละสี) และเส้นเทาเลียนแบบบรรทัดข้อความ */
    public static function slip(int $seed): string
    {
        $width   = 420;
        $height  = 560;
        $img     = imagecreatetruecolor($width, $height);
        $palette = [[46, 125, 50], [21, 101, 192], [230, 126, 34], [123, 31, 162], [198, 40, 40]];
        [$r, $g, $b] = $palette[$seed % count($palette)];

        imagefilledrectangle($img, 0, 0, $width - 1, $height - 1, imagecolorallocate($img, 255, 255, 255));
        imagefilledrectangle($img, 0, 0, $width - 1, 95, imagecolorallocate($img, $r, $g, $b));
        imagefilledrectangle($img, 0, $height - 40, $width - 1, $height - 1, imagecolorallocate($img, 244, 246, 251));
        $line = imagecolorallocate($img, 222, 227, 236);
        for ($i = 0; $i < 8; $i++) {
            $y = 120 + $i * 46;
            $w = [300, 220, 260][$i % 3];
            imagefilledrectangle($img, 41, $y, 40 + $w - 1, $y + 10, $line);
        }
        imagerectangle($img, 0, 0, $width - 1, $height - 1, imagecolorallocate($img, 208, 214, 226));

        return self::save($img);
    }

    /**
     * รูปทรง QR ปลอม — สแกนไม่ติด ใช้ดูหน้าตาหน้าจอเท่านั้น
     * ไม่ประกอบ payload พร้อมเพย์จริง เพราะถ้าผิดแม้แต่หลักเดียวแล้วมีคนหลงสแกนจ่าย เงินจะวิ่งไปบัญชีอื่น
     */
    public static function qr(int $seed): string
    {
        $modules = 29;
        $scale   = 8;
        $quiet   = 4;
        $size    = ($modules + $quiet * 2) * $scale;
        $img     = imagecreatetruecolor($size, $size);
        imagefilledrectangle($img, 0, 0, $size - 1, $size - 1, imagecolorallocate($img, 255, 255, 255));
        $dark  = imagecolorallocate($img, 0x13, 0x1a, 0x2e);
        $state = ($seed * 2654435761) & 0xFFFFFFFF;
        $bit   = static function () use (&$state): int {
            $state ^= ($state << 13) & 0xFFFFFFFF;
            $state ^= $state >> 17;
            $state ^= ($state << 5) & 0xFFFFFFFF;

            return $state & 1;
        };
        for ($r = 0; $r < $modules; $r++) {
            for ($c = 0; $c < $modules; $c++) {
                $finder = null;
                foreach ([[0, 0], [0, $modules - 7], [$modules - 7, 0]] as [$fr, $fc]) {
                    $dr = $r - $fr;
                    $dc = $c - $fc;
                    if ($dr >= 0 && $dr <= 6 && $dc >= 0 && $dc <= 6) {
                        $finder = max(abs($dr - 3), abs($dc - 3)) !== 2;
                        break;
                    }
                }
                if ($finder ?? $bit() === 1) {
                    $x = ($c + $quiet) * $scale;
                    $y = ($r + $quiet) * $scale;
                    imagefilledrectangle($img, $x, $y, $x + $scale - 1, $y + $scale - 1, $dark);
                }
            }
        }

        return self::save($img);
    }

    /** เขียนลงโฟลเดอร์อัปโหลด แล้วคืน URL ที่ใช้ในระบบได้เลย */
    private static function save(\GdImage $img): string
    {
        $dir = config(Paynest::class)->uploadPath();
        if (! is_dir($dir)) {
            mkdir($dir, 0750, true);
        }
        $name = bin2hex(random_bytes(16)) . '.png';
        imagepng($img, $dir . DIRECTORY_SEPARATOR . $name, 6);
        imagedestroy($img);

        return "/api/uploads/{$name}";
    }

    /** ล้างไฟล์ที่ seed รอบก่อนทิ้ง ไม่ให้ค้างสะสมทุกครั้งที่ reset */
    public static function clear(): void
    {
        foreach (glob(config(Paynest::class)->uploadPath('*')) ?: [] as $file) {
            @unlink($file);
        }
    }
}
