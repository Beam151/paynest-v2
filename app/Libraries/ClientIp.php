<?php

namespace App\Libraries;

use Config\Paynest;

/**
 * IP จริงของผู้ใช้ — นับ proxy ที่อยู่หน้าแอปตาม paynest.trustProxy (แบบ trust proxy ของ Express)
 *
 * trustProxy = N แปลว่าเชื่อ N ชั้นจากตัวที่ต่อเข้ามา แล้วเอา IP ตัวถัดไปใน X-Forwarded-For
 * ตั้งน้อยไป = ทุกคนเป็น IP ของ proxy (คนเดารหัสผิดคนเดียว ทุกร้านโดนล็อก)
 * ตั้งมากไป = คนร้ายปลอม X-Forwarded-For หนี rate limit ได้
 */
final class ClientIp
{
    private static ?string $cached = null;

    public static function get(): string
    {
        if (self::$cached !== null) {
            return self::$cached;
        }
        $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
        $hops   = config(Paynest::class)->trustProxy;
        if ($hops <= 0) {
            return self::$cached = $remote;
        }
        $forwarded = array_values(array_filter(
            array_map('trim', explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''))),
            static fn ($ip) => $ip !== '',
        ));
        $chain = [$remote, ...array_reverse($forwarded)];

        return self::$cached = $chain[min($hops, count($chain) - 1)];
    }

    /**
     * คีย์ของ rate limit — IPv6 รวมทั้ง /56 เป็นกลุ่มเดียว
     * ไม่งั้นคนมี IPv6 สลับเลขท้ายหนีได้ไม่จำกัด
     */
    public static function limitKey(string $ip): string
    {
        if (! str_contains($ip, ':')) {
            return $ip;
        }
        $bin = @inet_pton($ip);
        if ($bin === false || strlen($bin) !== 16) {
            return $ip;
        }
        $masked = substr($bin, 0, 7) . str_repeat("\0", 9);

        return inet_ntop($masked) . '/56';
    }
}
