<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Clock;
use App\Libraries\Db;
use App\Libraries\Money;
use App\Libraries\Period;
use App\Libraries\SecretBox;
use Throwable;

final class FranchiseService
{
    /**
     * สร้างร้านค้า
     * username ตัวเดียวทำหน้าที่ทั้ง "ตัวระบุร้านค้า" และ "ชื่อผู้ใช้สำหรับเข้าระบบ"
     * (คอลัมน์ franchises.username เก็บค่าเดียวกับ users.username ของเจ้าของบัญชี)
     */
    public static function create(array $input, int $actorUserId): array
    {
        $username = trim($input['username']);
        $taken    = Db::one('SELECT status FROM franchises WHERE LOWER(username) = LOWER(?)', [$username]);
        if ($taken !== null) {
            // ร้านที่ลบแบบซ่อน ชื่อยังผูกกับบิล/ผู้ใช้เดิมอยู่ (users.username ก็ UNIQUE) — ลบจริงแล้วเท่านั้นที่ชื่อว่างคืน
            throw ApiException::conflict($taken['status'] === 'DELETED'
                ? "ชื่อ {$username} เคยใช้กับร้านที่ลบไปแล้ว (บิลเก่ายังอ้างถึง) — ใช้ชื่ออื่น"
                : "username \"{$username}\" ถูกใช้ไปแล้ว");
        }

        return Db::tx(static function () use ($input, $username, $actorUserId) {
            $franchiseId = Db::insert(
                'INSERT INTO franchises (username, contact_name, phone, email, address, note, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
                [$username, $input['contactName'] ?? null, $input['phone'] ?? null, $input['email'] ?? null, $input['address'] ?? null, $input['note'] ?? null],
            );

            // ยูสเซอร์เดียวที่ super admin สร้างให้ = เจ้าของบัญชีร้าน
            // ผู้ช่วยคนถัด ๆ ไป เจ้าของบัญชีเป็นคนเพิ่มเองจากหน้า "บัญชีของฉัน"
            $user = UserService::create([
                'username'    => $username,
                'password'    => $input['password'],
                'displayName' => $input['contactName'] ?? $username,
                'role'        => 'FRANCHISE',
                'franchiseId' => $franchiseId,
                'isOwner'     => true,
            ]);

            // ร้านใหม่ได้ลิงก์เข้าระบบของตัวเองทันที — ไม่มีลิงก์ = ผู้ใช้ของร้านล็อกอินไม่ได้เลย (ดู Auth::login)
            self::storeLoginKey($franchiseId, self::newLoginKey(), false);

            Audit::write($actorUserId, 'franchise.create', 'franchise', $franchiseId, ['username' => $username]);

            // loginLink: หน้าเว็บประกอบชุดข้อมูลเข้าระบบ (ลิงก์ + ชื่อผู้ใช้ + รหัส) ให้คัดลอกส่งร้านได้ในจังหวะเดียว
            return ['franchise' => self::get($franchiseId), 'user' => UserService::serialize($user), 'loginLink' => self::getLoginLink($franchiseId)];
        });
    }

    /**
     * ร้านที่ลบแล้ว (DELETED) = ไม่พบ สำหรับทุกคนทุกเส้นทาง — บิล/ยอดขาย/ค่าคอมเก่า join ชื่อร้านจากตารางเองอยู่แล้ว ไม่ผ่านตัวนี้
     */
    public static function get(?int $id): array
    {
        $row = $id ? Db::one("SELECT * FROM franchises WHERE id = ? AND status <> 'DELETED'", [$id]) : null;

        return self::serialize($row ?? throw ApiException::notFound('ไม่พบร้านค้า'));
    }

