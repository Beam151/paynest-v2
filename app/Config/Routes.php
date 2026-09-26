<?php

use CodeIgniter\Router\RouteCollection;

/**
 * เส้นทางทั้งหมดของระบบ — รายการ endpoint ที่ถูกต้องที่สุดคือไฟล์นี้
 *
 * ด่านตรวจเขียนต่อท้ายแต่ละเส้นเป็น guard:<ขั้น>,<ขั้น>,… ทำตามลำดับจากซ้ายไปขวา (ดู app/Filters/ApiGuard.php)
 *   auth · super · staff (ส่วนกลาง+ร้าน) · agent (ส่วนกลาง+เซล) · perm.<สิทธิ์ผู้ช่วย> · elevated (รหัส 6 หลัก) · limit.<ชนิด>
 * เส้นที่เจาะจงต้องอยู่ก่อนเส้นที่มี (:segment) ในตำแหน่งเดียวกัน ไม่งั้นคำอย่าง "me" จะถูกจับเป็น id
 *
 * @var RouteCollection $routes
 */

// หน้าเว็บหลังบ้าน (ไฟล์ js/css/รูปเสิร์ฟตรงจาก public/) + ตัวตรวจสุขภาพของ UptimeRobot
$routes->get('/', 'Home::index');
$routes->get('health', 'Home::health');

