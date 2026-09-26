<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\AuthContext;
use App\Libraries\Clock;
use App\Libraries\Db;
use App\Libraries\Money;
use App\Libraries\Period;

/**
 * เซล — ดีลผูกกับสินค้า (ไม่ใช่ทั้งร้าน) คิดค่าคอมอัตโนมัติตอนออกบิล + ค่าคอมที่พิมพ์เพิ่มเอง
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
            // เซลไม่มีตัวเลขคอมติดตัว — เงินทุกบาทมาจากดีลที่ผูกกับสินค้า หรือรายการที่พิมพ์เพิ่มเอง
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

    private static function selectAgent(): string
    {
        return "
            SELECT a.*,
                   (SELECT COUNT(*) FROM product_sales_links l
                     WHERE l.sales_agent_id = a.id
                       AND l.start_date <= ?
                       AND (l.end_date IS NULL OR l.end_date >= ?))                     AS active_product_count,
                   (SELECT COUNT(*) FROM users u WHERE u.sales_agent_id = a.id)          AS user_count,
                   (SELECT COALESCE(SUM(c.total_satang), 0) FROM sales_commissions c
                     WHERE c.sales_agent_id = a.id AND c.status = 'PENDING')             AS pending_satang,
                   (SELECT COALESCE(SUM(c.total_satang), 0) FROM sales_commissions c
                     WHERE c.sales_agent_id = a.id AND c.status = 'PAID')                AS paid_satang
              FROM sales_agents a";
    }

    public static function get(int $id): array
    {
        $today = Clock::todayUtc();
        $row   = Db::one(self::selectAgent() . ' WHERE a.id = ?', [$today, $today, $id]);

        return self::serializeAgent($row ?? throw ApiException::notFound('ไม่พบเซล'));
    }

    public static function list(?string $status = null, ?string $q = null): array
    {
        $today  = Clock::todayUtc();
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

        return array_map([self::class, 'serializeAgent'], Db::all(
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
            'createdAt'          => $row['created_at'],
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

    /** 1 สินค้า มีเซลเจ้าของดีลได้คนเดียวต่อช่วงเวลา */
    public static function linkProduct(array $input, ?int $actorUserId): array
    {
        $agent = Db::one('SELECT * FROM sales_agents WHERE id = ?', [(int) $input['salesAgentId']]) ?? throw ApiException::notFound('ไม่พบเซล');
        if ($agent['status'] !== 'ACTIVE') {
            throw ApiException::badRequest("เซล {$agent['username']} ไม่อยู่ในสถานะใช้งาน");
        }
        $product   = Db::one('SELECT * FROM products WHERE id = ?', [(int) $input['productId']]) ?? throw ApiException::notFound('ไม่พบสินค้า');
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
        // ตัวเลขต้องมาจากตรงนี้เท่านั้น — เซลไม่มีค่าตั้งต้นให้หยิบมาใช้แล้ว
        $pctBp = ($input['commissionPct'] ?? null) === null ? null : Money::pctToBp($input['commissionPct'], 'commissionPct');
        $fixed = ($input['fixedAmount'] ?? null) === null ? null : Money::toSatang($input['fixedAmount'], 'fixedAmount');
        if ($pctBp === null && $fixed === null) {
            throw ApiException::badRequest("ดีลของ {$product['sku']}: ต้องกรอกอย่างน้อยหนึ่งอย่าง — % ต่อรอบ หรือค่าคงที่ต่อรอบ");
        }
        $basis = $input['basis'] ?? 'COMMISSION';
        if (! in_array($basis, ['COMMISSION', 'GROSS'], true)) {
            throw ApiException::badRequest('basis: ต้องเป็น COMMISSION หรือ GROSS');
        }
        $id = Db::insert(
            'INSERT INTO product_sales_links
               (product_id, sales_agent_id, basis, commission_pct_bp, fixed_satang, start_date, end_date, note, created_by_user_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
            [$product['id'], $agent['id'], $basis, $pctBp, $fixed, $startDate, $endDate, $input['note'] ?? null, $actorUserId],
        );
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
            throw ApiException::badRequest('ต้องเลือกสินค้าอย่างน้อยหนึ่งรายการ');
        }
        $seen = [];
        foreach ($items as $item) {
            $key = (int) $item['productId'];
            if (isset($seen[$key])) {
                throw ApiException::badRequest('เลือกสินค้าซ้ำกันในรายการเดียว');
            }
            $seen[$key] = true;
        }
        $common = array_intersect_key($input, array_flip(['salesAgentId', 'basis', 'startDate', 'endDate', 'note']));

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
        if ($activeOn) {
            $date    = Period::assertDate($activeOn, 'activeOn');
            $where[] = 'l.start_date <= ? AND (l.end_date IS NULL OR l.end_date >= ?)';
            array_push($params, $date, $date);
        }

        return array_map([self::class, 'serializeLink'], Db::all(
            self::SELECT_LINK . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY l.start_date DESC, l.id DESC',
            $params,
        ));
    }

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
        $clash = self::overlappingLinks((int) $row['product_id'], $startDate, $endDate, $id);
        if ($clash !== []) {
            throw ApiException::conflict(
                'ช่วงวันที่ใหม่ทับกับดีลเซลรายอื่นของสินค้าชิ้นนี้',
                array_map(static fn ($l) => ['linkId' => (int) $l['id'], 'agentUsername' => $l['agent_username'], 'startDate' => $l['start_date'], 'endDate' => $l['end_date']], $clash),
            );
        }
        $pctBp = ! array_key_exists('commissionPct', $patch)
            ? $row['commission_pct_bp']
            : ($patch['commissionPct'] === null ? null : Money::pctToBp($patch['commissionPct'], 'commissionPct'));
        $fixed = ! array_key_exists('fixedAmount', $patch)
            ? $row['fixed_satang']
            : ($patch['fixedAmount'] === null ? null : Money::toSatang($patch['fixedAmount'], 'fixedAmount'));
        if ($pctBp === null && $fixed === null) {
            throw ApiException::badRequest('ต้องเหลืออย่างน้อยหนึ่งอย่าง: เปอร์เซ็นต์ต่อรอบ หรือค่าคงที่ต่อรอบ');
        }
        Db::exec(
            'UPDATE product_sales_links
                SET basis = ?, commission_pct_bp = ?, fixed_satang = ?, start_date = ?, end_date = ?,
                    note = ?, updated_at = UTC_TIMESTAMP()
              WHERE id = ?',
            [$patch['basis'] ?? $row['basis'], $pctBp, $fixed, $startDate, $endDate, array_key_exists('note', $patch) ? $patch['note'] : $row['note'], $id],
        );
        Audit::write($actorUserId, 'sales_link.update', 'sales_link', $id, $patch);

        return self::getLink($id);
    }

    /** ปิดดีล — เซลจะไม่ได้คอมจากรอบบิลที่ออกหลังวันที่นี้ */
    public static function endLink(int $id, ?string $endDate, int $actorUserId): array
    {
        $row  = Db::one('SELECT * FROM product_sales_links WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบดีลของเซล');
        $date = Period::assertDate($endDate ?? Period::today(), 'endDate');
        if ($date < $row['start_date']) {
            throw ApiException::badRequest('endDate ต้องไม่น้อยกว่า startDate');
        }
        Db::exec('UPDATE product_sales_links SET end_date = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [$date, $id]);
        Audit::write($actorUserId, 'sales_link.end', 'sales_link', $id, ['endDate' => $date]);

        return self::getLink($id);
    }

    /** ดีลของสินค้าชิ้นนี้ในรอบบิลนี้ — ต้องเจอรายการเดียว ถ้าเปลี่ยนมือกลางรอบให้ข้ามไปก่อน */
    public static function resolveLinkForPeriod(int $productId, array $period): ?array
    {
        $matches = self::overlappingLinks($productId, $period['start_date'], $period['end_date']);

        return count($matches) === 1 ? $matches[0] : null;
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
            'basisLabel'        => $row['basis'] === 'GROSS' ? 'ยอดขายเต็ม' : 'ส่วนต่างที่ร้านค้าจ่าย',
            'commissionPct'     => $row['commission_pct_bp'] === null ? null : Money::bpToPct($row['commission_pct_bp']),
            'fixedAmount'       => $row['fixed_satang'] === null ? null : Money::toBaht($row['fixed_satang']),
            'startDate'         => $row['start_date'],
            'endDate'           => $row['end_date'],
            'isActive'          => $row['start_date'] <= $today && ($row['end_date'] === null || $row['end_date'] >= $today),
            'note'              => $row['note'],
            'createdAt'         => $row['created_at'],
        ];
    }

    /* ── ค่าคอมที่เกิดขึ้นจริง ──────────────────────────────────── */

    /**
     * คิดค่าคอมเซลของใบเรียกเก็บใบหนึ่ง
     *
     * ฐานที่ใช้คือส่วนต่างจากยอดเต็ม (หรือยอดขายเต็ม) ก่อนบวกค่าใช้จ่าย/หักส่วนลด
     * — ค่าใช้จ่ายอื่นในบิลจึงไม่ทำให้คอมเซลบวมตาม
     *
     * ดีลผูกกับสินค้า ไม่ใช่ร้าน — บิลใบเดียวจึงมีสินค้าของเซลหลายคนปนกันได้
     * จึงจัดกลุ่มรายการในบิลตามเซลที่ถือดีลของสินค้านั้น แล้วคิดคนละแถว
     *
     * ค่าคงที่คิด "ครั้งเดียวต่อ (เซล, ร้าน, รอบบิล)" — เซลถือหลายชิ้นในร้านเดียวกัน หรือบิลแยกหลายใบก็ไม่คิดซ้ำ
     *
     * @return list<int> id ค่าคอมที่สร้าง (ว่างได้ถ้าไม่มีสินค้าชิ้นไหนมีเซลถือดีล)
     */
    public static function createCommissionForInvoice(array $invoice, array $period, ?int $actorUserId, array $skipAgents = []): array
    {
        $lines = Db::all('SELECT product_id, gross_amount_satang, commission_amount_satang FROM sales_entries WHERE invoice_id = ? ORDER BY id', [$invoice['id']]);

        // รวมยอดของแต่ละเซล จากสินค้าที่เซลคนนั้นถือดีลอยู่ในรอบนี้
        $byAgent = [];
        foreach ($lines as $line) {
            $link = self::resolveLinkForPeriod((int) $line['product_id'], $period);
            if ($link === null) {
                continue;
            }
            $agentId                        = (int) $link['sales_agent_id'];
            $byAgent[$agentId]            ??= ['link' => $link, 'gross' => 0, 'commission' => 0];
            $byAgent[$agentId]['gross']      += (int) $line['gross_amount_satang'];
            $byAgent[$agentId]['commission'] += (int) $line['commission_amount_satang'];
        }

        $created = [];
        foreach ($byAgent as $agentId => ['link' => $link, 'gross' => $gross, 'commission' => $commission]) {
            if (in_array($agentId, $skipAgents, true)) {
                continue; // จ่ายคอมรอบนี้ให้เซลคนนี้ไปแล้ว ไม่คิดซ้ำ
            }
            $base      = $link['basis'] === 'GROSS' ? $gross : $commission;
            $pctAmount = $link['commission_pct_bp'] === null ? 0 : Money::commissionOf($base, (int) $link['commission_pct_bp']);
            $charged   = Db::int(
                "SELECT COUNT(*) FROM sales_commissions
                  WHERE sales_agent_id = ? AND franchise_id = ? AND period_id = ? AND status <> 'VOID'",
                [$agentId, $invoice['franchise_id'], $period['id']],
            );
            $fixed = $charged > 0 ? 0 : (int) ($link['fixed_satang'] ?? 0);
            $total = $pctAmount + $fixed;
            if ($total <= 0) {
                continue;
            }
            $id = Db::insert(
                "INSERT INTO sales_commissions
                   (sales_agent_id, franchise_id, period_id, invoice_id, kind, basis,
                    base_amount_satang, commission_pct_bp, pct_amount_satang, fixed_satang, total_satang, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'DEAL', ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
                [$agentId, $invoice['franchise_id'], $period['id'], $invoice['id'], $link['basis'], $base, $link['commission_pct_bp'], $pctAmount, $fixed, $total],
            );
            Audit::write($actorUserId, 'sales_commission.create', 'sales_commission', $id, ['agentId' => $agentId, 'total' => $total]);
            $created[] = $id;
        }

        return $created;
    }

    /**
     * คิดค่าคอมเซลของใบนี้ใหม่ หลังยอดในใบเปลี่ยน (เช่นเติมรายการเข้าบิลเดิม)
     * ลบแถวที่ยังไม่จ่ายทิ้งแล้วคิดใหม่ทั้งชุด — ส่วนคอมที่จ่ายเงินให้เซลไปแล้วไม่แตะ
     */
    public static function recalcCommissionForInvoice(array $invoice, array $period, ?int $actorUserId): array
    {
        $paidAgents = array_map('intval', array_column(
            Db::all("SELECT sales_agent_id FROM sales_commissions WHERE invoice_id = ? AND status = 'PAID'", [$invoice['id']]),
            'sales_agent_id',
        ));
        Db::exec("DELETE FROM sales_commissions WHERE invoice_id = ? AND status <> 'PAID'", [$invoice['id']]);

        return self::createCommissionForInvoice($invoice, $period, $actorUserId, $paidAgents);
    }

    /* ── ค่าคอมรายการอื่น ๆ ที่พิมพ์เองเป็นจำนวนเงิน ───────────── */

    /**
     * ค่าคอมที่ไม่ได้มาจากดีลสินค้า เช่นโบนัสปิดดีลใหญ่ หรือค่าเดินทางที่ตกลงกันไว้
     * ลงไปกองรวมกับคอมจากดีลในรอบเดียวกัน จะได้จ่ายทีเดียวจบและเห็นยอดรวมจริงของรอบนั้น
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
            throw ApiException::conflict('รายการที่ระบบคิดจากดีลแก้ตรงนี้ไม่ได้ — ต้องไปแก้ที่ดีลหรือใบเรียกเก็บ');
        }
        if ($row['status'] === 'PAID') {
            throw ApiException::conflict('จ่ายเงินให้เซลไปแล้ว แก้ไม่ได้');
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
            throw ApiException::conflict('ลบได้เฉพาะรายการที่พิมพ์เพิ่มเอง');
        }
        if ($row['status'] === 'PAID') {
            throw ApiException::conflict('จ่ายเงินให้เซลไปแล้ว ลบไม่ได้');
        }
        Db::exec('DELETE FROM sales_commissions WHERE id = ?', [$id]);
        Audit::write($actorUserId, 'sales_commission.manual_delete', 'sales_commission', $id, ['label' => $row['label'], 'amount' => Money::toBaht($row['total_satang'])]);

        return ['deleted' => true, 'id' => $id];
    }

    private const SELECT_COMMISSION = '
        SELECT c.*, a.username AS agent_username, a.name AS agent_name,
               f.username AS franchise_username,
               bp.code AS period_code, bp.start_date AS period_start, bp.end_date AS period_end,
               i.invoice_no, i.status AS invoice_status
          FROM sales_commissions c
          JOIN sales_agents a       ON a.id = c.sales_agent_id
          LEFT JOIN franchises f    ON f.id = c.franchise_id
          JOIN billing_periods bp   ON bp.id = c.period_id
          LEFT JOIN invoices i      ON i.id = c.invoice_id';

    /** อ่านแถวเดียวโดยไม่เช็คสิทธิ์ — ใช้ภายในหลังเพิ่ง insert/update เสร็จ */
    private static function getCommissionRaw(int $id): array
    {
        return self::serializeCommission(Db::one(self::SELECT_COMMISSION . ' WHERE c.id = ?', [$id]));
    }

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
            $where[]  = 'c.franchise_id = ?';
            $params[] = (int) $filters['franchiseId'];
        }
        if (! empty($filters['status'])) {
            $where[]  = 'c.status = ?';
            $params[] = $filters['status'];
        }
        if (! empty($filters['periodCode'])) {
            $where[]  = 'bp.code = ?';
            $params[] = $filters['periodCode'];
        }
        if (! empty($filters['fromPeriod']) && ! empty($filters['toPeriod'])) {
            $where[] = 'bp.code >= ? AND bp.code <= ?';
            array_push($params, $filters['fromPeriod'], $filters['toPeriod']);
        }
        $rows = array_map([self::class, 'serializeCommission'], Db::all(
            self::SELECT_COMMISSION . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY bp.start_date DESC, c.id DESC',
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

    /** บันทึกว่าจ่ายคอมให้เซลแล้ว */
    public static function markPaid(int $id, array $input, array $user): array
    {
        $row = Db::one('SELECT * FROM sales_commissions WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบรายการค่าคอม');
        if ($row['status'] === 'VOID') {
            throw ApiException::conflict('รายการนี้ถูกยกเลิกแล้ว');
        }
        if ($row['status'] === 'PAID') {
            throw ApiException::conflict('รายการนี้จ่ายไปแล้ว');
        }
        Db::exec(
            "UPDATE sales_commissions
                SET status = 'PAID', paid_at = COALESCE(?, UTC_TIMESTAMP()), note = ?, updated_at = UTC_TIMESTAMP()
              WHERE id = ?",
            [$input['paidAt'] ?? null, $input['note'] ?? $row['note'], $id],
        );
        Audit::write((int) $user['id'], 'sales_commission.pay', 'sales_commission', $id);

        return self::getCommission($id, $user);
    }

    public static function voidCommissionsForInvoice(int $invoiceId, int $actorUserId): int
    {
        $changes = Db::exec("UPDATE sales_commissions SET status = 'VOID', updated_at = UTC_TIMESTAMP() WHERE invoice_id = ? AND status <> 'PAID'", [$invoiceId]);
        if ($changes > 0) {
            Audit::write($actorUserId, 'sales_commission.void', 'invoice', $invoiceId, ['count' => $changes]);
        }

        return $changes;
    }

    public static function serializeCommission(array $row): array
    {
        $manual = $row['kind'] === 'MANUAL';

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
            'kind'              => $row['kind'],
            'isManual'          => $manual,
            'label'             => $row['label'],
            // ชื่อที่เอาไปโชว์ได้เลยโดยไม่ต้องแยกเคสที่หน้าจอ
            'title'         => $manual ? $row['label'] : ($row['franchise_username'] ?? '—'),
            'basis'         => $row['basis'],
            'basisLabel'    => $manual ? 'พิมพ์เพิ่มเอง' : ($row['basis'] === 'GROSS' ? 'ยอดขายเต็ม' : 'ส่วนต่างที่ร้านค้าจ่าย'),
            'baseAmount'    => Money::toBaht($row['base_amount_satang']),
            'commissionPct' => $row['commission_pct_bp'] === null ? null : Money::bpToPct($row['commission_pct_bp']),
            'pctAmount'     => Money::toBaht($row['pct_amount_satang']),
            'fixedAmount'   => Money::toBaht($row['fixed_satang']),
            'totalAmount'   => Money::toBaht($row['total_satang']),
            'status'        => $row['status'],
            'paidAt'        => $row['paid_at'],
            'note'          => $row['note'],
            'createdAt'     => $row['created_at'],
        ];
    }

    /** ภาพรวมสำหรับหน้าแรกของเซล */
    public static function dashboard(int $agentId): array
    {
        $agent    = self::get($agentId);
        $links    = self::listLinks($agentId);
        $byPeriod = array_map(static fn ($r) => [
            'periodCode'    => $r['period_code'],
            'startDate'     => $r['start_date'],
            'endDate'       => $r['end_date'],
            'entries'       => (int) $r['entries'],
            'totalAmount'   => Money::toBaht((int) $r['total_satang']),
            'pendingAmount' => Money::toBaht((int) $r['pending_satang']),
        ], Db::all(
            "SELECT bp.code AS period_code, bp.start_date, bp.end_date,
                    COUNT(*) AS entries,
                    COALESCE(SUM(c.total_satang), 0) AS total_satang,
                    COALESCE(SUM(CASE WHEN c.status = 'PENDING' THEN c.total_satang ELSE 0 END), 0) AS pending_satang
               FROM sales_commissions c
               JOIN billing_periods bp ON bp.id = c.period_id
              WHERE c.sales_agent_id = ? AND c.status <> 'VOID'
              GROUP BY bp.id, bp.code, bp.start_date, bp.end_date
              ORDER BY bp.start_date DESC
              LIMIT 12",
            [$agentId],
        ));

        return [
            'agent'    => $agent,
            'products' => $links,
            'byPeriod' => $byPeriod,
            'summary'  => [
                'activeProducts' => count(array_filter($links, static fn ($l) => $l['isActive'])),
                'pending'        => $agent['pendingCommission'],
                'paid'           => $agent['paidCommission'],
            ],
        ];
    }
}
