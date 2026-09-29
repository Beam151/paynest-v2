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
 *
 * บัญชี USD = กระเป๋าคริปโต (เจ้าของเลือก: กรอกแค่ที่อยู่กระเป๋า + เครือข่าย + รูป QR) ไม่ใช่บัญชีธนาคารต่างประเทศ
 * เก็บในตารางเดียวกับบัญชีธนาคาร แต่ความหมายของช่องต่างไป:
 *   account_number = ที่อยู่กระเป๋า (ยาวได้ถึง 128 ตัว) · chain = เครือข่าย เช่น TRC20
 *   bank_name      = chain ซ้ำอีกช่อง — uq_bank_number (bank_name, account_number) จึงยังกันกระเป๋าซ้ำในเครือข่ายเดียวกันได้
 *                    และทุกที่ที่พิมพ์ bank_name ออกไป (ประวัติกิจกรรม ข้อความ error snapshot ที่แจ้งร้าน) จะเห็นเครือข่าย ไม่ใช่ช่องว่าง
 *   account_name   = '' และ branch = NULL — กระเป๋าไม่มีชื่อบัญชี/สาขา ค่าที่ค้างจากตอนเป็นบัญชีไทยจะหลอกคนที่ตรวจก่อนโอน
 */
final class BankAccountService
{
    public const CURRENCY_LABEL = ['THB' => 'บาท (THB)', 'USD' => 'ดอลลาร์ (USD)'];

    /*
     * เครือข่ายพิมพ์เองได้ (มีเครือข่ายใหม่เกิดตลอด) แต่ต้องเป็นชื่อสั้น ๆ ที่อ่านออก — ห้ามอักษรแปลก ๆ ที่ดูเหมือนกันแต่คนละตัว
     * ที่อยู่กระเป๋าห้ามมีช่องว่าง: ช่องว่างแปลว่าคัดลอกมาไม่ครบ/ติดข้อความอื่นมา โอนไปแล้วเงินหาย
     */
    public const CHAIN_RE  = '/^[A-Za-z0-9][A-Za-z0-9 ()._-]{1,31}$/D';
    public const WALLET_RE = '/^[A-Za-z0-9:_.-]{10,128}$/D';

    /**
     * ป้ายชื่อบัญชีแบบเดียวกันทั้งระบบ (หน้าเว็บ แจ้งเตือน ประวัติ หลักฐานแจ้งชำระ) — รับแถว snake_case แบบ bank_accounts
     * THB "ธนาคาร · เลขที่ (ชื่อบัญชี)" · USD "USD · เครือข่าย · ที่อยู่กระเป๋า" (กระเป๋าไม่มีชื่อบัญชี ใส่วงเล็บว่างจะดูเหมือนข้อมูลหาย)
     * แถวที่ join มากับบิลใช้ bank_currency ได้ — ช่อง currency ของแถวบิลคือสกุลของบิล ไม่ใช่ของบัญชี
     */
    public static function labelOf(array $row): string
    {
        $currency = $row['bank_currency'] ?? $row['currency'] ?? 'THB';
        if ($currency === 'USD') {
            $chain = (string) ($row['chain'] ?? $row['bank_chain'] ?? '');

            return 'USD · ' . ($chain !== '' ? $chain : (string) ($row['bank_name'] ?? '')) . ' · ' . $row['account_number'];
        }

        return "{$row['bank_name']} · {$row['account_number']} ({$row['account_name']})";
    }

    private const SELECT = "
        SELECT b.*,
               (SELECT COUNT(*) FROM invoices i
                 WHERE i.bank_account_id = b.id AND i.status <> 'VOID') AS invoice_count,
               (SELECT COUNT(*) FROM invoices i
                 WHERE i.bank_account_id = b.id AND i.status IN ('OPEN', 'PARTIAL')
                   AND i.net_total_satang > i.paid_satang) AS open_invoice_count
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

    /* ข้อความที่พิมพ์มา: ตัดช่องว่างหัวท้าย · ว่าง = ไม่มี (NULL) */
    private static function text(mixed $value): ?string
    {
        $s = trim((string) ($value ?? ''));

        return $s === '' ? null : $s;
    }

