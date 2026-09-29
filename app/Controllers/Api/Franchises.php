<?php

namespace App\Controllers\Api;

use App\Libraries\ApiException;
use App\Libraries\AuthContext;
use App\Libraries\Permissions;
use App\Libraries\V;
use App\Services\Audit;
use App\Services\CreditService;
use App\Services\FranchiseService;
use App\Services\UserService;

/**
 * ร้าน · ผู้ใช้ในร้าน · ยอดยกมา — /api/franchises (ส่วนกลาง + ร้าน · เซลดูผ่าน /api/sales-agents/links แทน)
 *
 * super admin สร้างให้แค่ยูสเซอร์เดียวตอนเปิดสาขา (= เจ้าของบัญชี)
 * ผู้ช่วยคนถัด ๆ ไป เจ้าของบัญชีสาขาเป็นคนเพิ่ม/ปิดเอง
 * super admin ยังตั้งรหัสผ่านใหม่และระงับบัญชีได้ (งานซัพพอร์ต)
 */
class Franchises extends BaseApiController
{
    private static function usernameField(?string $minMessage = null)
    {
        return V::string()->min(3, $minMessage)->regex('/^[a-zA-Z0-9._-]+$/', 'ใช้ได้เฉพาะ a-z 0-9 . _ -');
    }

    /** super admin สร้างร้านค้า + ยูสเซอร์สำหรับเข้าระบบในขั้นตอนเดียว */
    public function create()
    {
        $body = V::parse(V::object([
            // username เดียวใช้ทั้งเป็นตัวระบุร้านค้าและชื่อผู้ใช้สำหรับเข้าระบบ
            'username'    => self::usernameField('ชื่อผู้ใช้อย่างน้อย 3 ตัวอักษร'),
            'password'    => V::string()->min(8, 'รหัสผ่านอย่างน้อย 8 ตัวอักษร'),
            'contactName' => V::string()->optional(),
            'phone'       => V::string()->optional(),
            'email'       => V::email('อีเมลไม่ถูกต้อง')->optional(),
            'address'     => V::string()->optional(),
            'note'        => V::string()->optional(),
        ]), $this->body());

        return $this->json(FranchiseService::create($body, (int) $this->user()['id']), 201);
    }

    public function index()
    {
        $user = $this->user();
        if (! AuthContext::isSuperAdmin($user)) {
            return $this->json(['items' => [FranchiseService::get((int) $user['franchise_id'])]]);
        }

        return $this->json(['items' => FranchiseService::list($this->q('status'), $this->q('q'))]);
    }

    public function show(string $id)
    {
        return $this->json(FranchiseService::get(AuthContext::franchiseScope($this->user(), $id)));
    }

    /**
     * ยอดที่ส่วนกลางติดค้างร้าน รอหักบิลรอบหน้า
     * ร้านดูของตัวเองได้ (ต้องตรวจได้ว่ายอดมาจากบิลใบไหน) แต่ดูของร้านอื่นไม่ได้
     */
    public function credits(string $id)
    {
        $franchiseId = (int) AuthContext::franchiseScope($this->user(), $id);
        FranchiseService::get($franchiseId); // ร้านที่ลบแล้ว = 404 เหมือนดูตัวร้าน

        return $this->json(CreditService::list($franchiseId));
    }

    public function update(string $id)
    {
        $body = V::parse(V::object([
            'contactName' => V::string()->nullable()->optional(),
            'phone'       => V::string()->nullable()->optional(),
            'email'       => V::string()->nullable()->optional(),
            'address'     => V::string()->nullable()->optional(),
            'note'        => V::string()->nullable()->optional(),
            'status'      => V::enum(['ACTIVE', 'SUSPENDED', 'CLOSED'])->optional(),
        ]), $this->body());

        return $this->json(FranchiseService::update(V::parseId($id), $body, (int) $this->user()['id']));
    }

    /**
     * ลบร้านถาวร — ส่วนกลาง + รหัส 6 หลัก (guard) · ระบบเลือกเองว่าลบจริงหรือลบแบบซ่อน แล้วตอบ mode กลับมา
     * พักร้านชั่วคราวใช้ PATCH status SUSPENDED / CLOSED แทน (เปลี่ยนกลับได้)
     */
    public function delete(string $id)
    {
        return $this->json(FranchiseService::delete(V::parseId($id), $this->user()));
    }

    /* ── ลิงก์เข้าระบบของร้าน ─────────────────────────────────────── */

