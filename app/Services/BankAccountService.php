<?php

namespace App\Services;

use App\Libraries\ApiException;
use App\Libraries\Db;
use App\Libraries\Json;
use App\Libraries\Period;
use App\Libraries\SignedUrl;

/**
 * บัญชีธนาคารที่ใช้รับเงินจากร้านค้า
 *
 * มีได้หลายบัญชี แล้วเลือกตอนออกบิลว่าใบนี้ให้โอนเข้าอันไหน
 * บัญชีที่ตั้งเป็น "บัญชีหลัก" จะถูกเลือกให้อัตโนมัติ
 *
 * บิลที่ออกไปแล้วจะจำบัญชี ณ ตอนนั้นไว้ตลอด ถึงจะเปลี่ยนบัญชีหลักทีหลัง
 * บิลเก่าก็ยังชี้บัญชีเดิม — ร้านที่ถือบิลไว้จะได้ไม่โอนผิดที่
 */
final class BankAccountService
{
    public const CURRENCY_LABEL = ['THB' => 'บาท (THB)', 'USD' => 'ดอลลาร์ (USD)'];

    private const SELECT = "
        SELECT b.*,
               (SELECT COUNT(*) FROM invoices i
                 WHERE i.bank_account_id = b.id AND i.status <> 'VOID') AS invoice_count
          FROM bank_accounts b";

    /*
     * รับเฉพาะไฟล์ที่อัปโหลดผ่าน /api/uploads — ไม่รับลิงก์ภายนอก
     * กติกาเดียวกับสลิป ลิงก์ข้างนอกพังเมื่อไหร่ก็ได้ แล้วร้านสแกนจ่ายไม่ได้
     */
    public const UPLOAD_RE = '/^\/api\/uploads\/[0-9a-f]{32}\.(jpg|png|gif|webp|pdf)$/';

    /** เลขบัญชีเก็บเฉพาะตัวเลข ขีดกับเว้นวรรคที่คนพิมพ์มาไม่ต้องเก็บ */
    private static function normalizeNumber(mixed $value): string
    {
        return preg_replace('/[\s-]/u', '', (string) ($value ?? '')) ?? '';
    }

    private static function assertQrUrl(mixed $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (! is_string($value) || ! preg_match(self::UPLOAD_RE, $value)) {
            throw ApiException::badRequest('รูป QR ต้องเป็นไฟล์ที่อัปโหลดผ่านระบบ (ไม่รับลิงก์ภายนอก)');
        }

        return $value;
    }

    private static function assertCurrency(mixed $value): string
    {
        if (! is_string($value) || ! isset(self::CURRENCY_LABEL[$value])) {
            throw ApiException::badRequest('สกุลเงินของบัญชีต้องเป็น THB หรือ USD');
        }

        return $value;
    }

    /*
     * ช่องที่กำหนดว่าเงินของร้านจะไปลงที่ไหน — แก้ช่องไหนก็ต้องยืนยันรหัส + เตือนแอดมินทุกคน
     * เหลือแค่สาขากับหมายเหตุที่แก้ได้อิสระ เพราะไม่มีผลกับปลายทางของเงิน
     *
     * สถานะกับบัญชีหลักอยู่ในนี้ด้วย: ปิดบัญชีหลัก หรือตั้งบัญชีอื่นเป็นหลัก
     * = บิลที่ออกใหม่ย้ายไปลงบัญชีอื่นทันที ทั้งที่ไม่ได้แตะเลขบัญชีเลย
     */
    private const ROUTING_FIELDS = [
        'bankName'      => 'bank_name',
        'accountName'   => 'account_name',
        'accountNumber' => 'account_number',
        'qrUrl'         => 'qr_url',
        'currency'      => 'currency',
        'status'        => 'status',
    ];

    private static function normalizeRouting(string $key, array $patch): mixed
    {
        if (! array_key_exists($key, $patch)) {
            return self::class; // ไม่ได้ส่งมา
        }
        $value = $patch[$key];
        if ($key === 'accountNumber') {
            return self::normalizeNumber($value);
        }
        if ($key === 'qrUrl') {
            return $value === '' ? null : $value;
        }

        return is_string($value) ? trim($value) : $value;
    }

