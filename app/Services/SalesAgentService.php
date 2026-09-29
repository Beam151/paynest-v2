<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\AuthContext;
use App\Libraries\Db;
use App\Libraries\Money;
use App\Libraries\Period;
use Throwable;

/**
 * เซล — ดีลผูกกับสินค้า (ไม่ใช่ทั้งร้าน) · ค่าคอมจ่ายผ่าน "บิลค่าคอม" ที่ส่วนกลางทำเอง
 *
 * ออกบิลร้านแล้วไม่มีค่าคอมเกิดเองอีกต่อไป (เจ้าของระบบ: แต่ละรอบจ่ายค่าคอมไม่เหมือนกัน)
 * ส่วนกลางเปิด "ทำบิลค่าคอม" แล้วติ๊กเลือกเองว่าจะให้เซลได้จากสินค้าบรรทัดไหนของบิลร้านที่ออกไปแล้ว
 * (เฉพาะสินค้าที่เซลคนนั้นถือดีล) + เหมาต่อรอบ + ค่าคอมอื่น ๆ — ไม่ต้องรอร้านจ่ายก่อน
 * แถว DEAL/MANUAL แบบเก่ายังอ่าน จ่าย และยกเลิกได้ตามเดิม
 */
final class SalesAgentService
{
    private const OPEN_END = '9999-12-31';

    /* ── เซล ───────────────────────────────────────────────────── */

    /**
     * สร้างเซล — username ตัวเดียวทำหน้าที่ทั้ง "ตัวระบุเซล" และ "ชื่อผู้ใช้สำหรับเข้าระบบ" (เหมือนร้านค้า)
     */
    public static function create(array $input, int $actorUserId): array
    {
        $username = trim($input['username']);
        if (Db::one('SELECT 1 FROM sales_agents WHERE LOWER(username) = LOWER(?)', [$username])) {
            throw ApiException::conflict("username \"{$username}\" ถูกใช้ไปแล้ว");
        }

        return Db::tx(static function () use ($input, $username, $actorUserId) {
            // เซลไม่มีตัวเลขคอมติดตัว — เงินทุกบาทมาจากบิลค่าคอม (ดีลที่ผูกกับสินค้า หรือค่าคอมอื่น ๆ)
            $agentId = Db::insert(
                'INSERT INTO sales_agents (username, name, phone, email, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
                [$username, $input['name'], $input['phone'] ?? null, $input['email'] ?? null, $input['note'] ?? null],
            );
            // ยูสเซอร์สำหรับให้เซลเข้าดูคอมของตัวเอง — ใช้ username เดียวกับตัวระบุเซล
            $user = UserService::create([
                'username'     => $username,
                'password'     => $input['password'],
                'displayName'  => $input['name'],
                'role'         => 'SALES',
                'salesAgentId' => $agentId,
            ]);
            Audit::write($actorUserId, 'agent.create', 'sales_agent', $agentId, ['username' => $username]);

            return ['agent' => self::get($agentId), 'user' => UserService::serialize($user)];
        });
    }

    /*
     * "ถือดีลอยู่" = เริ่มแล้ว และยังไม่ปิด (ปิดวันไหน วันนั้นก็ไม่นับแล้ว)
     * ปิดดีลเป็นคลิกเดียวไม่มีวันที่ (ปิด = วันนี้) — ถ้านับวันปิดรวมด้วย ดีลที่เพิ่งกดปิดจะยังขึ้นว่าถืออยู่จนถึงพรุ่งนี้
     */
    private static function selectAgent(): string
    {
        return "
            SELECT a.*,
                   (SELECT COUNT(*) FROM product_sales_links l
                     WHERE l.sales_agent_id = a.id
                       AND l.start_date <= ?
                       AND (l.end_date IS NULL OR l.end_date > ?))                      AS active_product_count,
                   (SELECT COUNT(*) FROM users u WHERE u.sales_agent_id = a.id)          AS user_count,
                   (SELECT COALESCE(SUM(c.total_satang), 0) FROM sales_commissions c
                     WHERE c.sales_agent_id = a.id AND c.status = 'PENDING')             AS pending_satang,
                   (SELECT COALESCE(SUM(c.total_satang), 0) FROM sales_commissions c
                     WHERE c.sales_agent_id = a.id AND c.status = 'PAID')                AS paid_satang
              FROM sales_agents a";
    }

    /**
     * จำนวนบรรทัดบิลร้านที่ยังทำบิลค่าคอมให้เซลได้ (นับแบบเดียวกับ commissionCandidates — เงื่อนไขแถวเก่าต้องตรงกับ eligibleRows) — คิวรีเดียวทั้งหน้า
     *
     * @return array<int, int> agentId → จำนวน
     */
    private static function uncommissionedCounts(?int $agentId = null): array
    {
        $rows = Db::all(
            "SELECT l.sales_agent_id, COUNT(DISTINCT se.id) AS n
               FROM product_sales_links l
               JOIN sales_entries se ON se.product_id = l.product_id
               JOIN invoices i       ON i.id = se.invoice_id AND i.status <> 'VOID'
              WHERE (? IS NULL OR l.sales_agent_id = ?)
                AND NOT EXISTS (SELECT 1 FROM sales_commission_lines x WHERE x.active_entry_id = se.id)
                AND NOT EXISTS (SELECT 1 FROM sales_commissions d
                                 WHERE d.kind = 'DEAL' AND d.franchise_id = i.franchise_id AND d.period_id = i.period_id
                                   AND d.sales_agent_id = l.sales_agent_id AND d.status <> 'VOID')
              GROUP BY l.sales_agent_id",
            [$agentId, $agentId],
        );

        return array_map('intval', array_column($rows, 'n', 'sales_agent_id'));
    }

    public static function get(int $id): array
    {
        $today = Period::today();
        $row   = Db::one(self::selectAgent() . ' WHERE a.id = ?', [$today, $today, $id]) ?? throw ApiException::notFound('ไม่พบเซล');

        return self::serializeAgent([...$row, 'uncommissioned_count' => self::uncommissionedCounts($id)[$id] ?? 0]);
    }

    public static function list(?string $status = null, ?string $q = null): array
    {
        $today  = Period::today();
        $where  = [];
        $params = [$today, $today];
        if ($status) {
            $where[]  = 'a.status = ?';
            $params[] = $status;
        }
        if ($q) {
            $where[] = '(a.username LIKE ? OR a.name LIKE ?)';
            array_push($params, "%{$q}%", "%{$q}%");
        }
        $counts = self::uncommissionedCounts();

        return array_map(static fn ($r) => self::serializeAgent([...$r, 'uncommissioned_count' => $counts[(int) $r['id']] ?? 0]), Db::all(
            self::selectAgent() . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY a.username',
            $params,
        ));
    }

    private const AGENT_FIELDS = ['name' => 'name', 'phone' => 'phone', 'email' => 'email', 'note' => 'note', 'status' => 'status'];