$routes->group('api', ['namespace' => 'App\Controllers\Api'], static function (RouteCollection $routes): void {
    $g = static fn (string $steps): array => ['filter' => "guard:{$steps}"];

    /* ── ล็อกอิน · 2FA · ยืนยันรหัส 6 หลัก · Telegram ส่วนตัว · เช็กลิสต์ ── */
    $routes->post('auth/login', 'Auth::login', $g('limit.login'));
    $routes->post('auth/login/mfa', 'Auth::loginMfa', $g('limit.mfa'));
    $routes->get('auth/me', 'Auth::me', $g('auth'));
    $routes->post('auth/change-password', 'Auth::changePassword', $g('auth'));
    $routes->get('auth/2fa', 'Auth::twoFactorStatus', $g('auth'));
    $routes->post('auth/2fa/setup', 'Auth::twoFactorSetup', $g('auth'));
    $routes->post('auth/2fa/enable', 'Auth::twoFactorEnable', $g('auth,limit.code'));
    $routes->post('auth/2fa/disable', 'Auth::twoFactorDisable', $g('auth,limit.code'));
    $routes->post('auth/2fa/backup-codes', 'Auth::twoFactorBackupCodes', $g('auth,limit.code'));
    $routes->post('auth/elevate', 'Auth::elevate', $g('auth,limit.code'));
    $routes->post('auth/users/(:segment)/reset-2fa', 'Auth::resetTwoFactor/$1', $g('auth,super,elevated'));
    $routes->get('auth/onboarding', 'Auth::onboarding', $g('auth'));
    $routes->post('auth/onboarding', 'Auth::updateOnboarding', $g('auth'));
    $routes->get('auth/telegram', 'Auth::telegram', $g('auth'));
    $routes->put('auth/telegram/prefs', 'Auth::telegramPrefs', $g('auth'));
    $routes->post('auth/telegram/link', 'Auth::telegramLink', $g('auth'));
    $routes->delete('auth/telegram', 'Auth::telegramUnlink', $g('auth'));

    /* ── ร้าน · ผู้ใช้ในร้าน · ยอดยกมา (เซลดูร้านผ่าน /sales-agents/links แทน) ── */
    $routes->post('franchises', 'Franchises::create', $g('auth,staff,super'));
    $routes->get('franchises', 'Franchises::index', $g('auth,staff'));
    $routes->get('franchises/(:segment)', 'Franchises::show/$1', $g('auth,staff'));
    $routes->get('franchises/(:segment)/credits', 'Franchises::credits/$1', $g('auth,staff,perm.bills'));
    $routes->patch('franchises/(:segment)', 'Franchises::update/$1', $g('auth,staff,super'));
    $routes->get('franchises/(:segment)/users', 'Franchises::users/$1', $g('auth,staff'));
    $routes->post('franchises/(:segment)/users', 'Franchises::addUser/$1', $g('auth,staff'));
    $routes->patch('franchises/(:segment)/users/(:segment)/permissions', 'Franchises::userPermissions/$1/$2', $g('auth,staff'));
    $routes->post('franchises/(:segment)/users/(:segment)/reset-password', 'Franchises::resetUserPassword/$1/$2', $g('auth,staff'));
    $routes->patch('franchises/(:segment)/users/(:segment)/status', 'Franchises::userStatus/$1/$2', $g('auth,staff'));

    /* ── สินค้า · การมอบหมาย ── */
    $routes->post('products', 'Products::create', $g('auth,staff,perm.products,super'));
    $routes->get('products', 'Products::index', $g('auth,staff,perm.products'));
    $routes->get('products/(:segment)', 'Products::show/$1', $g('auth,staff,perm.products'));
    $routes->patch('products/(:segment)', 'Products::update/$1', $g('auth,staff,perm.products,super'));
    $routes->delete('products/(:segment)', 'Products::delete/$1', $g('auth,staff,perm.products,super'));

    $routes->post('assignments', 'Assignments::create', $g('auth,staff,super'));
    $routes->get('assignments', 'Assignments::index', $g('auth,staff,perm.products'));
    $routes->get('assignments/(:segment)', 'Assignments::show/$1', $g('auth,staff,super'));
    $routes->patch('assignments/(:segment)', 'Assignments::update/$1', $g('auth,staff,super'));
    $routes->post('assignments/(:segment)/end', 'Assignments::end/$1', $g('auth,staff,super'));

    /* ── รอบบิล · อัตรา USD · ยอดขาย ── */
    $routes->get('periods', 'Periods::index', $g('auth,staff'));
    $routes->get('periods/current', 'Periods::current', $g('auth,staff'));
    $routes->get('periods/(:segment)', 'Periods::show/$1', $g('auth,staff'));
    $routes->post('periods/(:segment)/usd-rate', 'Periods::usdRate/$1', $g('auth,staff,super'));
    $routes->post('periods/(:segment)/status', 'Periods::status/$1', $g('auth,staff,super'));

    $routes->post('sales-entries', 'SalesEntries::upsert', $g('auth,super'));
    $routes->post('sales-entries/bulk', 'SalesEntries::bulk', $g('auth,super'));
    $routes->get('sales-entries', 'SalesEntries::index', $g('auth,super'));
    $routes->get('sales-entries/(:segment)', 'SalesEntries::show/$1', $g('auth,super'));
    $routes->post('sales-entries/(:segment)/approve', 'SalesEntries::approve/$1', $g('auth,super'));
    $routes->post('sales-entries/(:segment)/reopen', 'SalesEntries::reopen/$1', $g('auth,super'));
    $routes->delete('sales-entries/(:segment)', 'SalesEntries::delete/$1', $g('auth,super'));

    /* ── บิล · ค่าใช้จ่าย/ส่วนลด ── */
    $routes->get('invoices/readiness', 'Invoices::readiness', $g('auth,staff,perm.bills,super'));
    $routes->post('invoices/generate-bulk', 'Invoices::generateBulk', $g('auth,staff,perm.bills,super'));
    $routes->post('invoices/generate', 'Invoices::generate', $g('auth,staff,perm.bills,super'));
    $routes->patch('invoices/(:segment)', 'Invoices::update/$1', $g('auth,staff,perm.bills,super'));
    $routes->post('invoices/(:segment)/lines', 'Invoices::addLines/$1', $g('auth,staff,perm.bills,super'));
    $routes->get('invoices', 'Invoices::index', $g('auth,staff,perm.bills'));
    $routes->get('invoices/(:segment)', 'Invoices::show/$1', $g('auth,staff,perm.bills'));
    $routes->post('invoices/(:segment)/adjustments', 'Invoices::addAdjustment/$1', $g('auth,staff,perm.bills,super'));
    $routes->delete('invoices/(:segment)/adjustments/(:segment)', 'Invoices::removeAdjustment/$1/$2', $g('auth,staff,perm.bills,super'));
    $routes->post('invoices/(:segment)/void', 'Invoices::void/$1', $g('auth,staff,perm.bills,super'));

    $routes->get('charge-items', 'ChargeItems::index', $g('auth,staff'));
    $routes->get('charge-items/(:segment)', 'ChargeItems::show/$1', $g('auth,staff'));
    $routes->post('charge-items', 'ChargeItems::create', $g('auth,staff,super'));
    $routes->patch('charge-items/(:segment)', 'ChargeItems::update/$1', $g('auth,staff,super'));

    /* ── แจ้งชำระ · ตรวจสลิป · อัปโหลดไฟล์ ── */
    $routes->get('payments/nav-counts', 'Payments::navCounts', $g('auth,staff,perm.bills'));
    $routes->get('payments/center', 'Payments::center', $g('auth,staff,perm.bills'));
    $routes->get('payments/received', 'Payments::received', $g('auth,staff,perm.bills'));
    $routes->get('payments/outstanding', 'Payments::outstanding', $g('auth,staff,perm.bills'));
    $routes->post('payments', 'Payments::submit', $g('auth,staff,perm.pay'));
    $routes->get('payments', 'Payments::index', $g('auth,staff,perm.bills.pay'));
    $routes->get('payments/(:segment)', 'Payments::show/$1', $g('auth,staff,perm.bills.pay'));
    $routes->post('payments/(:segment)/approve', 'Payments::approve/$1', $g('auth,staff,super'));
    $routes->post('payments/(:segment)/reject', 'Payments::reject/$1', $g('auth,staff,super'));
    $routes->post('payments/(:segment)/cancel', 'Payments::cancel/$1', $g('auth,staff,perm.pay'));

    // ร้านอัปโหลดได้เฉพาะคนที่มีสิทธิ์แจ้งชำระ (ไฟล์เดียวที่ร้านต้องส่งคือสลิป) — super admin ผ่านเสมอ (รูป QR บัญชี)
    $routes->post('uploads', 'Uploads::create', $g('auth,staff,perm.pay,limit.upload'));
    // เปิดไฟล์ด้วยลิงก์ที่ระบบเซ็นให้ (มีวันหมดอายุ) — <img src> แนบ token ไม่ได้
    $routes->get('uploads/(:segment)', 'Uploads::show/$1');

    /* ── เซล · ดีล · ค่าคอม ── */
    $routes->get('sales-agents/me', 'SalesAgents::me', $g('auth,agent'));
    $routes->get('sales-agents/me/commissions', 'SalesAgents::myCommissions', $g('auth,agent'));
    $routes->get('sales-agents/commissions', 'SalesAgents::commissions', $g('auth,agent'));
    $routes->post('sales-agents/commissions/manual', 'SalesAgents::createManual', $g('auth,agent,super'));
    $routes->patch('sales-agents/commissions/manual/(:segment)', 'SalesAgents::updateManual/$1', $g('auth,agent,super'));
    $routes->delete('sales-agents/commissions/manual/(:segment)', 'SalesAgents::deleteManual/$1', $g('auth,agent,super'));
    $routes->get('sales-agents/commissions/(:segment)', 'SalesAgents::commission/$1', $g('auth,agent'));
    $routes->post('sales-agents/commissions/(:segment)/pay', 'SalesAgents::payCommission/$1', $g('auth,agent,super'));
    $routes->post('sales-agents/links', 'SalesAgents::createLinks', $g('auth,agent,super'));
    $routes->get('sales-agents/links', 'SalesAgents::links', $g('auth,agent'));
    $routes->get('sales-agents/links/(:segment)', 'SalesAgents::link/$1', $g('auth,agent,super'));
    $routes->patch('sales-agents/links/(:segment)', 'SalesAgents::updateLink/$1', $g('auth,agent,super'));
    $routes->post('sales-agents/links/(:segment)/end', 'SalesAgents::endLink/$1', $g('auth,agent,super'));
    $routes->post('sales-agents', 'SalesAgents::create', $g('auth,agent,super'));
    $routes->get('sales-agents', 'SalesAgents::index', $g('auth,agent,super'));
    $routes->get('sales-agents/(:segment)', 'SalesAgents::show/$1', $g('auth,agent,super'));
    $routes->patch('sales-agents/(:segment)', 'SalesAgents::update/$1', $g('auth,agent,super'));
    $routes->post('sales-agents/(:segment)/users', 'SalesAgents::addUser/$1', $g('auth,agent,super'));

    /* ── รายงาน · หน้าแรก · อันดับร้าน ── */
    foreach (['by-period' => 'byPeriod', 'by-month' => 'byMonth', 'compare' => 'compare', 'compare-range' => 'compareRange',
        'breakdown' => 'breakdown', 'dashboard' => 'dashboard', 'standing' => 'standing'] as $path => $method) {
        $routes->get("reports/{$path}", "Reports::{$method}", $g('auth,staff,perm.reports'));
    }

    /* ── ประวัติรายการ · รายรับ-รายจ่ายของส่วนกลาง · บัญชีรับเงิน ── */
    $routes->get('activity', 'Activity::index', $g('auth,super'));

    $routes->post('ledger', 'Ledger::create', $g('auth,super'));
    $routes->get('ledger', 'Ledger::index', $g('auth,super'));
    $routes->patch('ledger/(:segment)', 'Ledger::update/$1', $g('auth,super'));
    $routes->delete('ledger/(:segment)', 'Ledger::delete/$1', $g('auth,super'));

    $routes->get('bank-accounts', 'BankAccounts::index', $g('auth,staff'));
    $routes->get('bank-accounts/changes/unread', 'BankAccounts::unreadChanges', $g('auth,staff,super'));
    $routes->post('bank-accounts/changes/(:segment)/ack', 'BankAccounts::ackChange/$1', $g('auth,staff,super'));
    $routes->get('bank-accounts/(:segment)', 'BankAccounts::show/$1', $g('auth,staff'));
    $routes->post('bank-accounts', 'BankAccounts::create', $g('auth,staff,super,elevated'));
    // แก้เฉพาะสาขา/หมายเหตุไม่ต้องยืนยัน — controller ตัดสินเองว่าการแก้ครั้งนี้เปลี่ยนปลายทางเงินไหม
    $routes->patch('bank-accounts/(:segment)', 'BankAccounts::update/$1', $g('auth,staff,super'));
    $routes->delete('bank-accounts/(:segment)', 'BankAccounts::delete/$1', $g('auth,staff,super,elevated'));

    /* ── ตั้งค่าแจ้งเตือน · Telegram กลุ่ม · สำรองข้อมูล (แก้อะไรต้องยืนยันรหัส 6 หลัก) ── */
    $routes->get('settings/notifications', 'Settings::notifications', $g('auth,super'));
    $routes->put('settings/notifications', 'Settings::saveNotifications', $g('auth,super,elevated'));
    $routes->get('settings/telegram', 'Settings::telegram', $g('auth,super'));
    $routes->post('settings/telegram/test', 'Settings::telegramTest', $g('auth,super'));
    $routes->post('settings/telegram/discover', 'Settings::telegramDiscover', $g('auth,super,elevated'));
    $routes->put('settings/telegram', 'Settings::saveTelegram', $g('auth,super,elevated'));
    $routes->delete('settings/telegram', 'Settings::disableTelegram', $g('auth,super,elevated'));
    $routes->get('settings/backup', 'Settings::backup', $g('auth,super'));
    $routes->post('settings/backup', 'Settings::runBackup', $g('auth,super'));

    /* ── ประกาศถึงร้าน · ใครอ่านแล้ว · คู่มือ ── */
    $routes->get('announcements', 'Announcements::index', $g('auth'));
    $routes->post('announcements/(:segment)/read', 'Announcements::read/$1', $g('auth'));
    $routes->post('announcements', 'Announcements::create', $g('auth,super'));
    $routes->get('announcements/(:segment)/readers', 'Announcements::readers/$1', $g('auth,super'));
    $routes->patch('announcements/(:segment)', 'Announcements::update/$1', $g('auth,super'));
    $routes->delete('announcements/(:segment)', 'Announcements::delete/$1', $g('auth,super'));

    $routes->get('manual', 'Manual::index', $g('auth'));
});