    /** เทียบ patch กับบัญชีปัจจุบัน — คืนเฉพาะช่องที่ค่าเปลี่ยนจริง */
    private static function diffRouting(array $row, array $patch): array
    {
        $out = [];
        foreach (self::ROUTING_FIELDS as $key => $column) {
            $next = self::normalizeRouting($key, $patch);
            if ($next === self::class || $next === $row[$column]) {
                continue;
            }
            $out[] = ['field' => $key, 'from' => $row[$column], 'to' => $next];
        }
        if (($patch['isDefault'] ?? null) === true && ! (int) $row['is_default']) {
            $out[] = ['field' => 'isDefault', 'from' => false, 'to' => true];
        }

        return $out;
    }

    /**
     * แก้ครั้งนี้เปลี่ยนปลายทางเงินไหม — ใช้ตัดสินว่าต้องยืนยันรหัส 6 หลักหรือเปล่า
     * (หน้าเว็บส่งทุกช่องมาทุกครั้ง จึงดูแค่ว่ามี key ไม่ได้ ต้องเทียบค่ากับของเดิม)
     */
    public static function changes(int $id, array $patch): array
    {
        $row = Db::one('SELECT * FROM bank_accounts WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบบัญชีธนาคาร');

        return self::diffRouting($row, $patch);
    }

    private static function openInvoicesOf(int $id): int
    {
        return Db::int("SELECT COUNT(*) FROM invoices WHERE bank_account_id = ? AND status IN ('OPEN', 'PARTIAL')", [$id]);
    }

    private static function labelOf(array $row): string
    {
        return "{$row['bank_name']} · {$row['account_number']} ({$row['account_name']})";
    }

    private const FIELD_LABEL = [
        'bankName'      => 'ธนาคาร',
        'accountName'   => 'ชื่อบัญชี',
        'accountNumber' => 'เลขที่บัญชี',
        'qrUrl'         => 'รูป QR',
        'currency'      => 'สกุลเงิน',
        'status'        => 'สถานะ',
        'isDefault'     => 'บัญชีหลัก',
    ];

    private const KIND_LABEL = ['CREATE' => '➕ เพิ่มบัญชีรับเงินใหม่', 'UPDATE' => '✏️ แก้ไขบัญชีรับเงิน', 'DELETE' => '🗑 ลบบัญชีรับเงิน'];

    private static function valueText(string $field, mixed $value): string
    {
        if ($value === null || $value === '') {
            return '—';
        }

        return match ($field) {
            'qrUrl'     => 'มีรูป', // ลิงก์รูปไม่ส่งออกไป — ให้เปิดดูในระบบ
            'isDefault' => $value ? 'ใช่' : 'ไม่ใช่',
            'status'    => $value === 'ACTIVE' ? 'เปิดใช้งาน' : 'ปิดใช้งาน',
            default     => is_bool($value) ? ($value ? 'true' : 'false') : (string) $value,
        };
    }

    /** "26 ก.ย. 2569 16:05" เวลาไทย */
    private static function thaiTime(): string
    {
        $now = \App\Libraries\Clock::thaiNow();

        return (int) $now->format('j') . ' ' . Period::THAI_MONTHS[(int) $now->format('n') - 1] . ' ' . ((int) $now->format('Y') + 543) . ' ' . $now->format('H:i');
    }

    /** ข้อความที่ส่งเข้า Telegram — ต้องอ่านจบในข้อความเดียวว่าใครแก้อะไร และต้องทำอะไรต่อ */
    private static function changeMessage(string $label, string $kind, array $changes, ?int $actorUserId, int $openInvoices): string
    {
        $actor = $actorUserId ? Db::one('SELECT username, display_name FROM users WHERE id = ?', [$actorUserId]) : null;
        $lines = [
            '🚨 <b>' . self::KIND_LABEL[$kind] . '</b>',
            TelegramService::escapeHtml($label),
            'โดย: <b>' . TelegramService::escapeHtml($actor ? (($actor['display_name'] ?? $actor['username']) . " ({$actor['username']})") : 'ระบบ') . '</b>',
            'เวลา: ' . self::thaiTime(),
        ];
        if ($kind !== 'CREATE' && $changes !== []) {
            $lines[] = '';
            foreach ($changes as $c) {
                $lines[] = (self::FIELD_LABEL[$c['field']] ?? $c['field']) . ': '
                    . TelegramService::escapeHtml(self::valueText($c['field'], $c['from'])) . ' → <b>'
                    . TelegramService::escapeHtml(self::valueText($c['field'], $c['to'])) . '</b>';
            }
        }
        if ($openInvoices > 0) {
            array_push($lines, '', "⚠ บิลค้างจ่าย {$openInvoices} ใบชี้บัญชีนี้อยู่ — ร้านจะเห็นข้อมูลใหม่ทันที");
        }
        array_push($lines, '', 'ถ้าไม่ได้เป็นคนแก้: เปลี่ยนรหัสผ่านแอดมินทันที แล้วแก้บัญชีกลับ');

        return implode("\n", $lines);
    }