    /**
     * ดูลิงก์เข้าระบบของร้าน — ส่วนกลาง และเจ้าของบัญชีร้านนั้น (ไว้ส่งให้ผู้ช่วยของตัวเอง)
     * ผู้ช่วยดูไม่ได้: ลิงก์คือกุญแจชั้นที่สองของทั้งร้าน คนที่ไม่ได้จัดการผู้ใช้ไม่ควรถือไว้ส่งต่อ
     * ไม่เขียนประวัติ — แค่เปิดดู ไม่มีอะไรเปลี่ยน
     */
    public function loginLink(string $id)
    {
        $user = $this->user();
        // ร้านอื่น → 403 จาก franchiseScope ก่อนตรวจอย่างอื่น (ไม่ให้แยกได้ว่าร้าน id ไหนมีจริง)
        $franchiseId = AuthContext::isSuperAdmin($user) ? V::parseId($id) : (int) AuthContext::franchiseScope($user, $id);
        if (! AuthContext::isSuperAdmin($user) && ! AuthContext::isFranchiseOwner($user, $franchiseId)) {
            throw ApiException::forbidden('เฉพาะเจ้าของบัญชีร้านเท่านั้นที่ดูลิงก์เข้าระบบของร้านได้ — ขอลิงก์จากเจ้าของบัญชีร้าน');
        }
        try {
            return $this->json(FranchiseService::getLoginLink($franchiseId));
        } catch (ApiException $e) {
            // เจ้าของร้านกด "สร้างลิงก์ใหม่" เองไม่ได้ — บอกให้ติดต่อทางเราแทนข้อความสำหรับส่วนกลาง
            if ($e->errorCode === 'LOGIN_LINK_UNREADABLE' && ! AuthContext::isSuperAdmin($user)) {
                throw new ApiException(409, $e->errorCode, 'ตอนนี้เปิดลิงก์เข้าระบบของร้านไม่ได้ — ติดต่อทางเราเพื่อขอลิงก์ใหม่ครับ');
            }

            throw $e;
        }
    }

    /** สร้างลิงก์ใหม่ (ลิงก์เดิมใช้ไม่ได้ + ทุกคนในร้านหลุด) — ส่วนกลางเท่านั้น ต้องใส่รหัส 6 หลัก (guard) */
    public function rotateLoginLink(string $id)
    {
        return $this->json(FranchiseService::rotateLoginLink(V::parseId($id), $this->user()));
    }

    /* ── ยูสเซอร์ในสาขา ───────────────────────────────────────── */

    /**
     * ต้องเช็กสิทธิ์ก่อนหาผู้ใช้เสมอ: ถ้าหาก่อนแล้วค่อยเช็ค
     * ร้านอื่นจะแยกได้จาก 404 กับ 403 ว่า user id ไหนอยู่ร้านไหน
     */
    private function assertManages(array $user, int $franchiseId): void
    {
        if (! AuthContext::isSuperAdmin($user) && ! AuthContext::isFranchiseOwner($user, $franchiseId)) {
            throw ApiException::forbidden('ไม่มีสิทธิ์จัดการผู้ใช้ของสาขานี้');
        }
    }

    private function franchiseUser(int $franchiseId, int $userId): array
    {
        // ร้านที่ลบแล้ว: ผู้ใช้ถูกปิดไว้ถาวร — ห้ามตั้งรหัส/เปิดใช้งาน/แก้สิทธิ์กลับ (ไม่งั้นเปิดทางกลับเข้าร้านที่ไม่มีอยู่แล้ว)
        FranchiseService::get($franchiseId);
        foreach (UserService::list($franchiseId) as $u) {
            if ((int) $u['id'] === $userId) {
                return $u;
            }
        }

        throw ApiException::notFound('ไม่พบผู้ใช้ในสาขานี้');
    }

    public function users(string $id)
    {
        $user        = $this->user();
        $franchiseId = AuthContext::franchiseScope($user, $id);
        FranchiseService::get($franchiseId);

        return $this->json([
            'items'     => array_map([UserService::class, 'serialize'], UserService::list($franchiseId)),
            'canManage' => AuthContext::isFranchiseOwner($user, $franchiseId),
        ]);
    }

    /** เพิ่มผู้ช่วย — เฉพาะเจ้าของบัญชีสาขาเท่านั้น */
    public function addUser(string $id)
    {
        $franchiseId = V::parseId($id);
        if (! AuthContext::isFranchiseOwner($this->user(), $franchiseId)) {
            throw ApiException::forbidden('เฉพาะเจ้าของบัญชีสาขาเท่านั้นที่เพิ่มผู้ช่วยได้');
        }
        FranchiseService::get($franchiseId);
        $body = V::parse(V::object([
            'username'    => self::usernameField(),
            'password'    => V::string()->min(8, 'รหัสผ่านอย่างน้อย 8 ตัวอักษร'),
            'displayName' => V::string()->optional(),
            'permissions' => V::array(V::enum(Permissions::KEYS))->optional(),
        ]), $this->body());
        $user = UserService::create([
            ...$body,
            'role'        => 'FRANCHISE',
            'franchiseId' => $franchiseId,
            'isOwner'     => false,
            // ผู้ช่วยมีชุดสิทธิ์เสมอ ไม่ปล่อยเป็น null (null = ทำได้ทุกอย่าง)
            'permissions' => $body['permissions'] ?? Permissions::DEFAULT_STAFF,
        ]);

        return $this->json(UserService::serialize($user), 201);
    }