    public static function update(int $id, array $patch, int $actorUserId): array
    {
        self::get($id);
        $sets   = [];
        $params = [];
        foreach (self::AGENT_FIELDS as $key => $column) {
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
        Db::exec('UPDATE sales_agents SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
        Audit::write($actorUserId, 'agent.update', 'sales_agent', $id, $patch);

        return self::get($id);
    }

    /**
     * ตั้งรหัสผ่านใหม่ให้ยูสเซอร์ของเซล (super) — หน้าเว็บสุ่มรหัสให้แล้วคัดลอกทั้งชุดส่งเซล
     * รหัสเดิมดูย้อนหลังไม่ได้ (เก็บเป็น bcrypt) ทางเดียวที่จะส่งชุดเข้าระบบที่มีรหัสได้คือตั้งใหม่
     * $mustChange = ให้เซลเปลี่ยนเองตอนเข้าครั้งแรก — รหัสที่ส่งผ่านแชตไม่ควรใช้ยาว
     * setPassword เพิ่ม token_version ให้เอง → เครื่องที่ล็อกอินค้างไว้ด้วยรหัสเก่าหลุดหมด
     */
    public static function resetUserPassword(int $agentId, int $userId, string $newPassword, bool $mustChange, int $actorUserId): array
    {
        $agent = Db::one('SELECT id, username FROM sales_agents WHERE id = ?', [$agentId]) ?? throw ApiException::notFound('ไม่พบเซล');
        // ยูสเซอร์ต้องเป็นของเซลคนนี้จริง — ไม่งั้นแค่เปลี่ยน id ใน URL ก็ตั้งรหัสให้ใครก็ได้ (รวมแอดมิน/ร้าน)
        $target = Db::one("SELECT id, username FROM users WHERE id = ? AND sales_agent_id = ? AND role = 'SALES'", [$userId, $agentId])
            ?? throw ApiException::notFound("ไม่พบผู้ใช้นี้ในเซล {$agent['username']}");

        Db::tx(static function () use ($userId, $newPassword, $mustChange, $actorUserId, $agentId, $target) {
            UserService::setPassword($userId, $newPassword, $mustChange);
            Audit::write($actorUserId, 'agent.reset_password', 'sales_agent', $agentId, [
                'userId'     => $userId,
                'username'   => $target['username'],
                'mustChange' => $mustChange,
            ]);
        });

        return ['ok' => true, 'user' => UserService::serialize(UserService::getById($userId))];
    }

    public static function serializeAgent(array $row): array
    {
        return [
            'id'                 => (int) $row['id'],
            'username'           => $row['username'],
            'name'               => $row['name'],
            'phone'              => $row['phone'],
            'email'              => $row['email'],
            'note'               => $row['note'],
            'status'             => $row['status'],
            'activeProductCount' => (int) $row['active_product_count'],
            'userCount'          => (int) $row['user_count'],
            'pendingCommission'  => Money::toBaht($row['pending_satang'] ?? 0),
            'paidCommission'     => Money::toBaht($row['paid_satang'] ?? 0),
            // บรรทัดบิลร้านที่ยังไม่ได้ทำบิลค่าคอมให้เซลคนนี้ — หน้ารายการเซลเตือนได้ว่า "ยังค้างทำบิลค่าคอม"
            'uncommissionedCount' => (int) ($row['uncommissioned_count'] ?? 0),
            'createdAt'           => $row['created_at'],
        ];
    }

    /* ── ดีล: เซลคนไหนถือสินค้าไหน ─────────────────────── */

    private static function overlappingLinks(int $productId, string $start, ?string $end, ?int $excludeId = null): array
    {
        return Db::all(
            'SELECT l.*, a.username AS agent_username, a.name AS agent_name
               FROM product_sales_links l
               JOIN sales_agents a ON a.id = l.sales_agent_id
              WHERE l.product_id = ?
                AND l.start_date <= ?
                AND COALESCE(l.end_date, ?) >= ?
                AND (? IS NULL OR l.id <> ?)
              ORDER BY l.start_date',
            [$productId, $end ?? self::OPEN_END, self::OPEN_END, $start, $excludeId, $excludeId],
        );
    }

    /** ดีลของสินค้าชิ้นนี้ที่ยังถืออยู่หลังวันนี้ (ยังไม่ปิด หรือปิดวันหลัง) — ดีลใหม่แบบไม่ระบุวันที่ชนกับพวกนี้เท่านั้น */
    private static function stillHeldLinks(int $productId): array
    {
        return Db::all(
            'SELECT l.*, a.username AS agent_username, a.name AS agent_name
               FROM product_sales_links l
               JOIN sales_agents a ON a.id = l.sales_agent_id
              WHERE l.product_id = ? AND (l.end_date IS NULL OR l.end_date > ?)
              ORDER BY l.start_date, l.id',
            [$productId, Period::today()],
        );
    }

    /** เหมาต่อรอบที่พิมพ์มา — ต้องไม่ติดลบ และกันเลขใหญ่ผิดปกติก่อนแปลงเป็นสตางค์ */
    private static function fixedSatang(mixed $amount, string $field): int
    {
        $satang = self::typedSatang($amount, $field);
        if ($satang < 0) {
            throw ApiException::badRequest("{$field}: เหมาต่อรอบต้องไม่ติดลบ");
        }

        return $satang;
    }

    /**
     * ผูกดีลสินค้าให้เซล — 1 สินค้ามีเซลถือดีลได้คนเดียว
     *
     * ไม่ต้องเลือกวันที่แล้ว (หน้าเว็บไม่มีช่องวันที่): เริ่มวันนี้ ไม่มีวันสิ้นสุดจนกว่าจะกด "ปิดดีล"
     * วันที่ของดีลไม่มีผลกับเงินอีกต่อไป — บิลค่าคอมเลือกรายการเอง จึงเช็กแค่ว่ามีคนถือสินค้านี้อยู่หรือเปล่า
     * (ยังรับวันที่ทาง API ได้เหมือนเดิม และตรวจช่วงวันทับกันแบบเดิมเมื่อส่งวันที่มา)
     * % คิดจากยอดขายเต็มเสมอ (basis GROSS) — เจ้าของระบบให้ตัดตัวเลือก "คิดจากส่วนต่าง" ทิ้ง
     */
    public static function linkProduct(array $input, ?int $actorUserId): array
    {
        $agent = Db::one('SELECT * FROM sales_agents WHERE id = ?', [(int) $input['salesAgentId']]) ?? throw ApiException::notFound('ไม่พบเซล');
        if ($agent['status'] !== 'ACTIVE') {
            throw ApiException::badRequest("เซล {$agent['username']} ไม่อยู่ในสถานะใช้งาน");
        }
        $product = Db::one('SELECT * FROM products WHERE id = ?', [(int) $input['productId']]) ?? throw ApiException::notFound('ไม่พบสินค้า');
        // สินค้าที่ปิดใช้งาน/ลบแล้วบันทึกยอดใหม่ไม่ได้ — ผูกดีลใหม่ไว้ก็ไม่มีวันได้คอม คนตั้งจะเข้าใจผิดว่าเซลได้ดีลแล้ว
        ProductService::assertActive($product, 'ผูกดีล');
        $dated = ! empty($input['startDate']) || ! empty($input['endDate']);
        if ($dated) {
            $startDate = Period::assertDate($input['startDate'] ?? Period::today(), 'startDate');
            $endDate   = ! empty($input['endDate']) ? Period::assertDate($input['endDate'], 'endDate') : null;
            if ($endDate !== null && $endDate < $startDate) {
                throw ApiException::badRequest('endDate ต้องไม่น้อยกว่า startDate');
            }
            $clash = self::overlappingLinks((int) $product['id'], $startDate, $endDate);
            if ($clash !== []) {
                throw ApiException::conflict(
                    "สินค้า {$product['sku']} มีเซล {$clash[0]['agent_username']} ถือดีลอยู่แล้วในช่วงวันที่ที่ทับกัน",
                    array_map(static fn ($l) => ['linkId' => (int) $l['id'], 'agentUsername' => $l['agent_username'], 'startDate' => $l['start_date'], 'endDate' => $l['end_date']], $clash),
                );
            }
        } else {
            $startDate = Period::today();
            $endDate   = null;
            // ดีลที่เพิ่งกดปิดวันนี้ไม่นับ — ปิดของเซลคนเก่าแล้วให้คนใหม่ได้ในวันเดียวกัน
            $clash = self::stillHeldLinks((int) $product['id']);
            if ($clash !== []) {
                throw ApiException::conflict(
                    "สินค้า {$product['sku']} มีเซล {$clash[0]['agent_username']} ถือดีลอยู่ — ปิดดีลเดิมก่อน",
                    array_map(static fn ($l) => ['linkId' => (int) $l['id'], 'agentUsername' => $l['agent_username'], 'startDate' => $l['start_date'], 'endDate' => $l['end_date']], $clash),
                );
            }
        }
        // ตัวเลขต้องมาจากตรงนี้เท่านั้น — เซลไม่มีค่าตั้งต้นให้หยิบมาใช้แล้ว
        $pctBp = ($input['commissionPct'] ?? null) === null ? null : Money::pctToBp($input['commissionPct'], 'commissionPct');
        $fixed = ($input['fixedAmount'] ?? null) === null ? null : self::fixedSatang($input['fixedAmount'], 'fixedAmount');
        if ($pctBp === null && $fixed === null) {
            throw ApiException::badRequest("ดีลของ {$product['sku']}: ต้องกรอกอย่างน้อยหนึ่งอย่าง — % ของยอดขายเต็ม หรือเหมาต่อรอบ");
        }
        try {
            $id = Db::insert(
                "INSERT INTO product_sales_links
                   (product_id, sales_agent_id, basis, commission_pct_bp, fixed_satang, start_date, end_date, note, created_by_user_id, created_at, updated_at)
                 VALUES (?, ?, 'GROSS', ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
                [$product['id'], $agent['id'], $pctBp, $fixed, $startDate, $endDate, $input['note'] ?? null, $actorUserId],
            );
        } catch (Throwable $e) {
            // สองจอกดผูกสินค้าชิ้นเดียวกันพร้อมกัน — uq_prod_link_open_ended ในฐานข้อมูลกันไว้ ตอบเป็นข้อความที่อ่านรู้เรื่อง
            if (self::isDuplicateKey($e)) {
                throw ApiException::conflict("สินค้า {$product['sku']} มีเซลถือดีลอยู่ — ปิดดีลเดิมก่อน");
            }

            throw $e;
        }
        Audit::write($actorUserId, 'sales_link.create', 'sales_link', $id, ['productId' => (int) $product['id'], 'agentId' => (int) $agent['id']]);

        return self::getLink($id);
    }

    /**
     * ผูกดีลหลายสินค้าให้เซลคนเดียวในครั้งเดียว — ทรานแซกชันเดียว:
     * ถ้ามีสักชิ้นชนดีลเดิมอยู่ ต้องไม่บันทึกอะไรเลย (ไม่งั้นผู้ใช้ต้องมาไล่ว่าอันไหนเข้าไปแล้วบ้าง)
     */
    public static function linkProducts(array $input, int $actorUserId): array
    {
        $items = $input['items'] ?? [];
        if ($items === []) {
            throw ApiException::badRequest('ยังไม่ได้เลือกสินค้า — เลือกสินค้าอย่างน้อยหนึ่งรายการ');
        }
        $seen = [];
        foreach ($items as $item) {
            $key = (int) $item['productId'];
            if (isset($seen[$key])) {
                throw ApiException::badRequest('เลือกสินค้าซ้ำกันในรายการเดียว');
            }
            $seen[$key] = true;
        }
        $common = array_intersect_key($input, array_flip(['salesAgentId', 'startDate', 'endDate', 'note']));

        return Db::tx(static fn () => array_map(static fn ($item) => self::linkProduct([...$common, ...$item], $actorUserId), $items));
    }

    private const SELECT_LINK = '
        SELECT l.*, a.username AS agent_username, a.name AS agent_name,
               p.sku, p.name AS product_name,
               f.username AS franchise_username
          FROM product_sales_links l
          JOIN sales_agents a ON a.id = l.sales_agent_id
          JOIN products p     ON p.id = l.product_id
          LEFT JOIN product_assignments pa
                 ON pa.product_id = p.id AND pa.end_date IS NULL
          LEFT JOIN franchises f ON f.id = pa.franchise_id';

    public static function getLink(int $id): array
    {
        return self::serializeLink(Db::one(self::SELECT_LINK . ' WHERE l.id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบดีลของเซล'));
    }

    public static function listLinks(mixed $salesAgentId = null, mixed $productId = null, mixed $franchiseId = null, ?string $activeOn = null): array
    {
        $where  = [];
        $params = [];
        if ($salesAgentId) {
            $where[]  = 'l.sales_agent_id = ?';
            $params[] = (int) $salesAgentId;
        }
        if ($productId) {
            $where[]  = 'l.product_id = ?';
            $params[] = (int) $productId;
        }
        // กรองตามร้าน = ดีลของสินค้าที่ร้านนั้นถือสิทธิ์ขายอยู่ตอนนี้
        if ($franchiseId) {
            $where[]  = 'pa.franchise_id = ?';
            $params[] = (int) $franchiseId;
        }
        // กติกาเดียวกับ isActive — ดีลที่ปิดวันนั้นไม่นับว่ายังถืออยู่ในวันนั้น
        if ($activeOn) {
            $date    = Period::assertDate($activeOn, 'activeOn');
            $where[] = 'l.start_date <= ? AND (l.end_date IS NULL OR l.end_date > ?)';
            array_push($params, $date, $date);
        }

        return array_map([self::class, 'serializeLink'], Db::all(
            self::SELECT_LINK . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY l.start_date DESC, l.id DESC',
            $params,
        ));
    }

    /**
     * แก้ดีล — หน้าเว็บแก้ได้แค่ % / เหมาต่อรอบ / หมายเหตุ (วันที่ยังรับทาง API)
     * ตรวจช่วงวันทับกันเฉพาะตอนวันที่เปลี่ยนจริง: ดีลที่ปิดของคนเก่าแล้วให้คนใหม่ในวันเดียวกัน
     * วันที่ทับกันหนึ่งวันโดยตั้งใจ — ถ้าตรวจทุกครั้ง จะแก้ % ของดีลใหม่ไม่ได้เลย
     */
    public static function updateLink(int $id, array $patch, int $actorUserId): array
    {
        $row       = Db::one('SELECT * FROM product_sales_links WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบดีลของเซล');
        $startDate = ! empty($patch['startDate']) ? Period::assertDate($patch['startDate'], 'startDate') : $row['start_date'];
        $endDate   = ! array_key_exists('endDate', $patch)
            ? $row['end_date']
            : ($patch['endDate'] === null ? null : Period::assertDate($patch['endDate'], 'endDate'));
        if ($endDate !== null && $endDate < $startDate) {
            throw ApiException::badRequest('endDate ต้องไม่น้อยกว่า startDate');
        }
        if ($startDate !== $row['start_date'] || $endDate !== $row['end_date']) {
            // สินค้าที่ลบแล้ว: ดีลถูกปิดตอนลบ — แก้ % / เหมา / หมายเหตุได้ (ค่าตั้งต้นของรายการที่ยังติ๊กทำบิลค่าคอมได้) แต่ขยับวันที่ = เปิดดีลให้ของที่ไม่มีอยู่แล้ว
            self::assertProductNotDeleted((int) $row['product_id'], 'เปลี่ยนวันที่ของดีล');
            $clash = self::overlappingLinks((int) $row['product_id'], $startDate, $endDate, $id);
            if ($clash !== []) {
                throw ApiException::conflict(
                    'ช่วงวันที่ใหม่ทับกับดีลเซลรายอื่นของสินค้าชิ้นนี้',
                    array_map(static fn ($l) => ['linkId' => (int) $l['id'], 'agentUsername' => $l['agent_username'], 'startDate' => $l['start_date'], 'endDate' => $l['end_date']], $clash),
                );
            }
        }
        $pctBp = ! array_key_exists('commissionPct', $patch)
            ? $row['commission_pct_bp']
            : ($patch['commissionPct'] === null ? null : Money::pctToBp($patch['commissionPct'], 'commissionPct'));
        $fixed = ! array_key_exists('fixedAmount', $patch)
            ? $row['fixed_satang']
            : ($patch['fixedAmount'] === null ? null : self::fixedSatang($patch['fixedAmount'], 'fixedAmount'));
        if ($pctBp === null && $fixed === null) {
            throw ApiException::badRequest('ต้องเหลืออย่างน้อยหนึ่งอย่าง: % ของยอดขายเต็ม หรือเหมาต่อรอบ');
        }
        // basis บังคับ GROSS ทุกครั้งที่แตะ — ดีลเก่าที่ยังเป็น COMMISSION (ถ้ามี) ถูกปรับตามกติกาใหม่ไปด้วย
        Db::exec(
            "UPDATE product_sales_links
                SET basis = 'GROSS', commission_pct_bp = ?, fixed_satang = ?, start_date = ?, end_date = ?,
                    note = ?, updated_at = UTC_TIMESTAMP()
              WHERE id = ?",
            [$pctBp, $fixed, $startDate, $endDate, array_key_exists('note', $patch) ? $patch['note'] : $row['note'], $id],
        );
        Audit::write($actorUserId, 'sales_link.update', 'sales_link', $id, $patch);

        return self::getLink($id);
    }

    /**
     * ปิดดีล — หน้าเว็บกดปุ่มเดียว ไม่ต้องเลือกวันที่ (ปิด = วันนี้) · ส่ง endDate มาทาง API ได้
     * ปิดไปแล้วกดซ้ำ = ไม่ทำอะไร (สองจอกดพร้อมกันไม่ควรได้ error)
     * รายการจากบิลร้านที่ออกไปแล้วของสินค้านี้ยังทำบิลค่าคอมให้เซลคนนี้ได้ (ดีลปิดแล้วไม่ได้แปลว่าไม่จ่ายของเก่า)
     */
    public static function endLink(int $id, ?string $endDate, int $actorUserId): array
    {
        $row   = Db::one('SELECT * FROM product_sales_links WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบดีลของเซล');
        $today = Period::today();
        if ($endDate === null && $row['end_date'] !== null && $row['end_date'] <= $today) {
            return self::getLink($id);
        }
        /*
         * กดปิดดีลที่ยังไม่ถึงวันเริ่ม (ดีลจากหน้าเว็บรุ่นก่อนที่มีช่องวันเริ่ม หรือส่งวันที่มาทาง API)
         * = ยกเลิกดีลที่ยังไม่เคยเริ่ม — หน้าเว็บไม่มีช่องวันที่แล้ว ถ้าตอบ "วันปิดต้องไม่ก่อนวันเริ่ม" ปุ่มจะกดไม่ได้เลย
         * และสินค้าชิ้นนี้ถูกกันไม่ให้ผูกกับเซลคนอื่นจนกว่าจะถึงวันเริ่ม
         * ตั้งทั้งวันเริ่มและวันปิดเป็นวันนี้: ผ่าน ck_link_range และทุกที่นับว่าปิดแล้ววันนี้ (stillHeldLinks / isActive / หน้าเว็บ)
         * ให้เซลคนใหม่รับสินค้านี้ได้ในวันเดียวกัน · วันเริ่มเดิมจดไว้ในประวัติ
         */
        if ($endDate === null && $row['start_date'] > $today) {
            Db::exec('UPDATE product_sales_links SET start_date = ?, end_date = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [$today, $today, $id]);
            Audit::write($actorUserId, 'sales_link.end', 'sales_link', $id, ['endDate' => $today, 'cancelledBeforeStart' => $row['start_date']]);

            return self::getLink($id);
        }
        // ดีลของสินค้าที่ลบแล้วถูกปิดไปตอนลบ (กดปิดซ้ำแบบไม่ระบุวันจบที่บรรทัดบน) — ย้ายวันปิดทีหลังไม่ได้
        self::assertProductNotDeleted((int) $row['product_id'], 'เปลี่ยนวันปิดดีล');
        $date = Period::assertDate($endDate ?? $today, 'endDate');
        if ($date < $row['start_date']) {
            throw ApiException::badRequest('ดีลนี้เริ่มวันที่ ' . Period::thDate($row['start_date']) . ' — วันปิดดีลต้องไม่ก่อนวันเริ่ม');
        }
        Db::exec('UPDATE product_sales_links SET end_date = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [$date, $id]);
        Audit::write($actorUserId, 'sales_link.end', 'sales_link', $id, ['endDate' => $date]);

        return self::getLink($id);
    }

    private static function assertProductNotDeleted(int $productId, string $action): void
    {
        $p = Db::one('SELECT sku, status FROM products WHERE id = ?', [$productId]);
        if (($p['status'] ?? null) === 'DELETED') {
            throw ApiException::conflict("สินค้า {$p['sku']} ถูกลบแล้ว — {$action}ไม่ได้ (ดีลถูกปิดตอนลบสินค้า)");
        }
    }

    public static function serializeLink(array $row): array
    {
        $today = Period::today();

        return [
            'id'                => (int) $row['id'],
            'productId'         => (int) $row['product_id'],
            'sku'               => $row['sku'],
            'productName'       => $row['product_name'],
            'franchiseUsername' => $row['franchise_username'],
            'salesAgentId'      => (int) $row['sales_agent_id'],
            'agentUsername'     => $row['agent_username'],
            'agentName'         => $row['agent_name'],
            'basis'             => $row['basis'],
            'basisLabel'        => self::basisLabel($row['basis']),
            'commissionPct'     => $row['commission_pct_bp'] === null ? null : Money::bpToPct($row['commission_pct_bp']),
            'fixedAmount'       => $row['fixed_satang'] === null ? null : Money::toBaht($row['fixed_satang']),
            'startDate'         => $row['start_date'],
            'endDate'           => $row['end_date'],
            // ถืออยู่วันนี้ (ปิดวันนี้ = ไม่ถือแล้ว) · isOpen = ยังไม่เคยกดปิด
            'isActive'  => $row['start_date'] <= $today && ($row['end_date'] === null || $row['end_date'] > $today),
            'isOpen'    => $row['end_date'] === null,
            'note'      => $row['note'],
            'createdAt' => $row['created_at'],
        ];
    }

    /* ── บิลค่าคอม ───────────────────────────────────────────────── */

    /** วิธีคิดของรายการสินค้าในบิลค่าคอม */
    public const ITEM_MODE_LABEL = ['PCT' => '% ของยอดเต็ม', 'MANUAL' => 'กรอกเอง'];

    /** พิมพ์ยอดเองได้ไม่เกินนี้ (บาท) — ตัวเลขยาวเกินทำให้แปลงเป็นสตางค์แล้วล้น (500) แทนที่จะได้ข้อความบอกว่าผิด */
    private const MAX_TYPED_BAHT = 100_000_000;

    /** แถวเก่า (DEAL) ยังมี COMMISSION/MIXED/MANUAL ได้ — ต้องอ่านออกต่อไป */
    private static function basisLabel(?string $basis): string
    {
        return match ($basis) {
            'GROSS'        => 'ยอดขายเต็ม',
            'BILL'         => 'บิลค่าคอม — ดูรายการ',
            'MIXED'        => 'หลายแบบ — ดูรายสินค้า',
            'MANUAL', null => 'กรอกเอง',
            default        => 'ส่วนต่างที่ร้านค้าจ่าย',
        };
    }

    /** แปลงยอดที่คนพิมพ์เป็นสตางค์ — กันเลขใหญ่ผิดปกติก่อน (Money::toSatang ไม่มีเพดาน) */
    private static function typedSatang(mixed $amount, string $field): int
    {
        $raw = is_string($amount) ? str_replace([',', ' '], '', trim($amount)) : $amount;
        if ((is_int($raw) || is_float($raw) || (is_string($raw) && is_numeric($raw))) && abs((float) $raw) > self::MAX_TYPED_BAHT) {
            throw ApiException::badRequest("{$field}: จำนวนเงินเกินกำหนด — กรอกได้ไม่เกิน 100,000,000 บาท");
        }

        return Money::toSatang($amount, $field);
    }

    private static function isDuplicateKey(Throwable $e): bool
    {
        for ($x = $e; $x !== null; $x = $x->getPrevious()) {
            if ((int) $x->getCode() === 1062) {
                return true;
            }
        }

        return false;
    }

    /** คีย์ "เหมาต่อรอบ" — ครั้งเดียวต่อ เซล × ร้าน × รอบ (unique ในฐานข้อมูลผ่าน active_fixed_key) */
    private static function fixedKey(int $agentId, int $franchiseId, int $periodId): string
    {
        return "{$agentId}:{$franchiseId}:{$periodId}";
    }

    /**
     * บรรทัดบิลร้านที่เซลคนนี้ "มีสิทธิ์" ได้ค่าคอม — สินค้าที่เซลเคยถือดีล (เปิดอยู่หรือปิดแล้วก็ได้) บนบิลร้านที่ยังไม่ยกเลิก
     * ไม่สนวันที่ของดีล: ส่วนกลางเป็นคนตัดสินเองตอนติ๊ก (เจ้าของระบบ: แต่ละรอบจ่ายไม่เหมือนกัน)
     * ไม่รอร้านจ่ายก่อน · ร้าน×รอบที่มีแถวค่าคอมแบบเก่า (DEAL) ของเซลคนนี้แล้ว = จ่ายไปแล้วในระบบเดิม ตัดทิ้ง
     *   จับคู่ด้วย (ร้าน, รอบ) ไม่ใช่ id บิลร้าน — ยกเลิกบิลร้านแล้วออกใบใหม่ได้ id ใหม่แต่รายการชุดเดิม
     *   (แถวเก่าที่จ่ายแล้วยังชี้บิลใบที่ยกเลิก) ถ้าจับด้วย id รายการที่จ่ายไปแล้วจะกลับมาให้ติ๊กจ่ายซ้ำ
     *   หนึ่งร้านหนึ่งรอบมีบิลที่ยังไม่ยกเลิกได้ใบเดียว และเหมาต่อรอบก็ตัดด้วยคู่นี้อยู่แล้ว (candidateSets)
     * live_agent_id = เซลของบิลค่าคอมที่ถือบรรทัดนี้อยู่ (NULL = ยังว่าง)
     */
    private static function eligibleRows(int $agentId): array
    {
        return Db::all(
            "SELECT se.id AS entry_id, se.product_id, se.gross_amount_satang, se.components_snapshot,
                    i.id AS invoice_id, i.invoice_no, i.status AS invoice_status, i.franchise_id, i.period_id,
                    f.username AS franchise_username, bp.code AS period_code, bp.start_date AS period_start,
                    p.sku, p.name AS product_name,
                    scl.id AS live_line_id, sc.sales_agent_id AS live_agent_id
               FROM sales_entries se
               JOIN invoices i         ON i.id = se.invoice_id AND i.status <> 'VOID'
               JOIN franchises f       ON f.id = i.franchise_id
               JOIN billing_periods bp ON bp.id = i.period_id
               JOIN products p         ON p.id = se.product_id
               LEFT JOIN sales_commission_lines scl ON scl.active_entry_id = se.id
               LEFT JOIN sales_commissions sc       ON sc.id = scl.commission_id
              WHERE EXISTS (SELECT 1 FROM product_sales_links l WHERE l.product_id = se.product_id AND l.sales_agent_id = ?)
                AND NOT EXISTS (SELECT 1 FROM sales_commissions d
                                 WHERE d.kind = 'DEAL' AND d.franchise_id = i.franchise_id AND d.period_id = i.period_id
                                   AND d.sales_agent_id = ? AND d.status <> 'VOID')
              ORDER BY bp.start_date DESC, i.invoice_no, p.sku, se.id",
            [$agentId, $agentId],
        );
    }

    /**
     * ดีลล่าสุดของเซลคนนี้ต่อสินค้า — ใช้เป็นค่าตั้งต้น (% / เหมา) ตอนติ๊ก
     *
     * @return array<int, array> productId → แถว product_sales_links
     */
    private static function latestDeals(int $agentId): array
    {
        $out = [];
        foreach (Db::all('SELECT * FROM product_sales_links WHERE sales_agent_id = ? ORDER BY product_id, start_date DESC, id DESC', [$agentId]) as $l) {
            $out[(int) $l['product_id']] ??= $l;
        }

        return $out;
    }

    /**
     * รายการที่ติ๊กทำบิลค่าคอมได้ตอนนี้ — ใช้ทั้งหน้าจอ (commissionCandidates) และตอนบันทึก (ต้องตรวจชุดเดียวกัน)
     *
     * items: บรรทัดที่ยังไม่อยู่ในบิลค่าคอมใบไหน (ใบที่ยกเลิกแล้วไม่นับ)
     * fixed: เหมาต่อรอบต่อ (ร้าน, รอบ) = ค่าเหมาสูงสุดของดีลสินค้าในรอบนั้น — คิดจากบรรทัดที่ยังว่าง "หรือ" อยู่ในบิลของเซลคนนี้เอง
     *   (ทำบิลสินค้าไปก่อนแล้วค่อยจ่ายเหมาทีหลังได้ · บรรทัดที่ไปอยู่ในบิลของเซลคนอื่นแล้วไม่ทำให้เซลคนนี้ได้เหมา)
     *   ตัดคีย์ที่อยู่ในบิลค่าคอมแล้ว และ (ร้าน, รอบ) ที่มีแถวค่าคอมแบบเก่าของเซลคนนี้แล้ว (เดิมรวมเหมาไว้ในแถวนั้น)
     *
     * @return array{items: array<int, array>, fixed: array<string, array>}
     */
    private static function candidateSets(int $agentId): array
    {
        $deals = self::latestDeals($agentId);
        $rows  = self::eligibleRows($agentId);

        $items = [];
        foreach ($rows as $r) {
            if ($r['live_line_id'] === null) {
                $items[(int) $r['entry_id']] = [...$r, 'deal' => $deals[(int) $r['product_id']] ?? null];
            }
        }

        $liveKeys = array_flip(array_column(
            Db::all('SELECT active_fixed_key FROM sales_commission_lines WHERE active_fixed_key LIKE ?', ["{$agentId}:%"]),
            'active_fixed_key',
        ));
        $legacy = [];
        foreach (Db::all("SELECT DISTINCT franchise_id, period_id FROM sales_commissions WHERE kind = 'DEAL' AND sales_agent_id = ? AND status <> 'VOID'", [$agentId]) as $l) {
            $legacy[(int) $l['franchise_id'] . ':' . (int) $l['period_id']] = true;
        }

        $groups = [];
        foreach ($rows as $r) {
            if ($r['live_agent_id'] !== null && (int) $r['live_agent_id'] !== $agentId) {
                continue;
            }
            $deal = $deals[(int) $r['product_id']] ?? null;
            if ($deal === null || (int) ($deal['fixed_satang'] ?? 0) <= 0) {
                continue;
            }
            $key = self::fixedKey($agentId, (int) $r['franchise_id'], (int) $r['period_id']);
            if (isset($liveKeys[$key]) || isset($legacy[(int) $r['franchise_id'] . ':' . (int) $r['period_id']])) {
                continue;
            }
            $groups[$key] ??= ['row' => $r, 'deals' => []];
            $groups[$key]['deals'][(int) $deal['id']] = (int) $deal['fixed_satang'];
        }
        $fixed = [];
        foreach ($groups as $key => ['row' => $r, 'deals' => $byDeal]) {
            // ดีลที่ให้ยอดสูงสุดขึ้นก่อน — บรรทัดเหมาเก็บ link_id เป็นดีลตัวแรก
            uksort($byDeal, static fn ($a, $b) => [$byDeal[$b], $a] <=> [$byDeal[$a], $b]);
            $fixed[$key] = [
                'key'               => $key,
                'franchise_id'      => (int) $r['franchise_id'],
                'franchise_username' => $r['franchise_username'],
                'period_id'         => (int) $r['period_id'],
                'period_code'       => $r['period_code'],
                'invoice_id'        => (int) $r['invoice_id'],
                'invoice_no'        => $r['invoice_no'],
                'amount_satang'     => max($byDeal),
                'deal_ids'          => array_keys($byDeal),
            ];
        }

        return ['items' => $items, 'fixed' => $fixed];
    }

    private static function agentRow(int $agentId): array
    {
        return Db::one('SELECT id, username, name, status FROM sales_agents WHERE id = ?', [$agentId]) ?? throw ApiException::notFound('ไม่พบเซล');
    }

    /**
     * รายการที่ทำบิลค่าคอมให้เซลคนนี้ได้ — หน้าต่าง "ทำบิลค่าคอม" จัดกลุ่มตามบิลร้าน
     * ตัวเลขเป็นค่าตั้งต้นจากดีลล่าสุด ส่วนกลางแก้ได้ตอนติ๊ก (ระบบคิดจริงตอนบันทึก)
     */
    public static function commissionCandidates(int $agentId): array
    {
        $agent = self::agentRow($agentId);
        $sets  = self::candidateSets($agentId);

        return [
            'agent' => ['id' => (int) $agent['id'], 'username' => $agent['username'], 'name' => $agent['name']],
            'items' => array_values(array_map(static fn ($r) => [
                'entryId'           => (int) $r['entry_id'],
                'invoiceId'         => (int) $r['invoice_id'],
                'invoiceNo'         => $r['invoice_no'],
                'invoiceStatus'     => $r['invoice_status'],
                'franchiseId'       => (int) $r['franchise_id'],
                'franchiseUsername' => $r['franchise_username'],
                'periodCode'        => $r['period_code'],
                'productId'         => (int) $r['product_id'],
                'sku'               => $r['sku'],
                'productName'       => $r['product_name'],
                ...self::groupFields($r['components_snapshot']),
                'grossAmount'       => Money::toBaht($r['gross_amount_satang']),
                'deal'              => $r['deal'] === null ? null : [
                    'id'          => (int) $r['deal']['id'],
                    'pct'         => $r['deal']['commission_pct_bp'] === null ? null : Money::bpToPct($r['deal']['commission_pct_bp']),
                    'fixedAmount' => $r['deal']['fixed_satang'] === null ? null : Money::toBaht($r['deal']['fixed_satang']),
                    'isOpen'      => $r['deal']['end_date'] === null,
                ],
            ], $sets['items'])),
            'fixed' => array_values(array_map(static fn ($f) => [
                'key'               => $f['key'],
                'franchiseId'       => $f['franchise_id'],
                'franchiseUsername' => $f['franchise_username'],
                'periodCode'        => $f['period_code'],
                'invoiceId'         => $f['invoice_id'],
                'invoiceNo'         => $f['invoice_no'],
                'amount'            => Money::toBaht($f['amount_satang']),
                'dealIds'           => $f['deal_ids'],
            ], $sets['fixed'])),
        ];
    }

    /**
     * สินค้ากลุ่ม: บรรทัดที่ติ๊กได้เป็นบรรทัดของบิลร้านที่ออกแล้ว — ใช้รายการย่อยที่จดไว้ตอนขึ้นบิล (ไม่ต้องคิวรีเพิ่ม)
     * กลุ่มยังเป็นหนึ่งรายการ คิดค่าคอมจากยอดขายเต็มของทั้งกลุ่มเหมือนสินค้าอื่น — รายการย่อยแค่โชว์ให้รู้ว่าในชุดมีอะไร
     */
    private static function groupFields(?string $snapshot): array
    {
        $components = SalesService::billedComponents($snapshot);

        return ['isGroup' => $components !== null, 'components' => $components ?? []];
    }

    /**
     * ทำบิลค่าคอมให้เซล — ส่วนกลางติ๊กรายการเอง (ITEM) + เหมาต่อรอบ (FIXED) + ค่าคอมอื่น ๆ (OTHER) รวมเป็นบิลเดียว
     *
     * ตรวจทุกบรรทัดให้ครบก่อนเขียน ผิดบรรทัดเดียวไม่มีอะไรถูกบันทึก
     * ITEM ต้องอยู่ในรายการที่ติ๊กได้ตอนนี้จริง (สินค้าที่เซลคนนี้ถือดีล · บิลร้านไม่ถูกยกเลิก · ยังไม่อยู่ในบิลค่าคอมใบอื่น)
     * กันจ่ายซ้ำสองชั้น: ตรวจกับรายการที่ติ๊กได้ + UNIQUE active_entry_id/active_fixed_key ในฐานข้อมูล (สองจอกดพร้อมกัน)
     */
    public static function createCommissionBill(int $agentId, array $input, array $user): array
    {
        $agent  = self::agentRow($agentId);
        $items  = $input['items'] ?? [];
        $fixeds = $input['fixed'] ?? [];
        $others = $input['others'] ?? [];
        if ($items === [] && $fixeds === [] && $others === []) {
            throw ApiException::badRequest('เลือกอย่างน้อยหนึ่งรายการ หรือใส่ค่าคอมอื่น ๆ');
        }
        $sets  = self::candidateSets($agentId);
        $lines = [];

        $seen = [];
        foreach ($items as $it) {
            $entryId = (int) $it['entryId'];
            if (isset($seen[$entryId])) {
                throw ApiException::badRequest("รายการ id {$entryId} ถูกเลือกซ้ำ — แต่ละรายการเลือกได้ครั้งเดียว");
            }
            $seen[$entryId] = true;
            $c = $sets['items'][$entryId] ?? throw ApiException::badRequest(
                "รายการ id {$entryId} ไม่อยู่ในรายการที่ทำบิลค่าคอมให้เซลคนนี้ได้ (อาจถูกทำบิลค่าคอมไปแล้ว หรือบิลร้านถูกยกเลิก) — โหลดรายการใหม่แล้วเลือกอีกครั้ง",
            );
            $what  = "สินค้า {$c['sku']} (บิล {$c['invoice_no']})";
            $gross = (int) $c['gross_amount_satang'];
            $mode  = $it['mode'];
            // ส่งทั้งสองช่องมา = ไม่รู้ว่าตั้งใจใช้ตัวไหน — ให้ส่งมาเฉพาะช่องของวิธีที่เลือก
            $hasPct    = array_key_exists('pct', $it) && $it['pct'] !== null;
            $hasAmount = array_key_exists('amount', $it) && $it['amount'] !== null;
            if ($mode === 'PCT') {
                if ($hasAmount) {
                    throw ApiException::badRequest("{$what}: เลือก \"% ของยอดเต็ม\" ไม่ต้องใส่จำนวนเงิน — ถ้าจะกำหนดยอดเองให้เลือก \"กรอกเอง\"");
                }
                if (! $hasPct) {
                    throw ApiException::badRequest("{$what}: เลือก \"% ของยอดเต็ม\" ต้องใส่ %");
                }
                $pctBp  = Money::pctToBp($it['pct'], "{$what} (%)");
                $amount = Money::commissionOf($gross, $pctBp);
            } elseif ($mode === 'MANUAL') {
                if ($hasPct) {
                    throw ApiException::badRequest("{$what}: เลือก \"กรอกเอง\" ไม่ต้องใส่ % — ใส่แค่จำนวนเงินค่าคอม");
                }
                if (! $hasAmount) {
                    throw ApiException::badRequest("{$what}: เลือก \"กรอกเอง\" ต้องใส่จำนวนเงินค่าคอม");
                }
                $pctBp  = null;
                $amount = self::typedSatang($it['amount'], "{$what} (ค่าคอม)");
                // ติดลบได้เฉพาะบรรทัดคืนสินค้า — พิมพ์ "-" หลงบนยอดขายปกติแล้วกลายเป็นหักเงินเซลไม่ได้ (หักคืนใช้ "ค่าคอมอื่น ๆ")
                if ($amount !== 0 && ($amount <=> 0) !== ($gross <=> 0)) {
                    throw ApiException::badRequest("{$what}: ค่าคอมที่กรอกเองต้องเป็น 0 หรือเครื่องหมายเดียวกับยอดขาย (ติดลบได้เฉพาะรายการคืนสินค้า — ถ้าจะหักคืน ใช้ค่าคอมอื่น ๆ)");
                }
            } else {
                throw ApiException::badRequest("{$what}: วิธีคิดต้องเป็น PCT (% ของยอดเต็ม) หรือ MANUAL (กรอกเอง)");
            }
            $lines[] = [
                'kind'               => 'ITEM',
                'sales_entry_id'     => $entryId,
                'invoice_id'         => (int) $c['invoice_id'],
                'franchise_id'       => (int) $c['franchise_id'],
                'period_id'          => (int) $c['period_id'],
                'product_id'         => (int) $c['product_id'],
                'link_id'            => $c['deal'] === null ? null : (int) $c['deal']['id'],
                'label'              => null,
                'mode'               => $mode,
                'base_amount_satang' => $gross,
                'pct_bp'             => $pctBp,
                'amount_satang'      => $amount,
                'active_entry_id'    => $entryId,
                'active_fixed_key'   => null,
            ];
        }

        $seen = [];
        foreach ($fixeds as $f) {
            $key = (string) $f['key'];
            if (isset($seen[$key])) {
                throw ApiException::badRequest('เหมาต่อรอบรายการเดียวกันถูกเลือกซ้ำ — เลือกได้ครั้งเดียว');
            }
            $seen[$key] = true;
            $c = $sets['fixed'][$key] ?? throw ApiException::badRequest(
                'เหมาต่อรอบที่เลือกไม่อยู่ในรายการที่ทำบิลค่าคอมให้เซลคนนี้ได้ (อาจจ่ายไปแล้ว หรือบิลร้านถูกยกเลิก) — โหลดรายการใหม่แล้วเลือกอีกครั้ง',
            );
            $what   = "เหมาต่อรอบ ร้าน {$c['franchise_username']} รอบ {$c['period_code']}";
            $amount = array_key_exists('amount', $f) && $f['amount'] !== null ? self::typedSatang($f['amount'], $what) : $c['amount_satang'];
            if ($amount <= 0) {
                throw ApiException::badRequest("{$what}: จำนวนเงินต้องมากกว่า 0 — ถ้าไม่ให้เหมารอบนี้ ให้เอาติ๊กออก");
            }
            $lines[] = [
                'kind'               => 'FIXED',
                'sales_entry_id'     => null,
                'invoice_id'         => $c['invoice_id'],
                'franchise_id'       => $c['franchise_id'],
                'period_id'          => $c['period_id'],
                'product_id'         => null,
                'link_id'            => $c['deal_ids'][0],
                'label'              => null,
                'mode'               => null,
                'base_amount_satang' => 0,
                'pct_bp'             => null,
                'amount_satang'      => $amount,
                'active_entry_id'    => null,
                'active_fixed_key'   => $key,
            ];
        }

        foreach ($others as $n => $o) {
            $label = trim((string) ($o['label'] ?? ''));
            if ($label === '' || mb_strlen($label) > 200) {
                throw ApiException::badRequest('ค่าคอมอื่น ๆ แถวที่ ' . ($n + 1) . ': ต้องมีชื่อรายการ (ไม่เกิน 200 ตัวอักษร)');
            }
            // ติดลบได้ = หักคืน (เช่นจ่ายเกินรอบก่อน) · ศูนย์ไม่มีผลอะไร
            $amount = self::typedSatang($o['amount'] ?? null, "ค่าคอมอื่น ๆ \"{$label}\"");
            if ($amount === 0) {
                throw ApiException::badRequest("ค่าคอมอื่น ๆ \"{$label}\": จำนวนเงินต้องไม่เป็นศูนย์ — ใส่ติดลบได้ถ้าเป็นการหักคืน");
            }
            $lines[] = [
                'kind'               => 'OTHER',
                'sales_entry_id'     => null,
                'invoice_id'         => null,
                'franchise_id'       => null,
                'period_id'          => null,
                'product_id'         => null,
                'link_id'            => null,
                'label'              => $label,
                'mode'               => null,
                'base_amount_satang' => 0,
                'pct_bp'             => null,
                'amount_satang'      => $amount,
                'active_entry_id'    => null,
                'active_fixed_key'   => null,
            ];
        }

        $header = self::headerOf($lines);
        if ($header['total_satang'] <= 0) {
            throw ApiException::badRequest('ยอดรวมบิลค่าคอมต้องมากกว่า 0');
        }
        $note       = trim((string) ($input['note'] ?? ''));
        $note       = $note === '' ? null : $note;
        $invoiceIds = array_values(array_unique(array_filter(array_column($lines, 'invoice_id'))));
        $countOf    = static fn (string $kind) => count(array_filter($lines, static fn ($l) => $l['kind'] === $kind));

        try {
            $id = Db::tx(static function () use ($agent, $lines, $header, $note, $invoiceIds, $user, $countOf) {
                // ล็อกเซลไว้ — เลขบิลค่าคอมนับต่อวันต่อเซล สองจอของเซลคนเดียวกันต้องไม่ได้เลขเดียวกัน
                Db::one('SELECT id FROM sales_agents WHERE id = ? FOR UPDATE', [$agent['id']]);
                /*
                 * บิลร้านถูกยกเลิกระหว่างที่หน้าต่างเปิดอยู่ — ล็อกแล้วตรวจอีกครั้ง
                 * (ยกเลิกบิลร้านล็อกบิลก่อนถอดรายการออกจากบิลค่าคอม สองทางจึงไม่สวนกัน)
                 */
                if ($invoiceIds !== []) {
                    foreach (Db::all('SELECT invoice_no, status FROM invoices WHERE id IN ? ORDER BY id FOR UPDATE', [$invoiceIds]) as $inv) {
                        if ($inv['status'] === 'VOID') {
                            throw ApiException::conflict("บิลร้าน {$inv['invoice_no']} เพิ่งถูกยกเลิก — โหลดรายการใหม่แล้วลองอีกครั้ง");
                        }
                    }
                }
                $billNo = self::nextBillNo($agent['username']);
                $id     = Db::insert(
                    "INSERT INTO sales_commissions
                       (sales_agent_id, franchise_id, period_id, invoice_id, kind, bill_no, label, basis,
                        base_amount_satang, commission_pct_bp, pct_amount_satang, fixed_satang, total_satang,
                        status, note, created_by_user_id, created_at, updated_at)
                     VALUES (?, NULL, NULL, NULL, 'BILL', ?, NULL, 'BILL', ?, NULL, ?, ?, ?, 'PENDING', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
                    [$agent['id'], $billNo, $header['base_amount_satang'], $header['pct_amount_satang'], $header['fixed_satang'], $header['total_satang'], $note, $user['id']],
                );
                foreach ($lines as $l) {
                    Db::insert(
                        'INSERT INTO sales_commission_lines
                           (commission_id, kind, sales_entry_id, invoice_id, franchise_id, period_id, product_id, link_id, label, mode,
                            base_amount_satang, pct_bp, amount_satang, active_entry_id, active_fixed_key, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
                        [
                            $id, $l['kind'], $l['sales_entry_id'], $l['invoice_id'], $l['franchise_id'], $l['period_id'], $l['product_id'], $l['link_id'],
                            $l['label'], $l['mode'], $l['base_amount_satang'], $l['pct_bp'], $l['amount_satang'], $l['active_entry_id'], $l['active_fixed_key'],
                        ],
                    );
                }
                Audit::write((int) $user['id'], 'sales_commission.bill_create', 'sales_commission', $id, [
                    'billNo' => $billNo,
                    'agent'  => $agent['username'],
                    'items'  => $countOf('ITEM'),
                    'fixed'  => $countOf('FIXED'),
                    'others' => $countOf('OTHER'),
                    'total'  => Money::toBaht($header['total_satang']),
                ]);

                return $id;
            });
        } catch (Throwable $e) {
            if (self::isDuplicateKey($e)) {
                throw ApiException::conflict('บางรายการเพิ่งถูกทำบิลค่าคอมไปแล้ว — โหลดรายการใหม่แล้วลองอีกครั้ง');
            }

            throw $e;
        }

        return self::getCommission($id, $user);
    }

    /**
     * ยอดหัวบิลค่าคอมจากรายการ
     *   base  = ยอดขายเต็มรวมของสินค้าที่ติ๊ก (ข้อมูลประกอบ)
     *   pct   = ค่าคอมรวมของรายการสินค้า
     *   fixed = เหมาต่อรอบ + ค่าคอมอื่น ๆ (ยอดที่ไม่ได้คิดจากยอดขาย)
     */
    private static function headerOf(array $lines): array
    {
        $sum = static fn (array $kinds, string $col) => array_sum(array_map(
            static fn ($l) => (int) $l[$col],
            array_filter($lines, static fn ($l) => in_array($l['kind'], $kinds, true)),
        ));
        $pct   = $sum(['ITEM'], 'amount_satang');
        $fixed = $sum(['FIXED', 'OTHER'], 'amount_satang');

        return [
            'base_amount_satang' => $sum(['ITEM'], 'base_amount_satang'),
            'pct_amount_satang'  => $pct,
            'fixed_satang'       => $fixed,
            'total_satang'       => $pct + $fixed,
        ];
    }

    /** ชื่อเซลในเลขบิลค่าคอมยาวได้ไม่เกินนี้ — bill_no เป็น VARCHAR(64): 'COM-YYYYMMDD-' 13 ตัว + ชื่อ + '-NNN' */
    private const BILL_NO_NAME_MAX = 40;

    /**
     * COM-YYYYMMDD-เซล (วันที่ไทย) · วันเดียวกันออกหลายใบต่อท้าย -2, -3 … — เรียกหลังล็อกแถวเซลแล้วเท่านั้น
     * ชื่อเซลยาวเกิน (username รับได้ถึง 100 ตัว · เซลเก่าก่อนมีเพดาน) ตัดเหลือ 40 ตัว — ไม่งั้น INSERT หัวบิลชน
     * "Data too long" แล้วเซลคนนั้นทำบิลค่าคอมไม่ได้เลย · ตัดแล้วชนกับเซลอื่นก็ไม่เป็นไร ลูปข้างล่างหาเลขที่ว่างให้
     */
    private static function nextBillNo(string $username): string
    {
        $base = 'COM-' . str_replace('-', '', Period::today()) . '-' . mb_substr($username, 0, self::BILL_NO_NAME_MAX);
        for ($n = 1; ; $n++) {
            $no = $n === 1 ? $base : "{$base}-{$n}";
            if (! Db::one('SELECT 1 FROM sales_commissions WHERE bill_no = ?', [$no])) {
                return $no;
            }
        }
    }

    /**
     * ยกเลิกบิลค่าคอมที่ยังไม่จ่าย — รายการในบิลกลับไปติ๊กทำบิลใหม่ได้ (ล้าง active_* ออก)
     * จ่ายแล้วยกเลิกไม่ได้: เงินออกไปแล้วจริง ถ้าจ่ายเกินให้หักคืนด้วยค่าคอมอื่น ๆ ติดลบในบิลถัดไป
     * แถวแบบเก่า (DEAL/MANUAL) ที่ยังไม่จ่ายก็ยกเลิกทางนี้ได้เหมือนกัน
     */
    public static function voidCommission(int $id, string $reason, array $user): array
    {
        Db::tx(static function () use ($id, $reason, $user) {
            $row = Db::one('SELECT * FROM sales_commissions WHERE id = ? FOR UPDATE', [$id]) ?? throw ApiException::notFound('ไม่พบรายการค่าคอม');
            if ($row['status'] === 'PAID') {
                throw ApiException::conflict('จ่ายแล้วยกเลิกไม่ได้ — ถ้าจ่ายเกิน ให้ใส่ค่าคอมอื่น ๆ ติดลบในบิลถัดไป');
            }
            if ($row['status'] === 'VOID') {
                throw ApiException::conflict('รายการนี้ถูกยกเลิกไปแล้ว');
            }
            self::markVoid((int) $row['id'], $reason);
            Audit::write((int) $user['id'], 'sales_commission.void', 'sales_commission', $id, [
                'billNo' => $row['bill_no'],
                'kind'   => $row['kind'],
                'reason' => $reason,
                'total'  => Money::toBaht($row['total_satang']),
            ]);
        });

        return self::getCommission($id, $user);
    }

    /** VOID + ปล่อยรายการกลับไปให้ติ๊กได้ใหม่ — แถวต้องถูกล็อกไว้แล้ว */
    private static function markVoid(int $id, string $reason): void
    {
        Db::exec(
            "UPDATE sales_commissions
                SET status = 'VOID', voided_at = UTC_TIMESTAMP(), void_reason = ?, updated_at = UTC_TIMESTAMP()
              WHERE id = ?",
            [$reason, $id],
        );
        Db::exec('UPDATE sales_commission_lines SET active_entry_id = NULL, active_fixed_key = NULL WHERE commission_id = ?', [$id]);
    }

    /**
     * บิลร้านถูกยกเลิก — เรียกใน transaction ของ InvoiceService::void (หลังล็อกบิลร้านแล้ว)
     *
     * แถวค่าคอมแบบเก่า (DEAL) ของบิลนั้น → ยกเลิกตามเดิม (voidCommissionsForInvoice)
     * บิลค่าคอมที่ยังไม่จ่าย → ถอดรายการ ITEM/FIXED ของบิลร้านใบนั้นออก แล้วคิดยอดหัวบิลใหม่
     *   ไม่เหลือรายการ หรือยอดรวม ≤ 0 → ยกเลิกทั้งใบ (ไม่งั้นจะมีบิลค่าคอมที่จ่ายไม่ได้ค้างอยู่)
     *   บิลร้านที่ออกใหม่แทนใบเดิม → รายการกลับมาให้ติ๊กได้อีก (บรรทัดเดิมถูกลบไปแล้ว)
     * บิลค่าคอมที่จ่ายแล้วไม่แตะ — รายการยังผูกอยู่ จึงจ่ายค่าคอมของบรรทัดเดิมซ้ำไม่ได้ แม้บิลร้านจะออกใหม่
     */
    public static function onInvoiceVoided(int $invoiceId, int $actorUserId): void
    {
        self::voidCommissionsForInvoice($invoiceId, $actorUserId);

        $billIds = array_map('intval', array_column(
            Db::all('SELECT DISTINCT commission_id FROM sales_commission_lines WHERE invoice_id = ?', [$invoiceId]),
            'commission_id',
        ));
        if ($billIds === []) {
            return;
        }
        $invoiceNo = (string) Db::val('SELECT invoice_no FROM invoices WHERE id = ?', [$invoiceId]);
        foreach (Db::all("SELECT * FROM sales_commissions WHERE id IN ? AND kind = 'BILL' AND status = 'PENDING' ORDER BY id FOR UPDATE", [$billIds]) as $bill) {
            $billId  = (int) $bill['id'];
            $removed = Db::exec("DELETE FROM sales_commission_lines WHERE commission_id = ? AND invoice_id = ? AND kind IN ('ITEM', 'FIXED')", [$billId, $invoiceId]);
            if ($removed === 0) {
                continue;
            }
            $left   = Db::all('SELECT kind, base_amount_satang, amount_satang FROM sales_commission_lines WHERE commission_id = ? FOR UPDATE', [$billId]);
            $header = self::headerOf($left);
            Db::exec(
                'UPDATE sales_commissions
                    SET base_amount_satang = ?, pct_amount_satang = ?, fixed_satang = ?, total_satang = ?, updated_at = UTC_TIMESTAMP()
                  WHERE id = ?',
                [$header['base_amount_satang'], $header['pct_amount_satang'], $header['fixed_satang'], $header['total_satang'], $billId],
            );
            $voided = $left === [] || $header['total_satang'] <= 0;
            $reason = "บิลร้าน {$invoiceNo} ถูกยกเลิก";
            if ($voided) {
                self::markVoid($billId, $reason);
            }
            Audit::write($actorUserId, 'sales_commission.lines_removed', 'sales_commission', $billId, [
                'billNo'    => $bill['bill_no'],
                'invoiceNo' => $invoiceNo,
                'removed'   => $removed,
                'from'      => Money::toBaht($bill['total_satang']),
                'to'        => Money::toBaht($header['total_satang']),
                'voided'    => $voided,
            ]);
            if ($voided) {
                Audit::write($actorUserId, 'sales_commission.void', 'sales_commission', $billId, ['billNo' => $bill['bill_no'], 'reason' => $reason, 'auto' => true]);
            }
        }
    }

    /* ── ค่าคอมรายการอื่น ๆ แบบเก่า (มีรอบบิล) — หน้าเว็บไม่ใช้แล้ว เก็บ API ไว้ให้ไคลเอนต์เดิม ── */

    /**
     * ค่าคอมที่ไม่ได้มาจากดีลสินค้า เช่นโบนัสปิดดีลใหญ่ หรือค่าเดินทางที่ตกลงกันไว้
     * ตอนนี้ใส่เป็น "ค่าคอมอื่น ๆ" ในบิลค่าคอมแทน (ไม่ต้องเลือกรอบ)
     */
    public static function createManual(array $input, int $actorUserId): array
    {
        $agent  = Db::one('SELECT * FROM sales_agents WHERE id = ?', [(int) $input['salesAgentId']]) ?? throw ApiException::notFound('ไม่พบเซล');
        $period = PeriodService::ensure($input['periodCode']);
        $label  = trim((string) ($input['label'] ?? ''));
        if ($label === '') {
            throw ApiException::badRequest('ต้องระบุชื่อรายการ');
        }
        // ติดลบได้ ใช้หักคืนตอนจ่ายเกินหรือคิดผิด แต่ห้ามเป็นศูนย์เพราะไม่มีผลอะไร
        $amount = Money::toSatang($input['amount'] ?? null, 'amount');
        if ($amount === 0) {
            throw ApiException::badRequest('amount: จำนวนเงินต้องไม่เป็นศูนย์');
        }
        $id = Db::insert(
            "INSERT INTO sales_commissions
               (sales_agent_id, franchise_id, period_id, invoice_id, kind, label, basis,
                base_amount_satang, commission_pct_bp, pct_amount_satang, fixed_satang, total_satang,
                note, created_by_user_id, created_at, updated_at)
             VALUES (?, NULL, ?, NULL, 'MANUAL', ?, 'MANUAL', 0, NULL, 0, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
            [$agent['id'], $period['id'], $label, $amount, $amount, $input['note'] ?? null, $actorUserId],
        );
        Audit::write($actorUserId, 'sales_commission.manual_create', 'sales_commission', $id, [
            'agent'      => $agent['username'],
            'periodCode' => $period['code'],
            'label'      => $label,
            'amount'     => Money::toBaht($amount),
        ]);

        return self::getCommissionRaw($id);
    }

    public static function updateManual(int $id, array $patch, int $actorUserId): array
    {
        $row = Db::one('SELECT * FROM sales_commissions WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการค่าคอม');
        if ($row['kind'] !== 'MANUAL') {
            throw ApiException::conflict('แก้ตรงนี้ได้เฉพาะรายการที่พิมพ์เพิ่มเองแบบเก่า — บิลค่าคอมที่ยังไม่จ่ายให้ยกเลิกแล้วทำใหม่');
        }
        if ($row['status'] !== 'PENDING') {
            throw ApiException::conflict($row['status'] === 'PAID' ? 'จ่ายเงินให้เซลไปแล้ว แก้ไม่ได้' : 'รายการนี้ถูกยกเลิกแล้ว แก้ไม่ได้');
        }
        $sets   = [];
        $params = [];
        if (array_key_exists('label', $patch)) {
            $label = trim((string) $patch['label']);
            if ($label === '') {
                throw ApiException::badRequest('ต้องระบุชื่อรายการ');
            }
            $sets[]   = 'label = ?';
            $params[] = $label;
        }
        if (array_key_exists('amount', $patch)) {
            $amount = Money::toSatang($patch['amount'], 'amount');
            if ($amount === 0) {
                throw ApiException::badRequest('amount: จำนวนเงินต้องไม่เป็นศูนย์');
            }
            array_push($sets, 'fixed_satang = ?', 'total_satang = ?');
            array_push($params, $amount, $amount);
        }
        if (array_key_exists('periodCode', $patch)) {
            $sets[]   = 'period_id = ?';
            $params[] = PeriodService::ensure($patch['periodCode'])['id'];
        }
        if (array_key_exists('note', $patch)) {
            $sets[]   = 'note = ?';
            $params[] = $patch['note'];
        }
        if ($sets === []) {
            return self::getCommissionRaw($id);
        }
        $sets[]   = 'updated_at = UTC_TIMESTAMP()';
        $params[] = $id;
        Db::exec('UPDATE sales_commissions SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
        Audit::write($actorUserId, 'sales_commission.manual_update', 'sales_commission', $id, $patch);

        return self::getCommissionRaw($id);
    }

    public static function deleteManual(int $id, int $actorUserId): array
    {
        $row = Db::one('SELECT * FROM sales_commissions WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการค่าคอม');
        if ($row['kind'] !== 'MANUAL') {
            throw ApiException::conflict('ลบได้เฉพาะรายการที่พิมพ์เพิ่มเองแบบเก่า — บิลค่าคอมใช้ "ยกเลิก" แทน (ประวัติต้องอยู่ครบ)');
        }
        if ($row['status'] === 'PAID') {
            throw ApiException::conflict('จ่ายเงินให้เซลไปแล้ว ลบไม่ได้');
        }
        Db::exec('DELETE FROM sales_commissions WHERE id = ?', [$id]);
        Audit::write($actorUserId, 'sales_commission.manual_delete', 'sales_commission', $id, ['label' => $row['label'], 'amount' => Money::toBaht($row['total_satang'])]);

        return ['deleted' => true, 'id' => $id];
    }

    /* ── อ่านค่าคอม ─────────────────────────────────────────────── */

    // บิลค่าคอมไม่มีรอบ — LEFT JOIN รอบ (ถ้า JOIN ธรรมดา บิลค่าคอมจะหายจากทุกรายการ)
    private const SELECT_COMMISSION = '
        SELECT c.*, a.username AS agent_username, a.name AS agent_name,
               f.username AS franchise_username,
               bp.code AS period_code, bp.start_date AS period_start, bp.end_date AS period_end,
               i.invoice_no, i.status AS invoice_status
          FROM sales_commissions c
          JOIN sales_agents a          ON a.id = c.sales_agent_id
          LEFT JOIN franchises f       ON f.id = c.franchise_id
          LEFT JOIN billing_periods bp ON bp.id = c.period_id
          LEFT JOIN invoices i         ON i.id = c.invoice_id';

    /* แถวเก่าเรียงตามรอบ บิลค่าคอมเรียงตามวันที่ทำ (เวลาไทย) — ปนกันได้ในรายการเดียว */
    private const ORDER_COMMISSION = ' ORDER BY COALESCE(bp.start_date, DATE(DATE_ADD(c.created_at, INTERVAL 7 HOUR))) DESC, c.id DESC';

    /* รายการในบิลค่าคอม + ข้อมูลบิลร้าน/ดีลที่อ้างถึง */
    private const SELECT_LINES = '
        SELECT l.*, p.sku, p.name AS product_name,
               i.invoice_no, i.status AS invoice_status,
               f.username AS franchise_username,
               bp.code AS period_code,
               k.commission_pct_bp AS deal_pct_bp, k.fixed_satang AS deal_fixed_satang
          FROM sales_commission_lines l
          LEFT JOIN products p             ON p.id = l.product_id
          LEFT JOIN invoices i             ON i.id = l.invoice_id
          LEFT JOIN franchises f           ON f.id = l.franchise_id
          LEFT JOIN billing_periods bp     ON bp.id = l.period_id
          LEFT JOIN product_sales_links k  ON k.id = l.link_id';

    /**
     * รายการของหลายบิลในคำขอเดียว (หน้ารายการมีเป็นร้อยใบ — ห้ามยิงทีละใบ)
     *
     * @return array<int, list<array>> commission_id → รายการ
     */
    private static function linesOf(array $commissionIds): array
    {
        if ($commissionIds === []) {
            return [];
        }
        $out = [];
        foreach (Db::all(
            self::SELECT_LINES . " WHERE l.commission_id IN ?
              ORDER BY l.commission_id, FIELD(l.kind, 'ITEM', 'FIXED', 'OTHER'), bp.start_date DESC, i.invoice_no, p.sku, l.id",
            [array_values(array_unique($commissionIds))],
        ) as $r) {
            $out[(int) $r['commission_id']][] = $r;
        }

        return $out;
    }

    private static function serializeLine(array $l): array
    {
        return [
            'id'                => (int) $l['id'],
            'kind'              => $l['kind'],
            'entryId'           => $l['sales_entry_id'] === null ? null : (int) $l['sales_entry_id'],
            'invoiceId'         => $l['invoice_id'] === null ? null : (int) $l['invoice_id'],
            'invoiceNo'         => $l['invoice_no'],
            'franchiseId'       => $l['franchise_id'] === null ? null : (int) $l['franchise_id'],
            'franchiseUsername' => $l['franchise_username'],
            'periodCode'        => $l['period_code'],
            'productId'         => $l['product_id'] === null ? null : (int) $l['product_id'],
            'sku'               => $l['sku'],
            'productName'       => $l['product_name'],
            'label'             => $l['label'],
            'mode'              => $l['mode'],
            'modeLabel'         => $l['mode'] === null ? null : (self::ITEM_MODE_LABEL[$l['mode']] ?? $l['mode']),
            'baseAmount'        => Money::toBaht($l['base_amount_satang']),
            'pct'               => $l['pct_bp'] === null ? null : Money::bpToPct($l['pct_bp']),
            'amount'            => Money::toBaht($l['amount_satang']),
            'deal'              => $l['link_id'] === null ? null : [
                'id'          => (int) $l['link_id'],
                'pct'         => $l['deal_pct_bp'] === null ? null : Money::bpToPct($l['deal_pct_bp']),
                'fixedAmount' => $l['deal_fixed_satang'] === null ? null : Money::toBaht($l['deal_fixed_satang']),
            ],
            // บิลร้านของรายการนี้ถูกยกเลิกทีหลัง (บิลค่าคอมที่จ่ายแล้วไม่ถูกแตะ) — หน้าจอติดป้ายให้รู้
            'invoiceVoided' => ($l['invoice_status'] ?? null) === 'VOID',
        ];
    }

    /** อ่านแถวเดียวโดยไม่เช็คสิทธิ์ — ใช้ภายในหลังเพิ่ง insert/update เสร็จ */
    private static function getCommissionRaw(int $id): array
    {
        return self::serializeCommission(Db::one(self::SELECT_COMMISSION . ' WHERE c.id = ?', [$id]));
    }

    /** serialize หลายแถว + รายการของบิลค่าคอมในคิวรีเดียว */
    private static function serializeMany(array $raw): array
    {
        $lines = self::linesOf(array_map(static fn ($r) => (int) $r['id'], array_filter($raw, static fn ($r) => $r['kind'] === 'BILL')));

        return array_map(static fn ($r) => self::serializeCommission($r, $lines[(int) $r['id']] ?? []), $raw);
    }

    /**
     * รายการค่าคอม — บิลค่าคอม (BILL) ปนกับแถวแบบเก่า (DEAL/MANUAL)
     * periodCode / fromPeriod กรองได้เฉพาะแถวเก่า (บิลค่าคอมไม่มีรอบ) · franchiseId หาในรายการของบิลค่าคอมด้วย
     */
    public static function listCommissions(array $filters, array $user): array
    {
        $where  = [];
        $params = [];
        // เซลเห็นเฉพาะคอมของตัวเอง
        $agentId = AuthContext::isSuperAdmin($user) ? ($filters['salesAgentId'] ?? null) : $user['sales_agent_id'];
        if ($agentId) {
            $where[]  = 'c.sales_agent_id = ?';
            $params[] = (int) $agentId;
        }
        if (! empty($filters['franchiseId'])) {
            $where[] = '(c.franchise_id = ? OR EXISTS (SELECT 1 FROM sales_commission_lines x WHERE x.commission_id = c.id AND x.franchise_id = ?))';
            array_push($params, (int) $filters['franchiseId'], (int) $filters['franchiseId']);
        }
        if (! empty($filters['status'])) {
            $where[]  = 'c.status = ?';
            $params[] = $filters['status'];
        }
        if (! empty($filters['kind'])) {
            if (! in_array($filters['kind'], ['BILL', 'DEAL', 'MANUAL'], true)) {
                throw ApiException::badRequest('kind: ต้องเป็น BILL, DEAL หรือ MANUAL');
            }
            $where[]  = 'c.kind = ?';
            $params[] = $filters['kind'];
        }
        if (! empty($filters['periodCode'])) {
            $where[]  = 'bp.code = ?';
            $params[] = $filters['periodCode'];
        }
        if (! empty($filters['fromPeriod']) && ! empty($filters['toPeriod'])) {
            $where[] = 'bp.code >= ? AND bp.code <= ?';
            array_push($params, $filters['fromPeriod'], $filters['toPeriod']);
        }
        $rows  = self::serializeMany(Db::all(
            self::SELECT_COMMISSION . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . self::ORDER_COMMISSION,
            $params,
        ));
        $sumBy = static fn (string $status) => array_sum(array_map(static fn ($r) => $r['totalAmount'], array_filter($rows, static fn ($r) => $r['status'] === $status)));

        return [
            'items'   => $rows,
            'summary' => [
                'count'   => count($rows),
                'pending' => Money::round2($sumBy('PENDING')),
                'paid'    => Money::round2($sumBy('PAID')),
                'total'   => Money::round2(array_sum(array_map(static fn ($r) => $r['totalAmount'], array_filter($rows, static fn ($r) => $r['status'] !== 'VOID')))),
            ],
        ];
    }

    public static function getCommission(int $id, array $user): array
    {
        $row = Db::one(self::SELECT_COMMISSION . ' WHERE c.id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการค่าคอม');
        if (! AuthContext::isSuperAdmin($user) && (int) $row['sales_agent_id'] !== (int) $user['sales_agent_id']) {
            throw ApiException::forbidden();
        }

        return self::serializeCommission($row);
    }

    /**
     * บันทึกว่าจ่ายคอมให้เซลแล้ว
     * UPDATE แบบมีเงื่อนไขสถานะ — จ่ายกับยกเลิก (หรือบิลร้านถูกยกเลิก) พร้อมกัน ต้องมีแค่ทางเดียวที่สำเร็จ
     */
    public static function markPaid(int $id, array $input, array $user): array
    {
        $row = Db::one('SELECT * FROM sales_commissions WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการค่าคอม');
        if ($row['status'] === 'VOID') {
            throw ApiException::conflict('รายการนี้ถูกยกเลิกแล้ว');
        }
        if ($row['status'] === 'PAID') {
            throw ApiException::conflict('รายการนี้จ่ายไปแล้ว');
        }
        $changed = Db::exec(
            "UPDATE sales_commissions
                SET status = 'PAID', paid_at = COALESCE(?, UTC_TIMESTAMP()), note = ?, updated_at = UTC_TIMESTAMP()
              WHERE id = ? AND status = 'PENDING'",
            [$input['paidAt'] ?? null, $input['note'] ?? $row['note'], $id],
        );
        if ($changed === 0) {
            throw ApiException::conflict('รายการนี้เพิ่งถูกจ่ายหรือยกเลิกไป — โหลดหน้าใหม่แล้วตรวจอีกครั้ง');
        }
        Audit::write((int) $user['id'], 'sales_commission.pay', 'sales_commission', $id, $row['bill_no'] === null ? null : ['billNo' => $row['bill_no']]);

        return self::getCommission($id, $user);
    }

    /** แถวค่าคอมแบบเก่า (DEAL ผูกบิลร้าน) ที่ยังไม่จ่าย ยกเลิกตามบิลร้าน — บิลค่าคอมไม่ผูก invoice_id จึงไม่โดนตรงนี้ */
    public static function voidCommissionsForInvoice(int $invoiceId, int $actorUserId): int
    {
        $changes = Db::exec(
            "UPDATE sales_commissions
                SET status = 'VOID', voided_at = UTC_TIMESTAMP(), void_reason = 'บิลร้านถูกยกเลิก', updated_at = UTC_TIMESTAMP()
              WHERE invoice_id = ? AND status = 'PENDING'",
            [$invoiceId],
        );
        if ($changes > 0) {
            Audit::write($actorUserId, 'sales_commission.void', 'invoice', $invoiceId, ['count' => $changes]);
        }

        return $changes;
    }

    /**
     * $lineRows = รายการที่โหลดมาแล้ว (หน้ารายการโหลดทีเดียวทั้งหน้า) · ไม่ส่งมา = อ่านเองเฉพาะแถวนี้
     * แถวแบบเก่า (DEAL/MANUAL) ไม่มีรายการ — lines ว่าง ตัวเลขอยู่ที่หัวแถวเหมือนเดิม
     */
    public static function serializeCommission(array $row, ?array $lineRows = null): array
    {
        $kind     = $row['kind'];
        $manual   = $kind === 'MANUAL';
        $bill     = $kind === 'BILL';
        $lineRows = $bill ? ($lineRows ?? (self::linesOf([(int) $row['id']])[(int) $row['id']] ?? [])) : [];
        $lines    = array_map([self::class, 'serializeLine'], $lineRows);

        return [
            'id'                => (int) $row['id'],
            'salesAgentId'      => (int) $row['sales_agent_id'],
            'agentUsername'     => $row['agent_username'],
            'agentName'         => $row['agent_name'],
            'franchiseId'       => $row['franchise_id'] === null ? null : (int) $row['franchise_id'],
            'franchiseUsername' => $row['franchise_username'],
            'periodCode'        => $row['period_code'],
            'periodStart'       => $row['period_start'],
            'periodEnd'         => $row['period_end'],
            'invoiceId'         => $row['invoice_id'] === null ? null : (int) $row['invoice_id'],
            'invoiceNo'         => $row['invoice_no'],
            'kind'              => $kind,
            'isManual'          => $manual,
            'isBill'            => $bill,
            'billNo'            => $row['bill_no'] ?? null,
            'label'             => $row['label'],
            // ชื่อที่เอาไปโชว์ได้เลยโดยไม่ต้องแยกเคสที่หน้าจอ
            'title'         => $bill ? "บิลค่าคอม {$row['bill_no']}" : ($manual ? $row['label'] : ($row['franchise_username'] ?? '—')),
            'basis'         => $row['basis'],
            'basisLabel'    => $manual ? 'พิมพ์เพิ่มเอง' : self::basisLabel($row['basis']),
            'baseAmount'    => Money::toBaht($row['base_amount_satang']),
            'commissionPct' => $row['commission_pct_bp'] === null ? null : Money::bpToPct($row['commission_pct_bp']),
            'pctAmount'     => Money::toBaht($row['pct_amount_satang']),
            'fixedAmount'   => Money::toBaht($row['fixed_satang']),
            'totalAmount'   => Money::toBaht($row['total_satang']),
            'status'        => $row['status'],
            'paidAt'        => $row['paid_at'],
            'voidedAt'      => $row['voided_at'] ?? null,
            'voidReason'    => $row['void_reason'] ?? null,
            'note'          => $row['note'],
            'createdAt'     => $row['created_at'],
            'lineCount'     => count($lines),
            'lines'         => $lines,
        ];
    }

    /**
     * ภาพรวมสำหรับหน้าแรกของเซล
     * byMonth = ยอดต่อเดือน (เวลาไทย) — บิลค่าคอมไม่มีรอบ จึงนับตามเดือนที่ทำบิล · แถวเก่านับตามเดือนของรอบ
     */
    public static function dashboard(int $agentId): array
    {
        $agent   = self::get($agentId);
        $links   = self::listLinks($agentId);
        $byMonth = array_map(static function ($r) {
            [$y, $m] = array_map('intval', explode('-', $r['ym']));

            return [
                'month'         => $r['ym'],
                'monthLabel'    => Period::THAI_MONTHS[$m - 1] . ' ' . ($y + 543),
                'count'         => (int) $r['n'],
                'totalAmount'   => Money::toBaht((int) $r['total_satang']),
                'pendingAmount' => Money::toBaht((int) $r['pending_satang']),
                'paidAmount'    => Money::toBaht((int) $r['paid_satang']),
            ];
        }, Db::all(
            // ตั้งชื่อ ym ไม่ใช่ month — GROUP BY หาชื่อคอลัมน์ในตารางก่อน alias และ billing_periods มีคอลัมน์ month อยู่แล้ว
            "SELECT DATE_FORMAT(COALESCE(bp.start_date, DATE(DATE_ADD(c.created_at, INTERVAL 7 HOUR))), '%Y-%m') AS ym,
                    COUNT(*) AS n,
                    COALESCE(SUM(c.total_satang), 0) AS total_satang,
                    COALESCE(SUM(CASE WHEN c.status = 'PENDING' THEN c.total_satang ELSE 0 END), 0) AS pending_satang,
                    COALESCE(SUM(CASE WHEN c.status = 'PAID' THEN c.total_satang ELSE 0 END), 0) AS paid_satang
               FROM sales_commissions c
               LEFT JOIN billing_periods bp ON bp.id = c.period_id
              WHERE c.sales_agent_id = ? AND c.status <> 'VOID'
              GROUP BY ym
              ORDER BY ym DESC
              LIMIT 12",
            [$agentId],
        ));
        $recent = self::serializeMany(Db::all(self::SELECT_COMMISSION . ' WHERE c.sales_agent_id = ?' . self::ORDER_COMMISSION . ' LIMIT 10', [$agentId]));

        return [
            'agent'       => $agent,
            'products'    => $links,
            'byMonth'     => $byMonth,
            'recentBills' => $recent,
            'summary'     => [
                'activeProducts' => count(array_filter($links, static fn ($l) => $l['isActive'])),
                'pending'        => $agent['pendingCommission'],
                'paid'           => $agent['paidCommission'],
            ],
        ];
    }
}