    /** แม่แบบของบัญชีใหม่ — create ใช้ทางเดียวกับ update จึงตรวจ "แถวที่จะได้" ด้วยกติกาชุดเดียวกัน */
    private const BLANK = [
        'id'             => null,
        'bank_name'      => '',
        'account_name'   => '',
        'account_number' => '',
        'branch'         => null,
        'note'           => null,
        'currency'       => 'THB',
        'chain'          => null,
        'qr_url'         => null,
        'status'         => 'ACTIVE',
        'is_default'     => 0,
    ];

    /** คอลัมน์ที่ create/update เขียนได้ (is_default แยกจัดการ เพราะต้องปลดธงของบัญชีอื่นด้วย) */
    private const COLUMNS = ['bank_name', 'account_name', 'account_number', 'branch', 'note', 'currency', 'chain', 'qr_url', 'status'];

    /**
     * ค่าของบัญชี "หลังบันทึก" (แถว snake_case) จากแถวเดิม + ช่องที่ส่งมา — ยังไม่ตรวจความถูกต้อง
     * ใช้ทั้งตัดสินว่าต้องยืนยันรหัส 6 หลักไหม (changes) และตอนบันทึกจริง (update) สองที่จึงเห็นตรงกันเสมอ
     * ช่องที่ไม่ใช้กับสกุลนั้นถูกทิ้ง: หน้าเว็บส่ง bankName/สาขามากับบัญชี USD ก็ไม่ทำให้ "เปลี่ยน" และไม่ต้องยืนยันรหัสเปล่า ๆ
     */
    private static function resolve(array $row, array $patch): array
    {
        $has  = static fn (string $key) => array_key_exists($key, $patch);
        $next = [...$row, 'chain' => $row['chain'] ?? null];
        if ($has('currency')) {
            $next['currency'] = $patch['currency'];
        }
        if ($has('note')) {
            $next['note'] = self::text($patch['note']);
        }
        if ($has('qrUrl')) {
            $next['qr_url'] = $patch['qrUrl'] === '' ? null : $patch['qrUrl'];
        }
        if ($has('status')) {
            $next['status'] = $patch['status'];
        }

        if ($next['currency'] === 'USD') {
            // ที่อยู่กระเป๋าตัดแค่หัวท้าย ไม่ลบช่องว่าง/ขีดข้างใน (ต่างจากเลขบัญชีไทย) — ที่อยู่ที่มีช่องว่างต้องถูกปฏิเสธ ไม่ใช่ถูก "ซ่อม" ให้
            if ($has('accountNumber')) {
                $next['account_number'] = trim((string) ($patch['accountNumber'] ?? ''));
            }
            $chain = $has('chain')
                ? (self::text($patch['chain']) ?? '')
                : (string) ($row['chain'] ?? (($row['currency'] ?? null) === 'USD' ? $row['bank_name'] : ''));

            return [...$next, 'chain' => $chain, 'bank_name' => $chain, 'account_name' => '', 'branch' => null];
        }

        if ($has('accountNumber')) {
            $next['account_number'] = self::normalizeNumber($patch['accountNumber']);
        }
        if ($has('bankName')) {
            $next['bank_name'] = trim((string) ($patch['bankName'] ?? ''));
        }
        if ($has('accountName')) {
            $next['account_name'] = trim((string) ($patch['accountName'] ?? ''));
        }
        if ($has('branch')) {
            $next['branch'] = self::text($patch['branch']);
        }

        return [...$next, 'chain' => null];
    }

