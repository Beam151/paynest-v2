<?php

namespace Config;

use CodeIgniter\Config\BaseConfig;

/**
 * ค่าของระบบ — ทุกค่ามีค่าตั้งต้นที่ปลอดภัย ใช้งานได้ทันทีโดยไม่ต้องแก้อะไร
 * อยากเปลี่ยนให้ใส่ใน .env เช่น  paynest.trustProxy = 1  (ดู env ที่รากโปรเจกต์)
 *
 * ค่าที่แอดมินต้องปรับเองระหว่างใช้งาน (Telegram, เรื่องที่แจ้งเตือน, บัญชีรับเงิน) อยู่ในหน้าเว็บ ไม่ใช่ที่นี่
 */
class Paynest extends BaseConfig
{
    /**
     * รุ่นของระบบ — เลื่อนทุกครั้งที่ปล่อยงานขึ้นเครื่องจริง (แก้บั๊ก = เลขท้าย · ฟีเจอร์ใหม่ = เลขกลาง)
     * เป็นค่าคงที่ ตั้งผ่าน .env ไม่ได้โดยตั้งใจ: เลขรุ่นต้องมากับโค้ด ไม่ใช่กับเครื่อง
     * ลืมเลื่อนก็ยังจดเวลาอัปเดตได้ เพราะเทียบ commit ของ git ด้วย (ดู VersionService)
     */
    public const VERSION = '2.5.0';

    /** ชื่อที่ขึ้นในแอป Google Authenticator ให้รู้ว่ารหัสนี้ของระบบไหน */
    public string $appName = 'ระบบจัดการร้าน';

    /** ล็อกอินหมดอายุ — ใช้รูปแบบ 24h / 30m / 3600 (วินาที) · เจ้าของระบบตัดสินใจให้ล็อกอินใหม่วันละครั้ง */
    public string $jwtExpiresIn = '24h';

    /**
     * จำนวน reverse proxy / CDN ที่อยู่หน้าเว็บเซิร์ฟเวอร์ (Cloudflare หรือ load balancer = 1, ไม่มี = 0)
     * nginx/Apache ที่รัน PHP เอง (PHP-FPM) ไม่นับ — IP ที่ PHP เห็นเป็นของผู้ใช้จริงอยู่แล้ว
     * ต้องตั้งให้ตรง ไม่งั้น rate limit จะเห็นทุกคนเป็น IP เดียวกัน (IP ของ proxy)
     */
    public int $trustProxy = 0;

    /** จำนวนวันหลังจบรอบบิลที่ถือเป็นวันครบกำหนดชำระ */
    public int $invoiceDueDays = 7;

    /**
     * ที่เก็บไฟล์ของระบบ: secrets.json, รหัสแอดมินเริ่มต้น, uploads/ (สลิป/QR), backups/
     * ว่าง = writable/data
     */
    public string $dataDir = '';

    /** ที่เก็บไฟล์สำรอง (ว่าง = <dataDir>/backups) และเก็บย้อนหลังกี่วัน */
    public string $backupDir = '';
    public int $backupKeepDays = 30;

    /**
     * กุญแจลับ — ไม่ต้องตั้ง: ระบบสุ่มให้แล้วเก็บใน <dataDir>/secrets.json
     * ตั้งเองได้ถ้าเก็บ secret แยก (ค่าใน env ชนะไฟล์เสมอ · ต้องยาว ≥ 32 ตัว)
     */
    public string $jwtSecret     = '';
    public string $encryptionKey = '';

    /** แอดมินคนแรก — ไม่ตั้งรหัส = ระบบสุ่มรหัสใส่ไฟล์ <dataDir>/initial-admin-password.txt */
    public string $seedSuperAdminUser = 'superadmin';
    public string $seedSuperAdminPass = '';

    /** ปลายทาง Telegram — มีไว้ให้เทสต์ชี้ไป Telegram จำลอง (ของจริงตั้งบอทในหน้าตั้งค่า) */
    public string $telegramApiBase = 'https://api.telegram.org';

    /** ที่ตรวจ token ของ Cloudflare Turnstile — มีไว้ให้เทสต์ชี้ไปตัวจำลอง (คีย์ของจริงตั้งในหน้าตั้งค่า) */
    public string $turnstileVerifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

    /**
     * บังคับ Google Authenticator กับบัญชีส่วนกลางบนเซิร์ฟเวอร์จริง — ปิด (false) = ล็อกอินด้วยรหัสผ่านอย่างเดียวได้
     * ตั้งได้จากไฟล์บนเซิร์ฟเวอร์เท่านั้น ไม่มีปุ่มในหน้าเว็บ · บัญชีที่เปิด 2FA ไว้แล้วยังต้องใส่รหัสจนกว่าจะปิดเอง
     */
    public bool $enforceAdmin2fa = true;

