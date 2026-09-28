/**
 * ทดสอบ end-to-end ทุกเงื่อนไขหลักของระบบ — ยิง HTTP ใส่เซิร์ฟเวอร์ PHP จริง บนฐานข้อมูลเทสต์แยก
 * รัน: composer test:e2e  (หรือ node tests/e2e/smoke.mjs — ตั้งค่าการต่อฐานข้อมูลดู tests/e2e/lib/harness.mjs)
 *
 * พอร์ตมาจากชุดเทสต์ของระบบเดิม (Node) แบบคำต่อคำ — เปลี่ยนเฉพาะส่วนที่เดิมเรียกโค้ดภายในโดยตรง
 * (งานตั้งเวลา / อ่านฐานข้อมูล) ให้ผ่าน php spark แทน · ตัวเช็กทุกข้อยังเป็นข้อเดิม
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { DB, TURNSTILE, jwtSign, spark, startStack, thaiWall, totp } from './lib/harness.mjs';

const TG_TOKEN = '123456:SMOKE-SECRET-TOKEN';
const TG_CHAT = '-1009876543210';

// ทดสอบพฤติกรรมของเซิร์ฟเวอร์จริง (บังคับ Google Authenticator กับส่วนกลาง) — CI_ENVIRONMENT = production
const stack = await startStack({
  dbName: process.env.SMOKE_DB ?? 'paynest_e2e_smoke',
  mode: 'production',
  env: {
    PAYNEST_JWT_SECRET: 'smoke-test-secret-32-characters-min',
    PAYNEST_SEED_ADMIN_PASS: 'smoke-test-password-123456',
    // ไม่ตั้ง PAYNEST_ENCRYPTION_KEY — ให้ระบบสุ่มกุญแจเก็บใน secrets.json เองแบบเครื่องจริง (เทสต์สำรองข้อมูลเช็กว่าไฟล์นี้ถูกสำรองไปด้วย)
    // เทสต์ captcha จำลองคนร้ายหลาย IP ผ่าน X-Forwarded-For · คำขอที่ไม่ส่ง header นี้ยังเป็น 127.0.0.1 เหมือนเดิม
    PAYNEST_TRUST_PROXY: '1',
  },
});
const { base, telegram, turnstile, db, call } = stack;
const server = { close: () => stack.stop() };
const tgServer = { close: () => {} };
process.env.SEED_SUPERADMIN_PASS = 'smoke-test-password-123456';

const jwt = { sign: (payload, secret, opts) => jwtSign(payload, secret, opts) };
const flushTelegram = () => call('flush');
const pollTelegram = () => call('poll');
const notify = (key, text, opts) => call('notify', { key, text, opts });
const notifyShopForTest = (fid) => call('notifyShop', { franchiseId: fid, text: 'ทดสอบหลังเลิกเชื่อม' });
const runDigestIfDue = () => call('runDigestIfDue');
const runDueReminders = (now) => call('runDueReminders', { now: thaiWall(now) });
const runOverdueNudges = (now) => call('runOverdueNudges', { now: thaiWall(now) });
const runAnnouncementPushes = () => call('runAnnouncementPushes');
const notifyStarted = () => call('notifyStarted');
const notifySystemError = (err, req) => call('notifySystemError', { message: err.message, method: req?.method, path: req?.originalUrl });
// statfs จำลองแบบของเดิม → ส่งเป็นจำนวนไบต์ที่ว่าง/ทั้งหมด
const checkDiskSpace = (_dir, statfs) => {
  const st = statfs();
  return call('checkDiskSpace', { fake: { free: st.bavail * st.bsize, total: st.blocks * st.bsize } });
};

let passed = 0;
const failures = [];

function check(label, condition, extra) {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); return; }
  failures.push(label);
  console.log(`  ✗ ${label}${extra ? `\n      ${JSON.stringify(extra)}` : ''}`);
}

const ADMIN_PASS = process.env.SEED_SUPERADMIN_PASS;
const ADMIN_NEW_PASS = 'smoke-admin-own-password-2026';
let admin; // ตั้งค่าหลังล็อกอิน (ข้อ 1) — api() ใช้เช็คว่าเป็นคำขอของแอดมิน
let adminSecret; // secret ของ Google Authenticator แอดมิน — ใช้สร้างรหัส 6 หลักเหมือนมือถือ

/**
 * รหัส 6 หลักแบบที่แอปในมือถือจะแสดง — รหัสแต่ละช่วง 30 วิใช้ได้ครั้งเดียว
 * จึงเลือกช่วงที่ยังไม่เคยใช้ (ตอนนี้ หรือช่วงถัดไปที่เซิร์ฟเวอร์ยอมรับ) ถ้าหมดก็รอช่วงใหม่
 */
const usedStep = new Map();
async function codeFor(secret) {
  const key = secret.replace(/\s/g, '');
  for (;;) {
    const now = Math.floor(Date.now() / 30000);
    const step = [now, now + 1].find((x) => x > (usedStep.get(key) ?? 0));
    if (step !== undefined) {
      usedStep.set(key, step);
      return totp(key, step);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}


/** ยืนยันรหัส 6 หลักของแอดมิน — ได้ elevation token อายุ 5 นาที (ต่ออายุเองเมื่อใกล้หมด) */
let adminElev = null;
async function adminElevation() {
  if (!adminElev || Date.now() - adminElev.at > 240_000) {
    const res = await api('POST', '/api/auth/elevate', { token: admin, body: { code: await codeFor(adminSecret) } });
    adminElev = { token: res.body.elevationToken, at: Date.now() };
  }
  return adminElev.token;
}

// เส้นทางที่ต้องยืนยันรหัส 6 หลัก (แก้บัญชีรับเงิน / ตั้งค่า Telegram / captcha)
const ELEVATED_URL = /^\/api\/(bank-accounts(\/\d+)?|settings\/(telegram(\/discover)?|notifications|turnstile))$/;

async function api(method, url, { token, body, headers = {}, elevate = true } = {}) {
  // เทสต์ที่ต้องการทดสอบว่า "ไม่ยืนยันแล้วโดนกัน" ส่ง elevate: false
  if (elevate && token && token === admin && method !== 'GET' && ELEVATED_URL.test(url)) {
    headers = { 'x-elevation': await adminElevation(), ...headers };
  }
  const res = await fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

const section = (t) => console.log(`\n${t}`);

// ── 1) super admin เข้าระบบ และสร้างเจ้าของร้าน ─────────────────────────
section('1) super admin + สร้างเจ้าของร้าน');
const login = await api('POST', '/api/auth/login', { body: { username: 'superadmin', password: ADMIN_PASS } });
check('super admin ล็อกอินได้', login.status === 200 && login.body.token, login.body);
check('ล็อกอินครั้งแรกต้องเปลี่ยนรหัสและตั้ง 2FA ก่อน',
  login.body.mustChangePassword === true && login.body.enrollRequired === true, login.body);
admin = login.body.token;

const pwGate = await api('GET', '/api/franchises', { token: admin });
check('ยังไม่เปลี่ยนรหัสเริ่มต้น ใช้งานอย่างอื่นไม่ได้',
  pwGate.status === 403 && pwGate.body.error.code === 'PASSWORD_CHANGE_REQUIRED', pwGate.body);
check('พิมพ์รหัสเดิมผิดตอนเปลี่ยนรหัส ไม่เตะออกจากระบบ (403 ไม่ใช่ 401)', (await api('POST', '/api/auth/change-password', {
  token: admin, body: { currentPassword: 'not-it', newPassword: ADMIN_NEW_PASS },
})).status === 403);
const changedPw = await api('POST', '/api/auth/change-password', {
  token: admin, body: { currentPassword: ADMIN_PASS, newPassword: ADMIN_NEW_PASS },
});
check('เปลี่ยนรหัสเริ่มต้นได้', changedPw.status === 200, changedPw.body);
admin = changedPw.body.token;

const mfaGate = await api('GET', '/api/franchises', { token: admin });
check('ส่วนกลางยังไม่ตั้ง 2FA ใช้งานอย่างอื่นไม่ได้',
  mfaGate.status === 403 && mfaGate.body.error.code === 'MFA_ENROLL_REQUIRED', mfaGate.body);
const adminSetup = await api('POST', '/api/auth/2fa/setup', { token: admin });
check('ได้ QR และ secret ไว้สแกนเข้าแอป',
  adminSetup.status === 200 && adminSetup.body.qrDataUrl.startsWith('data:image/png') && adminSetup.body.secret, adminSetup.body);
adminSecret = adminSetup.body.secret;
const adminEnabled = await api('POST', '/api/auth/2fa/enable', { token: admin, body: { code: await codeFor(adminSecret) } });
check('ใส่รหัสแรกถูกแล้วเปิด 2FA ได้ พร้อมรหัสสำรอง 10 ชุด',
  adminEnabled.status === 200 && adminEnabled.body.backupCodes.length === 10, adminEnabled.body);
check('token ที่ออกก่อนเปิด 2FA ใช้ต่อไม่ได้', (await api('GET', '/api/auth/me', { token: admin })).status === 401);
admin = adminEnabled.body.token;
const adminId = adminEnabled.body.user.id;
check('ตั้งครบแล้วใช้งานได้ปกติ', (await api('GET', '/api/franchises', { token: admin })).status === 200);

// Telegram ตั้งในหน้าเว็บได้แล้ว แต่ต้องใส่รหัส 6 หลักก่อน — คนที่ได้ session ไปย้ายแจ้งเตือนไปกลุ่มตัวเองไม่ได้
telegram.updates = [
  { update_id: 1, message: { chat: { id: Number(TG_CHAT), title: 'แจ้งเตือนร้าน', type: 'supergroup' } } },
  { update_id: 2, message: { chat: { id: 42, type: 'private' } } },
];
const tgNoCode = await api('PUT', '/api/settings/telegram', {
  token: admin, elevate: false, body: { botToken: TG_TOKEN, chatId: TG_CHAT },
});
check('ตั้งค่า Telegram โดยไม่ใส่รหัส 6 หลักไม่ได้',
  tgNoCode.status === 403 && tgNoCode.body.error.code === 'ELEVATION_REQUIRED', tgNoCode.body);
const found = await api('POST', '/api/settings/telegram/discover', { token: admin, body: { botToken: TG_TOKEN } });
check('ค้นหากลุ่มจาก bot token ได้ (ไม่เอาแชตส่วนตัว)',
  found.body.botUsername === 'franchise_alert_bot' && found.body.chats.length === 1 && found.body.chats[0].id === TG_CHAT, found.body);
const badBot = await api('POST', '/api/settings/telegram/discover', { token: admin, body: { botToken: '999:BAD' } });
check('bot token ผิด บอกว่าเชื่อมต่อไม่ได้ โดยไม่ส่ง token กลับมา',
  badBot.status === 400 && !JSON.stringify(badBot.body).includes('999:BAD'), badBot.body);
const tgSaved = await api('PUT', '/api/settings/telegram', {
  token: admin, body: { botToken: TG_TOKEN, chatId: TG_CHAT, chatTitle: 'แจ้งเตือนร้าน' },
});
check('บันทึกได้เมื่อส่งข้อความทดสอบเข้ากลุ่มสำเร็จ',
  tgSaved.status === 200 && tgSaved.body.configured && /เชื่อมต่อแล้ว/.test(telegram.messages.at(-1)?.text ?? ''), tgSaved.body);
check('bot token ในฐานข้อมูลถูกเข้ารหัส',
  !db.prepare("SELECT value FROM app_settings WHERE name = 'telegram.botToken'").get().value.includes('SMOKE-SECRET'));

// รหัสผ่านอย่างเดียวไม่พออีกต่อไป
const pwOnly = await api('POST', '/api/auth/login', { body: { username: 'superadmin', password: ADMIN_NEW_PASS } });
check('ล็อกอินด้วยรหัสผ่านอย่างเดียวยังไม่ได้ session', pwOnly.body.mfaRequired === true && !pwOnly.body.token, pwOnly.body);
check('เอา token ขั้นที่สองมาใช้เป็น session ไม่ได้',
  (await api('GET', '/api/franchises', { token: pwOnly.body.mfaToken })).status === 401);
const viaBackup = await api('POST', '/api/auth/login/mfa', {
  body: { mfaToken: pwOnly.body.mfaToken, code: adminEnabled.body.backupCodes[0].toUpperCase() },
});
check('มือถือหาย ล็อกอินด้วยรหัสสำรองได้ (พิมพ์ตัวใหญ่ก็ได้)',
  viaBackup.status === 200 && viaBackup.body.usedBackupCode === true && viaBackup.body.backupCodesLeft === 9, viaBackup.body);
const pwOnly2 = await api('POST', '/api/auth/login', { body: { username: 'superadmin', password: ADMIN_NEW_PASS } });
check('รหัสสำรองใช้ซ้ำไม่ได้', (await api('POST', '/api/auth/login/mfa', {
  body: { mfaToken: pwOnly2.body.mfaToken, code: adminEnabled.body.backupCodes[0] },
})).status === 403);
await flushTelegram();
check('แอดมินใช้รหัสสำรอง → แจ้ง Telegram', telegram.messages.some((m) => /ล็อกอินด้วยรหัสสำรอง/.test(m.text)));

check('รหัสผ่านผิดต้องไม่ผ่าน',
  (await api('POST', '/api/auth/login', { body: { username: 'superadmin', password: 'wrong' } })).status === 401);

const shopA = await api('POST', '/api/franchises', {
  token: admin,
  body: { username: 'shopa', password: 'shopa12345', contactName: 'คุณเอ' },
});
check('สร้างร้าน A พร้อมยูสเซอร์', shopA.status === 201 && shopA.body.user.role === 'FRANCHISE', shopA.body);

const shopB = await api('POST', '/api/franchises', {
  token: admin,
  body: { username: 'shopb', password: 'shopb12345' },
});
check('สร้างร้าน B', shopB.status === 201, shopB.body);

check('username ซ้ำต้องถูกปฏิเสธ', (await api('POST', '/api/franchises', {
  token: admin,
  body: { username: 'shopa', password: 'dup123456' },
})).status === 409);

// ── 2) เจ้าของร้านเข้าระบบดูข้อมูลของตัวเอง ────────────────────────────
section('2) ยูสเซอร์ของร้านเข้าระบบ + ขอบเขตข้อมูล');
const loginA = await api('POST', '/api/auth/login', { body: { username: 'shopa', password: 'shopa12345' } });
check('ร้าน A ล็อกอินได้', loginA.status === 200, loginA.body);
let tokenA = loginA.body.token;
const tokenB = (await api('POST', '/api/auth/login', { body: { username: 'shopb', password: 'shopb12345' } })).body.token;

check('เจ้าของร้านเห็นเฉพาะข้อมูลตัวเอง',
  (await api('GET', '/api/franchises', { token: tokenA })).body.items.length === 1);
check('เจ้าของร้านเปิดข้อมูลของรายอื่นไม่ได้',
  (await api('GET', `/api/franchises/${shopB.body.franchise.id}`, { token: tokenA })).status === 403);
check('ไม่มีโทเคนเข้าไม่ได้', (await api('GET', '/api/products')).status === 401);

// ── ยูสเซอร์: super สร้างให้แค่คนเดียว ที่เหลือเจ้าของบัญชีเพิ่มเอง ──
section('ยูสเซอร์ของร้าน (เจ้าของบัญชี / ผู้ช่วย)');
const fidA = shopA.body.franchise.id;
check('ยูสเซอร์แรกที่มาพร้อมเจ้าของร้านคือเจ้าของบัญชี', shopA.body.user.isOwner === true, shopA.body.user);

check('super admin เพิ่มยูสเซอร์ให้ร้านไม่ได้', (await api('POST', `/api/franchises/${fidA}/users`, {
  token: admin, body: { username: 'helper-by-admin', password: 'helper12345' },
})).status === 403);

const helper = await api('POST', `/api/franchises/${fidA}/users`, {
  token: tokenA, body: { username: 'helpera', password: 'helper12345', displayName: 'ผู้ช่วยเอ' },
});
check('เจ้าของบัญชีเพิ่มผู้ช่วยเองได้', helper.status === 201 && helper.body.isOwner === false, helper.body);

let helperToken = (await api('POST', '/api/auth/login', { body: { username: 'helpera', password: 'helper12345' } })).body.token;
check('ผู้ช่วยล็อกอินและใช้งานข้อมูลเจ้าของร้านได้',
  (await api('GET', '/api/products', { token: helperToken })).status === 200);

check('ผู้ช่วยเพิ่มยูสเซอร์ต่อไม่ได้', (await api('POST', `/api/franchises/${fidA}/users`, {
  token: helperToken, body: { username: 'helperb', password: 'helper12345' },
})).status === 403);

check('ผู้ช่วยปิดบัญชีเจ้าของไม่ได้', (await api('PATCH', `/api/franchises/${fidA}/users/${shopA.body.user.id}/status`, {
  token: helperToken, body: { status: 'DISABLED' },
})).status === 403);

check('เจ้าของบัญชีเพิ่มผู้ช่วยให้ร้านอื่นไม่ได้', (await api('POST', `/api/franchises/${shopB.body.franchise.id}/users`, {
  token: tokenA, body: { username: 'crossshop', password: 'cross12345' },
})).status === 403);

check('เจ้าของบัญชีตั้งรหัสใหม่ให้ผู้ช่วยได้',
  (await api('POST', `/api/franchises/${fidA}/users/${helper.body.id}/reset-password`, {
    token: tokenA, body: { newPassword: 'newhelper123' },
  })).status === 200);
check('super admin ยังตั้งรหัสใหม่ให้เจ้าของบัญชีได้ (งานซัพพอร์ต)',
  (await api('POST', `/api/franchises/${fidA}/users/${shopA.body.user.id}/reset-password`, {
    token: admin, body: { newPassword: 'shopa12345' },
  })).status === 200);

// ตั้งรหัสใหม่แล้ว token เดิมต้องใช้ไม่ได้ทันที — ถ้ายังใช้ได้ คนที่ขโมย token ไปจะอยู่ต่อได้ทั้งวัน
check('ถูกตั้งรหัสใหม่แล้ว token เก่าใช้ไม่ได้',
  (await api('GET', '/api/auth/me', { token: tokenA })).status === 401);
tokenA = (await api('POST', '/api/auth/login', { body: { username: 'shopa', password: 'shopa12345' } })).body.token;
helperToken = (await api('POST', '/api/auth/login', { body: { username: 'helpera', password: 'newhelper123' } })).body.token;
check('ล็อกอินใหม่ด้วยรหัสใหม่ได้', (await api('GET', '/api/auth/me', { token: tokenA })).status === 200);

const teamList = await api('GET', `/api/franchises/${fidA}/users`, { token: tokenA });
check('เจ้าของบัญชีเห็นทีมของตัวเองและจัดการได้',
  teamList.body.canManage === true && teamList.body.items.length === 2, teamList.body);
check('ผู้ช่วยเห็นทีมแต่จัดการไม่ได้',
  (await api('GET', `/api/franchises/${fidA}/users`, { token: helperToken })).body.canManage === false);

// ปิดผู้ช่วยไว้ ไม่ให้รบกวนเทสต์ถัดไป
await api('PATCH', `/api/franchises/${fidA}/users/${helper.body.id}/status`, { token: tokenA, body: { status: 'DISABLED' } });
check('บัญชีที่ถูกปิดใช้งานเข้าระบบไม่ได้',
  (await api('GET', '/api/products', { token: helperToken })).status === 401);

// รอบบิลถูกสร้างตอนบันทึกยอดครั้งแรก — การ "ดู" รอบที่ยังว่างต้องได้ลิสต์ว่าง ไม่ใช่ 404
const emptyPeriod = await api('GET', '/api/sales-entries?periodCode=2030-12-H2', { token: admin });
check('ดูรอบบิลที่ยังไม่มีข้อมูลได้ (ไม่ใช่ 404)',
  emptyPeriod.status === 200 && emptyPeriod.body.items.length === 0, emptyPeriod.body);
check('ดูใบเรียกเก็บของรอบที่ยังไม่มีข้อมูลได้',
  (await api('GET', '/api/invoices?periodCode=2030-12-H2', { token: tokenA })).status === 200);
check('รหัสรอบบิลผิดรูปแบบยังต้องถูกปฏิเสธ',
  (await api('GET', '/api/sales-entries?periodCode=ไม่ใช่รอบ', { token: admin })).status === 400);

// ── 5 & 6) สร้างสินค้าไม่จำกัด + สินค้า 1 ชิ้น = ร้านเดียว ──────────────
section('5+6) สินค้า และการมอบหมาย');
const p1 = await api('POST', '/api/products', {
  token: admin,
  body: { sku: 'SKU-001', name: 'สินค้า 1', commissionPct: 12.5, franchiseId: shopA.body.franchise.id, startDate: '2026-01-01' },
});
check('สร้างสินค้า + มอบหมายให้ A ในขั้นตอนเดียว',
  p1.status === 201 && p1.body.assignment.franchiseId === shopA.body.franchise.id, p1.body);

const p2 = await api('POST', '/api/products', {
  token: admin, body: { sku: 'SKU-002', name: 'สินค้า 2', commissionPct: 15 },
});
check('สร้างสินค้าที่ยังไม่มอบหมายได้', p2.status === 201 && p2.body.assignment === null);

const clash = await api('POST', '/api/assignments', {
  token: admin,
  body: { productId: p1.body.product.id, franchiseId: shopB.body.franchise.id, startDate: '2026-06-01' },
});
check('สินค้าชิ้นเดิมมอบให้อีกเจ้าของร้านในช่วงทับกันไม่ได้ (409)', clash.status === 409, clash.body);

const laterOk = await api('POST', '/api/assignments', {
  token: admin,
  body: { productId: p2.body.product.id, franchiseId: shopB.body.franchise.id, startDate: '2026-01-01' },
});
check('มอบหมายสินค้าคนละชิ้นให้ B ได้', laterOk.status === 201, laterOk.body);

const denied = await api('POST', '/api/products', {
  token: tokenA, body: { sku: 'SKU-X', name: 'เจ้าของร้านสร้างเอง' },
});
check('เจ้าของร้านสร้างสินค้าเองไม่ได้ (403)', denied.status === 403, denied.body);

const p3 = await api('POST', '/api/products', {
  token: admin,
  body: { sku: 'SKU-003', name: 'สินค้า 3', commissionPct: 12.5, franchiseId: shopA.body.franchise.id, startDate: '2026-01-01' },
});
check('super admin สร้างสินค้าชิ้นที่สองให้ A ได้',
  p3.status === 201 && p3.body.assignment.franchiseId === shopA.body.franchise.id, p3.body);

const listA = await api('GET', '/api/products', { token: tokenA });
check('ร้าน A เห็นเฉพาะสินค้าของตัวเอง (2 ชิ้น)', listA.body.items.length === 2, listA.body.items.map((i) => i.sku));
check('1 ร้านถือได้หลายชิ้น', listA.body.items.length > 1);

// ── 3) เก็บยอดรายครึ่งเดือน + เปอร์เซ็นต์ที่ต้องจ่าย ──────────────────────
section('3) ยอดขายรายครึ่งเดือน + ส่วนต่าง');
check('เจ้าของร้านกรอกยอดขายเองไม่ได้ (403)', (await api('POST', '/api/sales-entries', {
  token: tokenA, body: { periodCode: '2026-09-H1', productId: p1.body.product.id, grossAmount: 100000 },
})).status === 403);
check('เจ้าของร้านเปิดดูรายการยอดขายไม่ได้',
  (await api('GET', '/api/sales-entries', { token: tokenA })).status === 403);

const e1 = await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2026-09-H1', productId: p1.body.product.id, grossAmount: 100000 },
});
check('บันทึกยอดเต็ม 100,000 แล้วคิด 12.5% = 12,500',
  e1.status === 201 && e1.body.commissionAmount === 12500 && e1.body.commissionPct === 12.5, e1.body);
check('รอบบิล H1 ครอบคลุม 1–15',
  e1.body.period.startDate === '2026-09-01' && e1.body.period.endDate === '2026-09-15');

const e1b = await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2026-09-H1', productId: p1.body.product.id, grossAmount: 120000.55 },
});
check('บันทึกซ้ำรอบเดิม = แก้ไขรายการเดิม',
  e1b.body.id === e1.body.id && e1b.body.grossAmount === 120000.55 && e1b.body.commissionAmount === 15000.07, e1b.body);

