<?php

namespace App\Filters;

use App\Libraries\AssetVersion;
use CodeIgniter\Filters\FilterInterface;
use CodeIgniter\HTTP\RequestInterface;
use CodeIgniter\HTTP\ResponseInterface;

/**
 * header ความปลอดภัยของทุก response (ชุดเดียวกับ helmet ที่ระบบเดิมใช้)
 *
 * ไม่ใส่ upgrade-insecure-requests: ถ้าวันไหนเปิดผ่าน http เบราว์เซอร์จะบังคับโหลด js เป็น https
 * แล้วหน้าเว็บขาวทั้งหน้าโดยไม่มี error ให้เห็น — ให้ proxy เป็นคน redirect ไป https แทน
 * img-src blob: = รูปที่ผู้ใช้เลือกจากเครื่องตัวเอง (ย่อรูปสลิปก่อนอัปโหลด)
 * challenges.cloudflare.com (script + frame) = ช่อง captcha ของ Turnstile — หน้าเว็บโหลดเฉพาะตอนต้องใช้
 *   เปิดไว้ตลอดแม้ยังไม่ได้ตั้ง captcha เพราะหน้าตั้งค่าต้องวาดช่องทดสอบคีย์ก่อนบันทึก
 *
 * ไม่มี CORS โดยตั้งใจ — หน้าเว็บกับ API อยู่ origin เดียวกัน
 * script-src เพิ่ม hash ของ import map ในหน้า HTML (AssetVersion) ตอนส่ง — สคริปต์ในหน้าตัวอื่นยังถูกบล็อกเหมือนเดิม
 *
 * X-Paynest-Build (ไม่ใช่เรื่องความปลอดภัย แต่ต้องติดทุก response เหมือนกัน) = ป้ายรุ่นของไฟล์หน้าเว็บชุดปัจจุบัน
 * หน้าที่เปิดค้างไว้ตั้งแต่ก่อนอัปเดตเทียบกับป้ายที่โหลดมา แล้วบอกให้โหลดหน้าใหม่ (public/js/freshness.js)
 */
class SecurityHeaders implements FilterInterface
{
    public const CSP = "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';"
        . "frame-ancestors 'self';frame-src 'self' https://challenges.cloudflare.com;img-src 'self' data: blob:;object-src 'none';"
        . "script-src 'self' https://challenges.cloudflare.com;script-src-attr 'none';style-src 'self' https: 'unsafe-inline'";

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
        $response->setHeader('Content-Security-Policy', str_replace("script-src 'self'", "script-src 'self' " . AssetVersion::importMapCsp(), self::CSP));
        $response->setHeader('X-Paynest-Build', AssetVersion::build());
        // ไม่บอกว่าเบื้องหลังเป็น PHP เวอร์ชันไหน
        if (! headers_sent()) {
            header_remove('X-Powered-By');
        }

        return $response;
    }
}
