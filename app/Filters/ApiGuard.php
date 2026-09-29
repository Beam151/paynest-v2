<?php

namespace App\Filters;

use App\Libraries\ApiException;
use App\Libraries\ApiResponse;
use App\Libraries\AuthContext;
use App\Libraries\ClientIp;
use App\Libraries\Db;
use App\Libraries\Js;
use App\Libraries\Jwt;
use App\Libraries\Permissions;
use App\Libraries\RateLimiter;
use App\Libraries\RequestBody;
use App\Services\NotificationService;
use App\Services\TelegramService;
use App\Services\TurnstileService;
use App\Services\UserService;
use CodeIgniter\Filters\FilterInterface;
use CodeIgniter\HTTP\RequestInterface;
use CodeIgniter\HTTP\ResponseInterface;
use Config\Paynest;

/**
 * ด่านตรวจของเส้นทาง API — ทำทีละขั้นตามลำดับที่เขียนใน Routes.php เช่น
 *   'guard:auth,staff,perm.bills,super,elevated'
 *
 *   auth          ตรวจ Bearer token + โหลดผู้ใช้จากฐานข้อมูล (บัญชีถูกปิดหลังออก token ก็เข้าไม่ได้)
 *   super         ส่วนกลางเท่านั้น
 *   staff         ส่วนกลาง + ร้าน (เซลไม่เกี่ยวกับยอดขาย/บิลของร้าน)
 *   agent         ส่วนกลาง + เซล
 *   perm.a.b      สิทธิ์รายข้อของผู้ช่วยร้าน (มีข้อใดข้อหนึ่งก็ผ่าน)
 *   elevated      เพิ่งยืนยันรหัส 6 หลัก (header x-elevation) — เรื่องอันตราย
 *   limit.login / limit.mfa / limit.code / limit.upload   กันเดารหัส / ถมดิสก์
 *
 * ต้องกันที่เซิร์ฟเวอร์เสมอ ไม่ใช่แค่ซ่อนปุ่มบนหน้าจอ — คนที่รู้ว่ามี endpoint อะไรก็ยิงตรงได้
 */
class ApiGuard implements FilterInterface
{
    /*
     * ส่วนกลางที่ยังไม่ได้ตั้ง 2FA ใช้ได้แค่เส้นทางเหล่านี้ — ตั้งให้เสร็จก่อนถึงจะทำอย่างอื่นได้
     */
    private const ENROLL_PATHS = ['/api/auth/me', '/api/auth/2fa', '/api/auth/2fa/setup', '/api/auth/2fa/enable', '/api/auth/change-password'];

    /** ตัวนับที่คำขอนี้นับไป — ถ้าคำขอสำเร็จตามกติกาของตัวนับนั้น จะคืนให้ตอนจบ (นับเฉพาะครั้งที่พลาด) */
    private static array $counted = [];

    public function before(RequestInterface $request, $arguments = null)
    {
        self::$counted = [];
        try {
            foreach ($arguments ?? [] as $step) {
                $blocked = $this->step($request, (string) $step);
                if ($blocked instanceof ResponseInterface) {
                    return $blocked;
                }
            }
        } catch (ApiException $e) {
            return ApiResponse::error($e);
        }

        return null;
    }

    public function after(RequestInterface $request, ResponseInterface $response, $arguments = null)
    {
        $status = $response->getStatusCode();
        foreach (self::$counted as [$key, $successful]) {
            if ($successful($status)) {
                RateLimiter::undo($key);
            }
        }
        self::$counted = [];

        return null;
    }

    private function step(RequestInterface $request, string $step): ?ResponseInterface
    {
        if ($step === 'auth') {
            $this->requireAuth($request);

            return null;
        }
        if (in_array($step, ['super', 'staff', 'agent'], true)) {
            $roles = ['super' => ['SUPER_ADMIN'], 'staff' => ['SUPER_ADMIN', 'FRANCHISE'], 'agent' => ['SUPER_ADMIN', 'SALES']][$step];
            $user  = AuthContext::user() ?? throw ApiException::unauthorized();
            if (! in_array($user['role'], $roles, true)) {
                throw ApiException::forbidden();
            }

            return null;
        }
        if (str_starts_with($step, 'perm.')) {
            $this->requirePermission(explode('.', substr($step, 5)));

            return null;
        }
        if ($step === 'elevated') {
            self::assertElevated($request);

            return null;
        }
        if (str_starts_with($step, 'limit.')) {
            return $this->limit(substr($step, 6));
        }

        throw new \LogicException("unknown guard step: {$step}");
    }