const cross = await api('POST', '/api/sales-entries', {
  token: tokenB, body: { periodCode: '2026-09-H1', productId: p1.body.product.id, grossAmount: 5000 },
});
check('ร้านอื่นบันทึกยอดสินค้าที่ไม่ใช่ของตัวเองไม่ได้', cross.status === 400 || cross.status === 403, cross.body);

await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2026-09-H2', productId: p1.body.product.id, grossAmount: 80000 },
});
await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2026-08-H1', productId: p1.body.product.id, grossAmount: 90000 },
});
await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2026-08-H2', productId: p1.body.product.id, grossAmount: 60000 },
});
const eB = await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2026-09-H1', productId: p2.body.product.id, grossAmount: 50000, franchiseId: shopB.body.franchise.id },
});
check('ร้าน B บันทึกยอดสินค้าตัวเองได้ (15% = 7,500)', eB.body.commissionAmount === 7500, eB.body);

// % ผูกกับสินค้า — สินค้าคนละชิ้นของร้านเดียวกันตั้งคนละ % ได้
section('% ส่วนต่างผูกกับสินค้า');
check('สร้างสินค้าโดยไม่ระบุ % ไม่ได้', (await api('POST', '/api/products', {
  token: admin, body: { sku: 'SKU-NOPCT', name: 'ไม่ตั้ง %' },
})).status === 400);

const pctProduct = await api('POST', '/api/products', {
  token: admin, body: { sku: 'SKU-PCT', name: 'สินค้า % สูง', commissionPct: 20, franchiseId: shopA.body.franchise.id },
});
check('สินค้าชิ้นใหม่ของร้านเดิมตั้ง % ต่างกันได้ (20%)',
  pctProduct.status === 201 && pctProduct.body.product.commissionPct === 20, pctProduct.body);

const pctEntry = await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2026-10-H2', productId: pctProduct.body.product.id, grossAmount: 10000 },
});
check('คิดส่วนต่างตาม % ของสินค้า ไม่ใช่ของร้าน (10,000 × 20% = 2,000)',
  pctEntry.body.commissionPct === 20 && pctEntry.body.commissionAmount === 2000, pctEntry.body);

const pctEdited = await api('PATCH', `/api/products/${pctProduct.body.product.id}`, {
  token: admin, body: { commissionPct: 30 },
});
check('แก้ % ของสินค้าได้', pctEdited.body.commissionPct === 30, pctEdited.body);
check('แก้ % แล้วยอดที่บันทึกไปแล้วไม่เปลี่ยน (snapshot)',
  (await api('GET', `/api/sales-entries/${pctEntry.body.id}`, { token: admin })).body.commissionAmount === 2000);

// เก็บกวาดไม่ให้ไปกวนยอดรวมของเทสต์อื่น
await api('DELETE', `/api/sales-entries/${pctEntry.body.id}`, { token: admin });

// ── อนุมัติ + ออกใบเรียกเก็บ + รับชำระ ────────────────────────────────────
/*
 * ระบบรับเฉพาะสลิปที่อัปโหลดเข้ามาจริง ไม่รับลิงก์ภายนอก
 * เทสต์ที่ต้องแจ้งชำระจึงต้องมีไฟล์จริงก่อน
 */
// ลิงก์ไฟล์ที่ API ส่งออกมามีลายเซ็นต่อท้าย (?exp=&sig=) — เทียบกันที่ตัวไฟล์
const fileOf = (url) => (url ? String(url).split('?')[0] : url);

const SLIP_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154'
  + '789c6300010000050001',
  'hex',
);

async function uploadSlip(token = admin) {
  const res = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', authorization: `Bearer ${token}` },
    body: SLIP_PNG,
  });
  return (await res.json()).url;
}

const slip = await uploadSlip();

section('ใบเรียกเก็บ');
const approve = await api('POST', `/api/sales-entries/${e1.body.id}/approve`, { token: admin });
check('super admin อนุมัติยอดได้', approve.body.status === 'APPROVED', approve.body);
check('เจ้าของร้านอนุมัติเองไม่ได้',
  (await api('POST', `/api/sales-entries/${e1.body.id}/approve`, { token: tokenA })).status === 403);

const inv = await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2026-09-H1' },
});
check('ออกใบเรียกเก็บรอบ 2026-09-H1 ได้', inv.status === 201 && inv.body.commissionTotal === 15000.07, inv.body);
const again = await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2026-09-H1' },
});
check('ออกใบซ้ำในรอบเดิมของร้านเดิมไม่ได้',
  again.status === 409 && again.body.error.message.includes('ออกได้ใบเดียว'), again.body);

// ── ค่าใช้จ่ายอื่น + ส่วนลดในบิล ──────────────────────────────────────────
section('ค่าใช้จ่ายอื่น / ส่วนลดในบิล');
const items = await api('GET', '/api/charge-items', { token: admin });
check('มีรายการค่าใช้จ่าย/ส่วนลดตั้งต้นให้เลือก', items.body.items.length >= 6, items.body.items.map((i) => i.name));
const mktFee = items.body.items.find((i) => i.name === 'ค่าการตลาดส่วนกลาง');
check('รายการตั้งต้นแบบ % มีค่า default', mktFee.defaultPct === 2 && mktFee.kind === 'CHARGE', mktFee);

// รายการตั้งต้นต้องเลือกวิธีคิดอย่างเดียว: จำนวนเงิน หรือ % (ตั้งทั้งคู่ตีความไม่ได้)
check('สร้างรายการที่ตั้งทั้งจำนวนเงินและ % ไม่ได้', (await api('POST', '/api/charge-items', {
  token: admin, body: { name: 'ตั้งสองอย่าง', kind: 'CHARGE', defaultAmount: 100, defaultPct: 5 },
})).status === 400);
check('แก้ให้กลายเป็นตั้งทั้งคู่ก็ไม่ได้', (await api('PATCH', `/api/charge-items/${mktFee.id}`, {
  token: admin, body: { defaultAmount: 100 },
})).status === 400);
const byAmount = await api('POST', '/api/charge-items', {
  token: admin, body: { name: 'ค่าอบรมพนักงาน', kind: 'CHARGE', defaultAmount: 1500, defaultPct: null },
});
check('สร้างรายการแบบจำนวนเงินได้',
  byAmount.status === 201 && byAmount.body.defaultAmount === 1500 && byAmount.body.defaultPct === null, byAmount.body);
const eachTime = await api('POST', '/api/charge-items', {
  token: admin, body: { name: 'ค่าใช้จ่ายเฉพาะกิจ', kind: 'CHARGE', defaultAmount: null, defaultPct: null },
});
check('สร้างรายการแบบกรอกทุกครั้งได้ (ไม่ตั้งค่าไว้)',
  eachTime.status === 201 && eachTime.body.defaultAmount === null && eachTime.body.defaultPct === null, eachTime.body);
check('ชื่อรายการซ้ำไม่ได้ (ใช้ชื่อแทนรหัสแล้ว)', (await api('POST', '/api/charge-items', {
  token: admin, body: { name: 'ค่าอบรมพนักงาน', kind: 'CHARGE', defaultAmount: 999 },
})).status === 409);

// ส่วนต่าง 15,000.07 -> ค่าการตลาด 2% = 300.00
const withPct = await api('POST', `/api/invoices/${inv.body.id}/adjustments`, {
  token: admin, body: { chargeItemId: mktFee.id },
});
check('เพิ่มค่าใช้จ่ายจากรายการตั้งต้น (2% ของส่วนต่าง)',
  withPct.status === 201 && withPct.body.chargeTotal === 300 && withPct.body.netTotal === 15300.07, withPct.body);

const customCharge = await api('POST', `/api/invoices/${inv.body.id}/adjustments`, {
  token: admin, body: { kind: 'CHARGE', label: 'ค่าขนส่งรอบพิเศษ', amount: 1200.50 },
});
check('พิมพ์ค่าใช้จ่ายเองได้', customCharge.body.chargeTotal === 1500.5 && customCharge.body.netTotal === 16500.57, customCharge.body);

const discount = await api('POST', `/api/invoices/${inv.body.id}/adjustments`, {
  token: admin, body: { kind: 'DISCOUNT', label: 'ส่วนลดพิเศษ', amount: 500 },
});
check('หักส่วนลดออกจากยอดที่ต้องจ่าย',
  discount.body.discountTotal === 500 && discount.body.netTotal === 16000.57, discount.body);
check('ยอดที่ต้องจ่าย = ส่วนต่าง + ค่าใช้จ่าย − ส่วนลด',
  discount.body.netTotal === Number((discount.body.commissionTotal + discount.body.chargeTotal - discount.body.discountTotal).toFixed(2)));

const tooMuch = await api('POST', `/api/invoices/${inv.body.id}/adjustments`, {
  token: admin, body: { kind: 'DISCOUNT', label: 'ลดเกิน', amount: 999999 },
});
check('ส่วนลดมากกว่ายอดรวมไม่ได้', tooMuch.status === 400, tooMuch.body);

check('เจ้าของร้านเพิ่มค่าใช้จ่าย/ส่วนลดเองไม่ได้', (await api('POST', `/api/invoices/${inv.body.id}/adjustments`, {
  token: tokenA, body: { kind: 'DISCOUNT', label: 'ขอลดเอง', amount: 100 },
})).status === 403);

const removed = await api('DELETE', `/api/invoices/${inv.body.id}/adjustments/${discount.body.adjustments.find((a) => a.label === 'ส่วนลดพิเศษ').id}`, { token: admin });
check('ลบรายการออกแล้วยอดคำนวณใหม่', removed.body.discountTotal === 0 && removed.body.netTotal === 16500.57, removed.body);

// เงินเข้าได้ทางเดียว: ร้านแจ้งชำระ -> ส่วนกลางอนุมัติ ส่วนกลางจ่ายแทนร้านเองไม่ได้
check('ส่วนกลางบันทึกรับชำระเองโดยตรงไม่ได้ (ไม่มี endpoint นี้แล้ว)',
  (await api('POST', `/api/invoices/${inv.body.id}/payments`, { token: admin, body: { amount: 5000 } })).status === 404);

const shopPays = await api('POST', '/api/payments', {
  token: tokenA,
  body: { invoiceId: inv.body.id, amount: 5000, paidAt: '2026-09-20', slipUrl: slip },
});
check('ร้านแจ้งชำระบางส่วนได้', shopPays.status === 201 && shopPays.body.status === 'PENDING', shopPays.body);

const stillOpen = await api('GET', `/api/invoices/${inv.body.id}`, { token: admin });
check('แจ้งแล้วแต่ยังไม่อนุมัติ ยอดยังไม่ถูกตัด',
  stillOpen.body.paid === 0 && stillOpen.body.status === 'OPEN', stillOpen.body);

await api('POST', `/api/payments/${shopPays.body.id}/approve`, { token: admin, body: {} });
const afterApprove = await api('GET', `/api/invoices/${inv.body.id}`, { token: admin });
check('ส่วนกลางอนุมัติแล้วยอดถึงถูกตัด -> PARTIAL',
  afterApprove.body.status === 'PARTIAL' && afterApprove.body.outstanding === 11500.57, afterApprove.body);

check('ร้านแจ้งชำระเกินยอดค้างไม่ได้', (await api('POST', '/api/payments', {
  token: tokenA, body: { invoiceId: inv.body.id, amount: 999999, paidAt: '2026-09-20', slipUrl: slip },
})).status === 400);

// ── 4) รายงานเปรียบเทียบ ─────────────────────────────────────────────────
section('4) รายงานรายเดือน / รายรอบบิล / เทียบช่วงวันที่');
const byMonth = await api('GET', '/api/reports/by-month?from=2026-08&to=2026-09', { token: tokenA });
const sep = byMonth.body.rows.find((r) => r.bucket === '2026-09');
check('รายงานรายเดือนแยกครึ่งเดือน H1/H2',
  sep.halves.length === 2 && sep.halves[0].bucket === '2026-09-H1' && sep.halves[0].grossAmount === 120000.55, sep);
check('ยอดรวมเดือน ก.ย. = H1 + H2', sep.grossAmount === 200000.55, sep.grossAmount);

const byPeriod = await api('GET', '/api/reports/by-period?from=2026-08-H1&to=2026-09-H2', { token: tokenA });
check('รายงานรายรอบบิลคืนครบ 4 รอบ', byPeriod.body.rows.length === 4, byPeriod.body.rows.map((r) => r.bucket));

const cmpMonth = await api('GET', '/api/reports/compare?granularity=month&current=2026-09&previous=2026-08', { token: tokenA });
check('เทียบรายเดือน ก.ย. vs ส.ค.',
  cmpMonth.body.current.grossAmount === 200000.55 && cmpMonth.body.previous.grossAmount === 150000
  && cmpMonth.body.diff.grossAmount === 50000.55, cmpMonth.body.diff);

const cmpPeriod = await api('GET', '/api/reports/compare?granularity=period&current=2026-09-H1', { token: tokenA });
check('เทียบรอบบิล 2026-09-H1 กับรอบก่อนหน้าอัตโนมัติ',
  cmpPeriod.body.previous.key === '2026-08-H2' && cmpPeriod.body.current.grossAmount === 120000.55, cmpPeriod.body);

const cmpRange = await api('GET', '/api/reports/compare-range?aStart=2026-09-01&aEnd=2026-09-15&against=prev_month', { token: tokenA });
check('เทียบช่วงวันที่เดียวกันข้ามเดือน (1–15 ก.ย. vs 1–15 ส.ค.)',
  cmpRange.body.current.grossAmount === 120000.55 && cmpRange.body.previous.grossAmount === 90000
  && cmpRange.body.current.periods[0] === '2026-09-H1', cmpRange.body);

const cmpExplicit = await api('GET', '/api/reports/compare-range?aStart=2026-09-01&aEnd=2026-09-30&bStart=2026-08-01&bEnd=2026-08-31', { token: tokenA });
check('เทียบสองช่วงวันที่ที่ระบุเอง',
  cmpExplicit.body.current.periods.length === 2 && cmpExplicit.body.previous.periods.length === 2, cmpExplicit.body);

const scoped = await api('GET', '/api/reports/by-month?from=2026-09&to=2026-09', { token: tokenA });
check('รายงานของร้านไม่ปนยอดของสาขาอื่น',
  scoped.body.total.grossAmount === 200000.55, scoped.body.total);

const allShops = await api('GET', '/api/reports/breakdown?from=2026-09-H1&to=2026-09-H2&groupBy=franchise', { token: admin });
check('super admin เห็นภาพรวมทุกร้าน', allShops.body.rows.length === 2, allShops.body.rows);

const dash = await api('GET', '/api/reports/dashboard?periodCode=2026-09-H1', { token: admin });
check('dashboard สรุปรอบปัจจุบันได้', dash.body.current.grossAmount === 170000.55, dash.body.current);

// ── หน้าชำระเงินลูกค้า + หน้าตรวจสอบของ super ─────────────────────────────
section('การแจ้งชำระเงิน และการตรวจสอบ');
const center = await api('GET', '/api/payments/center', { token: tokenA });
check('ลูกค้าเห็นใบที่ยังค้างชำระในหน้าชำระเงิน',
  center.body.outstandingInvoices.length === 1 && center.body.totalOutstanding === 11500.57, center.body.totalOutstanding);

const sub1 = await api('POST', '/api/payments', {
  token: tokenA,
  body: {
    invoiceId: inv.body.id, amount: 1500.57, paidAt: '2026-09-16',
    method: 'โอนธนาคาร', reference: 'TRX-001', slipUrl: slip,
  },
});
check('ลูกค้าแจ้งชำระเงินได้ -> รอตรวจสอบ', sub1.status === 201 && sub1.body.status === 'PENDING', sub1.body);
check('แจ้งชำระแล้วยังไม่ตัดยอดจนกว่าจะตรวจสอบ',
  (await api('GET', `/api/invoices/${inv.body.id}`, { token: tokenA })).body.outstanding === 11500.57);

check('ลิงก์สลิปต้องเป็น URL ที่ถูกต้อง', (await api('POST', '/api/payments', {
  token: tokenA, body: { invoiceId: inv.body.id, amount: 100, slipUrl: 'ไม่ใช่ลิงก์' },
})).status === 400);

check('แจ้งเกินยอดค้าง (รวมรายการที่รอตรวจอยู่) ไม่ได้', (await api('POST', '/api/payments', {
  token: tokenA, body: { invoiceId: inv.body.id, amount: 11500.57, slipUrl: slip },
})).status === 400);

check('ร้านอื่นแจ้งชำระบิลที่ไม่ใช่ของตัวเองไม่ได้', (await api('POST', '/api/payments', {
  token: tokenB, body: { invoiceId: inv.body.id, amount: 100, slipUrl: slip },
})).status === 403);

const pendingList = await api('GET', '/api/payments?status=PENDING', { token: admin });
check('super admin เห็นรายการรอตรวจสอบ',
  pendingList.body.summary.pendingCount === 1 && pendingList.body.items[0].reference === 'TRX-001', pendingList.body.summary);
check('รายการที่ตรวจสอบมีไฟล์สลิปให้เปิดดู', fileOf(pendingList.body.items[0].slipUrl) === slip, pendingList.body.items[0].slipUrl);

check('เจ้าของร้านอนุมัติการชำระของตัวเองไม่ได้',
  (await api('POST', `/api/payments/${sub1.body.id}/approve`, { token: tokenA })).status === 403);

const rejected = await api('POST', `/api/payments/${sub1.body.id}/reject`, {
  token: admin, body: { reason: 'สลิปไม่ชัด ขอใหม่' },
});
check('super admin ปฏิเสธพร้อมเหตุผลได้',
  rejected.body.status === 'REJECTED' && rejected.body.rejectReason === 'สลิปไม่ชัด ขอใหม่', rejected.body);
check('ปฏิเสธโดยไม่ให้เหตุผลไม่ได้',
  (await api('POST', `/api/payments/${sub1.body.id}/reject`, { token: admin, body: {} })).status === 400);

const sub2 = await api('POST', '/api/payments', {
  token: tokenA,
  body: { invoiceId: inv.body.id, amount: 11500.57, paidAt: '2026-09-17', method: 'พร้อมเพย์', reference: 'TRX-002', slipUrl: slip },
});
check('แจ้งใหม่หลังถูกปฏิเสธได้ (ยอดที่ถูกปฏิเสธไม่กินโควตา)', sub2.status === 201, sub2.body);

const approved = await api('POST', `/api/payments/${sub2.body.id}/approve`, { token: admin });
check('อนุมัติแล้วตัดยอดในบิลทันที -> PAID',
  approved.body.status === 'APPROVED' && approved.body.invoiceOutstanding === 0, approved.body);
const paidInv = await api('GET', `/api/invoices/${inv.body.id}`, { token: admin });
// เงินเข้า 2 ครั้ง (แจ้งบางส่วน + แจ้งส่วนที่เหลือ) จากการแจ้ง 3 ครั้ง (มี 1 ครั้งถูกปฏิเสธ)
check('บิลกลายเป็นชำระครบ และเงินเข้าเท่ากับจำนวนครั้งที่อนุมัติ',
  paidInv.body.status === 'PAID'
  && paidInv.body.payments.length === 2
  && paidInv.body.submissions.filter((x) => x.status === 'APPROVED').length === 2, {
    status: paidInv.body.status,
    payments: paidInv.body.payments.length,
    submissions: paidInv.body.submissions.map((x) => x.status),
  });
check('อนุมัติซ้ำไม่ได้',
  (await api('POST', `/api/payments/${sub2.body.id}/approve`, { token: admin })).status === 409);

// ── เซล: ค่าคอมจากการหาลูกค้ามาเปิดร้าน ───────────────────────────────
section('เซล และค่าคอมจากการหาลูกค้า');
const agent1 = await api('POST', '/api/sales-agents', {
  token: admin,
  body: { username: 'salea', password: 'salea12345', name: 'เซลเอ' },
});
check('สร้างเซลพร้อมยูสเซอร์ได้', agent1.status === 201 && agent1.body.user.role === 'SALES', agent1.body);

const agent2 = await api('POST', '/api/sales-agents', {
  token: admin, body: { username: 'saleb', password: 'saleb12345', name: 'เซลบี' },
});
check('เซลได้บัญชีเข้าระบบอัตโนมัติจาก username เดียวกัน',
  agent2.status === 201 && agent2.body.user.username === agent2.body.agent.username, agent2.body);

check('ต้องตั้ง % หรือค่าคงที่อย่างน้อยหนึ่งอย่าง', (await api('POST', '/api/sales-agents/links', {
  token: admin,
  body: { salesAgentId: agent2.body.agent.id, items: [{ productId: p2.body.product.id }] },
})).status === 400);

// ดีลผูกกับสินค้า ไม่ใช่ทั้งร้าน — เซลได้คอมเฉพาะสินค้าที่ตัวเองผลักดัน
// ตัวเลขต้องกรอกที่ดีลเสมอ เซลไม่มีค่าตั้งต้นให้หยิบมาใช้แล้ว
const link1res = await api('POST', '/api/sales-agents/links', {
  token: admin,
  body: {
    salesAgentId: agent1.body.agent.id,
    startDate: '2026-01-01',
    items: [{ productId: p1.body.product.id, commissionPct: 5, fixedAmount: 300 }],
  },
});
const link1 = { status: link1res.status, body: link1res.body.items?.[0] ?? link1res.body };
check('ผูกเซลกับสินค้าที่ผลักดัน',
  link1.status === 201 && link1.body.sku === 'SKU-001'
  && link1.body.commissionPct === 5 && link1.body.fixedAmount === 300, link1.body);

check('สินค้าชิ้นเดียวมีเซลซ้อนกันในช่วงเวลาเดียวกันไม่ได้', (await api('POST', '/api/sales-agents/links', {
  token: admin,
  body: {
    salesAgentId: agent2.body.agent.id,
    startDate: '2026-06-01',
    items: [{ productId: p1.body.product.id, commissionPct: 5 }],
  },
})).status === 409);

const link2res = await api('POST', '/api/sales-agents/links', {
  token: admin,
  body: {
    salesAgentId: agent2.body.agent.id,
    startDate: '2026-01-01',
    basis: 'GROSS',
    items: [{ productId: p2.body.product.id, commissionPct: 12 }],
  },
});
const link2 = { status: link2res.status, body: link2res.body.items[0] };
check('ผูกเซลอีกคนกับสินค้าอีกชิ้นได้ (คิดจากยอดขายเต็ม)',
  link2.status === 201 && link2.body.basis === 'GROSS', link2.body);

// ผูกหลายสินค้าในครั้งเดียว แต่ละชิ้นตั้งเรตเองได้
// สินค้าคนละชิ้นในร้านเดียวกัน ให้เซลคนละคนถือได้ — จุดสำคัญของโมเดลใหม่
const p4 = await api('POST', '/api/products', {
  token: admin,
  body: { sku: 'SKU-004', name: 'สินค้า 4', commissionPct: 10, franchiseId: shopB.body.franchise.id, startDate: '2026-01-01' },
});
const batch = await api('POST', '/api/sales-agents/links', {
  token: admin,
  body: {
    salesAgentId: agent2.body.agent.id,
    startDate: '2026-01-01',
    items: [
      { productId: p3.body.product.id, commissionPct: 10 },
      { productId: p4.body.product.id, commissionPct: 3, fixedAmount: 50 },
    ],
  },
});
check('ผูกดีลหลายสินค้าในครั้งเดียวได้ แต่ละชิ้นคนละเรต',
  batch.status === 201 && batch.body.count === 2
  && batch.body.items[0].commissionPct === 10
  && batch.body.items[1].commissionPct === 3 && batch.body.items[1].fixedAmount === 50, batch.body);
check('สินค้าคนละชิ้นของร้านเดียวกัน ให้เซลคนละคนถือได้', batch.body.items[0].sku === 'SKU-003');
const link3 = { body: batch.body.items[0] };

// ทั้งชุดต้องล้มพร้อมกัน ไม่ใช่บันทึกไปครึ่งเดียวแล้วค้าง
const p5 = await api('POST', '/api/products', {
  token: admin,
  body: { sku: 'SKU-005', name: 'สินค้า 5', commissionPct: 10, franchiseId: shopB.body.franchise.id, startDate: '2026-01-01' },
});
const partialBatch = await api('POST', '/api/sales-agents/links', {
  token: admin,
  body: {
    salesAgentId: agent1.body.agent.id,
    startDate: '2026-01-01',
    items: [
      { productId: p5.body.product.id, commissionPct: 3 },
      { productId: p3.body.product.id, commissionPct: 3 },
    ],
  },
});
check('ผูกดีลเป็นชุด ถ้ามีชิ้นที่ชนต้องไม่บันทึกอะไรเลย',
  partialBatch.status === 409
  && (await api('GET', `/api/sales-agents/links?productId=${p5.body.product.id}`, { token: admin })).body.items.length === 0,
  partialBatch.body);

