<?php

namespace App\Controllers\Api;

use App\Libraries\ApiException;
use App\Libraries\ApiResponse;
use App\Libraries\SignedUrl;
use Config\Paynest;

/**
 * อัปโหลดรูปสลิป / QR — /api/uploads
 *
 * ส่งไฟล์มาเป็น raw body ตรง ๆ (fetch(url, { body: file })) ไม่ใช้ multipart
 * ไฟล์เก็บนอกโฟลเดอร์ public แล้วเสิร์ฟผ่านเส้นทางนี้ เพื่อไม่ให้ใครไล่ดูรายการไฟล์ได้
 * และบังคับ Content-Type ตามที่ตรวจเองตอนอัปโหลด ไม่เชื่อค่าที่ไคลเอนต์ส่งมา
 */
class Uploads extends BaseApiController
{
    private const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — รูปจากมือถือใบใหญ่สุดก็ไม่เกินนี้

    /** นามสกุลที่ยอมรับ — ตรวจจาก magic bytes ไม่ใช่จากชื่อไฟล์หรือ header */
    private const TYPES = [
        'jpg'  => 'image/jpeg',
        'png'  => 'image/png',
        'gif'  => 'image/gif',
        'webp' => 'image/webp',
        'pdf'  => 'application/pdf',
    ];

    private static function detect(string $b): ?string
    {
        return match (true) {
            str_starts_with($b, "\xFF\xD8\xFF")                                         => 'jpg',
            str_starts_with($b, "\x89PNG")                                              => 'png',
            str_starts_with($b, 'GIF')                                                  => 'gif',
            strlen($b) > 12 && substr($b, 0, 4) === 'RIFF' && substr($b, 8, 4) === 'WEBP' => 'webp',
            str_starts_with($b, '%PDF')                                                 => 'pdf',
            default                                                                     => null,
        };
    }

    public function create()
    {
        $declared = $this->request->getHeaderLine('Content-Length');
        if (ctype_digit($declared) && (int) $declared > self::MAX_BYTES) {
            return ApiResponse::errorOf(413, 'PAYLOAD_TOO_LARGE', 'ข้อมูลหรือไฟล์ใหญ่เกินกำหนด', $this->response);
        }
        $body = (string) ($this->request->getBody() ?? '');
        if (strlen($body) > self::MAX_BYTES) {
            return ApiResponse::errorOf(413, 'PAYLOAD_TOO_LARGE', 'ข้อมูลหรือไฟล์ใหญ่เกินกำหนด', $this->response);
        }
        if ($body === '') {
            throw ApiException::badRequest('ไม่พบไฟล์ที่อัปโหลด');
        }
        // ดูจาก magic bytes เท่านั้น — ไฟล์ที่ไม่ใช่รูป/PDF จะไม่ถูกเขียนลงดิสก์เลย
        $ext = self::detect($body) ?? throw ApiException::badRequest('รองรับเฉพาะไฟล์รูป (JPG, PNG, GIF, WebP) หรือ PDF');

        $dir = config(Paynest::class)->uploadPath();
        if (! is_dir($dir)) {
            mkdir($dir, 0750, true);
        }
        // ชื่อไฟล์สุ่มเสมอ ไม่ใช้ชื่อที่ไคลเอนต์ส่งมา กัน path traversal และชื่อชนกัน
        $name = bin2hex(random_bytes(16)) . '.' . $ext;
        if (file_put_contents($dir . DIRECTORY_SEPARATOR . $name, $body, LOCK_EX) === false) {
            throw new \RuntimeException('เขียนไฟล์อัปโหลดไม่ได้ — ตรวจสิทธิ์โฟลเดอร์ uploads');
        }
        $url = "/api/uploads/{$name}";

        return $this->json(['url' => $url, 'viewUrl' => SignedUrl::sign($url), 'size' => strlen($body), 'type' => self::TYPES[$ext]], 201);
    }

    /*
     * เปิดดูไฟล์ได้โดยไม่ต้องแนบ token เพราะ <img src> แนบ Authorization header ไม่ได้
     * ต้องเป็นลิงก์ที่ API เซ็นให้และยังไม่หมดอายุ · ตอบ 404 เหมือนไม่มีไฟล์ ไม่บอกว่าไฟล์มีอยู่จริงหรือเปล่า
     */
    public function show(string $name)
    {
        // รับเฉพาะรูปแบบที่ระบบสร้างเอง — กันทั้ง ../ และชื่อแปลกปลอมทุกชนิด
        if (! preg_match('/^[0-9a-f]{32}\.(jpg|png|gif|webp|pdf)$/', $name, $m)) {
            throw ApiException::notFound('ไม่พบไฟล์');
        }
        if (! SignedUrl::verify($name, $this->request->getGet('exp'), $this->request->getGet('sig'))) {
            throw ApiException::notFound('ลิงก์ไฟล์หมดอายุหรือไม่ถูกต้อง — เปิดจากหน้าในระบบอีกครั้ง');
        }
        $file = config(Paynest::class)->uploadPath($name);
        if (! is_file($file)) {
            throw ApiException::notFound('ไม่พบไฟล์');
        }

        return $this->response
            ->setStatusCode(200)
            ->setContentType(self::TYPES[$m[1]])
            ->setHeader('Cache-Control', 'private, max-age=86400')
            // บังคับให้เบราว์เซอร์แสดงผลตามชนิดที่เราตรวจแล้ว ไม่ให้เดาเอง
            ->setHeader('X-Content-Type-Options', 'nosniff')
            ->setBody((string) file_get_contents($file));
    }
}
