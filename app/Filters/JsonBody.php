<?php

namespace App\Filters;

use App\Libraries\ApiResponse;
use App\Libraries\Js;
use App\Libraries\RequestBody;
use App\Libraries\Undefined;
use App\Services\TurnstileService;
use CodeIgniter\Filters\FilterInterface;
use CodeIgniter\HTTP\RequestInterface;
use CodeIgniter\HTTP\ResponseInterface;
use stdClass;

/**
 * แปลง body JSON ของทุกคำขอ /api/* ก่อนถึง controller
 *
 *   ใหญ่เกิน 256KB            → 413 PAYLOAD_TOO_LARGE
 *   JSON เสีย / ไม่ใช่ object   → 400 INVALID_JSON
 *   ข้อความช่องไหนยาวเกิน 2,000 → 400 (กันไว้ที่เดียว ดีกว่าไล่เติม max() ทุกช่องแล้วลืมสักช่อง)
 *
 * อัปโหลดไฟล์ไม่ผ่านตรงนี้ (ส่งเป็น raw body ชนิดรูป/PDF) — controller อัปโหลดอ่านเอง
 */
class JsonBody implements FilterInterface
{
    public const LIMIT_BYTES = 256 * 1024;
    public const MAX_STRING  = 2000;

    /** ช่องที่ยาวกว่าเพดานทั่วไปได้ — token ของ captcha ยาวได้ถึง 2,048 ตัว (Cloudflare กำหนด) */
    private const LONGER = ['captchaToken' => TurnstileService::MAX_TOKEN];

    public function before(RequestInterface $request, $arguments = null)
    {
        $type = strtolower(trim(explode(';', $request->getHeaderLine('Content-Type'))[0]));
        if ($type !== 'application/json') {
            RequestBody::set(Undefined::get());

            return null;
        }
        $declared = $request->getHeaderLine('Content-Length');
        $raw      = (string) ($request->getBody() ?? '');
        if ((ctype_digit($declared) && (int) $declared > self::LIMIT_BYTES) || strlen($raw) > self::LIMIT_BYTES) {
            return ApiResponse::errorOf(413, 'PAYLOAD_TOO_LARGE', 'ข้อมูลหรือไฟล์ใหญ่เกินกำหนด');
        }
        if (trim($raw) === '') {
            // body ว่างที่ประกาศว่าเป็น JSON = {} (แบบ express.json) · GET ไม่มี body
            RequestBody::set(in_array(strtoupper($request->getMethod()), ['GET', 'HEAD'], true) ? Undefined::get() : new stdClass());

            return null;
        }
        $first = ltrim($raw)[0];
        $value = json_decode($raw, false, 512);
        if (($first !== '{' && $first !== '[') || json_last_error() !== JSON_ERROR_NONE) {
            return ApiResponse::errorOf(400, 'INVALID_JSON', 'รูปแบบ JSON ไม่ถูกต้อง');
        }
        $tooLong = self::findLongString($value, '');
        if ($tooLong !== null) {
            return ApiResponse::errorOf(400, 'BAD_REQUEST', ($tooLong === '' ? 'ข้อมูล' : $tooLong) . ': ยาวเกิน ' . self::MAX_STRING . ' ตัวอักษร');
        }
        RequestBody::set($value);

        return null;
    }

    public function after(RequestInterface $request, ResponseInterface $response, $arguments = null)
    {
        return null;
    }

    /** ชื่อช่องแรกที่ข้อความยาวเกิน (null = ไม่มี) */
    private static function findLongString(mixed $value, string $key): ?string
    {
        if (is_string($value)) {
            return Js::len($value) > (self::LONGER[$key] ?? self::MAX_STRING) ? $key : null;
        }
        if ($value instanceof stdClass || is_array($value)) {
            foreach ((array) $value as $k => $v) {
                $found = self::findLongString($v, (string) $k);
                if ($found !== null) {
                    return $found;
                }
            }
        }

        return null;
    }
}