// ออกบิลรอบใหม่ให้ A แล้วต้องเกิดค่าคอมเซลอัตโนมัติ
const e2 = await api('GET', `/api/sales-entries?periodCode=2026-08-H1`, { token: admin });
for (const e of e2.body.items) await api('POST', `/api/sales-entries/${e.id}/approve`, { token: admin });
const inv2 = await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2026-08-H1' },
});
check('ออกบิลรอบ 2026-08-H1 ได้ (ส่วนต่าง 11,250)', inv2.status === 201 && inv2.body.commissionTotal === 11250, inv2.body);

const comms = await api('GET', `/api/sales-agents/commissions?salesAgentId=${agent1.body.agent.id}`, { token: admin });
const c1 = comms.body.items.find((c) => c.invoiceNo === inv2.body.invoiceNo);
check('ออกบิลแล้วเกิดค่าคอมเซลอัตโนมัติ (5% ของ 11,250 + เหมา 300 = 862.50)',
  c1 && c1.pctAmount === 562.5 && c1.fixedAmount === 300 && c1.totalAmount === 862.5, c1);
check('คอมเซลคิดจากส่วนต่าง ไม่ใช่ยอดหลังบวกค่าใช้จ่าย', c1.baseAmount === 11250 && c1.basis === 'COMMISSION');

const saleToken = (await api('POST', '/api/auth/login', { body: { username: 'salea', password: 'salea12345' } })).body.token;
const me = await api('GET', '/api/sales-agents/me', { token: saleToken });
check('เซลล็อกอินเห็นสินค้าที่ตัวเองถือดีลและยอดคอม',
  me.body.agent.username === 'salea' && me.body.products.length === 1 && me.body.summary.pending > 0, me.body.summary);

const myComms = await api('GET', '/api/sales-agents/me/commissions', { token: saleToken });
check('เซลเห็นเฉพาะคอมของตัวเอง',
  myComms.body.items.every((c) => c.agentUsername === 'salea'), myComms.body.items.map((c) => c.agentUsername));

// ปุ่ม "ดูมุมมองนี้" ของ super admin เรียก /me พร้อม salesAgentId
const asAgent = await api('GET', `/api/sales-agents/me?salesAgentId=${agent1.body.agent.id}`, { token: admin });
check('super admin ดูมุมมองของเซลได้',
  asAgent.status === 200 && asAgent.body.agent.username === 'salea', asAgent.body?.agent);
check('super admin ต้องระบุว่าดูของเซลคนไหน',
  (await api('GET', '/api/sales-agents/me', { token: admin })).status === 403);
/* ── ค่าคอมรายการอื่น ๆ ที่พิมพ์เป็นจำนวนเงิน ──────────────
 * แนวคิดเดียวกับค่าใช้จ่ายอื่น/ส่วนลดของฝั่งบิล แต่เป็นเงินที่เราจ่ายให้เซล
 * ต้องลงรอบเดียวกับคอมจากดีล เพื่อให้จ่ายทีเดียวจบ
 */
const manual1 = await api('POST', '/api/sales-agents/commissions/manual', {
  token: admin,
  body: { salesAgentId: agent1.body.agent.id, periodCode: '2026-08-H1', label: 'โบนัสปิดร้านใหม่', amount: 5000 },
});
check('เพิ่มค่าคอมอื่น ๆ แบบจำนวนเงินได้',
  manual1.status === 201 && manual1.body.totalAmount === 5000 && manual1.body.isManual === true, manual1.body);
check('ค่าคอมที่พิมพ์เองไม่ผูกกับร้านหรือบิลใด',
  manual1.body.franchiseUsername === null && manual1.body.invoiceNo === null, manual1.body);

const manual2 = await api('POST', '/api/sales-agents/commissions/manual', {
  token: admin,
  body: { salesAgentId: agent1.body.agent.id, periodCode: '2026-08-H1', label: 'หักคืนที่คิดเกิน', amount: -1200 },
});
check('ค่าคอมอื่น ๆ ใส่ติดลบได้ (หักคืน)', manual2.status === 201 && manual2.body.totalAmount === -1200, manual2.body);

check('ค่าคอมอื่น ๆ ต้องมีชื่อรายการ', (await api('POST', '/api/sales-agents/commissions/manual', {
  token: admin, body: { salesAgentId: agent1.body.agent.id, periodCode: '2026-08-H1', label: '', amount: 100 },
})).status === 400);

check('ค่าคอมอื่น ๆ จำนวนเงินเป็นศูนย์ไม่ได้', (await api('POST', '/api/sales-agents/commissions/manual', {
  token: admin, body: { salesAgentId: agent1.body.agent.id, periodCode: '2026-08-H1', label: 'ว่าง', amount: 0 },
})).status === 400);

// ต้องไปรวมกองกับคอมจากดีลของรอบเดียวกัน ไม่ใช่แยกไปอยู่คนละที่
const h1 = await api('GET', `/api/sales-agents/commissions?salesAgentId=${agent1.body.agent.id}&periodCode=2026-08-H1`, { token: admin });
check('ค่าคอมที่พิมพ์เองไปรวมกับคอมจากดีลในรอบเดียวกัน',
  h1.body.items.filter((c) => c.isManual).length === 2
  && h1.body.items.some((c) => !c.isManual), h1.body.items.map((c) => c.title));
check('ยอดรวมของรอบนับรวมรายการที่พิมพ์เองและหักลบตัวติดลบให้',
  h1.body.summary.total === Number((862.5 + 5000 - 1200).toFixed(2)), h1.body.summary);

check('แก้ไขค่าคอมที่พิมพ์เองได้', (await api('PATCH', `/api/sales-agents/commissions/manual/${manual1.body.id}`, {
  token: admin, body: { amount: 4500 },
})).body.totalAmount === 4500);

check('รายการที่ระบบคิดจากดีล แก้ผ่านช่องทางนี้ไม่ได้', (await api('PATCH', `/api/sales-agents/commissions/manual/${c1.id}`, {
  token: admin, body: { amount: 999 },
})).status === 409);
check('รายการที่ระบบคิดจากดีล ลบผ่านช่องทางนี้ไม่ได้',
  (await api('DELETE', `/api/sales-agents/commissions/manual/${c1.id}`, { token: admin })).status === 409);

await api('POST', `/api/sales-agents/commissions/${manual2.body.id}/pay`, { token: admin, body: {} });
check('จ่ายเงินให้เซลแล้ว แก้ไม่ได้',
  (await api('PATCH', `/api/sales-agents/commissions/manual/${manual2.body.id}`, { token: admin, body: { amount: 1 } })).status === 409);
check('จ่ายเงินให้เซลแล้ว ลบไม่ได้',
  (await api('DELETE', `/api/sales-agents/commissions/manual/${manual2.body.id}`, { token: admin })).status === 409);

check('ลบค่าคอมที่พิมพ์เองที่ยังไม่จ่ายได้',
  (await api('DELETE', `/api/sales-agents/commissions/manual/${manual1.body.id}`, { token: admin })).status === 200);

check('เซลดูยอดขายของร้านไม่ได้', (await api('GET', '/api/sales-entries', { token: saleToken })).status === 403);
check('เซลดูรายงานยอดขายไม่ได้', (await api('GET', '/api/reports/by-month?from=2026-08&to=2026-09', { token: saleToken })).status === 403);
check('เซลดูใบเรียกเก็บของร้านไม่ได้', (await api('GET', '/api/invoices', { token: saleToken })).status === 403);
check('เซลสร้างเซลคนใหม่ไม่ได้',
  (await api('POST', '/api/sales-agents', { token: saleToken, body: { username: 'salex', password: 'salex12345', name: 'x' } })).status === 403);

const paidComm = await api('POST', `/api/sales-agents/commissions/${c1.id}/pay`, { token: admin, body: { paidAt: '2026-09-25' } });
check('super admin บันทึกว่าจ่ายคอมเซลแล้ว', paidComm.body.status === 'PAID', paidComm.body);
check('จ่ายซ้ำไม่ได้', (await api('POST', `/api/sales-agents/commissions/${c1.id}/pay`, { token: admin })).status === 409);

const voided = await api('POST', `/api/invoices/${inv2.body.id}/void`, { token: admin, body: { reason: 'ทดสอบยกเลิก' } });
check('ยกเลิกบิลได้เมื่อยังไม่มีการชำระ', voided.body.status === 'VOID', voided.body.status);
const afterVoid = await api('GET', `/api/sales-agents/commissions?salesAgentId=${agent1.body.agent.id}`, { token: admin });
check('ยกเลิกบิลแล้วคอมเซลที่จ่ายไปแล้วไม่ถูกล้าง',
  afterVoid.body.items.find((c) => c.id === c1.id).status === 'PAID', afterVoid.body.items.map((c) => c.status));


// ── เลือกเฉพาะบางสินค้าเข้าบิล ────────────────────────────────────────────
section('ออกใบเรียกเก็บแบบเลือกสินค้า');
// เตรียมรอบ 2026-08-H2 ของ A ที่มี 2 สินค้า (SKU-001 = 60,000 @12.5%, SKU-003 = 30,000 @5%)
await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2026-08-H2', productId: p3.body.product.id, grossAmount: 30000 },
});
const aug2 = await api('GET', '/api/sales-entries?periodCode=2026-08-H2', { token: admin });
for (const e of aug2.body.items) await api('POST', `/api/sales-entries/${e.id}/approve`, { token: admin });
const pickOne = aug2.body.items.find((e) => e.sku === 'SKU-001');
const pickTwo = aug2.body.items.find((e) => e.sku === 'SKU-003');

check('เลือกรายการที่ไม่มีอยู่ในรอบนั้นไม่ได้', (await api('POST', '/api/invoices/generate', {
  token: admin,
  body: { franchiseId: shopA.body.franchise.id, periodCode: '2026-08-H2', entryIds: [pickOne.id, 999999] },
})).status === 400);

check('ส่ง entryIds ว่างไม่ได้', (await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2026-08-H2', entryIds: [] },
})).status === 400);

const partial = await api('POST', '/api/invoices/generate', {
  token: admin,
  body: { franchiseId: shopA.body.franchise.id, periodCode: '2026-08-H2', entryIds: [pickOne.id] },
});
check('ออกบิลเฉพาะสินค้าที่เลือกได้ (SKU-001 เท่านั้น)',
  partial.status === 201 && partial.body.lines.length === 1 && partial.body.commissionTotal === 7500, partial.body);

const leftover = await api('GET', '/api/sales-entries?periodCode=2026-08-H2', { token: admin });
check('รายการที่ไม่ได้เลือกยังไม่ถูกออกบิล รอเติมเข้าใบเดิม',
  leftover.body.items.find((e) => e.id === pickTwo.id).status !== 'INVOICED', leftover.body.items.map((e) => `${e.sku}:${e.status}`));

// ── หนึ่งร้าน / หนึ่งรอบ = ใบเดียว ───────────────────────────────────────
section('หนึ่งรอบบิลออกได้ใบเดียวต่อร้าน');
const second = await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2026-08-H2' },
});
check('ออกใบที่สองของรอบเดิมไม่ได้', second.status === 409, { status: second.status, body: second.body });
check('บอกเลขที่ใบเดิมในข้อความเตือนด้วย',
  String(second.body.error?.message ?? '').includes(partial.body.invoiceNo), second.body.error);

const invList = (await api('GET', '/api/invoices?periodCode=2026-08-H2', { token: admin })).body;
check('รอบนี้มีใบเดียวจริง ๆ',
  invList.items.filter((i) => i.franchiseUsername === 'shopa' && i.status !== 'VOID').length === 1,
  invList.items.map((i) => `${i.invoiceNo}:${i.status}`));
check('ใบเดิมบอกจำนวนรายการที่ยังไม่ได้เรียกเก็บ',
  invList.items.find((i) => i.invoiceNo === partial.body.invoiceNo).pendingEntries === 1, invList.items);

// รายการที่เหลือต้องมีทางขึ้นบิล ไม่งั้นจะค้างเก็บเงินไม่ได้ตลอดไป
const added = await api('POST', `/api/invoices/${partial.body.id}/lines`, { token: admin, body: {} });
check('เติมรายการที่เหลือเข้าใบเดิมได้ (7,500 + 3,750 = 11,250)',
  added.status === 200 && added.body.lines.length === 2 && added.body.commissionTotal === 11250, added.body);
check('เติมแล้วไม่เหลือรายการค้างในรอบนั้น', added.body.pendingEntries === 0, added.body.pendingEntries);
check('เติมซ้ำอีกไม่ได้เพราะไม่เหลืออะไรแล้ว',
  (await api('POST', `/api/invoices/${partial.body.id}/lines`, { token: admin, body: {} })).status === 400);

/*
 * บิลใบนี้มี 2 สินค้าที่เซลคนละคนถือดีล — ต้องแตกคอมเป็นคนละแถว
 *   salea ถือ SKU-001 (7,500 × 5% = 375 + เหมา 300) = 675
 *   saleb ถือ SKU-003 (3,750 × 10% = 375 ไม่มีเหมา)  = 375
 */
const commsA = (await api('GET', `/api/sales-agents/commissions?salesAgentId=${agent1.body.agent.id}&periodCode=2026-08-H2`, { token: admin })).body;
check('ค่าคอมเซลคิดใหม่ตามยอดที่เพิ่มขึ้น เหลือรายการเดียวต่อรอบ',
  commsA.items.filter((c) => c.status !== 'VOID').length === 1, commsA.items.map((c) => `${c.status}:${c.totalAmount}`));
check('salea ได้คอมเฉพาะสินค้าที่ตัวเองถือ (375 + เหมา 300 = 675)',
  commsA.summary.total === 675, { total: commsA.summary.total, breakdown: commsA.items.map((c) => [c.pctAmount, c.fixedAmount]) });

const commsB = (await api('GET', `/api/sales-agents/commissions?salesAgentId=${agent2.body.agent.id}&periodCode=2026-08-H2`, { token: admin })).body;
check('บิลใบเดียวแตกคอมให้เซลคนที่สองด้วย (3,750 × 10% = 375)',
  commsB.summary.total === 375, { total: commsB.summary.total, breakdown: commsB.items.map((c) => [c.pctAmount, c.fixedAmount]) });

const bothOnInvoice = (await api('GET', `/api/sales-agents/commissions?periodCode=2026-08-H2`, { token: admin })).body;
check('คอมทั้งสองแถวผูกกับใบเรียกเก็บใบเดียวกัน',
  bothOnInvoice.items.filter((c) => c.invoiceNo === partial.body.invoiceNo && c.status !== 'VOID').length === 2,
  bothOnInvoice.items.map((c) => `${c.agentUsername}:${c.invoiceNo}:${c.totalAmount}`));

section('บันทึกยอดแล้วออกบิลได้เลย ไม่ต้องผ่านขั้นอนุมัติ');
// ใช้รอบใหม่ที่ยังไม่เคยแตะ เพื่อไม่ให้ชนกับเคสอื่นด้านบน
const draftEntry = await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2026-10-H1', productId: p3.body.product.id, grossAmount: 40000 },
});
check('บันทึกยอดแล้วสถานะเป็น DRAFT (ไม่มีขั้นอนุมัติ)',
  draftEntry.status === 201 && draftEntry.body.status === 'DRAFT', draftEntry.body);

const draftInvoice = await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2026-10-H1' },
});
check('ออกใบเรียกเก็บจากยอดที่เพิ่งบันทึกได้ทันที (40,000 × 12.5% = 5,000)',
  draftInvoice.status === 201 && draftInvoice.body.commissionTotal === 5000, draftInvoice.body);

const lockedEdit = await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2026-10-H1', productId: p3.body.product.id, grossAmount: 99999 },
});
check('ยอดที่ออกบิลแล้วแก้ไม่ได้จนกว่าจะยกเลิกบิล', lockedEdit.status === 409, lockedEdit.body);

await api('POST', `/api/invoices/${draftInvoice.body.id}/void`, { token: admin, body: { reason: 'คืนค่าเทสต์' } });
const reopened = await api('GET', '/api/sales-entries?periodCode=2026-10-H1', { token: admin });
check('ยกเลิกบิลแล้วยอดกลับมาพร้อมออกบิลใหม่ ไม่ต้องอนุมัติซ้ำ',
  reopened.body.items.every((e) => e.status !== 'INVOICED'), reopened.body.items.map((e) => e.status));

section('ยอดขายติดลบ (คืนสินค้า) → ยกไปหักรอบหน้า');
const retPeriod = '2026-11-H1';
const retNeg = await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: retPeriod, productId: p1.body.product.id, grossAmount: -40000 },
});
check('กรอกยอดติดลบได้ และส่วนต่างติดลบตาม (-40,000 × 12.5% = -5,000)',
  retNeg.status === 201 && retNeg.body.grossAmount === -40000 && retNeg.body.commissionAmount === -5000, retNeg.body);

/*
 * รอบที่คืนมากกว่าขาย = เราเป็นฝ่ายติดค้างร้าน
 * ไม่โอนเงินคืน แต่ออกบิลยอด 0 แล้วจดยอดไว้ไปหักรอบหน้า
 */
const retInv = await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: retPeriod },
});
check('รอบที่ติดลบออกบิลได้ แต่ยอดที่ต้องจ่ายเป็น 0 ไม่ใช่ error',
  retInv.status === 201 && retInv.body.netTotal === 0 && retInv.body.commissionTotal === -5000
  && retInv.body.outstanding === 0,
  { net: retInv.body.netTotal, commission: retInv.body.commissionTotal, status: retInv.body.status });

const credits = await api('GET', `/api/franchises/${shopA.body.franchise.id}/credits`, { token: admin });
check('ยอดติดลบถูกจดเป็นยอดยกไปหักรอบหน้า 5,000',
  credits.body.summary.open === 5000 && credits.body.items[0].sourceInvoiceNo === retInv.body.invoiceNo,
  credits.body.summary);
check('ร้านดูยอดที่เราติดค้างเขาได้',
  (await api('GET', `/api/franchises/${shopA.body.franchise.id}/credits`, { token: tokenA })).body.summary.open === 5000);
check('ร้านดูยอดของร้านอื่นไม่ได้',
  (await api('GET', `/api/franchises/${shopB.body.franchise.id}/credits`, { token: tokenA })).status === 403);

// ยอดบวกที่เข้ามาทีหลังในรอบเดียวกัน กลบยอดคืน → ยอดยกไปต้องหายไปด้วย
await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: retPeriod, productId: p3.body.product.id, grossAmount: 100000 },
});
const retFixed = await api('POST', `/api/invoices/${retInv.body.id}/lines`, { token: admin, body: {} });
check('เพิ่มยอดบวกเข้าบิลเดิมแล้วกลบยอดคืนได้ (12,500 − 5,000 = 7,500)',
  retFixed.body.grossTotal === 60000 && retFixed.body.commissionTotal === 7500 && retFixed.body.netTotal === 7500,
  { gross: retFixed.body.grossTotal, commission: retFixed.body.commissionTotal, net: retFixed.body.netTotal });
check('ยอดยกไปหายไปเมื่อบิลกลับมาเป็นบวก',
  (await api('GET', `/api/franchises/${shopA.body.franchise.id}/credits`, { token: admin })).body.summary.open === 0);

/* ── ยกยอดข้ามรอบจริง ────────────────────────────────────────
 * ใช้ร้านของตัวเองทั้งหมด เพราะเครดิตติดกับร้าน ถ้าใช้ร้านร่วมกับเทสต์อื่นจะรบกวนยอดกัน
 */
section('ยอดยกไปหักรอบถัดไป');

const cShop = await api('POST', '/api/franchises', {
  token: admin, body: { username: 'shopcredit', password: 'credit12345' },
});
const cProduct = await api('POST', '/api/products', {
  token: admin, body: { sku: 'CREDIT-01', name: 'สินค้าทดสอบยอดยก', commissionPct: 10 },
});
await api('POST', '/api/assignments', {
  token: admin,
  body: { productId: cProduct.body.product.id, franchiseId: cShop.body.franchise.id, startDate: '2026-01-01' },
});
const cBill = async (periodCode, gross) => {
  await api('POST', '/api/sales-entries', {
    token: admin, body: { periodCode, productId: cProduct.body.product.id, grossAmount: gross },
  });
  return api('POST', '/api/invoices/generate', {
    token: admin, body: { franchiseId: cShop.body.franchise.id, periodCode },
  });
};
const cOpen = async () => (await api('GET', `/api/franchises/${cShop.body.franchise.id}/credits`, { token: admin }))
  .body.summary.open;

// รอบที่ 1: คืนของ 80,000 → ติดค้างร้าน 8,000
const cNeg = await cBill('2028-01-H1', -80000);
check('รอบที่ติดลบ: บิลยอด 0 และจดยอดยกไป 8,000',
  cNeg.body.netTotal === 0 && (await cOpen()) === 8000, { net: cNeg.body.netTotal, open: await cOpen() });

// รอบที่ 2: ขายได้ 30,000 → ส่วนต่าง 3,000 หักยอดยกมาหมดพอดี ยังเหลือค้าง 5,000
const cSmall = await cBill('2028-01-H2', 30000);
check('รอบถัดมาที่ยอดน้อยกว่ายอดยกมา: หักจนเหลือ 0 ไม่ติดลบซ้ำ',
  cSmall.body.subtotal === 3000 && cSmall.body.creditApplied === 3000 && cSmall.body.netTotal === 0,
  { subtotal: cSmall.body.subtotal, applied: cSmall.body.creditApplied, net: cSmall.body.netTotal });
check('ยอดยกไปเหลือ 5,000 รอหักรอบถัดไปอีก', (await cOpen()) === 5000);

// รอบที่ 3: ขายได้ 200,000 → ส่วนต่าง 20,000 หักยอดที่เหลือ 5,000 แล้วเก็บจริง 15,000
const cBig = await cBill('2028-02-H1', 200000);
check('รอบที่ยอดมากกว่ายอดยกมา: หักหมดแล้วเก็บส่วนที่เหลือ (20,000 − 5,000 = 15,000)',
  cBig.body.subtotal === 20000 && cBig.body.creditApplied === 5000 && cBig.body.netTotal === 15000,
  { subtotal: cBig.body.subtotal, applied: cBig.body.creditApplied, net: cBig.body.netTotal });
check('ยอดยกไปหมดแล้ว', (await cOpen()) === 0);

// ยกเลิกบิลที่หักยอดยกมาไป → ยอดนั้นต้องกลับมาให้ร้าน ไม่ใช่หายไปเฉย ๆ
await api('POST', `/api/invoices/${cBig.body.id}/void`, { token: admin, body: { reason: 'ทดสอบ' } });
check('ยกเลิกบิลที่หักยอดยกมา แล้วยอดกลับมาเป็นของร้านเหมือนเดิม', (await cOpen()) === 5000);

// ยกเลิกบิลต้นทางของยอดยกไปไม่ได้ ถ้ายอดถูกหักไปใช้แล้ว
check('ยกเลิกบิลต้นทางที่ยอดถูกหักไปใช้แล้วไม่ได้', (await api('POST', `/api/invoices/${cNeg.body.id}/void`, {
  token: admin, body: { reason: 'ทดสอบ' },
})).status === 409);

// ยกเลิกใบที่หักไปก่อน แล้วค่อยยกเลิกต้นทางได้
await api('POST', `/api/invoices/${cSmall.body.id}/void`, { token: admin, body: { reason: 'ทดสอบ' } });
check('ยกเลิกใบที่หักไปครบแล้ว ยกเลิกใบต้นทางได้ และยอดยกไปหายตาม',
  (await api('POST', `/api/invoices/${cNeg.body.id}/void`, { token: admin, body: { reason: 'ทดสอบ' } })).status === 200
  && (await cOpen()) === 0);

section('เวลาที่โอน + หมายเหตุของผู้ตรวจ');
const timeInv = await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2026-11-H2' },
}).then(async (r) => (r.status === 201 ? r : (await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2026-11-H2', productId: p1.body.product.id, grossAmount: 20000 },
}), api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2026-11-H2' },
}))));

const timed = await api('POST', '/api/payments', {
  token: tokenA,
  body: {
    invoiceId: timeInv.body.id, amount: 100, paidAt: '2026-09-20', paidTime: '09:45',
    slipUrl: slip,
  },
});
check('ร้านแจ้งชำระพร้อมเวลาที่โอนได้', timed.status === 201 && timed.body.paidTime === '09:45', timed.body);