    /**
     * ตรวจ "แถวที่จะได้หลังบันทึก" ตามสกุลของแถวนั้น ไม่ใช่ตรวจแค่ช่องที่ส่งมา
     * (ส่งที่อยู่ 0x… มาแก้บัญชี USD ต้องตรวจแบบที่อยู่กระเป๋า ไม่ใช่แบบเลขบัญชีไทย · เปลี่ยนสกุลต้องกรอกช่องของแบบใหม่ครบ)
     * $row = null คือสร้างใหม่ ตรวจทุกช่อง · แถวเดิมตรวจเฉพาะช่องที่ค่าจะเปลี่ยน —
     * บัญชีที่เกิดก่อนมีกติกานี้ (เช่นบัญชี USD เดิมที่ chain = ชื่อธนาคาร) ยังปิดใช้งาน/แก้หมายเหตุได้ ไม่ต้องกรอกใหม่ทั้งแถว
     */
    private static function assertValid(array $next, ?array $row, array $patch): void
    {
        self::assertCurrency($next['currency']);
        $switched = $row !== null && $row['currency'] !== $next['currency'];
        $touched  = static fn (string $col) => $row === null || $switched || (string) ($next[$col] ?? '') !== (string) ($row[$col] ?? '');
        $wallet   = $next['currency'] === 'USD';

        // เปลี่ยนแบบบัญชี = ค่าเดิมของอีกแบบใช้ต่อไม่ได้ (เลขบัญชีไทยไม่ใช่ที่อยู่กระเป๋า) ต้องกรอกช่องของแบบใหม่มาเอง
        $need = $wallet ? ['chain', 'accountNumber'] : ['bankName', 'accountName', 'accountNumber'];
        if ($switched && array_diff($need, array_keys($patch)) !== []) {
            throw ApiException::badRequest($wallet
                ? 'เปลี่ยนเป็นบัญชี USD (กระเป๋าคริปโต) ต้องกรอกเครือข่าย (chain) และที่อยู่กระเป๋า (wallet address) มาด้วย'
                : 'เปลี่ยนเป็นบัญชีธนาคารไทย ต้องกรอกธนาคาร ชื่อบัญชี และเลขที่บัญชีมาด้วย');
        }
        if ($wallet) {
            if ($touched('chain') && ! preg_match(self::CHAIN_RE, (string) $next['chain'])) {
                throw ApiException::badRequest('ต้องระบุเครือข่าย (chain) เช่น TRC20');
            }
            if ($touched('account_number') && ! preg_match(self::WALLET_RE, (string) $next['account_number'])) {
                throw ApiException::badRequest('ที่อยู่กระเป๋า (wallet address) ไม่ถูกต้อง — คัดลอกมาทั้งชุด ห้ามมีช่องว่าง');
            }
        } else {
            if ($touched('bank_name') && $next['bank_name'] === '') {
                throw ApiException::badRequest('ต้องระบุชื่อธนาคาร');
            }
            if ($touched('account_name') && $next['account_name'] === '') {
                throw ApiException::badRequest('ต้องระบุชื่อบัญชี');
            }
            if ($touched('account_number') && ! preg_match('/^\d{6,20}$/', (string) $next['account_number'])) {
                throw ApiException::badRequest('เลขที่บัญชีต้องเป็นตัวเลข 6–20 หลัก');
            }
        }
        if (array_key_exists('qrUrl', $patch)) {
            self::assertQrUrl($patch['qrUrl']);
        }
        if (($patch['isDefault'] ?? null) === true && $next['status'] !== 'ACTIVE') {
            throw ApiException::badRequest('บัญชีที่ปิดใช้งานอยู่ตั้งเป็นบัญชีหลักไม่ได้');
        }
        if (($touched('bank_name') || $touched('account_number'))
            && Db::one('SELECT id FROM bank_accounts WHERE bank_name = ? AND account_number = ? AND id <> ?', [$next['bank_name'], $next['account_number'], $row['id'] ?? 0])) {
            throw ApiException::conflict($wallet
                ? "กระเป๋าเครือข่าย {$next['chain']} ที่อยู่นี้มีอยู่แล้ว — ใช้บัญชีเดิม (ถ้าปิดใช้งานอยู่ให้เปิดใช้งานแทน)"
                : "บัญชี {$next['bank_name']} เลขที่ {$next['account_number']} มีอยู่แล้ว");
        }
    }