    /* ── ตรวจ token ─────────────────────────────────────────────── */

    private function requireAuth(RequestInterface $request): void
    {
        AuthContext::set(null);
        $header = $request->getHeaderLine('Authorization');
        $token  = str_starts_with($header, 'Bearer ') ? trim(substr($header, 7)) : '';
        if ($token === '') {
            throw ApiException::unauthorized();
        }
        $payload = Jwt::verify($token);
        if ($payload === null) {
            throw ApiException::unauthorized('โทเคนไม่ถูกต้องหรือหมดอายุ');
        }
        // token ใช้งานเฉพาะอย่างเอามาเข้าระบบไม่ได้ — ไม่งั้นแค่รู้รหัสผ่านก็ได้ session โดยไม่ผ่านรหัส 6 หลัก
        if (! empty($payload['purpose'])) {
            throw ApiException::unauthorized('โทเคนไม่ถูกต้องหรือหมดอายุ');
        }
        $sub  = $payload['sub'] ?? null;
        $user = is_int($sub) || (is_string($sub) && ctype_digit($sub)) ? Db::one(
            'SELECT u.id, u.username, u.display_name, u.role, u.franchise_id, u.sales_agent_id,
                    u.status, u.last_login_at, u.is_franchise_owner, u.permissions, u.token_version,
                    u.totp_enabled_at, u.must_change_password, u.created_at,
                    f.status AS franchise_status, f.username AS franchise_username,
                    a.status AS agent_status, a.username AS agent_username, a.name AS agent_name
               FROM users u
               LEFT JOIN franchises f    ON f.id = u.franchise_id
               LEFT JOIN sales_agents a  ON a.id = u.sales_agent_id
              WHERE u.id = ?',
            [(int) $sub],
        ) : null;

        /*
         * ร้านที่ลบแล้ว: ตอนลบระบบปิดผู้ใช้ทุกคน + token_version + 1 ให้อยู่แล้ว — ตรวจร้านซ้ำอีกชั้น
         * กันผู้ใช้ถูกเปิดกลับทีหลัง (แก้ฐานข้อมูลตรง ๆ) แล้วได้ session ของร้านที่ไม่มีอยู่แล้ว
         */
        if ($user === null || $user['status'] !== 'ACTIVE' || ($user['role'] === 'FRANCHISE' && $user['franchise_status'] === 'DELETED')) {
            throw ApiException::unauthorized('บัญชีนี้ถูกปิดใช้งาน');
        }
        // รหัสผ่านถูกเปลี่ยนหลังออก token นี้ — ต้องล็อกอินใหม่
        if (($payload['tv'] ?? 0) !== (int) $user['token_version']) {
            throw ApiException::unauthorized('รหัสผ่านถูกเปลี่ยนแล้ว — กรุณาเข้าสู่ระบบใหม่');
        }
        $route = '/' . ltrim($request->getUri()->getPath(), '/');
        // รหัสเริ่มต้นจากไฟล์ต้องเปลี่ยนก่อน แล้วค่อยตั้ง 2FA — ทำอย่างอื่นไม่ได้จนกว่าจะเสร็จ
        if ((int) $user['must_change_password'] === 1 && $route !== '/api/auth/me' && $route !== '/api/auth/change-password') {
            throw new ApiException(403, 'PASSWORD_CHANGE_REQUIRED', 'ต้องเปลี่ยนรหัสผ่านเริ่มต้นก่อนใช้งาน');
        }
        if (config(Paynest::class)->requireAdmin2fa() && $user['role'] === 'SUPER_ADMIN'
            && ! $user['totp_enabled_at'] && ! in_array($route, self::ENROLL_PATHS, true)) {
            throw new ApiException(403, 'MFA_ENROLL_REQUIRED', 'บัญชีส่วนกลางต้องตั้ง Google Authenticator ก่อนใช้งาน');
        }
        if ($user['role'] === 'FRANCHISE' && $user['franchise_status'] === 'CLOSED') {
            throw ApiException::forbidden('ร้านนี้ถูกปิดแล้ว');
        }
        if ($user['role'] === 'SALES' && $user['agent_status'] !== 'ACTIVE') {
            throw ApiException::forbidden('บัญชีเซลนี้ถูกปิดการใช้งาน');
        }
        AuthContext::set($user);
    }