    private static function recordChange(?int $accountId, string $label, string $kind, array $changes, ?int $actorUserId): void
    {
        $openInvoices = $accountId ? self::openInvoicesOf($accountId) : 0;
        $changeId     = Db::insert(
            'INSERT INTO bank_account_changes (bank_account_id, account_label, kind, changes, open_invoices, actor_user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
            [$accountId, $label, $kind, Json::encode($changes), $openInvoices, $actorUserId],
        );
        NotificationService::notify('bank_account.change', self::changeMessage($label, $kind, $changes, $actorUserId, $openInvoices), ['changeId' => $changeId]);
    }

    public static function create(array $input, int $actorUserId): array
    {
        $bankName      = trim((string) ($input['bankName'] ?? ''));
        $accountName   = trim((string) ($input['accountName'] ?? ''));
        $accountNumber = self::normalizeNumber($input['accountNumber'] ?? null);
        $currency      = self::assertCurrency($input['currency'] ?? 'THB');
        $qrUrl         = self::assertQrUrl($input['qrUrl'] ?? null);

        if ($bankName === '') {
            throw ApiException::badRequest('ต้องระบุชื่อธนาคาร');
        }
        if ($accountName === '') {
            throw ApiException::badRequest('ต้องระบุชื่อบัญชี');
        }
        if (! preg_match('/^\d{6,20}$/', $accountNumber)) {
            throw ApiException::badRequest('เลขที่บัญชีต้องเป็นตัวเลข 6–20 หลัก');
        }
        if (Db::one('SELECT id FROM bank_accounts WHERE bank_name = ? AND account_number = ?', [$bankName, $accountNumber])) {
            throw ApiException::conflict("บัญชี {$bankName} เลขที่ {$accountNumber} มีอยู่แล้ว");
        }

        return Db::tx(static function () use ($input, $bankName, $accountName, $accountNumber, $currency, $qrUrl, $actorUserId) {
            // บัญชีแรกของระบบเป็นบัญชีหลักให้เลย ไม่งั้นออกบิลแล้วไม่มีบัญชีให้ร้านโอน
            $isFirst     = Db::int('SELECT COUNT(*) FROM bank_accounts') === 0;
            $wantDefault = ($input['isDefault'] ?? null) === true || $isFirst;
            if ($wantDefault) {
                Db::exec('UPDATE bank_accounts SET is_default = 0 WHERE is_default = 1');
            }
            $id = Db::insert(
                'INSERT INTO bank_accounts (bank_name, account_name, account_number, branch, note, is_default, currency, qr_url, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
                [$bankName, $accountName, $accountNumber, $input['branch'] ?? null, $input['note'] ?? null, $wantDefault ? 1 : 0, $currency, $qrUrl],
            );
            $changes = [
                ['field' => 'bankName', 'from' => null, 'to' => $bankName],
                ['field' => 'accountName', 'from' => null, 'to' => $accountName],
                ['field' => 'accountNumber', 'from' => null, 'to' => $accountNumber],
                ['field' => 'currency', 'from' => null, 'to' => $currency],
            ];
            if ($qrUrl) {
                $changes[] = ['field' => 'qrUrl', 'from' => null, 'to' => $qrUrl];
            }
            if ($wantDefault) {
                $changes[] = ['field' => 'isDefault', 'from' => false, 'to' => true];
            }
            self::recordChange($id, "{$bankName} · {$accountNumber} ({$accountName})", 'CREATE', $changes, $actorUserId);
            Audit::write($actorUserId, 'bank_account.create', 'bank_account', $id, [
                'bankName'      => $bankName,
                'accountNumber' => $accountNumber,
                'isDefault'     => $wantDefault,
                'currency'      => $currency,
            ]);

            return self::get($id);
        });
    }