    /**
     * ตัวแปรสภาพแวดล้อมจริง (PAYNEST_*) ชนะค่าใน .env เสมอ — ใช้กับ Docker / ระบบเก็บ secret แยก / ชุดเทสต์
     * ชื่อตรงกับระบบเดิม (JWT_SECRET → PAYNEST_JWT_SECRET ฯลฯ) ให้คนดูแลเซิร์ฟเวอร์เทียบกันได้ง่าย
     */
    private const ENV_OVERRIDES = [
        'PAYNEST_APP_NAME'             => 'appName',
        'PAYNEST_TRUST_PROXY'          => 'trustProxy',
        'PAYNEST_INVOICE_DUE_DAYS'     => 'invoiceDueDays',
        'PAYNEST_DATA_DIR'             => 'dataDir',
        'PAYNEST_BACKUP_DIR'           => 'backupDir',
        'PAYNEST_BACKUP_KEEP_DAYS'     => 'backupKeepDays',
        'PAYNEST_JWT_SECRET'           => 'jwtSecret',
        'PAYNEST_ENCRYPTION_KEY'       => 'encryptionKey',
        'PAYNEST_JWT_EXPIRES_IN'       => 'jwtExpiresIn',
        'PAYNEST_SEED_ADMIN_USER'      => 'seedSuperAdminUser',
        'PAYNEST_SEED_ADMIN_PASS'      => 'seedSuperAdminPass',
        'PAYNEST_TELEGRAM_API_BASE'    => 'telegramApiBase',
        'PAYNEST_TURNSTILE_VERIFY_URL' => 'turnstileVerifyUrl',
        'PAYNEST_ENFORCE_ADMIN_2FA'    => 'enforceAdmin2fa',
    ];

    public function __construct()
    {
        parent::__construct();
        foreach (self::ENV_OVERRIDES as $env => $property) {
            $value = getenv($env);
            if ($value !== false) {
                $this->{$property} = match (true) {
                    is_int($this->{$property}) => (int) $value,
                    // "false" / "0" / "off" / "no" = ปิด — ค่าอื่นที่อ่านไม่ออกถือว่าเปิด (พิมพ์ผิดแล้วไม่หลุดเป็นปิด)
                    is_bool($this->{$property}) => filter_var($value, FILTER_VALIDATE_BOOL, FILTER_NULL_ON_FAILURE) ?? true,
                    default                     => $value,
                };
            }
        }
    }

    /**
     * บังคับ Google Authenticator กับบัญชีส่วนกลาง — เฉพาะเซิร์ฟเวอร์จริง (CI_ENVIRONMENT = production) และไม่ได้ปิดด้วย enforceAdmin2fa
     * ไม่มีปุ่มปิดในหน้าเว็บโดยตั้งใจ: ถ้าปิดได้จากหน้าเว็บ คนที่ได้รหัสผ่านไปก็ปิดเองได้
     */
    public function requireAdmin2fa(): bool
    {
        return ENVIRONMENT === 'production' && $this->enforceAdmin2fa;
    }

    public function dataPath(string $relative = ''): string
    {
        $base = $this->dataDir !== '' ? $this->resolve($this->dataDir) : WRITEPATH . 'data';
        $base = rtrim($base, '/\\');

        return $relative === '' ? $base : $base . DIRECTORY_SEPARATOR . $relative;
    }

    public function uploadPath(string $name = ''): string
    {
        return $this->dataPath('uploads' . ($name === '' ? '' : DIRECTORY_SEPARATOR . $name));
    }

    public function backupPath(string $relative = ''): string
    {
        $base = $this->backupDir !== '' ? rtrim($this->resolve($this->backupDir), '/\\') : $this->dataPath('backups');

        return $relative === '' ? $base : $base . DIRECTORY_SEPARATOR . $relative;
    }

    /** อายุ token เข้าระบบเป็นวินาที */
    public function jwtTtl(): int
    {
        return self::parseDuration($this->jwtExpiresIn, 86400);
    }

    /** '24h' / '30m' / '7d' / '3600' → วินาที (แบบเดียวกับไลบรารี ms ที่ตัวเดิมใช้) */
    public static function parseDuration(string $text, int $fallback): int
    {
        $text = strtolower(trim($text));
        if (preg_match('/^\d+$/', $text)) {
            return (int) $text;
        }
        if (! preg_match('/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hrs?|hours?|d|days?|w|weeks?|y|yrs?|years?)$/', $text, $m)) {
            return $fallback;
        }
        $unit = match ($m[2][0]) {
            's'     => 1,
            'm'     => 60,
            'h'     => 3600,
            'd'     => 86400,
            'w'     => 604800,
            default => 31557600,
        };

        return (int) round((float) $m[1] * $unit);
    }

    private function resolve(string $path): string
    {
        // path แบบสัมพัทธ์นับจากรากโปรเจกต์ (โฟลเดอร์ที่มี spark)
        return preg_match('#^([a-zA-Z]:[\\\\/]|[\\\\/])#', $path) ? $path : ROOTPATH . $path;
    }
}