check('เวลาผิดรูปแบบถูกปฏิเสธ', (await api('POST', '/api/payments', {
  token: tokenA, body: { invoiceId: timeInv.body.id, amount: 100, paidTime: '25:99', slipUrl: slip },
})).status === 400);

const reviewed = await api('POST', `/api/payments/${timed.body.id}/approve`, {
  token: admin, body: { note: 'ตรงกับรายการเดินบัญชี' },
});
check('หมายเหตุของผู้ตรวจถูกเก็บแยกจากหมายเหตุของร้าน',
  reviewed.body.reviewNote === 'ตรงกับรายการเดินบัญชี' && reviewed.body.paidTime === '09:45', reviewed.body);

section('สมุดรายรับ-รายจ่ายของส่วนกลาง');
const LP = '2026-08-H1';   // รอบที่มีบิลและมีเงินเข้าแล้ว
const exp = await api('POST', '/api/ledger', {
  token: admin, body: { periodCode: LP, kind: 'EXPENSE', label: 'ค่าขนส่ง', amount: 2000, spentOn: '2026-08-05' },
});
check('บันทึกรายจ่ายของส่วนกลางได้',
  exp.status === 201 && exp.body.kind === 'EXPENSE' && exp.body.amount === 2000, exp.body);

const inc = await api('POST', '/api/ledger', {
  token: admin, body: { periodCode: LP, kind: 'INCOME', label: 'เงินคืนซัพพลายเออร์', amount: 500 },
});
check('บันทึกรายรับอื่นได้', inc.status === 201 && inc.body.signedAmount === 500, inc.body);

const ledger = await api('GET', `/api/ledger?periodCode=${LP}`, { token: admin });
check('สรุปกำไรจริง = เก็บได้จริง + รายรับอื่น − รายจ่าย',
  ledger.body.summary.expense === 2000
  && ledger.body.summary.income === 500
  && ledger.body.summary.net === Number((ledger.body.summary.collected + 500 - 2000).toFixed(2)),
  ledger.body.summary);

check('ร้านค้าเปิดสมุดรายรับ-รายจ่ายไม่ได้',
  (await api('GET', `/api/ledger?periodCode=${LP}`, { token: tokenA })).status === 403);
check('ร้านค้าบันทึกรายการลงสมุดไม่ได้', (await api('POST', '/api/ledger', {
  token: tokenA, body: { periodCode: LP, label: 'ลอง', amount: 1 },
})).status === 403);

check('จำนวนเงินติดลบไม่ได้ (ให้เลือกประเภทแทน)', (await api('POST', '/api/ledger', {
  token: admin, body: { periodCode: LP, label: 'ติดลบ', amount: -5 },
})).status === 400);

await api('DELETE', `/api/ledger/${exp.body.id}`, { token: admin });
const afterDel = await api('GET', `/api/ledger?periodCode=${LP}`, { token: admin });
check('ลบรายการแล้วยอดสรุปคิดใหม่', afterDel.body.summary.expense === 0, afterDel.body.summary);

section('ทยอยจ่ายหลายงวดในบิลเดียว');
const instInv = await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2026-12-H1', productId: p1.body.product.id, grossAmount: 80000 },
}).then(() => api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2026-12-H1' },
}));
check('เตรียมบิลสำหรับทดสอบทยอยจ่าย (80,000 × 12.5% = 10,000)',
  instInv.status === 201 && instInv.body.netTotal === 10000, instInv.body);

const inst1 = await api('POST', '/api/payments', {
  token: tokenA, body: { invoiceId: instInv.body.id, amount: 4000, paidAt: '2026-09-20', slipUrl: slip },
});
check('แจ้งงวดที่ 1 ได้ (4,000)', inst1.status === 201, inst1.body);

// ระหว่างที่งวดแรกยังรอตรวจ ต้องกันไม่ให้แจ้งรวมเกินยอดค้าง
check('แจ้งงวดถัดไปรวมแล้วเกินยอดค้างไม่ได้', (await api('POST', '/api/payments', {
  token: tokenA, body: { invoiceId: instInv.body.id, amount: 7000, paidAt: '2026-09-20', slipUrl: slip },
})).status === 400);

await api('POST', `/api/payments/${inst1.body.id}/approve`, { token: admin, body: {} });
const midway = await api('GET', `/api/invoices/${instInv.body.id}`, { token: admin });
check('อนุมัติงวดแรกแล้วบิลเป็น PARTIAL และเหลือ 6,000',
  midway.body.status === 'PARTIAL' && midway.body.outstanding === 6000, midway.body);

const inst2 = await api('POST', '/api/payments', {
  token: tokenA, body: { invoiceId: instInv.body.id, amount: 6000, paidAt: '2026-09-21', slipUrl: slip },
});
await api('POST', `/api/payments/${inst2.body.id}/approve`, { token: admin, body: {} });
const closed = await api('GET', `/api/invoices/${instInv.body.id}`, { token: admin });
check('อนุมัติงวดสุดท้ายแล้วบิลปิดสมบูรณ์ และมีเงินเข้า 2 ครั้ง',
  closed.body.status === 'PAID' && closed.body.outstanding === 0 && closed.body.payments.length === 2, {
    status: closed.body.status, payments: closed.body.payments.length,
  });

check('บิลที่ปิดแล้วแจ้งชำระเพิ่มไม่ได้', (await api('POST', '/api/payments', {
  token: tokenA, body: { invoiceId: instInv.body.id, amount: 100, paidAt: '2026-09-21', slipUrl: slip },
})).status === 409);

/* ── ล็อกการแก้บิลที่เงินขยับไปแล้ว ────────────────────────────
 * หน้าจอซ่อนปุ่ม "แก้ไขบิล" ไว้แล้ว แต่กติกาเรื่องเงินต้องอยู่ที่เซิร์ฟเวอร์
 * ไม่งั้นใครยิง API ตรงก็แก้ยอดบิลที่ร้านจ่ายไปแล้วได้
 */
section('ล็อกไม่ให้แก้บิลที่เงินขยับไปแล้ว');

const mkBill = async (periodCode, gross) => {
  await api('POST', '/api/sales-entries', {
    token: admin, body: { periodCode, productId: p1.body.product.id, grossAmount: gross },
  });
  return api('POST', '/api/invoices/generate', {
    token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode },
  });
};
const addCharge = (invoiceId) => api('POST', `/api/invoices/${invoiceId}/adjustments`, {
  token: admin, body: { kind: 'CHARGE', label: 'ค่าขนส่ง', amount: 100 },
});

// 1. ยังไม่มีใครแตะเงิน → แก้ได้
const freshBill = await mkBill('2027-01-H1', 40000);
const freshAdj = await addCharge(freshBill.body.id);
check('บิลที่ยังไม่มีเงินเข้า เพิ่มค่าใช้จ่ายได้', freshAdj.status === 201, freshAdj.body);
check('ลบค่าใช้จ่ายออกจากบิลที่ยังไม่มีเงินเข้าได้',
  (await api('DELETE', `/api/invoices/${freshBill.body.id}/adjustments/${freshAdj.body.adjustments.at(-1).id}`,
    { token: admin })).status === 200);

// 2. มีสลิปรออยู่ → ห้ามแก้ (ยอดที่ร้านเห็นตอนโอนต้องไม่เปลี่ยนกลางคัน)
const slipBill = await mkBill('2027-01-H2', 40000);
await api('POST', '/api/payments', {
  token: tokenA, body: { invoiceId: slipBill.body.id, amount: 1000, paidAt: '2026-09-21', slipUrl: slip },
});
const slipBlocked = await addCharge(slipBill.body.id);
check('มีสลิปรอตรวจอยู่ แก้บิลไม่ได้', slipBlocked.status === 409, slipBlocked.body);

// 3. เงินเข้าแล้ว → ห้ามแก้ แม้จะจ่ายมาแค่บางส่วน
const paidBill = await mkBill('2027-02-H1', 40000);
const paidSub = await api('POST', '/api/payments', {
  token: tokenA, body: { invoiceId: paidBill.body.id, amount: 1000, paidAt: '2026-09-21', slipUrl: slip },
});
await api('POST', `/api/payments/${paidSub.body.id}/approve`, { token: admin, body: {} });
const paidBlocked = await addCharge(paidBill.body.id);
check('ร้านจ่ายมาบางส่วนแล้ว แก้บิลไม่ได้', paidBlocked.status === 409, paidBlocked.body);

// ยอดที่เพิ่งกรอกเข้ามาทีหลังก็ยัดเข้าบิลที่จ่ายไปแล้วไม่ได้ ต้องไปออกบิลรอบถัดไป
const lateEntry = await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2027-02-H1', productId: p2.body.product.id, grossAmount: 5000 },
});
const lateAdd = await api('POST', `/api/invoices/${paidBill.body.id}/lines`, {
  token: admin, body: { entryIds: [lateEntry.body.id] },
});
check('ร้านจ่ายมาบางส่วนแล้ว เพิ่มรายการเข้าบิลก็ไม่ได้', lateAdd.status === 409, lateAdd.body);

// 4. ยกเลิกแล้ว → ห้ามแก้ และต้องไม่ค้างเป็นยอดที่ยังเก็บไม่ได้
const voidBill = await mkBill('2027-02-H2', 40000);
await api('POST', `/api/invoices/${voidBill.body.id}/void`, { token: admin, body: { reason: 'ทดสอบ' } });
check('บิลที่ยกเลิกแล้ว แก้ไม่ได้', (await addCharge(voidBill.body.id)).status === 409);

const voidedBill = await api('GET', `/api/invoices/${voidBill.body.id}`, { token: admin });
check('บิลที่ยกเลิกแล้วยอดค้างต้องเป็น 0',
  voidedBill.body.outstanding === 0 && voidedBill.body.isOverdue === false, voidedBill.body);

/* ── บัญชีรับเงินจากร้านค้า ─────────────────────────────────
 * บิลต้องจำบัญชี ณ ตอนออกไว้ตลอด ไม่ใช่ชี้ไปที่บัญชีหลักปัจจุบัน
 * ไม่งั้นพอเปลี่ยนบัญชีหลัก บิลเก่าที่ร้านถืออยู่จะพาไปโอนผิดที่
 */
/* ── วันที่และเวลาเป็นเวลาไทย ────────────────────────────────
 * เวลาที่ระบบประทับเก็บเป็น UTC (มาตรฐานที่ถูก) แต่ "วันนี้" ต้องเป็นวันไทย
 * เดิมใช้ UTC ทำให้ตั้งแต่เที่ยงคืนถึงเจ็ดโมงเช้าบ้านเรา ระบบยังนับเป็นวันของเมื่อวาน
 */
section('เขตเวลาไทย');

const thaiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
const utcToday = new Date().toISOString().slice(0, 10);

// ทดสอบผ่าน API ที่เอา today() ไปใช้จริง: วันที่โอนต้องไม่เป็นอนาคต
const tzBill = await mkBill('2027-09-H1', 40000);
const todayPay = await api('POST', '/api/payments', {
  token: tokenA,
  body: { invoiceId: tzBill.body.id, amount: 1, paidAt: thaiToday, slipUrl: slip },
});
check('แจ้งชำระลงวันที่ของวันนี้ (เวลาไทย) ได้', todayPay.status === 201, {
  thai: thaiToday, utc: utcToday, status: todayPay.status, err: todayPay.body?.error?.message,
});
if (todayPay.status === 201) await api('POST', `/api/payments/${todayPay.body.id}/cancel`, { token: tokenA });

const tomorrow = new Date(`${thaiToday}T00:00:00Z`);
tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
check('แจ้งชำระลงวันที่พรุ่งนี้ยังไม่ได้เหมือนเดิม', (await api('POST', '/api/payments', {
  token: tokenA,
  body: { invoiceId: tzBill.body.id, amount: 1, paidAt: tomorrow.toISOString().slice(0, 10), slipUrl: slip },
})).status === 400);

section('บัญชีรับเงินจากร้านค้า');

const bank1 = await api('POST', '/api/bank-accounts', {
  token: admin,
  body: { bankName: 'กสิกรไทย', accountName: 'บจก. ทดสอบ', accountNumber: '123-4-56789-0', branch: 'สีลม' },
});
check('สร้างบัญชีแรกแล้วเป็นบัญชีหลักอัตโนมัติ',
  bank1.status === 201 && bank1.body.isDefault === true, bank1.body);
check('เลขบัญชีถูกตัดขีดและเว้นวรรคออก', bank1.body.accountNumber === '1234567890', bank1.body.accountNumber);

const bank2 = await api('POST', '/api/bank-accounts', {
  token: admin, body: { bankName: 'ไทยพาณิชย์', accountName: 'บจก. ทดสอบ', accountNumber: '9876543210' },
});
check('เพิ่มบัญชีที่สองได้ และไม่แย่งเป็นบัญชีหลัก',
  bank2.status === 201 && bank2.body.isDefault === false, bank2.body);

check('เลขบัญชีซ้ำของธนาคารเดียวกันใส่ไม่ได้', (await api('POST', '/api/bank-accounts', {
  token: admin, body: { bankName: 'กสิกรไทย', accountName: 'อีกชื่อ', accountNumber: '1234567890' },
})).status === 409);
check('เลขที่บัญชีต้องเป็นตัวเลข', (await api('POST', '/api/bank-accounts', {
  token: admin, body: { bankName: 'x', accountName: 'y', accountNumber: 'abcdefgh' },
})).status === 400);
check('ร้านค้าสร้างบัญชีรับเงินไม่ได้', (await api('POST', '/api/bank-accounts', {
  token: tokenA, body: { bankName: 'x', accountName: 'y', accountNumber: '1111111111' },
})).status === 403);
check('ร้านค้าเปิดดูบัญชีได้ (ต้องรู้ว่าโอนเข้าไหน)',
  (await api('GET', '/api/bank-accounts', { token: tokenA })).status === 200);

// ออกบิลโดยไม่ระบุบัญชี → ต้องได้บัญชีหลัก
await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2027-03-H1', productId: p1.body.product.id, grossAmount: 40000 },
});
const autoBill = await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2027-03-H1' },
});
check('ไม่เลือกบัญชี = ใช้บัญชีหลักให้อัตโนมัติ',
  autoBill.body.bankAccount?.id === bank1.body.id, autoBill.body.bankAccount);

// ออกบิลโดยเลือกบัญชีเอง
await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2027-03-H2', productId: p1.body.product.id, grossAmount: 40000 },
});
const pickedBill = await api('POST', '/api/invoices/generate', {
  token: admin,
  body: { franchiseId: shopA.body.franchise.id, periodCode: '2027-03-H2', bankAccountId: bank2.body.id },
});
check('เลือกบัญชีเองตอนออกบิลได้',
  pickedBill.body.bankAccount?.accountNumber === '9876543210', pickedBill.body.bankAccount);

// เปลี่ยนบัญชีหลัก แล้วบิลเก่าต้องไม่เปลี่ยนตาม
await api('PATCH', `/api/bank-accounts/${bank2.body.id}`, { token: admin, body: { isDefault: true } });
const afterSwap = await api('GET', `/api/invoices/${autoBill.body.id}`, { token: admin });
check('เปลี่ยนบัญชีหลักแล้ว บิลเก่ายังชี้บัญชีเดิม',
  afterSwap.body.bankAccount?.id === bank1.body.id, afterSwap.body.bankAccount);
check('บัญชีหลักมีได้ทีละใบเดียว',
  (await api('GET', '/api/bank-accounts', { token: admin })).body.items.filter((b) => b.isDefault).length === 1);

// บัญชีที่ผูกกับบิลแล้ว ลบไม่ได้ ต้องปิดใช้งานแทน
check('บัญชีที่ผูกกับบิลแล้ว ลบไม่ได้',
  (await api('DELETE', `/api/bank-accounts/${bank1.body.id}`, { token: admin })).status === 409);
await api('PATCH', `/api/bank-accounts/${bank1.body.id}`, { token: admin, body: { status: 'INACTIVE' } });
check('บัญชีที่ปิดใช้งานแล้ว เอามาออกบิลใหม่ไม่ได้', (await api('POST', '/api/invoices/generate', {
  token: admin,
  body: { franchiseId: shopB.body.franchise.id, periodCode: '2027-03-H1', bankAccountId: bank1.body.id },
})).status === 400);

const bank3 = await api('POST', '/api/bank-accounts', {
  token: admin, body: { bankName: 'กรุงเทพ', accountName: 'ยังไม่ได้ใช้', accountNumber: '5555555555' },
});
check('บัญชีที่ยังไม่เคยผูกกับบิล ลบได้',
  (await api('DELETE', `/api/bank-accounts/${bank3.body.id}`, { token: admin })).status === 200);

/*
 * กันแก้บัญชีรับเงินแบบเงียบ ๆ
 * แก้เลขบัญชีครั้งเดียว บิลค้างจ่ายทุกใบชี้ไปบัญชีใหม่ทันที — จุดที่โกงแล้วเสียหายที่สุด
 */
section('ยืนยันรหัส 6 หลักก่อนเปลี่ยนบัญชีรับเงิน + แจ้งเตือน');

const noCode = await api('POST', '/api/bank-accounts', {
  token: admin, elevate: false, body: { bankName: 'ออมสิน', accountName: 'x', accountNumber: '7777777777' },
});
check('เพิ่มบัญชีโดยไม่ใส่รหัส 6 หลักไม่ได้ และไม่เตะออกจากระบบ (403 ไม่ใช่ 401)',
  noCode.status === 403 && noCode.body.error.code === 'ELEVATION_REQUIRED', noCode.body);
const forgedElev = jwt.sign({ sub: adminId, purpose: 'elevate', tv: 99 }, 'not-the-server-secret-at-all-000000');
check('elevation token ปลอมใช้ไม่ได้', (await api('POST', '/api/bank-accounts', {
  token: admin, elevate: false, headers: { 'x-elevation': forgedElev },
  body: { bankName: 'ออมสิน', accountName: 'x', accountNumber: '7777777777' },
})).status === 403);
check('elevation token ใช้แทน session ไม่ได้',
  (await api('GET', '/api/franchises', { token: await adminElevation() })).status === 401);

check('แก้แค่หมายเหตุไม่ต้องยืนยัน', (await api('PATCH', `/api/bank-accounts/${bank2.body.id}`, {
  token: admin, elevate: false, body: { note: 'บัญชีหลักปัจจุบัน' },
})).status === 200);
check('หน้าเว็บส่งทุกช่องมาแต่ค่าไม่เปลี่ยน = ไม่ต้องยืนยัน', (await api('PATCH', `/api/bank-accounts/${bank2.body.id}`, {
  token: admin, elevate: false,
  body: { bankName: 'ไทยพาณิชย์', accountName: 'บจก. ทดสอบ', accountNumber: '987-654-3210' },
})).status === 200);

const sneaky = await api('PATCH', `/api/bank-accounts/${bank2.body.id}`, {
  token: admin, elevate: false, body: { accountNumber: '1112223334' },
});
check('แก้เลขบัญชีโดยไม่ใส่รหัส 6 หลักไม่ได้', sneaky.status === 403, sneaky.body);
check('...และเลขบัญชีต้องยังเป็นของเดิม',
  (await api('GET', `/api/bank-accounts/${bank2.body.id}`, { token: admin })).body.accountNumber === '9876543210');

const unreadBefore = (await api('GET', '/api/bank-accounts/changes/unread', { token: admin })).body.count;
const legit = await api('PATCH', `/api/bank-accounts/${bank2.body.id}`, { token: admin, body: { accountNumber: '1112223334' } });
check('ใส่รหัส 6 หลักแล้วแก้เลขบัญชีได้', legit.status === 200 && legit.body.accountNumber === '1112223334', legit.body);

const unread = (await api('GET', '/api/bank-accounts/changes/unread', { token: admin })).body;
const change = unread.items[0];
check('แอดมินได้แจ้งเตือนการแก้บัญชี', unread.count === unreadBefore + 1 && change.kind === 'UPDATE', unread);
check('แจ้งเตือนบอกเลขเดิม → เลขใหม่',
  change.changes.some((c) => c.field === 'accountNumber' && c.from === '9876543210' && c.to === '1112223334'), change.changes);
check('แจ้งเตือนบอกจำนวนบิลค้างจ่ายที่โดนผลกระทบ', change.openInvoices >= 1, change.openInvoices);
check('ร้านค้าดูแจ้งเตือนของแอดมินไม่ได้',
  (await api('GET', '/api/bank-accounts/changes/unread', { token: tokenA })).status === 403);

// ── แจ้งออกนอกระบบทาง Telegram — คนที่ได้ session แอดมินไปลบข้อความในกลุ่มไม่ได้ ──
await flushTelegram();
const tgMsg = telegram.messages.at(-1);
check('แก้เลขบัญชีแล้วส่งเข้า Telegram', tgMsg?.chat_id === '-1009876543210' && /9876543210/.test(tgMsg.text) && /1112223334/.test(tgMsg.text), tgMsg);
check('ข้อความบอกว่าใครเป็นคนแก้', /superadmin/.test(tgMsg?.text ?? ''), tgMsg?.text);
check('ข้อความบอกจำนวนบิลค้างจ่ายที่โดนผลกระทบ', /บิลค้างจ่าย \d+ ใบ/.test(tgMsg?.text ?? ''), tgMsg?.text);
check('ใช้ bot token ที่ตั้งไว้', tgMsg?.path === '/bot123456:SMOKE-SECRET-TOKEN/sendMessage', tgMsg?.path);
check('รายการแจ้งเตือนในระบบบอกว่าส่ง Telegram แล้ว',
  (await api('GET', '/api/bank-accounts/changes/unread', { token: admin })).body.items[0].telegram?.status === 'SENT');

// ชื่อบัญชีมาจากคนพิมพ์ — ต้อง escape ไม่งั้นแต่งข้อความ/ลิงก์หลอกในกลุ่มได้
const sent = telegram.messages.length;
const htmlAcc = await api('POST', '/api/bank-accounts', {
  token: admin, body: { bankName: 'ทดสอบ', accountName: '<a href="x">คลิก</a> & co', accountNumber: '8080808080' },
});
await flushTelegram();
const escaped = telegram.messages.at(-1)?.text ?? '';
check('ชื่อบัญชีที่มี HTML ถูก escape ในข้อความ Telegram',
  telegram.messages.length === sent + 1 && escaped.includes('&lt;a href="x"&gt;') && escaped.includes('&amp; co') && !escaped.includes('<a href'), escaped);

// Telegram ล่ม → ต้องไม่หาย ลองใหม่เองจนส่งได้
telegram.failNext = 1;
await api('PATCH', `/api/bank-accounts/${htmlAcc.body.id}`, { token: admin, body: { accountName: 'ชื่อใหม่' } });
await flushTelegram();
const retryRow = db.prepare('SELECT * FROM telegram_outbox ORDER BY id DESC LIMIT 1').get();
check('Telegram ล่ม — ข้อความยังค้างรอส่งใหม่ ไม่หาย', retryRow.status === 'PENDING' && retryRow.attempts === 1 && /Bad Gateway/.test(retryRow.last_error), retryRow);
check('error ที่เก็บไว้ไม่มี bot token', !String(retryRow.last_error).includes('SMOKE-SECRET-TOKEN'));
db.prepare("UPDATE telegram_outbox SET next_attempt_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id = ?").run(retryRow.id);
await flushTelegram();
check('ถึงเวลาลองใหม่แล้วส่งได้', db.prepare('SELECT status FROM telegram_outbox WHERE id = ?').get(retryRow.id).status === 'SENT');

const tgStatus = await api('GET', '/api/settings/telegram', { token: admin });
check('หน้าสถานะบอกว่าตั้งค่าแล้ว โดยไม่โชว์ token และ chat id เต็ม',
  tgStatus.body.configured === true && tgStatus.body.chatHint === '…3210'
    && !JSON.stringify(tgStatus.body).includes('SMOKE-SECRET') && !JSON.stringify(tgStatus.body).includes('9876543210'), tgStatus.body);
const tgTest = await api('POST', '/api/settings/telegram/test', { token: admin });
check('ปุ่มส่งข้อความทดสอบใช้ได้', tgTest.body.ok === true && telegram.messages.some((m) => /ทดสอบการแจ้งเตือน/.test(m.text)), tgTest.body);
check('ร้านค้าดูสถานะ/ส่งทดสอบ Telegram ไม่ได้',
  (await api('POST', '/api/settings/telegram/test', { token: tokenA })).status === 403);