    /** @param list<string> $keys */
    private function requirePermission(array $keys): void
    {
        $user = AuthContext::user() ?? throw ApiException::unauthorized();
        foreach ($keys as $key) {
            if (Permissions::has($user, $key)) {
                return;
            }
        }
        $labels = implode(' หรือ ', array_map([Permissions::class, 'labelOf'], $keys));

        throw ApiException::forbidden("บัญชีของคุณไม่มีสิทธิ์: {$labels} — ติดต่อเจ้าของบัญชีร้านเพื่อเปิดสิทธิ์");
    }

    /**
     * เรื่องอันตราย (แก้บัญชีรับเงิน ตั้งค่า Telegram ปลด 2FA คนอื่น) ต้องเพิ่งใส่รหัส 6 หลักจากแอป
     *
     * หลักฐานคือ elevation token ใน header x-elevation — ได้จาก POST /api/auth/elevate
     * หน้าเว็บเก็บไว้ในหน่วยความจำเท่านั้น คนที่ขโมย session token ไปจึงไม่มีตัวนี้
     * ผูกกับผู้ใช้และ token_version — เปลี่ยนรหัสผ่าน/ปิด 2FA แล้วใช้ต่อไม่ได้
     *
     * ตอบ 403 ไม่ใช่ 401 เพราะหน้าเว็บเจอ 401 จะเตะออกจากระบบ
     */
    public static function assertElevated(RequestInterface $request): void
    {
        $user    = AuthContext::require();
        $payload = Jwt::verifyPurpose($request->getHeaderLine('x-elevation'), 'elevate');
        if ($payload === null || ($payload['sub'] ?? null) !== (int) $user['id'] || ($payload['tv'] ?? null) !== (int) $user['token_version']) {
            throw new ApiException(403, 'ELEVATION_REQUIRED', 'ต้องใส่รหัส 6 หลักจากแอป Authenticator ก่อน');
        }
    }

    /* ── rate limit ──────────────────────────────────────────────── */

    private const QUARTER = 900;

