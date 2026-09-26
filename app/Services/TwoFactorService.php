<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Db;
use App\Libraries\SecretBox;
use App\Libraries\Totp;
use Config\Paynest;

/**
 * ยืนยันตัวตนสองชั้นแบบ TOTP (RFC 6238) — ใช้กับ Google Authenticator,
 * Microsoft Authenticator, Authy, 1Password ได้หมด ไม่ต้องพึ่งบริการภายนอกและไม่มีค่า SMS
 *
 * super admin บังคับ (ดู ApiGuard) · ร้านค้า/เซลเลือกเปิดเอง
 */
final class TwoFactorService
{
    private const BACKUP_CODE_COUNT = 10;

    private static function userRow(int $userId): array
    {
        return Db::one('SELECT * FROM users WHERE id = ?', [$userId]) ?? throw ApiException::notFound('ไม่พบผู้ใช้');
    }

    private static function hashCode(string $code): string
    {
        return hash('sha256', $code);
    }

    /** รหัสสำรองพิมพ์ได้ทั้งมีขีด/ไม่มีขีด ตัวเล็ก/ตัวใหญ่ */
    private static function normalizeBackup(mixed $code): string
    {
        return preg_replace('/[^a-z0-9]/', '', strtolower((string) ($code ?? ''))) ?? '';
    }

    private static function cleanTotp(mixed $code): string
    {
        return preg_replace('/\s/u', '', (string) ($code ?? '')) ?? '';
    }

    private static function bumpTokenVersion(int $userId): void
    {
        Db::exec('UPDATE users SET token_version = token_version + 1, updated_at = UTC_TIMESTAMP() WHERE id = ?', [$userId]);
    }

    private static function requireAdmin2fa(): bool
    {
        return config(Paynest::class)->requireAdmin2fa();
    }

    /* ── ตรวจรหัส ───────────────────────────────────────────────── */

    /**
     * ตรวจรหัส 6 หลักจากแอป
     * ยอมคลาดเคลื่อน ±1 ช่วง (30 วิ) เผื่อนาฬิกามือถือไม่ตรง
     * รหัสของช่วงที่ใช้ไปแล้วใช้ซ้ำไม่ได้ ต่อให้ยังไม่หมดเวลา
     */
    private static function checkTotp(array $user, string $code): array
    {
        if (! $user['totp_secret'] || ! preg_match('/^\d{6}$/', $code)) {
            return ['ok' => false, 'reused' => false];
        }
        $delta = Totp::validate(SecretBox::open($user['totp_secret']), $code, 1);
        if ($delta === null) {
            return ['ok' => false, 'reused' => false];
        }
        $step = Totp::counterAt() + $delta;
        // เงื่อนไขอยู่ใน UPDATE เอง — สองคำขอพร้อมกันด้วยรหัสเดียวกัน ผ่านได้แค่คำขอเดียว
        $claimed = Db::exec('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?', [$step, $user['id'], $step]);

        return $claimed === 1 ? ['ok' => true, 'reused' => false] : ['ok' => false, 'reused' => true];
    }

    private static function useBackupCode(array $user, mixed $code): bool
    {
        $row = Db::one(
            'SELECT id FROM user_backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
            [$user['id'], self::hashCode(self::normalizeBackup($code))],
        );
        if ($row === null) {
            return false;
        }

        return Db::exec('UPDATE user_backup_codes SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL', [$row['id']]) === 1;
    }

    private static function wrongCode(bool $reused): ApiException
    {
        return new ApiException(
            403,
            'OTP_INVALID',
            $reused
                ? 'รหัสนี้เพิ่งถูกใช้ไปแล้ว — รอรหัสถัดไปในแอป (เปลี่ยนทุก 30 วินาที)'
                : 'รหัสไม่ถูกต้อง — ตรวจว่าเวลาในมือถือตั้งเป็นอัตโนมัติ แล้วใช้รหัสล่าสุดในแอป',
        );
    }

    /**
     * ตรวจตอนล็อกอิน — รับได้ทั้งรหัสจากแอปและรหัสสำรอง
     * คืนว่าใช้แบบไหน เพื่อให้แจ้งเตือนได้เมื่อแอดมินต้องใช้รหัสสำรอง
     */
    public static function verifyLoginCode(int $userId, mixed $code): array
    {
        $user = self::userRow($userId);
        $totp = self::checkTotp($user, self::cleanTotp($code));
        if ($totp['ok']) {
            return ['method' => 'totp'];
        }
        if (! $totp['reused'] && self::useBackupCode($user, $code)) {
            Audit::write((int) $user['id'], 'auth.backup_code_used', 'user', (int) $user['id']);

            return ['method' => 'backup', 'remaining' => self::backupCodesLeft((int) $user['id'])];
        }

        throw self::wrongCode($totp['reused']);
    }

