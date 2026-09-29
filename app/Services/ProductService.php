<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Clock;
use App\Libraries\Db;
use App\Libraries\Money;
use App\Libraries\Period;

final class ProductService
{
    /** กันรายการย่อยยาวผิดปกติ — ชุดจริงไม่กี่ชิ้น และหน้าบิลต้องโชว์ครบทุกชิ้นใต้ชื่อกลุ่ม */
    private const MAX_GROUP_ITEMS = 100;

    private const MSG_GROUP_MIN_ONE = 'สินค้ากลุ่มต้องมีสินค้าย่อยอย่างน้อย 1 รายการ — ติ๊กเลือกสินค้าที่อยู่ในชุดนี้';

    private const MSG_ITEMS_NOT_GROUP = 'ใส่รายการย่อยได้เฉพาะสินค้ากลุ่ม — เปิด "สินค้ากลุ่ม" ก่อน หรือเอารายการย่อยออก';

    public static function create(array $input, ?int $actorUserId): array
    {
        $taken = Db::one('SELECT status FROM products WHERE LOWER(sku) = LOWER(?)', [$input['sku']]);
        if ($taken !== null) {
            // สินค้าลบไม่ได้ SKU จึงไม่เคยว่างคืน — ถ้าเป็นของที่ปิดใช้งานไว้ บอกทางให้เปิดของเดิมแทน
            throw ApiException::conflict($taken['status'] === 'ARCHIVED'
                ? "รหัสสินค้า (SKU) \"{$input['sku']}\" เป็นของสินค้าที่ปิดใช้งานไว้ — เปิดใช้งานสินค้าเดิมอีกครั้ง หรือใช้รหัสอื่น"
                : "รหัสสินค้า (SKU) \"{$input['sku']}\" ถูกใช้ไปแล้ว");
        }
        // % ส่วนต่างผูกกับสินค้า ต้องกำหนดตั้งแต่สร้าง — เป็นแหล่งเดียวที่ระบบใช้คิดเงิน
        $bp = Money::pctToBp($input['commissionPct'] ?? null, 'commissionPct');

        $isGroup = ($input['isGroup'] ?? false) === true;
        $itemIds = self::uniqueIds($input['itemProductIds'] ?? []);
        if (! $isGroup && $itemIds !== []) {
            throw ApiException::badRequest(self::MSG_ITEMS_NOT_GROUP);
        }
        if ($isGroup) {
            self::assertItemCount($itemIds);
        }

        return Db::tx(static function () use ($input, $bp, $isGroup, $itemIds, $actorUserId) {
            // สินค้าใหม่ยังไม่อยู่ในกลุ่มไหนแน่นอน — ตรวจแค่ตัวรายการย่อย (ล็อกไว้กันถูกเปลี่ยนเป็นกลุ่มพร้อมกัน)
            $items = $isGroup ? self::checkItems(null, $itemIds, self::lockProducts($itemIds), []) : [];
            $id    = Db::insert(
                'INSERT INTO products (sku, name, description, commission_pct_bp, is_group, created_by_user_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
                [$input['sku'], $input['name'], $input['description'] ?? null, $bp, $isGroup ? 1 : 0, $actorUserId],
            );
            if ($items !== []) {
                self::replaceItems($id, $items);
            }
            Audit::write($actorUserId, 'product.create', 'product', $id, [
                'sku'     => $input['sku'],
                'isGroup' => $isGroup,
                'items'   => array_column($items, 'sku'),
            ]);

            return self::get($id);
        });
    }

