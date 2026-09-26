<?php

namespace App\Controllers\Api;

use App\Libraries\ApiException;
use App\Libraries\ClientIp;
use App\Libraries\Db;
use App\Libraries\Jwt;
use App\Libraries\V;
use App\Services\Audit;
use App\Services\BootstrapService;
use App\Services\NotificationService;
use App\Services\OnboardingService;
use App\Services\TelegramService;
use App\Services\TwoFactorService;
use App\Services\UserService;
use Config\Paynest;

/** ล็อกอิน · 2FA · ยืนยันรหัส 6 หลัก · เช็กลิสต์ครั้งแรก · Telegram ของผู้ใช้ — /api/auth */
class Auth extends BaseApiController
{
    public function login()
    {
        $body = V::parse(V::object([
            'username' => V::string()->min(1, 'กรุณากรอกชื่อผู้ใช้'),
            'password' => V::string()->min(1, 'กรุณากรอกรหัสผ่าน'),
        ]), $this->body());

        // ติดตั้งใหม่ยังไม่มีแอดมิน = สร้างให้ (รหัสสุ่มอยู่ในไฟล์บนเซิร์ฟเวอร์ ไม่มีใครเดาได้)
        BootstrapService::ensureSuperAdmin();

        $user = UserService::findByUsername($body['username']);
        // ข้อความเดียวกันทุกกรณี เพื่อไม่ให้เดาได้ว่าชื่อผู้ใช้มีอยู่จริงไหม
        if ($user === null) {
            UserService::burnPasswordCheck($body['password']);

            throw ApiException::unauthorized('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
        }
        if (! UserService::verifyPassword($body['password'], $user['password_hash'])) {
            throw ApiException::unauthorized('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
        }
        if ($user['status'] !== 'ACTIVE') {
            throw ApiException::unauthorized('บัญชีนี้ถูกปิดใช้งาน');
        }
        // เปิด 2FA ไว้ = รหัสผ่านถูกยังไม่พอ ต้องใส่รหัส 6 หลักต่อ (mfaToken ใช้เข้าระบบเองไม่ได้)
        if ($user['totp_enabled_at']) {
            return $this->json(['mfaRequired' => true, 'mfaToken' => Jwt::forPurpose($user, 'mfa')]);
        }

        return $this->json($this->completeLogin($user));
    }

    private function completeLogin(array $user): array
    {
        UserService::touchLogin((int) $user['id']);
        Audit::write((int) $user['id'], 'auth.login', 'user', (int) $user['id']);
        // แอดมินเข้าระบบจากที่ที่ไม่คุ้น = สัญญาณแรกว่ารหัสหลุด (ร้านค้าเข้าระบบปิดไว้เป็นค่าตั้งต้น — เยอะเกิน)
        $admin = $user['role'] === 'SUPER_ADMIN';
        $name  = TelegramService::escapeHtml($user['display_name'] ? "{$user['display_name']} ({$user['username']})" : $user['username']);
        $ip    = TelegramService::escapeHtml(ClientIp::get() ?: '—');
        NotificationService::notify($admin ? 'login.admin' : 'login.shop', implode("\n", [
            ($admin ? '🛡' : '👤') . ' <b>' . ($admin ? 'ส่วนกลาง' : 'ผู้ใช้') . 'เข้าสู่ระบบ</b>',
            "บัญชี: <b>{$name}</b>",
            "IP: {$ip}",
        ]), ['line' => "{$name} · IP {$ip}"]);

        return [
            'token' => Jwt::forUser($user),
            'user'  => UserService::serialize($user),
            // ส่วนกลางที่ยังไม่มี 2FA ต้องตั้งก่อน (guard กันเส้นทางอื่นไว้แล้ว — ตัวนี้บอกหน้าเว็บให้พาไปตั้ง)
            'enrollRequired'     => config(Paynest::class)->requireAdmin2fa() && $admin && ! $user['totp_enabled_at'],
            'mustChangePassword' => (int) $user['must_change_password'] === 1,
        ];
    }

    /** ขั้นที่สองของการล็อกอิน — รับรหัสจากแอปหรือรหัสสำรอง */
    public function loginMfa()
    {
        $body    = V::parse(V::object(['mfaToken' => V::string(), 'code' => V::string()->min(1, 'กรุณากรอกรหัส')]), $this->body());
        $payload = Jwt::verifyPurpose($body['mfaToken'], 'mfa');
        if ($payload === null) {
            throw ApiException::unauthorized('หมดเวลายืนยัน — เข้าสู่ระบบใหม่อีกครั้ง');
        }
        $user = UserService::getById((int) $payload['sub']);
        if ($user['status'] !== 'ACTIVE' || ($payload['tv'] ?? null) !== (int) $user['token_version']) {
            throw ApiException::unauthorized('หมดเวลายืนยัน — เข้าสู่ระบบใหม่อีกครั้ง');
        }
        $used = TwoFactorService::verifyLoginCode((int) $user['id'], $body['code']);
        // แอดมินต้องใช้รหัสสำรอง = มือถือหาย หรือมีคนได้รหัสสำรองไป — ต้องมีคนรู้
        if ($used['method'] === 'backup' && $user['role'] === 'SUPER_ADMIN') {
            NotificationService::notify('security.backup_code', implode("\n", [
                '🔑 <b>บัญชีส่วนกลางล็อกอินด้วยรหัสสำรอง</b>',
                'บัญชี: <b>' . TelegramService::escapeHtml($user['username']) . "</b> · เหลือรหัสสำรอง {$used['remaining']} ชุด",
                '',
                'ถ้าไม่ใช่คุณ: เปลี่ยนรหัสผ่านทันที แล้วสร้างรหัสสำรองชุดใหม่',
            ]));
        }
        $result = [...$this->completeLogin(UserService::getById((int) $user['id'])), 'usedBackupCode' => $used['method'] === 'backup'];
        if (isset($used['remaining'])) {
            $result['backupCodesLeft'] = $used['remaining'];
        }

        return $this->json($result);
    }

    public function me()
    {
        return $this->json(['user' => UserService::serialize($this->user())]);
    }

    public function changePassword()
    {
        $body = V::parse(V::object([
            'currentPassword' => V::string()->min(1),
            'newPassword'     => V::string()->min(8, 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร'),
        ]), $this->body());
        $user = UserService::findByUsername($this->user()['username']);
        // 403 ไม่ใช่ 401 — หน้าเว็บเจอ 401 จะเตะออกจากระบบทั้งที่แค่พิมพ์รหัสเดิมผิด
        if (! UserService::verifyPassword($body['currentPassword'], $user['password_hash'])) {
            throw new ApiException(403, 'WRONG_PASSWORD', 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
        }
        if ($body['newPassword'] === $body['currentPassword']) {
            throw ApiException::badRequest('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม');
        }
        UserService::setPassword((int) $user['id'], $body['newPassword']);
        if ((int) $user['must_change_password'] === 1) {
            Db::exec('UPDATE users SET must_change_password = 0 WHERE id = ?', [$user['id']]);
            // รหัสในไฟล์ใช้ไม่ได้แล้ว — ลบทิ้ง ไม่ให้ค้างอยู่บนดิสก์
            @unlink(BootstrapService::initialPasswordFile());
        }
        Audit::write((int) $user['id'], 'auth.change_password', 'user', (int) $user['id']);

        // token ทุกใบของบัญชีนี้ใช้ไม่ได้แล้ว (รวมเครื่องที่กดเปลี่ยน) — ออกใบใหม่ให้เครื่องนี้ใช้ต่อ
        return $this->json(['ok' => true, 'token' => Jwt::forUser(UserService::findByUsername($user['username']))]);
    }

    /* ── ยืนยันตัวตนสองชั้น ─────────────────────────────────────────── */

    private function codeBody(): string
    {
        return V::parse(V::object(['code' => V::string()->min(1, 'กรุณากรอกรหัส 6 หลัก')]), $this->body())['code'];
    }

    public function twoFactorStatus()
    {
        return $this->json(TwoFactorService::status($this->user()));
    }

    public function twoFactorSetup()
    {
        return $this->json(TwoFactorService::startSetup((int) $this->user()['id']));
    }

    /** เปิดใช้แล้ว session เก่าทุกอันหลุด — ส่ง token ใบใหม่ให้เครื่องนี้ใช้ต่อ พร้อมรหัสสำรอง (โชว์ครั้งเดียว) */
    public function twoFactorEnable()
    {
        $code   = $this->codeBody();
        $result = TwoFactorService::enable((int) $this->user()['id'], $code);
        $user   = UserService::getById((int) $this->user()['id']);

        return $this->json(['token' => Jwt::forUser($user), 'user' => UserService::serialize($user), 'backupCodes' => $result['backupCodes']]);
    }

    public function twoFactorDisable()
    {
        $code = $this->codeBody();
        TwoFactorService::disable((int) $this->user()['id'], $code);
        $user = UserService::getById((int) $this->user()['id']);

        return $this->json(['token' => Jwt::forUser($user), 'user' => UserService::serialize($user)]);
    }

    public function twoFactorBackupCodes()
    {
        $code = $this->codeBody();

        return $this->json(TwoFactorService::regenerateBackupCodes((int) $this->user()['id'], $code));
    }

    /**
     * ยืนยันรหัส 6 หลักก่อนทำเรื่องอันตราย — ได้ elevation token อายุ 5 นาที
     * ในช่วงนั้นแก้บัญชีรับเงินต่อกันได้โดยไม่ต้องใส่รหัสซ้ำทุกครั้ง (แบบ sudo mode ของ GitHub)
     */
    public function elevate()
    {
        $body = V::parse(V::object(['code' => V::string()->optional(), 'password' => V::string()->optional()]), $this->body());
        $user = $this->user();
        if ($user['totp_enabled_at'] || config(Paynest::class)->requireAdmin2fa()) {
            TwoFactorService::verifyAppCode((int) $user['id'], $body['code'] ?? null);
        } else {
            // โหมดทดสอบ + ยังไม่ได้ตั้ง 2FA: ยืนยันด้วยรหัสผ่านแทน (เซิร์ฟเวอร์จริงไม่มีทางมาถึงตรงนี้)
            $row = UserService::findByUsername($user['username']);
            if (empty($body['password']) || ! UserService::verifyPassword($body['password'], $row['password_hash'])) {
                throw new ApiException(403, 'OTP_INVALID', 'รหัสผ่านไม่ถูกต้อง');
            }
        }
        Audit::write((int) $user['id'], 'auth.elevate', 'user', (int) $user['id']);

        return $this->json(['elevationToken' => Jwt::forPurpose($user, 'elevate', 300), 'expiresIn' => 300]);
    }

    /** ปลด 2FA ให้ผู้ใช้ที่มือถือหาย — ส่วนกลางเท่านั้น และต้องเพิ่งใส่รหัสของตัวเอง */
    public function resetTwoFactor(string $id)
    {
        $actor  = $this->user();
        $target = TwoFactorService::reset(V::parseId($id), (int) $actor['id']);
        NotificationService::notify('security.2fa_reset', implode("\n", [
            '🔓 <b>ปลด Google Authenticator ของผู้ใช้</b>',
            'ผู้ใช้: <b>' . TelegramService::escapeHtml($target['username']) . '</b>',
            'โดย: <b>' . TelegramService::escapeHtml($actor['username']) . '</b>',
        ]));

        return $this->json(['ok' => true]);
    }

    /* ── เช็กลิสต์ครั้งแรก ──────────────────────────────────────────── */

    public function onboarding()
    {
        return $this->json(OnboardingService::status((int) $this->user()['id']));
    }

    public function updateOnboarding()
    {
        $body = V::parse(V::object(['viewedBill' => V::boolean()->optional(), 'dismissed' => V::boolean()->optional()]), $this->body());

        return $this->json(OnboardingService::update((int) $this->user()['id'], $body));
    }

    /* ── Telegram ของผู้ใช้เอง (ร้านรับแจ้งเตือนในแชตส่วนตัว) ────────────── */

    public function telegram()
    {
        $row = Db::one('SELECT * FROM users WHERE id = ?', [$this->user()['id']]);

        return $this->json([
            'available' => TelegramService::isConfigured(),
            'linked'    => (bool) ($row['telegram_chat_id'] ?? null),
            // เรื่องที่เลือกรับได้ — เฉพาะผู้ใช้ของร้าน (ส่วนกลางตั้งที่หน้าตั้งค่าแจ้งเตือนแทน)
            'events' => ($row['role'] ?? null) === 'FRANCHISE' ? NotificationService::shopNotifyOptions($row) : [],
        ]);
    }

    /** ร้านเลือกเองว่าอยากได้เรื่องไหน — ของตัวเองเท่านั้น ไม่กระทบคนอื่นในร้าน */
    public function telegramPrefs()
    {
        $user = $this->user();
        if ($user['role'] !== 'FRANCHISE') {
            throw ApiException::forbidden('ส่วนกลางตั้งค่าที่หน้าตั้งค่าแจ้งเตือน');
        }
        $body = V::parse(V::object([
            'events' => V::partialRecord(V::enum(NotificationService::shopEventKeys()), V::boolean()),
        ]), $this->body());

        return $this->json(['events' => NotificationService::saveShopPrefs((int) $user['id'], $body['events'])]);
    }

    public function telegramLink()
    {
        return $this->json(TelegramService::createLinkCode((int) $this->user()['id']));
    }

    public function telegramUnlink()
    {
        $id = (int) $this->user()['id'];
        Db::exec('UPDATE users SET telegram_chat_id = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?', [$id]);
        Audit::write($id, 'telegram.unlink', 'user', $id);

        return $this->json(['available' => TelegramService::isConfigured(), 'linked' => false]);
    }
}
