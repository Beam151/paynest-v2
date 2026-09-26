<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Clock;
use App\Libraries\Db;
use App\Libraries\Money;
use App\Libraries\Period;

final class ProductService
{
    public static function create(array $input, ?int $actorUserId): array
    {
        if (Db::one('SELECT 1 FROM products WHERE LOWER(sku) = LOWER(?)', [$input['sku']])) {
            throw ApiException::conflict("รหัสสินค้า (SKU) \"{$input['sku']}\" ถูกใช้ไปแล้ว");
        }
        // % ส่วนต่างผูกกับสินค้า ต้องกำหนดตั้งแต่สร้าง — เป็นแหล่งเดียวที่ระบบใช้คิดเงิน
        $bp = Money::pctToBp($input['commissionPct'] ?? null, 'commissionPct');
        $id = Db::insert(
            'INSERT INTO products (sku, name, description, commission_pct_bp, created_by_user_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
            [$input['sku'], $input['name'], $input['description'] ?? null, $bp, $actorUserId],
        );
        Audit::write($actorUserId, 'product.create', 'product', $id, ['sku' => $input['sku']]);

        return self::get($id);
    }

    public static function get(int $id): array
    {
        $today = Clock::todayUtc();
        $row   = Db::one(
            'SELECT p.*,
                    a.id           AS assignment_id,
                    a.franchise_id AS assigned_franchise_id,
                    a.start_date   AS assigned_start_date,
                    a.end_date     AS assigned_end_date,
                    f.username     AS assigned_franchise_username
               FROM products p
               LEFT JOIN product_assignments a
                      ON a.product_id = p.id
                     AND a.start_date <= ?
                     AND (a.end_date IS NULL OR a.end_date >= ?)
               LEFT JOIN franchises f ON f.id = a.franchise_id
              WHERE p.id = ?',
            [$today, $today, $id],
        );

        return self::serialize($row ?? throw ApiException::notFound('ไม่พบสินค้า'));
    }

    public static function getRow(int $id): array
    {
        return Db::one('SELECT * FROM products WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบสินค้า');
    }

    /**
     * รายการสินค้า
     * - franchiseId: เห็นเฉพาะสินค้าที่ถูกมอบหมายให้ร้านนั้น (ณ วันที่ที่ระบุ / วันนี้)
     * - unassignedOnly: เฉพาะสินค้าที่ยังว่าง พร้อมมอบหมาย
     */
    public static function list(?int $franchiseId = null, ?string $status = null, ?string $q = null, bool $unassignedOnly = false, ?string $onDate = null): array
    {
        $date   = $onDate ?? Period::today();
        $where  = [];
        $params = [$date, $date]; // ใช้ใน JOIN ก่อน จึงต้องมาก่อนพารามิเตอร์ของ WHERE
        if ($status) {
            $where[]  = 'p.status = ?';
            $params[] = $status;
        }
        if ($q) {
            $where[] = '(p.sku LIKE ? OR p.name LIKE ?)';
            array_push($params, "%{$q}%", "%{$q}%");
        }
        if ($franchiseId) {
            $where[]  = 'a.franchise_id = ?';
            $params[] = $franchiseId;
        }
        if ($unassignedOnly) {
            $where[] = 'a.id IS NULL';
        }

        return array_map([self::class, 'serialize'], Db::all(
            'SELECT p.*,
                    a.id AS assignment_id, a.franchise_id AS assigned_franchise_id,
                    a.start_date AS assigned_start_date, a.end_date AS assigned_end_date,
                    f.username AS assigned_franchise_username
               FROM products p
               LEFT JOIN product_assignments a
                      ON a.product_id = p.id
                     AND a.start_date <= ?
                     AND (a.end_date IS NULL OR a.end_date >= ?)
               LEFT JOIN franchises f ON f.id = a.franchise_id
               ' . ($where ? 'WHERE ' . implode(' AND ', $where) : '') . '
              ORDER BY p.sku',
            $params,
        ));
    }