    public static function get(int $id): array
    {
        return self::serialize(Db::one(self::SELECT . ' WHERE b.id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบบัญชีธนาคาร'));
    }

    public static function list(?string $status = null): array
    {
        $rows = array_map([self::class, 'serialize'], Db::all(
            self::SELECT . ($status ? ' WHERE b.status = ?' : '') . ' ORDER BY b.is_default DESC, b.bank_name, b.id',
            $status ? [$status] : [],
        ));
        $default = null;
        foreach ($rows as $r) {
            if ($r['isDefault']) {
                $default = $r['id'];
                break;
            }
        }

        return [
            'items'   => $rows,
            'summary' => [
                'count'     => count($rows),
                'active'    => count(array_filter($rows, static fn ($r) => $r['status'] === 'ACTIVE')),
                'defaultId' => $default,
            ],
        ];
    }

    /** บัญชีที่จะถูกใช้อัตโนมัติตอนออกบิล (null ได้ถ้ายังไม่เคยสร้างบัญชีเลย) */
    public static function defaultId(string $currency = 'THB'): ?int
    {
        // บัญชีหลักใช้ได้ต่อเมื่อรับสกุลเดียวกับบิล ไม่งั้นหยิบบัญชีที่รับสกุลนั้นมาแทน
        $id = Db::val("SELECT id FROM bank_accounts WHERE status = 'ACTIVE' AND currency = ? ORDER BY is_default DESC, id LIMIT 1", [$currency]);

        return $id === null ? null : (int) $id;
    }

    /**
     * เช็กก่อนผูกกับบิล — บัญชีที่ปิดใช้งานแล้วเอามาออกบิลใหม่ไม่ได้
     * บัญชีต้องรับสกุลเดียวกับบิล — เลขบัญชีเงินบาทกับบัญชีเงินตราต่างประเทศเป็นคนละใบ โอนผิดใบเงินไม่เข้า
     */
    public static function assertUsable(?int $id, ?string $currency): ?int
    {
        if ($id === null) {
            return null;
        }
        $row = Db::one('SELECT * FROM bank_accounts WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบบัญชีธนาคารที่เลือก');
        if ($row['status'] !== 'ACTIVE') {
            throw ApiException::badRequest("บัญชี {$row['bank_name']} {$row['account_number']} ถูกปิดใช้งานแล้ว");
        }
        if ($currency && $row['currency'] !== $currency) {
            throw ApiException::badRequest(
                "บัญชี {$row['bank_name']} {$row['account_number']} เป็นบัญชี" . self::CURRENCY_LABEL[$row['currency']] . ' '
                . 'รับบิลสกุล' . self::CURRENCY_LABEL[$currency] . 'ไม่ได้ — เลือกบัญชีที่รับ' . self::CURRENCY_LABEL[$currency] . ' หรือเพิ่มบัญชีใหม่ก่อน',
            );
        }

        return (int) $row['id'];
    }

    private const FIELDS = [
        'bankName'    => 'bank_name',
        'accountName' => 'account_name',
        'branch'      => 'branch',
        'note'        => 'note',
        'status'      => 'status',
    ];