check('ร้านค้าตั้งค่า Telegram ไม่ได้', (await api('PUT', '/api/settings/telegram', {
  token: tokenA, body: { chatId: '-1' },
})).status === 403);

// คนร้ายมักย้าย/ปิดแจ้งเตือนก่อนลงมือ — กลุ่มเดิมต้องรู้ทุกครั้ง
let mark = telegram.messages.length;
await api('PUT', '/api/settings/telegram', { token: admin, body: { chatId: '-100555', chatTitle: 'กลุ่มใหม่' } });
check('ย้ายกลุ่มแจ้งเตือนแล้ว กลุ่มเดิมได้ข้อความแจ้ง',
  telegram.messages.slice(mark).some((m) => m.chat_id === TG_CHAT && /ถูกย้ายออก/.test(m.text)), telegram.messages.slice(mark));
mark = telegram.messages.length;
await api('DELETE', '/api/settings/telegram', { token: admin });
check('ปิดแจ้งเตือนแล้ว กลุ่มได้ข้อความแจ้งก่อนปิด',
  telegram.messages.slice(mark).some((m) => m.chat_id === '-100555' && /ถูกปิด/.test(m.text)), telegram.messages.slice(mark));
check('ปิดแล้วสถานะเป็นยังไม่ได้ตั้งค่า',
  (await api('GET', '/api/settings/telegram', { token: admin })).body.configured === false);
await api('PUT', '/api/settings/telegram', { token: admin, body: { chatId: TG_CHAT, botToken: TG_TOKEN, chatTitle: 'แจ้งเตือนร้าน' } });
await api('DELETE', `/api/bank-accounts/${htmlAcc.body.id}`, { token: admin });

const unreadNow = (await api('GET', '/api/bank-accounts/changes/unread', { token: admin })).body.count;
check('รับทราบแล้วหายจากรายการของตัวเอง', (await api('POST', `/api/bank-accounts/changes/${change.id}/ack`, { token: admin })).status === 200
  && (await api('GET', '/api/bank-accounts/changes/unread', { token: admin })).body.count === unreadNow - 1);
check('รับทราบซ้ำได้ไม่ error', (await api('POST', `/api/bank-accounts/changes/${change.id}/ack`, { token: admin })).status === 200);

let tamper = null;
try { db.prepare('DELETE FROM bank_account_changes').run(); } catch (err) { tamper = err.message; }
check('ลบประวัติการแก้บัญชีไม่ได้ (append-only)', /append-only/.test(tamper ?? ''), tamper);
tamper = null;
try { db.prepare("UPDATE bank_account_changes SET changes = '[]'").run(); } catch (err) { tamper = err.message; }
check('แก้ประวัติการแก้บัญชีไม่ได้ (append-only)', /append-only/.test(tamper ?? ''), tamper);

// คืนเลขเดิม ให้เทสต์ถัดไปเห็นข้อมูลเหมือนเดิม
await api('PATCH', `/api/bank-accounts/${bank2.body.id}`, { token: admin, body: { accountNumber: '9876543210' } });

/*
 * แก้หัวบิล (บัญชีปลายทาง / วันครบกำหนด) ใช้กติกาเดียวกับการแก้ยอด
 * เลือกบัญชีผิดตั้งแต่แรกต้องแก้ได้ ตราบใดที่ร้านยังไม่โอนเงินมา
 */
const moved = await api('PATCH', `/api/invoices/${freshBill.body.id}`, {
  token: admin, body: { bankAccountId: bank2.body.id, dueDate: '2027-01-31' },
});
check('บิลที่ยังไม่มีเงินขยับ เปลี่ยนบัญชีและวันครบกำหนดได้',
  moved.body.bankAccount?.id === bank2.body.id && moved.body.dueDate === '2027-01-31',
  { bank: moved.body.bankAccount?.accountNumber, due: moved.body.dueDate });

check('ร้านจ่ายมาแล้ว เปลี่ยนบัญชีไม่ได้', (await api('PATCH', `/api/invoices/${paidBill.body.id}`, {
  token: admin, body: { bankAccountId: bank2.body.id },
})).status === 409);
check('มีสลิปรอตรวจ เปลี่ยนบัญชีไม่ได้', (await api('PATCH', `/api/invoices/${slipBill.body.id}`, {
  token: admin, body: { bankAccountId: bank2.body.id },
})).status === 409);
check('ร้านค้าแก้บิลของตัวเองไม่ได้', (await api('PATCH', `/api/invoices/${freshBill.body.id}`, {
  token: tokenA, body: { bankAccountId: bank2.body.id },
})).status === 403);
check('เปลี่ยนไปใช้บัญชีที่ปิดใช้งานแล้วไม่ได้', (await api('PATCH', `/api/invoices/${freshBill.body.id}`, {
  token: admin, body: { bankAccountId: bank1.body.id },
})).status === 400);


/* ── อัตราแลกเปลี่ยน USD ต่อรอบบิล ──────────────────────────
 * ยอดในระบบเป็นบาทเสมอ อัตราเป็นแค่ตัวแปลงให้ร้านต่างชาติเทียบ
 * ของสำคัญคือบิลต้องตรึงอัตรา ณ ตอนออกไว้ ไม่ใช่วิ่งตามอัตราล่าสุด
 */
section('อัตราแลกเปลี่ยน USD ต่อรอบบิล');

const rateSet = await api('POST', '/api/periods/2027-04-H1/usd-rate', { token: admin, body: { usdRate: 36.25 } });
check('ตั้งอัตราแลกเปลี่ยนของรอบได้', rateSet.status === 200 && rateSet.body.usdRate === 36.25, rateSet.body);
check('อัตราติดลบหรือศูนย์ไม่ได้',
  (await api('POST', '/api/periods/2027-04-H1/usd-rate', { token: admin, body: { usdRate: 0 } })).status === 400);
check('ร้านค้าตั้งอัตราเองไม่ได้',
  (await api('POST', '/api/periods/2027-04-H1/usd-rate', { token: tokenA, body: { usdRate: 30 } })).status === 403);

await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2027-04-H1', productId: p1.body.product.id, grossAmount: 58000 },
});
const usdBill = await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2027-04-H1' },
});
// 58,000 × 12.5% = 7,250 บาท ÷ 36.25 = 200 ดอลลาร์พอดี
check('บิลตรึงอัตราไว้ และคิดยอดดอลลาร์จากยอดที่ต้องจ่าย',
  usdBill.body.usdRate === 36.25 && usdBill.body.netTotal === 7250 && usdBill.body.netTotalUsd === 200,
  { rate: usdBill.body.usdRate, net: usdBill.body.netTotal, usd: usdBill.body.netTotalUsd });

// เปลี่ยนอัตราของรอบทีหลัง บิลที่ออกไปแล้วต้องไม่ขยับตาม
await api('POST', '/api/periods/2027-04-H1/usd-rate', { token: admin, body: { usdRate: 40 } });
const afterRateChange = await api('GET', `/api/invoices/${usdBill.body.id}`, { token: admin });
check('เปลี่ยนอัตราของรอบแล้ว บิลเก่ายังใช้อัตราเดิม',
  afterRateChange.body.usdRate === 36.25 && afterRateChange.body.netTotalUsd === 200,
  { rate: afterRateChange.body.usdRate, usd: afterRateChange.body.netTotalUsd });

// รอบที่ไม่ได้ตั้งอัตรา = ไม่มียอดดอลลาร์ ไม่ใช่ error
await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2027-04-H2', productId: p1.body.product.id, grossAmount: 40000 },
});
const plainBill = await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2027-04-H2' },
});
check('รอบที่ไม่ได้ตั้งอัตรา บิลไม่มียอดดอลลาร์ (ไม่ใช่ error)',
  plainBill.status === 201 && plainBill.body.usdRate === null && plainBill.body.netTotalUsd === null,
  plainBill.body);

check('ล้างอัตราของรอบได้',
  (await api('POST', '/api/periods/2027-04-H1/usd-rate', { token: admin, body: { usdRate: null } })).body.usdRate === null);

/* ── เลือกสกุลเงินที่ให้ร้านชำระ ────────────────────────────
 * ยอดในฐานข้อมูลเป็นบาทหน่วยเดียวเสมอ (gross/commission/net/paid)
 * currency บอกแค่ว่าร้านเห็นและโอนเป็นสกุลไหน แล้วแปลงด้วยอัตราที่ตรึงไว้
 * ถ้าเก็บคนละสกุลในคอลัมน์เดียวกัน การรวมเงินทุกที่ในระบบจะบวกข้ามสกุลกันมั่ว
 */
section('สกุลเงินที่ให้ร้านชำระ');

await api('POST', '/api/periods/2027-05-H1/usd-rate', { token: admin, body: { usdRate: 36.25 } });
await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2027-05-H1', productId: p1.body.product.id, grossAmount: 58000 },
});
const usdInvoice = await api('POST', '/api/invoices/generate', {
  token: admin,
  body: { franchiseId: shopA.body.franchise.id, periodCode: '2027-05-H1', currency: 'USD' },
});
// 58,000 × 12.5% = 7,250 บาท ÷ 36.25 = 200 ดอลลาร์พอดี
check('ออกบิลสกุลดอลลาร์ได้ และยอดในระบบยังเป็นบาท',
  usdInvoice.body.currency === 'USD' && usdInvoice.body.netTotal === 7250,
  { ccy: usdInvoice.body.currency, netTHB: usdInvoice.body.netTotal });
check('payAmount คือยอดที่ร้านต้องโอนในสกุลของบิล',
  usdInvoice.body.payAmount === 200 && usdInvoice.body.payOutstanding === 200, {
    pay: usdInvoice.body.payAmount, outstanding: usdInvoice.body.payOutstanding,
  });

// รอบที่ไม่มีอัตรา ออกเป็นดอลลาร์ไม่ได้ เพราะแปลงไม่ออก
await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2027-05-H2', productId: p1.body.product.id, grossAmount: 40000 },
});
const noRateUsd = await api('POST', '/api/invoices/generate', {
  token: admin,
  body: { franchiseId: shopA.body.franchise.id, periodCode: '2027-05-H2', currency: 'USD' },
});
check('รอบที่ยังไม่ได้ตั้งอัตรา ออกบิลเป็นดอลลาร์ไม่ได้', noRateUsd.status === 400, noRateUsd.body);

const thbInvoice = await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2027-05-H2' },
});
check('ไม่ระบุสกุล = บาทเหมือนเดิม',
  thbInvoice.body.currency === 'THB' && thbInvoice.body.payAmount === thbInvoice.body.netTotal,
  { ccy: thbInvoice.body.currency, pay: thbInvoice.body.payAmount });

check('สกุลอื่นที่ระบบไม่รองรับถูกปฏิเสธ', (await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopB.body.franchise.id, periodCode: '2027-05-H1', currency: 'EUR' },
})).status === 400);

/*
 * ร้านจ่ายบิลดอลลาร์ — หน้าจอแปลงเป็นบาทก่อนส่ง ระบบจึงรับเป็นบาทตามเดิม
 * ตรงนี้ทดสอบว่ายอดบาทที่ส่งไปตัดยอดได้ถูกต้อง และยอดดอลลาร์ที่เหลือคำนวณตรง
 */
const usdPay = await api('POST', '/api/payments', {
  token: tokenA,
  body: { invoiceId: usdInvoice.body.id, amount: 3625, paidAt: '2026-09-21', slipUrl: slip },
});
await api('POST', `/api/payments/${usdPay.body.id}/approve`, { token: admin, body: {} });
const afterUsdPay = await api('GET', `/api/invoices/${usdInvoice.body.id}`, { token: admin });
check('จ่ายบิลดอลลาร์แล้วยอดคงเหลือคิดเป็นดอลลาร์ถูกต้อง (3,625 ฿ = $100)',
  afterUsdPay.body.outstanding === 3625 && afterUsdPay.body.payOutstanding === 100, {
    thb: afterUsdPay.body.outstanding, usd: afterUsdPay.body.payOutstanding,
  });

// เปลี่ยนอัตราของรอบทีหลัง บิลดอลลาร์ที่ออกไปแล้วต้องไม่ขยับ
await api('POST', '/api/periods/2027-05-H1/usd-rate', { token: admin, body: { usdRate: 50 } });
const frozen = await api('GET', `/api/invoices/${usdInvoice.body.id}`, { token: admin });
check('บิลดอลลาร์ตรึงอัตราไว้ เปลี่ยนอัตราของรอบแล้วยอดไม่ขยับ',
  frozen.body.usdRate === 36.25 && frozen.body.payOutstanding === 100, {
    rate: frozen.body.usdRate, usd: frozen.body.payOutstanding,
  });

/* ── บัญชีปลายทางต้องรับสกุลเดียวกับบิล ──────────────────────
 * เลขบัญชีเงินบาทกับบัญชีเงินตราต่างประเทศเป็นคนละใบ
 * ถ้าปล่อยให้บิลดอลลาร์ชี้บัญชีบาท ร้านต่างชาติโอนแล้วเงินไม่เข้า
 */
section('สกุลเงินของบัญชีปลายทาง');

check('บัญชีที่ไม่ระบุสกุล = บัญชีเงินบาท', bank2.body.currency === 'THB', bank2.body.currency);

const usdAcc = await api('POST', '/api/bank-accounts', {
  token: admin,
  body: { bankName: 'กรุงไทย', accountName: 'บจก. ทดสอบ (FCD)', accountNumber: '4440001112', currency: 'USD' },
});
check('เพิ่มบัญชีที่รับดอลลาร์ได้', usdAcc.status === 201 && usdAcc.body.currency === 'USD', usdAcc.body);
check('สกุลที่ระบบไม่รองรับใส่ไม่ได้', (await api('POST', '/api/bank-accounts', {
  token: admin, body: { bankName: 'x', accountName: 'y', accountNumber: '6660001112', currency: 'EUR' },
})).status === 400);

await api('POST', '/api/periods/2027-06-H1/usd-rate', { token: admin, body: { usdRate: 36.25 } });
await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2027-06-H1', productId: p1.body.product.id, grossAmount: 58000 },
});
check('บิลดอลลาร์ผูกบัญชีเงินบาทไม่ได้', (await api('POST', '/api/invoices/generate', {
  token: admin,
  body: {
    franchiseId: shopA.body.franchise.id, periodCode: '2027-06-H1',
    currency: 'USD', bankAccountId: bank2.body.id,
  },
})).status === 400);

const matched = await api('POST', '/api/invoices/generate', {
  token: admin,
  body: {
    franchiseId: shopA.body.franchise.id, periodCode: '2027-06-H1',
    currency: 'USD', bankAccountId: usdAcc.body.id,
  },
});
check('บิลดอลลาร์ผูกบัญชีดอลลาร์ได้',
  matched.status === 201 && matched.body.bankAccount?.currency === 'USD'
  && matched.body.bankAccount?.currencyMatches === true,
  matched.body.bankAccount);

// ไม่ได้เลือกบัญชีมา ต้องหยิบบัญชีที่รับสกุลนั้น ไม่ใช่บัญชีหลักที่เป็นคนละสกุล
await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2027-06-H2', productId: p1.body.product.id, grossAmount: 58000 },
});
await api('POST', '/api/periods/2027-06-H2/usd-rate', { token: admin, body: { usdRate: 36.25 } });
const autoUsd = await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2027-06-H2', currency: 'USD' },
});
check('ไม่เลือกบัญชี = หยิบบัญชีที่รับสกุลเดียวกับบิล ไม่ใช่บัญชีหลักคนละสกุล',
  autoUsd.body.bankAccount?.id === usdAcc.body.id, autoUsd.body.bankAccount);

/* แก้บิลทีหลัง: เปลี่ยนสกุลต้องเปลี่ยนบัญชีพร้อมกัน ไม่งั้นบิลจะชี้บัญชีผิดสกุล */
await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2027-07-H1', productId: p1.body.product.id, grossAmount: 58000 },
});
await api('POST', '/api/periods/2027-07-H1/usd-rate', { token: admin, body: { usdRate: 36.25 } });
const editable = await api('POST', '/api/invoices/generate', {
  token: admin,
  body: { franchiseId: shopA.body.franchise.id, periodCode: '2027-07-H1', bankAccountId: bank2.body.id },
});
check('เปลี่ยนเป็นดอลลาร์ทั้งที่ยังผูกบัญชีบาทอยู่ ไม่ได้', (await api('PATCH', `/api/invoices/${editable.body.id}`, {
  token: admin, body: { currency: 'USD' },
})).status === 400);

const switched = await api('PATCH', `/api/invoices/${editable.body.id}`, {
  token: admin, body: { currency: 'USD', bankAccountId: usdAcc.body.id },
});
check('เปลี่ยนสกุลพร้อมบัญชีในครั้งเดียวได้ และยอดบาทไม่ขยับ',
  switched.body.currency === 'USD' && switched.body.netTotal === 7250
  && switched.body.payAmount === 200 && switched.body.bankAccount?.id === usdAcc.body.id,
  { ccy: switched.body.currency, thb: switched.body.netTotal, pay: switched.body.payAmount });

check('เปลี่ยนกลับเป็นบาทพร้อมบัญชีบาทได้', (await api('PATCH', `/api/invoices/${editable.body.id}`, {
  token: admin, body: { currency: 'THB', bankAccountId: bank2.body.id },
})).body.currency === 'THB');

// รอบที่ไม่มีอัตรา เปลี่ยนเป็นดอลลาร์ไม่ได้ เหมือนตอนออกบิล
await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2027-07-H2', productId: p1.body.product.id, grossAmount: 40000 },
});
const noRateBill = await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2027-07-H2' },
});
check('รอบที่ไม่มีอัตรา เปลี่ยนบิลเป็นดอลลาร์ไม่ได้', (await api('PATCH', `/api/invoices/${noRateBill.body.id}`, {
  token: admin, body: { currency: 'USD', bankAccountId: usdAcc.body.id },
})).status === 400);

// สกุลของบัญชีที่ผูกบิลไปแล้วเปลี่ยนไม่ได้ — บิลเก่าจะกลายเป็นชี้บัญชีผิดสกุลย้อนหลัง
check('บัญชีที่ผูกบิลแล้ว เปลี่ยนสกุลไม่ได้', (await api('PATCH', `/api/bank-accounts/${usdAcc.body.id}`, {
  token: admin, body: { currency: 'THB' },
})).status === 409);

const freeAcc = await api('POST', '/api/bank-accounts', {
  token: admin, body: { bankName: 'ออมสิน', accountName: 'ยังไม่ได้ใช้', accountNumber: '3330001112' },
});

/* ── QR สำหรับสแกนโอน ────────────────────────────────────────
 * รับเฉพาะไฟล์ที่อัปโหลดผ่านระบบ กติกาเดียวกับสลิป
 * ถ้ารับลิงก์ภายนอก วันหนึ่งลิงก์ตาย ร้านก็สแกนจ่ายไม่ได้ทั้งระบบ
 */
section('QR ของบัญชีรับเงิน');

const qrImage = await uploadSlip();
const qrAcc = await api('POST', '/api/bank-accounts', {
  token: admin,
  body: {
    bankName: 'ยูโอบี', accountName: 'บจก. ทดสอบ', accountNumber: '2220003334', qrUrl: qrImage,
  },
});
check('เพิ่มบัญชีพร้อม QR ได้', qrAcc.status === 201 && fileOf(qrAcc.body.qrUrl) === qrImage, qrAcc.body.qrUrl);

check('QR ที่เป็นลิงก์ภายนอกใส่ไม่ได้', (await api('POST', '/api/bank-accounts', {
  token: admin,
  body: {
    bankName: 'x', accountName: 'y', accountNumber: '9990003334',
    qrUrl: 'https://example.com/qr.png',
  },
})).status === 400);

check('บัญชีที่ไม่ใส่ QR ก็สร้างได้ (ไม่บังคับ)', bank2.body.qrUrl === null, bank2.body.qrUrl);

const qrImage2 = await uploadSlip();
check('เปลี่ยน QR ทีหลังได้', (await api('PATCH', `/api/bank-accounts/${qrAcc.body.id}`, {
  token: admin, body: { qrUrl: qrImage2 },
})).body.qrUrl?.split('?')[0] === qrImage2);

check('ถอด QR ออกได้', (await api('PATCH', `/api/bank-accounts/${qrAcc.body.id}`, {
  token: admin, body: { qrUrl: null },
})).body.qrUrl === null);

// ร้านต้องเห็น QR ของบัญชีที่บิลผูกไว้ ไม่งั้นแนบไปก็ไม่มีใครได้ใช้
await api('PATCH', `/api/bank-accounts/${qrAcc.body.id}`, { token: admin, body: { qrUrl: qrImage } });
await api('POST', '/api/sales-entries', {
  token: admin, body: { periodCode: '2027-08-H1', productId: p1.body.product.id, grossAmount: 40000 },
});
const qrBill = await api('POST', '/api/invoices/generate', {
  token: admin,
  body: { franchiseId: shopA.body.franchise.id, periodCode: '2027-08-H1', bankAccountId: qrAcc.body.id },
});
const qrBillAsShop = await api('GET', `/api/invoices/${qrBill.body.id}`, { token: tokenA });
check('ร้านเห็น QR ของบัญชีที่ต้องโอนเข้า',
  fileOf(qrBillAsShop.body.bankAccount?.qrUrl) === qrImage, qrBillAsShop.body.bankAccount?.qrUrl);

check('ร้านค้าแก้ QR ของบัญชีไม่ได้', (await api('PATCH', `/api/bank-accounts/${qrAcc.body.id}`, {
  token: tokenA, body: { qrUrl: qrImage2 },
})).status === 403);

check('บัญชีที่ยังไม่ผูกบิล เปลี่ยนสกุลได้', (await api('PATCH', `/api/bank-accounts/${freeAcc.body.id}`, {
  token: admin, body: { currency: 'USD' },
})).body.currency === 'USD');

/* ── แนบไฟล์สลิป ─────────────────────────────────────────────
 * ตรวจชนิดไฟล์จาก magic bytes ไม่ใช่จาก content-type หรือชื่อไฟล์ที่ไคลเอนต์ส่งมา
 * เพราะสองอย่างนั้นปลอมได้ง่าย
 */
section('แนบไฟล์สลิป');

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154'
  + '789c6300010000050001',
  'hex',
);