    private const UPDATABLE = ['name' => 'name', 'description' => 'description', 'status' => 'status'];

    /** แก้ % ของสินค้า — มีผลกับยอดที่บันทึกใหม่เท่านั้น ยอดเก่าเก็บ snapshot ไว้แล้ว */
    public static function update(int $id, array $patch, int $actorUserId): array
    {
        self::getRow($id);
        $sets   = [];
        $params = [];
        foreach (self::UPDATABLE as $key => $column) {
            if (array_key_exists($key, $patch)) {
                $sets[]   = "{$column} = ?";
                $params[] = $patch[$key];
            }
        }
        if (array_key_exists('commissionPct', $patch)) {
            $sets[]   = 'commission_pct_bp = ?';
            $params[] = Money::pctToBp($patch['commissionPct'], 'commissionPct');
        }
        if ($sets === []) {
            return self::get($id);
        }
        $sets[]   = 'updated_at = UTC_TIMESTAMP()';
        $params[] = $id;
        Db::exec('UPDATE products SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
        Audit::write($actorUserId, 'product.update', 'product', $id, $patch);

        return self::get($id);
    }

    /**
     * ลบสินค้าถาวร — ใช้ได้เฉพาะสินค้าที่ยังไม่เคยมีการเคลื่อนไหวทางการเงิน
     * ถ้าเคยบันทึกยอดขายแล้วต้องลบไม่ได้เด็ดขาด เพราะจะทำให้บิลและรายงานย้อนหลังเพี้ยน
     * กรณีนั้นให้ "ปิดใช้งาน" (status = ARCHIVED) แทน ซึ่งยังเก็บประวัติไว้ครบ
     */
    public static function delete(int $id, int $actorUserId): array
    {
        $product = self::getRow($id);
        $entries = Db::int('SELECT COUNT(*) FROM sales_entries WHERE product_id = ?', [$id]);
        if ($entries > 0) {
            throw ApiException::conflict(
                "สินค้า {$product['sku']} มียอดขายบันทึกไว้แล้ว {$entries} รายการ ลบไม่ได้ "
                . '— ใช้ "ปิดใช้งาน" แทน เพื่อไม่ให้บิลและรายงานย้อนหลังเสียหาย',
            );
        }
        $assignments = Db::int('SELECT COUNT(*) FROM product_assignments WHERE product_id = ?', [$id]);

        return Db::tx(static function () use ($id, $product, $assignments, $actorUserId) {
            // การมอบหมายและดีลเซลที่ยังไม่เคยมียอดขาย ลบทิ้งพร้อมกันได้
            Db::exec('DELETE FROM product_assignments WHERE product_id = ?', [$id]);
            Db::exec('DELETE FROM product_sales_links WHERE product_id = ?', [$id]);
            Db::exec('DELETE FROM products WHERE id = ?', [$id]);
            Audit::write($actorUserId, 'product.delete', 'product', $id, [
                'sku'                => $product['sku'],
                'name'               => $product['name'],
                'assignmentsRemoved' => $assignments,
            ]);

            return ['deleted' => true, 'id' => $id, 'sku' => $product['sku']];
        });
    }

    public static function serialize(array $row): array
    {
        return [
            'id'                => (int) $row['id'],
            'sku'               => $row['sku'],
            'name'              => $row['name'],
            'description'       => $row['description'],
            'commissionPct'     => Money::bpToPct($row['commission_pct_bp']),
            'status'            => $row['status'],
            'createdAt'         => $row['created_at'],
            'currentAssignment' => ($row['assignment_id'] ?? null)
                ? [
                    'id'                => (int) $row['assignment_id'],
                    'franchiseId'       => (int) $row['assigned_franchise_id'],
                    'franchiseUsername' => $row['assigned_franchise_username'],
                    'startDate'         => $row['assigned_start_date'],
                    'endDate'           => $row['assigned_end_date'],
                ]
                : null,
        ];
    }
}
