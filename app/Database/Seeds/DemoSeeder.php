<?php

namespace App\Database\Seeds;

use App\Libraries\Db;
use App\Services\AssignmentService;
use App\Services\BankAccountService;
use App\Services\ChargeItemService;
use App\Services\FranchiseService;
use App\Services\InvoiceService;
use App\Services\PaymentSubmissionService;
use App\Services\PeriodService;
use App\Services\ProductService;
use App\Services\SalesAgentService;
use App\Services\SalesService;
use App\Services\UserService;
use CodeIgniter\CLI\CLI;
use CodeIgniter\Database\Seeder;
use RuntimeException;
use Throwable;

/**
 * ข้อมูลตัวอย่างขนาดใช้งานจริง — 10 ร้าน สินค้าครบ ย้อนหลัง 8 รอบบิล
 *   php spark app:install && php spark db:seed DemoSeeder
 *
 * ตัวเลขทุกตัวสุ่มจาก seed คงที่ (mulberry32 ตัวเดียวกับระบบเดิม) — รันกี่ครั้งก็ได้ข้อมูลชุดเดิม
 * เทียบผลรายงานข้ามเครื่องได้ และได้ตัวเลขชุดเดียวกับระบบเดิมเป๊ะ
 *
 * ข้อมูลตัวอย่างใช้รหัสผ่านที่เขียนไว้ใน README — ใครก็รู้ จึงรันบน production ไม่ได้
 */
class DemoSeeder extends Seeder
{
    private int $state = 20260921;

    /* ── ตัวสุ่มแบบกำหนด seed (mulberry32) — ต้องได้ลำดับเดียวกับ JavaScript ทุกบิต ── */

    private static function int32(int $x): int
    {
        $x &= 0xFFFFFFFF;

        return $x >= 0x80000000 ? $x - 0x100000000 : $x;
    }

    private static function imul(int $a, int $b): int
    {
        $a &= 0xFFFFFFFF;
        $b &= 0xFFFFFFFF;
        $lo = ($a & 0xFFFF) * ($b & 0xFFFF);
        $mid = ((($a >> 16) & 0xFFFF) * ($b & 0xFFFF) + ($a & 0xFFFF) * (($b >> 16) & 0xFFFF)) & 0xFFFF;

        return self::int32($lo + ($mid << 16));
    }

    private static function ushr(int $x, int $n): int
    {
        return ($x & 0xFFFFFFFF) >> $n;
    }

    private function rnd(): float
    {
        $this->state = self::int32($this->state + 0x6D2B79F5);
        $s           = $this->state;
        $t           = self::imul($s ^ self::ushr($s, 15), 1 | $s);
        $t           = self::int32(self::int32($t + self::imul($t ^ self::ushr($t, 7), 61 | $t)) ^ $t);

        return (($t ^ self::ushr($t, 14)) & 0xFFFFFFFF) / 4294967296;
    }

    /** Math.round ของ JavaScript (ปัดครึ่งขึ้นเสมอ ไม่มีการปัดล่วงหน้าแบบ round() ของ PHP) */
    private static function jsRound(float $x): float
    {
        $f = floor($x);

        return $x - $f >= 0.5 ? $f + 1 : $f;
    }

    /** สุ่มจำนวนเงินแล้วปัดเป็นหลักร้อย ให้ดูเหมือนยอดขายจริงมากกว่าเลขเศษ ๆ */
    private function amountBetween(float $min, float $max): int
    {
        return (int) (self::jsRound(($min + $this->rnd() * ($max - $min)) / 100) * 100);
    }

    private function pick(array $items): mixed
    {
        return $items[(int) floor($this->rnd() * count($items))];
    }

