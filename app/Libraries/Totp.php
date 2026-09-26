<?php

namespace App\Libraries;

use chillerlan\QRCode\Output\QROutputInterface;
use chillerlan\QRCode\QRCode;
use chillerlan\QRCode\QROptions;

/**
 * TOTP (RFC 6238) สำหรับ Google Authenticator / Microsoft Authenticator / Authy / 1Password
 * SHA1 · 6 หลัก · 30 วินาที — แอปส่วนใหญ่รองรับแค่ชุดนี้ อย่าเปลี่ยน
 */
final class Totp
{
    public const PERIOD = 30;
    public const DIGITS = 6;

    private const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    /** secret ใหม่ 20 ไบต์ (160 บิต) เป็น base32 ไม่มี padding */
    public static function newSecret(): string
    {
        return self::base32Encode(random_bytes(20));
    }

    public static function base32Encode(string $bytes): string
    {
        $bits = '';
        foreach (str_split($bytes) as $char) {
            $bits .= str_pad(decbin(ord($char)), 8, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 5) as $chunk) {
            $out .= self::ALPHABET[bindec(str_pad($chunk, 5, '0'))];
        }

        return $out;
    }

    public static function base32Decode(string $text): string
    {
        $text = strtoupper(preg_replace('/[\s=]/', '', $text) ?? '');
        $bits = '';
        foreach (str_split($text) as $char) {
            $pos = strpos(self::ALPHABET, $char);
            if ($pos === false) {
                return '';
            }
            $bits .= str_pad(decbin($pos), 5, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 8) as $byte) {
            if (strlen($byte) === 8) {
                $out .= chr(bindec($byte));
            }
        }

        return $out;
    }

    /** รหัส 6 หลักของช่วงเวลา (counter) ที่กำหนด */
    public static function generate(string $secretBase32, int $counter): string
    {
        $key  = self::base32Decode($secretBase32);
        $hmac = hash_hmac('sha1', pack('J', $counter), $key, true);
        $off  = ord($hmac[19]) & 0x0f;
        $code = ((ord($hmac[$off]) & 0x7f) << 24) | (ord($hmac[$off + 1]) << 16) | (ord($hmac[$off + 2]) << 8) | ord($hmac[$off + 3]);

        return str_pad((string) ($code % (10 ** self::DIGITS)), self::DIGITS, '0', STR_PAD_LEFT);
    }

    public static function counterAt(?int $timestamp = null): int
    {
        return intdiv($timestamp ?? time(), self::PERIOD);
    }

    /**
     * ตรวจรหัส — คืนระยะห่างจากช่วงปัจจุบัน (-1, 0, +1) หรือ null ถ้าไม่ตรง
     * ลองช่วงปัจจุบันก่อน แล้วค่อยก่อนหน้า/ถัดไป (ยอมนาฬิกามือถือคลาดได้ ±30 วิ)
     */
    public static function validate(string $secretBase32, string $token, int $window = 1): ?int
    {
        if (strlen($token) !== self::DIGITS) {
            return null;
        }
        $counter = self::counterAt();
        if (hash_equals(self::generate($secretBase32, $counter), $token)) {
            return 0;
        }
        for ($i = 1; $i <= $window; $i++) {
            if (hash_equals(self::generate($secretBase32, $counter - $i), $token)) {
                return -$i;
            }
            if (hash_equals(self::generate($secretBase32, $counter + $i), $token)) {
                return $i;
            }
        }

        return null;
    }

    /** otpauth:// URI สำหรับสแกน — รูปแบบเดียวกับที่ Google Authenticator คาดหวัง */
    public static function uri(string $issuer, string $label, string $secretBase32): string
    {
        $e = [Js::class, 'encodeURIComponent'];

        return 'otpauth://totp/' . $e($issuer) . ':' . $e($label)
            . '?issuer=' . $e($issuer)
            . '&secret=' . $e($secretBase32)
            . '&algorithm=SHA1&digits=' . self::DIGITS . '&period=' . self::PERIOD;
    }

    /** รูป QR (data URL ของ PNG) ให้สแกนเข้าแอป */
    public static function qrDataUrl(string $uri): string
    {
        $options = new QROptions([
            'outputType'    => QROutputInterface::GDIMAGE_PNG,
            'outputBase64'  => true,
            'scale'         => 5,
            'quietzoneSize' => 1,
            'eccLevel'      => \chillerlan\QRCode\Common\EccLevel::M,
        ]);

        return (new QRCode($options))->render($uri);
    }
}
