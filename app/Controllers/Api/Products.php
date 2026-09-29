<?php

namespace App\Controllers\Api;

use App\Libraries\ApiException;
use App\Libraries\ApiResponse;
use App\Libraries\AuthContext;
use App\Libraries\Db;
use App\Libraries\Period;
use App\Libraries\V;
use App\Libraries\Validation\ArraySchema;
use App\Services\AssignmentService;
use App\Services\ProductService;

/** สินค้า — /api/products (ส่วนกลาง + ร้านที่มีสิทธิ์ดูสินค้า) */
class Products extends BaseApiController
{
    /**
     * สร้างสินค้าได้ไม่จำกัดจำนวน — เฉพาะ super admin
     * ระบุ franchiseId มาด้วยเพื่อมอบหมายทันที หรือปล่อยว่างไว้ก่อนแล้วค่อยมอบหมายภายหลังก็ได้
     */
    public function create()
    {
        $body = V::parse(V::object([
            'sku'         => V::string()->min(1)->regex('/^[A-Za-z0-9._-]+$/', 'SKU ใช้ได้เฉพาะ A-Z 0-9 . _ -'),
            'name'        => V::string()->min(1),
            'description' => V::string()->optional(),
            // % ส่วนต่างของสินค้าชิ้นนี้ — บังคับ เป็นแหล่งเดียวที่ระบบใช้คิดเงิน
            'commissionPct' => V::pct(),
            // มอบหมายให้ร้านทันทีตั้งแต่ตอนสร้าง (ไม่ระบุ = สร้างไว้ก่อน ยังไม่มีเจ้าของ)
            'franchiseId' => V::id()->optional(),
            'startDate'   => V::string()->optional(),
            'endDate'     => V::string()->optional(),
            // สินค้ากลุ่ม (ชุด) — ขายและคิดบิลเป็นก้อนเดียว รายการย่อยเป็นแค่ข้อมูลว่าในชุดมีอะไร (กติกาอยู่ใน ProductService)
            'isGroup'        => V::boolean()->optional(),
            'itemProductIds' => self::itemIdsSchema(),
        ]), $this->body());
        $actor    = (int) $this->user()['id'];
        $assignTo = $body['franchiseId'] ?? null;

        $result = Db::tx(static function () use ($body, $actor, $assignTo) {
            $product = ProductService::create($body, $actor);
            if (! $assignTo) {
                return ['product' => $product, 'assignment' => null];
            }
            $assignment = AssignmentService::assign([
                'productId'   => $product['id'],
                'franchiseId' => $assignTo,
                'startDate'   => $body['startDate'] ?? Period::today(),
                'endDate'     => $body['endDate'] ?? null,
            ], $actor);

            return ['product' => ProductService::get($product['id']), 'assignment' => $assignment];
        });

        return $this->json($result, 201);
    }

    /**
     * ร้านค้าเห็นเฉพาะสินค้าที่ถูกมอบหมายให้ตัวเอง
     * ร้านไม่ได้ inGroups (สินค้านี้อยู่ในกลุ่มไหน) — กลุ่มนั้นอาจเป็นของร้านอื่น · รายการย่อยของกลุ่มตัวเองยังเห็นครบ
     */
    public function index()
    {
        $user = $this->user();

        return $this->json(['items' => ProductService::list(
            AuthContext::franchiseScope($user, $this->q('franchiseId')),
            $this->q('status'),
            $this->q('q'),
            $this->q('unassignedOnly') === 'true',
            $this->q('onDate'),
            $this->isGroupFilter(),
            AuthContext::isSuperAdmin($user),
        )]);
    }

    /** ?isGroup=1|0 (true|false ก็ได้) · ไม่ส่ง = ทั้งหมด */
    private function isGroupFilter(): ?bool
    {
        $raw = $this->q('isGroup');

        return match ($raw) {
            null, ''     => null,
            '1', 'true'  => true,
            '0', 'false' => false,
            default      => throw ApiException::badRequest('isGroup ต้องเป็น 1 (เฉพาะสินค้ากลุ่ม) หรือ 0 (เฉพาะสินค้าเดี่ยว)'),
        };
    }

    /** ติ๊กซ้ำนับครั้งเดียว · จำกัดจำนวนจริง (100) ตรวจใน service หลังตัดตัวซ้ำ — ตรงนี้แค่กันคำขอใหญ่ผิดปกติ */
    private static function itemIdsSchema(): ArraySchema
    {
        return V::array(V::id())->max(500, 'เลือกรายการย่อยมากเกินไป — สินค้ากลุ่มมีสินค้าย่อยได้สูงสุด 100 รายการ')->optional();
    }

    public function show(string $id)
    {
        $user    = $this->user();
        $product = ProductService::get(V::parseId($id), AuthContext::isSuperAdmin($user));
        if (! AuthContext::isSuperAdmin($user) && ($product['currentAssignment']['franchiseId'] ?? null) !== (int) $user['franchise_id']) {
            return ApiResponse::errorOf(403, 'FORBIDDEN', 'สินค้านี้ไม่ได้อยู่ในความดูแลของคุณ', $this->response);
        }

        return $this->json([...$product, 'assignments' => AssignmentService::list($product['id'])]);
    }

    public function update(string $id)
    {
        $body = V::parse(V::object([
            'name'        => V::string()->min(1)->optional(),
            'description' => V::string()->nullable()->optional(),
            // แก้ % ได้ แต่มีผลกับยอดที่บันทึกใหม่เท่านั้น ยอดเก่าเก็บ snapshot ไว้แล้ว
            'commissionPct' => V::pct()->optional(),
            // ARCHIVED = ปิดใช้งาน (ชั่วคราว) · ACTIVE = เปิดใช้งานอีกครั้ง · DELETED ตั้งทางนี้ไม่ได้ — ลบใช้ DELETE (มีด่านตรวจ)
            'status' => V::enum(['ACTIVE', 'ARCHIVED'])->optional(),
            // false = เลิกเป็นกลุ่ม (ล้างรายการย่อย) · itemProductIds ส่งมา = แทนที่รายการย่อยทั้งชุด
            'isGroup'        => V::boolean()->optional(),
            'itemProductIds' => self::itemIdsSchema(),
        ]), $this->body());

        return $this->json(ProductService::update(V::parseId($id), $body, (int) $this->user()['id']));
    }

    /**
     * ลบสินค้าถาวร (ส่วนกลางเท่านั้น — guard) · ระบบเลือกเองว่าลบจริงหรือลบแบบซ่อน แล้วตอบ mode กลับมา
     * หยุดขายชั่วคราวใช้ PATCH status ARCHIVED (ปิดใช้งาน) แทน — เปิดกลับได้ สัญญา/ดีลยังอยู่
     */
    public function delete(string $id)
    {
        return $this->json(ProductService::delete(V::parseId($id), $this->user()));
    }
}
