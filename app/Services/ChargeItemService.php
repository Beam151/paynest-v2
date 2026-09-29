<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Db;
use App\Libraries\Money;

/** รายการค่าใช้จ่าย/ส่วนลดตั้งต้น ที่ super admin เลือกใส่บิลได้เร็ว ๆ */
final class ChargeItemService
{
    /** ตั้งได้อย่างใดอย่างหนึ่ง: จำนวนเงินคงที่ หรือ % ของส่วนต่าง — ตั้งทั้งคู่จะตีความไม่ได้ว่าจะใช้อันไหน */
    private static function assertSingleBasis(mixed $defaultAmount, mixed $defaultPct): void
    {
        if ($defaultAmount !== null && $defaultPct !== null) {
            throw ApiException::badRequest('เลือกได้อย่างเดียว: จำนวนเงิน หรือ % ของส่วนต่าง');
        }
    }

    /** ชื่อรายการห้ามซ้ำ เพราะตอนออกบิลเลือกจากชื่อนี้ */
    private static function assertNameFree(string $name, ?int $excludeId = null): void
    {
        if (Db::one('SELECT id FROM charge_items WHERE LOWER(name) = LOWER(?) AND (? IS NULL OR id <> ?)', [$name, $excludeId, $excludeId])) {
            throw ApiException::conflict("ชื่อรายการ \"{$name}\" ถูกใช้ไปแล้ว");
        }
    }

    public static function create(array $input, int $actorUserId): array
    {
        self::assertNameFree($input['name']);
        self::assertSingleBasis($input['defaultAmount'] ?? null, $input['defaultPct'] ?? null);
        $id = Db::insert(
            'INSERT INTO charge_items (name, kind, default_amount_satang, default_pct_bp, description, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
            [
                $input['name'],
                $input['kind'],
                ($input['defaultAmount'] ?? null) === null ? null : Money::toSatang($input['defaultAmount'], 'defaultAmount'),
                ($input['defaultPct'] ?? null) === null ? null : Money::pctToBp($input['defaultPct'], 'defaultPct'),
                $input['description'] ?? null,
            ],
        );
        Audit::write($actorUserId, 'charge_item.create', 'charge_item', $id, ['name' => $input['name']]);

        return self::get($id);
    }

    public static function get(int $id): array
    {
        return self::serialize(Db::one('SELECT * FROM charge_items WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการค่าใช้จ่าย'));
    }

    public static function list(?string $kind = null, ?string $status = 'ACTIVE'): array
    {
        $where  = [];
        $params = [];
        if ($kind) {
            $where[]  = 'kind = ?';
            $params[] = $kind;
        }
        if ($status) {
            $where[]  = 'status = ?';
            $params[] = $status;
        }

        return array_map([self::class, 'serialize'], Db::all(
            'SELECT * FROM charge_items ' . ($where ? 'WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY kind DESC, name',
            $params,
        ));
    }

    private const FIELDS = ['name' => 'name', 'description' => 'description', 'status' => 'status'];

    public static function update(int $id, array $patch, int $actorUserId): array
    {
        $current = self::get($id);
        if (array_key_exists('name', $patch)) {
            self::assertNameFree($patch['name'], $id);
        }
        // รวมค่าเดิมกับค่าใหม่ก่อนตรวจ เผื่อ patch มาแค่ช่องเดียว
        self::assertSingleBasis(
            array_key_exists('defaultAmount', $patch) ? $patch['defaultAmount'] : $current['defaultAmount'],
            array_key_exists('defaultPct', $patch) ? $patch['defaultPct'] : $current['defaultPct'],
        );
        $sets   = [];
        $params = [];
        foreach (self::FIELDS as $key => $column) {
            if (array_key_exists($key, $patch)) {
                $sets[]   = "{$column} = ?";
                $params[] = $patch[$key];
            }
        }
        if (array_key_exists('defaultAmount', $patch)) {
            $sets[]   = 'default_amount_satang = ?';
            $params[] = $patch['defaultAmount'] === null ? null : Money::toSatang($patch['defaultAmount'], 'defaultAmount');
        }
        if (array_key_exists('defaultPct', $patch)) {
            $sets[]   = 'default_pct_bp = ?';
            $params[] = $patch['defaultPct'] === null ? null : Money::pctToBp($patch['defaultPct'], 'defaultPct');
        }
        if ($sets === []) {
            return self::get($id);
        }
        $sets[]   = 'updated_at = UTC_TIMESTAMP()';
        $params[] = $id;
        Db::exec('UPDATE charge_items SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
        Audit::write($actorUserId, 'charge_item.update', 'charge_item', $id, $patch);

        return self::get($id);
    }

    /**
     * ลบรายการตั้งต้น — เจ้าของระบบ: "หน้านี้ต้องกดลบได้"
     *
     * ลบได้แม้เคยใช้ในบิลแล้ว เพราะบิลเก็บชื่อ % และจำนวนเงินของตัวเองไว้ใน invoice_adjustments ตั้งแต่ตอนใส่
     * รายการนี้เป็นแค่ "ทางลัดตอนออกบิล" — ตัดความเชื่อมโยงของบิลเก่าออก (charge_item_id = NULL) แล้วลบได้เลย
     * บิลเก่ายังแสดงชื่อและยอดเดิมครบ แค่เลือกรายการนี้ตอนออกบิลใหม่ไม่ได้แล้ว
     * ต่างจากสินค้า (ลบไม่ได้) เพราะสินค้าผูกกับยอดขาย การมอบหมาย และดีลเซล ส่วนรายการนี้ไม่มีอะไรอ้างถึงนอกจากบิล
     */
    public static function delete(int $id, int $actorUserId): array
    {
        $item = self::get($id);

        return Db::tx(static function () use ($id, $item, $actorUserId) {
            $used = Db::int('SELECT COUNT(*) FROM invoice_adjustments WHERE charge_item_id = ?', [$id]);
            Db::exec('UPDATE invoice_adjustments SET charge_item_id = NULL WHERE charge_item_id = ?', [$id]);
            Db::exec('DELETE FROM charge_items WHERE id = ?', [$id]);
            // จดชื่อไว้ในรายละเอียด — แถวถูกลบแล้ว หน้า "ประวัติรายการ" หาชื่อจาก id ไม่เจออีก
            Audit::write($actorUserId, 'charge_item.delete', 'charge_item', $id, [
                'name'        => $item['name'],
                'kind'        => $item['kind'],
                'usedOnBills' => $used,
            ]);

            return ['deleted' => true, 'id' => $id, 'name' => $item['name'], 'usedOnBills' => $used];
        });
    }

    public static function serialize(array $row): array
    {
        return [
            'id'            => (int) $row['id'],
            'name'          => $row['name'],
            'kind'          => $row['kind'],
            'kindLabel'     => $row['kind'] === 'DISCOUNT' ? 'ส่วนลด' : 'ค่าใช้จ่าย',
            'defaultAmount' => $row['default_amount_satang'] === null ? null : Money::toBaht($row['default_amount_satang']),
            'defaultPct'    => $row['default_pct_bp'] === null ? null : Money::bpToPct($row['default_pct_bp']),
            'description'   => $row['description'],
            'status'        => $row['status'],
        ];
    }
}