const uploadFile = async (bytes, type) => {
  const res = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: { 'content-type': type, authorization: `Bearer ${admin}` },
    body: bytes,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const uploaded = await uploadFile(PNG_BYTES, 'image/png');
check('อัปโหลดรูป PNG ได้ และได้ชื่อไฟล์สุ่มกลับมา',
  uploaded.status === 201 && /^\/api\/uploads\/[0-9a-f]{32}\.png$/.test(uploaded.body.url), uploaded.body);

const fetched = await fetch(`${base}${uploaded.body.viewUrl}`);
check('เปิดดูไฟล์ด้วยลิงก์ที่ระบบเซ็นให้ได้ และ content-type ตรงกับชนิดจริง',
  fetched.status === 200 && fetched.headers.get('content-type')?.includes('image/png'),
  { status: fetched.status, type: fetched.headers.get('content-type') });
check('ลิงก์ไฟล์ที่ไม่มีลายเซ็น เปิดไม่ได้ (ใครได้ลิงก์ไปก็เปิดไม่ได้ตลอดไปอีกแล้ว)',
  (await fetch(`${base}${uploaded.body.url}`)).status === 404);
const tampered = uploaded.body.viewUrl.replace(/sig=[^&]+/, 'sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
check('ลายเซ็นปลอมเปิดไม่ได้', (await fetch(`${base}${tampered}`)).status === 404);
const expired = uploaded.body.viewUrl.replace(/exp=\d+/, `exp=${Math.floor(Date.now() / 1000) - 60}`);
check('ลิงก์หมดอายุเปิดไม่ได้', (await fetch(`${base}${expired}`)).status === 404);

// ไฟล์ที่อ้างว่าเป็นรูปแต่ข้างในไม่ใช่ ต้องไม่ถูกเขียนลงดิสก์
const fake = await uploadFile(Buffer.from('<?php system($_GET["c"]); ?>'), 'image/png');
check('ไฟล์ที่ไม่ใช่รูปจริงถูกปฏิเสธ แม้จะอ้าง content-type เป็นรูป', fake.status === 400, fake.body);
check('ไฟล์ว่างถูกปฏิเสธ', (await uploadFile(Buffer.alloc(0), 'image/png')).status === 400);

const noAuth = await fetch(`${base}/api/uploads`, {
  method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG_BYTES,
});
check('ไม่ล็อกอิน อัปโหลดไม่ได้', noAuth.status === 401);

for (const evil of ['../../../etc/passwd', 'abc.png', 'x'.repeat(32) + '.png']) {
  const r = await fetch(`${base}/api/uploads/${encodeURIComponent(evil)}`);
  check(`ขอไฟล์ด้วยชื่อ "${evil.slice(0, 20)}…" ไม่หลุด (404)`, r.status === 404, r.status);
}

// แจ้งชำระด้วยไฟล์ที่อัปโหลด — path สั้น ๆ ต้องผ่าน schema
const withFile = await api('POST', '/api/payments', {
  token: tokenA,
  body: {
    invoiceId: thbInvoice.body.id,
    amount: 100,
    paidAt: '2026-09-21',
    slipUrl: uploaded.body.url,
  },
});
check('แจ้งชำระโดยแนบไฟล์ที่อัปโหลดได้', withFile.status === 201 && fileOf(withFile.body.slipUrl) === uploaded.body.url, withFile.body);
// ลิงก์ภายนอกพังได้ทุกเมื่อ หลักฐานการโอนต้องอยู่กับเราเท่านั้น
check('ลิงก์ภายนอกถูกปฏิเสธ (รับเฉพาะไฟล์ที่อัปโหลด)', (await api('POST', '/api/payments', {
  token: tokenA,
  body: { invoiceId: thbInvoice.body.id, amount: 100, paidAt: '2026-09-21', slipUrl: 'https://example.com/a.jpg' },
})).status === 400);
check('ลิงก์สลิปมั่ว ๆ ถูกปฏิเสธ', (await api('POST', '/api/payments', {
  token: tokenA,
  body: { invoiceId: thbInvoice.body.id, amount: 100, paidAt: '2026-09-21', slipUrl: '/etc/passwd' },
})).status === 400);
check('ไม่แนบสลิปเลย แจ้งชำระไม่ได้', (await api('POST', '/api/payments', {
  token: tokenA,
  body: { invoiceId: thbInvoice.body.id, amount: 100, paidAt: '2026-09-21' },
})).status === 400);

/* ── สิทธิ์รายข้อของผู้ช่วยร้านค้า ──────────────────────────
 * ซ่อนปุ่มบนหน้าจออย่างเดียวไม่พอ คนที่รู้ว่ามี endpoint อะไรก็ยิงตรงได้
 * ทุกข้อจึงต้องกันที่เซิร์ฟเวอร์ และทดสอบที่ระดับ API
 */
section('สิทธิ์รายข้อของผู้ช่วยร้านค้า');

const ownerToken = tokenA;
const fid = shopA.body.franchise.id;

const viewOnly = await api('POST', `/api/franchises/${fid}/users`, {
  token: ownerToken,
  body: { username: 'a-view', password: 'viewonly1234', displayName: 'ดูอย่างเดียว', permissions: ['bills'] },
});
check('เจ้าของร้านสร้างผู้ช่วยพร้อมกำหนดสิทธิ์ได้',
  viewOnly.status === 201 && JSON.stringify(viewOnly.body.permissions) === '["bills"]', viewOnly.body);

const viewToken = (await api('POST', '/api/auth/login', {
  body: { username: 'a-view', password: 'viewonly1234' },
})).body.token;

check('มีสิทธิ์ bills → ดูใบเรียกเก็บได้',
  (await api('GET', '/api/invoices', { token: viewToken })).status === 200);
check('ไม่มีสิทธิ์ reports → ดูรายงานไม่ได้',
  (await api('GET', '/api/reports/dashboard?periodCode=2026-08-H1', { token: viewToken })).status === 403);
check('ไม่มีสิทธิ์ products → ดูสินค้าไม่ได้',
  (await api('GET', '/api/products', { token: viewToken })).status === 403);

const blockedPay = await api('POST', '/api/payments', {
  token: viewToken,
  body: { invoiceId: thbInvoice.body.id, amount: 100, paidAt: '2026-09-21', slipUrl: slip },
});
check('ไม่มีสิทธิ์ pay → แจ้งชำระเงินไม่ได้ (กันที่เซิร์ฟเวอร์)', blockedPay.status === 403, blockedPay.body);

// เจ้าของเปิดสิทธิ์เพิ่มแล้วต้องทำได้ทันที
const staffId = viewOnly.body.id;
const granted = await api('PATCH', `/api/franchises/${fid}/users/${staffId}/permissions`, {
  token: ownerToken, body: { permissions: ['bills', 'pay'] },
});
check('เจ้าของร้านเปิดสิทธิ์เพิ่มได้',
  JSON.stringify(granted.body.permissions) === '["bills","pay"]', granted.body);

const token2 = (await api('POST', '/api/auth/login', {
  body: { username: 'a-view', password: 'viewonly1234' },
})).body.token;
check('เปิดสิทธิ์ pay แล้วแจ้งชำระได้', (await api('POST', '/api/payments', {
  token: token2,
  body: { invoiceId: thbInvoice.body.id, amount: 50, paidAt: '2026-09-21', slipUrl: slip },
})).status === 201);

check('ผู้ช่วยตั้งสิทธิ์ให้ตัวเองไม่ได้', (await api('PATCH', `/api/franchises/${fid}/users/${staffId}/permissions`, {
  token: token2, body: { permissions: ['bills', 'pay', 'reports', 'products'] },
})).status === 403);

const ownerId = (await api('GET', `/api/franchises/${fid}/users`, { token: ownerToken }))
  .body.items.find((u) => u.isOwner).id;
check('ตั้งสิทธิ์จำกัดให้เจ้าของร้านไม่ได้', (await api('PATCH', `/api/franchises/${fid}/users/${ownerId}/permissions`, {
  token: ownerToken, body: { permissions: ['bills'] },
})).status === 403);

check('เจ้าของร้านไม่ถูกจำกัดสิทธิ์ (permissions = null)',
  (await api('GET', '/api/auth/me', { token: ownerToken })).body.user.permissions === null);

// ผู้ช่วยที่สร้างไว้ก่อนมีระบบสิทธิ์ ต้องทำได้เหมือนเดิม ไม่ใช่โดนล็อกทั้งหมด
const legacy = await api('POST', `/api/franchises/${fid}/users`, {
  token: ownerToken, body: { username: 'a-legacy', password: 'legacy12345' },
});
check('ไม่ระบุสิทธิ์ตอนสร้าง = ได้ชุดตั้งต้น (ดูได้ แต่ยังจ่ายเงินไม่ได้)',
  JSON.stringify(legacy.body.permissions) === '["bills","reports","products"]', legacy.body.permissions);

section('งานเร็ว: เหตุผลยกเลิกบิล · ตัวเลขข้างเมนู · สิทธิ์ · แจ้งสลิปใหม่');
const liveInv = db.prepare("SELECT id FROM invoices WHERE status IN ('OPEN', 'PARTIAL') LIMIT 1").get();
check('ยกเลิกบิลโดยไม่ใส่เหตุผลไม่ได้',
  (await api('POST', `/api/invoices/${liveInv.id}/void`, { token: admin, body: {} })).status === 400);
check('ยกเลิกบิลด้วยเหตุผลสั้นเกินไม่ได้',
  (await api('POST', `/api/invoices/${liveInv.id}/void`, { token: admin, body: { reason: ' x ' } })).status === 400);

const navAdmin = (await api('GET', '/api/payments/nav-counts', { token: admin })).body;
check('ตัวเลขข้างเมนูของส่วนกลาง = สลิปรอตรวจ',
  navAdmin.invoices.count === db.prepare("SELECT COUNT(*) AS n FROM payment_submissions WHERE status = 'PENDING'").get().n, navAdmin);
const navShop = (await api('GET', '/api/payments/nav-counts', { token: tokenA })).body;
check('ตัวเลขข้างเมนูของร้าน = บิลที่ยังต้องจ่ายของร้านตัวเอง',
  navShop.invoices.count === db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE franchise_id = ? AND status IN ('OPEN', 'PARTIAL')").get(shopA.body.franchise.id).n, navShop);

const payOnly = await api('POST', `/api/franchises/${shopA.body.franchise.id}/users`, {
  token: tokenA, body: { username: 'pay-only', password: 'payonly12345', permissions: ['pay'] },
});
check('ให้สิทธิ์จ่ายเงิน = ได้สิทธิ์ดูบิลด้วย (ไม่งั้นเข้าหน้าจ่ายไม่ได้)',
  payOnly.status === 201 && payOnly.body.permissions.includes('bills'), payOnly.body);

check('ร้านแจ้งชำระแล้ว ส่วนกลางได้ข้อความใน Telegram',
  telegram.messages.some((m) => /สลิปใหม่รอตรวจ/.test(m.text) && /shopa|shopb/.test(m.text)));

section('ออกบิลหลายร้านพร้อมกัน + บันทึกยอดทั้งหมด');
{
  const BULK_PERIOD = '2031-02-H1';
  const live = db.prepare('SELECT product_id, franchise_id FROM product_assignments WHERE end_date IS NULL ORDER BY id').all();
  const aProd = live.find((r) => r.franchise_id === shopA.body.franchise.id);
  const bProd = live.find((r) => r.franchise_id === shopB.body.franchise.id);
  check('มีสินค้าที่มอบหมายให้ทั้งสองร้าน (ตั้งฉากเทสต์)', Boolean(aProd && bProd), live);

  const before = (await api('GET', `/api/invoices/readiness?periodCode=${BULK_PERIOD}`, { token: admin })).body;
  check('ร้านที่มีสินค้าแต่ยังไม่กรอกยอด ขึ้นเป็น "ยังไม่กรอกยอด"',
    before.items.some((r) => r.franchiseId === shopA.body.franchise.id && r.status === 'NO_SALES'), before);

  const bulkSave = await api('POST', '/api/sales-entries/bulk', {
    token: admin,
    body: { items: [
      { periodCode: BULK_PERIOD, productId: aProd.product_id, grossAmount: 30000 },
      { periodCode: BULK_PERIOD, productId: bProd.product_id, grossAmount: 20000 },
    ] },
  });
  check('บันทึกยอดทั้งหมดในครั้งเดียวได้', bulkSave.status === 201 && bulkSave.body.saved.length === 2, bulkSave.body);

  const ready = (await api('GET', `/api/invoices/readiness?periodCode=${BULK_PERIOD}`, { token: admin })).body;
  check('กรอกแล้วทั้งสองร้าน = พร้อมออกบิล 2 ร้าน', ready.summary.ready >= 2, ready.summary);
  check('ร้านค้าดูภาพรวมการออกบิลไม่ได้',
    (await api('GET', `/api/invoices/readiness?periodCode=${BULK_PERIOD}`, { token: tokenA })).status === 403);

  const ids = [shopA.body.franchise.id, shopB.body.franchise.id];
  const issued = await api('POST', '/api/invoices/generate-bulk', {
    token: admin, body: { periodCode: BULK_PERIOD, franchiseIds: [...ids, ids[0]] },
  });
  check('ออกบิลหลายร้านพร้อมกันได้ (ส่งร้านซ้ำมาก็ออกใบเดียว)',
    issued.status === 201 && issued.body.created.length === 2, issued.body);

  const after = (await api('GET', `/api/invoices/readiness?periodCode=${BULK_PERIOD}`, { token: admin })).body;
  check('ออกแล้วสถานะเปลี่ยนเป็น "ออกบิลแล้ว" พร้อมเลขบิล',
    ids.every((id) => after.items.find((r) => r.franchiseId === id)?.status === 'INVOICED'
      && after.items.find((r) => r.franchiseId === id)?.invoiceNo), after.items);

  const again = await api('POST', '/api/invoices/generate-bulk', { token: admin, body: { periodCode: BULK_PERIOD, franchiseIds: ids } });
  check('ออกซ้ำไม่ได้ — บอกเป็นรายร้าน ไม่ล้มทั้งชุด',
    again.status === 207 && again.body.created.length === 0 && again.body.errors.length === 2, again.body);

  // คืนสภาพ ให้เทสต์ถัดไปไม่เห็นบิลของรอบนี้
  for (const c of issued.body.created) {
    await api('POST', `/api/invoices/${c.invoiceId}/void`, { token: admin, body: { reason: 'คืนค่าเทสต์ออกบิลหลายร้าน' } });
  }
}

section('ตั้งค่าแจ้งเตือน: เลือกรายเรื่อง · สรุปรายวัน · ช่วงห้ามรบกวน');
{
  await flushTelegram();
  check('ส่วนกลางเข้าระบบ → แจ้ง Telegram พร้อม IP (ค่าตั้งต้น: แจ้งทันที)',
    telegram.messages.some((m) => /ส่วนกลางเข้าสู่ระบบ/.test(m.text) && /IP:/.test(m.text)));
  check('ร้านค้าเข้าระบบ → ไม่แจ้ง (ค่าตั้งต้น: ปิด — เยอะเกิน)', !telegram.messages.some((m) => /ผู้ใช้เข้าสู่ระบบ/.test(m.text)));

  const cfg = await api('GET', '/api/settings/notifications', { token: admin });
  check('หน้าตั้งค่าบอกทุกเรื่องพร้อมโหมดปัจจุบัน',
    cfg.status === 200 && cfg.body.events.find((e) => e.key === 'payment.submitted')?.mode === 'instant', cfg.body);
  check('เรื่องความปลอดภัยล็อก "แจ้งทันทีเสมอ"',
    cfg.body.events.filter((e) => e.group === 'security').every((e) => e.locked && e.mode === 'instant'));
  check('ร้านค้าเปิดหน้าตั้งค่าไม่ได้', (await api('GET', '/api/settings/notifications', { token: tokenA })).status === 403);
  check('แก้ตั้งค่าแจ้งเตือนโดยไม่ใส่รหัส 6 หลักไม่ได้', (await api('PUT', '/api/settings/notifications', {
    token: admin, elevate: false, body: { events: { 'payment.submitted': 'off' } },
  })).status === 403);
  check('ปิดเรื่องความปลอดภัยไม่ได้', (await api('PUT', '/api/settings/notifications', {
    token: admin, body: { events: { 'bank_account.change': 'off' } },
  })).status === 400);

  let mark = telegram.messages.length;
  const saved = await api('PUT', '/api/settings/notifications', {
    token: admin, body: { events: { 'payment.submitted': 'digest', 'login.admin': 'off' }, digestTime: '00:00' },
  });
  await flushTelegram();
  check('บันทึกได้ และกลุ่มได้ข้อความว่าใครแก้อะไร',
    saved.status === 200 && telegram.messages.slice(mark).some((m) => /ตั้งค่าแจ้งเตือนถูกเปลี่ยน/.test(m.text) && /สรุปรายวัน/.test(m.text)),
    telegram.messages.slice(mark));

  mark = telegram.messages.length;
  await notify('payment.submitted', '💳 ทดสอบ', { line: 'ร้านทดสอบ 1,234.00 บาท' });
  await notify('login.admin', '🛡 ทดสอบเข้าระบบ');
  await flushTelegram();
  check('เรื่องที่ตั้ง "สรุปรายวัน" ไม่ส่งทันที', telegram.messages.length === mark);
  check('เรื่องที่ตั้ง "ไม่แจ้ง" ไม่เข้าแม้แต่สรุป',
    db.prepare("SELECT COUNT(*) AS n FROM notification_digest WHERE event_key = 'login.admin'").get().n === 0);

  db.prepare("DELETE FROM app_settings WHERE name = 'notify.lastDigest'").run();
  check('ถึงเวลาสรุป → ส่งสรุปรายวันหนึ่งข้อความ', (await runDigestIfDue()) === true);
  await flushTelegram();
  const digest = telegram.messages.slice(mark).find((m) => /สรุปประจำวัน/.test(m.text));
  check('สรุปมีเรื่องที่รอไว้ + สลิปรอตรวจ + บิลเลยกำหนด',
    Boolean(digest) && /ร้านทดสอบ 1,234\.00 บาท/.test(digest.text) && /สลิปรอตรวจ|บิลเลยกำหนด/.test(digest.text), digest);
  check('วันเดียวกันไม่ส่งสรุปซ้ำ', (await runDigestIfDue()) === false);

  // ช่วงห้ามรบกวนทั้งวัน: เรื่องทั่วไปเลื่อนไปส่งทีหลัง แต่เรื่องความปลอดภัยยังส่งทันที
  await api('PUT', '/api/settings/notifications', {
    token: admin, body: { events: { 'invoice.voided': 'instant' }, quietHours: { enabled: true, from: '00:00', to: '23:59' } },
  });
  await flushTelegram();
  mark = telegram.messages.length;
  await notify('invoice.voided', '🗑 ทดสอบช่วงห้ามรบกวน');
  await notify('security.2fa_reset', '🔓 ทดสอบความปลอดภัยช่วงห้ามรบกวน');
  await flushTelegram();
  const held = db.prepare("SELECT status, next_attempt_at > UTC_TIMESTAMP() AS later FROM telegram_outbox WHERE text = '🗑 ทดสอบช่วงห้ามรบกวน'").get();
  check('ช่วงห้ามรบกวน: เรื่องทั่วไปถูกเลื่อน ยังไม่ส่ง', held?.status === 'PENDING' && held.later === 1, held);
  check('ช่วงห้ามรบกวน: เรื่องความปลอดภัยยังส่งทันที',
    telegram.messages.slice(mark).some((m) => /ทดสอบความปลอดภัยช่วงห้ามรบกวน/.test(m.text)));

  // คืนค่าตั้งต้นให้เทสต์ถัดไป
  await api('PUT', '/api/settings/notifications', {
    token: admin,
    body: { events: { 'payment.submitted': 'instant', 'login.admin': 'instant' }, quietHours: { enabled: false, from: '22:00', to: '07:00' }, digestTime: '08:00' },
  });
  db.prepare("UPDATE telegram_outbox SET status = 'FAILED' WHERE text = '🗑 ทดสอบช่วงห้ามรบกวน'").run();
}

section('ยืนยันตัวตนสองชั้นของร้านค้า (เลือกเปิดเอง)');
await api('POST', '/api/franchises', { token: admin, body: { username: 'mfashop', password: 'mfashop-pass-1' } });
let mtok = (await api('POST', '/api/auth/login', { body: { username: 'mfashop', password: 'mfashop-pass-1' } })).body.token;
const mstatus = await api('GET', '/api/auth/2fa', { token: mtok });
check('ร้านไม่ถูกบังคับ 2FA — ใช้งานได้เลย',
  mstatus.body.enabled === false && mstatus.body.required === false
    && (await api('GET', '/api/invoices', { token: mtok })).status === 200, mstatus.body);

const msetup = await api('POST', '/api/auth/2fa/setup', { token: mtok });
const pending = db.prepare("SELECT totp_pending_secret FROM users WHERE username = 'mfashop'").get().totp_pending_secret;
check('secret ในฐานข้อมูลถูกเข้ารหัส (ไฟล์ .db หลุดไปก็สร้างรหัสไม่ได้)',
  pending.startsWith('v1:') && !pending.includes(msetup.body.secret.replace(/\s/g, '')));
const menabled = await api('POST', '/api/auth/2fa/enable', { token: mtok, body: { code: await codeFor(msetup.body.secret) } });
check('ร้านเปิด 2FA เองได้', menabled.status === 200 && menabled.body.backupCodes.length === 10, menabled.body);
check('เปิดแล้ว token เก่าทุกเครื่องหลุด', (await api('GET', '/api/auth/me', { token: mtok })).status === 401);
mtok = menabled.body.token;
const mstatus2 = (await api('GET', '/api/auth/2fa', { token: mtok })).body;
check('สถานะบอกว่าเปิดแล้ว เหลือรหัสสำรอง 10 ชุด', mstatus2.enabled === true && mstatus2.backupCodesLeft === 10, mstatus2);

const mlogin = await api('POST', '/api/auth/login', { body: { username: 'mfashop', password: 'mfashop-pass-1' } });
check('ล็อกอินต้องใส่รหัส 6 หลักต่อ', mlogin.body.mfaRequired === true && !mlogin.body.token, mlogin.body);
check('รหัสผิดเข้าไม่ได้', (await api('POST', '/api/auth/login/mfa', {
  body: { mfaToken: mlogin.body.mfaToken, code: '12345' },
})).status === 403);
const goodCode = await codeFor(msetup.body.secret);
const mok = await api('POST', '/api/auth/login/mfa', { body: { mfaToken: mlogin.body.mfaToken, code: goodCode } });
check('รหัสถูกเข้าได้', mok.status === 200 && Boolean(mok.body.token), mok.body);
const mlogin2 = await api('POST', '/api/auth/login', { body: { username: 'mfashop', password: 'mfashop-pass-1' } });
const replay = await api('POST', '/api/auth/login/mfa', { body: { mfaToken: mlogin2.body.mfaToken, code: goodCode } });
check('รหัสเดิมใช้ซ้ำไม่ได้ (กันคนแอบเห็นแล้วรีบใช้ตาม)',
  replay.status === 403 && /เพิ่งถูกใช้/.test(replay.body.error.message), replay.body);
const forgedMfa = jwt.sign({ sub: adminId, purpose: 'mfa', tv: 0 }, 'not-the-server-secret-at-all-000000');
check('ปลอม token ขั้นที่สองไม่ได้', (await api('POST', '/api/auth/login/mfa', {
  body: { mfaToken: forgedMfa, code: '000000' },
})).status === 401);

const mfaUser = menabled.body.user;
check('ร้านปลด 2FA ให้คนอื่นไม่ได้',
  (await api('POST', `/api/auth/users/${adminId}/reset-2fa`, { token: mok.body.token })).status === 403);
check('ปลด 2FA ร้านต้องใส่รหัส 6 หลักของแอดมินก่อน', (await api('POST', `/api/auth/users/${mfaUser.id}/reset-2fa`, {
  token: admin,
})).body?.error?.code === 'ELEVATION_REQUIRED');
check('ส่วนกลางปลด 2FA ของตัวเองไม่ได้ (ไม่งั้นคนที่ได้ session ไปจะผูกมือถือตัวเองแทน)',
  (await api('POST', `/api/auth/users/${adminId}/reset-2fa`, {
    token: admin, headers: { 'x-elevation': await adminElevation() },
  })).status === 403);
const reset = await api('POST', `/api/auth/users/${mfaUser.id}/reset-2fa`, {
  token: admin, headers: { 'x-elevation': await adminElevation() },
});
check('ร้านทำมือถือหาย ส่วนกลางปลดให้ได้', reset.status === 200, reset.body);
const afterReset = await api('POST', '/api/auth/login', { body: { username: 'mfashop', password: 'mfashop-pass-1' } });
check('ปลดแล้วร้านล็อกอินด้วยรหัสผ่านได้', Boolean(afterReset.body.token) && !afterReset.body.mfaRequired, afterReset.body);
check('ปลดแล้ว session เก่าของร้านหลุด', (await api('GET', '/api/auth/me', { token: mok.body.token })).status === 401);
await flushTelegram();
check('ปลด 2FA → แจ้ง Telegram', telegram.messages.some((m) => /ปลด Google Authenticator ของผู้ใช้/.test(m.text)));

section('หน้าแรกของร้าน: เช็กลิสต์ · ประกาศ · Telegram ของร้าน · เตือนก่อนครบกำหนด · ขอบคุณ');
{
  const shop = await api('POST', '/api/franchises', { token: admin, body: { username: 'engshop', password: 'engshop-pass-1' } });
  const fid = shop.body.franchise.id;
  const stok = (await api('POST', '/api/auth/login', { body: { username: 'engshop', password: 'engshop-pass-1' } })).body.token;

  // ── เช็กลิสต์เริ่มต้นใช้งาน ──
  const ob = await api('GET', '/api/auth/onboarding', { token: stok });
  check('ร้านใหม่มีเช็กลิสต์ ยังไม่ได้ทำสักข้อ',
    ob.status === 200 && ob.body.total >= 3 && ob.body.done === 0 && ob.body.steps.some((x) => x.key === 'telegram'), ob.body);
  check('ส่วนกลางไม่มีเช็กลิสต์ของร้าน', (await api('GET', '/api/auth/onboarding', { token: admin })).body === null);
  const viewed = await api('POST', '/api/auth/onboarding', { token: stok, body: { viewedBill: true } });
  check('เปิดดูบิลแล้วข้อแรกติ๊กเอง', viewed.body.steps.find((x) => x.key === 'viewBill')?.done === true, viewed.body);
  const hid = await api('POST', '/api/auth/onboarding', { token: stok, body: { dismissed: true } });
  const back = await api('POST', '/api/auth/onboarding', { token: stok, body: { dismissed: false } });
  check('ซ่อนเช็กลิสต์แล้วเปิดกลับได้', hid.body.dismissed === true && back.body.dismissed === false);
  check('ส่งค่าแปลก ๆ ไม่รับ', (await api('POST', '/api/auth/onboarding', { token: stok, body: { dismissed: 'yes' } })).status === 400);

  // ── กระดานประกาศ ──
  check('ร้านสร้างประกาศไม่ได้', (await api('POST', '/api/announcements', { token: stok, body: { title: 'x', body: 'y' } })).status === 403);
  const a1 = await api('POST', '/api/announcements', {
    token: admin, body: { title: 'โปรเดือนตุลา', body: 'ลด 10% ทุกชิ้น', category: 'PROMO', pinned: true },
  });
  const later = await api('POST', '/api/announcements', { token: admin, body: { title: 'หยุดปีใหม่', body: 'ปิด 3 วัน', category: 'HOLIDAY', startsAt: '2099-12-25' } });
  const expired = await api('POST', '/api/announcements', { token: admin, body: { title: 'ประกาศเก่า', body: 'หมดแล้ว', startsAt: '2020-01-01', endsAt: '2020-01-31' } });
  check('ส่วนกลางสร้างประกาศได้', a1.status === 201 && a1.body.state === 'ACTIVE' && a1.body.pinned === true, a1.body);
  const seen = await api('GET', '/api/announcements', { token: stok });
  const seenIds = seen.body.items.map((a) => a.id);
  check('ร้านเห็นเฉพาะประกาศที่อยู่ในช่วงเผยแพร่',
    seenIds.includes(a1.body.id) && !seenIds.includes(later.body.id) && !seenIds.includes(expired.body.id), seen.body);
  check('ประกาศใหม่นับเป็นยังไม่อ่าน', seen.body.unread >= 1 && seen.body.items.find((a) => a.id === a1.body.id).read === false);
  await api('POST', `/api/announcements/${a1.body.id}/read`, { token: stok });
  const seen2 = await api('GET', '/api/announcements', { token: stok });
  check('เปิดอ่านแล้วไม่นับเป็นใหม่ (แยกตามผู้ใช้)',
    seen2.body.items.find((a) => a.id === a1.body.id).read === true && seen2.body.unread === seen.body.unread - 1);
  check('ร้านอื่นยังเห็นว่าเป็นประกาศใหม่',
    (await api('GET', '/api/announcements', { token: tokenB })).body.items.find((a) => a.id === a1.body.id)?.read === false);
  const every = await api('GET', '/api/announcements', { token: admin });
  check('ส่วนกลางเห็นทุกประกาศพร้อมสถานะ (แสดง/ตั้งเวลา/หมดอายุ)',
    ['ACTIVE', 'SCHEDULED', 'EXPIRED'].every((st) => every.body.items.some((a) => a.state === st)));
  check('หัวข้อยาวเกินไม่รับ', (await api('POST', '/api/announcements', { token: admin, body: { title: 'ก'.repeat(121), body: 'x' } })).status === 400);
  check('หมวดที่ไม่มีจริงไม่รับ', (await api('POST', '/api/announcements', { token: admin, body: { title: 'x', body: 'y', category: 'HACK' } })).status === 400);
  const edited = await api('PATCH', `/api/announcements/${a1.body.id}`, { token: admin, body: { title: 'โปรเดือนตุลา (ขยายเวลา)' } });
  check('แก้ประกาศได้', edited.status === 200 && edited.body.title.includes('ขยายเวลา'), edited.body);
  check('ร้านแก้/ลบประกาศไม่ได้',
    (await api('PATCH', `/api/announcements/${a1.body.id}`, { token: stok, body: { title: 'x' } })).status === 403
      && (await api('DELETE', `/api/announcements/${a1.body.id}`, { token: stok })).status === 403);
  for (const x of [later, expired]) await api('DELETE', `/api/announcements/${x.body.id}`, { token: admin });
  check('ลบประกาศได้', !(await api('GET', '/api/announcements', { token: admin })).body.items.some((a) => a.id === expired.body.id));

  // ── ร้านเชื่อม Telegram ของตัวเอง ──
  const tg0 = await api('GET', '/api/auth/telegram', { token: stok });
  check('ส่วนกลางตั้งบอทแล้ว ร้านเชื่อมเองได้', tg0.body.available === true && tg0.body.linked === false, tg0.body);
  const link = await api('POST', '/api/auth/telegram/link', { token: stok });
  const code = new URL(link.body.url).searchParams.get('start');
  check('ได้ลิงก์ t.me ของบอทพร้อมรหัสครั้งเดียว',
    /^https:\/\/t\.me\/franchise_alert_bot\?start=/.test(link.body.url) && code?.length >= 8, link.body);
  const SHOP_CHAT = '777000111';
  let mark = telegram.messages.length;
  telegram.updates = [{ update_id: 5001, message: { chat: { id: Number(SHOP_CHAT), type: 'private' }, text: `/start ${code}` } }];
  await pollTelegram();
  telegram.updates = [];
  check('กด Start ในแอปแล้วผูกกับบัญชีร้าน', (await api('GET', '/api/auth/telegram', { token: stok })).body.linked === true);
  await flushTelegram();
  check('บอทตอบยืนยันในแชตส่วนตัวของร้าน (ไม่ใช่กลุ่มส่วนกลาง)',
    telegram.messages.slice(mark).some((m) => String(m.chat_id) === SHOP_CHAT && /เชื่อมต่อแล้ว/.test(m.text)), telegram.messages.slice(mark));
  telegram.updates = [{ update_id: 5002, message: { chat: { id: 999, type: 'private' }, text: `/start ${code}` } }];
  await pollTelegram();
  telegram.updates = [];
  check('รหัสเดิมใช้ซ้ำไม่ได้ (คนอื่นเอาลิงก์ไปกดต่อ ก็ไม่ได้รับข้อความของร้าน)',
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE telegram_chat_id = '999'").get().n === 0);

  // ── ออกบิล → แจ้งร้าน · ใกล้ครบกำหนด → เตือนสุภาพครั้งเดียว ──
  const prod = await api('POST', '/api/products', {
    token: admin, body: { sku: 'ENG-1', name: 'สินค้าเทสต์หน้าร้าน', commissionPct: 10, franchiseId: fid, startDate: '2026-01-01' },
  });
  await api('POST', '/api/sales-entries', { token: admin, body: { periodCode: '2026-08-H1', productId: prod.body.product.id, grossAmount: 50000 } });
  mark = telegram.messages.length;
  const bill = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: fid, periodCode: '2026-08-H1' } });
  await flushTelegram();
  check('ออกบิล → ร้านได้ข้อความในแชตของตัวเอง',
    bill.status === 201 && telegram.messages.slice(mark).some((m) => String(m.chat_id) === SHOP_CHAT && /บิลรอบใหม่/.test(m.text)),
    telegram.messages.slice(mark));

  const thaiToday = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(thaiToday) + 86400000).toISOString().slice(0, 10);
  db.prepare('UPDATE invoices SET due_date = ?, reminded_at = NULL WHERE id = ?').run(tomorrow, bill.body.id);
  check('ก่อน 09:00 ยังไม่เตือน (ไม่ปลุกร้านตอนเช้ามืด)', (await runDueReminders(new Date(`${thaiToday}T08:00:00Z`))) === 0);
  mark = telegram.messages.length;
  await runDueReminders(new Date(`${thaiToday}T10:00:00Z`));
  await flushTelegram();
  const remind = telegram.messages.slice(mark).find((m) => String(m.chat_id) === SHOP_CHAT);
  check('ใกล้ครบกำหนด → เตือนร้านแบบสุภาพ บอกยอดและวัน',
    Boolean(remind) && /แจ้งเตือนล่วงหน้า/.test(remind.text) && /อีก 1 วัน/.test(remind.text) && /ขอบคุณ/.test(remind.text), remind);
  mark = telegram.messages.length;
  await runDueReminders(new Date(`${thaiToday}T11:00:00Z`));
  await flushTelegram();
  check('เตือนครั้งเดียวต่อบิล ไม่ซ้ำทุกนาที', !telegram.messages.slice(mark).some((m) => String(m.chat_id) === SHOP_CHAT));

  // ── สลิปต้องแก้ → แจ้งร้าน · ได้รับเงิน → ขอบคุณ + หน้าแรกขึ้นข้อความขอบคุณ ──
  const owed = (await api('GET', `/api/invoices/${bill.body.id}`, { token: stok })).body.outstanding;
  const shopSlip = await uploadSlip(stok);
  const bad = await api('POST', '/api/payments', { token: stok, body: { invoiceId: bill.body.id, amount: owed, slipUrl: shopSlip } });
  mark = telegram.messages.length;
  await api('POST', `/api/payments/${bad.body.id}/reject`, { token: admin, body: { reason: 'ยอดในสลิปไม่ตรง' } });
  await flushTelegram();
  check('สลิปถูกตีกลับ → ร้านรู้ทันทีพร้อมเหตุผล',
    telegram.messages.slice(mark).some((m) => String(m.chat_id) === SHOP_CHAT && /ยอดในสลิปไม่ตรง/.test(m.text)));
  const good = await api('POST', '/api/payments', { token: stok, body: { invoiceId: bill.body.id, amount: owed, slipUrl: shopSlip } });
  mark = telegram.messages.length;
  await api('POST', `/api/payments/${good.body.id}/approve`, { token: admin });
  await flushTelegram();
  const thanks = telegram.messages.slice(mark).find((m) => String(m.chat_id) === SHOP_CHAT);
  check('ได้รับเงิน → ขอบคุณร้านด้วยคำว่า "ทางเราได้รับ" (ไม่ใช้คำว่าส่วนกลาง)',
    Boolean(thanks) && /ขอบคุณ/.test(thanks.text) && /ทางเราได้รับ/.test(thanks.text) && !/ส่วนกลาง/.test(thanks.text), thanks);

  const standing = await api('GET', '/api/reports/standing?periodCode=2026-08-H1', { token: stok });
  check('หน้าแรกของร้านรู้ว่าเพิ่งจ่ายครบ (ขึ้นการ์ดขอบคุณ)',
    standing.status === 200 && standing.body.recentlyPaid?.invoiceId === bill.body.id && standing.body.recentlyPaid.amount === owed, standing.body);
  check('อันดับบอกแค่ตำแหน่ง ไม่มีชื่อ/ยอดของร้านอื่น',
    standing.body.rank?.position >= 1 && standing.body.rank.of >= standing.body.rank.position
      && Object.keys(standing.body.rank).sort().join() === 'of,position', standing.body.rank);
  check('ร้านขอข้อมูลอันดับของร้านอื่นไม่ได้',
    (await api('GET', `/api/reports/standing?periodCode=2026-08-H1&franchiseId=${shopB.body.franchise.id}`, { token: stok })).status === 403);
  check('ส่วนกลางดูของร้านไหนก็ได้เมื่อระบุร้าน',
    (await api('GET', `/api/reports/standing?periodCode=2026-08-H1&franchiseId=${fid}`, { token: admin })).body.recentlyPaid?.invoiceId === bill.body.id);
  const receipt = await api('GET', `/api/invoices/${bill.body.id}`, { token: stok });
  check('ใบรับเงินมีรายการเงินเข้าครบ', receipt.body.status === 'PAID' && receipt.body.payments.length === 1 && receipt.body.paid === owed, receipt.body.payments);

  // ── ร้านเลือกเองว่าอยากได้เรื่องไหน ──
  const opts = await api('GET', '/api/auth/telegram', { token: stok });
  check('ร้านเห็นรายการเรื่องที่เลือกรับได้ ค่าตั้งต้นเปิดทุกเรื่อง',
    opts.body.events.length === 6 && opts.body.events.every((e) => e.enabled), opts.body.events);
  check('ส่วนกลางไม่มีตัวเลือกของร้าน (ตั้งที่หน้าตั้งค่าแจ้งเตือน)',
    (await api('GET', '/api/auth/telegram', { token: admin })).body.events.length === 0
      && (await api('PUT', '/api/auth/telegram/prefs', { token: admin, body: { events: { 'bill.issued': false } } })).status === 403);
  check('เรื่องที่ไม่มีจริงไม่รับ',
    (await api('PUT', '/api/auth/telegram/prefs', { token: stok, body: { events: { hack: false } } })).status === 400);
  const offed = await api('PUT', '/api/auth/telegram/prefs', { token: stok, body: { events: { 'bill.issued': false, announcement: false } } });
  check('ปิดบางเรื่องได้ เรื่องอื่นยังเปิด',
    offed.status === 200 && offed.body.events.find((e) => e.key === 'bill.issued').enabled === false
      && offed.body.events.find((e) => e.key === 'payment.received').enabled === true, offed.body);

  await api('POST', '/api/sales-entries', { token: admin, body: { periodCode: '2026-08-H2', productId: prod.body.product.id, grossAmount: 20000 } });
  mark = telegram.messages.length;
  const bill2 = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: fid, periodCode: '2026-08-H2' } });
  const ann = await api('POST', '/api/announcements', { token: admin, body: { title: 'ทดสอบประกาศปิดไว้', body: 'ไม่ควรเข้าแชต' } });
  await flushTelegram();
  check('ปิด "บิลใหม่" และ "ประกาศ" ไว้ → ไม่ได้ข้อความสองเรื่องนี้',
    bill2.status === 201 && ann.status === 201 && !telegram.messages.slice(mark).some((m) => String(m.chat_id) === SHOP_CHAT), telegram.messages.slice(mark));

  await api('PUT', '/api/auth/telegram/prefs', { token: stok, body: { events: { announcement: true } } });
  mark = telegram.messages.length;
  const ann2 = await api('POST', '/api/announcements', { token: admin, body: { title: 'เมนูใหม่เข้าแล้ว', body: 'ขายได้ตั้งแต่วันนี้', category: 'PRODUCT' } });
  const annLater = await api('POST', '/api/announcements', { token: admin, body: { title: 'ประกาศล่วงหน้า', body: 'ยังไม่ถึงวัน', startsAt: '2099-01-01' } });
  await flushTelegram();
  const pushed = telegram.messages.slice(mark).filter((m) => String(m.chat_id) === SHOP_CHAT);
  check('เปิด "ประกาศ" → ประกาศใหม่เข้าแชตร้านทันที (ประกาศตั้งเวลายังไม่ส่ง)',
    pushed.length === 1 && /เมนูใหม่เข้าแล้ว/.test(pushed[0].text) && /ประกาศจากทางเรา/.test(pushed[0].text), pushed);
  mark = telegram.messages.length;
  await api('PATCH', `/api/announcements/${ann2.body.id}`, { token: admin, body: { title: 'เมนูใหม่เข้าแล้ว (แก้คำ)' } });
  await runAnnouncementPushes();
  await flushTelegram();
  check('แก้ประกาศแล้วไม่ส่งซ้ำ', !telegram.messages.slice(mark).some((m) => String(m.chat_id) === SHOP_CHAT));
  for (const x of [ann, ann2, annLater]) await api('DELETE', `/api/announcements/${x.body.id}`, { token: admin });

  // ── ทักหลังเลยกำหนด 3 วัน / 7 วัน ──
  const daysAgo = (n) => new Date(Date.parse(thaiToday) - n * 86400000).toISOString().slice(0, 10);
  const at10 = new Date(`${thaiToday}T10:00:00Z`);
  const shopMsgs = (from) => telegram.messages.slice(from).filter((m) => String(m.chat_id) === SHOP_CHAT);
  db.prepare('UPDATE invoices SET due_date = ?, overdue_nudges = 0 WHERE id = ?').run(daysAgo(2), bill2.body.id);
  mark = telegram.messages.length;
  await runOverdueNudges(at10);
  await flushTelegram();
  check('เลยกำหนดแค่ 2 วัน ยังไม่ทัก', shopMsgs(mark).length === 0);
  db.prepare('UPDATE invoices SET due_date = ? WHERE id = ?').run(daysAgo(3), bill2.body.id);
  check('ก่อน 09:00 ไม่ทัก', (await runOverdueNudges(new Date(`${thaiToday}T07:00:00Z`))) === 0);
  await runOverdueNudges(at10);
  await flushTelegram();
  const nudge1 = shopMsgs(mark);
  check('เลยกำหนด 3 วัน → ทักแบบสุภาพหนึ่งข้อความ',
    nudge1.length === 1 && /แจ้งเพื่อทราบ/.test(nudge1[0].text) && /ผ่านมา 3 วัน/.test(nudge1[0].text) && !/ส่วนกลาง/.test(nudge1[0].text), nudge1);
  mark = telegram.messages.length;
  await runOverdueNudges(new Date(`${thaiToday}T15:00:00Z`));
  await flushTelegram();
  check('วันเดียวกันไม่ทักซ้ำ', shopMsgs(mark).length === 0);
  db.prepare('UPDATE invoices SET due_date = ? WHERE id = ?').run(daysAgo(8), bill2.body.id);
  await runOverdueNudges(at10);
  await flushTelegram();
  const nudge2 = shopMsgs(mark);
  check('เลยกำหนด 7 วันขึ้นไป → ทักครั้งที่สอง เสนอช่วยหาทางออก',
    nudge2.length === 1 && /ยังค้างอยู่/.test(nudge2[0].text) && /ยินดีช่วย/.test(nudge2[0].text), nudge2);
  mark = telegram.messages.length;
  await runOverdueNudges(at10);
  await flushTelegram();
  check('ทักครบสองครั้งแล้วหยุด ไม่ทวงทุกวัน', shopMsgs(mark).length === 0);

  // เลื่อนวันครบกำหนดแล้ว นับใหม่ · มีสลิปรออยู่ไม่ทัก · ร้านปิดเรื่องนี้ได้
  const moved = await api('PATCH', `/api/invoices/${bill2.body.id}`, { token: admin, body: { dueDate: daysAgo(4) } });
  check('เลื่อนวันครบกำหนด → นับการทักใหม่ตามวันใหม่',
    moved.status === 200 && db.prepare('SELECT overdue_nudges FROM invoices WHERE id = ?').get(bill2.body.id).overdue_nudges === 0, moved.body);
  const owed2 = (await api('GET', `/api/invoices/${bill2.body.id}`, { token: stok })).body.outstanding;
  const waiting = await api('POST', '/api/payments', { token: stok, body: { invoiceId: bill2.body.id, amount: owed2, slipUrl: shopSlip } });
  await runOverdueNudges(at10);
  await flushTelegram();
  check('ร้านแนบสลิปแล้ว รอเราตรวจ → ไม่ทัก', waiting.status === 201 && shopMsgs(mark).length === 0, waiting.body);
  await api('POST', `/api/payments/${waiting.body.id}/cancel`, { token: stok }).catch(() => null);
  db.prepare("UPDATE payment_submissions SET status = 'CANCELLED' WHERE id = ?").run(waiting.body.id);
  await api('PUT', '/api/auth/telegram/prefs', { token: stok, body: { events: { 'bill.overdue': false } } });
  mark = telegram.messages.length;
  await runOverdueNudges(at10);
  await flushTelegram();
  check('ร้านปิด "ทักเมื่อเลยกำหนด" → ไม่ได้รับ', shopMsgs(mark).length === 0);
  await api('PUT', '/api/auth/telegram/prefs', { token: stok, body: { events: { 'bill.overdue': true } } });

  // ── เลิกเชื่อม ──
  const unlinked = await api('DELETE', '/api/auth/telegram', { token: stok });
  mark = telegram.messages.length;
  await notifyShopForTest(fid);
  await flushTelegram();
  check('เลิกเชื่อมแล้วไม่ได้รับข้อความอีก', unlinked.body.linked === false && !telegram.messages.slice(mark).some((m) => String(m.chat_id) === SHOP_CHAT));
}

