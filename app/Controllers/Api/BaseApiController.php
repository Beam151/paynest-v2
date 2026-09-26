<?php

namespace App\Controllers\Api;

use App\Libraries\ApiException;
use App\Libraries\ApiResponse;
use App\Libraries\AuthContext;
use App\Libraries\Db;
use App\Libraries\RequestBody;
use App\Services\NotificationService;
use CodeIgniter\Controller;
use CodeIgniter\HTTP\ResponseInterface;
use Throwable;

/**
 * ฐานของ controller ใน /api/* — ชั้น HTTP ล้วน: อ่าน input ตรวจด้วย V แล้วเรียก service
 * ตรรกะธุรกิจอยู่ใน app/Services ทั้งหมด (ไม่เขียนในนี้)
 *
 * error ทุกชนิดกลายเป็น { error: { code, message, details } } ที่นี่ที่เดียว:
 *   ApiException           → สถานะ/ข้อความตามที่ service ตั้ง
 *   ข้อมูลขัด constraint     → 409 CONSTRAINT_VIOLATION (ไม่เผยชื่อตาราง/คอลัมน์)
 *   อย่างอื่น              → 500 INTERNAL_ERROR + log + แจ้ง Telegram (รายละเอียดอยู่ใน log เท่านั้น)
 */
abstract class BaseApiController extends Controller
{
    public function _remap(string $method, ...$params)
    {
        if (str_starts_with($method, '_') || ! method_exists($this, $method) || ! (new \ReflectionMethod($this, $method))->isPublic()) {
            return ApiResponse::errorOf(404, 'ROUTE_NOT_FOUND', 'ไม่พบ endpoint: ' . $this->request->getMethod() . ' /' . ltrim($this->request->getUri()->getPath(), '/'), $this->response);
        }
        try {
            return $this->{$method}(...$params);
        } catch (ApiException $e) {
            return ApiResponse::error($e, $this->response);
        } catch (Throwable $e) {
            if (Db::isConstraintError($e)) {
                return ApiResponse::errorOf(409, 'CONSTRAINT_VIOLATION', 'ข้อมูลขัดกับข้อกำหนดของระบบ', $this->response);
            }
            log_message('critical', '[unhandled] ' . $e::class . ': ' . $e->getMessage() . "\n" . $e->getTraceAsString());
            NotificationService::notifySystemError($e, $this->request->getMethod(), '/' . ltrim($this->request->getUri()->getPath(), '/'));

            return ApiResponse::errorOf(500, 'INTERNAL_ERROR', 'เกิดข้อผิดพลาดภายในระบบ', $this->response);
        }
    }

    protected function json(mixed $data, int $status = 200): ResponseInterface
    {
        return ApiResponse::json($data, $status, $this->response);
    }

    /** ผู้ใช้ที่ผ่าน guard:auth มาแล้ว */
    protected function user(): array
    {
        return AuthContext::require();
    }

    /** body JSON (Undefined ถ้าไม่ได้ส่งมา) */
    protected function body(): mixed
    {
        return RequestBody::get();
    }

    /** body หรือ {} — แบบ req.body ?? {} */
    protected function bodyOrEmpty(): mixed
    {
        return RequestBody::orEmpty();
    }

    /** query string เป็นข้อความ (ไม่ได้ส่งมา = null) */
    protected function q(string $key): ?string
    {
        $value = $this->request->getGet($key);
        if (is_array($value)) {
            $value = implode(',', array_filter($value, 'is_scalar'));
        }

        return $value === null ? null : (string) $value;
    }

    /** query string ดิบ (อาเรย์ได้ ถ้าส่งซ้ำ) */
    protected function qRaw(string $key): mixed
    {
        return $this->request->getGet($key);
    }
}