    public static function update(int $id, array $patch, int $actorUserId): array
    {
        $row     = Db::one('SELECT * FROM bank_accounts WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบบัญชีธนาคาร');
        $changes = self::diffRouting($row, $patch);

        return Db::tx(static function () use ($id, $row, $patch, $changes, $actorUserId) {
            $sets   = [];
            $params = [];
            foreach (self::FIELDS as $key => $column) {
                if (! array_key_exists($key, $patch)) {
                    continue;
                }
                $value = is_string($patch[$key]) ? trim($patch[$key]) : $patch[$key];
                if ($column === 'bank_name' && ! $value) {
                    throw ApiException::badRequest('ต้องระบุชื่อธนาคาร');
                }
                if ($column === 'account_name' && ! $value) {
                    throw ApiException::badRequest('ต้องระบุชื่อบัญชี');
                }
                $sets[]   = "{$column} = ?";
                $params[] = $value === '' ? null : $value;
            }
            if (array_key_exists('qrUrl', $patch)) {
                $sets[]   = 'qr_url = ?';
                $params[] = self::assertQrUrl($patch['qrUrl']);
            }
            if (array_key_exists('accountNumber', $patch)) {
                $number = self::normalizeNumber($patch['accountNumber']);
                if (! preg_match('/^\d{6,20}$/', $number)) {
                    throw ApiException::badRequest('เลขที่บัญชีต้องเป็นตัวเลข 6–20 หลัก');
                }
                if (Db::one('SELECT id FROM bank_accounts WHERE bank_name = ? AND account_number = ? AND id <> ?', [$patch['bankName'] ?? $row['bank_name'], $number, $id])) {
                    throw ApiException::conflict('มีบัญชีเลขนี้ของธนาคารนี้อยู่แล้ว');
                }
                $sets[]   = 'account_number = ?';
                $params[] = $number;
            }
            /*
             * เปลี่ยนสกุลของบัญชีที่ผูกบิลไปแล้วไม่ได้
             * บิลเก่าตรึงบัญชีใบนี้ไว้ ถ้าสกุลเปลี่ยนทีหลังบิลพวกนั้นจะกลายเป็นชี้บัญชีผิดสกุลย้อนหลัง
             */
            if (array_key_exists('currency', $patch) && $patch['currency'] !== $row['currency']) {
                $used = Db::int("SELECT COUNT(*) FROM invoices WHERE bank_account_id = ? AND status <> 'VOID'", [$id]);
                if ($used > 0) {
                    throw ApiException::conflict("บัญชีนี้ผูกกับใบเรียกเก็บอยู่ {$used} ใบ เปลี่ยนสกุลเงินไม่ได้ — ให้เพิ่มบัญชีใหม่สำหรับอีกสกุลแทน");
                }
                $sets[]   = 'currency = ?';
                $params[] = self::assertCurrency($patch['currency']);
            }
            if (($patch['isDefault'] ?? null) === true) {
                if (($patch['status'] ?? $row['status']) !== 'ACTIVE') {
                    throw ApiException::badRequest('บัญชีที่ปิดใช้งานอยู่ตั้งเป็นบัญชีหลักไม่ได้');
                }
                Db::exec('UPDATE bank_accounts SET is_default = 0 WHERE is_default = 1 AND id <> ?', [$id]);
                $sets[] = 'is_default = 1';
            }
            // ปิดใช้งานบัญชีหลัก = ระบบจะไม่เหลือบัญชีตั้งต้น ต้องปลดธงออกด้วย
            if (($patch['status'] ?? null) === 'INACTIVE' && (int) $row['is_default']) {
                $sets[] = 'is_default = 0';
            }
            if ($sets === []) {
                return self::get($id);
            }
            $sets[]   = 'updated_at = UTC_TIMESTAMP()';
            $params[] = $id;
            Db::exec('UPDATE bank_accounts SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
            if ($changes !== []) {
                self::recordChange($id, self::labelOf($row), 'UPDATE', $changes, $actorUserId);
            }
            Audit::write($actorUserId, 'bank_account.update', 'bank_account', $id, $patch);

            return self::get($id);
        });
    }

    /**
     * ลบบัญชี — ลบได้เฉพาะที่ยังไม่เคยผูกกับบิลใบไหน
     * ถ้าเคยใช้แล้วให้ปิดใช้งานแทน เพราะบิลเก่าต้องชี้บัญชีเดิมได้ตลอด
     */
    public static function delete(int $id, int $actorUserId): array
    {
        $row  = Db::one('SELECT * FROM bank_accounts WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบบัญชีธนาคาร');
        $used = Db::int('SELECT COUNT(*) FROM invoices WHERE bank_account_id = ?', [$id]);
        if ($used > 0) {
            throw ApiException::conflict("บัญชีนี้ผูกกับใบเรียกเก็บอยู่ {$used} ใบ ลบไม่ได้ — ให้กด \"ปิดใช้งาน\" แทน บิลเก่าจะได้ยังชี้บัญชีเดิมไว้ถูกต้อง");
        }
        Db::tx(static function () use ($id, $row, $actorUserId) {
            self::recordChange($id, self::labelOf($row), 'DELETE', [], $actorUserId);
            Db::exec('DELETE FROM bank_accounts WHERE id = ?', [$id]);
        });
        Audit::write($actorUserId, 'bank_account.delete', 'bank_account', $id, ['bankName' => $row['bank_name'], 'accountNumber' => $row['account_number']]);

        return ['deleted' => true, 'id' => $id];
    }

    public static function serialize(array $row): array
    {
        $currency = $row['currency'] ?? 'THB';

        return [
            'id'            => (int) $row['id'],
            'bankName'      => $row['bank_name'],
            'accountName'   => $row['account_name'],
            'accountNumber' => $row['account_number'],
            'branch'        => $row['branch'],
            'note'          => $row['note'],
            'isDefault'     => (int) $row['is_default'] === 1,
            'currency'      => $currency,
            'currencyLabel' => self::CURRENCY_LABEL[$currency],
            'qrUrl'         => SignedUrl::sign($row['qr_url']),
            'status'        => $row['status'],
            'invoiceCount'  => (int) ($row['invoice_count'] ?? 0),
            // ข้อความพร้อมโชว์ให้ร้านคัดลอกไปโอน ไม่ต้องประกอบเองทุกที่
            'label'     => "{$row['bank_name']} · {$row['account_number']} ({$row['account_name']})",
            'createdAt' => $row['created_at'],
        ];
    }

    /* ── แจ้งเตือนแอดมินเมื่อบัญชีรับเงินถูกเปลี่ยน ───────────────── */

    private static function serializeChange(array $row): array
    {
        $changes = json_decode((string) $row['changes'], true) ?: [];

        return [
            'id'            => (int) $row['id'],
            'bankAccountId' => $row['bank_account_id'] === null ? null : (int) $row['bank_account_id'],
            'accountLabel'  => $row['account_label'],
            'kind'          => $row['kind'],
            'changes'       => array_map(static fn ($c) => ($c['field'] ?? null) === 'qrUrl'
                ? [...$c, 'from' => SignedUrl::sign($c['from'] ?? null), 'to' => SignedUrl::sign($c['to'] ?? null)]
                : $c, $changes),
            'openInvoices' => (int) $row['open_invoices'],
            'actor'        => $row['actor_username']
                ? ['id' => (int) $row['actor_user_id'], 'username' => $row['actor_username'], 'displayName' => $row['actor_display_name']]
                : null,
            'createdAt' => $row['created_at'],
            'telegram'  => $row['tg_status'] ? ['status' => $row['tg_status'], 'error' => $row['tg_error']] : null,
        ];
    }

    /**
     * การเปลี่ยนแปลงที่แอดมินคนนี้ยังไม่ได้กดรับทราบ
     * ไม่เอาของก่อนที่เขาจะมีบัญชี (แอดมินใหม่ไม่ต้องไล่รับทราบประวัติเก่าทั้งหมด)
     * และไม่เกิน 90 วัน — เก่ากว่านั้นดูได้จากประวัติกิจกรรม
     */
    public static function listUnreadChanges(int $userId): array
    {
        $items = array_map([self::class, 'serializeChange'], Db::all(
            'SELECT c.*, u.username AS actor_username, u.display_name AS actor_display_name,
                    o.status AS tg_status, o.last_error AS tg_error
               FROM bank_account_changes c
               LEFT JOIN users u ON u.id = c.actor_user_id
               LEFT JOIN telegram_outbox o ON o.change_id = c.id
               JOIN users me ON me.id = ?
              WHERE c.created_at >= me.created_at
                AND c.created_at >= UTC_TIMESTAMP() - INTERVAL 90 DAY
                AND NOT EXISTS (SELECT 1 FROM bank_account_change_acks a WHERE a.change_id = c.id AND a.user_id = me.id)
              ORDER BY c.id DESC',
            [$userId],
        ));

        return ['items' => $items, 'count' => count($items)];
    }

    /** รับทราบ — เฉพาะของตัวเอง แอดมินคนอื่นยังเห็นอยู่จนกว่าจะกดเอง */
    public static function ackChange(int $changeId, int $userId): array
    {
        if (! Db::one('SELECT id FROM bank_account_changes WHERE id = ?', [$changeId])) {
            throw ApiException::notFound('ไม่พบรายการเปลี่ยนแปลงนี้');
        }
        Db::exec('INSERT IGNORE INTO bank_account_change_acks (change_id, user_id, acked_at) VALUES (?, ?, UTC_TIMESTAMP())', [$changeId, $userId]);
        Audit::write($userId, 'bank_account.change_ack', 'bank_account_change', $changeId);

        return ['ok' => true];
    }
}