    private function limit(string $kind): ?ResponseInterface
    {
        $ip        = ClientIp::limitKey(ClientIp::get());
        $failedOnly = static fn (int $status): bool => $status < 400;

        switch ($kind) {
            /*
             * กันเดารหัสผ่าน — สามชั้น นับเฉพาะครั้งที่ล็อกอินไม่ผ่าน
             * ชั้นบัญชี: เดาบัญชีเดียวซ้ำ ๆ (brute force)
             * ชั้น IP: ลองรหัสยอดนิยมไล่ทีละบัญชี (password spraying)
             * ชั้น captcha: หลาย IP ผลัดกันเดาบัญชีเดียว (botnet) — ดู loginCaptcha()
             * ไม่ล็อกบัญชีทั้งระบบ (ไม่ผูกกับ IP) เพราะคนร้ายจะยิงรหัสผิดใส่ superadmin แล้วส่วนกลางทั้งหมดล็อกอินไม่ได้แทน
             */
            case 'login':
                $username = mb_strtolower(Js::toString(RequestBody::field('username') ?? ''));

                return $this->count("login:{$ip}|{$username}", 10, self::QUARTER, $failedOnly, fn (bool $justLocked) => $this->loginLocked(
                    'ล็อกอินผิดหลายครั้งเกินไป — รอ 15 นาทีแล้วลองใหม่',
                    'บัญชี',
                    $justLocked,
                ))
                    ?? $this->count("login-ip:{$ip}", 30, self::QUARTER, $failedOnly, fn (bool $justLocked) => $this->loginLocked(
                        'มีการล็อกอินผิดจากเครือข่ายนี้หลายครั้งเกินไป — รอ 15 นาทีแล้วลองใหม่',
                        'เครือข่าย',
                        $justLocked,
                    ))
                    ?? $this->loginCaptcha($username, $failedOnly);

            // ด่านรหัส 6 หลักตอนล็อกอิน — ยังไม่มี session จึงนับตามผู้ใช้ใน mfa token + IP
            case 'mfa':
                $sub = Jwt::peekSubject(RequestBody::field('mfaToken'));

                return $this->count("mfa:{$sub}", 5, self::QUARTER, $failedOnly, static fn () => ApiResponse::errorOf(
                    429,
                    'TOO_MANY_REQUESTS',
                    'ใส่รหัสผิดหลายครั้งเกินไป — รอ 15 นาทีแล้วลองใหม่',
                ))
                    ?? $this->count("mfa-ip:{$ip}", 30, self::QUARTER, $failedOnly, static fn () => ApiResponse::errorOf(
                        429,
                        'TOO_MANY_REQUESTS',
                        'ใส่รหัสผิดจากเครือข่ายนี้หลายครั้งเกินไป — รอ 15 นาทีแล้วลองใหม่',
                    ));

            /*
             * ใส่รหัส 6 หลักผิด 5 ครั้งใน 15 นาที = ล็อกทุกช่องที่ถามรหัส 6 หลักของบัญชีนั้น
             * นับ 403 (รหัสผิด) และ 429 (โดนบล็อกอยู่)
             */
            case 'code':
                $user = AuthContext::require();

                return $this->count('code:' . $user['id'], 5, self::QUARTER, static fn (int $s) => $s !== 403 && $s !== 429, static function (bool $justLocked) use ($user) {
                    // ถือ session อยู่แต่ไม่มีรหัสจากมือถือ = เกือบแน่ว่าไม่ใช่เจ้าของ — แจ้งครั้งเดียวตอนเพิ่งโดนล็อก
                    if ($justLocked && $user['role'] === 'SUPER_ADMIN') {
                        NotificationService::notify('security.code_lockout', implode("\n", [
                            '🔐 <b>มีคนใส่รหัส 6 หลักผิดหลายครั้งในบัญชีส่วนกลาง</b>',
                            'บัญชี: <b>' . TelegramService::escapeHtml($user['username']) . '</b>',
                            'ล็อกการยืนยันตัวตนไว้ 15 นาทีแล้ว',
                            '',
                            'ถ้าไม่ใช่คุณ: session นี้อาจถูกขโมย — เปลี่ยนรหัสผ่านทันที (เครื่องอื่นจะหลุดหมด)',
                        ]));
                    }

                    return ApiResponse::errorOf(429, 'TOO_MANY_REQUESTS', 'ใส่รหัสผิดหลายครั้งเกินไป — รอ 15 นาทีแล้วลองใหม่');
                });

            // อัปโหลดได้ชั่วโมงละ 60 ไฟล์ต่อบัญชี — ใช้งานจริงไม่ถึง แต่กันยิงวนถมดิสก์ (ไฟล์ละ 8MB)
            case 'upload':
                $user = AuthContext::require();

                return $this->count('upload:' . $user['id'], 60, 3600, static fn () => false, static fn () => ApiResponse::errorOf(
                    429,
                    'TOO_MANY_REQUESTS',
                    'อัปโหลดไฟล์ถี่เกินไป — ลองใหม่ในอีกสักครู่',
                ));
        }

        throw new \LogicException("unknown limiter: {$kind}");
    }

    /**
     * นับหนึ่งครั้ง — เกินกำหนดแล้วคืน response 429
     *
     * @param callable(int): bool                   $successful กติกาว่าคำขอแบบไหนนับว่า "สำเร็จ" (จะคืนตัวนับให้)
     * @param callable(bool): ResponseInterface      $blocked    รับ true เมื่อเพิ่งโดนล็อกครั้งนี้ (ไว้แจ้งเตือนครั้งเดียว)
     */
    private function count(string $key, int $limit, int $window, callable $successful, callable $blocked): ?ResponseInterface
    {
        $current = RateLimiter::hit($key, $window);
        if ($current > $limit) {
            return $blocked($current === $limit + 1);
        }
        self::$counted[] = [$key, $successful];

        return null;
    }

