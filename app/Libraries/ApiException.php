<?php

namespace App\Libraries;

use RuntimeException;

/**
 * ข้อผิดพลาดที่ตั้งใจส่งถึงผู้ใช้ — กลายเป็น JSON { error: { code, message, details } } เสมอ
 *
 * โยนได้จากทุกชั้น (service / controller / filter) แล้ว BaseApiController แปลงเป็น response ให้
 * ข้อความเป็นภาษาไทยและบอกว่าต้องทำอะไรต่อ ไม่ใช่แค่ว่าผิด
 */
class ApiException extends RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly mixed $details = null,
    ) {
        parent::__construct($message, $status);
    }

    public static function badRequest(string $message, mixed $details = null): self
    {
        return new self(400, 'BAD_REQUEST', $message, $details);
    }

    public static function unauthorized(string $message = 'ต้องเข้าสู่ระบบก่อน'): self
    {
        return new self(401, 'UNAUTHORIZED', $message);
    }

    public static function forbidden(string $message = 'ไม่มีสิทธิ์เข้าถึงข้อมูลนี้'): self
    {
        return new self(403, 'FORBIDDEN', $message);
    }

    public static function notFound(string $message = 'ไม่พบข้อมูล'): self
    {
        return new self(404, 'NOT_FOUND', $message);
    }

    public static function conflict(string $message, mixed $details = null): self
    {
        return new self(409, 'CONFLICT', $message, $details);
    }

    /** รูปแบบที่ส่งออกทาง API — details ไม่มี = ไม่ใส่คีย์ (แบบ JSON.stringify ตัด undefined) */
    public function toArray(): array
    {
        $error = ['code' => $this->errorCode, 'message' => $this->getMessage()];
        if ($this->details !== null) {
            $error['details'] = $this->details;
        }

        return ['error' => $error];
    }
}