    /** รายการร้าน — ไม่มีร้านที่ลบแล้วเสมอ (หน้าร้านค้า และตัวเลือกร้านทุกหน้า: มอบหมาย ออกบิล ยอดขาย รายงาน) */
    public static function list(?string $status = null, ?string $q = null): array
    {
        $where  = ["f.status <> 'DELETED'"];
        $params = [Clock::todayUtc()];
        if ($status) {
            $where[]  = 'f.status = ?';
            $params[] = $status;
        }
        if ($q) {
            $where[]  = 'f.username LIKE ?';
            $params[] = "%{$q}%";
        }

        // นับเฉพาะสินค้าที่ยังใช้งาน — สินค้าที่ปิดใช้งานแล้วกรอกยอดไม่ได้ ไม่ควรนับเป็น "สินค้าที่ร้านขายอยู่"
        return array_map([self::class, 'serialize'], Db::all(
            'SELECT f.*,
                    (SELECT COUNT(*) FROM users u WHERE u.franchise_id = f.id) AS user_count,
                    (SELECT COUNT(*) FROM product_assignments a
                       JOIN products p ON p.id = a.product_id AND p.status = \'ACTIVE\'
                      WHERE a.franchise_id = f.id AND (a.end_date IS NULL OR a.end_date >= ?)) AS active_product_count
               FROM franchises f
              WHERE ' . implode(' AND ', $where) . '
              ORDER BY f.username',
            $params,
        ));
    }

    private const UPDATABLE = [
        'contactName' => 'contact_name',
        'phone'       => 'phone',
        'email'       => 'email',
        'address'     => 'address',
        'note'        => 'note',
        'status'      => 'status',
    ];

