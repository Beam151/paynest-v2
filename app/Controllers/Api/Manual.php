<?php

namespace App\Controllers\Api;

use App\Libraries\AssetVersion;
use App\Libraries\AuthContext;

/**
 * คู่มือการใช้งาน — /api/manual · แต่ละบทบาทได้เฉพาะคู่มือของตัวเอง
 *
 * ไฟล์อยู่ใน app/Manual (ไม่ใช่ public/) จึงเปิดตรง ๆ จาก URL ไม่ได้ ต้องผ่านเส้นนี้ที่เช็ก token ก่อน
 * ร้าน/เซลขอของบทบาทอื่นก็ได้ของตัวเองกลับไป — ส่วนกลางขอดูได้ทุกบทบาท (ใช้ตอน "ดูมุมมองนี้")
 *
 * ในไฟล์คู่มือเขียนสั้น ๆ ได้:
 *   {i:ชื่อไอคอน}  → ไอคอนจาก public/icons.svg
 *   {nav:หน้า}     → ทางไปหน้านั้น ทั้งแบบคอม ("เมนูซ้าย › บิลของฉัน") และแบบมือถือ ("แถบล่าง › บิล")
 */
class Manual extends BaseApiController
{
    private const ROLE_FILE = ['SUPER_ADMIN' => 'admin', 'FRANCHISE' => 'shop', 'SALES' => 'sales'];

    /*
     * เมนูของแต่ละบทบาท — ต้องตรงกับ ROUTES / NAV_GROUPS / BOTTOM_NAV ใน public/js/app.js
     * desktop = เมนูด้านซ้าย · mobile = แถบล่าง (4 ปุ่ม) ที่เหลืออยู่ในปุ่ม ☰
     * account = กดชื่อผู้ใช้มุมซ้ายล่าง (คอม) / ปุ่ม "บัญชี" แถบล่าง (มือถือ)
     */
    private const NAV = [
        'shop' => [
            'user'    => ['name' => 'bkk01', 'role' => 'เจ้าของบัญชีร้าน'],
            'desktop' => [['dashboard', 'ภาพรวม', 'layout-dashboard'], ['bills', 'บิลของฉัน', 'wallet'], ['reports', 'รายงานเปรียบเทียบ', 'trending-up'], ['products', 'สินค้า', 'package']],
            'mobile'  => [['dashboard', 'หน้าแรก', 'house'], ['bills', 'บิล', 'receipt'], ['reports', 'ยอดขาย', 'trending-up'], ['account', 'บัญชี', 'settings']],
        ],
        'admin' => [
            'user'    => ['name' => 'superadmin', 'role' => 'ผู้ดูแลระบบส่วนกลาง'],
            'desktop' => [
                ['dashboard', 'ภาพรวม', 'layout-dashboard'], ['sales', 'ยอดขายรายรอบ', 'receipt'], ['bills', 'บิลและการชำระ', 'wallet'],
                ['reports', 'รายงานเปรียบเทียบ', 'trending-up'], ['ledger', 'รายรับ-รายจ่ายของเรา', 'notebook-text'],
                ['shops', 'ร้านค้า', 'store'], ['products', 'สินค้า', 'package'], ['agents', 'เซล', 'handshake'],
                ['charges', 'ค่าใช้จ่าย/ส่วนลด', 'tag'], ['bank', 'บัญชีรับเงิน', 'landmark'],
                ['news', 'ประกาศถึงร้าน', 'megaphone'], ['settings', 'ตั้งค่าแจ้งเตือน', 'bell'],
            ],
            'mobile' => [['dashboard', 'หน้าแรก', 'house'], ['bills', 'บิล', 'receipt'], ['sales', 'ยอดขาย', 'shopping-cart'], ['account', 'บัญชี', 'settings']],
        ],
        'sales' => [
            'user'    => ['name' => 'sale01', 'role' => 'เซล'],
            'desktop' => [['mysales', 'รายได้ของฉัน', 'target'], ['deals', 'สินค้าที่ถือดีล', 'package']],
            'mobile'  => [['mysales', 'หน้าแรก', 'house'], ['deals', 'ดีล', 'package'], ['account', 'บัญชี', 'settings']],
        ],
    ];

    private static function icon(string $name): string
    {
        // ไฟล์ไอคอนติดป้ายรุ่นแบบเดียวกับหน้าเว็บ (ui.js) — อัปเดตเพิ่มไอคอนแล้วคู่มือไม่ใช้ไฟล์เก่าที่ไม่มีไอคอนนั้น
        return '<svg class="icon" aria-hidden="true"><use href="' . AssetVersion::url('/icons.svg') . '#i-' . $name . '"></use></svg>';
    }

    private static function find(array $items, string $key): ?array
    {
        foreach ($items as $item) {
            if ($item[0] === $key) {
                return $item;
            }
        }

        return null;
    }

    /** ทางไปหน้า key — แบบคอมและแบบมือถือ (หน้าที่ไม่อยู่แถบล่าง = อยู่ในปุ่ม ☰) */
    private static function navText(array $nav, string $key): string
    {
        $desk    = self::find($nav['desktop'], $key);
        $mob     = self::find($nav['mobile'], $key);
        $deskTxt = $desk[1] ?? $key;
        $desktop = $key === 'account'
            ? 'กดชื่อ <span class="m-ui">' . $nav['user']['name'] . '</span> มุมซ้ายล่าง'
            : 'เมนูซ้าย <span class="m-ui">' . $deskTxt . '</span>';
        $mobile = $mob
            ? 'แถบล่าง <span class="m-ui">' . $mob[1] . '</span>'
            : 'ปุ่ม <span class="m-ui">☰</span> มุมซ้ายบน › <span class="m-ui">' . $deskTxt . '</span>';

        return '<span class="only-desktop">' . $desktop . '</span><span class="only-mobile">' . $mobile . '</span>';
    }

    public function index()
    {
        $user    = $this->user();
        $own     = self::ROLE_FILE[$user['role']];
        $asked   = (string) ($this->q('role') ?? '');
        $section = AuthContext::isSuperAdmin($user) && in_array($asked, self::ROLE_FILE, true) ? $asked : $own;
        $nav     = self::NAV[$section];
        // อ่านทุกครั้ง (ไฟล์เล็ก) — แก้คู่มือแล้วเห็นผลทันที · ตัดคอมเมนต์ของคนเขียนคู่มือออกก่อนส่ง
        $html = (string) file_get_contents(APPPATH . 'Manual' . DIRECTORY_SEPARATOR . "{$section}.html");
        $html = preg_replace('/<!--[\s\S]*?-->/', '', $html) ?? $html;
        $html = preg_replace_callback('/\{nav:([a-z]+)\}/', static fn ($m) => self::navText($nav, $m[1]), $html) ?? $html;
        $html = preg_replace_callback('/\{i:([a-z0-9-]+)\}/', static fn ($m) => self::icon($m[1]), $html) ?? $html;

        return $this->json(['section' => $section, 'html' => $html, 'nav' => $nav])->removeHeader('Cache-Control')->setHeader('Cache-Control', 'no-store');
    }
}