    /*
     * ช่องที่กำหนดว่าเงินของร้านจะไปลงที่ไหน — แก้ช่องไหนก็ต้องยืนยันรหัส + เตือนแอดมินทุกคน
     * เหลือแค่สาขากับหมายเหตุที่แก้ได้อิสระ เพราะไม่มีผลกับปลายทางของเงิน
     * เครือข่าย (chain) ก็เป็นปลายทาง: ที่อยู่เดิมแต่คนละเครือข่าย = เงินไปคนละที่ หรือหายไปเลย
     *
     * สถานะกับบัญชีหลักอยู่ในนี้ด้วย: ปิดบัญชีหลัก หรือตั้งบัญชีอื่นเป็นหลัก
     * = บิลที่ออกใหม่ย้ายไปลงบัญชีอื่นทันที ทั้งที่ไม่ได้แตะเลขบัญชีเลย
     */
    private const ROUTING_FIELDS = [
        'bankName'      => 'bank_name',
        'accountName'   => 'account_name',
        'accountNumber' => 'account_number',
        'chain'         => 'chain',
        'qrUrl'         => 'qr_url',
        'currency'      => 'currency',
        'status'        => 'status',
    ];

    /** ชื่อช่องของกระเป๋า USD ที่ต่างจากบัญชีไทย — จดลงรายการเปลี่ยนแปลงไปด้วย แอดมินจะไม่อ่าน "เลขที่บัญชี" แล้วงงว่าทำไมเป็นตัวอักษร */
    private const WALLET_FIELD_LABEL = ['accountNumber' => 'ที่อยู่กระเป๋า (wallet address)'];

    /** เทียบแถวเดิมกับแถวหลังแก้ — คืนเฉพาะช่องปลายทางเงินที่ค่าเปลี่ยนจริง */
    private static function diffRouting(array $row, array $next, array $patch): array
    {
        $wallet = $next['currency'] === 'USD';
        $out    = [];
        foreach (self::ROUTING_FIELDS as $key => $column) {
            $from = $row[$column] ?? null;
            $to   = $next[$column] ?? null;
            // กระเป๋า: bank_name คือ chain ซ้ำอีกช่อง — โชว์เป็น "เครือข่าย (chain)" บรรทัดเดียว ไม่ให้เห็นซ้ำสองบรรทัด
            if ($from === $to || ($wallet && $key === 'bankName')) {
                continue;
            }
            $out[] = ['field' => $key, 'from' => $from, 'to' => $to]
                + ($wallet && isset(self::WALLET_FIELD_LABEL[$key]) ? ['fieldLabel' => self::WALLET_FIELD_LABEL[$key]] : []);
        }
        if (($patch['isDefault'] ?? null) === true && ! (int) $row['is_default']) {
            $out[] = ['field' => 'isDefault', 'from' => false, 'to' => true];
        }

        return $out;
    }

    /**
     * แก้ครั้งนี้เปลี่ยนปลายทางเงินไหม — ใช้ตัดสินว่าต้องยืนยันรหัส 6 หลักหรือเปล่า
     * (หน้าเว็บส่งทุกช่องมาทุกครั้ง จึงดูแค่ว่ามี key ไม่ได้ ต้องเทียบค่ากับของเดิม)
     * ไม่ตรวจความถูกต้องตรงนี้ — ถ้าเปลี่ยนปลายทาง ต้องผ่านรหัส 6 หลักก่อนจะได้รู้ว่าค่าไหนผิด
     */
    public static function changes(int $id, array $patch): array
    {
        $row = Db::one('SELECT * FROM bank_accounts WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบบัญชีธนาคาร');

        return self::diffRouting($row, self::resolve($row, $patch), $patch);
    }

    private static function openInvoicesOf(int $id): int
    {
        return Db::int("SELECT COUNT(*) FROM invoices WHERE bank_account_id = ? AND status IN ('OPEN', 'PARTIAL')", [$id]);
    }

    /** บิลที่ยังต้องโอนเข้าบัญชีนี้ (ค้างจ่ายจริง) — ร้านของบิลพวกนี้คือคนที่เห็นเลขบัญชีเปลี่ยน */
    private static function openBillsOf(int $id): array
    {
        return Db::all(
            "SELECT id, invoice_no FROM invoices
              WHERE bank_account_id = ? AND status IN ('OPEN', 'PARTIAL') AND net_total_satang > paid_satang
              ORDER BY id",
            [$id],
        );
    }