    /**
     * ตรวจก่อนทำเรื่องอันตราย (แก้บัญชีรับเงิน) — รับเฉพาะรหัสจากแอป ไม่รับรหัสสำรอง
     * ต้องมีมือถือจริงอยู่ในมือเท่านั้น
     */
    public static function verifyAppCode(int $userId, mixed $code): void
    {
        $user = self::userRow($userId);
        if (! $user['totp_enabled_at']) {
            throw new ApiException(403, 'MFA_ENROLL_REQUIRED', 'ต้องเปิดใช้ Google Authenticator ก่อน (หน้าบัญชีของฉัน)');
        }
        $result = self::checkTotp($user, self::cleanTotp($code));
        if (! $result['ok']) {
            throw self::wrongCode($result['reused']);
        }
    }

    /* ── ตั้งค่า / ปิด ──────────────────────────────────────────── */

    public static function backupCodesLeft(int $userId): int
    {
        return Db::int('SELECT COUNT(*) FROM user_backup_codes WHERE user_id = ? AND used_at IS NULL', [$userId]);
    }

    public static function status(array $user): array
    {
        $required = self::requireAdmin2fa();

        return [
            'enabled'   => (bool) $user['totp_enabled_at'],
            'enabledAt' => $user['totp_enabled_at'] ?? null,
            'required'  => $user['role'] === 'SUPER_ADMIN' && $required,
            // ยังไม่ตั้ง 2FA ในโหมดทดสอบ = ยืนยันเรื่องอันตรายด้วยรหัสผ่านแทน (หน้าเว็บใช้เลือกช่องที่จะถาม)
            'confirmWith'     => $user['totp_enabled_at'] || $required ? 'code' : 'password',
            'testMode'        => ! $required,
            'backupCodesLeft' => $user['totp_enabled_at'] ? self::backupCodesLeft((int) $user['id']) : 0,
        ];
    }