    public static function update(int $id, array $patch, int $actorUserId): array
    {
        self::assertNotDeleted($id);
        $sets   = [];
        $params = [];
        foreach (self::UPDATABLE as $key => $column) {
            if (array_key_exists($key, $patch)) {
                $sets[]   = "{$column} = ?";
                $params[] = $patch[$key];
            }
        }
        if ($sets === []) {
            return self::get($id);
        }
        $sets[]   = 'updated_at = UTC_TIMESTAMP()';
        $params[] = $id;
        Db::exec('UPDATE franchises SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
        Audit::write($actorUserId, 'franchise.update', 'franchise', $id, $patch);

        return self::get($id);
    }

    /* ── ลิงก์เข้าระบบของร้าน (/#/s/<key>) ─────────────────────────────
     * ผู้ใช้ของร้าน (เจ้าของ + ผู้ช่วย) ต้องล็อกอินผ่านลิงก์ของร้านตัวเองเท่านั้น — key ในลิงก์คือ "ของที่ต้องมี"
     * รหัสผ่านที่หลุดหรือถูกเดาได้อย่างเดียวจึงเข้าระบบไม่ได้ และร้านอื่นเอาลิงก์ของตัวเองมาใช้ก็ไม่ได้
     * ฐานข้อมูลเก็บ sha256 ไว้ตรวจ + ตัวจริงเข้ารหัสด้วย SecretBox ไว้เปิดดูซ้ำ (ส่วนกลาง/เจ้าของร้านคัดลอกส่งต่อได้)
     */

    /** 24 ไบต์สุ่ม → 32 ตัวอักษร base64 แบบใส่ URL ได้ (ไม่มี + / =) */
    private static function newLoginKey(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
    }

    /**
     * $onlyIfMissing = true: เขียนเฉพาะร้านที่ยังไม่มี key — สองคำขอเปิดดูลิงก์พร้อมกัน คนมาทีหลังต้องไม่เขียนทับ
     * (ไม่งั้นคนแรกได้ลิงก์ที่ใช้ไม่ได้ไปส่งร้าน)
     */
    private static function storeLoginKey(int $franchiseId, string $key, bool $onlyIfMissing): bool
    {
        return Db::exec(
            'UPDATE franchises SET login_key_hash = ?, login_key_enc = ?, login_key_rotated_at = UTC_TIMESTAMP()
              WHERE id = ?' . ($onlyIfMissing ? ' AND login_key_hash IS NULL' : ''),
            [hash('sha256', $key), SecretBox::seal($key), $franchiseId],
        ) > 0;
    }

    /**
     * key ที่ส่งมาตอนล็อกอินตรงกับร้านนี้ไหม — ร้านที่ยังไม่มี key หรือไม่ได้ส่งมา = ไม่ผ่าน
     * hash_equals: เวลาเทียบไม่ขึ้นกับว่าตรงกันกี่ตัว (เดาทีละตัวอักษรจากเวลาตอบไม่ได้)
     */
    public static function loginKeyMatches(?int $franchiseId, ?string $key): bool
    {
        if (! $franchiseId || $key === null || $key === '') {
            return false;
        }
        // ร้านที่ลบแล้วถูกล้าง hash ไปแล้ว — กรองซ้ำไว้กันกรณีมีคนเติม key กลับมาเอง (ensureLoginKeys / แก้ฐานข้อมูลตรง)
        $hash = Db::val("SELECT login_key_hash FROM franchises WHERE id = ? AND status <> 'DELETED'", [$franchiseId]);

        return is_string($hash) && hash_equals($hash, hash('sha256', $key));
    }

    /**
     * สร้าง key ให้ร้านที่ยังไม่มี (ร้านที่เปิดก่อนมีระบบลิงก์) — app:install เรียกทุกครั้ง รันซ้ำได้
     * @return int จำนวนร้านที่เพิ่งได้ key
     */
    public static function ensureLoginKeys(): int
    {
        $made = 0;
        // ร้านที่ลบแล้วไม่มีลิงก์โดยตั้งใจ (delete() ล้างทิ้ง) — ห้ามเติมคืนตอน app:install
        foreach (Db::all("SELECT id FROM franchises WHERE login_key_hash IS NULL AND status <> 'DELETED' ORDER BY id") as $row) {
            $made += self::storeLoginKey((int) $row['id'], self::newLoginKey(), true) ? 1 : 0;
        }

        return $made;
    }

    /**
     * ลิงก์เข้าระบบของร้าน {key, path, rotatedAt} — ยังไม่มีก็สร้างให้เลย (ร้านเก่าที่ app:install ยังไม่ได้เติม)
     * path เป็นแบบสัมพัทธ์ หน้าเว็บต่อ location.origin เอง (เซิร์ฟเวอร์ไม่รู้แน่ว่าผู้ใช้เข้าด้วยโดเมนไหน)
     * ผู้เรียกต้องตรวจสิทธิ์เอง: ส่วนกลาง หรือเจ้าของบัญชีร้านนั้นเท่านั้น
     */
    public static function getLoginLink(int $franchiseId): array
    {
        $select = "SELECT login_key_hash, login_key_enc, login_key_rotated_at FROM franchises WHERE id = ? AND status <> 'DELETED'";
        $row    = Db::one($select, [$franchiseId]) ?? throw ApiException::notFound('ไม่พบร้านค้า');
        if ($row['login_key_hash'] === null) {
            self::storeLoginKey($franchiseId, self::newLoginKey(), true);
            $row = Db::one($select, [$franchiseId]);
        }
        try {
            $key = SecretBox::open((string) $row['login_key_enc']);
        } catch (Throwable) {
            $key = null;
        }
        // เปิดไม่ออก/ไม่ตรงกับ hash = กุญแจเข้ารหัสของระบบถูกเปลี่ยนหรือข้อมูลถูกแก้ตรง ๆ — ห้ามส่งลิงก์ที่ใช้ไม่ได้ออกไป
        if ($key === null || ! hash_equals((string) $row['login_key_hash'], hash('sha256', $key))) {
            throw new ApiException(409, 'LOGIN_LINK_UNREADABLE', 'อ่านลิงก์เข้าระบบเดิมของร้านนี้ไม่ได้ (กุญแจเข้ารหัสของระบบถูกเปลี่ยน) — กด "สร้างลิงก์ใหม่" แล้วส่งลิงก์ใหม่ให้ร้าน');
        }

        return ['key' => $key, 'path' => '/#/s/' . $key, 'rotatedAt' => $row['login_key_rotated_at']];
    }

    /**
     * สร้างลิงก์ใหม่ — ลิงก์เดิมใช้ไม่ได้ทันที และทุกคนในร้านถูกออกจากระบบ (token_version + 1)
     * ใช้ตอนลิงก์หลุด (ส่งผิดคน/พนักงานลาออก) — คนที่เข้าอยู่ด้วยลิงก์เก่าต้องไม่ค้างอยู่ในระบบต่อ
     */
    public static function rotateLoginLink(int $franchiseId, array $actor): array
    {
        $franchise = Db::one("SELECT id, username FROM franchises WHERE id = ? AND status <> 'DELETED'", [$franchiseId]) ?? throw ApiException::notFound('ไม่พบร้านค้า');
        $signedOut = Db::tx(static function () use ($franchiseId, $franchise, $actor): int {
            self::storeLoginKey($franchiseId, self::newLoginKey(), false);
            $users = Db::exec('UPDATE users SET token_version = token_version + 1, updated_at = UTC_TIMESTAMP() WHERE franchise_id = ?', [$franchiseId]);
            Audit::write((int) $actor['id'], 'franchise.login_link_rotate', 'franchise', $franchiseId, [
                'username'  => $franchise['username'],
                'signedOut' => $users,
            ]);

            return $users;
        });

        // ถ้าไม่ได้เป็นคนกด = มีคนถือบัญชีส่วนกลางอยู่ และกำลังจะเอาลิงก์ใหม่ไปใช้ — กลุ่มต้องรู้ทันที (ปิดไม่ได้)
        $actorName = (($actor['display_name'] ?? '') ?: ($actor['username'] ?? '')) . ' (' . ($actor['username'] ?? '') . ')';
        NotificationService::notify('security.shop_login_link', implode("\n", [
            '🔑 <b>สร้างลิงก์เข้าระบบใหม่ให้ร้าน ' . TelegramService::escapeHtml($franchise['username']) . '</b>',
            'ลิงก์เดิมใช้ไม่ได้แล้ว และผู้ใช้ทุกคนของร้านถูกออกจากระบบ' . ($signedOut > 0 ? " ({$signedOut} คน)" : ''),
            'โดย: <b>' . TelegramService::escapeHtml($actorName) . '</b>',
            'เวลา: ' . BankAccountService::thaiTime(),
            '',
            'ถ้าไม่ได้เป็นคนทำ ให้เปลี่ยนรหัสผ่านและตรวจสอบทันที',
        ]));

        return self::getLoginLink($franchiseId);
    }

    /** PATCH ร้านที่ลบแล้ว = 409 (ไม่ใช่ 404) — หน้าเว็บที่ค้างรายการเก่าไว้จะได้บอกได้ว่าร้านนี้ถูกลบไปแล้ว ไม่ใช่ id ผิด */
    private static function assertNotDeleted(int $id): void
    {
        $row = Db::one('SELECT username, status FROM franchises WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบร้านค้า');
        if ($row['status'] === 'DELETED') {
            throw ApiException::conflict("ร้าน {$row['username']} ถูกลบแล้ว — แก้ไขไม่ได้ · โหลดหน้าใหม่");
        }
    }

    /* ── ลบร้าน (R20 · 30 ก.ย. 69) ───────────────────────────────────── */

    /**
     * ลบร้านถาวร (ส่วนกลาง + รหัส 6 หลัก — guard) · ต่างจากสถานะ ระงับ/ปิด ที่เปลี่ยนกลับได้
     *
     * ลองลบจริงก่อน (HARD) ติด FK ค่อยลบแบบซ่อน (SOFT) — ดู Db::hardOrSoft
     *   HARD: ร้านที่ไม่เคยมีบิล/ยอดขาย และผู้ใช้ของร้านไม่มีประวัติรายการ (ล็อกอินครั้งเดียวก็มีแล้ว — audit_logs อ้างถึงผู้ใช้)
     *         → ลบผู้ใช้ของร้าน (รหัสสำรอง 2FA / รหัสผูก Telegram / การอ่านประกาศ หายตาม CASCADE) สัญญามอบหมาย ยอดยกมา และตัวร้าน
     *         ชื่อร้านว่างใช้ใหม่ได้ · ไม่ลบ audit_logs เด็ดขาด — ถ้ามันอ้างผู้ใช้อยู่ FK จะบังคับให้เป็น SOFT เอง (ถูกต้อง: ประวัติต้องอยู่)
     *   SOFT: status DELETED หายจากทุกรายการ/ตัวเลือก · ผู้ใช้ทุกคนของร้าน DISABLED + token_version + 1 (หลุดทันที)
     *         + ล้าง telegram_chat_id (บอทไม่ส่งอะไรหาอีก) · ล้างกุญแจลิงก์เข้าระบบ (ลิงก์เดิมตาย ล็อกอินได้แค่ 401 แบบรหัสผิด)
     *         · สัญญามอบหมายที่ยังเปิดปิดวันนี้ (สินค้ามอบหมายให้ร้านอื่นได้ทันที) · ดีลเซลไม่แตะ (เป็นของสินค้า ไม่ใช่ของร้าน)
     *         · บิล การชำระ บิลค่าคอม รายงานรอบเก่า ยังโชว์ชื่อร้านตามเดิม
     *
     * ด่าน (409 บอกว่าต้องทำอะไรก่อน) ตรวจบนแถวร้านที่ล็อกแล้วในทั้งสองรอบ: สลิปรอตรวจ · บิลค้างชำระ · ยอดขายที่ยังไม่ออกบิล
     * · ยอดยกมาที่ทางเรายังติดค้างร้าน — ลบไปแล้วเงินพวกนี้จะไม่มีใครเห็นและตามต่อไม่ได้
     *
     * @return array{deleted: true, id: int, username: string, mode: 'HARD'|'SOFT', users: int}
     */
    public static function delete(int $id, array $actor): array
    {
        $actorId = (int) $actor['id'];
        $result  = Db::hardOrSoft(
            static function () use ($id, $actorId): array {
                $f = self::lockForDelete($id);
                Db::exec('DELETE FROM product_assignments WHERE franchise_id = ?', [$id]);
                Db::exec('DELETE FROM franchise_credits WHERE franchise_id = ?', [$id]);
                $users = Db::exec('DELETE FROM users WHERE franchise_id = ?', [$id]);
                Db::exec('DELETE FROM franchises WHERE id = ?', [$id]);
                Audit::write($actorId, 'franchise.delete', 'franchise', $id, ['username' => $f['username'], 'mode' => 'HARD', 'users' => $users]);

                return ['deleted' => true, 'id' => $id, 'username' => $f['username'], 'mode' => 'HARD', 'users' => $users];
            },
            static function () use ($id, $actorId): array {
                $f     = self::lockForDelete($id);
                $today = Period::today();
                // SET เรียงแบบนี้เพราะ MySQL ใช้ค่าที่เพิ่งแก้ในบรรทัดเดียวกัน — สัญญาที่ยังไม่ถึงวันเริ่มได้ทั้งสองวันเป็นวันนี้ (ผ่าน CHECK)
                $ended = Db::exec(
                    'UPDATE product_assignments SET start_date = LEAST(start_date, ?), end_date = ?, updated_at = UTC_TIMESTAMP()
                      WHERE franchise_id = ? AND (end_date IS NULL OR end_date > ?)',
                    [$today, $today, $id, $today],
                );
                // รหัสผูก Telegram ที่ยังไม่หมดอายุ — กันผู้ใช้ที่ถูกปิดกด Start ในแอปแล้วได้แชตกลับมา
                Db::exec('DELETE lc FROM telegram_link_codes lc JOIN users u ON u.id = lc.user_id WHERE u.franchise_id = ?', [$id]);
                $users = Db::exec(
                    "UPDATE users SET status = 'DISABLED', token_version = token_version + 1, telegram_chat_id = NULL, updated_at = UTC_TIMESTAMP()
                      WHERE franchise_id = ?",
                    [$id],
                );
                Db::exec(
                    "UPDATE franchises
                        SET status = 'DELETED', deleted_at = UTC_TIMESTAMP(), deleted_by_user_id = ?,
                            login_key_hash = NULL, login_key_enc = NULL, updated_at = UTC_TIMESTAMP()
                      WHERE id = ?",
                    [$actorId, $id],
                );
                Audit::write($actorId, 'franchise.delete', 'franchise', $id, [
                    'username'         => $f['username'],
                    'mode'             => 'SOFT',
                    'users'            => $users,
                    'endedAssignments' => $ended,
                ]);

                return ['deleted' => true, 'id' => $id, 'username' => $f['username'], 'mode' => 'SOFT', 'users' => $users];
            },
        );

        // ส่งหลัง commit เท่านั้น — ถ้าลบไม่สำเร็จต้องไม่มีข้อความ "ลบร้านแล้ว" หลุดไปกลุ่ม · ปิดไม่ได้ (ใครได้บัญชีแอดมินไปลบร้านทิ้ง กลุ่มต้องรู้)
        $actorName = (($actor['display_name'] ?? '') ?: ($actor['username'] ?? '')) . ' (' . ($actor['username'] ?? '') . ')';
        $hard      = $result['mode'] === 'HARD';
        NotificationService::notify('security.shop_deleted', implode("\n", [
            '🗑 <b>ลบร้าน ' . TelegramService::escapeHtml($result['username']) . '</b> ('
                . ($hard ? 'ลบทิ้งทั้งหมด — ร้านยังไม่เคยมีประวัติ' : 'ซ่อนถาวร — บิลและประวัติเก่ายังอยู่ครบ') . ')',
            $hard
                ? "ผู้ใช้ของร้านถูกลบ ({$result['users']} คน) · ชื่อร้านนี้ใช้สร้างร้านใหม่ได้"
                : "ผู้ใช้ทุกคนของร้านถูกปิดและออกจากระบบ ({$result['users']} คน) · ลิงก์เข้าระบบของร้านใช้ไม่ได้แล้ว",
            'โดย: <b>' . TelegramService::escapeHtml($actorName) . '</b>',
            'เวลา: ' . BankAccountService::thaiTime(),
            '',
            'ถ้าไม่ได้เป็นคนทำ ให้เปลี่ยนรหัสผ่านและตรวจสอบทันที',
        ]));

        return $result;
    }

    /**
     * ล็อกแถวร้านแล้วตรวจด่านของการลบ — คำสั่งแรกของทรานแซกชันเสมอ (อ่านอะไรก่อนล็อก = เห็นภาพเก่า ดู HANDOVER)
     * นับแบบล็อก (share) ให้เห็นบิล/สลิป/ยอดที่อีกจอเพิ่ง commit และกันไม่ให้เพิ่มเข้ามาจนกว่าจะลบเสร็จ
     */
    private static function lockForDelete(int $id): array
    {
        $f = Db::one('SELECT id, username, status FROM franchises WHERE id = ? FOR UPDATE', [$id]);
        if ($f === null || $f['status'] === 'DELETED') {
            throw ApiException::notFound('ไม่พบร้านค้า');
        }
        $u = $f['username'];

        // สลิปรอตรวจก่อนบิลค้าง — สลิปที่รออยู่ผูกกับบิลค้างเสมอ และตรวจสลิปแล้วบิลอาจปิดเอง (บอกขั้นที่ต้องทำก่อน)
        $slips = Db::int("SELECT COUNT(*) FROM payment_submissions WHERE franchise_id = ? AND status = 'PENDING' LOCK IN SHARE MODE", [$id]);
        if ($slips > 0) {
            throw ApiException::conflict("ร้าน {$u} มีสลิปรอตรวจ {$slips} รายการ — ตรวจสลิปก่อน");
        }
        $open = Db::one(
            "SELECT COUNT(*) AS n, COALESCE(SUM(net_total_satang - paid_satang), 0) AS owed FROM invoices
              WHERE franchise_id = ? AND status IN ('OPEN', 'PARTIAL') AND net_total_satang > paid_satang LOCK IN SHARE MODE",
            [$id],
        );
        if ((int) $open['n'] > 0) {
            throw ApiException::conflict("ร้าน {$u} มีบิลค้างชำระ {$open['n']} ใบ (" . Money::fmtSatang((int) $open['owed']) . ' บาท) — รับชำระหรือยกเลิกบิลก่อน');
        }
        $unbilled = Db::int("SELECT COUNT(*) FROM sales_entries WHERE franchise_id = ? AND status <> 'INVOICED' LOCK IN SHARE MODE", [$id]);
        if ($unbilled > 0) {
            throw ApiException::conflict("ร้าน {$u} มียอดขายที่ยังไม่ออกบิล {$unbilled} รายการ — ออกบิลหรือลบยอดก่อน");
        }
        $credit = Db::int("SELECT COALESCE(SUM(remaining_satang), 0) FROM franchise_credits WHERE franchise_id = ? AND status = 'OPEN' AND remaining_satang > 0 LOCK IN SHARE MODE", [$id]);
        if ($credit > 0) {
            throw ApiException::conflict('ทางเรายังมียอดยกมาค้างให้ร้านนี้ ' . Money::fmtSatang($credit) . ' บาท — ใช้หักบิลหรือยกเลิกยอดยกมาก่อน');
        }

        return $f;
    }

    public static function serialize(?array $row): ?array
    {
        if ($row === null) {
            return null;
        }

        $out = [
            'id'          => (int) $row['id'],
            'username'    => $row['username'],
            'contactName' => $row['contact_name'],
            'phone'       => $row['phone'],
            'email'       => $row['email'],
            'address'     => $row['address'],
            'note'        => $row['note'],
            'status'      => $row['status'],
        ];
        // นับผู้ใช้/สินค้ามีเฉพาะตอนดึงเป็นรายการ — ดึงร้านเดียวไม่ส่งคีย์นี้ (แบบเดิม)
        if (array_key_exists('user_count', $row)) {
            $out['userCount'] = (int) $row['user_count'];
        }
        if (array_key_exists('active_product_count', $row)) {
            $out['activeProductCount'] = (int) $row['active_product_count'];
        }
        $out['createdAt'] = $row['created_at'];

        return $out;
    }
}
