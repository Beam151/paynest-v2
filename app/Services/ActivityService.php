<?php

namespace App\Services;

use App\Libraries\Db;

/**
 * ประวัติรายการ — อ่านจาก audit_logs ที่ทุก service เขียนไว้อยู่แล้ว
 * แปลงเป็นข้อความภาษาคนให้อ่านรู้เรื่องโดยไม่ต้องเดาจากรหัส action
 */
final class ActivityService
{
    private const ACTION_TEXT = [
        'auth.login'                => 'เข้าสู่ระบบ',
        'auth.change_password'      => 'เปลี่ยนรหัสผ่าน',
        'turnstile.configure'       => 'เปิด captcha หน้าเข้าสู่ระบบ',
        'turnstile.disable'         => 'ปิด captcha หน้าเข้าสู่ระบบ',
        'franchise.create'          => 'สร้างร้านค้า',
        'franchise.update'          => 'แก้ไขข้อมูลร้าน',
        'product.create'            => 'เพิ่มสินค้า',
        'product.update'            => 'แก้ไขสินค้า',
        'product.delete'            => 'ลบสินค้า',
        'assignment.create'         => 'มอบหมายสิทธิ์ขาย',
        'assignment.update'         => 'แก้ไขการมอบหมาย',
        'assignment.end'            => 'ยกเลิกการมอบหมาย',
        'charge_item.create'        => 'เพิ่มรายการค่าใช้จ่าย/ส่วนลด',
        'charge_item.update'        => 'แก้ไขรายการค่าใช้จ่าย/ส่วนลด',
        'entry.create'              => 'บันทึกยอดขาย',
        'entry.update'              => 'แก้ยอดขาย',
        'entry.delete'              => 'ลบยอดขาย',
        'entry.approve'             => 'อนุมัติยอดขาย',
        'entry.reopen'              => 'เปิดยอดขายให้แก้ใหม่',
        'invoice.create'            => 'ออกใบเรียกเก็บ',
        'invoice.add_lines'         => 'เพิ่มรายการเข้าบิล',
        'invoice.adjustment.add'    => 'เพิ่มค่าใช้จ่าย/ส่วนลดในบิล',
        'invoice.adjustment.remove' => 'ลบค่าใช้จ่าย/ส่วนลดออกจากบิล',
        'invoice.payment'           => 'ตัดยอดในบิลแล้ว',
        'invoice.void'              => 'ยกเลิกใบเรียกเก็บ',
        'payment.submit'            => 'ลูกค้าแจ้งชำระเงิน',
        'payment.approve'           => 'ยืนยันว่าได้รับเงินแล้ว',
        'payment.reject'            => 'ปฏิเสธการแจ้งชำระ',
        'payment.cancel'            => 'ลูกค้ายกเลิกการแจ้งชำระ',
        'ledger.create'             => 'บันทึกรายรับ/รายจ่าย',
        'ledger.update'             => 'แก้ไขรายรับ/รายจ่าย',
        'ledger.delete'             => 'ลบรายรับ/รายจ่าย',
        'agent.create'              => 'เพิ่มเซล',
        'agent.update'              => 'แก้ไขข้อมูลเซล',
        'sales_link.create'         => 'ผูกดีลเซลกับสินค้า',
        'sales_link.update'         => 'แก้ไขดีลเซล',
        'sales_link.end'            => 'ปิดดีลเซล',
        'sales_commission.create'   => 'คิดค่าคอมเซล',
        'sales_commission.recalc'   => 'คิดค่าคอมเซลใหม่',
        'sales_commission.pay'      => 'จ่ายค่าคอมเซล',
        'sales_commission.void'     => 'ยกเลิกค่าคอมเซล',
    ];