    /**
     * @param bool $includeInGroups false = ไม่บอกว่าสินค้านี้อยู่ในกลุ่มไหน (ร้านค้า — กลุ่มนั้นอาจเป็นของร้านอื่น)
     */
    public static function get(int $id, bool $includeInGroups = true): array
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
        ) ?? throw ApiException::notFound('ไม่พบสินค้า');

        return self::serialize(
            $row,
            (int) $row['is_group'] === 1 ? (self::itemsOf([$id])[$id] ?? []) : [],
            $includeInGroups ? (self::groupsOf([$id])[$id] ?? []) : [],
        );
    }

    public static function getRow(int $id): array
    {
        return Db::one('SELECT * FROM products WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบสินค้า');
    }

    /**
     * รายการสินค้า
     * - franchiseId: เห็นเฉพาะสินค้าที่ถูกมอบหมายให้ร้านนั้น (ณ วันที่ที่ระบุ / วันนี้)
     * - unassignedOnly: เฉพาะสินค้าที่ยังว่าง พร้อมมอบหมาย
     * - isGroup: true = เฉพาะสินค้ากลุ่ม · false = เฉพาะสินค้าเดี่ยว · null = ทั้งหมด
     * รายการย่อย / กลุ่มที่สังกัด ดึงรวบทีเดียวทั้งหน้า (อย่างละหนึ่งคิวรี) ไม่ใช่ทีละแถว
     */
    public static function list(?int $franchiseId = null, ?string $status = null, ?string $q = null, bool $unassignedOnly = false, ?string $onDate = null, ?bool $isGroup = null, bool $includeInGroups = true): array
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
        if ($isGroup !== null) {
            $where[]  = 'p.is_group = ?';
            $params[] = $isGroup ? 1 : 0;
        }

        $rows = Db::all(
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
        );
        $groupIds = array_map(static fn ($r) => (int) $r['id'], array_filter($rows, static fn ($r) => (int) $r['is_group'] === 1));
        $items    = self::itemsOf($groupIds);
        $inGroups = $includeInGroups ? self::groupsOf(array_map(static fn ($r) => (int) $r['id'], $rows)) : [];

        return array_map(static fn ($r) => self::serialize($r, $items[(int) $r['id']] ?? [], $inGroups[(int) $r['id']] ?? []), $rows);
    }

    private const UPDATABLE = ['name' => 'name', 'description' => 'description', 'status' => 'status'];

    /**
     * แก้ % ของสินค้า — มีผลกับยอดที่บันทึกใหม่เท่านั้น ยอดเก่าเก็บ snapshot ไว้แล้ว
     *
     * สินค้าลบไม่ได้ (บิล/ยอดขาย/ดีลย้อนหลังอ้างถึงอยู่) — เลิกขายใช้ status ARCHIVED = "ปิดใช้งาน" แทน
     * ปิดใช้งานแล้วสัญญามอบหมายและดีลเซลที่ยังเปิดอยู่คงไว้เหมือนเดิม ไม่ตัดจบให้
     * เพราะเปิดใช้งานอีกครั้งต้องขายต่อได้ทันทีโดยไม่ต้องมอบหมาย/ผูกดีลใหม่
     * ระหว่างปิด บันทึกยอดใหม่ไม่ได้ (SalesService::upsert) แต่ยอดที่บันทึกไว้แล้วยังออกบิลได้ตามปกติ
     *
     * สินค้ากลุ่ม: isGroup เปิด/ปิด · itemProductIds = รายการย่อยทั้งชุด (ส่งมา = แทนที่ของเดิมทั้งหมด)
     *   ปิด isGroup = ล้างรายการย่อยทิ้ง · บิลที่ออกไปแล้วยังโชว์รายการย่อยเดิม (sales_entries.components_snapshot)
     */
    public static function update(int $id, array $patch, int $actorUserId): array
    {
        self::getRow($id);
        $wantsGroup = array_key_exists('isGroup', $patch) ? $patch['isGroup'] === true : null;
        $itemIds    = array_key_exists('itemProductIds', $patch) ? self::uniqueIds($patch['itemProductIds']) : null;
        // ตรวจของที่ไม่ต้องอ่านฐานข้อมูลก่อน — ไม่ต้องล็อกแถวให้เสียเปล่า
        if ($wantsGroup === false && $itemIds) {
            throw ApiException::badRequest(self::MSG_ITEMS_NOT_GROUP);
        }
        if ($itemIds !== null && ($wantsGroup === true || $itemIds !== [])) {
            self::assertItemCount($itemIds);
        }

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
        if ($sets === [] && $wantsGroup === null && $itemIds === null) {
            return self::get($id);
        }

        Db::tx(static function () use ($id, $sets, $params, $patch, $wantsGroup, $itemIds, $actorUserId) {
            /*
             * ล็อกตัวสินค้า + รายการย่อยที่เลือกพร้อมกันในคำสั่งเดียว (เรียงตาม id) ก่อนตรวจ "ห้ามกลุ่มซ้อนกลุ่ม"
             * ไม่งั้นสองจอกดพร้อมกัน — จอหนึ่งใส่ B เป็นรายการย่อยของ A อีกจอเปลี่ยน B เป็นกลุ่ม — จะผ่านทั้งคู่
             */
            $locked = self::lockProducts([$id, ...($itemIds ?? [])]);
            $before = $locked[$id];
            $plan   = self::planGroupChange($before, $wantsGroup, $itemIds, $locked);
            if ($plan['isGroup'] !== null) {
                $sets[]   = 'is_group = ?';
                $params[] = $plan['isGroup'] ? 1 : 0;
            }

            if ($sets !== []) {
                Db::exec('UPDATE products SET ' . implode(', ', [...$sets, 'updated_at = UTC_TIMESTAMP()']) . ' WHERE id = ?', [...$params, $id]);
                // รายการย่อยจดแยกเป็น product.group_items (เป็น SKU อ่านรู้เรื่อง) — ไม่ซ้ำเป็น id ในแถวนี้
                $detail = array_diff_key($patch, ['itemProductIds' => true]);
                // หน้าแก้สินค้าส่ง isGroup:true มากับการแก้รายการย่อยของกลุ่มเดิม — ความเป็นกลุ่มไม่ได้เปลี่ยน ไม่ต้องจดให้ประวัติอ่านแล้วงง
                if ($plan['isGroup'] === null) {
                    unset($detail['isGroup']);
                }
                if ($detail !== []) {
                    Audit::write($actorUserId, 'product.update', 'product', $id, $detail);
                }
            }
            // ปิด/เปิดใช้งานจดแยกอีกแถว — หน้า "ประวัติรายการ" จะเห็นชัดว่าใครปิดสินค้าไหนเมื่อไร ไม่จมอยู่ใน "แก้ไขสินค้า"
            if (array_key_exists('status', $patch) && $patch['status'] !== $before['status']) {
                Audit::write($actorUserId, $patch['status'] === 'ARCHIVED' ? 'product.archive' : 'product.activate', 'product', $id, [
                    'sku'  => $before['sku'],
                    'from' => $before['status'],
                    'to'   => $patch['status'],
                ]);
            }

            if ($plan['items'] !== null) {
                self::replaceItems($id, $plan['items']);
                if ($plan['added'] !== [] || $plan['removed'] !== []) {
                    Audit::write($actorUserId, 'product.group_items', 'product', $id, [
                        'sku'     => $before['sku'],
                        'added'   => $plan['added'],
                        'removed' => $plan['removed'],
                    ]);
                }
            }
        });

        return self::get($id);
    }

    /* ── สินค้ากลุ่ม (ชุด) ─────────────────────────────────────────── */

    /**
     * ตัดสินว่า PATCH นี้เปลี่ยนความเป็นกลุ่ม/รายการย่อยอย่างไร — ยังไม่เขียนอะไร
     *
     * @param array<int, array> $locked แถวสินค้าที่ล็อกไว้แล้ว (ตัวมันเอง + รายการย่อยที่ส่งมา)
     *
     * @return array{isGroup: bool|null, items: list<array>|null, added: list<string>, removed: list<string>}
     *   isGroup null = ไม่เปลี่ยน · items null = ไม่แตะรายการย่อย ([] = ล้างทิ้ง)
     */
    private static function planGroupChange(array $product, ?bool $wantsGroup, ?array $itemIds, array $locked): array
    {
        $id      = (int) $product['id'];
        $isGroup = (int) $product['is_group'] === 1;
        $target  = $wantsGroup ?? $isGroup;
        $current = $isGroup ? (self::itemsOf([$id])[$id] ?? []) : [];
        $noop    = ['isGroup' => null, 'items' => null, 'added' => [], 'removed' => []];

        if (! $target) {
            if ($itemIds) {
                throw ApiException::badRequest(self::MSG_ITEMS_NOT_GROUP);
            }
            if (! $isGroup) {
                return $noop;
            }

            // เลิกเป็นกลุ่ม = กลับเป็นสินค้าธรรมดา รายการย่อยไม่มีความหมายแล้ว
            return ['isGroup' => false, 'items' => [], 'added' => [], 'removed' => array_column($current, 'sku')];
        }

        if (! $isGroup) {
            // สินค้าที่เป็นรายการย่อยของกลุ่มอื่นอยู่ ถ้ากลายเป็นกลุ่มเองก็คือกลุ่มซ้อนกลุ่ม
            $parents = self::parentSkus($id);
            if ($parents !== []) {
                throw ApiException::badRequest('สินค้านี้อยู่ในสินค้ากลุ่ม ' . implode(', ', $parents) . ' อยู่ — เอาออกจากกลุ่มก่อน จึงจะเปลี่ยนเป็นสินค้ากลุ่มได้');
            }
            if (! $itemIds) {
                throw ApiException::badRequest(self::MSG_GROUP_MIN_ONE);
            }
        }
        if ($itemIds === null) {
            return $noop; // เป็นกลุ่มอยู่แล้ว และไม่ได้ส่งรายการย่อยมา — ของเดิมคงไว้
        }

        $items      = self::checkItems($id, $itemIds, $locked, array_column($current, 'id'));
        $currentSku = array_column($current, 'sku');
        $newSku     = array_column($items, 'sku');

        return [
            'isGroup' => $isGroup ? null : true,
            'items'   => $items,
            'added'   => array_values(array_diff($newSku, $currentSku)),
            'removed' => array_values(array_diff($currentSku, $newSku)),
        ];
    }

    /**
     * ตรวจรายการย่อยที่ติ๊กมา แล้วคืนแถวสินค้าเรียงตามลำดับที่ส่งมา
     * - ต้องมีอย่างน้อย 1 · ไม่ใช่ตัวมันเอง · ไม่ใช่สินค้ากลุ่ม (ห้ามซ้อน)
     * - สินค้าที่ปิดใช้งาน: อยู่ในกลุ่มเดิมต่อได้ (ชุดที่เคยขายยังต้องโชว์ครบ) แต่เพิ่มเข้าใหม่ไม่ได้
     *
     * @param list<int>          $itemIds    ไม่ซ้ำแล้ว
     * @param array<int, array>  $locked     แถวสินค้าที่ล็อกไว้แล้ว
     * @param list<int|string>   $currentIds รายการย่อยปัจจุบันของกลุ่มนี้
     */
    private static function checkItems(?int $groupId, array $itemIds, array $locked, array $currentIds): array
    {
        if ($itemIds === []) {
            throw ApiException::badRequest(self::MSG_GROUP_MIN_ONE);
        }
        if ($groupId !== null && in_array($groupId, $itemIds, true)) {
            throw ApiException::badRequest('ใส่สินค้ากลุ่มเป็นรายการย่อยของตัวเองไม่ได้ — เอาสินค้านี้ออกจากรายการที่ติ๊กไว้');
        }
        $missing = array_values(array_filter($itemIds, static fn ($i) => ! isset($locked[$i])));
        if ($missing !== []) {
            throw ApiException::badRequest('ไม่พบสินค้าที่เลือกเป็นรายการย่อย (id: ' . implode(', ', $missing) . ') — โหลดหน้าใหม่แล้วเลือกอีกครั้ง');
        }
        $rows   = array_map(static fn ($i) => $locked[$i], $itemIds);
        $nested = array_column(array_filter($rows, static fn ($r) => (int) $r['is_group'] === 1), 'sku');
        if ($nested !== []) {
            throw ApiException::badRequest('สินค้ากลุ่มใส่สินค้ากลุ่มอื่นเป็นรายการย่อยไม่ได้ (' . implode(', ', $nested) . ') — เอาออกจากรายการที่ติ๊กไว้');
        }
        $keep     = array_flip(array_map('intval', $currentIds));
        $archived = array_column(array_filter($rows, static fn ($r) => $r['status'] === 'ARCHIVED' && ! isset($keep[(int) $r['id']])), 'sku');
        if ($archived !== []) {
            throw ApiException::badRequest('สินค้า ' . implode(', ', $archived) . ' ถูกปิดใช้งานแล้ว เพิ่มเป็นรายการย่อยใหม่ไม่ได้ — เปิดใช้งานสินค้านั้นก่อน หรือเลือกสินค้าอื่น');
        }

        return $rows;
    }

    /** @param list<int> $itemIds */
    private static function assertItemCount(array $itemIds): void
    {
        if ($itemIds === []) {
            throw ApiException::badRequest(self::MSG_GROUP_MIN_ONE);
        }
        if (count($itemIds) > self::MAX_GROUP_ITEMS) {
            throw ApiException::badRequest('สินค้ากลุ่มมีสินค้าย่อยได้สูงสุด ' . self::MAX_GROUP_ITEMS . ' รายการ — แยกเป็นหลายกลุ่ม หรือเอารายการที่ไม่จำเป็นออก');
        }
    }

    /** id ที่ส่งมาซ้ำนับครั้งเดียว — คงลำดับที่ติ๊กไว้ (ใช้เป็น sort_order) */
    private static function uniqueIds(array $ids): array
    {
        return array_values(array_unique(array_map('intval', $ids)));
    }

    /**
     * ล็อกแถวสินค้าทีเดียวทั้งชุด เรียงตาม id — สองรายการที่ล็อกสินค้าชุดทับกันจะรอคิวกัน ไม่ติด deadlock
     *
     * @param list<int> $ids
     *
     * @return array<int, array> id → แถว (id, sku, name, status, is_group)
     */
    private static function lockProducts(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $out = [];
        foreach (Db::all('SELECT id, sku, name, status, is_group FROM products WHERE id IN ? ORDER BY id FOR UPDATE', [array_values(array_unique($ids))]) as $r) {
            $out[(int) $r['id']] = $r;
        }

        return $out;
    }

    /**
     * SKU ของกลุ่มที่มีสินค้านี้เป็นรายการย่อย
     * อ่านแบบล็อก (share) — ต้องเห็นรายการย่อยที่อีกจอเพิ่ง commit ไป ไม่ใช่ภาพเก่าของ transaction นี้
     * ล็อกเฉพาะแถว product_group_items ไม่ล็อกแถวสินค้ากลุ่ม (จอที่กำลังแก้กลุ่มนั้นถือล็อกอยู่ → deadlock)
     */
    private static function parentSkus(int $productId): array
    {
        $groupIds = array_map('intval', array_column(
            Db::all('SELECT group_product_id FROM product_group_items WHERE item_product_id = ? LOCK IN SHARE MODE', [$productId]),
            'group_product_id',
        ));

        return $groupIds === [] ? [] : array_column(Db::all('SELECT sku FROM products WHERE id IN ? ORDER BY sku', [$groupIds]), 'sku');
    }

    /**
     * เขียนรายการย่อยทั้งชุดแทนของเดิม — ลบที่ไม่อยู่ในชุดใหม่ + ใส่/อัปเดตลำดับ (อย่างละหนึ่งคำสั่ง)
     * แถวที่ยังอยู่ต่อไม่ถูกลบแล้วใส่ใหม่ created_at จึงยังบอกได้ว่าติ๊กเข้ากลุ่มตั้งแต่เมื่อไร
     *
     * @param list<array> $items แถวสินค้าเรียงตามลำดับที่ต้องการ ([] = ล้างทิ้ง)
     */
    private static function replaceItems(int $groupId, array $items): void
    {
        $ids = array_map(static fn ($r) => (int) $r['id'], $items);
        if ($ids === []) {
            Db::exec('DELETE FROM product_group_items WHERE group_product_id = ?', [$groupId]);

            return;
        }
        Db::exec('DELETE FROM product_group_items WHERE group_product_id = ? AND item_product_id NOT IN ?', [$groupId, $ids]);
        $values = [];
        $params = [];
        foreach ($ids as $i => $itemId) {
            $values[] = '(?, ?, ?, UTC_TIMESTAMP())';
            array_push($params, $groupId, $itemId, $i);
        }
        Db::exec(
            'INSERT INTO product_group_items (group_product_id, item_product_id, sort_order, created_at)
             VALUES ' . implode(', ', $values) . '
             ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order)',
            $params,
        );
    }

    /**
     * รายการย่อยของสินค้ากลุ่มหลายตัวในคิวรีเดียว (ใช้ทั้งหน้าสินค้า การจด snapshot ตอนขึ้นบิล และบรรทัดยอดขาย)
     * สินค้าที่ไม่ใช่กลุ่มไม่มีคีย์ในผลลัพธ์
     *
     * @param list<int> $groupIds
     *
     * @return array<int, list<array{id: int, sku: string, name: string, status: string}>>
     */
    public static function itemsOf(array $groupIds): array
    {
        if ($groupIds === []) {
            return [];
        }
        $out = [];
        foreach (Db::all(
            'SELECT gi.group_product_id, c.id, c.sku, c.name, c.status
               FROM product_group_items gi
               JOIN products g ON g.id = gi.group_product_id AND g.is_group = 1
               JOIN products c ON c.id = gi.item_product_id
              WHERE gi.group_product_id IN ?
              ORDER BY gi.group_product_id, gi.sort_order, c.sku',
            [array_values(array_unique(array_map('intval', $groupIds)))],
        ) as $r) {
            $out[(int) $r['group_product_id']][] = [
                'id'     => (int) $r['id'],
                'sku'    => $r['sku'],
                'name'   => $r['name'],
                'status' => $r['status'],
            ];
        }

        return $out;
    }

    /**
     * กลุ่มที่สินค้าแต่ละตัวเป็นรายการย่อยอยู่ (คิวรีเดียวทั้งหน้า)
     *
     * @param list<int> $productIds
     *
     * @return array<int, list<array{id: int, sku: string, name: string}>>
     */
    public static function groupsOf(array $productIds): array
    {
        if ($productIds === []) {
            return [];
        }
        $out = [];
        foreach (Db::all(
            'SELECT gi.item_product_id, g.id, g.sku, g.name
               FROM product_group_items gi
               JOIN products g ON g.id = gi.group_product_id AND g.is_group = 1
              WHERE gi.item_product_id IN ?
              ORDER BY gi.item_product_id, g.sku',
            [array_values(array_unique(array_map('intval', $productIds)))],
        ) as $r) {
            $out[(int) $r['item_product_id']][] = ['id' => (int) $r['id'], 'sku' => $r['sku'], 'name' => $r['name']];
        }

        return $out;
    }

    /**
     * @param list<array> $items    รายการย่อย (เฉพาะสินค้ากลุ่ม)
     * @param list<array> $inGroups กลุ่มที่สินค้านี้เป็นรายการย่อยอยู่
     */
    public static function serialize(array $row, array $items = [], array $inGroups = []): array
    {
        return [
            'id'                => (int) $row['id'],
            'sku'               => $row['sku'],
            'name'              => $row['name'],
            'description'       => $row['description'],
            'commissionPct'     => Money::bpToPct($row['commission_pct_bp']),
            'status'            => $row['status'],
            'isGroup'           => (int) ($row['is_group'] ?? 0) === 1,
            'items'             => $items,
            'inGroups'          => $inGroups,
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