section('ดูแลระบบ: ตรวจสถานะ · แจ้งเมื่อฟื้น/ขัดข้อง/ดิสก์ใกล้เต็ม · ใครอ่านประกาศแล้ว');
{
  const health = await fetch(`${base}/health`);
  const hb = await health.json();
  check('/health ตอบ 200 เมื่อฐานข้อมูลปกติ ไม่บอกรายละเอียดภายใน',
    health.status === 200 && hb.ok === true && !('version' in hb) && health.headers.get('cache-control') === 'no-store', hb);
  check('/health ไม่ต้องล็อกอิน (ตัวตรวจภายนอกเรียกได้)', health.status === 200);
  // รุ่น PHP พึ่ง cron — cron หยุดแล้วเว็บยังตอบได้ แต่ไม่มีสำรองข้อมูล/เตือนร้าน ต้องให้ตัวตรวจภายนอกรู้
  const beat = (secondsAgo) => db.prepare(`INSERT INTO app_settings (name, value, updated_at) VALUES ('system.heartbeat', ?, UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE value = VALUES(value)`).run(String(Math.floor(Date.now() / 1000) - secondsAgo));
  beat(11 * 60);
  const stale = await fetch(`${base}/health`);
  const staleBody = await stale.json();
  beat(30);
  const alive = await fetch(`${base}/health`);
  db.prepare("DELETE FROM app_settings WHERE name = 'system.heartbeat'").run();
  const neverRan = await fetch(`${base}/health`);
  check('งานตั้งเวลา (cron) เงียบเกิน 10 นาที → /health ตอบ 503 · กลับมาเดิน → 200 · ยังไม่เคยเดิน (เพิ่งติดตั้ง) → 200',
    stale.status === 503 && staleBody.ok === false && staleBody.failing === 'schedule' && alive.status === 200 && neverRan.status === 200,
    { stale: stale.status, staleBody, alive: alive.status, neverRan: neverRan.status });
  check('หน้าเว็บยอมให้แสดงรูปที่ผู้ใช้เลือกจากเครื่อง (ย่อสลิปก่อนอัปโหลด) แต่ไม่เปิดรูปจากเว็บอื่น',
    /img-src 'self' data: blob:(;|$)/.test(health.headers.get('content-security-policy') ?? ''), health.headers.get('content-security-policy'));

  const cfg = await api('GET', '/api/settings/notifications', { token: admin });
  check('หน้าตั้งค่ามีกลุ่ม "ระบบ / เซิร์ฟเวอร์" ค่าตั้งต้นแจ้งทันที',
    Boolean(cfg.body.groups.system) && ['system.started', 'system.error', 'system.disk']
      .every((k) => cfg.body.events.find((e) => e.key === k)?.mode === 'instant'), cfg.body.groups);

  let mark = telegram.messages.length;
  await notifyStarted();
  await flushTelegram();
  check('เปิดระบบใหม่ → แจ้งกลุ่ม', telegram.messages.slice(mark).some((m) => /ระบบเริ่มทำงานแล้ว/.test(m.text)));

  // รุ่นของระบบ + เวลาอัปเดต — app:install ตอนตั้งฉากจดไว้แล้ว
  const version = (token) => api('GET', '/api/system/version', { token });
  const ver = await version(admin);
  const shopVer = await version(tokenA);
  check('ส่วนกลางเห็นรุ่น + เวลาอัปเดตที่ app:install จดไว้ · ร้านเห็นแค่รุ่นกับวันที่ · ไม่ล็อกอินดูไม่ได้',
    ver.status === 200 && /^\d+\.\d+\.\d+$/.test(ver.body.version) && Boolean(ver.body.updatedAt) && ver.body.installPending === false
      && shopVer.status === 200 && shopVer.body.version === ver.body.version && shopVer.body.updatedAt === ver.body.updatedAt
      && !('commit' in shopVer.body) && !('installPending' in shopVer.body)
      && (await version()).status === 401, { admin: ver.body, shop: shopVer.body });

  // จำลองเครื่องที่รันรุ่นเก่าอยู่ แล้ว git pull โค้ดใหม่มา
  const oldRelease = { version: '1.9.0', commit: null, at: '2026-01-01 00:00:00', previous: null };
  db.prepare("UPDATE app_settings SET value = ? WHERE name = 'system.release'").run(JSON.stringify(oldRelease));
  const pulled = await version(admin);
  check('pull โค้ดใหม่แล้วยังไม่ได้รัน app:install → เตือน และยังไม่นับว่าอัปเดต (บอกว่ารุ่นที่ติดตั้งไว้คือรุ่นไหน)',
    pulled.body.installPending === true && pulled.body.updatedAt === oldRelease.at && pulled.body.installed?.version === '1.9.0'
      && pulled.body.version === ver.body.version, pulled.body);

  mark = telegram.messages.length;
  const install = await spark(['app:install'], stack.env);
  await flushTelegram();
  const updated = await version(admin);
  const upMsgs = telegram.messages.slice(mark).filter((m) => /ระบบเริ่มทำงานแล้ว/.test(m.text));
  check('รัน app:install → จดเวลาอัปเดตใหม่ + รุ่นก่อนหน้า · กลุ่มได้ข้อความว่าอัปเดตจากรุ่นไหนเป็นรุ่นไหน',
    install.status === 0 && updated.body.installPending === false && updated.body.updatedAt !== oldRelease.at
      && updated.body.previous?.version === '1.9.0'
      && upMsgs.length === 1 && upMsgs[0].text.includes(`อัปเดตเป็นรุ่น <b>${ver.body.version}`) && /เดิม 1\.9\.0\)/.test(upMsgs[0].text)
      && !/เพิ่งล่ม/.test(upMsgs[0].text), { status: install.status, out: install.stdout.slice(-400), updated: updated.body, upMsgs });

  const rerun = await spark(['app:install'], stack.env);
  await flushTelegram();
  check('รัน app:install ซ้ำ (รุ่นเดิม) ไม่นับเป็นการอัปเดต — เวลาเดิมคงไว้',
    rerun.status === 0 && /รุ่นเดิม/.test(rerun.stdout) && (await version(admin)).body.updatedAt === updated.body.updatedAt, rerun.stdout.slice(-400));

  mark = telegram.messages.length;
  const first = await notifySystemError(new Error('SQLITE_BUSY: database is locked'), { method: 'POST', originalUrl: '/api/payments?x=secret' });
  const second = await notifySystemError(new Error('อีกครั้ง'));
  await flushTelegram();
  const errMsgs = telegram.messages.slice(mark).filter((m) => /ระบบขัดข้อง/.test(m.text));
  check('ขัดข้อง → แจ้งกลุ่มพร้อมเส้นทาง (ไม่มี query string ที่อาจมีข้อมูลลับ)',
    first === true && errMsgs.length === 1 && /POST \/api\/payments/.test(errMsgs[0].text) && !/secret/.test(errMsgs[0].text), errMsgs);
  check('พังรัว ๆ ไม่ถล่มกลุ่ม (15 นาทีแจ้งครั้งเดียว)', second === false);

  const fakeFull = () => ({ bavail: 1 * 1024 ** 2, bsize: 1024, blocks: 50 * 1024 ** 2 }); // เหลือ 1 GB จาก 50 GB
  const fakeOk = () => ({ bavail: 30 * 1024 ** 2, bsize: 1024, blocks: 50 * 1024 ** 2 });
  db.prepare("DELETE FROM app_settings WHERE name = 'notify.diskWarned'").run();
  mark = telegram.messages.length;
  check('ดิสก์ยังว่างเยอะ → ไม่แจ้ง', (await checkDiskSpace('.', fakeOk)).low === false);
  const warned = await checkDiskSpace('.', fakeFull);
  const again = await checkDiskSpace('.', fakeFull);
  await flushTelegram();
  const diskMsgs = telegram.messages.slice(mark).filter((m) => /พื้นที่บนเซิร์ฟเวอร์ใกล้เต็ม/.test(m.text));
  check('ดิสก์ใกล้เต็ม → แจ้งพร้อมตัวเลข วันละครั้ง',
    warned.warned === true && again.warned === false && diskMsgs.length === 1 && /เหลือ 1\.0 GB จาก 50\.0 GB/.test(diskMsgs[0].text), diskMsgs);

  // คู่มือแยกตามบทบาท — ร้านต้องไม่เห็นคู่มือของส่วนกลาง
  const manualOf = async (token, role) => (await api('GET', `/api/manual${role ? `?role=${role}` : ''}`, { token })).body;
  const shopManual = await manualOf(tokenA);
  check('ร้านได้คู่มือร้าน', shopManual.section === 'shop' && /คู่มือสำหรับร้านค้า/.test(shopManual.html), shopManual.section);
  const sneaky = await manualOf(tokenA, 'admin');
  check('ร้านขอคู่มือส่วนกลางไม่ได้ (ได้คู่มือร้านกลับไป)',
    sneaky.section === 'shop' && !/คู่มือสำหรับส่วนกลาง|id="admin-|ยอดขายรายรอบ/.test(sneaky.html), sneaky.section);
  check('ส่วนกลางได้คู่มือส่วนกลาง และขอดูคู่มือร้านได้ (ใช้ตอนดูมุมมองร้าน)',
    (await manualOf(admin)).section === 'admin' && (await manualOf(admin, 'shop')).section === 'shop');
  const all = await Promise.all([[admin, 'admin'], [admin, 'shop'], [admin, 'sales']].map(([t, r]) => manualOf(t, r)));
  check('คู่มือทุกบทบาท: สอนทั้งคอมและมือถือ ไม่มีตัวแปร {nav:} {i:} หลุดออกไป',
    all.every((m) => m.html.includes('only-desktop') && m.html.includes('only-mobile') && !/\{(nav|i):/.test(m.html) && m.nav?.desktop?.length && m.nav?.mobile?.length),
    all.map((m) => m.section));
  check('ส่งบทบาทแปลก ๆ มาไม่ได้อ่านไฟล์อื่น', (await manualOf(admin, '../config')).section === 'admin');
  check('ไม่ล็อกอินอ่านคู่มือไม่ได้', (await api('GET', '/api/manual')).status === 401);
  const direct = await Promise.all(['/manual.html', '/manual/admin.html', '/src/manual/admin.html', '/api/manual/admin.html']
    .map(async (u) => (await (await fetch(`${base}${u}`)).text()).includes('คู่มือสำหรับส่วนกลาง')));
  check('ไฟล์คู่มือเปิดตรง ๆ จาก URL ไม่ได้ (ต้องผ่านการล็อกอิน)', direct.every((leaked) => !leaked), direct);

  // สำรองข้อมูล — เซิร์ฟเวอร์ของเทสต์ตั้งโฟลเดอร์สำรองไว้ในโฟลเดอร์ชั่วคราว ไม่ปนกับของจริง
  const backupDir = stack.env.PAYNEST_BACKUP_DIR;
  check('ร้านดู/สั่งสำรองข้อมูลไม่ได้',
    (await api('GET', '/api/settings/backup', { token: tokenA })).status === 403
      && (await api('POST', '/api/settings/backup', { token: tokenA })).status === 403);
  const bk = await api('POST', '/api/settings/backup', { token: admin });
  const snap = path.join(backupDir, 'db', bk.body.last?.file ?? 'x');
  /*
   * ไฟล์สำรองต้อง "กู้คืนได้จริง" ไม่ใช่แค่มีไฟล์ — ลองโหลดเข้าฐานข้อมูลชั่วคราวแล้วนับบิลเทียบของจริง
   * (ไม่มีโปรแกรม mysql บนเครื่อง = นับแถวของบิลในไฟล์ SQL แทน)
   */
  const dump = fs.existsSync(snap) ? zlib.gunzipSync(fs.readFileSync(snap)).toString('utf8') : '';
  const liveInvoices = db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;
  let restoredInvoices = null;
  const cli = process.env.E2E_MYSQL_CLI;
  if (cli && dump) {
    const scratch = 'paynest_e2e_restore';
    const args = ['-h', DB.host, '-P', String(DB.port), '-u', DB.user, ...(DB.pass ? [`-p${DB.pass}`] : [])];
    spawnSync(cli, [...args, '-e', `DROP DATABASE IF EXISTS ${scratch}; CREATE DATABASE ${scratch} CHARACTER SET utf8mb4`]);
    const restore = spawnSync(cli, [...args, '--default-character-set=utf8mb4', scratch], { input: dump });
    const counted = spawnSync(cli, [...args, '-N', '-B', scratch, '-e', 'SELECT COUNT(*) FROM invoices'], { encoding: 'utf8' });
    restoredInvoices = restore.status === 0 ? Number(counted.stdout.trim()) : `restore failed: ${restore.stderr}`;
    spawnSync(cli, [...args, '-e', `DROP DATABASE IF EXISTS ${scratch}`]);
  } else {
    // ค่าข้อความในไฟล์สำรองถูก escape ขึ้นบรรทัดใหม่เป็น \n แล้ว — แต่ละแถวจึงคั่นด้วย "),<ขึ้นบรรทัด>(" เสมอ
    const inserts = [...dump.matchAll(/INSERT INTO `invoices` \([^)]*\) VALUES\n([\s\S]*?);\n/g)];
    restoredInvoices = inserts.reduce((n, m) => n + m[1].split('),\n(').length, 0);
  }
  check('สั่งสำรองทันทีได้ ได้สำเนาฐานข้อมูลที่กู้คืนได้ครบ + กุญแจลับ',
    bk.status === 200 && bk.body.count === 1 && dump.includes('CREATE TABLE `invoices`')
      && restoredInvoices === liveInvoices
      && fs.existsSync(path.join(backupDir, 'secrets.json')), { status: bk.status, count: bk.body.count, restoredInvoices, liveInvoices });
  // สิทธิ์ไฟล์แบบ POSIX ตรวจได้เฉพาะ Linux/macOS (เครื่องจริง) — Windows ไม่มีบิตสิทธิ์แบบนี้
  if (process.platform !== 'win32') {
    check('โฟลเดอร์สำรองอ่านได้เฉพาะเจ้าของเครื่อง (มีกุญแจลับอยู่ข้างใน)',
      (fs.statSync(backupDir).mode & 0o077) === 0 && (fs.statSync(snap).mode & 0o077) === 0);
  }
  check('สำรองไม่สำเร็จ = แจ้งเสมอ ปิดไม่ได้',
    cfg.body.events.find((e) => e.key === 'system.backup_failed')?.locked === true);

  // ใครอ่านประกาศแล้ว — นับเป็นร้าน
  const a = await api('POST', '/api/announcements', { token: admin, body: { title: 'หยุดวันปิยะ', body: 'งดส่งของ 23 ต.ค.', category: 'HOLIDAY' } });
  await api('POST', `/api/announcements/${a.body.id}/read`, { token: tokenA });
  // คนที่สองในร้านเดียวกันก็อ่าน (ใส่ตรงในฐานข้อมูล — ผู้ช่วยในเทสต์ก่อนหน้าอาจถูกปิดบัญชีไปแล้ว)
  const mate = db.prepare("SELECT id FROM users WHERE franchise_id = ? AND username <> 'shopa' LIMIT 1").get(fidA);
  if (mate) db.prepare('INSERT IGNORE INTO announcement_reads (announcement_id, user_id) VALUES (?, ?)').run(a.body.id, mate.id);
  const listed = (await api('GET', '/api/announcements', { token: admin })).body.items.find((x) => x.id === a.body.id);
  const activeShops = db.prepare("SELECT COUNT(*) AS n FROM franchises WHERE status = 'ACTIVE'").get().n;
  check('ส่วนกลางเห็น "อ่านแล้วกี่ร้าน" (คนในร้านเดียวกันอ่านหลายคน นับเป็นร้านเดียว)',
    listed.reach?.read === 1 && listed.reach.total === activeShops, listed.reach);
  check('ร้านไม่เห็นสถิติการอ่านของร้านอื่น',
    !('reach' in ((await api('GET', '/api/announcements', { token: tokenB })).body.items.find((x) => x.id === a.body.id) ?? {})));
  const readers = await api('GET', `/api/announcements/${a.body.id}/readers`, { token: admin });
  check('รายชื่อร้านที่อ่านแล้ว/ยังไม่อ่าน พร้อมเวลาอ่าน',
    readers.status === 200 && readers.body.read.length === 1 && readers.body.read[0].username === 'shopa' && Boolean(readers.body.read[0].readAt)
      && readers.body.unread.some((x) => x.username === 'shopb') && readers.body.read.length + readers.body.unread.length === activeShops, readers.body);
  check('ร้านดูรายชื่อคนอ่านไม่ได้', (await api('GET', `/api/announcements/${a.body.id}/readers`, { token: tokenA })).status === 403);
  await api('DELETE', `/api/announcements/${a.body.id}`, { token: admin });
}

