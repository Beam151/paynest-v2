<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Db;
use App\Libraries\Money;
use App\Libraries\Period;

final class AssignmentService
{
    private const OPEN_END = '9999-12-31';

    /**
     * สัญญาของสินค้าชิ้นนี้ที่ช่วงวันที่คาบเกี่ยวกับ [start, end]
     * ไม่นับสัญญาของร้านที่ถูกลบ (สัญญาถูกปิดวันที่ลบ แต่วันนั้นยังนับว่าถืออยู่) — ร้านนั้นรับยอด/ถือสินค้าอะไรไม่ได้อีกแล้ว
     * สินค้าจึงมอบหมายต่อให้ร้านอื่นได้ตั้งแต่วันที่ลบ และบันทึกยอดรอบนั้นก็ไม่ติด "เปลี่ยนมือกลางรอบ" กับร้านที่ไม่มีอยู่แล้ว
     * (ยอดที่ร้านเดิมออกบิลไปแล้วยังผูกสัญญาเดิมอยู่ — 1 สินค้า 1 รอบมีได้รายการเดียว จึงไม่ซ้อนกับของร้านใหม่)
     */
    private static function overlapping(int $productId, string $start, ?string $end, ?int $excludeId = null): array
    {
        return Db::all(
            "SELECT a.*, f.username AS franchise_username
               FROM product_assignments a
               JOIN franchises f ON f.id = a.franchise_id AND f.status <> 'DELETED'
              WHERE a.product_id = ?
                AND a.start_date <= ?
                AND COALESCE(a.end_date, ?) >= ?
                AND (? IS NULL OR a.id <> ?)
              ORDER BY a.start_date",
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
        ProductService::assertActive($product, 'มอบหมายให้ร้าน');
        $franchise = Db::one('SELECT * FROM franchises WHERE id = ?', [(int) $input['franchiseId']]) ?? throw ApiException::notFound('ไม่พบร้านค้า');
        if ($franchise['status'] === 'DELETED') {
            throw ApiException::conflict("ร้าน {$franchise['username']} ถูกลบแล้ว — มอบหมายสินค้าให้ไม่ได้ · เลือกร้านอื่น");
        }
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
               f.username AS franchise_username, f.status AS franchise_status,
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

    /**
     * สัญญาของสินค้าที่ลบแล้ว / ร้านที่ลบแล้ว เป็นประวัติอย่างเดียว — ตอนลบระบบปิดให้แล้ว
     * แก้วันที่ทีหลัง = เปิดสัญญาให้ของที่ไม่มีอยู่แล้วกลับมาถือสินค้า (หรือย้ายยอดเก่าไปอยู่นอกช่วงสัญญา)
     */
    private static function assertLive(array $row): void
    {
        $who = Db::one(
            'SELECT p.sku, p.status AS product_status, f.username, f.status AS franchise_status
               FROM products p
               JOIN franchises f ON f.id = ?
              WHERE p.id = ?',
            [$row['franchise_id'], $row['product_id']],
        );
        if (($who['product_status'] ?? null) === 'DELETED') {
            throw ApiException::conflict("สินค้า {$who['sku']} ถูกลบแล้ว — สัญญาของสินค้านี้เป็นประวัติ แก้ไม่ได้");
        }
        if (($who['franchise_status'] ?? null) === 'DELETED') {
            throw ApiException::conflict("ร้าน {$who['username']} ถูกลบแล้ว — สัญญาของร้านนี้เป็นประวัติ แก้ไม่ได้");
        }
    }

    /** ปิดสัญญา เพื่อให้สินค้าชิ้นนี้ว่างและมอบหมายให้ร้านอื่นต่อได้ */
    public static function end(int $id, ?string $endDate, int $actorUserId): array
    {
        $row  = Db::one('SELECT * FROM product_assignments WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบข้อมูลการมอบหมายสินค้า');
        self::assertLive($row);
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

    /**
     * แก้วันเริ่ม/วันสิ้นสุดของสัญญา (หน้าแก้ไขสินค้า หรือ PATCH /api/assignments/:id)
     * $productId = ผู้เรียกบอกว่าสัญญานี้ต้องเป็นของสินค้าไหน (หน้าแก้ไขสินค้าส่ง id สัญญามาเอง — กันส่ง id ของสินค้าอื่น)
     */
    public static function update(int $id, array $patch, int $actorUserId, ?int $productId = null): array
    {
        $row       = Db::one('SELECT * FROM product_assignments WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบข้อมูลการมอบหมายสินค้า');
        if ($productId !== null && (int) $row['product_id'] !== $productId) {
            throw ApiException::notFound('ไม่พบสัญญานี้ในสินค้าที่กำลังแก้');
        }
        self::assertLive($row);
        $startDate = ! empty($patch['startDate']) ? Period::assertDate($patch['startDate'], 'startDate') : $row['start_date'];
        $endDate   = ! array_key_exists('endDate', $patch)
            ? $row['end_date']
            : ($patch['endDate'] === null ? null : Period::assertDate($patch['endDate'], 'endDate'));
        if ($endDate !== null && $endDate < $startDate) {
            throw ApiException::badRequest('endDate ต้องไม่น้อยกว่า startDate');
        }
        /*
         * ยอดขายที่บันทึกไว้แล้วผูกกับสัญญานี้ — รอบของยอดเหล่านั้นต้องยังอยู่ในช่วงสัญญาใหม่ (แบบเดียวกับตอนปิดสัญญา)
         * ไม่งั้นมียอดของรอบที่ร้านไม่ได้ถือสินค้า: บันทึกยอดรอบนั้นซ้ำ/ออกบิลรอบนั้นจะหาสัญญาไม่เจอหรือเจอของร้านอื่น
         */
        $outside = Db::one(
            'SELECT bp.code
               FROM sales_entries se
               JOIN billing_periods bp ON bp.id = se.period_id
              WHERE se.assignment_id = ? AND (bp.end_date < ? OR bp.start_date > ?)
              ORDER BY bp.start_date LIMIT 1',
            [$id, $startDate, $endDate ?? self::OPEN_END],
        );
        if ($outside !== null) {
            throw ApiException::conflict('แก้วันที่แบบนี้ไม่ได้ เพราะมียอดขายของสัญญานี้บันทึกไว้แล้วในรอบ ' . Period::text($outside['code'])
                . " ({$outside['code']}) — ช่วงสัญญาต้องยังครอบรอบนั้นอยู่");
        }
        $clash = self::overlapping((int) $row['product_id'], $startDate, $endDate, $id);
        if ($clash !== []) {
            $c = $clash[0];
            throw ApiException::conflict(
                "ช่วงวันที่ใหม่ทับกับสัญญาของร้าน {$c['franchise_username']} (" . Period::thDate($c['start_date']) . ' ถึง '
                    . ($c['end_date'] === null ? 'ไม่กำหนด' : Period::thDate($c['end_date'])) . ') — สินค้าชิ้นเดียวมีเจ้าของได้ทีละร้าน',
                array_map(static fn ($a) => [
                'assignmentId'      => (int) $a['id'],
                'franchiseUsername' => $a['franchise_username'],
                'startDate'         => $a['start_date'],
                'endDate'           => $a['end_date'],
            ], $clash),
            );
        }
        Db::exec(
            'UPDATE product_assignments SET start_date = ?, end_date = ?, note = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
            [$startDate, $endDate, array_key_exists('note', $patch) ? $patch['note'] : $row['note'], $id],
        );
        // จดค่าเดิมไว้ด้วย — หน้า "ประวัติรายการ" ต้องบอกได้ว่าย้ายวันจากไหนไปไหน
        Audit::write($actorUserId, 'assignment.update', 'assignment', $id, [
            ...$patch,
            'productId' => (int) $row['product_id'],
            'from'      => ['startDate' => $row['start_date'], 'endDate' => $row['end_date']],
        ]);

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
            // ร้านที่ลบแล้วไม่ถือสินค้าอะไร แม้สัญญาที่ปิดวันที่ลบยังนับถึงสิ้นวัน (ดู overlapping) — หน้าเว็บไม่ต้องโชว์ปุ่มปิดสัญญา
            'isActive'               => $row['start_date'] <= $today && ($row['end_date'] === null || $row['end_date'] >= $today)
                && ($row['franchise_status'] ?? null) !== 'DELETED',
            'franchiseStatus'        => $row['franchise_status'] ?? null,
            'note'                   => $row['note'],
            'createdAt'              => $row['created_at'],
        ];
    }
}