    private const FIELD_LABEL = [
        'bankName'      => 'ธนาคาร',
        'accountName'   => 'ชื่อบัญชี',
        'accountNumber' => 'เลขที่บัญชี',
        'chain'         => 'เครือข่าย (chain)',
        'qrUrl'         => 'รูป QR',
        'currency'      => 'สกุลเงิน',
        'status'        => 'สถานะ',
        'isDefault'     => 'บัญชีหลัก',
        // เปลี่ยนบัญชีปลายทางของบิลใบเดียว (ค่า = ป้ายชื่อบัญชี) — ดู NotificationService::invoiceAccountChanged
        'invoiceAccount' => 'บัญชีของบิล',
    ];

    /* ช่องที่ร้านใช้โอนจริง — แก้ช่องพวกนี้ ข้อความ Telegram ที่ร้านเคยได้จะไม่ตรงกับหน้าเว็บทันที */
    private const SHOP_VISIBLE_FIELDS = ['bankName', 'accountName', 'accountNumber', 'chain', 'currency', 'qrUrl'];

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
    public static function thaiTime(): string
    {
        $now = \App\Libraries\Clock::thaiNow();

        return (int) $now->format('j') . ' ' . Period::THAI_MONTHS[(int) $now->format('n') - 1] . ' ' . ((int) $now->format('Y') + 543) . ' ' . $now->format('H:i');
    }

