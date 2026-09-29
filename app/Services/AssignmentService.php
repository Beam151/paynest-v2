<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Db;
use App\Libraries\Money;
use App\Libraries\Period;

final class AssignmentService
{
    private const OPEN_END = '9999-12-31';

    /** สัญญาของสินค้าชิ้นนี้ที่ช่วงวันที่คาบเกี่ยวกับ [start, end] */
    private static function overlapping(int $productId, string $start, ?string $end, ?int $excludeId = null): array
    {
        return Db::all(
            'SELECT a.*, f.username AS franchise_username
               FROM product_assignments a
               JOIN franchises f ON f.id = a.franchise_id
              WHERE a.product_id = ?
                AND a.start_date <= ?
                AND COALESCE(a.end_date, ?) >= ?
                AND (? IS NULL OR a.id <> ?)
              ORDER BY a.start_date',
            [$productId, $end ?? self::OPEN_END, self::OPEN_END, $start, $excludeId, $excludeId],
        );
    }

    /**
     * มอบหมายสินค้าให้ร้าน
     * กฎเหล็ก: สินค้าชิ้นเดียวกันห้ามมีสัญญาที่ช่วงวันที่ทับกัน → ขายได้ร้านเดียว
     */
    public static function assign(array $input, ?int $actorUserId): array
    {
        $product = ProductService::getRow((int) $input['productId']);
        if ($product['status'] !== 'ACTIVE') {
            throw ApiException::badRequest("สินค้า {$product['sku']} ถูกปิดใช้งานแล้ว — เปิดใช้งานที่หน้าสินค้าก่อนจึงจะมอบหมายให้ร้านได้");
        }
        $franchise = Db::one('SELECT * FROM franchises WHERE id = ?', [(int) $input['franchiseId']]) ?? throw ApiException::notFound('ไม่พบร้านค้า');
        if ($franchise['status'] !== 'ACTIVE') {
            throw ApiException::badRequest("ร้านค้า {$franchise['username']} ไม่อยู่ในสถานะใช้งาน");
        }
        $startDate = Period::assertDate($input['startDate'] ?? Period::today(), 'startDate');
        $endDate   = ! empty($input['endDate']) ? Period::assertDate($input['endDate'], 'endDate') : null;
        if ($endDate !== null && $endDate < $startDate) {
            throw ApiException::badRequest('endDate ต้องไม่น้อยกว่า startDate');
        }

        $clash = self::overlapping((int) $product['id'], $startDate, $endDate);
        if ($clash !== []) {
            throw ApiException::conflict(
                "สินค้า \"{$product['sku']}\" ถูกมอบหมายให้ร้าน {$clash[0]['franchise_username']} อยู่แล้วในช่วงวันที่ที่ทับกัน",
                array_map(static fn ($a) => [
                    'assignmentId'      => (int) $a['id'],
                    'franchiseId'       => (int) $a['franchise_id'],
                    'franchiseUsername' => $a['franchise_username'],
                    'startDate'         => $a['start_date'],
                    'endDate'           => $a['end_date'],
                ], $clash),
            );
        }

        $id = Db::insert(
            'INSERT INTO product_assignments (product_id, franchise_id, start_date, end_date, note, created_by_user_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
            [$product['id'], $franchise['id'], $startDate, $endDate, $input['note'] ?? null, $actorUserId],
        );
        Audit::write($actorUserId, 'assignment.create', 'assignment', $id, [
            'productId'   => (int) $product['id'],
            'franchiseId' => (int) $franchise['id'],
            'startDate'   => $startDate,
            'endDate'     => $endDate,
        ]);

        return self::get($id);
    }

    private const SELECT = '
        SELECT a.*,
               p.sku, p.name AS product_name,
               f.username AS franchise_username,
               p.commission_pct_bp AS product_pct_bp
          FROM product_assignments a
          JOIN products p   ON p.id = a.product_id
          JOIN franchises f ON f.id = a.franchise_id';

    public static function get(int $id): array
    {
        return self::serialize(Db::one(self::SELECT . ' WHERE a.id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบข้อมูลการมอบหมายสินค้า'));
    }

    public static function list(?int $productId = null, ?int $franchiseId = null, ?string $activeOn = null): array
    {
        $where  = [];
        $params = [];
        if ($productId) {
            $where[]  = 'a.product_id = ?';
            $params[] = $productId;
        }
        if ($franchiseId) {
            $where[]  = 'a.franchise_id = ?';
            $params[] = $franchiseId;
        }
        if ($activeOn) {
            $date    = Period::assertDate($activeOn, 'activeOn');
            $where[] = 'a.start_date <= ? AND (a.end_date IS NULL OR a.end_date >= ?)';
            array_push($params, $date, $date);
        }

        return array_map([self::class, 'serialize'], Db::all(
            self::SELECT . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY a.start_date DESC, a.id DESC',
            $params,
        ));
    }