    public function run()
    {
        if (ENVIRONMENT === 'production') {
            throw new RuntimeException('ห้ามรัน seed บน production — ข้อมูลตัวอย่างใช้รหัสผ่านที่เผยแพร่อยู่ใน README');
        }
        // เครื่องนักพัฒนา: ใช้รหัสตาม README (ตัวสร้างแอดมินจริงปฏิเสธรหัสนี้เพราะมันเป็นรหัสสาธารณะ)
        if (! Db::one("SELECT 1 FROM users WHERE role = 'SUPER_ADMIN'")) {
            UserService::create(['username' => config('Paynest')->seedSuperAdminUser, 'password' => 'admin1234', 'displayName' => 'ผู้ดูแลระบบส่วนกลาง', 'role' => 'SUPER_ADMIN']);
        }
        if (Db::int('SELECT COUNT(*) FROM franchises') > 0) {
            CLI::write('มีข้อมูลอยู่แล้ว — ข้ามการ seed (ใช้ php spark app:reset ก่อนถ้าต้องการล้าง)', 'yellow');

            return;
        }
        // ล้างสลิปของข้อมูลชุดก่อนทิ้ง ไม่ให้ไฟล์ค้างสะสมทุกครั้งที่ reset
        SampleImages::clear();
        $admin = Db::one("SELECT * FROM users WHERE role = 'SUPER_ADMIN' ORDER BY id LIMIT 1");
        $adminId = (int) $admin['id'];

        /* ── รอบบิลที่จะสร้างย้อนหลัง ── */
        $periods   = ['2026-06-H1', '2026-06-H2', '2026-07-H1', '2026-07-H2', '2026-08-H1', '2026-08-H2', '2026-09-H1', '2026-09-H2'];
        $startDate = '2026-06-01';

        /* ── 1) ร้านค้า 10 ราย ── */
        $shopsInput = [
            ['username' => 'bkk01', 'contactName' => 'สมศักดิ์ จันทร์เพ็ญ', 'phone' => '0811111111', 'note' => 'สาขาสยาม'],
            ['username' => 'bkk02', 'contactName' => 'วรรณา ศรีสุข', 'phone' => '0822222222', 'note' => 'สาขาลาดพร้าว'],
            ['username' => 'bkk03', 'contactName' => 'ธนพล ทองดี', 'phone' => '0833333333', 'note' => 'สาขาบางนา'],
            ['username' => 'cnx01', 'contactName' => 'ปรียา ใจดี', 'phone' => '0844444444', 'note' => 'สาขานิมมาน'],
            ['username' => 'cnx02', 'contactName' => 'กิตติ วงศ์คำ', 'phone' => '0855555555', 'note' => 'สาขาเชียงใหม่เมือง'],
            ['username' => 'hdy01', 'contactName' => 'อารีย์ บุญมา', 'phone' => '0866666666', 'note' => 'สาขาหาดใหญ่'],
            ['username' => 'kkc01', 'contactName' => 'ประสิทธิ์ แก้วมณี', 'phone' => '0877777777', 'note' => 'สาขาขอนแก่น'],
            ['username' => 'psk01', 'contactName' => 'มานพ สุขสวัสดิ์', 'phone' => '0888888888', 'note' => 'สาขาพิษณุโลก'],
            ['username' => 'ryg01', 'contactName' => 'จิราภรณ์ พงษ์ศรี', 'phone' => '0899999999', 'note' => 'สาขาระยอง'],
            ['username' => 'nma01', 'contactName' => 'สุรชัย ภักดี', 'phone' => '0801234567', 'note' => 'สาขานครราชสีมา'],
        ];
        $shops = array_map(static fn ($s) => FranchiseService::create([...$s, 'password' => 'franchise1234'], $adminId), $shopsInput);

        // ร้านใหญ่ 3 ร้านมีผู้ช่วยเพิ่ม (ส่วนกลางเพิ่มให้ไม่ได้ — เจ้าของบัญชีเป็นคนเพิ่มเอง)
        foreach ([[0, 'ธุรการ'], [1, 'บัญชี'], [3, 'ผู้จัดการร้าน']] as [$i, $title]) {
            UserService::create([
                'username'    => $shops[$i]['franchise']['username'] . '-staff',
                'password'    => 'staff123456',
                'displayName' => "ผู้ช่วย ({$title})",
                'role'        => 'FRANCHISE',
                'franchiseId' => $shops[$i]['franchise']['id'],
                'isOwner'     => false,
            ]);
        }

        /* ── 2) สินค้า 18 รายการ — แต่ละชิ้นตั้ง % ส่วนต่างของตัวเอง ── */
        $productsInput = [
            ['COFFEE-KIT', 10, 'ชุดอุปกรณ์ชงกาแฟ'], ['BEAN-ARBC', 12, 'เมล็ดอาราบิก้าคั่วกลาง 1 กก.'],
            ['BEAN-ROBS', 11.5, 'เมล็ดโรบัสต้าคั่วเข้ม 1 กก.'], ['MILK-TEA', 12, 'ผงชานมสูตรต้นตำรับ'],
            ['MATCHA-JP', 9.5, 'ผงมัทฉะเกรดพรีเมียม'], ['COCOA-BAR', 13, 'ผงโกโก้เข้มข้น'],
            ['SYRUP-SET', 10, 'ชุดไซรัป 6 รสชาติ'], ['CUP-16OZ', 11, 'แก้วพลาสติก 16 ออนซ์ (50 ใบ)'],
            ['CUP-PAPER', 12.5, 'แก้วกระดาษร้อน (50 ใบ)'], ['LID-DOME', 10.5, 'ฝาโดม (100 ชิ้น)'],
            ['STRAW-ECO', 14, 'หลอดย่อยสลายได้ (200 ชิ้น)'], ['BAG-KRAFT', 15, 'ถุงกระดาษคราฟท์ (100 ใบ)'],
            ['MACHINE-E', 6, 'เครื่องชงเอสเพรสโซ่'], ['GRINDER-P', 7, 'เครื่องบดเมล็ดกาแฟ'],
            ['BLENDER-X', 6.5, 'เครื่องปั่นความเร็วสูง'], ['ICE-MAKER', 5, 'เครื่องทำน้ำแข็ง'],
            ['UNIFORM-A', 8, 'ชุดยูนิฟอร์มพนักงาน'], ['SIGN-LED', 7.5, 'ป้ายไฟ LED หน้าร้าน'],
        ];
        $products = array_map(static fn ($p) => ProductService::create(['sku' => $p[0], 'commissionPct' => $p[1], 'name' => $p[2]], $adminId), $productsInput);

        /*
         * สินค้ากลุ่มตัวอย่าง — COFFEE-KIT เป็น "ชุด" อยู่แล้วตามชื่อ ติ๊กสินค้าย่อยให้เห็นป้ายกลุ่ม/"ประกอบด้วย" ทุกหน้า
         * ทำก่อนมียอดขายและบิล บิลตัวอย่างจึงจดรายการย่อยไว้ครบ · ไม่ดึงเลขสุ่มเพิ่ม ตัวเลขเงินทุกตัวยังเท่าชุดเดิม
         */
        ProductService::update($products[0]['id'], [
            'isGroup'        => true,
            'itemProductIds' => array_map(static fn ($i) => $products[$i]['id'], [13, 1, 8, 9]), // GRINDER-P · BEAN-ARBC · CUP-PAPER · LID-DOME
        ], $adminId);

        /*
         * ── 3) มอบหมายสินค้า — 1 สินค้า = 1 ร้านเท่านั้น ──
         * แจกวนให้ทั่วทุกร้าน แล้วเว้น 2 ชิ้นท้ายไว้ยังไม่มอบหมาย ให้มีตัวอย่าง "สินค้าที่ยังว่าง"
         */
        $assignable = array_slice($products, 0, count($products) - 2);
        foreach ($assignable as $i => $p) {
            AssignmentService::assign(['productId' => $p['id'], 'franchiseId' => $shops[$i % count($shops)]['franchise']['id'], 'startDate' => $startDate], $adminId);
        }

        /*
         * ── 4) ยอดขายย้อนหลัง 8 รอบ ──
         * สินค้าแต่ละชิ้นมี "ฐานยอด" ของตัวเอง แล้วแกว่ง ±35% ในแต่ละรอบ · บางรอบเว้นไม่ขายบ้าง
         */
        $bases = [];
        foreach ($assignable as $p) {
            $bases[$p['id']] = $this->amountBetween(45000, 260000);
        }
        foreach ($periods as $periodCode) {
            foreach ($assignable as $p) {
                // รอบล่าสุดยังเก็บยอดไม่ครบ (เหมือนใช้งานจริงกลางรอบ) — ใส่แค่บางร้าน
                if ($periodCode === '2026-09-H2' && $this->rnd() < 0.55) {
                    continue;
                }
                if ($this->rnd() < 0.08) {
                    continue; // รอบที่ร้านไม่ได้ขายสินค้าชิ้นนี้เลย
                }
                $base = $bases[$p['id']];
                SalesService::upsert(['periodCode' => $periodCode, 'productId' => $p['id'], 'grossAmount' => $this->amountBetween($base * 0.65, $base * 1.35)], $admin);
            }
        }

        /*
         * ── 5) เซล 5 คน + ดีลที่ผูกกับสินค้า (เรตอยู่ที่ดีล ไม่ได้ติดตัวเซล · % คิดจากยอดขายเต็มเสมอ) ──
         * sale05 ไม่ถือดีลสินค้าเลย — ตัวอย่างเซลที่ได้แต่ "ค่าคอมอื่น ๆ" (เช่นค่าแนะนำร้าน)
         */
        $agentsInput = [
            ['sale01', 'สมชาย ทองอยู่ (ภาคกลาง)', '0891112222', 5, 300],
            ['sale02', 'สุดา คำแสน (ภาคเหนือ)', '0893334444', 8, null],
            ['sale03', 'ณัฐพงษ์ ดวงแก้ว (ภาคใต้)', '0895556666', 6, 500],
            ['sale04', 'พิมพ์ใจ อินทร์ทอง (อีสาน)', '0897778888', 7, null],
            ['sale05', 'ธีรวัฒน์ ศรีวงศ์ (ตัวแทนแนะนำร้าน)', '0899990000', null, null],
        ];
        $agents = array_map(static fn ($a) => SalesAgentService::create(['username' => $a[0], 'name' => $a[1], 'phone' => $a[2], 'password' => 'sale1234567'], $adminId), $agentsInput);

        /*
         * ตั้งใจให้บางร้านมีสินค้าของเซลคนละคนปนกัน (บิลร้านใบเดียวมีรายการให้เซลหลายคน) และเว้นบางชิ้นไว้ไม่มีเซลถือ
         * ใส่วันเริ่มย้อนหลังผ่าน API (หน้าเว็บไม่มีช่องวันที่ — ดีลใหม่เริ่มวันที่กด) ให้ตารางดีลดูเหมือนถือมาตั้งแต่ต้น
         */
        $deals = [[0, 0], [0, 1], [0, 2], [0, 10], [1, 3], [1, 4], [1, 11], [2, 5], [2, 12], [3, 6], [3, 7], [3, 13]];
        foreach ($deals as [$ai, $pi]) {
            SalesAgentService::linkProduct([
                'salesAgentId'  => $agents[$ai]['agent']['id'],
                'productId'     => $products[$pi]['id'],
                'commissionPct' => $agentsInput[$ai][3],
                'fixedAmount'   => $agentsInput[$ai][4],
                'startDate'     => $startDate,
            ], $adminId);
        }

        /* ── บัญชีรับเงิน — บัญชีแรกเป็นบัญชีหลักอัตโนมัติ · QR ตัวอย่างสแกนไม่ติด ใช้ดูหน้าตาเท่านั้น ── */
        $banks = [
            ['bankName' => 'กสิกรไทย', 'accountName' => 'บจก. เซ็นทรัลซัพพลาย', 'accountNumber' => '1234567890', 'branch' => 'สีลม', 'note' => 'บัญชีหลักของบริษัท'],
            ['bankName' => 'ไทยพาณิชย์', 'accountName' => 'บจก. เซ็นทรัลซัพพลาย', 'accountNumber' => '9876543210', 'branch' => 'อโศก'],
            ['bankName' => 'กรุงเทพ', 'accountName' => 'บจก. เซ็นทรัลซัพพลาย', 'accountNumber' => '5551234567', 'note' => 'ใช้กับร้านต่างจังหวัด'],
            /*
             * บิลสกุลดอลลาร์ต้องมีบัญชีที่รับดอลลาร์รออยู่ — บัญชี USD คือกระเป๋าคริปโต (เครือข่าย + ที่อยู่กระเป๋า)
             * ที่อยู่นี้ปลอมชัด ๆ (มีคำว่า Demo) ห้ามใครเอาไปโอนจริง
             */
            ['currency' => 'USD', 'chain' => 'TRC20', 'accountNumber' => 'TDemoWalletAddress000000000000000', 'note' => 'กระเป๋า USDT ตัวอย่าง (ที่อยู่ปลอม) ใช้กับร้านที่จ่ายเป็นดอลลาร์'],
        ];
        foreach ($banks as $i => $bank) {
            BankAccountService::create([...$bank, 'qrUrl' => SampleImages::qr($i + 1)], $adminId);
        }

        // อัตราแลกเปลี่ยนของแต่ละรอบ — ตั้งก่อนออกบิล เพราะบิลตรึงอัตรา ณ ตอนออกไว้กับตัวเอง
        foreach ([36.10, 36.45, 35.90, 36.30, 36.75, 36.20, 35.85, 36.25] as $i => $rate) {
            PeriodService::ensure($periods[$i]);
            PeriodService::setUsdRate($periods[$i], $rate, $adminId);
        }

        /* ── 6) ออกใบเรียกเก็บย้อนหลัง มิ.ย.–ส.ค. (ก.ย. เว้นไว้ให้ลองกดออกเอง) ── */
        $charges  = array_column(ChargeItemService::list(), null, 'name');
        $invoices = [];
        foreach (array_slice($periods, 0, 6) as $periodCode) {
            foreach ($shops as $shop) {
                // ค่าใช้จ่าย/ส่วนลดไม่ได้ติดทุกใบ ให้ดูเหมือนคิดเป็นราย ๆ ไป
                $adjustments = [['chargeItemId' => $charges['ค่าระบบ/ซอฟต์แวร์']['id']]];
                if ($this->rnd() < 0.6) {
                    $adjustments[] = ['chargeItemId' => $charges['ค่าการตลาดส่วนกลาง']['id']];
                }
                if ($this->rnd() < 0.3) {
                    $adjustments[] = ['chargeItemId' => $charges['ส่วนลดโปรโมชัน']['id'], 'amount' => $this->amountBetween(800, 3000)];
                }
                try {
                    $invoices[] = InvoiceService::generate(['franchiseId' => $shop['franchise']['id'], 'periodCode' => $periodCode, 'adjustments' => $adjustments], $admin);
                } catch (Throwable) {
                    // รอบที่ร้านนั้นไม่มียอดเลย ออกบิลไม่ได้ — ข้ามไปตามปกติ
                }
            }
        }

        /*
         * ── 7) การชำระเงิน — เดินตามขั้นตอนจริง: ร้านแจ้งชำระพร้อมสลิป → ส่วนกลางตรวจแล้วอนุมัติ ──
         * บิลเก่าจ่ายครบเกือบหมด บิลใหม่ยังค้างเยอะ — เหมือนพฤติกรรมเก็บเงินจริง
         */
        $userOfShop = [];
        foreach ($shops as $s) {
            $userOfShop[$s['franchise']['id']] = Db::one('SELECT * FROM users WHERE franchise_id = ? ORDER BY id LIMIT 1', [$s['franchise']['id']]);
        }
        $shopPays = function (array $inv, float $amount, array $opts = []) use ($userOfShop, $admin) {
            $sub = PaymentSubmissionService::submit([
                'invoiceId' => $inv['id'],
                'amount'    => $amount,
                'paidAt'    => $opts['paidAt'] ?? $inv['dueDate'],
                'method'    => $opts['method'] ?? $this->pick(['โอนธนาคาร', 'พร้อมเพย์', 'เงินสด']),
                'reference' => $opts['reference'] ?? null,
                'slipUrl'   => SampleImages::slip($inv['id']),
                'note'      => $opts['note'] ?? null,
            ], $userOfShop[$inv['franchiseId']]);
            PaymentSubmissionService::approve($sub['id'], ['note' => 'ตรวจสลิปแล้ว เงินเข้าจริง'], $admin);
        };
        $paidFull    = 0;
        $paidPartial = 0;
        foreach ($invoices as $index => $inv) {
            $age     = array_search($inv['periodCode'], $periods, true);
            $roll    = $this->rnd();
            $payFull = $age <= 2 ? $roll < 0.85 : ($age <= 3 ? $roll < 0.6 : $roll < 0.25);
            $payPart = ! $payFull && $roll < 0.75;
            if ($payFull) {
                $shopPays($inv, $inv['outstanding'], ['reference' => 'TRX-' . substr((string) (70000 + $index), 0, 5)]);
                $paidFull++;
            } elseif ($payPart) {
                $amount = max(100, self::jsRound($inv['outstanding'] * (0.3 + $this->rnd() * 0.4) * 100) / 100);
                $shopPays($inv, $amount, ['method' => 'โอนธนาคาร', 'reference' => 'TRX-' . substr((string) (80000 + $index), 0, 5), 'note' => 'ทยอยจ่ายบางส่วนก่อนครับ']);
                $paidPartial++;
            }
        }

        // ใบที่ยังค้าง — ลูกค้าแจ้งโอนเข้ามารอส่วนกลางตรวจสอบ (ครึ่งหนึ่งตรวจผ่านแล้ว)
        $stillOpen = array_values(array_filter(
            array_map(static fn ($i) => Db::one('SELECT * FROM invoices WHERE id = ?', [$i['id']]), $invoices),
            static fn ($row) => (int) $row['net_total_satang'] > (int) $row['paid_satang'],
        ));
        $pending  = 0;
        $approved = 0;
        foreach (array_slice($stillOpen, 0, 8) as $row) {
            $outstanding = ((int) $row['net_total_satang'] - (int) $row['paid_satang']) / 100;
            $amount      = max(100, self::jsRound($outstanding * ($this->rnd() < 0.5 ? 1 : 0.5) * 100) / 100);
            $method      = $this->pick(['โอนธนาคาร', 'พร้อมเพย์']);
            $note        = $this->rnd() < 0.4 ? 'โอนแล้วครับ รบกวนตรวจสอบ' : null;
            $sub         = PaymentSubmissionService::submit([
                'invoiceId' => (int) $row['id'],
                'amount'    => $amount,
                'paidAt'    => '2026-09-15',
                'method'    => $method,
                'reference' => 'TRX-9' . (1000 + (int) $row['id']),
                'slipUrl'   => SampleImages::slip((int) $row['id']),
                'note'      => $note,
            ], $userOfShop[(int) $row['franchise_id']]);
            if ($this->rnd() < 0.5) {
                PaymentSubmissionService::approve($sub['id'], ['note' => 'ตรวจสลิปแล้ว ถูกต้อง'], $admin);
                $approved++;
            } else {
                $pending++;
            }
        }

        /*
         * ── 8) บิลค่าคอมเซล — ออกบิลร้านแล้วไม่มีค่าคอมเกิดเอง ส่วนกลางทำบิลค่าคอมจากรายการบิลร้านที่ออกไปแล้ว ──
         * มิ.ย.–ก.ค. ครึ่งแรก = บิลที่จ่ายแล้ว · ก.ค. ครึ่งหลัง–ส.ค. ครึ่งแรก = บิลรอจ่าย
         * ส.ค. ครึ่งหลัง เว้นไว้ให้ลองกด "ทำบิลค่าคอม" เอง
         * ส่วนใหญ่คิด % ตามดีล ทุกรายการที่ 5 "กรอกเอง" (ปัดลงเป็นหลักพัน เหมือนตกลงยอดกลม ๆ กัน) ให้เห็นตัวอย่างทั้งสองแบบ
         * ย้อนวันที่ทำบิลให้กระจายหลายเดือน (หน้าเซลสรุปรายเดือน) — ทำได้เพราะเป็นข้อมูลตัวอย่างเท่านั้น
         */
        $commissionStages = [
            ['periods' => array_slice($periods, 0, 3), 'date' => '2026-08-03', 'paidAt' => '2026-08-05', 'note' => 'ค่าคอมรอบ มิ.ย. – ก.ค. (ครึ่งแรก)'],
            ['periods' => array_slice($periods, 3, 2), 'date' => '2026-09-02', 'paidAt' => null, 'note' => 'ค่าคอมรอบ ก.ค. (ครึ่งหลัง) – ส.ค. (ครึ่งแรก)'],
        ];
        // ค่าคอมอื่น ๆ — โบนัส/ค่าเดินทางที่ตกลงกันเป็นครั้ง ๆ (ติดลบ = หักคืน) · ไม่ต้องเลือกรอบ
        $otherLines = [
            0 => [0 => [['โบนัสปิดร้านใหม่ bkk03', 5000]], 1 => [['โบนัสยอดทะลุเป้าไตรมาส', 8000]]],
            1 => [0 => [['ค่าเดินทางไปเปิดร้านเชียงใหม่', 2400]]],
            2 => [1 => [['หักคืนค่าคอมที่คิดเกินรอบก่อน', -1200]]],
            4 => [1 => [['ค่าแนะนำร้านใหม่ ryg01', 3000], ['ค่าเดินทางพบลูกค้าระยอง', 850]]],
        ];
        $commissionBills = ['PAID' => 0, 'PENDING' => 0];
        foreach ($agents as $ai => $a) {
            $agentId    = $a['agent']['id'];
            $candidates = SalesAgentService::commissionCandidates($agentId);
            foreach ($commissionStages as $stage => $cfg) {
                $items = [];
                foreach (array_values(array_filter($candidates['items'], static fn ($it) => in_array($it['periodCode'], $cfg['periods'], true))) as $n => $it) {
                    $pct    = (float) ($it['deal']['pct'] ?? 0);
                    $manual = floor($it['grossAmount'] * $pct / 100 / 1000) * 1000;
                    $items[] = $n % 5 === 4 && $manual > 0
                        ? ['entryId' => $it['entryId'], 'mode' => 'MANUAL', 'amount' => $manual]
                        : ['entryId' => $it['entryId'], 'mode' => 'PCT', 'pct' => $pct];
                }
                $fixed = array_map(
                    static fn ($f) => ['key' => $f['key']],
                    array_values(array_filter($candidates['fixed'], static fn ($f) => in_array($f['periodCode'], $cfg['periods'], true))),
                );
                $others = array_map(static fn ($o) => ['label' => $o[0], 'amount' => $o[1]], $otherLines[$ai][$stage] ?? []);
                if ($items === [] && $fixed === [] && $others === []) {
                    continue;
                }
                // เซลที่ไม่ถือดีลได้แต่ค่าคอมอื่น ๆ — บิลไม่ได้อ้างรอบไหน หมายเหตุจึงไม่ใช่ชื่อรอบ
                $note   = $items === [] && $fixed === [] ? 'ค่าคอมอื่น ๆ (ไม่ได้ถือดีลสินค้า)' : $cfg['note'];
                $bill   = SalesAgentService::createCommissionBill($agentId, ['items' => $items, 'fixed' => $fixed, 'others' => $others, 'note' => $note], $admin);
                $billNo = 'COM-' . str_replace('-', '', $cfg['date']) . '-' . $a['agent']['username'];
                Db::exec(
                    'UPDATE sales_commissions SET bill_no = ?, created_at = ?, updated_at = ? WHERE id = ?',
                    [$billNo, "{$cfg['date']} 03:00:00", "{$cfg['date']} 03:00:00", $bill['id']],
                );
                if ($cfg['paidAt'] !== null) {
                    SalesAgentService::markPaid($bill['id'], ['paidAt' => $cfg['paidAt']], $admin);
                    $commissionBills['PAID']++;
                } else {
                    $commissionBills['PENDING']++;
                }
            }
        }
        $uncommissioned = array_sum(array_map(static fn ($a) => count(SalesAgentService::commissionCandidates($a['agent']['id'])['items']), $agents));

        /* ── สรุปให้ดูว่าได้อะไรมาบ้าง ── */
        $count = static fn (string $table) => Db::int("SELECT COUNT(*) FROM {$table}");
        $sum   = static fn (string $sql) => number_format(Db::int($sql) / 100, 2);
        CLI::newLine();
        CLI::write('── ข้อมูลตัวอย่างพร้อมใช้งาน ──────────────────────────', 'green');
        CLI::write('  ร้านค้า          ' . $count('franchises') . ' ร้าน');
        CLI::write('  สินค้า           ' . $count('products') . ' รายการ (มอบหมายแล้ว ' . $count('product_assignments') . ', ว่าง ' . (count($products) - count($assignable)) . ')');
        CLI::write('  ผู้ใช้ทั้งหมด     ' . $count('users') . ' บัญชี');
        CLI::write('  เซล              ' . $count('sales_agents') . ' คน · ดีล ' . $count('product_sales_links') . ' ดีล');
        CLI::write('  รอบบิล           ' . count($periods) . " รอบ ({$periods[0]} → " . end($periods) . ')');
        CLI::write('  รายการยอดขาย     ' . $count('sales_entries') . ' รายการ');
        CLI::write('  ยอดขายรวม        ' . $sum('SELECT SUM(gross_amount_satang) FROM sales_entries') . ' บาท');
        CLI::write('  ส่วนต่างรวม       ' . $sum('SELECT SUM(commission_amount_satang) FROM sales_entries') . ' บาท');
        CLI::write('  ใบเรียกเก็บ       ' . count($invoices) . " ใบ — ชำระครบ {$paidFull} · ชำระบางส่วน {$paidPartial}");
        CLI::write("  แจ้งชำระ         รอตรวจสอบ {$pending} · ยืนยันแล้ว {$approved}");
        CLI::write('  บิลค่าคอมเซล      ' . array_sum($commissionBills) . " ใบ (จ่ายแล้ว {$commissionBills['PAID']} · รอจ่าย {$commissionBills['PENDING']}) — รายการบิลร้านที่ยังไม่ได้ทำบิลค่าคอม {$uncommissioned} รายการ");
        CLI::newLine();
        CLI::write('── บัญชีสำหรับเข้าระบบ ────────────────────────────────', 'green');
        CLI::write('  ผู้ดูแลส่วนกลาง : superadmin / admin1234');
        CLI::write('  เซล            : ' . implode(', ', array_map(static fn ($a) => $a['user']['username'], $agents)) . ' / sale1234567');
        CLI::write('  ร้านค้า        : ' . implode(', ', array_map(static fn ($s) => $s['user']['username'], $shops)) . ' / franchise1234');
        CLI::write('  ผู้ช่วยของร้าน   : bkk01-staff, bkk02-staff, cnx01-staff / staff123456');
        // ร้านเข้าระบบได้ทางลิงก์ของร้านเท่านั้น (รหัสผ่านอย่างเดียวไม่พอ) — ต่อท้ายที่อยู่เว็บ เช่น http://localhost:8080/#/s/…
        CLI::newLine();
        CLI::write('── ลิงก์เข้าระบบของแต่ละร้าน (ต่อท้ายที่อยู่เว็บ · ผู้ช่วยใช้ลิงก์เดียวกับร้าน) ──', 'green');
        foreach ($shops as $shop) {
            CLI::write(sprintf('  %-6s : %s', $shop['franchise']['username'], FranchiseService::getLoginLink((int) $shop['franchise']['id'])['path']));
        }
    }
}