    /** แจ้งครั้งเดียวตอนเพิ่งโดนล็อก ไม่ใช่ทุกคำขอที่ถูกบล็อก */
    private function loginLocked(string $message, string $what, bool $justLocked): ResponseInterface
    {
        if ($justLocked) {
            $ip       = TelegramService::escapeHtml(ClientIp::get());
            $raw      = mb_substr(Js::toString(RequestBody::field('username') ?? ''), 0, 60);
            $username = TelegramService::escapeHtml($raw !== '' ? $raw : '—');
            NotificationService::notify('security.login_lockout', implode("\n", [
                '🚫 <b>มีคนเดารหัสผ่านจนถูกล็อก</b>',
                "{$what}: <b>" . ($what === 'บัญชี' ? $username : $ip) . '</b>',
                "IP: {$ip} · ล็อก 15 นาที",
            ]), ['line' => ($what === 'บัญชี' ? $username : 'หลายบัญชี') . " จาก IP {$ip}"]);
        }

        return ApiResponse::errorOf(429, 'TOO_MANY_REQUESTS', $message);
    }

    /**
     * ชั้นที่สามของการกันเดารหัส — นับตามชื่อบัญชีอย่างเดียว ไม่ผูก IP
     * สองชั้นแรกผูก IP: คนร้ายที่มีหลาย IP ได้ลองคนละ 10 ครั้ง รวมกันแล้วไม่จำกัด
     * ผิดเกินกำหนดใน 1 ชั่วโมง = ต้องผ่าน captcha ก่อน (ไม่ล็อก — เจ้าของบัญชีตัวจริงยังเข้าได้)
     * ยังไม่ได้ตั้ง captcha ก็ยังนับ เพื่อแจ้งกลุ่มว่าบัญชีไหนกำลังถูกเดา
     *
     * นับชื่อที่ไม่มีอยู่จริงด้วย — ไม่งั้นดูจากการถาม captcha ก็รู้ว่าชื่อไหนมีจริง
     */
    private function loginCaptcha(string $username, callable $successful): ?ResponseInterface
    {
        $key  = "login-user:{$username}";
        $hits = RateLimiter::hit($key, TurnstileService::LOGIN_WINDOW);
        self::$counted[] = [$key, $successful];
        if ($hits <= TurnstileService::LOGIN_THRESHOLD) {
            return null;
        }
        $configured = TurnstileService::isConfigured();
        // แจ้งครั้งเดียวตอนเพิ่งเกิน · ชื่อที่ไม่มีจริงไม่แจ้ง (คนร้ายสุ่มชื่อมาเป็นร้อยจะท่วมกลุ่ม)
        if ($hits === TurnstileService::LOGIN_THRESHOLD + 1 && UserService::findByUsername($username) !== null) {
            $name = TelegramService::escapeHtml(mb_substr($username, 0, 60));
            $ip   = TelegramService::escapeHtml(ClientIp::get());
            NotificationService::notify('security.login_captcha', implode("\n", [
                '🧩 <b>บัญชีถูกใส่รหัสผิดเกิน ' . TurnstileService::LOGIN_THRESHOLD . ' ครั้งใน 1 ชั่วโมง</b>',
                "บัญชี: <b>{$name}</b> · ครั้งล่าสุดจาก IP {$ip}",
                $configured
                    ? 'ต่อจากนี้ต้องยืนยันว่าไม่ใช่บอทก่อนเข้าระบบ (จนครบชั่วโมง)'
                    : 'ยังไม่ได้เปิด captcha — คนร้ายที่มีหลาย IP ยังเดาต่อได้ · เปิดได้ที่หน้าตั้งค่า',
            ]), ['line' => "{$name} จาก IP {$ip}"]);
        }
        if ($configured) {
            TurnstileService::verifyLogin(RequestBody::field('captchaToken'));
        }

        return null;
    }
}