    /** ปิดสัญญา เพื่อให้สินค้าชิ้นนี้ว่างและมอบหมายให้ร้านอื่นต่อได้ */
    public static function end(int $id, ?string $endDate, int $actorUserId): array
    {
        $row  = Db::one('SELECT * FROM product_assignments WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบข้อมูลการมอบหมายสินค้า');
        $date = Period::assertDate($endDate ?? Period::today(), 'endDate');
        if ($date < $row['start_date']) {
            throw ApiException::badRequest('endDate ต้องไม่น้อยกว่า startDate');
        }
        $locked = Db::one(
            'SELECT bp.code
               FROM sales_entries se
               JOIN billing_periods bp ON bp.id = se.period_id
              WHERE se.assignment_id = ? AND bp.start_date > ?
              ORDER BY bp.start_date DESC LIMIT 1',
            [$id, $date],
        );
        if ($locked !== null) {
            throw ApiException::conflict("ปิดสัญญาที่วันที่นี้ไม่ได้ เพราะมียอดขายบันทึกไว้แล้วในรอบบิล {$locked['code']}");
        }
        Db::exec('UPDATE product_assignments SET end_date = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [$date, $id]);
        Audit::write($actorUserId, 'assignment.end', 'assignment', $id, ['endDate' => $date]);

        return self::get($id);
    }

    public static function update(int $id, array $patch, int $actorUserId): array
    {
        $row       = Db::one('SELECT * FROM product_assignments WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบข้อมูลการมอบหมายสินค้า');
        $startDate = ! empty($patch['startDate']) ? Period::assertDate($patch['startDate'], 'startDate') : $row['start_date'];
        $endDate   = ! array_key_exists('endDate', $patch)
            ? $row['end_date']
            : ($patch['endDate'] === null ? null : Period::assertDate($patch['endDate'], 'endDate'));
        if ($endDate !== null && $endDate < $startDate) {
            throw ApiException::badRequest('endDate ต้องไม่น้อยกว่า startDate');
        }
        $clash = self::overlapping((int) $row['product_id'], $startDate, $endDate, $id);
        if ($clash !== []) {
            throw ApiException::conflict('ช่วงวันที่ใหม่ทับกับสัญญาอื่นของสินค้าชิ้นนี้', array_map(static fn ($a) => [
                'assignmentId'      => (int) $a['id'],
                'franchiseUsername' => $a['franchise_username'],
                'startDate'         => $a['start_date'],
                'endDate'           => $a['end_date'],
            ], $clash));
        }
        Db::exec(
            'UPDATE product_assignments SET start_date = ?, end_date = ?, note = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
            [$startDate, $endDate, array_key_exists('note', $patch) ? $patch['note'] : $row['note'], $id],
        );
        Audit::write($actorUserId, 'assignment.update', 'assignment', $id, $patch);

        return self::get($id);
    }

    /**
     * หาสัญญาที่ใช้กับรอบบิลนี้ (ต้องเจอเพียงรายการเดียวเท่านั้น)
     * ถ้าเจอมากกว่า 1 แปลว่ามีการเปลี่ยนมือกลางรอบ → ให้ผู้ดูแลตัดสินใจก่อน
     */
    public static function resolveForPeriod(int $productId, array $period, ?int $franchiseId = null): array
    {
        $matches = self::overlapping($productId, $period['start_date'], $period['end_date']);
        if ($matches === []) {
            throw ApiException::badRequest("สินค้านี้ยังไม่ถูกมอบหมายให้ร้านใดในรอบบิล {$period['code']}");
        }
        if (count($matches) > 1) {
            throw ApiException::conflict(
                "สินค้านี้เปลี่ยนมือกลางรอบบิล {$period['code']} — ต้องแยกรอบหรือแก้ช่วงสัญญาก่อนบันทึกยอด",
                array_map(static fn ($a) => [
                    'assignmentId'      => (int) $a['id'],
                    'franchiseUsername' => $a['franchise_username'],
                    'startDate'         => $a['start_date'],
                    'endDate'           => $a['end_date'],
                ], $matches),
            );
        }
        $assignment = $matches[0];
        if ($franchiseId && (int) $assignment['franchise_id'] !== $franchiseId) {
            throw ApiException::badRequest("สินค้านี้อยู่ในความดูแลของร้าน {$assignment['franchise_username']} ไม่ใช่ของคุณ");
        }

        return $assignment;
    }

    /** % ผูกกับสินค้า ตั้งไว้ตั้งแต่ตอนสร้าง — สินค้าคนละชิ้นตัด % ไม่เท่ากันได้ */
    public static function effectiveCommissionBp(array $productRow): int
    {
        $bp = $productRow['commission_pct_bp'] ?? null;
        if ($bp === null) {
            throw ApiException::badRequest('สินค้า ' . ($productRow['sku'] ?? '') . ' ยังไม่ได้ตั้ง % ส่วนต่าง — ตั้งที่หน้า "สินค้า" ก่อน');
        }

        return (int) $bp;
    }

    public static function serialize(array $row): array
    {
        $today     = Period::today();
        $effective = $row['product_pct_bp'] ?? null;

        return [
            'id'                     => (int) $row['id'],
            'productId'              => (int) $row['product_id'],
            'sku'                    => $row['sku'],
            'productName'            => $row['product_name'],
            'franchiseId'            => (int) $row['franchise_id'],
            'franchiseUsername'      => $row['franchise_username'],
            'effectiveCommissionPct' => $effective === null ? null : Money::bpToPct($effective),
            'startDate'              => $row['start_date'],
            'endDate'                => $row['end_date'],
            'isActive'               => $row['start_date'] <= $today && ($row['end_date'] === null || $row['end_date'] >= $today),
            'note'                   => $row['note'],
            'createdAt'              => $row['created_at'],
        ];
    }
}