    /**
     * ข้อความที่ส่งเข้า Telegram — ต้องอ่านจบในข้อความเดียวว่าใครแก้อะไร และต้องทำอะไรต่อ
     * $openBills = เลขบิลค้างจ่ายที่ร้านเห็นบัญชีเปลี่ยน (เฉพาะตอนแก้ช่องที่ร้านใช้โอน)
     */
    private static function changeMessage(string $label, string $kind, array $changes, ?int $actorUserId, int $openInvoices, array $openBills = []): string
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
                [$from, $to] = [self::valueText($c['field'], $c['from']), self::valueText($c['field'], $c['to'])];
                // ลิงก์รูปไม่ส่งออกไป จึงบอกได้แค่ว่ารูปเพิ่ม/ถอด/เปลี่ยน — "มีรูป → มีรูป" อ่านแล้วนึกว่าไม่มีอะไรเปลี่ยน
                if ($c['field'] === 'qrUrl' && $c['from'] && $c['to']) {
                    [$from, $to] = ['รูปเดิม', 'รูปใหม่'];
                }
                $lines[] = ($c['fieldLabel'] ?? self::FIELD_LABEL[$c['field']] ?? $c['field']) . ': '
                    . TelegramService::escapeHtml($from) . ' → <b>' . TelegramService::escapeHtml($to) . '</b>';
            }
        }
        if ($openInvoices > 0) {
            array_push($lines, '', "⚠ บิลค้างจ่าย {$openInvoices} ใบชี้บัญชีนี้อยู่ — ร้านจะเห็นข้อมูลใหม่ทันที");
        }
        if ($openBills !== []) {
            $nos = array_map(static fn ($b) => TelegramService::escapeHtml($b['invoice_no']), array_slice($openBills, 0, 10));
            $lines[] = 'บิลที่ได้รับผลกระทบ: ' . implode(', ', $nos) . (count($openBills) > 10 ? ' และอีก ' . (count($openBills) - 10) . ' ใบ' : '');
            // ระบบไม่ส่งเลขใหม่ให้ร้านเอง — คนร้ายที่แก้บัญชีได้จะให้ระบบบอกร้านให้โอนเข้าบัญชีโจรไม่ได้
            $lines[] = '⚠ ร้านยังไม่ได้รับเลขบัญชีใหม่ทาง Telegram — ตรวจว่าถูกต้องแล้วกด "📨 ส่งเลขบัญชีให้ร้านที่มีบิลค้าง" ที่หน้าบัญชีรับเงิน'
                . ' (ระหว่างนี้ร้านจะเห็นว่าบัญชีไม่ตรงกับ Telegram และจะไม่โอน)';
        }
        array_push($lines, '', 'ถ้าไม่ได้เป็นคนแก้: เปลี่ยนรหัสผ่านแอดมินทันที แล้วแก้บัญชีกลับ');

        return implode("\n", $lines);
    }

    /**
     * จดการเปลี่ยนแปลงลง bank_account_changes (แก้/ลบไม่ได้ — trigger กันไว้) → ขึ้นแถบเตือนแอดมินจนกว่าจะกดรับทราบ
     * ใช้ทั้งแก้ตัวบัญชี และเปลี่ยนบัญชีของบิลใบเดียว (NotificationService::invoiceAccountChanged) — คืน id ไว้ผูกกับข้อความ Telegram
     */
    public static function logChange(?int $accountId, string $label, string $kind, array $changes, int $openInvoices, ?int $actorUserId): int
    {
        return Db::insert(
            'INSERT INTO bank_account_changes (bank_account_id, account_label, kind, changes, open_invoices, actor_user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
            [$accountId, $label, $kind, Json::encode($changes), $openInvoices, $actorUserId],
        );
    }

    private static function recordChange(?int $accountId, string $label, string $kind, array $changes, ?int $actorUserId): void
    {
        $openInvoices = $accountId ? self::openInvoicesOf($accountId) : 0;
        $changeId     = self::logChange($accountId, $label, $kind, $changes, $openInvoices, $actorUserId);
        $touchesShop  = $kind === 'UPDATE' && array_intersect(array_column($changes, 'field'), self::SHOP_VISIBLE_FIELDS) !== [];
        $openBills    = $accountId && $touchesShop ? self::openBillsOf($accountId) : [];
        NotificationService::notify('bank_account.change', self::changeMessage($label, $kind, $changes, $actorUserId, $openInvoices, $openBills), ['changeId' => $changeId]);
    }

    public static function create(array $input, int $actorUserId): array
    {
        $input['currency'] ??= 'THB';
        $next  = self::resolve([...self::BLANK, 'currency' => $input['currency']], $input);
        self::assertValid($next, null, $input);
        $wallet = $next['currency'] === 'USD';

        return Db::tx(static function () use ($input, $next, $wallet, $actorUserId) {
            // บัญชีแรกของระบบเป็นบัญชีหลักให้เลย ไม่งั้นออกบิลแล้วไม่มีบัญชีให้ร้านโอน
            $isFirst     = Db::int('SELECT COUNT(*) FROM bank_accounts') === 0;
            $wantDefault = ($input['isDefault'] ?? null) === true || $isFirst;
            if ($wantDefault) {
                Db::exec('UPDATE bank_accounts SET is_default = 0 WHERE is_default = 1');
            }
            $id = Db::insert(
                'INSERT INTO bank_accounts (bank_name, account_name, account_number, branch, note, is_default, currency, chain, qr_url, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
                [
                    $next['bank_name'], $next['account_name'], $next['account_number'], $next['branch'], $next['note'],
                    $wantDefault ? 1 : 0, $next['currency'], $next['chain'], $next['qr_url'],
                ],
            );
            $changes = $wallet
                ? [
                    ['field' => 'chain', 'from' => null, 'to' => $next['chain']],
                    ['field' => 'accountNumber', 'from' => null, 'to' => $next['account_number'], 'fieldLabel' => self::WALLET_FIELD_LABEL['accountNumber']],
                ]
                : [
                    ['field' => 'bankName', 'from' => null, 'to' => $next['bank_name']],
                    ['field' => 'accountName', 'from' => null, 'to' => $next['account_name']],
                    ['field' => 'accountNumber', 'from' => null, 'to' => $next['account_number']],
                ];
            $changes[] = ['field' => 'currency', 'from' => null, 'to' => $next['currency']];
            if ($next['qr_url']) {
                $changes[] = ['field' => 'qrUrl', 'from' => null, 'to' => $next['qr_url']];
            }
            if ($wantDefault) {
                $changes[] = ['field' => 'isDefault', 'from' => false, 'to' => true];
            }
            self::recordChange($id, self::labelOf($next), 'CREATE', $changes, $actorUserId);
            Audit::write($actorUserId, 'bank_account.create', 'bank_account', $id, [
                'bankName'      => $next['bank_name'],
                'accountNumber' => $next['account_number'],
                'isDefault'     => $wantDefault,
                'currency'      => $next['currency'],
                ...($wallet ? ['chain' => $next['chain']] : []),
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
            throw ApiException::badRequest('บัญชี ' . self::labelOf($row) . ' ถูกปิดใช้งานแล้ว');
        }
        if ($currency && $row['currency'] !== $currency) {
            throw ApiException::badRequest(
                'บัญชี ' . self::labelOf($row) . ' เป็นบัญชี' . self::CURRENCY_LABEL[$row['currency']] . ' '
                . 'รับบิลสกุล' . self::CURRENCY_LABEL[$currency] . 'ไม่ได้ — เลือกบัญชีที่รับ' . self::CURRENCY_LABEL[$currency] . ' หรือเพิ่มบัญชีใหม่ก่อน',
            );
        }

        return (int) $row['id'];
    }

    public static function update(int $id, array $patch, int $actorUserId): array
    {
        $row  = Db::one('SELECT * FROM bank_accounts WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบบัญชีธนาคาร');
        $next = self::resolve($row, $patch);
        /*
         * เปลี่ยนสกุลของบัญชีที่ผูกบิลไปแล้วไม่ได้
         * บิลเก่าตรึงบัญชีใบนี้ไว้ ถ้าสกุลเปลี่ยนทีหลังบิลพวกนั้นจะกลายเป็นชี้บัญชีผิดสกุลย้อนหลัง
         * (บาท ↔ USD ยังเปลี่ยนแบบบัญชีด้วย: บัญชีธนาคารไทย ↔ กระเป๋าคริปโต — ยิ่งห้ามย้อนหลัง)
         */
        if ($next['currency'] !== $row['currency']) {
            $used = Db::int("SELECT COUNT(*) FROM invoices WHERE bank_account_id = ? AND status <> 'VOID'", [$id]);
            if ($used > 0) {
                throw ApiException::conflict("บัญชีนี้ผูกกับใบเรียกเก็บอยู่ {$used} ใบ เปลี่ยนสกุลเงินไม่ได้ — ให้เพิ่มบัญชีใหม่สำหรับอีกสกุลแทน");
            }
        }
        self::assertValid($next, $row, $patch);
        $changes = self::diffRouting($row, $next, $patch);

        return Db::tx(static function () use ($id, $row, $next, $patch, $changes, $actorUserId) {
            // เขียนเฉพาะช่องที่ค่าเปลี่ยนจริง — หน้าเว็บส่งทุกช่องมาทุกครั้ง บันทึกซ้ำค่าเดิมไม่ต้องมีประวัติรก ๆ
            $sets   = [];
            $params = [];
            foreach (self::COLUMNS as $column) {
                if (($next[$column] ?? null) !== ($row[$column] ?? null)) {
                    $sets[]   = "{$column} = ?";
                    $params[] = $next[$column];
                }
            }
            if (($patch['isDefault'] ?? null) === true && ! (int) $row['is_default']) {
                Db::exec('UPDATE bank_accounts SET is_default = 0 WHERE is_default = 1 AND id <> ?', [$id]);
                $sets[] = 'is_default = 1';
            }
            // ปิดใช้งานบัญชีหลัก = ระบบจะไม่เหลือบัญชีตั้งต้น ต้องปลดธงออกด้วย
            if ($next['status'] === 'INACTIVE' && (int) $row['is_default']) {
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

    /**
     * ส่งเลขบัญชี (ตามที่บัญชีนี้เป็นอยู่ตอนนี้) ให้ทุกร้านที่มีบิลค้างจ่ายชี้บัญชีนี้ — หลังแก้เลข/ชื่อ/QR ของบัญชีแล้วตรวจแล้วว่าถูก
     * ระบบไม่ส่งเองตอนแก้บัญชี (ดู NotificationService) ต้องมีคนกดปุ่มนี้พร้อมรหัส 6 หลัก
     * แต่ละบิลที่บัญชีต่างจากที่เคยบอกร้าน กลุ่มส่วนกลางได้ข้อความแจ้งแยกทุกใบ
     *
     * @return array{invoices: int, sent: int, notified: int, items: list<array>} invoices = บิลที่ส่ง · sent = จำนวนคนที่เข้าคิว
     */
    public static function notifyShops(int $id, array $actor): array
    {
        $row = Db::one('SELECT * FROM bank_accounts WHERE id = ?', [$id]) ?? throw ApiException::notFound('ไม่พบบัญชีธนาคาร');
        if (! TelegramService::isConfigured()) {
            throw ApiException::badRequest('ยังไม่ได้ตั้งค่า Telegram ของระบบ — ตั้งค่าที่หน้าตั้งค่าแจ้งเตือนก่อน จึงจะส่งเลขบัญชีให้ร้านได้');
        }
        $items = [];
        foreach (self::openBillsOf($id) as $bill) {
            try {
                $r = NotificationService::notifyBillAccount((int) $bill['id'], $actor);
            } catch (ApiException) {
                continue; // บิลเพิ่งถูกจ่ายครบ/ยกเลิกระหว่างทาง — ไม่ต้องส่งแล้ว
            }
            $items[] = ['invoiceId' => (int) $bill['id'], 'invoiceNo' => $bill['invoice_no'], 'sent' => $r['sent'], 'changed' => $r['changed']];
        }
        $sent = array_sum(array_column($items, 'sent'));
        Audit::write(isset($actor['id']) ? (int) $actor['id'] : null, 'bank_account.notify_shops', 'bank_account', $id, [
            'account'    => self::labelOf($row),
            'invoices'   => count($items),
            'sent'       => $sent,
            'invoiceNos' => array_column($items, 'invoiceNo'),
        ]);

        return [
            'invoices' => count($items),
            'sent'     => $sent,
            // บิลที่มีคนในร้านได้รับจริง (ร้านที่ยังไม่เชื่อม Telegram = 0 ต้องแจ้งร้านเองทางอื่น)
            'notified' => count(array_filter($items, static fn ($i) => $i['sent'] > 0)),
            'items'    => $items,
        ];
    }

    public static function serialize(array $row): array
    {
        $currency = $row['currency'] ?? 'THB';
        $wallet   = $currency === 'USD';

        return [
            'id'            => (int) $row['id'],
            // กระเป๋า USD: bankName = เครือข่าย, accountName = '' (ดูหัวไฟล์) — คงคีย์เดิมไว้ให้หน้าเว็บ/สคริปต์เก่าไม่พัง
            'bankName'      => $row['bank_name'],
            'accountName'   => $row['account_name'],
            'accountNumber' => $row['account_number'],
            'branch'        => $row['branch'],
            'note'          => $row['note'],
            'isDefault'     => (int) $row['is_default'] === 1,
            'currency'      => $currency,
            'currencyLabel' => self::CURRENCY_LABEL[$currency],
            'chain'         => $wallet ? (($row['chain'] ?? null) ?: $row['bank_name']) : null,
            'isWallet'      => $wallet,
            'qrUrl'         => SignedUrl::sign($row['qr_url']),
            'status'        => $row['status'],
            'invoiceCount'  => (int) ($row['invoice_count'] ?? 0),
            // บิลค้างจ่ายที่ชี้บัญชีนี้ — หน้าบัญชีรับเงินใช้ตัดสินว่าจะโชว์ปุ่ม "ส่งเลขบัญชีให้ร้านที่มีบิลค้าง" ไหม
            'openInvoiceCount' => (int) ($row['open_invoice_count'] ?? 0),
            // ข้อความพร้อมโชว์ให้ร้านคัดลอกไปโอน ไม่ต้องประกอบเองทุกที่
            'label'     => self::labelOf($row),
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
            'changes'       => array_map(static fn ($c) => [
                ...(($c['field'] ?? null) === 'qrUrl'
                    ? [...$c, 'from' => SignedUrl::sign($c['from'] ?? null), 'to' => SignedUrl::sign($c['to'] ?? null)]
                    : $c),
                // ชื่อช่องที่จดไว้ตอนเปลี่ยน (เช่น "ที่อยู่กระเป๋า" ของบัญชี USD) ชนะชื่อกลาง
                'fieldLabel' => $c['fieldLabel'] ?? self::FIELD_LABEL[$c['field'] ?? ''] ?? ($c['field'] ?? ''),
            ], $changes),
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
