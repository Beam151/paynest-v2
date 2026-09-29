<?php

namespace App\Controllers\Api;

use App\Filters\ApiGuard;
use App\Libraries\V;
use App\Services\BankAccountService;

/**
 * บัญชีรับเงิน — /api/bank-accounts
 * ร้านค้าอ่านได้ (ต้องรู้ว่าโอนเข้าบัญชีไหน) แต่แก้ไม่ได้ · การสร้าง/แก้/ลบล็อกไว้ที่ super admin
 * เปลี่ยนปลายทางเงินต้องเพิ่งใส่รหัส 6 หลักจากแอป (x-elevation) — ต่อให้คนร้ายได้ทั้ง session และรหัสผ่าน
 * ถ้าไม่มีมือถือก็แก้บัญชีไม่ได้
 */
class BankAccounts extends BaseApiController
{
    /*
     * ช่องที่บังคับขึ้นกับสกุลของบัญชี — service ตรวจกับ "แถวที่จะได้" (ดู BankAccountService::assertValid)
     *   THB = บัญชีธนาคารไทย: ธนาคาร ชื่อบัญชี เลขที่บัญชี (สาขาไม่บังคับ)
     *   USD = กระเป๋าคริปโต: เครือข่าย (chain) + ที่อยู่กระเป๋า (ส่งมาในช่อง accountNumber) — ธนาคาร/ชื่อบัญชี/สาขาไม่ใช้
     * จึงบังคับตรงนี้ได้แค่ช่องที่ทั้งสองแบบต้องมี
     */
    private static function shape(): array
    {
        return [
            'bankName'      => V::string()->max(150, 'ชื่อธนาคารยาวได้ไม่เกิน 150 ตัวอักษร')->optional(),
            'accountName'   => V::string()->optional(),
            'accountNumber' => V::string()->min(1, 'ต้องระบุเลขที่บัญชี (บัญชี USD = ที่อยู่กระเป๋า)'),
            'chain'         => V::string()->max(32, 'เครือข่าย (chain) ยาวได้ไม่เกิน 32 ตัวอักษร')->nullable()->optional(),
            'branch'        => V::string()->nullable()->optional(),
            'note'          => V::string()->nullable()->optional(),
            'isDefault'     => V::boolean()->optional(),
            'currency'      => V::enum(['THB', 'USD'])->optional(),
            // รับเฉพาะไฟล์ที่อัปโหลดผ่านระบบ — null คือถอด QR ออก
            'qrUrl' => V::string()->nullable()->optional(),
        ];
    }

    public function index()
    {
        return $this->json(BankAccountService::list($this->q('status')));
    }

    /** แถบเตือนของแอดมิน — การเปลี่ยนแปลงที่ยังไม่ได้กดรับทราบ */
    public function unreadChanges()
    {
        return $this->json(BankAccountService::listUnreadChanges((int) $this->user()['id']));
    }

    public function ackChange(string $id)
    {
        return $this->json(BankAccountService::ackChange(V::parseId($id), (int) $this->user()['id']));
    }

    public function show(string $id)
    {
        return $this->json(BankAccountService::get(V::parseId($id)));
    }

    public function create()
    {
        return $this->json(BankAccountService::create(V::parse(V::object(self::shape()), $this->body()), (int) $this->user()['id']), 201);
    }

    /** แก้เฉพาะสาขา/หมายเหตุไม่ต้องยืนยัน — นอกนั้นเปลี่ยนปลายทางเงินได้ทั้งหมด ต้องยืนยันรหัส 6 หลัก */
    public function update(string $id)
    {
        $accountId = V::parseId($id);
        $patch     = V::parse(V::object(self::shape())->partial()->extend([
            'status' => V::enum(['ACTIVE', 'INACTIVE'])->optional(),
        ]), $this->body());
        if (BankAccountService::changes($accountId, $patch) !== []) {
            ApiGuard::assertElevated($this->request);
        }

        return $this->json(BankAccountService::update($accountId, $patch, (int) $this->user()['id']));
    }

    public function delete(string $id)
    {
        return $this->json(BankAccountService::delete(V::parseId($id), (int) $this->user()['id']));
    }

    /**
     * ส่งเลขบัญชีนี้ให้ร้านที่มีบิลค้างจ่ายทาง Telegram — เส้นทางบังคับรหัส 6 หลัก (elevated)
     * เพราะเป็นการบอกร้านว่า "โอนเข้าบัญชีนี้" ได้ทีละหลายร้าน
     */
    public function notifyShops(string $id)
    {
        return $this->json(BankAccountService::notifyShops(V::parseId($id), $this->user()));
    }
}
