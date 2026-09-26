<?php

namespace App\Libraries;

use App\Filters\SecurityHeaders;
use App\Services\NotificationService;
use CodeIgniter\Debug\ExceptionHandler;
use CodeIgniter\Debug\ExceptionHandlerInterface;
use CodeIgniter\HTTP\IncomingRequest;
use CodeIgniter\HTTP\RequestInterface;
use CodeIgniter\HTTP\ResponseInterface;
use Config\Exceptions;
use Throwable;

/**
 * error ที่หลุดมาถึงเฟรมเวิร์ก (นอก controller) — ตอบเป็น JSON รูปแบบเดียวกับ API เสมอ
 * ไม่ส่งหน้า error ของ CodeIgniter ที่มี path/trace ออกไป (ต่อให้ลืมตั้ง CI_ENVIRONMENT=production)
 * คำสั่ง CLI (php spark) ยังใช้ตัวแสดงผลเดิมของเฟรมเวิร์ก
 */
class JsonErrorHandler implements ExceptionHandlerInterface
{
    public function __construct(private readonly Exceptions $config)
    {
    }

    public function handle(Throwable $exception, RequestInterface $request, ResponseInterface $response, int $statusCode, int $exitCode): void
    {
        if (! $request instanceof IncomingRequest) {
            (new ExceptionHandler($this->config))->handle($exception, $request, $response, $statusCode, $exitCode);

            return;
        }
        $path = '/' . ltrim($request->getUri()->getPath(), '/');

        if ($exception instanceof ApiException) {
            [$status, $body] = [$exception->status, $exception->toArray()];
        } elseif ($statusCode === 404 || str_contains($exception->getMessage(), 'disallowed characters')) {
            // URL แปลก ๆ (เช่น %00) = ไม่มีเส้นทางนี้ ไม่ใช่ error ของระบบ
            [$status, $body] = [404, ['error' => ['code' => 'ROUTE_NOT_FOUND', 'message' => 'ไม่พบ endpoint: ' . $request->getMethod() . ' ' . $path]]];
        } elseif (Db::isConstraintError($exception)) {
            [$status, $body] = [409, ['error' => ['code' => 'CONSTRAINT_VIOLATION', 'message' => 'ข้อมูลขัดกับข้อกำหนดของระบบ']]];
        } elseif ($statusCode >= 400 && $statusCode < 500) {
            [$status, $body] = [$statusCode, ['error' => ['code' => 'BAD_REQUEST', 'message' => 'คำขอไม่ถูกต้อง']]];
        } else {
            NotificationService::notifySystemError($exception, $request->getMethod(), $path);
            [$status, $body] = [500, ['error' => ['code' => 'INTERNAL_ERROR', 'message' => 'เกิดข้อผิดพลาดภายในระบบ']]];
        }

        $response->setStatusCode($status)->setContentType('application/json', 'utf-8')->setBody(Json::encode($body));
        SecurityHeaders::apply($response)->send();

        if (ENVIRONMENT !== 'testing') {
            exit($exitCode); // @codeCoverageIgnore
        }
    }
}