section('captcha หน้าเข้าสู่ระบบ: หลาย IP ผลัดกันเดารหัสบัญชีเดียว (botnet)');
{
  for (const u of ['botshop', 'botshop2', 'botshop3']) {
    await api('POST', '/api/franchises', { token: admin, body: { username: u, password: `${u}-pass-1` } });
  }
  // IP ละครั้ง — ด่านเดิม (10 ครั้งต่อ IP) ไม่มีวันเห็น ต้องเป็นด่านที่นับตามชื่อบัญชี
  let ipSeq = 0;
  const loginAs = (username, password, extra = {}) => api('POST', '/api/auth/login', {
    body: { username, password, ...extra }, headers: { 'x-forwarded-for': `203.0.113.${++ipSeq}` },
  });

  const initial = await api('GET', '/api/settings/turnstile', { token: admin });
  check('ตั้งต้นยังไม่เปิด captcha · ถามเมื่อผิดเกิน 5 ครั้ง', initial.status === 200 && initial.body.configured === false && initial.body.threshold === 5, initial.body);
  const limit = initial.body.threshold;
  const captchaAlerts = (from, username) => telegram.messages.slice(from)
    .filter((m) => m.text.includes(`ใส่รหัสผิดเกิน ${limit} ครั้งใน 1 ชั่วโมง`) && m.text.includes(`<b>${username}</b>`));
  check('ร้านค้าดูค่าตั้ง captcha ไม่ได้', (await api('GET', '/api/settings/turnstile', { token: tokenA })).status === 403);

  // ยังไม่เปิด captcha: ยังนับและแจ้งกลุ่ม แต่ไม่ถาม captcha
  let mark = telegram.messages.length;
  for (let i = 0; i <= limit; i++) await loginAs('botshop', `wrong-${i}`);
  const noCaptcha = await loginAs('botshop', 'botshop-pass-1');
  check('ยังไม่เปิด captcha: เดาจากหลาย IP เกินกำหนด เจ้าของยังล็อกอินได้ตามปกติ', noCaptcha.status === 200, noCaptcha.body);
  await flushTelegram();
  const offAlert = captchaAlerts(mark, 'botshop');
  check('…แต่กลุ่มได้รับแจ้งว่าบัญชีนี้กำลังถูกเดา พร้อมแนะนำให้เปิด captcha',
    offAlert.length === 1 && /ยังไม่ได้เปิด captcha/.test(offAlert[0].text), telegram.messages.slice(mark));

  // ── เปิด captcha: ต้องผ่านช่องที่วาดด้วยคีย์ใหม่ก่อน ──
  const keys = { siteKey: TURNSTILE.siteKey, secret: TURNSTILE.secret };
  const put = (body, opts = {}) => api('PUT', '/api/settings/turnstile', { token: admin, body, ...opts });
  check('เปิด captcha โดยไม่ใส่รหัส 6 หลักไม่ได้', (await put({ ...keys, captchaToken: 'pass:setup' }, { elevate: false })).status === 403);
  const badSecret = await put({ ...keys, secret: 'not-the-secret-key', captchaToken: 'pass:setup' });
  check('secret key ผิด → ไม่บันทึก', badSecret.status === 400 && /Secret key/.test(badSecret.body.error.message), badSecret.body);
  check('ไม่ผ่านช่อง captcha → ไม่บันทึก', (await put({ ...keys, captchaToken: 'made-up' })).status === 400);
  check('token จากช่องล็อกอินเอามาตั้งค่าไม่ได้ (action ไม่ตรง)', (await put({ ...keys, captchaToken: 'pass:login:setup' })).status === 400);
  const dummy = await put({ siteKey: '1x00000000000000000000AA', secret: '1x0000000000000000000000000000000AA', captchaToken: 'XXXX.DUMMY.TOKEN.XXXX' });
  check('เซิร์ฟเวอร์จริงไม่รับคีย์ทดสอบของ Cloudflare (ปล่อยผ่านทุกคน)', dummy.status === 400 && /คีย์ทดสอบ/.test(dummy.body.error.message), dummy.body);
  mark = telegram.messages.length;
  const on = await put({ ...keys, captchaToken: 'pass:setup' });
  check('ผ่านช่อง captcha ด้วยคีย์ชุดใหม่ → บันทึก', on.status === 200 && on.body.configured === true && on.body.siteKey === TURNSTILE.siteKey, on.body);
  check('secret ไม่ถูกส่งกลับหน้าเว็บ', !JSON.stringify(on.body).includes(TURNSTILE.secret));
  const sealed = db.prepare("SELECT value FROM app_settings WHERE name = 'turnstile.secret'").get();
  check('secret เก็บแบบเข้ารหัสในฐานข้อมูล', Boolean(sealed) && !sealed.value.includes(TURNSTILE.secret), sealed);
  await flushTelegram();
  check('เปิด captcha → กลุ่มได้รับแจ้ง', telegram.messages.slice(mark).some((m) => /เปิด captcha หน้าเข้าสู่ระบบ/.test(m.text)));

  // ── botnet เดาบัญชีเดียว ──
  check('เปิด captcha แล้ว คนใช้ปกติไม่ถูกถาม', (await loginAs('botshop2', 'botshop2-pass-1')).status === 200);
  mark = telegram.messages.length;
  const guesses = [];
  for (let i = 0; i < limit; i++) guesses.push((await loginAs('botshop2', `guess-${i}`)).status);
  check(`${limit} IP เดาคนละครั้ง — ยังไม่ถึงกำหนด (ตอบรหัสผิดตามปกติ)`, guesses.every((s) => s === 401), guesses);
  const asked = await loginAs('botshop2', 'guess-next');
  check(`ครั้งที่ ${limit + 1} จาก IP ใหม่ → ต้องผ่าน captcha ก่อน พร้อม site key ให้หน้าเว็บวาดช่อง`,
    asked.status === 403 && asked.body.error.code === 'CAPTCHA_REQUIRED' && asked.body.error.details?.siteKey === TURNSTILE.siteKey, asked.body);
  const owner = await loginAs('botshop2', 'botshop2-pass-1');
  check('เจ้าของตัวจริงก็ต้องผ่าน captcha (ไม่ใช่ถูกล็อก)', owner.status === 403 && owner.body.error.code === 'CAPTCHA_REQUIRED', owner.body);
  const fake = await loginAs('botshop2', 'botshop2-pass-1', { captchaToken: 'bot-made-this-up' });
  check('token ปลอม → ไม่ผ่าน', fake.status === 403 && fake.body.error.code === 'CAPTCHA_INVALID', fake.body);
  const setupTok = await loginAs('botshop2', 'botshop2-pass-1', { captchaToken: 'pass:setup:again' });
  check('token จากช่องตั้งค่าเอามาล็อกอินไม่ได้', setupTok.status === 403 && setupTok.body.error.code === 'CAPTCHA_INVALID', setupTok.body);
  const passed = await loginAs('botshop2', 'botshop2-pass-1', { captchaToken: 'pass:login:1' });
  check('ผ่าน captcha + รหัสถูก → เข้าระบบได้', passed.status === 200 && Boolean(passed.body.token), passed.body);
  const replay = await loginAs('botshop2', 'botshop2-pass-1', { captchaToken: 'pass:login:1' });
  check('token เดิมใช้ซ้ำไม่ได้', replay.status === 403 && replay.body.error.code === 'CAPTCHA_INVALID', replay.body);
  check('ผ่าน captcha แต่รหัสผิด → ยังเข้าไม่ได้', (await loginAs('botshop2', 'guess-11', { captchaToken: 'pass:login:2' })).status === 401);
  const longTok = await loginAs('botshop2', 'botshop2-pass-1', { captchaToken: 'x'.repeat(2048) });
  check('token ยาว 2,048 ตัว (ยาวสุดที่ Cloudflare ออกให้) ผ่านเพดานความยาวของ body',
    longTok.status === 403 && longTok.body.error.code === 'CAPTCHA_INVALID', longTok.body);
  turnstile.down = true;
  const down = await loginAs('botshop2', 'botshop2-pass-1', { captchaToken: 'pass:login:3' });
  turnstile.down = false;
  check('ติดต่อ Cloudflare ไม่ได้ → ไม่ปล่อยผ่าน (503 ลองใหม่ได้)', down.status === 503 && down.body.error.code === 'CAPTCHA_UNAVAILABLE', down.body);
  await flushTelegram();
  const onAlert = captchaAlerts(mark, 'botshop2');
  check('กลุ่มได้รับแจ้งครั้งเดียวตอนเริ่มถาม captcha — ไม่ท่วมกลุ่ม',
    onAlert.length === 1 && /ต้องยืนยันว่าไม่ใช่บอท/.test(onAlert[0].text), onAlert);

  check('เปิดทีหลังก็มีผลกับบัญชีที่ถูกเดาไว้ก่อนแล้ว', (await loginAs('botshop', 'botshop-pass-1')).body?.error?.code === 'CAPTCHA_REQUIRED');
  check('บัญชีอื่นไม่โดนไปด้วย', (await loginAs('botshop3', 'botshop3-pass-1')).status === 200);
  mark = telegram.messages.length;
  for (let i = 0; i < limit; i++) await loginAs('no-such-user', 'x');
  const ghost = await loginAs('no-such-user', 'x');
  check('ชื่อที่ไม่มีจริงก็ถูกถาม captcha เหมือนกัน (เดาจาก captcha ไม่ได้ว่าชื่อไหนมีจริง)', ghost.body?.error?.code === 'CAPTCHA_REQUIRED', ghost.body);
  await flushTelegram();
  check('ชื่อที่ไม่มีจริงไม่แจ้งกลุ่ม (สุ่มชื่อมาเป็นร้อยจะท่วมกลุ่ม)', captchaAlerts(mark, 'no-such-user').length === 0);

  // ── ปิด captcha ──
  mark = telegram.messages.length;
  check('ปิด captcha โดยไม่ใส่รหัส 6 หลักไม่ได้', (await api('DELETE', '/api/settings/turnstile', { token: admin, elevate: false })).status === 403);
  const offNow = await api('DELETE', '/api/settings/turnstile', { token: admin });
  check('ปิด captcha ได้', offNow.status === 200 && offNow.body.configured === false, offNow.body);
  await flushTelegram();
  check('ปิด captcha → กลุ่มได้รับแจ้ง (ปิดเงียบ ๆ ไม่ได้)', telegram.messages.slice(mark).some((m) => /ปิด captcha หน้าเข้าสู่ระบบ/.test(m.text)));
  check('ปิดแล้ว บัญชีที่ถูกเดาอยู่ล็อกอินได้ตามปกติ', (await loginAs('botshop2', 'botshop2-pass-1')).status === 200);
}

section('ใส่รหัส 6 หลักผิดหลายครั้ง (ไว้ท้ายสุด — ล็อกการยืนยันตัวตนไป 15 นาที)');
let lockedAt = null;
for (let i = 1; i <= 8; i++) {
  const r = await api('POST', '/api/auth/elevate', { token: admin, body: { code: String(100000 + i) } });
  if (r.status === 429) { lockedAt = i; break; }
}
check('ได้ session แอดมินไปแต่ไม่มีมือถือ เดารหัส 6 หลักไม่ได้ — โดนล็อก', lockedAt !== null, lockedAt);
check('ล็อกแล้ว ต่อให้ใส่รหัสถูกก็ต้องรอ', (await api('POST', '/api/auth/elevate', {
  token: admin, body: { code: await codeFor(adminSecret) },
})).status === 429);
check('ล็อกแค่การยืนยันตัวตน ส่วนอื่นยังใช้งานได้', (await api('GET', '/api/invoices', { token: admin })).status === 200);
await flushTelegram();
const lockAlerts = telegram.messages.filter((m) => /ใส่รหัส 6 หลักผิดหลายครั้ง/.test(m.text));
check('โดนล็อกแล้วแจ้งเข้า Telegram — ครั้งเดียว ไม่ท่วมกลุ่ม', lockAlerts.length === 1, lockAlerts.length);

// ด่านรหัส 6 หลักตอนล็อกอินก็ต้องเดาไม่ได้เหมือนกัน
const guessLogin = await api('POST', '/api/auth/login', { body: { username: 'superadmin', password: ADMIN_NEW_PASS } });
let mfaLocked = null;
for (let i = 1; i <= 8; i++) {
  const r = await api('POST', '/api/auth/login/mfa', { body: { mfaToken: guessLogin.body.mfaToken, code: String(200000 + i) } });
  if (r.status === 429) { mfaLocked = i; break; }
}
check('ได้รหัสผ่านไปแต่ไม่มีมือถือ เดารหัสตอนล็อกอินไม่ได้ — โดนล็อก', mfaLocked !== null && mfaLocked <= 6, mfaLocked);

server.close();
tgServer.close();
console.log(`\nผ่าน ${passed} ข้อ, ไม่ผ่าน ${failures.length} ข้อ`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
