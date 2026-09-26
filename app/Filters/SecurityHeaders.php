<?php

namespace App\Filters;

use CodeIgniter\Filters\FilterInterface;
use CodeIgniter\HTTP\RequestInterface;
use CodeIgniter\HTTP\ResponseInterface;

/**
 * header ความปลอดภัยของทุก response (ชุดเดียวกับ helmet ที่ระบบเดิมใช้)
 *
 * ไม่ใส่ upgrade-insecure-requests: ถ้าวันไหนเปิดผ่าน http เบราว์เซอร์จะบังคับโหลด js เป็น https
 * แล้วหน้าเว็บขาวทั้งหน้าโดยไม่มี error ให้เห็น — ให้ proxy เป็นคน redirect ไป https แทน
 * img-src blob: = รูปที่ผู้ใช้เลือกจากเครื่องตัวเอง (ย่อรูปสลิปก่อนอัปโหลด)
 *
 * ไม่มี CORS โดยตั้งใจ — หน้าเว็บกับ API อยู่ origin เดียวกัน
 */
class SecurityHeaders implements FilterInterface
{
    public const CSP = "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';"
        . "frame-ancestors 'self';img-src 'self' data: blob:;object-src 'none';script-src 'self';"
        . "script-src-attr 'none';style-src 'self' https: 'unsafe-inline'";

    public const HEADERS = [
        'Content-Security-Policy'           => self::CSP,
        'Cross-Origin-Opener-Policy'        => 'same-origin',
        'Cross-Origin-Resource-Policy'      => 'same-origin',
        'Origin-Agent-Cluster'              => '?1',
        'Referrer-Policy'                   => 'no-referrer',
        'Strict-Transport-Security'         => 'max-age=31536000; includeSubDomains',
        'X-Content-Type-Options'            => 'nosniff',
        'X-DNS-Prefetch-Control'            => 'off',
        'X-Download-Options'                => 'noopen',
        'X-Frame-Options'                   => 'SAMEORIGIN',
        'X-Permitted-Cross-Domain-Policies' => 'none',
        'X-XSS-Protection'                  => '0',
    ];

    public function before(RequestInterface $request, $arguments = null)
    {
        return null;
    }

    public function after(RequestInterface $request, ResponseInterface $response, $arguments = null)
    {
        self::apply($response);

        return $response;
    }

    public static function apply(ResponseInterface $response): ResponseInterface
    {
        foreach (self::HEADERS as $name => $value) {
            $response->setHeader($name, $value);
        }
        // ไม่บอกว่าเบื้องหลังเป็น PHP เวอร์ชันไหน
        if (! headers_sent()) {
            header_remove('X-Powered-By');
        }

        return $response;
    }
}
