<?php

namespace App\Libraries;

use CodeIgniter\HTTP\ResponseInterface;

/** ประกอบ response JSON — ใช้ทั้งใน controller และ filter */
final class ApiResponse
{
    public static function json(mixed $data, int $status = 200, ?ResponseInterface $response = null): ResponseInterface
    {
        $response ??= service('response');

        return $response
            ->setStatusCode($status)
            ->setContentType('application/json', 'utf-8')
            ->setBody(Json::encode($data));
    }

    public static function error(ApiException $e, ?ResponseInterface $response = null): ResponseInterface
    {
        return self::json($e->toArray(), $e->status, $response);
    }

    public static function errorOf(int $status, string $code, string $message, ?ResponseInterface $response = null): ResponseInterface
    {
        return self::json(['error' => ['code' => $code, 'message' => $message]], $status, $response);
    }
}