    /** เริ่มตั้งค่า: สร้าง secret ใหม่ให้สแกน (ยังไม่มีผลจนกว่าจะยืนยันด้วยรหัสแรก) */
    public static function startSetup(int $userId): array
    {
        $user = self::userRow($userId);
        if ($user['totp_enabled_at']) {
            throw ApiException::conflict('เปิดใช้ 2FA อยู่แล้ว — ถ้าจะเปลี่ยนมือถือ ให้ปิดก่อนแล้วตั้งใหม่');
        }
        $secret = Totp::newSecret();
        Db::exec('UPDATE users SET totp_pending_secret = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [SecretBox::seal($secret), $userId]);
        $uri = Totp::uri(config(Paynest::class)->appName, $user['username'], $secret);

        return [
            // โชว์ให้พิมพ์เองได้ เผื่อสแกนไม่ได้ — จัดกลุ่มละ 4 ตัวให้อ่านง่าย
            'secret'    => implode(' ', str_split($secret, 4)),
            'qrDataUrl' => Totp::qrDataUrl($uri),
        ];
    }

    private static function issueBackupCodes(int $userId): array
    {
        Db::exec('DELETE FROM user_backup_codes WHERE user_id = ?', [$userId]);
        // 10 ตัว (a–z 0–9 ตัดตัวที่สับสน) ≈ 50 บิต — เดาไม่ได้ และมี rate limit กันอยู่แล้ว
        $alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
        $codes    = [];
        for ($i = 0; $i < self::BACKUP_CODE_COUNT; $i++) {
            $raw = '';
            for ($j = 0; $j < 10; $j++) {
                $raw .= $alphabet[random_int(0, strlen($alphabet) - 1)];
            }
            Db::exec('INSERT INTO user_backup_codes (user_id, code_hash, created_at) VALUES (?, ?, UTC_TIMESTAMP())', [$userId, self::hashCode($raw)]);
            $codes[] = substr($raw, 0, 5) . '-' . substr($raw, 5);
        }

        return $codes;
    }

    /**
     * ยืนยันรหัสแรกจากแอป = เปิดใช้จริง
     * session เดิมทุกอันถูกเตะออก (ออกก่อนเปิด 2FA = ไม่เคยผ่านด่านที่สอง) — ฝั่ง controller ออก token ใหม่ให้เครื่องนี้
     */
    public static function enable(int $userId, mixed $code): array
    {
        $user = self::userRow($userId);
        if ($user['totp_enabled_at']) {
            throw ApiException::conflict('เปิดใช้ 2FA อยู่แล้ว');
        }
        if (! $user['totp_pending_secret']) {
            throw ApiException::badRequest('ยังไม่ได้เริ่มตั้งค่า — กดเริ่มใหม่อีกครั้ง');
        }
        $secret = SecretBox::open($user['totp_pending_secret']);
        $delta  = Totp::validate($secret, self::cleanTotp($code), 1);
        if ($delta === null) {
            throw self::wrongCode(false);
        }
        $step = Totp::counterAt() + $delta;

        return Db::tx(static function () use ($userId, $secret, $step) {
            Db::exec(
                'UPDATE users SET totp_secret = ?, totp_pending_secret = NULL, totp_enabled_at = UTC_TIMESTAMP(),
                                  totp_last_step = ?, updated_at = UTC_TIMESTAMP()
                  WHERE id = ?',
                [SecretBox::seal($secret), $step, $userId],
            );
            self::bumpTokenVersion($userId);
            $backupCodes = self::issueBackupCodes($userId);
            Audit::write($userId, 'auth.2fa_enable', 'user', $userId);

            return ['backupCodes' => $backupCodes];
        });
    }

    private static function clear(int $userId): void
    {
        Db::exec(
            'UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL,
                              totp_last_step = 0, updated_at = UTC_TIMESTAMP()
              WHERE id = ?',
            [$userId],
        );
        Db::exec('DELETE FROM user_backup_codes WHERE user_id = ?', [$userId]);
        self::bumpTokenVersion($userId);
    }

    /** ปิดเอง — ต้องใส่รหัสจากแอป · super admin ปิดไม่ได้ (บังคับใช้) */
    public static function disable(int $userId, mixed $code): void
    {
        $user = self::userRow($userId);
        if ($user['role'] === 'SUPER_ADMIN' && self::requireAdmin2fa()) {
            throw ApiException::forbidden('บัญชีส่วนกลางต้องใช้ 2FA เสมอ ปิดไม่ได้');
        }
        self::verifyAppCode($userId, $code);
        Db::tx(static function () use ($userId) {
            self::clear($userId);
            Audit::write($userId, 'auth.2fa_disable', 'user', $userId);
        });
    }

    /** สร้างรหัสสำรองชุดใหม่ (ชุดเก่าใช้ไม่ได้ทันที) — ต้องใส่รหัสจากแอป */
    public static function regenerateBackupCodes(int $userId, mixed $code): array
    {
        self::verifyAppCode($userId, $code);

        return Db::tx(static function () use ($userId) {
            $backupCodes = self::issueBackupCodes($userId);
            Audit::write($userId, 'auth.2fa_backup_regenerate', 'user', $userId);

            return ['backupCodes' => $backupCodes];
        });
    }

    /**
     * ปลด 2FA ให้คนอื่น (มือถือหาย) — งานซัพพอร์ตของส่วนกลาง
     * ปลดของตัวเองไม่ได้: ถ้าทำได้ คนที่ได้ session ไปจะปลดแล้วผูกมือถือตัวเองแทน
     */
    public static function reset(int $targetUserId, int $actorUserId): array
    {
        if ($targetUserId === $actorUserId) {
            throw ApiException::forbidden('ปลด 2FA ของตัวเองไม่ได้ — ใช้รหัสสำรองล็อกอิน หรือให้ผู้ดูแลเซิร์ฟเวอร์ใช้คำสั่ง php spark 2fa:reset');
        }
        $target = self::userRow($targetUserId);
        if (! $target['totp_enabled_at']) {
            throw ApiException::badRequest('ผู้ใช้นี้ยังไม่ได้เปิด 2FA');
        }
        Db::tx(static function () use ($target, $actorUserId) {
            self::clear((int) $target['id']);
            Audit::write($actorUserId, 'auth.2fa_reset', 'user', (int) $target['id'], ['username' => $target['username']]);
        });

        return $target;
    }

    /** ใช้จากคำสั่งบนเซิร์ฟเวอร์เท่านั้น (คนที่เข้าเซิร์ฟเวอร์ได้คือคนที่ไว้ใจได้อยู่แล้ว) */
    public static function resetByUsername(string $username): array
    {
        $target = Db::one('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', [$username])
            ?? throw ApiException::notFound("ไม่พบผู้ใช้ {$username}");
        Db::tx(static function () use ($target, $username) {
            self::clear((int) $target['id']);
            Audit::write(null, 'auth.2fa_reset_cli', 'user', (int) $target['id'], ['username' => $username]);
        });

        return $target;
    }
}