    /** แก้สิทธิ์ผู้ช่วย — เจ้าของร้านเท่านั้น และแก้ของเจ้าของร้านด้วยกันไม่ได้ */
    public function userPermissions(string $id, string $userId)
    {
        $franchiseId = V::parseId($id);
        $targetId    = V::parseId($userId);
        $user        = $this->user();
        $this->assertManages($user, $franchiseId);
        $target = $this->franchiseUser($franchiseId, $targetId);
        if (! AuthContext::isFranchiseOwner($user, $franchiseId)) {
            throw ApiException::forbidden('เฉพาะเจ้าของบัญชีร้านเท่านั้นที่ตั้งสิทธิ์ได้');
        }
        if ((int) $target['is_franchise_owner'] === 1) {
            throw ApiException::forbidden('เจ้าของบัญชีร้านมีสิทธิ์ทุกอย่างอยู่แล้ว ตั้งค่าแยกไม่ได้');
        }
        $body = V::parse(V::object(['permissions' => V::array(V::enum(Permissions::KEYS))]), $this->body());

        return $this->json(UserService::serialize(UserService::setPermissions($targetId, $body['permissions'])));
    }

    public function resetUserPassword(string $id, string $userId)
    {
        $franchiseId = V::parseId($id);
        $targetId    = V::parseId($userId);
        $user        = $this->user();
        $this->assertManages($user, $franchiseId);
        $target = $this->franchiseUser($franchiseId, $targetId);
        // เจ้าของสาขาตั้งรหัสใหม่ให้ผู้ช่วยได้ / super admin ช่วยได้ทุกคนในฐานะซัพพอร์ต
        $allowed = AuthContext::isSuperAdmin($user) || (AuthContext::isFranchiseOwner($user, $franchiseId) && ! (int) $target['is_franchise_owner']);
        if (! $allowed) {
            throw ApiException::forbidden('ไม่มีสิทธิ์ตั้งรหัสผ่านให้ผู้ใช้รายนี้');
        }
        $body = V::parse(V::object([
            'newPassword' => V::string()->min(8, 'รหัสผ่านอย่างน้อย 8 ตัวอักษร'),
            // true = รหัสนี้ถูกคัดลอกส่งทางแชต — ให้เจ้าของบัญชีตั้งรหัสของตัวเองตอนเข้าครั้งแรก
            'mustChange'  => V::boolean()->optional(),
        ]), $this->body());
        $mustChange = ($body['mustChange'] ?? false) === true;
        UserService::setPassword($targetId, $body['newPassword'], $mustChange);
        Audit::write((int) $user['id'], 'user.reset_password', 'user', $targetId, [
            'username'    => $target['username'],
            'franchiseId' => $franchiseId,
            'mustChange'  => $mustChange,
        ]);

        return $this->json(['ok' => true, 'user' => UserService::serialize(UserService::getById($targetId))]);
    }

    public function userStatus(string $id, string $userId)
    {
        $franchiseId = V::parseId($id);
        $targetId    = V::parseId($userId);
        $user        = $this->user();
        $this->assertManages($user, $franchiseId);
        $target = $this->franchiseUser($franchiseId, $targetId);
        if ($targetId === (int) $user['id']) {
            throw ApiException::forbidden('ปิดใช้งานบัญชีตัวเองไม่ได้');
        }
        // เจ้าของสาขาปิดได้เฉพาะผู้ช่วย ไม่ใช่เจ้าของด้วยกัน
        $allowed = AuthContext::isSuperAdmin($user) || (AuthContext::isFranchiseOwner($user, $franchiseId) && ! (int) $target['is_franchise_owner']);
        if (! $allowed) {
            throw ApiException::forbidden('ไม่มีสิทธิ์เปลี่ยนสถานะผู้ใช้รายนี้');
        }
        $body = V::parse(V::object(['status' => V::enum(['ACTIVE', 'DISABLED'])]), $this->body());

        return $this->json(UserService::serialize(UserService::setStatus($targetId, $body['status'])));
    }
}