    /** entity → วิธีหาชื่อที่คนอ่านรู้เรื่อง (id → ชื่อ) */
    private const NAME_LOOKUP = [
        'franchise'          => 'SELECT id, username AS name FROM franchises WHERE id IN ?',
        'product'            => 'SELECT id, sku AS name FROM products WHERE id IN ?',
        'invoice'            => 'SELECT id, invoice_no AS name FROM invoices WHERE id IN ?',
        'sales_agent'        => 'SELECT id, username AS name FROM sales_agents WHERE id IN ?',
        'charge_item'        => 'SELECT id, name FROM charge_items WHERE id IN ?',
        'ledger_entry'       => 'SELECT id, label AS name FROM ledger_entries WHERE id IN ?',
        'bank_account'       => "SELECT id, CONCAT(bank_name, ' ', account_number) AS name FROM bank_accounts WHERE id IN ?",
        'sales_entry'        => 'SELECT se.id, p.sku AS name FROM sales_entries se JOIN products p ON p.id = se.product_id WHERE se.id IN ?',
        'payment_submission' => 'SELECT ps.id, i.invoice_no AS name FROM payment_submissions ps JOIN invoices i ON i.id = ps.invoice_id WHERE ps.id IN ?',
        'assignment'         => 'SELECT pa.id, p.sku AS name FROM product_assignments pa JOIN products p ON p.id = pa.product_id WHERE pa.id IN ?',
        'sales_link'         => 'SELECT l.id, p.sku AS name FROM product_sales_links l JOIN products p ON p.id = l.product_id WHERE l.id IN ?',
        'sales_commission'   => 'SELECT c.id, a.username AS name FROM sales_commissions c JOIN sales_agents a ON a.id = c.sales_agent_id WHERE c.id IN ?',
    ];

    /** เติมชื่อของ entity ทีละกลุ่ม แทนการ join สิบตารางในคิวรีเดียว */
    private static function resolveNames(array $rows): array
    {
        $byEntity = [];
        foreach ($rows as $r) {
            if (! $r['entity'] || ! $r['entity_id'] || ! isset(self::NAME_LOOKUP[$r['entity']])) {
                continue;
            }
            $byEntity[$r['entity']][(int) $r['entity_id']] = true;
        }
        $names = [];
        foreach ($byEntity as $entity => $ids) {
            foreach (Db::all(self::NAME_LOOKUP[$entity], [array_keys($ids)]) as $row) {
                $names["{$entity}:{$row['id']}"] = $row['name'];
            }
        }

        return $names;
    }

    /** ของที่ถูกลบไปแล้วหาชื่อจากตารางไม่เจอ — ดึงจาก detail ที่บันทึกไว้ตอนเกิดเหตุแทน */
    private static function nameFromDetail(?string $raw): mixed
    {
        if (! $raw) {
            return null;
        }
        $d = json_decode($raw, true);
        if (! is_array($d)) {
            return null;
        }

        return $d['sku'] ?? $d['username'] ?? $d['invoiceNo'] ?? $d['name'] ?? $d['label'] ?? null;
    }

    /**
     * @param list<string>|null $actions prefix เช่น ['invoice', 'payment'] — ไม่ส่ง = ทุกอย่าง
     */
    public static function list(?array $actions, mixed $limit = 20, mixed $offset = 0): array
    {
        $where  = [];
        $params = [];
        if ($actions) {
            // จับด้วย prefix เพื่อให้ 'invoice' ครอบคลุม invoice.create / invoice.void / invoice.adjustment.add
            $where[] = '(' . implode(' OR ', array_fill(0, count($actions), 'a.action LIKE ?')) . ')';
            foreach ($actions as $p) {
                $params[] = addcslashes($p, '\\%_') . '%';
            }
        }
        $clause = $where ? 'WHERE ' . implode(' AND ', $where) : '';
        $take   = (int) $limit > 0 ? min((int) $limit, 200) : 20;
        $skip   = max((int) $offset, 0);
        $total  = Db::int("SELECT COUNT(*) FROM audit_logs a {$clause}", $params);
        $rows   = Db::all(
            "SELECT a.*, u.username AS actor_username
               FROM audit_logs a
               LEFT JOIN users u ON u.id = a.actor_user_id
              {$clause}
              ORDER BY a.id DESC
              LIMIT ? OFFSET ?",
            [...$params, $take, $skip],
        );
        $names = self::resolveNames($rows);

        return [
            'items' => array_map(static fn ($r) => [
                'id'       => (int) $r['id'],
                'at'       => $r['created_at'],
                'actor'    => $r['actor_username'] ?? 'ระบบ',
                'action'   => $r['action'],
                'what'     => self::ACTION_TEXT[$r['action']] ?? $r['action'],
                'target'   => $names["{$r['entity']}:{$r['entity_id']}"] ?? self::nameFromDetail($r['detail']),
                'entity'   => $r['entity'],
                'entityId' => $r['entity_id'] === null ? null : (int) $r['entity_id'],
            ], $rows),
            'total'   => $total,
            'hasMore' => $skip + count($rows) < $total,
        ];
    }
}
