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

/*
 * เส้นทางที่ต้องยืนยันรหัส 6 หลัก — แอดมินในเทสต์ใส่ให้เองเหมือนหน้าเว็บ
 * แก้บัญชีรับเงิน / แก้หัวบิล (เปลี่ยนบัญชีของบิล) / ส่งเลขบัญชีให้ร้าน / สร้างลิงก์เข้าระบบใหม่ของร้าน / ลบร้าน / ตั้งค่า Telegram / captcha
 * (ปลด 2FA ของผู้ใช้ไม่อยู่ในนี้ — เทสต์ส่ง header เองเพื่อพิสูจน์ว่าไม่ใส่แล้วโดนกัน)
 */
const ELEVATED_URL = new RegExp('^/api/('
  + 'bank-accounts(/\\d+(/notify-shops)?)?'
  + '|invoices/\\d+(/notify-account)?'
  + '|franchises/\\d+/login-link/rotate'
  + '|settings/(telegram(/discover)?|notifications|turnstile)'
  + ')$');
// ลบร้าน (DELETE /api/franchises/:id) — แยกตาม method เพราะ PATCH เส้นเดียวกัน (แก้ข้อมูลร้าน) ไม่ต้องใส่รหัส
const ELEVATED_DELETE = /^\/api\/franchises\/\d+$/;

async function api(method, url, { token, body, headers = {}, elevate = true } = {}) {
  // เทสต์ที่ต้องการทดสอบว่า "ไม่ยืนยันแล้วโดนกัน" ส่ง elevate: false
  const needsCode = ELEVATED_URL.test(url) || (method === 'DELETE' && ELEVATED_DELETE.test(url));
  if (elevate && token && token === admin && method !== 'GET' && needsCode) {
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

/*
 * ผู้ใช้ของร้าน (เจ้าของ + ผู้ช่วย) ล็อกอินได้เฉพาะเมื่อส่ง key จากลิงก์เข้าระบบของร้านตัวเองมาด้วย
 * เทสต์หยิบ key แบบที่ส่วนกลางเปิดดูในหน้าร้านค้า (GET /api/franchises/:id/login-link) แล้วจำไว้
 * สร้างลิงก์ใหม่ (rotate) แล้วต้องลบของเดิมออกจาก shopKeys — key เก่าใช้ไม่ได้ทันที
 */
const shopKeys = new Map();
async function shopLoginKey(franchiseId) {
  if (!shopKeys.has(franchiseId)) {
    const res = await api('GET', `/api/franchises/${franchiseId}/login-link`, { token: admin });
    shopKeys.set(franchiseId, res.body?.key);
  }
  return shopKeys.get(franchiseId);
}
const shopLogin = async (username, password, franchiseId) => api('POST', '/api/auth/login', {
  body: { username, password, loginKey: await shopLoginKey(franchiseId) },
});

/** วันนี้ตามเวลาไทย (YYYY-MM-DD) — ดีลที่ไม่ส่งวันที่เริ่มวันนี้ · เลขบิลค่าคอมใช้วันที่ไทย */
const todayTh = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());

/** ผูกแชต Telegram ส่วนตัวให้ผู้ใช้ — กดลิงก์ t.me แล้วกด Start ในแอป (Telegram จำลองส่ง /start <รหัส> ให้บอท) */
let tgUpdateId = 9000;
async function linkTelegram(token, chatId) {
  const link = await api('POST', '/api/auth/telegram/link', { token });
  const code = link.body?.url ? new URL(link.body.url).searchParams.get('start') : null;
  telegram.updates = [{ update_id: ++tgUpdateId, message: { chat: { id: Number(chatId), type: 'private' }, text: `/start ${code}` } }];
  await pollTelegram();
  telegram.updates = [];
  return (await api('GET', '/api/auth/telegram', { token })).body?.linked === true;
}

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
const fidA = shopA.body.franchise.id;
const fidB = shopB.body.franchise.id;

// ── 2) เจ้าของร้านเข้าระบบดูข้อมูลของตัวเอง ────────────────────────────
section('2) ยูสเซอร์ของร้านเข้าระบบ + ขอบเขตข้อมูล');
// รหัสถูกแต่ไม่ได้มาจากลิงก์ของร้าน = ตอบเหมือนรหัสผิดทุกตัวอักษร (รหัสที่หลุดไปยืนยันไม่ได้แม้แต่ว่าถูก)
const noKeyA = await api('POST', '/api/auth/login', { body: { username: 'shopa', password: 'shopa12345' } });
const wrongPwB = await api('POST', '/api/auth/login', { body: { username: 'shopb', password: 'not-the-password', loginKey: await shopLoginKey(fidB) } });
check('ร้านล็อกอินโดยไม่มี key จากลิงก์ของร้านไม่ได้ — ข้อความเดียวกับรหัสผิด',
  noKeyA.status === 401 && !noKeyA.body?.token && wrongPwB.status === 401
    && noKeyA.body?.error?.message === wrongPwB.body?.error?.message, { noKey: noKeyA.body, wrongPassword: wrongPwB.body });
const loginA = await shopLogin('shopa', 'shopa12345', fidA);
check('ร้าน A ล็อกอินได้', loginA.status === 200, loginA.body);
let tokenA = loginA.body.token;
const tokenB = (await shopLogin('shopb', 'shopb12345', fidB)).body.token;

check('เจ้าของร้านเห็นเฉพาะข้อมูลตัวเอง',
  (await api('GET', '/api/franchises', { token: tokenA })).body.items.length === 1);
check('เจ้าของร้านเปิดข้อมูลของรายอื่นไม่ได้',
  (await api('GET', `/api/franchises/${shopB.body.franchise.id}`, { token: tokenA })).status === 403);
check('ไม่มีโทเคนเข้าไม่ได้', (await api('GET', '/api/products')).status === 401);

// ── ยูสเซอร์: super สร้างให้แค่คนเดียว ที่เหลือเจ้าของบัญชีเพิ่มเอง ──
section('ยูสเซอร์ของร้าน (เจ้าของบัญชี / ผู้ช่วย)');
check('ยูสเซอร์แรกที่มาพร้อมเจ้าของร้านคือเจ้าของบัญชี', shopA.body.user.isOwner === true, shopA.body.user);

check('super admin เพิ่มยูสเซอร์ให้ร้านไม่ได้', (await api('POST', `/api/franchises/${fidA}/users`, {
  token: admin, body: { username: 'helper-by-admin', password: 'helper12345' },
})).status === 403);

const helper = await api('POST', `/api/franchises/${fidA}/users`, {
  token: tokenA, body: { username: 'helpera', password: 'helper12345', displayName: 'ผู้ช่วยเอ' },
});
check('เจ้าของบัญชีเพิ่มผู้ช่วยเองได้', helper.status === 201 && helper.body.isOwner === false, helper.body);

let helperToken = (await shopLogin('helpera', 'helper12345', fidA)).body.token;
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
tokenA = (await shopLogin('shopa', 'shopa12345', fidA)).body.token;
helperToken = (await shopLogin('helpera', 'newhelper123', fidA)).body.token;
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

/* ── ลิงก์เข้าระบบของร้าน ────────────────────────────────────
 * ร้านเข้าระบบได้เฉพาะจากลิงก์ลับของร้านตัวเอง — key ในลิงก์คือ "ของที่ต้องมี" คู่กับรหัสผ่านที่ "ต้องรู้"
 * ทุกกรณีที่ key ไม่ผ่านต้องตอบเหมือนรหัสผิดทุกตัวอักษร ไม่งั้นรหัสที่หลุดไปจะถูกยืนยันได้ว่าถูก
 * ใช้ร้านของเทสต์นี้เอง: สร้างลิงก์ใหม่ทำให้ทุกคนในร้านหลุด จะไปกวน token ของร้าน A/B ในเทสต์อื่น
 */
section('ลิงก์เข้าระบบของร้าน (key ต่อร้าน · สร้างลิงก์ใหม่)');
{
  const BAD = 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
  const ks = await api('POST', '/api/franchises', { token: admin, body: { username: 'keyshop', password: 'keyshop-pass-1' } });
  const kfid = ks.body.franchise?.id;
  check('สร้างร้านแล้วได้ลิงก์เข้าระบบทันที (key สุ่ม 32 ตัว · path /#/s/<key>)',
    ks.status === 201 && /^[A-Za-z0-9_-]{32}$/.test(ks.body.loginLink?.key ?? '') && ks.body.loginLink.path === `/#/s/${ks.body.loginLink.key}`, ks.body.loginLink);
  const key = await shopLoginKey(kfid);
  check('ส่วนกลางเปิดดูลิงก์ของร้านได้ (key เดียวกับตอนสร้าง) · แต่ละร้าน key ไม่ซ้ำกัน',
    key === ks.body.loginLink?.key && key !== await shopLoginKey(fidA) && key !== await shopLoginKey(fidB));

  const tryLogin = (loginKey, username = 'keyshop', password = 'keyshop-pass-1') => api('POST', '/api/auth/login', {
    body: { username, password, ...(loginKey === undefined ? {} : { loginKey }) },
  });
  const noKey = await tryLogin(undefined);
  const wrongKey = await tryLogin('x'.repeat(32));
  const otherKey = await tryLogin(await shopLoginKey(fidA));
  check('ไม่มี key → 401 ข้อความเดียวกับรหัสผิด', noKey.status === 401 && noKey.body.error?.message === BAD, noKey.body);
  check('key มั่ว → 401 ข้อความเดียวกับรหัสผิด', wrongKey.status === 401 && wrongKey.body.error?.message === BAD, wrongKey.body);
  check('key ของร้านอื่น → 401 ข้อความเดียวกับรหัสผิด', otherKey.status === 401 && otherKey.body.error?.message === BAD, otherKey.body);
  const ok = await tryLogin(key);
  check('key ของร้านตัวเอง + รหัสถูก → เข้าระบบได้', ok.status === 200 && Boolean(ok.body.token), ok.body);
  const ownerTok = ok.body.token;
  const staff = await api('POST', `/api/franchises/${kfid}/users`, { token: ownerTok, body: { username: 'keyshop-staff', password: 'keystaff-pass-1' } });
  const staffTok = (await tryLogin(key, 'keyshop-staff', 'keystaff-pass-1')).body.token;
  check('ผู้ช่วยของร้านเข้าด้วยลิงก์เดียวกับร้าน', staff.status === 201 && Boolean(staffTok), staff.body);

  // ส่วนกลางและเซลใช้หน้าเข้าสู่ระบบปกติ — ส่ง key ของร้านมาก็ไม่มีผลอะไร
  const superWithKey = await api('POST', '/api/auth/login', { body: { username: 'superadmin', password: ADMIN_NEW_PASS, loginKey: key } });
  check('ส่วนกลางไม่ต้องใช้ key (ส่งมาก็ไม่สนใจ)', superWithKey.status === 200 && superWithKey.body.mfaRequired === true, superWithKey.body);
  await api('POST', '/api/sales-agents', { token: admin, body: { username: 'keysale', password: 'keysale-pass-1', name: 'เซลทดสอบลิงก์' } });
  const saleNoKey = await api('POST', '/api/auth/login', { body: { username: 'keysale', password: 'keysale-pass-1' } });
  const saleJunk = await api('POST', '/api/auth/login', { body: { username: 'keysale', password: 'keysale-pass-1', loginKey: 'junk' } });
  check('เซลไม่ต้องใช้ key (ส่ง key มั่วมาก็ไม่มีผล)', saleNoKey.status === 200 && saleJunk.status === 200, [saleNoKey.body, saleJunk.body]);

  // ดูลิงก์: เจ้าของบัญชีร้าน (ไว้ส่งให้ผู้ช่วย) · ผู้ช่วยและร้านอื่นดูไม่ได้
  const ownerView = await api('GET', `/api/franchises/${kfid}/login-link`, { token: ownerTok });
  check('เจ้าของบัญชีร้านเปิดดูลิงก์ของร้านตัวเองได้', ownerView.status === 200 && ownerView.body.key === key && ownerView.body.path === `/#/s/${key}`, ownerView.body);
  check('ผู้ช่วยเปิดดูลิงก์ของร้านไม่ได้', (await api('GET', `/api/franchises/${kfid}/login-link`, { token: staffTok })).status === 403);
  check('ร้านอื่นเปิดดูลิงก์ของร้านนี้ไม่ได้', (await api('GET', `/api/franchises/${kfid}/login-link`, { token: tokenA })).status === 403);
  check('เซลเปิดดูลิงก์ของร้านไม่ได้', (await api('GET', `/api/franchises/${kfid}/login-link`, { token: saleNoKey.body.token })).status === 403);

  // สร้างลิงก์ใหม่: ลิงก์เดิมอาจหลุด → key เก่าใช้ไม่ได้ + ทุกคนในร้านหลุด · ส่วนกลางเท่านั้น + รหัส 6 หลัก
  const noCodeRotate = await api('POST', `/api/franchises/${kfid}/login-link/rotate`, { token: admin, elevate: false });
  check('สร้างลิงก์ใหม่โดยไม่ใส่รหัส 6 หลักไม่ได้', noCodeRotate.status === 403 && noCodeRotate.body.error?.code === 'ELEVATION_REQUIRED', noCodeRotate.body);
  check('เจ้าของร้านสร้างลิงก์ใหม่เองไม่ได้', (await api('POST', `/api/franchises/${kfid}/login-link/rotate`, { token: ownerTok })).status === 403);
  await flushTelegram();
  const mark = telegram.messages.length;
  const rotated = await api('POST', `/api/franchises/${kfid}/login-link/rotate`, { token: admin });
  const newKey = rotated.body?.key;
  check('ส่วนกลางสร้างลิงก์ใหม่ได้ (key ใหม่ · path ใหม่)',
    rotated.status === 200 && Boolean(newKey) && newKey !== key && rotated.body.path === `/#/s/${newKey}`, rotated.body);
  shopKeys.delete(kfid);
  const oldKey = await tryLogin(key);
  check('ลิงก์เดิมใช้ไม่ได้ทันที (ข้อความเดียวกับรหัสผิด)', oldKey.status === 401 && oldKey.body.error?.message === BAD, oldKey.body);
  check('ทุกคนในร้านหลุดจากระบบ (เจ้าของและผู้ช่วย)',
    (await api('GET', '/api/auth/me', { token: ownerTok })).status === 401 && (await api('GET', '/api/auth/me', { token: staffTok })).status === 401);
  check('ร้านอื่นไม่หลุดไปด้วย', (await api('GET', '/api/auth/me', { token: tokenA })).status === 200);
  check('เข้าด้วยลิงก์ใหม่ได้', (await shopLogin('keyshop', 'keyshop-pass-1', kfid)).status === 200 && await shopLoginKey(kfid) === newKey);
  await flushTelegram();
  const rotMsg = telegram.messages.slice(mark).find((m) => /สร้างลิงก์เข้าระบบใหม่ให้ร้าน keyshop/.test(m.text));
  check('สร้างลิงก์ใหม่ → กลุ่มส่วนกลางได้แจ้ง (ลิงก์เดิมใช้ไม่ได้ · ทุกคนถูกออกจากระบบ)',
    rotMsg?.chat_id === TG_CHAT && /ผู้ใช้ทุกคนของร้านถูกออกจากระบบ/.test(rotMsg.text), telegram.messages.slice(mark).map((m) => m.text));
}

/* ── ตั้งรหัสใหม่ให้ลูกค้า แล้วให้ตั้งรหัสเองตอนเข้าครั้งแรก ──────────
 * ส่วนกลางคัดลอกชุด "ลิงก์ + ชื่อผู้ใช้ + รหัส" ส่งทางแชต — รหัสนั้นเห็นกันหลายคน ต้องบังคับเปลี่ยนตอนเข้าครั้งแรก
 */
section('ตั้งรหัสใหม่ + บังคับเปลี่ยนรหัสตอนเข้าครั้งแรก (ร้าน / เซล)');
{
  const rs = await api('POST', '/api/franchises', { token: admin, body: { username: 'resetshop', password: 'resetshop-pass-1' } });
  const rfid = rs.body.franchise?.id;
  const owner = rs.body.user;
  let ownerTok = (await shopLogin('resetshop', 'resetshop-pass-1', rfid)).body.token;
  const staff = await api('POST', `/api/franchises/${rfid}/users`, { token: ownerTok, body: { username: 'resetshop-staff', password: 'rstaff-pass-1' } });

  const reset = await api('POST', `/api/franchises/${rfid}/users/${owner?.id}/reset-password`, {
    token: admin, body: { newPassword: 'from-chat-pass-1', mustChange: true },
  });
  check('ส่วนกลางตั้งรหัสใหม่ให้เจ้าของร้าน พร้อมบังคับเปลี่ยนตอนเข้าครั้งแรก',
    reset.status === 200 && reset.body.ok === true && reset.body.user?.mustChangePassword === true, reset.body);
  const first = await shopLogin('resetshop', 'from-chat-pass-1', rfid);
  check('เข้าด้วยรหัสที่ได้ทางแชต → ระบบบอกให้ตั้งรหัสใหม่ก่อน', first.status === 200 && first.body.mustChangePassword === true, first.body);
  const gated = await api('GET', '/api/invoices', { token: first.body.token });
  check('ยังไม่ตั้งรหัสใหม่ ใช้งานอย่างอื่นไม่ได้', gated.status === 403 && gated.body.error?.code === 'PASSWORD_CHANGE_REQUIRED', gated.body);
  const changed = await api('POST', '/api/auth/change-password', {
    token: first.body.token, body: { currentPassword: 'from-chat-pass-1', newPassword: 'owner-own-pass-1' },
  });
  const again = await shopLogin('resetshop', 'owner-own-pass-1', rfid);
  check('ตั้งรหัสของตัวเองแล้วใช้งานได้ปกติ ไม่ถูกบังคับอีก',
    changed.status === 200 && again.status === 200 && again.body.mustChangePassword === false, again.body);
  ownerTok = again.body.token;
  const staffReset = await api('POST', `/api/franchises/${rfid}/users/${staff.body?.id}/reset-password`, {
    token: ownerTok, body: { newPassword: 'staff-chat-pass-1', mustChange: true },
  });
  check('เจ้าของร้านตั้งรหัสใหม่ให้ผู้ช่วยแบบบังคับเปลี่ยนได้', staffReset.status === 200 && staffReset.body.user?.mustChangePassword === true, staffReset.body);
  check('ตั้งรหัสใหม่ไม่ส่ง mustChange = ไม่บังคับ (แบบเดิม)', (await api('POST', `/api/franchises/${rfid}/users/${owner?.id}/reset-password`, {
    token: admin, body: { newPassword: 'owner-own-pass-2' },
  })).body.user?.mustChangePassword === false);

  // เซลใช้ endpoint ของเซล — ผู้ใช้ต้องเป็นของเซลคนนั้นจริง
  const s1 = (await api('POST', '/api/sales-agents', { token: admin, body: { username: 'resetsale', password: 'resetsale-pass-1', name: 'เซลตั้งรหัสใหม่' } })).body;
  const s2 = (await api('POST', '/api/sales-agents', { token: admin, body: { username: 'resetsale2', password: 'resetsale2-pass-1', name: 'เซลอีกคน' } })).body;
  const saleTok = (await api('POST', '/api/auth/login', { body: { username: 'resetsale', password: 'resetsale-pass-1' } })).body.token;
  const saleUrl = (agentId, userId) => `/api/sales-agents/${agentId}/users/${userId}/reset-password`;
  const saleReset = await api('POST', saleUrl(s1.agent?.id, s1.user?.id), { token: admin, body: { newPassword: 'sale-chat-pass-1', mustChange: true } });
  check('ส่วนกลางตั้งรหัสใหม่ให้เซล พร้อมบังคับเปลี่ยน', saleReset.status === 200 && saleReset.body.user?.mustChangePassword === true, saleReset.body);
  check('ตั้งรหัสใหม่แล้ว session เก่าของเซลหลุด', (await api('GET', '/api/auth/me', { token: saleTok })).status === 401);
  const saleFirst = await api('POST', '/api/auth/login', { body: { username: 'resetsale', password: 'sale-chat-pass-1' } });
  check('เซลเข้าด้วยรหัสใหม่ → ต้องตั้งรหัสเองก่อน', saleFirst.status === 200 && saleFirst.body.mustChangePassword === true, saleFirst.body);
  check('ผู้ใช้ไม่ใช่ของเซลคนนั้น → ไม่พบ (404)', (await api('POST', saleUrl(s2.agent?.id, s1.user?.id), { token: admin, body: { newPassword: 'x-pass-12345' } })).status === 404);
  check('ส่ง id ผู้ใช้ของร้านมาทาง endpoint ของเซล → ไม่พบ (404)', (await api('POST', saleUrl(s1.agent?.id, owner?.id), { token: admin, body: { newPassword: 'x-pass-12345' } })).status === 404);
  check('เซลตั้งรหัสให้ตัวเอง/คนอื่นทางนี้ไม่ได้', (await api('POST', saleUrl(s1.agent?.id, s1.user?.id), { token: saleFirst.body.token, body: { newPassword: 'x-pass-12345' } })).status === 403);
  check('ร้านค้าตั้งรหัสให้เซลไม่ได้', (await api('POST', saleUrl(s1.agent?.id, s1.user?.id), { token: tokenA, body: { newPassword: 'x-pass-12345' } })).status === 403);
  check('รหัสสั้นกว่า 8 ตัวไม่รับ', (await api('POST', saleUrl(s1.agent?.id, s1.user?.id), { token: admin, body: { newPassword: 'short' } })).status === 400);
}

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
// ตัวเลขต้องกรอกที่ดีลเสมอ เซลไม่มีค่าตั้งต้นให้หยิบมาใช้แล้ว · ไม่ต้องเลือกวันที่ (เริ่มวันนี้ เปิดไว้จนกด "ปิดดีล")
const link1res = await api('POST', '/api/sales-agents/links', {
  token: admin,
  body: {
    salesAgentId: agent1.body.agent.id,
    items: [{ productId: p1.body.product.id, commissionPct: 5, fixedAmount: 300 }],
  },
});
const link1 = { status: link1res.status, body: link1res.body.items?.[0] ?? link1res.body };
check('ผูกเซลกับสินค้าที่ผลักดัน',
  link1.status === 201 && link1.body.sku === 'SKU-001'
  && link1.body.commissionPct === 5 && link1.body.fixedAmount === 300, link1.body);
check('ผูกดีลโดยไม่ต้องเลือกวันที่ — เริ่มวันนี้ (เวลาไทย) และเปิดไว้จนกดปิดดีล',
  link1.body.startDate === todayTh && link1.body.endDate === null && link1.body.isOpen === true, link1.body);

const heldTwice = await api('POST', '/api/sales-agents/links', {
  token: admin,
  body: { salesAgentId: agent2.body.agent.id, items: [{ productId: p1.body.product.id, commissionPct: 5 }] },
});
check('สินค้าชิ้นเดียวมีเซลถือดีลซ้อนกันไม่ได้ — ต้องปิดดีลเดิมก่อน',
  heldTwice.status === 409 && /ปิดดีลเดิมก่อน/.test(heldTwice.body.error?.message ?? ''), heldTwice.body);

// % ของเซลคิดจากยอดขายเต็มของร้านเสมอ (เจ้าของระบบตัดตัวเลือก "คิดจากส่วนต่าง" ทิ้ง) — ส่ง basis อื่นมาก็ไม่มีผล
const link2res = await api('POST', '/api/sales-agents/links', {
  token: admin,
  body: {
    salesAgentId: agent2.body.agent.id,
    basis: 'COMMISSION',
    items: [{ productId: p2.body.product.id, commissionPct: 12 }],
  },
});
const link2 = { status: link2res.status, body: link2res.body.items?.[0] ?? link2res.body };
check('ผูกเซลอีกคนกับสินค้าอีกชิ้นได้ (คิดจากยอดขายเต็มเสมอ ส่ง basis อื่นมาก็ไม่มีผล)',
  link2.status === 201 && link2.body.basis === 'GROSS' && link1.body.basis === 'GROSS', link2.body);

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

/*
 * ออกบิลร้านไม่ทำให้เกิดค่าคอมเซลเองอีกแล้ว — ส่วนกลางทำ "บิลค่าคอม" ทีหลัง
 * ติ๊กเองว่ารอบนี้จ่ายรายการไหน (เจ้าของระบบ: แต่ละรอบจ่ายค่าคอมไม่เหมือนกัน) · ไม่ต้องรอร้านจ่ายก่อน
 */
const e2 = await api('GET', `/api/sales-entries?periodCode=2026-08-H1`, { token: admin });
for (const e of e2.body.items) await api('POST', `/api/sales-entries/${e.id}/approve`, { token: admin });
const inv2 = await api('POST', '/api/invoices/generate', {
  token: admin, body: { franchiseId: shopA.body.franchise.id, periodCode: '2026-08-H1' },
});
check('ออกบิลรอบ 2026-08-H1 ได้ (ส่วนต่าง 11,250)', inv2.status === 201 && inv2.body.commissionTotal === 11250, inv2.body);

const comms = await api('GET', `/api/sales-agents/commissions?salesAgentId=${agent1.body.agent.id}`, { token: admin });
check('ออกบิลร้านแล้วไม่เกิดค่าคอมเซลเอง (ต้องทำบิลค่าคอม)', comms.status === 200 && comms.body.items.length === 0, comms.body.items);

const cand1 = (await api('GET', `/api/sales-agents/${agent1.body.agent.id}/commission-candidates`, { token: admin })).body;
const cand1Item = cand1.items?.find((i) => i.invoiceId === inv2.body.id);
const cand1Fixed = cand1.fixed?.find((f) => f.invoiceId === inv2.body.id);
check('บรรทัดของบิลร้านขึ้นให้ติ๊กทำบิลค่าคอม พร้อมค่าตั้งต้นจากดีล (5% + เหมา 300 ต่อรอบ)',
  cand1Item?.sku === 'SKU-001' && cand1Item.grossAmount === 90000 && cand1Item.deal?.pct === 5 && cand1Item.deal.isOpen === true
  && cand1Fixed?.amount === 300 && cand1Fixed.periodCode === '2026-08-H1', { items: cand1.items, fixed: cand1.fixed });
check('ติ๊กได้เฉพาะสินค้าที่เซลคนนี้ถือดีล', (cand1.items ?? []).every((i) => i.sku === 'SKU-001'), cand1.items?.map((i) => i.sku));

const c1res = await api('POST', `/api/sales-agents/${agent1.body.agent.id}/commission-bills`, {
  token: admin,
  body: { items: [{ entryId: cand1Item?.entryId, mode: 'PCT', pct: cand1Item?.deal?.pct }], fixed: [{ key: cand1Fixed?.key }] },
});
const c1 = c1res.body;
check('ทำบิลค่าคอม: 5% ของยอดขายเต็ม 90,000 = 4,500 + เหมา 300 = 4,800',
  c1res.status === 201 && c1.kind === 'BILL' && c1.status === 'PENDING'
  && c1.pctAmount === 4500 && c1.fixedAmount === 300 && c1.totalAmount === 4800
  && c1.billNo === `COM-${todayTh.replace(/-/g, '')}-salea`, c1);
const c1Item = c1.lines?.find((l) => l.kind === 'ITEM');
check('คอมเซลคิดจากยอดขายเต็ม ไม่ใช่ส่วนต่างที่ร้านจ่ายหรือยอดหลังบวกค่าใช้จ่าย',
  c1.baseAmount === 90000 && c1Item?.baseAmount === 90000 && c1Item.pct === 5 && c1Item.amount === 4500
  && c1Item.invoiceNo === inv2.body.invoiceNo, { base: c1.baseAmount, line: c1Item });

const saleToken = (await api('POST', '/api/auth/login', { body: { username: 'salea', password: 'salea12345' } })).body.token;
const me = await api('GET', '/api/sales-agents/me', { token: saleToken });
check('เซลล็อกอินเห็นสินค้าที่ตัวเองถือดีลและยอดคอม',
  me.body.agent.username === 'salea' && me.body.products.length === 1 && me.body.summary.pending > 0, me.body.summary);
check('หน้าแรกของเซลมีบิลค่าคอมล่าสุด และยอดรายเดือน',
  me.body.recentBills?.some((b) => b.id === c1.id) && me.body.byMonth?.some((m) => m.pendingAmount === 4800), { recent: me.body.recentBills, byMonth: me.body.byMonth });

const myComms = await api('GET', '/api/sales-agents/me/commissions', { token: saleToken });
check('เซลเห็นเฉพาะคอมของตัวเอง',
  myComms.body.items.some((c) => c.id === c1.id) && myComms.body.items.every((c) => c.agentUsername === 'salea'),
  myComms.body.items.map((c) => c.agentUsername));

// ปุ่ม "ดูมุมมองนี้" ของ super admin เรียก /me พร้อม salesAgentId
const asAgent = await api('GET', `/api/sales-agents/me?salesAgentId=${agent1.body.agent.id}`, { token: admin });
check('super admin ดูมุมมองของเซลได้',
  asAgent.status === 200 && asAgent.body.agent.username === 'salea', asAgent.body?.agent);
check('super admin ต้องระบุว่าดูของเซลคนไหน',
  (await api('GET', '/api/sales-agents/me', { token: admin })).status === 403);
/* ── ค่าคอมรายการอื่น ๆ ที่พิมพ์เป็นจำนวนเงิน (API แบบเก่าที่มีรอบ) ──────────────
 * หน้าเว็บย้ายไปใส่เป็น "ค่าคอมอื่น ๆ" ในบิลค่าคอมแล้ว (ไม่ต้องเลือกรอบ)
 * แต่ endpoint เดิมยังต้องใช้ได้และกติกาเดิมยังอยู่ — ไคลเอนต์เก่า/ข้อมูลเก่ายังอ้างถึง
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

// บิลค่าคอมไม่มีรอบ — รายการของเซลรวมบิลค่าคอมกับรายการพิมพ์เองแบบเก่าไว้ที่เดียว จ่ายรวบได้
const allOfA = await api('GET', `/api/sales-agents/commissions?salesAgentId=${agent1.body.agent.id}`, { token: admin });
check('ค่าคอมที่พิมพ์เองอยู่ในรายการเดียวกับบิลค่าคอมของเซล',
  allOfA.body.items.filter((c) => c.isManual).length === 2
  && allOfA.body.items.some((c) => c.id === c1.id && c.isBill), allOfA.body.items.map((c) => c.title));
check('ยอดรวมนับรวมรายการที่พิมพ์เองและหักลบตัวติดลบให้ (4,800 + 5,000 − 1,200)',
  allOfA.body.summary.total === Number((4800 + 5000 - 1200).toFixed(2)), allOfA.body.summary);
const manualOfPeriod = await api('GET', `/api/sales-agents/commissions?salesAgentId=${agent1.body.agent.id}&periodCode=2026-08-H1`, { token: admin });
check('กรองตามรอบได้เฉพาะรายการแบบเก่า (บิลค่าคอมไม่มีรอบ)',
  manualOfPeriod.body.items.length === 2 && manualOfPeriod.body.items.every((c) => c.isManual), manualOfPeriod.body.items.map((c) => c.title));

check('แก้ไขค่าคอมที่พิมพ์เองได้', (await api('PATCH', `/api/sales-agents/commissions/manual/${manual1.body.id}`, {
  token: admin, body: { amount: 4500 },
})).body.totalAmount === 4500);

check('บิลค่าคอม แก้ผ่านช่องทางของรายการพิมพ์เองไม่ได้', (await api('PATCH', `/api/sales-agents/commissions/manual/${c1.id}`, {
  token: admin, body: { amount: 999 },
})).status === 409);
check('บิลค่าคอม ลบไม่ได้ (ต้องยกเลิกพร้อมเหตุผล ประวัติต้องอยู่ครบ)',
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
check('เซลทำบิลค่าคอมให้ตัวเองไม่ได้', (await api('POST', `/api/sales-agents/${agent1.body.agent.id}/commission-bills`, {
  token: saleToken, body: { others: [{ label: 'ขอเอง', amount: 100 }] },
})).status === 403);

const paidComm = await api('POST', `/api/sales-agents/commissions/${c1.id}/pay`, { token: admin, body: { paidAt: '2026-09-25' } });
check('super admin บันทึกว่าจ่ายคอมเซลแล้ว', paidComm.body.status === 'PAID', paidComm.body);
check('จ่ายซ้ำไม่ได้', (await api('POST', `/api/sales-agents/commissions/${c1.id}/pay`, { token: admin })).status === 409);
check('บิลค่าคอมที่จ่ายแล้วยกเลิกไม่ได้ (จ่ายเกินให้หักด้วยค่าคอมอื่น ๆ ติดลบในบิลถัดไป)',
  (await api('POST', `/api/sales-agents/commissions/${c1.id}/void`, { token: admin, body: { reason: 'ขอยกเลิก' } })).status === 409);

const voided = await api('POST', `/api/invoices/${inv2.body.id}/void`, { token: admin, body: { reason: 'ทดสอบยกเลิก' } });
check('ยกเลิกบิลได้เมื่อยังไม่มีการชำระ', voided.body.status === 'VOID', voided.body.status);
const afterVoid = await api('GET', `/api/sales-agents/commissions/${c1.id}`, { token: admin });
check('ยกเลิกบิลแล้วคอมเซลที่จ่ายไปแล้วไม่ถูกล้าง (ติดป้ายว่าบิลร้านถูกยกเลิก)',
  afterVoid.body.status === 'PAID' && afterVoid.body.totalAmount === 4800 && afterVoid.body.lines?.length === 2
  && afterVoid.body.lines.find((l) => l.kind === 'ITEM')?.invoiceVoided === true, afterVoid.body);


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
 * บิลใบนี้มี 2 สินค้าที่เซลคนละคนถือดีล — แต่ละคนติ๊กได้เฉพาะสินค้าของตัวเอง แยกบิลค่าคอมกัน
 * % ของเซลคิดจากยอดขายเต็มของสินค้า (ไม่ใช่ส่วนต่างที่ร้านจ่าย)
 *   salea ถือ SKU-001 (60,000 × 5% = 3,000 + เหมา 300) = 3,300
 *   saleb ถือ SKU-003 (30,000 × 10% = 3,000 ไม่มีเหมา)  = 3,000
 */
const onPartial = (c) => ({
  items: (c.items ?? []).filter((i) => i.invoiceId === partial.body.id),
  fixed: (c.fixed ?? []).filter((f) => f.invoiceId === partial.body.id),
});
const pickA = onPartial((await api('GET', `/api/sales-agents/${agent1.body.agent.id}/commission-candidates`, { token: admin })).body);
const pickB = onPartial((await api('GET', `/api/sales-agents/${agent2.body.agent.id}/commission-candidates`, { token: admin })).body);
check('ค่าคอมเซลตามยอดที่เพิ่มขึ้น: บรรทัดที่เติมเข้าบิลทีหลังก็ติ๊กได้ (เหมาต่อรอบรายการเดียวต่อรอบ)',
  pickA.items.length === 1 && pickA.fixed.length === 1 && pickB.items.length === 1 && pickB.fixed.length === 0, { a: pickA, b: pickB });
const billPicked = (agentId, pick) => api('POST', `/api/sales-agents/${agentId}/commission-bills`, {
  token: admin,
  body: { items: pick.items.map((i) => ({ entryId: i.entryId, mode: 'PCT', pct: i.deal?.pct })), fixed: pick.fixed.map((f) => ({ key: f.key })) },
});
const commsA = await billPicked(agent1.body.agent.id, pickA);
check('salea ได้คอมเฉพาะสินค้าที่ตัวเองถือ (60,000 × 5% = 3,000 + เหมา 300 = 3,300)',
  commsA.status === 201 && commsA.body.totalAmount === 3300
  && commsA.body.lines.filter((l) => l.kind === 'ITEM').map((l) => l.sku).join() === 'SKU-001',
  { total: commsA.body.totalAmount, lines: commsA.body.lines?.map((l) => [l.kind, l.sku, l.amount]) });

const commsB = await billPicked(agent2.body.agent.id, pickB);
check('บิลใบเดียวทำค่าคอมให้เซลคนที่สองได้ด้วย (30,000 × 10% = 3,000)',
  commsB.status === 201 && commsB.body.totalAmount === 3000
  && commsB.body.lines.map((l) => l.sku).join() === 'SKU-003', { total: commsB.body.totalAmount, lines: commsB.body.lines });

const bothOnInvoice = (await api('GET', `/api/sales-agents/commissions?franchiseId=${fidA}`, { token: admin })).body;
check('คอมทั้งสองบิลอ้างถึงใบเรียกเก็บใบเดียวกัน',
  bothOnInvoice.items.filter((c) => c.status !== 'VOID' && c.lines.some((l) => l.invoiceNo === partial.body.invoiceNo)).length === 2,
  bothOnInvoice.items.map((c) => `${c.agentUsername}:${c.billNo}:${c.totalAmount}`));
check('บรรทัดเดียวกันทำบิลค่าคอมซ้ำไม่ได้ (กันจ่ายซ้ำ)', (await billPicked(agent1.body.agent.id, pickA)).status === 400);

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

// บัญชีรับดอลลาร์ = กระเป๋าคริปโต: กรอกแค่เครือข่าย (chain) + ที่อยู่กระเป๋า (+ QR) — รายละเอียดอยู่หมวด "บัญชีรับเงิน USD"
const usdAcc = await api('POST', '/api/bank-accounts', {
  token: admin,
  body: { currency: 'USD', chain: 'TRC20', accountNumber: 'TSmokeUsdWalletAddr000000001' },
});
check('เพิ่มบัญชีที่รับดอลลาร์ได้ (กระเป๋า: เครือข่าย + ที่อยู่)',
  usdAcc.status === 201 && usdAcc.body.currency === 'USD' && usdAcc.body.isWallet === true && usdAcc.body.chain === 'TRC20', usdAcc.body);
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

// เปลี่ยนเป็นบัญชี USD = กลายเป็นกระเป๋า ต้องกรอกช่องของกระเป๋าให้ครบในครั้งเดียว
check('บัญชีบาทเปลี่ยนเป็น USD โดยไม่ใส่เครือข่าย/ที่อยู่กระเป๋าไม่ได้', (await api('PATCH', `/api/bank-accounts/${freeAcc.body.id}`, {
  token: admin, body: { currency: 'USD' },
})).status === 400);
const freeToUsd = await api('PATCH', `/api/bank-accounts/${freeAcc.body.id}`, {
  token: admin, body: { currency: 'USD', chain: 'ERC20', accountNumber: '0xSmokeFreeWallet000000002' },
});
check('บัญชีที่ยังไม่ผูกบิล เปลี่ยนสกุลได้ (พร้อมเครือข่าย + ที่อยู่กระเป๋า)',
  freeToUsd.body.currency === 'USD' && freeToUsd.body.isWallet === true && freeToUsd.body.chain === 'ERC20' && freeToUsd.body.accountName === '', freeToUsd.body);

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

const viewToken = (await shopLogin('a-view', 'viewonly1234', fid)).body.token;

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

const token2 = (await shopLogin('a-view', 'viewonly1234', fid)).body.token;
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
const mfaShop = await api('POST', '/api/franchises', { token: admin, body: { username: 'mfashop', password: 'mfashop-pass-1' } });
const mfaLogin = () => shopLogin('mfashop', 'mfashop-pass-1', mfaShop.body.franchise.id);
let mtok = (await mfaLogin()).body.token;
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

const mlogin = await mfaLogin();
check('ล็อกอินต้องใส่รหัส 6 หลักต่อ', mlogin.body.mfaRequired === true && !mlogin.body.token, mlogin.body);
check('รหัสผิดเข้าไม่ได้', (await api('POST', '/api/auth/login/mfa', {
  body: { mfaToken: mlogin.body.mfaToken, code: '12345' },
})).status === 403);
const goodCode = await codeFor(msetup.body.secret);
const mok = await api('POST', '/api/auth/login/mfa', { body: { mfaToken: mlogin.body.mfaToken, code: goodCode } });
check('รหัสถูกเข้าได้', mok.status === 200 && Boolean(mok.body.token), mok.body);
const mlogin2 = await mfaLogin();
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
const afterReset = await mfaLogin();
check('ปลดแล้วร้านล็อกอินด้วยรหัสผ่านได้', Boolean(afterReset.body.token) && !afterReset.body.mfaRequired, afterReset.body);
check('ปลดแล้ว session เก่าของร้านหลุด', (await api('GET', '/api/auth/me', { token: mok.body.token })).status === 401);
await flushTelegram();
check('ปลด 2FA → แจ้ง Telegram', telegram.messages.some((m) => /ปลด Google Authenticator ของผู้ใช้/.test(m.text)));

section('หน้าแรกของร้าน: เช็กลิสต์ · ประกาศ · Telegram ของร้าน · เตือนก่อนครบกำหนด · ขอบคุณ');
{
  const shop = await api('POST', '/api/franchises', { token: admin, body: { username: 'engshop', password: 'engshop-pass-1' } });
  const fid = shop.body.franchise.id;
  const stok = (await shopLogin('engshop', 'engshop-pass-1', fid)).body.token;

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
  // ข้อความเตือนก็มีบัญชีสำหรับโอน (ตามที่แจ้งร้านตอนออกบิล) + คำเตือนให้ตรวจก่อนโอน
  check('ข้อความเตือนบอกบัญชีสำหรับโอนของบิล พร้อมคำเตือนห้ามโอนถ้าไม่ตรง',
    Boolean(remind) && (bill.body.bankAccount ? remind.text.includes(bill.body.bankAccount.accountNumber) : /ยังไม่ได้ระบุบัญชีปลายทาง/.test(remind.text))
      && /ห้ามโอนเด็ดขาด/.test(remind.text) && /ไม่รับผิดชอบทุกกรณี/.test(remind.text), remind?.text);
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
    opts.body.events.length === 7 && opts.body.events.every((e) => e.enabled), opts.body.events);
  // บิลใหม่ + แจ้ง/เปลี่ยนบัญชีของบิล มีเลขบัญชีที่ร้านใช้ตรวจก่อนโอนทุกครั้ง — ร้านปิดเองไม่ได้
  check('เรื่องบิลใหม่ และแจ้ง/เปลี่ยนบัญชีของบิล ล็อกไว้ (ปิดไม่ได้)',
    ['bill.issued', 'bill.account'].every((k) => opts.body.events.find((e) => e.key === k)?.locked === true)
      && opts.body.events.filter((e) => e.locked).length === 2, opts.body.events);
  check('ส่วนกลางไม่มีตัวเลือกของร้าน (ตั้งที่หน้าตั้งค่าแจ้งเตือน)',
    (await api('GET', '/api/auth/telegram', { token: admin })).body.events.length === 0
      && (await api('PUT', '/api/auth/telegram/prefs', { token: admin, body: { events: { 'bill.issued': false } } })).status === 403);
  check('เรื่องที่ไม่มีจริงไม่รับ',
    (await api('PUT', '/api/auth/telegram/prefs', { token: stok, body: { events: { hack: false } } })).status === 400);
  const offed = await api('PUT', '/api/auth/telegram/prefs', {
    token: stok, body: { events: { 'bill.issued': false, 'bill.account': false, announcement: false } },
  });
  check('ปิดบางเรื่องได้ เรื่องอื่นยังเปิด',
    offed.status === 200 && offed.body.events.find((e) => e.key === 'announcement').enabled === false
      && offed.body.events.find((e) => e.key === 'payment.received').enabled === true, offed.body);
  check('ส่งค่าปิดเรื่องที่ล็อกมา ไม่ error แต่ยังเปิดอยู่ (บิลใหม่ · เลขบัญชีของบิล)',
    ['bill.issued', 'bill.account'].every((k) => offed.body.events?.find((e) => e.key === k)?.enabled === true), offed.body);

  await api('POST', '/api/sales-entries', { token: admin, body: { periodCode: '2026-08-H2', productId: prod.body.product.id, grossAmount: 20000 } });
  mark = telegram.messages.length;
  const bill2 = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: fid, periodCode: '2026-08-H2' } });
  const ann = await api('POST', '/api/announcements', { token: admin, body: { title: 'ทดสอบประกาศปิดไว้', body: 'ไม่ควรเข้าแชต' } });
  await flushTelegram();
  const gotAfterOff = telegram.messages.slice(mark).filter((m) => String(m.chat_id) === SHOP_CHAT);
  check('ปิด "ประกาศ" ไว้ → ไม่ได้ประกาศ · แต่บิลใหม่ (ล็อก) ยังส่งมาพร้อมเลขบัญชีและคำเตือน',
    bill2.status === 201 && ann.status === 201 && !gotAfterOff.some((m) => /ทดสอบประกาศปิดไว้/.test(m.text))
      && gotAfterOff.length === 1 && /บิลรอบใหม่/.test(gotAfterOff[0].text) && /ห้ามโอนเด็ดขาด/.test(gotAfterOff[0].text), gotAfterOff);

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

/* ── วิธีคิดยอดรายสินค้าในบิล ─────────────────────────────────
 * ตอนออกบิล แต่ละสินค้าเลือกได้ว่า "คิดตาม %" (แก้ % ได้) หรือ "กรอกยอดเอง"
 * ยอดรวม · ค่าใช้จ่ายแบบ % · ยอดสุทธิ ต้องคิดจากยอดที่ใช้จริงของแต่ละบรรทัด
 * ใช้ร้านของเทสต์นี้เอง (ร้าน A/B มียอดของเทสต์อื่นผูกอยู่)
 */
section('วิธีคิดยอดรายสินค้าในบิล (คิดตาม % / กรอกยอดเอง)');
{
  const ls = await api('POST', '/api/franchises', { token: admin, body: { username: 'lineshop', password: 'lineshop-pass-1' } });
  const lfid = ls.body.franchise?.id;
  const ltok = (await shopLogin('lineshop', 'lineshop-pass-1', lfid)).body.token;
  const mk = async (sku, pct) => (await api('POST', '/api/products', {
    token: admin, body: { sku, name: `สินค้าบรรทัด ${sku}`, commissionPct: pct, franchiseId: lfid, startDate: '2026-01-01' },
  })).body.product;
  const [l1, l2, l3] = [await mk('LINE-1', 10), await mk('LINE-2', 20), await mk('LINE-3', 5)];
  const entryOf = async (productId, grossAmount) => (await api('POST', '/api/sales-entries', {
    token: admin, body: { periodCode: '2029-04-H1', productId, grossAmount },
  })).body;
  const le1 = await entryOf(l1?.id, 10000);
  const le2 = await entryOf(l2?.id, 20000);
  const le3 = await entryOf(l3?.id, 4000);
  const gen = (extra) => api('POST', '/api/invoices/generate', {
    token: admin, body: { franchiseId: lfid, periodCode: '2029-04-H1', entryIds: [le1.id, le2.id], ...extra },
  });
  const lineOf = (body, id) => body?.lines?.find((l) => l.id === id);

  // ตรวจทุกบรรทัดก่อนเขียน — ผิดบรรทัดเดียวไม่มีบิลออกไป
  const invalid = [
    ['บรรทัดที่ไม่ได้เลือกออกบิล ส่งวิธีคิดมาไม่ได้', [{ entryId: le3.id, mode: 'PCT' }]],
    ['ส่งวิธีคิดของบรรทัดเดียวกันซ้ำไม่ได้', [{ entryId: le1.id, mode: 'PCT' }, { entryId: le1.id, mode: 'MANUAL', amount: 100 }]],
    ['"คิดตาม %" แต่ส่งจำนวนเงินมาด้วย ไม่รับ', [{ entryId: le1.id, mode: 'PCT', amount: 100 }]],
    // รุ่น 2.3.0: MANUAL ไม่ใส่จำนวนเงิน = ใช้ยอดส่วนต่างที่กรอกไว้ในหน้ายอดขาย — LINE-1 ไม่ได้กรอกไว้ จึงยังไม่รับ
    ['"กรอกยอดเอง" แต่ไม่ใส่จำนวนเงิน (และไม่ได้กรอกยอดส่วนต่างไว้ในหน้ายอดขาย) ไม่รับ', [{ entryId: le1.id, mode: 'MANUAL' }]],
    ['"กรอกยอดเอง" แต่ส่ง % มาด้วย ไม่รับ', [{ entryId: le1.id, mode: 'MANUAL', amount: 100, pct: 5 }]],
    ['กรอกยอดเกินยอดเงินเต็มไม่ได้', [{ entryId: le1.id, mode: 'MANUAL', amount: 10000.01 }]],
    ['กรอกยอดติดลบบนยอดขายปกติไม่ได้', [{ entryId: le1.id, mode: 'MANUAL', amount: -1 }]],
    ['ตัวเลขยาวผิดปกติ → บอกว่าเกินกำหนด (ไม่ใช่ระบบพัง)', [{ entryId: le1.id, mode: 'MANUAL', amount: 1e15 }]],
  ];
  for (const [label, lines] of invalid) {
    const r = await gen({ lines });
    check(label, r.status === 400, r.body);
  }
  check('ตรวจไม่ผ่านแล้วไม่มีบิลค้างอยู่ (ออกใหม่ได้)',
    (await api('GET', `/api/invoices?franchiseId=${lfid}`, { token: admin })).body.items?.length === 0);

  const inv = await gen({
    lines: [{ entryId: le1.id, mode: 'MANUAL', amount: 800 }, { entryId: le2.id, mode: 'PCT', pct: 12.5 }],
    adjustments: [{ kind: 'CHARGE', label: 'ค่าขนส่ง 10%', pct: 10 }],
  });
  // LINE-1 กรอกเอง 800 · LINE-2 20,000 × 12.5% = 2,500 → 3,300 · ค่าขนส่ง 10% = 330 → 3,630
  check('ออกบิลโดยเลือกวิธีคิดรายบรรทัด: กรอกเอง 800 + (20,000 × 12.5% = 2,500) = 3,300',
    inv.status === 201 && inv.body.commissionTotal === 3300
      && lineOf(inv.body, le1.id)?.billMode === 'MANUAL' && lineOf(inv.body, le1.id).commissionAmount === 800
      && lineOf(inv.body, le2.id)?.billMode === 'PCT' && lineOf(inv.body, le2.id).commissionPct === 12.5
      && lineOf(inv.body, le2.id).commissionAmount === 2500, inv.body);
  check('ค่าใช้จ่ายแบบ % คิดจากยอดที่ใช้จริง (10% ของ 3,300 = 330 · สุทธิ 3,630)',
    inv.body.chargeTotal === 330 && inv.body.netTotal === 3630, { charge: inv.body.chargeTotal, net: inv.body.netTotal });

  const toManual = await api('PATCH', `/api/invoices/${inv.body.id}/lines/${le2.id}`, { token: admin, body: { mode: 'MANUAL', amount: 1000 } });
  check('แก้วิธีคิดของบรรทัดในบิลที่ยังไม่มีเงินเข้าได้ — ยอดรวมและค่าใช้จ่าย % คิดใหม่ (1,800 · 180 · 1,980)',
    toManual.status === 200 && toManual.body.commissionTotal === 1800 && toManual.body.chargeTotal === 180
      && toManual.body.netTotal === 1980 && lineOf(toManual.body, le2.id)?.billMode === 'MANUAL', toManual.body);
  const toPct = await api('PATCH', `/api/invoices/${inv.body.id}/lines/${le2.id}`, { token: admin, body: { mode: 'PCT' } });
  check('กลับไปคิดตาม % ได้ (ไม่ส่ง % = ใช้ % เดิมของรายการ 12.5% → 2,500)',
    toPct.status === 200 && lineOf(toPct.body, le2.id)?.commissionAmount === 2500 && toPct.body.commissionTotal === 3300, toPct.body);
  check('แก้บรรทัดที่ไม่ได้อยู่ในบิลนี้ไม่ได้ (404)',
    (await api('PATCH', `/api/invoices/${inv.body.id}/lines/${le3.id}`, { token: admin, body: { mode: 'PCT' } })).status === 404);
  check('ร้านแก้วิธีคิดยอดเองไม่ได้',
    (await api('PATCH', `/api/invoices/${inv.body.id}/lines/${le2.id}`, { token: ltok, body: { mode: 'MANUAL', amount: 1 } })).status === 403);

  const added = await api('POST', `/api/invoices/${inv.body.id}/lines`, {
    token: admin, body: { entryIds: [le3.id], lines: [{ entryId: le3.id, mode: 'PCT', pct: 10 }] },
  });
  check('เติมรายการเข้าบิลพร้อมเลือกวิธีคิด (4,000 × 10% = 400 → 3,700 · ค่าขนส่ง 370)',
    added.status === 200 && lineOf(added.body, le3.id)?.commissionAmount === 400
      && added.body.commissionTotal === 3700 && added.body.chargeTotal === 370, added.body);
  const shopView = await api('GET', `/api/invoices/${inv.body.id}`, { token: ltok });
  check('ร้านเห็นว่าบรรทัดไหนทางเรากำหนดยอดเอง', lineOf(shopView.body, le1.id)?.billMode === 'MANUAL', shopView.body.lines);
  check('ประวัติบอกว่าแก้วิธีคิดยอดของบรรทัดไหน',
    db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'invoice.line.update' AND entity_id = ?").get(inv.body.id).n === 2);

  const lslip = await uploadSlip(ltok);
  const lsub = await api('POST', '/api/payments', { token: ltok, body: { invoiceId: inv.body.id, amount: 100, slipUrl: lslip } });
  check('มีสลิปรอตรวจอยู่ แก้วิธีคิดยอดไม่ได้',
    (await api('PATCH', `/api/invoices/${inv.body.id}/lines/${le1.id}`, { token: admin, body: { mode: 'PCT' } })).status === 409);
  await api('POST', `/api/payments/${lsub.body.id}/approve`, { token: admin, body: {} });
  check('เงินเข้าแล้ว แก้วิธีคิดยอดไม่ได้ (ต้องยกเลิกบิลแล้วออกใหม่)',
    (await api('PATCH', `/api/invoices/${inv.body.id}/lines/${le1.id}`, { token: admin, body: { mode: 'PCT' } })).status === 409);
}

/* ── รูปประกอบบิล ─────────────────────────────────────────────
 * ลิงก์รูปที่ระบบเซ็นให้เป็นกุญแจในตัว — ร้านได้ลิงก์เฉพาะรูปของบิลตัวเอง (ผ่าน GET บิลที่ตรวจสิทธิ์แล้ว)
 * ไฟล์ที่อัปโหลดไม่มีเจ้าของ จึงห้ามหยิบไฟล์ที่ผูกกับเรื่องอื่นอยู่แล้ว (สลิปของร้าน) มาแนบ
 */
section('รูปประกอบบิล (ร้านเห็นเฉพาะบิลของตัวเอง · สูงสุด 10 รูป)');
{
  const as = await api('POST', '/api/franchises', { token: admin, body: { username: 'attshop', password: 'attshop-pass-1' } });
  const afid = as.body.franchise?.id;
  const atok = (await shopLogin('attshop', 'attshop-pass-1', afid)).body.token;
  const prod = (await api('POST', '/api/products', {
    token: admin, body: { sku: 'ATT-1', name: 'สินค้ามีรูปประกอบ', commissionPct: 10, franchiseId: afid, startDate: '2026-01-01' },
  })).body.product;
  for (const periodCode of ['2029-05-H1', '2029-05-H2']) {
    await api('POST', '/api/sales-entries', { token: admin, body: { periodCode, productId: prod?.id, grossAmount: 10000 } });
  }
  const first = await uploadSlip();
  const bill = await api('POST', '/api/invoices/generate', {
    token: admin, body: { franchiseId: afid, periodCode: '2029-05-H1', attachments: [{ url: first, caption: 'ใบส่งของ' }] },
  });
  check('แนบรูปตอนออกบิลได้ พร้อมคำอธิบาย',
    bill.status === 201 && bill.body.attachments?.length === 1 && bill.body.attachments[0].caption === 'ใบส่งของ'
      && bill.body.attachments[0].type === 'image' && bill.body.attachmentCount === 1, bill.body.attachments);
  const more = await api('POST', `/api/invoices/${bill.body.id}/attachments`, { token: admin, body: { files: [{ url: await uploadSlip() }] } });
  check('แนบรูปเพิ่มทีหลังได้', more.status === 201 && more.body.attachments?.length === 2 && more.body.attachmentCount === 2, more.body);

  const asShop = await api('GET', `/api/invoices/${bill.body.id}`, { token: atok });
  const signed = asShop.body.attachments?.[0]?.url ?? '';
  check('ร้านเห็นรูปประกอบของบิลตัวเอง และเปิดด้วยลิงก์ที่ระบบเซ็นให้ได้',
    asShop.status === 200 && asShop.body.attachments?.length === 2 && (await fetch(`${base}${signed}`)).status === 200, asShop.body.attachments);
  check('ลิงก์รูปที่ไม่มีลายเซ็นเปิดไม่ได้', (await fetch(`${base}${fileOf(signed)}`)).status === 404);
  const otherShop = await api('GET', `/api/invoices/${bill.body.id}`, { token: tokenB });
  check('ร้านอื่นเปิดบิล (และรูปประกอบ) ของร้านนี้ไม่ได้',
    otherShop.status === 403 && !JSON.stringify(otherShop.body).includes(fileOf(first).split('/').pop()), otherShop.body);
  check('รายการบิลบอกจำนวนรูป (📎 N) โดยไม่ต้องโหลดรูป',
    (await api('GET', '/api/invoices', { token: atok })).body.items?.find((i) => i.id === bill.body.id)?.attachmentCount === 2);

  const shopFile = await uploadSlip(atok);
  check('ร้านแนบรูปเข้าบิลเองไม่ได้',
    (await api('POST', `/api/invoices/${bill.body.id}/attachments`, { token: atok, body: { files: [{ url: shopFile }] } })).status === 403);
  check('ร้านลบรูปประกอบเองไม่ได้',
    (await api('DELETE', `/api/invoices/${bill.body.id}/attachments/${bill.body.attachments?.[0]?.id}`, { token: atok })).status === 403);

  const attach = (files) => api('POST', `/api/invoices/${bill.body.id}/attachments`, { token: admin, body: { files } });
  check('ลิงก์ภายนอกแนบไม่ได้', (await attach([{ url: 'https://example.com/x.png' }])).status === 400);
  check('ชื่อไฟล์ที่ไม่มีอยู่จริงแนบไม่ได้', (await attach([{ url: `/api/uploads/${'0'.repeat(32)}.png` }])).status === 400);
  check('ไฟล์ที่เป็นสลิปแจ้งชำระอยู่แล้ว เอามาแนบบิลไม่ได้', (await attach([{ url: slip }])).status === 400);
  check('ไฟล์ที่แนบบิลไปแล้ว เอามาแนบซ้ำไม่ได้', (await attach([{ url: first }])).status === 400);
  const eight = [];
  for (let i = 0; i < 8; i++) eight.push({ url: await uploadSlip() });
  const ten = await attach(eight);
  const eleventh = await attach([{ url: await uploadSlip() }]);
  check('แนบได้สูงสุด 10 รูปต่อบิล (รูปที่ 11 ไม่รับ)',
    ten.status === 201 && ten.body.attachments?.length === 10 && eleventh.status === 400, { ten: ten.status, eleventh: eleventh.body });

  const removeFirst = () => api('DELETE', `/api/invoices/${bill.body.id}/attachments/${bill.body.attachments?.[0]?.id}`, { token: admin });
  const removed = await removeFirst();
  check('ลบรูปแล้วไม่แสดงในบิลอีก',
    removed.status === 200 && removed.body.attachments?.length === 9
      && !removed.body.attachments.some((a) => a.id === bill.body.attachments[0].id), removed.body.attachments?.length);
  check('ลบซ้ำ → ไม่พบ (404)', (await removeFirst()).status === 404);
  check('การลบรูปถูกจดประวัติ',
    db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'invoice.attachment.remove' AND entity_id = ?").get(bill.body.id).n === 1);

  const voidBill = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: afid, periodCode: '2029-05-H2' } });
  await api('POST', `/api/invoices/${voidBill.body.id}/void`, { token: admin, body: { reason: 'ทดสอบแนบรูปบิลยกเลิก' } });
  check('บิลที่ยกเลิกแล้วแนบรูปไม่ได้ (409)', (await api('POST', `/api/invoices/${voidBill.body.id}/attachments`, {
    token: admin, body: { files: [{ url: await uploadSlip() }] },
  })).status === 409);
}

/* ── เลขบัญชีในข้อความ Telegram ของร้าน + เปลี่ยนบัญชีของบิล ─────────
 * ข้อความ Telegram ที่ร้านได้คือหลักฐานนอกระบบที่ร้านใช้เทียบก่อนโอน — ทุกข้อความที่มีเลขบัญชีต้องมีคำเตือน
 * เปลี่ยนบัญชีของบิล: ต้องใส่รหัส 6 หลัก + แจ้งกลุ่มส่วนกลาง แต่ "ไม่" ส่งบัญชีใหม่ให้ร้านเอง
 * (ถ้าระบบส่งเอง คนที่ยึดบัญชีแอดมินได้จะใช้ระบบบอกร้านให้โอนเข้าบัญชีตัวเองได้ทันที) — คนตรวจแล้วกดส่งเอง
 */
section('เลขบัญชีในข้อความ Telegram ของร้าน · เปลี่ยนบัญชีของบิล · ยืนยันเลขบัญชีตอนแจ้งชำระ');
const acctShop = {}; // ร้านที่เชื่อม Telegram แล้ว — ใช้ต่อในหมวดกระเป๋า USD
{
  const ACCT_CHAT = '777000333';
  const as = await api('POST', '/api/franchises', { token: admin, body: { username: 'acctshop', password: 'acctshop-pass-1' } });
  const afid = as.body.franchise?.id;
  const stok = (await shopLogin('acctshop', 'acctshop-pass-1', afid)).body.token;
  const prod = (await api('POST', '/api/products', {
    token: admin, body: { sku: 'ACCT-1', name: 'สินค้าทดสอบบัญชี', commissionPct: 10, franchiseId: afid, startDate: '2026-01-01' },
  })).body.product;
  const accA = (await api('POST', '/api/bank-accounts', {
    token: admin, body: { bankName: 'ธนาคารบัญชีหนึ่ง', accountName: 'บจก. ตรวจบัญชี', accountNumber: '6060606060' },
  })).body;
  const accB = (await api('POST', '/api/bank-accounts', {
    token: admin, body: { bankName: 'ธนาคารบัญชีสอง', accountName: 'บจก. ตรวจบัญชี', accountNumber: '7070707070' },
  })).body;
  const issue = async (periodCode, gross, extra = {}) => {
    await api('POST', '/api/sales-entries', { token: admin, body: { periodCode, productId: prod?.id, grossAmount: gross } });
    return api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: afid, periodCode, bankAccountId: accA.id, ...extra } });
  };
  const shopMsgs = (from) => telegram.messages.slice(from).filter((m) => String(m.chat_id) === ACCT_CHAT);
  Object.assign(acctShop, { fid: afid, token: stok, productId: prod?.id, shopMsgs });

  // ร้านยังไม่เชื่อม Telegram = ยังไม่เคยได้เลขบัญชีทาง Telegram
  const b0 = await issue('2029-02-H2', 10000);
  check('ร้านยังไม่เคยได้เลขบัญชีทาง Telegram → ร้านเห็น NOT_SENT (ต้องยืนยันกับทางเราโดยตรง)',
    b0.status === 201 && b0.body.accountCheck === 'NOT_SENT' && b0.body.telegramAccount === null,
    { check: b0.body.accountCheck, tg: b0.body.telegramAccount });
  check('ร้านเชื่อม Telegram ของตัวเองได้ (ตั้งฉากเทสต์)', await linkTelegram(stok, ACCT_CHAT));

  await flushTelegram();
  let mark = telegram.messages.length;
  const b1 = await issue('2029-03-H1', 50000, { attachments: [{ url: await uploadSlip() }] });
  await flushTelegram();
  const issuedMsg = shopMsgs(mark).find((m) => /บิลรอบใหม่ออกแล้ว/.test(m.text));
  const issuedText = issuedMsg?.text ?? '';
  check('ออกบิล → ข้อความถึงร้านมีธนาคาร เลขที่บัญชี และชื่อบัญชีของบิล',
    issuedText.includes('ธนาคารบัญชีหนึ่ง') && issuedText.includes('<code>6060606060</code>') && issuedText.includes('บจก. ตรวจบัญชี'), issuedText);
  check('…พร้อมคำเตือน: ตรวจก่อนโอน · ไม่ตรงห้ามโอน · โอนผิดบัญชีทางเราไม่รับผิดชอบทุกกรณี',
    /ก่อนโอนทุกครั้ง/.test(issuedText) && /ห้ามโอนเด็ดขาด/.test(issuedText) && /ไม่รับผิดชอบทุกกรณี/.test(issuedText) && /สแกน QR/.test(issuedText), issuedText);
  check('…และบอกว่ามีรูปประกอบบิล', /📎 มีรูปประกอบ 1 รูป/.test(issuedText), issuedText);
  check('ส่งเลขบัญชีแล้ว: ร้านเห็น MATCH · ส่วนกลางเห็นว่าแจ้งบัญชีไหนไป',
    b1.body.accountCheck === 'MATCH' && b1.body.telegramAccount?.matches === true && b1.body.telegramAccount.account?.accountNumber === '6060606060',
    { check: b1.body.accountCheck, tg: b1.body.telegramAccount });
  const b1Shop = await api('GET', `/api/invoices/${b1.body.id}`, { token: stok });
  check('ร้านได้แค่ผลตรวจ (MATCH) ไม่ได้รายละเอียดที่ส่วนกลางเห็น',
    b1Shop.body.accountCheck === 'MATCH' && !('telegramAccount' in b1Shop.body), Object.keys(b1Shop.body));

  // ── เปลี่ยนบัญชีของบิล ──
  const noCode = await api('PATCH', `/api/invoices/${b1.body.id}`, { token: admin, elevate: false, body: { bankAccountId: accB.id } });
  check('เปลี่ยนบัญชีของบิลโดยไม่ใส่รหัส 6 หลักไม่ได้', noCode.status === 403 && noCode.body.error?.code === 'ELEVATION_REQUIRED', noCode.body);
  check('แก้แค่วันครบกำหนดไม่ต้องใส่รหัส 6 หลัก',
    (await api('PATCH', `/api/invoices/${b1.body.id}`, { token: admin, elevate: false, body: { dueDate: '2029-03-31' } })).status === 200);
  const unreadBefore = (await api('GET', '/api/bank-accounts/changes/unread', { token: admin })).body.count;
  mark = telegram.messages.length;
  const moved = await api('PATCH', `/api/invoices/${b1.body.id}`, { token: admin, body: { bankAccountId: accB.id } });
  check('ใส่รหัสแล้วเปลี่ยนบัญชีของบิลได้ → บัญชีไม่ตรงกับที่แจ้งร้านไว้ (CHANGED)',
    moved.status === 200 && moved.body.bankAccount?.id === accB.id && moved.body.accountCheck === 'CHANGED'
      && moved.body.telegramAccount?.matches === false, moved.body);
  await flushTelegram();
  const alert = telegram.messages.slice(mark).find((m) => /เปลี่ยนบัญชีรับเงินของบิล/.test(m.text));
  check('กลุ่มส่วนกลางได้แจ้งทันที: บิล · จากบัญชีเดิม → บัญชีใหม่ · ใครเปลี่ยน',
    alert?.chat_id === TG_CHAT && alert.text.includes(b1.body.invoiceNo) && alert.text.includes('6060606060')
      && alert.text.includes('7070707070') && /superadmin/.test(alert.text), alert?.text);
  check('ระบบไม่ส่งบัญชีใหม่ให้ร้านเอง (ต้องให้คนตรวจแล้วกดส่ง)', shopMsgs(mark).length === 0, shopMsgs(mark));
  const unread = (await api('GET', '/api/bank-accounts/changes/unread', { token: admin })).body;
  check('ขึ้นแถบเตือนการแก้บัญชีของแอดมิน (บัญชีของบิล: เดิม → ใหม่)',
    unread.count === unreadBefore + 1
      && unread.items?.[0]?.changes?.some((c) => c.field === 'invoiceAccount' && /6060606060/.test(c.from) && /7070707070/.test(c.to)),
    unread.items?.[0]);
  const notifyCfg = (await api('GET', '/api/settings/notifications', { token: admin })).body;
  check('แจ้งเตือน "เปลี่ยนบัญชีรับเงินของบิล" ปิดไม่ได้',
    notifyCfg.events?.find((e) => e.key === 'invoice.bank_account')?.locked === true, notifyCfg.events?.map((e) => e.key));
  check('ร้านเห็นว่าบัญชีของบิลไม่ตรงกับที่แจ้งทาง Telegram (CHANGED)',
    (await api('GET', `/api/invoices/${b1.body.id}`, { token: stok })).body.accountCheck === 'CHANGED');

  // ── ร้านยืนยันเลขบัญชีตอนแจ้งชำระ (หลักฐานเวลามีข้อโต้แย้งเรื่องโอนผิดบัญชี) ──
  const shopSlip = await uploadSlip(stok);
  const pay = (body, token = stok) => api('POST', '/api/payments', {
    token, body: { invoiceId: b1.body.id, amount: 100, slipUrl: shopSlip, ...body },
  });
  const stale = await pay({ accountConfirmed: true, bankAccountId: accA.id });
  check('ร้านยืนยันเลขบัญชีเดิมทั้งที่บิลเพิ่งเปลี่ยนบัญชี → 409 ให้ตรวจกับ Telegram อีกครั้ง', stale.status === 409, stale.body);
  check('ยืนยันเลขบัญชีแต่ไม่บอกว่าหน้าจอแสดงบัญชีไหน → 400', (await pay({ accountConfirmed: true })).status === 400);

  // ── ส่วนกลางตรวจแล้วกดส่งเลขบัญชีให้ร้าน ──
  check('ส่งเลขบัญชีให้ร้านโดยไม่ใส่รหัส 6 หลักไม่ได้',
    (await api('POST', `/api/invoices/${b1.body.id}/notify-account`, { token: admin, elevate: false })).status === 403);
  check('ร้านสั่งส่งเลขบัญชีเองไม่ได้', (await api('POST', `/api/invoices/${b1.body.id}/notify-account`, { token: stok })).status === 403);
  mark = telegram.messages.length;
  const sent = await api('POST', `/api/invoices/${b1.body.id}/notify-account`, { token: admin });
  await flushTelegram();
  const newAcctText = shopMsgs(mark)[0]?.text ?? '';
  check('กดส่งเลขบัญชี → ร้านได้ข้อความ "ทางเราเปลี่ยนบัญชีรับเงินของบิล" พร้อมบัญชีใหม่และคำเตือน',
    sent.status === 200 && sent.body.sent === 1 && sent.body.changed === true
      && /ทางเราเปลี่ยนบัญชีรับเงินของบิล/.test(newAcctText) && newAcctText.includes('7070707070') && /ห้ามโอนเด็ดขาด/.test(newAcctText),
    { body: sent.body, text: newAcctText });
  check('ส่งแล้วบิลกลับมาตรงกับที่แจ้งร้าน (MATCH)',
    sent.body.invoice?.accountCheck === 'MATCH' && sent.body.invoice.telegramAccount?.matches === true, sent.body.invoice?.telegramAccount);
  check('ส่งบัญชีใหม่ให้ร้าน → กลุ่มส่วนกลางรู้ด้วย (จาก → เป็น)',
    telegram.messages.slice(mark).some((m) => m.chat_id === TG_CHAT && /ส่งเลขบัญชีใหม่ให้ร้านแล้ว/.test(m.text)
      && m.text.includes('6060606060') && m.text.includes('7070707070')), telegram.messages.slice(mark).map((m) => m.text));

  const confirmed = await pay({ accountConfirmed: true, bankAccountId: accB.id });
  check('ร้านติ๊กยืนยันเลขบัญชีแล้วแจ้งชำระได้ → เก็บเวลาที่ยืนยัน + บัญชีที่บิลชี้ตอนแจ้ง',
    confirmed.status === 201 && Boolean(confirmed.body.accountConfirmedAt) && /7070707070/.test(confirmed.body.bankAccountLabel ?? ''), confirmed.body);
  const snap = db.prepare('SELECT bank_snapshot FROM payment_submissions WHERE id = ?').get(confirmed.body.id);
  check('หลักฐานเก็บ "ค่า" ของบัญชี ณ ตอนแจ้ง ไม่ใช่แค่ id (บัญชีแก้ทีหลังได้)',
    JSON.parse(snap?.bank_snapshot ?? '{}').accountNumber === '7070707070', snap);
  const bySuper = await pay({ accountConfirmed: true, bankAccountId: accB.id, slipUrl: await uploadSlip() }, admin);
  check('ส่วนกลางแจ้งแทนร้าน ติ๊กยืนยันมาก็ไม่นับเป็น "ร้านยืนยันแล้ว"',
    bySuper.status === 201 && bySuper.body.accountConfirmedAt === null, bySuper.body);
  const review = (await api('GET', '/api/payments?status=PENDING', { token: admin })).body.items?.find((x) => x.id === confirmed.body.id);
  check('หน้าตรวจสลิปของส่วนกลางเห็นว่าร้านยืนยันบัญชีไหนไว้',
    Boolean(review?.accountConfirmedAt) && /7070707070/.test(review?.bankAccountLabel ?? ''), review);

  // ── เตือนร้านซ้ำใช้บัญชีที่เคยแจ้งไว้ (snapshot) ไม่ "รับรอง" เลขที่ถูกแก้ในฐานข้อมูล ──
  const b2 = await issue('2029-03-H2', 30000, { bankAccountId: accB.id });
  check('ตั้งฉาก: บิลที่สองแจ้งบัญชีสองให้ร้านแล้ว', b2.status === 201 && b2.body.accountCheck === 'MATCH', b2.body.accountCheck);
  mark = telegram.messages.length;
  const edited = await api('PATCH', `/api/bank-accounts/${accB.id}`, { token: admin, body: { accountNumber: '7171717171' } });
  await flushTelegram();
  const editAlert = telegram.messages.slice(mark).find((m) => m.chat_id === TG_CHAT && /7171717171/.test(m.text));
  check('แก้เลขบัญชีที่มีบิลค้าง → กลุ่มได้รายชื่อบิลที่ได้รับผลกระทบ และคำแนะนำให้กดส่งเลขบัญชีให้ร้าน',
    edited.status === 200 && Boolean(editAlert) && editAlert.text.includes(b1.body.invoiceNo) && editAlert.text.includes(b2.body.invoiceNo)
      && /ส่งเลขบัญชีให้ร้าน/.test(editAlert.text), editAlert?.text);
  check('แก้เลขบัญชีแล้วระบบไม่ส่งเลขใหม่ให้ร้านเอง', shopMsgs(mark).length === 0, shopMsgs(mark));
  check('ร้านเห็นว่าไม่ตรงกับ Telegram ทันที (CHANGED)',
    (await api('GET', `/api/invoices/${b2.body.id}`, { token: stok })).body.accountCheck === 'CHANGED');
  const tomorrowTh = new Date(Date.parse(todayTh) + 86400000).toISOString().slice(0, 10);
  db.prepare('UPDATE invoices SET due_date = ?, reminded_at = NULL WHERE id = ?').run(tomorrowTh, b2.body.id);
  mark = telegram.messages.length;
  await runDueReminders(new Date(`${todayTh}T10:00:00Z`));
  await flushTelegram();
  const remindText = shopMsgs(mark).find((m) => m.text.includes(b2.body.invoiceNo))?.text ?? '';
  check('เตือนก่อนครบกำหนดบอกบัญชีที่เคยแจ้งร้าน (ไม่ใช่เลขที่ถูกแก้) + บอกให้ติดต่อทางเราก่อนโอน',
    /แจ้งเตือนล่วงหน้า/.test(remindText) && remindText.includes('7070707070') && !remindText.includes('7171717171')
      && /ไม่ตรงกับที่เคยแจ้งทาง Telegram/.test(remindText), remindText);

  const listed = (await api('GET', '/api/bank-accounts', { token: admin })).body.items?.find((a) => a.id === accB.id);
  check('บัญชีบอกจำนวนบิลค้างที่ชี้บัญชีนี้ (ใช้กับปุ่มส่งเลขบัญชีให้ร้าน)', listed?.openInvoiceCount === 2, listed);
  check('ส่งเลขบัญชีให้ร้านที่มีบิลค้างโดยไม่ใส่รหัส 6 หลักไม่ได้',
    (await api('POST', `/api/bank-accounts/${accB.id}/notify-shops`, { token: admin, elevate: false })).status === 403);
  mark = telegram.messages.length;
  const ns = await api('POST', `/api/bank-accounts/${accB.id}/notify-shops`, { token: admin });
  await flushTelegram();
  check('ส่งเลขบัญชีใหม่ให้ทุกบิลค้างที่ชี้บัญชีนี้ในครั้งเดียว (2 บิล)',
    ns.status === 200 && ns.body.invoices === 2 && ns.body.sent === 2
      && shopMsgs(mark).filter((m) => m.text.includes('7171717171')).length === 2, ns.body);
  // หน้าเว็บนับ "ส่งถึงร้านแล้วกี่บิล" จาก notified และบอกชื่อบิลที่ไม่ได้ส่งจาก items[].sent === 0
  check('ผลการส่งบอกว่าบิลไหนถึงร้านจริง (notified + items รายบิล)',
    ns.body.notified === 2 && ns.body.items?.length === 2 && ns.body.items.every((i) => i.sent > 0 && typeof i.invoiceNo === 'string'), ns.body);
  check('ส่งแล้วบิลกลับมาตรงกับ Telegram (MATCH)',
    (await api('GET', `/api/invoices/${b2.body.id}`, { token: stok })).body.accountCheck === 'MATCH');

  await api('POST', `/api/invoices/${b0.body.id}/void`, { token: admin, body: { reason: 'ทดสอบส่งเลขบัญชีบิลยกเลิก' } });
  check('บิลที่ยกเลิกแล้ว ส่งเลขบัญชีให้ร้านไม่ได้ (409)',
    (await api('POST', `/api/invoices/${b0.body.id}/notify-account`, { token: admin })).status === 409);
}

/* ── บัญชีรับเงิน USD = กระเป๋าคริปโต ─────────────────────────
 * รับดอลลาร์ผ่านกระเป๋า: กรอกแค่เครือข่าย (chain) + ที่อยู่กระเป๋า + QR — ไม่มีธนาคาร/ชื่อบัญชี
 * โอนผิดเครือข่าย = เงินหายถาวร ข้อความถึงร้านต้องบอกเครือข่ายติดกับที่อยู่เสมอ
 */
section('บัญชีรับเงิน USD = กระเป๋าคริปโต (เครือข่าย + ที่อยู่กระเป๋า)');
{
  const addr = 'TSmokeWallet0000000000000003';
  const mk = (body) => api('POST', '/api/bank-accounts', { token: admin, body });
  const noChain = await mk({ currency: 'USD', accountNumber: addr });
  check('บัญชี USD ต้องระบุเครือข่าย (chain)', noChain.status === 400 && /ต้องระบุเครือข่าย \(chain\)/.test(noChain.body.error?.message ?? ''), noChain.body);
  const spaced = await mk({ currency: 'USD', chain: 'TRC20', accountNumber: 'TSmoke Wallet 00000003' });
  check('ที่อยู่กระเป๋ามีช่องว่างไม่รับ (ต้องคัดลอกมาทั้งชุด)', spaced.status === 400 && /ที่อยู่กระเป๋า/.test(spaced.body.error?.message ?? ''), spaced.body);
  check('ที่อยู่กระเป๋าสั้นผิดปกติไม่รับ', (await mk({ currency: 'USD', chain: 'TRC20', accountNumber: 'short' })).status === 400);
  check('ชื่อเครือข่ายแปลก ๆ ไม่รับ', (await mk({ currency: 'USD', chain: '!bad', accountNumber: addr })).status === 400);
  const wallet = await mk({ currency: 'USD', chain: 'TRC20', accountNumber: `  ${addr} `, bankName: 'ไม่ใช้', accountName: 'ไม่ใช้' });
  check('เพิ่มกระเป๋า USD ได้: เก็บเครือข่าย + ที่อยู่ (ตัดช่องว่างหัวท้าย) · ไม่ใช้ชื่อธนาคาร/ชื่อบัญชี',
    wallet.status === 201 && wallet.body.isWallet === true && wallet.body.chain === 'TRC20' && wallet.body.accountNumber === addr
      && wallet.body.bankName === 'TRC20' && wallet.body.accountName === '', wallet.body);
  check('ป้ายของกระเป๋า = "USD · เครือข่าย · ที่อยู่"', wallet.body.label === `USD · TRC20 · ${addr}`, wallet.body.label);
  const longAddr = `0x${'ab'.repeat(40)}`;
  check('ที่อยู่กระเป๋ายาว 82 ตัวอักษรใส่ได้', (await mk({ currency: 'USD', chain: 'ERC20', accountNumber: longAddr })).body.accountNumber === longAddr);
  const thb = await mk({ bankName: 'ธนาคารบาท', accountName: 'บจก. บาท', accountNumber: '8181818181' });
  check('บัญชีบาทเหมือนเดิม (ไม่มีเครือข่าย · ป้าย "ธนาคาร · เลข (ชื่อ)")',
    thb.status === 201 && thb.body.chain === null && thb.body.isWallet === false && thb.body.label === 'ธนาคารบาท · 8181818181 (บจก. บาท)', thb.body);

  const chainNoCode = await api('PATCH', `/api/bank-accounts/${wallet.body.id}`, { token: admin, elevate: false, body: { chain: 'BEP20' } });
  check('เปลี่ยนเครือข่ายของกระเป๋าต้องใส่รหัส 6 หลัก (เปลี่ยนปลายทางเงิน)',
    chainNoCode.status === 403 && chainNoCode.body.error?.code === 'ELEVATION_REQUIRED', chainNoCode.body);
  const chainOk = await api('PATCH', `/api/bank-accounts/${wallet.body.id}`, { token: admin, body: { chain: 'TRON (TRC20)' } });
  check('ใส่รหัสแล้วเปลี่ยนเครือข่ายได้ ป้ายเปลี่ยนตาม', chainOk.status === 200 && chainOk.body.label === `USD · TRON (TRC20) · ${addr}`, chainOk.body);
  const lastChange = (await api('GET', '/api/bank-accounts/changes/unread', { token: admin })).body.items?.[0];
  check('แจ้งเตือนการแก้บอกว่าเปลี่ยน "เครือข่าย (chain)"', JSON.stringify(lastChange ?? {}).includes('เครือข่าย (chain)'), lastChange);
  await api('PATCH', `/api/bank-accounts/${wallet.body.id}`, { token: admin, body: { chain: 'TRC20' } });

  // บิลดอลลาร์ของร้านที่เชื่อม Telegram → ข้อความบอกเครือข่าย + ที่อยู่กระเป๋า (36,250 × 10% = 3,625 บาท = 100 USD)
  await api('POST', '/api/periods/2029-04-H2/usd-rate', { token: admin, body: { usdRate: 36.25 } });
  await api('POST', '/api/sales-entries', { token: admin, body: { periodCode: '2029-04-H2', productId: acctShop.productId, grossAmount: 36250 } });
  await flushTelegram();
  const mark = telegram.messages.length;
  const usdBill = await api('POST', '/api/invoices/generate', {
    token: admin, body: { franchiseId: acctShop.fid, periodCode: '2029-04-H2', currency: 'USD', bankAccountId: wallet.body.id },
  });
  await flushTelegram();
  check('บิลดอลลาร์ผูกกระเป๋าได้ — บิลบอกเครือข่ายและป้ายของกระเป๋า',
    usdBill.status === 201 && usdBill.body.bankAccount?.isWallet === true && usdBill.body.bankAccount.chain === 'TRC20'
      && usdBill.body.bankAccount.label === `USD · TRC20 · ${addr}`, usdBill.body.bankAccount ?? usdBill.body);
  const walletText = acctShop.shopMsgs?.(mark).find((m) => m.text.includes(usdBill.body.invoiceNo ?? '-'))?.text ?? '';
  check('ข้อความถึงร้าน: เครือข่าย · ที่อยู่กระเป๋าใน <code> · เตือนโอนผิดเครือข่ายเงินหาย · ไม่รับผิดชอบ',
    walletText.includes('💵 <b>บัญชีรับเงิน USD</b>') && walletText.includes('เครือข่าย (Chain): <b>TRC20</b>')
      && walletText.includes(`ที่อยู่กระเป๋า: <code>${addr}</code>`) && /โอนผิดเครือข่าย \(chain\)/.test(walletText)
      && /ไม่รับผิดชอบทุกกรณี/.test(walletText), walletText);
  check('ยอดในข้อความเป็นดอลลาร์ที่ต้องโอนจริง (≈ ยอดบาท)', /100\.00 USD \(≈ 3,625\.00 บาท\)/.test(walletText), walletText);
  const shopUsd = await api('GET', `/api/invoices/${usdBill.body.id}`, { token: acctShop.token });
  check('ร้านเห็นกระเป๋าของบิล และตรงกับที่แจ้งทาง Telegram (MATCH)',
    shopUsd.body.bankAccount?.isWallet === true && shopUsd.body.accountCheck === 'MATCH', { bank: shopUsd.body.bankAccount, check: shopUsd.body.accountCheck });
  check('กระเป๋าที่ผูกบิลแล้วเปลี่ยนเป็นบัญชีบาทไม่ได้ (409)',
    (await api('PATCH', `/api/bank-accounts/${wallet.body.id}`, { token: admin, body: { currency: 'THB' } })).status === 409);
}

/* ── ลบสินค้า / ปิดใช้งาน / เปิดใช้งาน ─────────────────────────────
 * R5 (29 ก.ย.) "สินค้าลบไม่ได้" → เจ้าของระบบกลับคำ 30 ก.ย. (R19): ลบได้ถาวร (ส่วนกลางเท่านั้น) · "ปิดใช้งาน" ยังอยู่สำหรับหยุดขายชั่วคราว
 * ลบ = ลองลบจริง (HARD) ก่อน ติด FK = มีบิล/ประวัติอ้างถึง → ซ่อนถาวร (SOFT) บิลเก่ายังแสดงสินค้าเดิมครบ
 * ห้ามลบเมื่อยังมียอดที่ยังไม่ออกบิล (เงินที่ยังไม่ได้เรียกเก็บจะหายจากสายตา) หรือเป็นสินค้าย่อยชิ้นสุดท้ายของกลุ่ม
 * ใช้ร้าน/สินค้า/เซลของหมวดนี้เอง (ห้ามปิด/ลบสินค้าของร้าน A/B — หมวดออกบิลหลายร้านหยิบสินค้าตัวแรกของร้าน)
 */
section('ลบสินค้า / ปิดใช้งาน / เปิดใช้งาน');
{
  const errOf = (r) => r.body?.error?.message ?? '';
  const skus = (arr) => (arr ?? []).map((x) => x.sku).join(',');
  const rs = await api('POST', '/api/franchises', { token: admin, body: { username: 'r5shop', password: 'r5shop-pass-1' } });
  const rfid = rs.body.franchise?.id;
  const rtok = (await shopLogin('r5shop', 'r5shop-pass-1', rfid)).body.token;
  // ผู้ช่วยที่มีสิทธิ์ดูสินค้า — ต้องโดนกันเพราะ "ส่วนกลางเท่านั้น" ไม่ใช่เพราะไม่มีสิทธิ์ดูสินค้า
  await api('POST', `/api/franchises/${rfid}/users`, { token: rtok, body: { username: 'r5shop-staff', password: 'r5staff-pass-1', permissions: ['products'] } });
  const stok = (await shopLogin('r5shop-staff', 'r5staff-pass-1', rfid)).body.token;
  const r5sale = (await api('POST', '/api/sales-agents', { token: admin, body: { username: 'r5sale', password: 'r5sale-pass-1', name: 'เซลหมวดลบสินค้า' } })).body.agent;
  const saletok = (await api('POST', '/api/auth/login', { body: { username: 'r5sale', password: 'r5sale-pass-1' } })).body.token;
  const mk = (sku, extra = {}) => api('POST', '/api/products', { token: admin, body: { sku, name: `สินค้า ${sku}`, commissionPct: 10, ...extra } });
  const only = (await mk('R5-ONLY', { name: 'สินค้าชิ้นเดียวของร้าน', franchiseId: rfid, startDate: '2026-01-01' })).body.product;
  const kept = await api('POST', '/api/sales-entries', { token: admin, body: { periodCode: '2029-06-H2', productId: only?.id, grossAmount: 10000 } });

  // ── ปิดใช้งาน / เปิดใช้งาน = หยุดขายชั่วคราว (ของเดิม R5 ยังอยู่ครบ) ──
  const readyOf = async (periodCode) => (await api('GET', `/api/invoices/readiness?periodCode=${periodCode}`, { token: admin }))
    .body.items?.find((r) => r.franchiseId === rfid);
  check('ตั้งฉาก: ร้านที่มีสินค้าแต่ยังไม่กรอกยอด = "ยังไม่กรอกยอด"', (await readyOf('2029-06-H1'))?.status === 'NO_SALES');
  check('ร้านค้าปิดใช้งานสินค้าเองไม่ได้',
    (await api('PATCH', `/api/products/${only?.id}`, { token: rtok, body: { status: 'ARCHIVED' } })).status === 403);
  const archived = await api('PATCH', `/api/products/${only?.id}`, { token: admin, body: { status: 'ARCHIVED' } });
  check('ปิดใช้งานสินค้าได้', archived.status === 200 && archived.body.status === 'ARCHIVED', archived.body);
  check('ปิดใช้งานถูกจดประวัติแยก (ปิดใช้งานสินค้า)',
    db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'product.archive' AND entity_id = ?").get(only?.id).n === 1);
  check('ร้านที่เหลือแต่สินค้าที่ปิดใช้งาน ไม่ค้างเป็น "ยังไม่กรอกยอด"', (await readyOf('2029-06-H1'))?.status !== 'NO_SALES');
  const blocked = await api('POST', '/api/sales-entries', { token: admin, body: { periodCode: '2029-06-H1', productId: only?.id, grossAmount: 5000 } });
  check('สินค้าที่ปิดใช้งาน บันทึกยอดใหม่ไม่ได้ (บอกให้เปิดใช้งานก่อน)',
    blocked.status === 400 && /ปิดใช้งาน/.test(blocked.body.error?.message ?? ''), blocked.body);
  check('สินค้าที่ปิดใช้งาน ผูกดีลเซลใหม่ไม่ได้', (await api('POST', '/api/sales-agents/links', {
    token: admin, body: { salesAgentId: r5sale?.id, items: [{ productId: only?.id, commissionPct: 1 }] },
  })).status === 400);
  const oldBill = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: rfid, periodCode: '2029-06-H2' } });
  check('ยอดที่บันทึกไว้ก่อนปิดใช้งาน ยังออกบิลได้', kept.status === 201 && oldBill.status === 201 && oldBill.body.lines?.length === 1, oldBill.body);
  const active = await api('PATCH', `/api/products/${only?.id}`, { token: admin, body: { status: 'ACTIVE' } });
  const again = await api('POST', '/api/sales-entries', { token: admin, body: { periodCode: '2029-06-H1', productId: only?.id, grossAmount: 5000 } });
  check('เปิดใช้งานอีกครั้งได้ และบันทึกยอดได้ตามเดิม', active.body.status === 'ACTIVE' && again.status === 201, again.body);
  check('เปิดใช้งานถูกจดประวัติ',
    db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'product.activate' AND entity_id = ?").get(only?.id).n === 1);

  // ── ลบ = ส่วนกลางเท่านั้น ──
  const denied = [];
  for (const tok of [rtok, stok, saletok]) denied.push((await api('DELETE', `/api/products/${only?.id}`, { token: tok })).status);
  check('ร้านค้า / ผู้ช่วยร้าน (มีสิทธิ์ดูสินค้า) / เซล ลบสินค้าไม่ได้ (403) และสินค้ายังอยู่',
    denied.every((s) => s === 403) && (await api('GET', `/api/products/${only?.id}`, { token: admin })).body?.status === 'ACTIVE', denied);
  const viaPatch = await api('PATCH', `/api/products/${only?.id}`, { token: admin, body: { status: 'DELETED' } });
  check('ตั้งสถานะ "ลบแล้ว" ผ่านการแก้ไขไม่ได้ (400) — ลบต้องผ่านปุ่มลบที่มีด่านตรวจ', viaPatch.status === 400, viaPatch.body);

  // ── ยอดที่ยังไม่ออกบิล = ห้ามลบ ──
  const unbilled = await api('DELETE', `/api/products/${only?.id}`, { token: admin });
  check('มียอดขายที่ยังไม่ออกบิล → ลบไม่ได้ (409 บอกจำนวนและทางไปต่อ) สินค้ายังใช้งานได้ตามเดิม',
    unbilled.status === 409
      && errOf(unbilled) === 'สินค้า R5-ONLY มียอดขายที่ยังไม่ออกบิล 1 รายการ — ออกบิลหรือลบยอดนั้นที่หน้า "ยอดขายรายรอบ" ก่อน'
      && (await api('GET', `/api/products/${only?.id}`, { token: admin })).body?.status === 'ACTIVE', unbilled.body);

  // ── ไม่เคยมียอดขาย → ลบทิ้งจริง (HARD) ──
  const fresh = (await mk('R19-FRESH', { franchiseId: rfid, startDate: '2026-01-01' })).body.product;
  const freshDeal = await api('POST', '/api/sales-agents/links', { token: admin, body: { salesAgentId: r5sale?.id, items: [{ productId: fresh?.id, commissionPct: 2 }] } });
  const hard = await api('DELETE', `/api/products/${fresh?.id}`, { token: admin });
  check('สินค้าที่ไม่เคยมียอดขาย (มีแค่สัญญาร้าน + ดีลเซล) → ลบทิ้งจริง (HARD)',
    freshDeal.status === 201 && hard.status === 200 && hard.body.deleted === true && hard.body.id === fresh?.id
      && hard.body.sku === 'R19-FRESH' && hard.body.mode === 'HARD', hard.body);
  const freshLeft = db.prepare(`SELECT
      (SELECT COUNT(*) FROM products WHERE id = ?) AS products,
      (SELECT COUNT(*) FROM product_assignments WHERE product_id = ?) AS assignments,
      (SELECT COUNT(*) FROM product_sales_links WHERE product_id = ?) AS deals`).get(fresh?.id, fresh?.id, fresh?.id);
  check('ลบจริงแล้วเปิดดูได้ 404 · สัญญามอบหมายและดีลเซลของสินค้านี้หายไปด้วย',
    (await api('GET', `/api/products/${fresh?.id}`, { token: admin })).status === 404
      && freshLeft.products === 0 && freshLeft.assignments === 0 && freshLeft.deals === 0, freshLeft);
  const reused = await mk('r19-fresh');
  check('ลบจริงแล้วรหัสสินค้า (SKU) ว่าง ใช้สร้างสินค้าใหม่ได้', reused.status === 201, reused.body);
  await api('PATCH', `/api/products/${reused.body.product?.id}`, { token: admin, body: { status: 'ARCHIVED' } });
  const archivedDel = await api('DELETE', `/api/products/${reused.body.product?.id}`, { token: admin });
  check('สินค้าที่ปิดใช้งานอยู่ก็ลบได้', archivedDel.status === 200 && archivedDel.body.mode === 'HARD', archivedDel.body);

  // ── มีบิลแล้ว → ซ่อนถาวร (SOFT) ──
  // เอายอดที่ยังไม่ออกบิลออกตามที่ข้อความบอก + ผูกดีลที่เริ่มในอนาคต (ตอนลบต้องปิดได้โดยไม่ติด "วันจบ ≥ วันเริ่ม")
  await api('DELETE', `/api/sales-entries/${again.body.id}`, { token: admin });
  const future = new Date(Date.parse(todayTh) + 10 * 86400000).toISOString().slice(0, 10);
  const deal = (await api('POST', '/api/sales-agents/links', {
    token: admin, body: { salesAgentId: r5sale?.id, startDate: future, items: [{ productId: only?.id, commissionPct: 3 }] },
  })).body.items?.[0];
  check('ตั้งฉาก: สินค้ามีบิลเก่า + สัญญาร้านที่เปิดอยู่ + ดีลเซลที่เริ่มในอนาคต', deal?.startDate === future && deal.endDate === null, deal);
  const soft = await api('DELETE', `/api/products/${only?.id}`, { token: admin });
  check('สินค้าที่มีบิลแล้ว → ลบแบบซ่อน (SOFT)',
    soft.status === 200 && soft.body.deleted === true && soft.body.id === only?.id && soft.body.sku === 'R5-ONLY' && soft.body.mode === 'SOFT', soft.body);
  const softRow = db.prepare('SELECT status, deleted_at, deleted_by_user_id FROM products WHERE id = ?').get(only?.id);
  check('แถวสินค้ายังอยู่ (บิลเก่าอ้างถึง) · สถานะ DELETED + เวลาที่ลบ + คนลบ',
    softRow?.status === 'DELETED' && Boolean(softRow.deleted_at) && softRow.deleted_by_user_id === adminId, softRow);
  const leaked = [];
  for (const q of ['', '?status=', '?status=ACTIVE', '?status=ARCHIVED', '?unassignedOnly=true', `?franchiseId=${rfid}`, '?q=R5-ONLY', '?isGroup=0']) {
    const l = await api('GET', `/api/products${q}`, { token: admin });
    if (l.status !== 200 || l.body.items.some((p) => p.id === only?.id)) leaked.push(q || '(ไม่กรอง)');
  }
  if ((await api('GET', '/api/products', { token: rtok })).body.items?.some((p) => p.id === only?.id)) leaked.push('หน้าร้าน');
  check('หายจากรายการสินค้าทุกแท็บ / ทุกตัวกรอง / ตัวเลือกสินค้าว่าง และหน้าร้าน', leaked.length === 0, leaked);
  check('เปิดดูสินค้าที่ลบแล้วได้ 404 (ส่วนกลางและร้าน)',
    (await api('GET', `/api/products/${only?.id}`, { token: admin })).status === 404
      && (await api('GET', `/api/products/${only?.id}`, { token: rtok })).status === 404);
  const lineOf = async (token) => (await api('GET', `/api/invoices/${oldBill.body.id}`, { token })).body?.lines?.find((l) => l.productId === only?.id);
  const adminLine = await lineOf(admin);
  const shopLine = await lineOf(rtok);
  check('บิลเก่ายังแสดงรหัสและชื่อสินค้าเดิมครบ (ส่วนกลางและร้าน)',
    adminLine?.sku === 'R5-ONLY' && adminLine.productName === 'สินค้าชิ้นเดียวของร้าน' && shopLine?.sku === 'R5-ONLY' && shopLine.productName === adminLine.productName,
    { adminLine, shopLine });
  const oldSales = (await api('GET', '/api/sales-entries?periodCode=2029-06-H2', { token: admin })).body.items ?? [];
  check('ยอดขายรอบเก่ายังแสดงสินค้านี้ (หน้ายอดขายรายรอบ)', oldSales.some((e) => e.id === kept.body.id && e.sku === 'R5-ONLY'), oldSales.map((e) => e.sku));
  const ended = db.prepare(`SELECT
      (SELECT end_date FROM product_assignments WHERE product_id = ? ORDER BY id DESC LIMIT 1) AS assignmentEnd,
      (SELECT CONCAT(start_date, '|', end_date) FROM product_sales_links WHERE id = ?) AS deal`).get(only?.id, deal?.id);
  check('สัญญาร้านที่เปิดอยู่ถูกปิดวันนี้ · ดีลที่ยังไม่ถึงวันเริ่มถูกปิดเป็นวันนี้ทั้งสองวัน',
    ended.assignmentEnd === todayTh && ended.deal === `${todayTh}|${todayTh}`, ended);
  const patched = await api('PATCH', `/api/products/${only?.id}`, { token: admin, body: { name: 'แก้หลังลบ' } });
  const revived = await api('PATCH', `/api/products/${only?.id}`, { token: admin, body: { status: 'ACTIVE' } });
  check('แก้ไขสินค้าที่ลบแล้วไม่ได้ (409) — เปิดใช้งานกลับก็ไม่ได้',
    patched.status === 409 && errOf(patched).includes('สินค้านี้ถูกลบแล้ว') && revived.status === 409, [patched.body, revived.body]);
  const sameSku = await mk('r5-only');
  check('สร้างสินค้าใหม่ด้วยรหัสเดิมไม่ได้ (409 · ตัวพิมพ์เล็กก็ไม่ได้) — บิลเก่ายังอ้างถึงรหัสนี้',
    sameSku.status === 409 && errOf(sameSku) === 'รหัส r5-only เคยใช้กับสินค้าที่ลบไปแล้ว (บิลเก่ายังอ้างถึง) — ใช้รหัสอื่น', sameSku.body);
  const onDeleted = [
    await api('POST', '/api/sales-entries', { token: admin, body: { periodCode: '2029-07-H1', productId: only?.id, grossAmount: 1000 } }),
    await api('POST', '/api/assignments', { token: admin, body: { productId: only?.id, franchiseId: rfid, startDate: '2030-01-01' } }),
    await api('POST', '/api/sales-agents/links', { token: admin, body: { salesAgentId: r5sale?.id, items: [{ productId: only?.id, commissionPct: 1 }] } }),
    await mk('R19-GSET', { isGroup: true, itemProductIds: [only?.id] }),
  ];
  check('บันทึกยอด / มอบหมายร้าน / ผูกดีล / ใส่ในสินค้ากลุ่ม กับสินค้าที่ลบแล้วไม่ได้ (409 บอกว่าถูกลบแล้ว)',
    onDeleted.every((r) => r.status === 409 && errOf(r).includes('ถูกลบแล้ว')), onDeleted.map((r) => [r.status, errOf(r)]));
  const cand = (await api('GET', `/api/sales-agents/${r5sale?.id}/commission-candidates`, { token: admin })).body;
  check('บรรทัดที่ออกบิลไปแล้วของสินค้าที่ลบ ยังติ๊กทำบิลค่าคอมได้ (เงินเรียกเก็บไปแล้ว)',
    cand.items?.some((i) => i.entryId === kept.body.id && i.sku === 'R5-ONLY'), cand.items);
  check('ลบซ้ำได้ 404', (await api('DELETE', `/api/products/${only?.id}`, { token: admin })).status === 404);
  const delLogs = db.prepare("SELECT entity_id, detail FROM audit_logs WHERE action = 'product.delete' AND entity_id IN (?, ?, ?) ORDER BY id")
    .all(fresh?.id, reused.body.product?.id, only?.id).map((r) => ({ id: r.entity_id, ...JSON.parse(r.detail) }));
  check('ประวัติ "ลบสินค้า" จดวิธีลบ (HARD/SOFT) รหัส ชื่อ และจำนวนบรรทัดที่ออกบิลแล้ว (แถวที่ลบจริงหาชื่อจาก id ไม่ได้แล้ว)',
    delLogs.length === 3 && delLogs[0].mode === 'HARD' && delLogs[0].sku === 'R19-FRESH' && delLogs[0].name === 'สินค้า R19-FRESH'
      && delLogs[2].mode === 'SOFT' && delLogs[2].sku === 'R5-ONLY' && delLogs[2].name === 'สินค้าชิ้นเดียวของร้าน' && delLogs[2].invoicedEntries === 1, delLogs);
  const acts = (await api('GET', '/api/activity?actions=product.delete&limit=10', { token: admin })).body.items ?? [];
  check('หน้าประวัติรายการแสดง "ลบสินค้า" พร้อมรหัสสินค้า', acts.some((a) => a.what === 'ลบสินค้า' && a.target === 'R19-FRESH'), acts.map((a) => [a.what, a.target]));

  // ── สินค้ากลุ่ม: กลุ่มต้องไม่ว่าง ──
  const cA = (await mk('R19-CA')).body.product;
  const cB = (await mk('R19-CB')).body.product;
  const g1 = (await mk('R19-G1', { isGroup: true, itemProductIds: [cA?.id, cB?.id] })).body.product;
  const g2 = (await mk('R19-G2', { isGroup: true, itemProductIds: [cA?.id] })).body.product;
  const lastOne = await api('DELETE', `/api/products/${cA?.id}`, { token: admin });
  check('สินค้าย่อยชิ้นสุดท้ายของกลุ่ม → ลบไม่ได้ (409 บอกชื่อกลุ่มที่จะว่าง)',
    lastOne.status === 409 && errOf(lastOne) === 'สินค้า R19-CA เป็นสินค้าย่อยชิ้นสุดท้ายของสินค้ากลุ่ม R19-G2 — เพิ่มสินค้าย่อยอื่นหรือเปลี่ยนกลุ่มก่อน', lastOne.body);
  const notLast = await api('DELETE', `/api/products/${cB?.id}`, { token: admin });
  const g1After = (await api('GET', `/api/products/${g1?.id}`, { token: admin })).body;
  check('สินค้าย่อยที่ไม่ใช่ชิ้นสุดท้าย → ลบได้ และหลุดออกจากกลุ่ม',
    notLast.status === 200 && notLast.body.mode === 'HARD' && skus(g1After.items) === 'R19-CA', { del: notLast.body, items: g1After.items });
  const groupDel = await api('DELETE', `/api/products/${g2?.id}`, { token: admin });
  const cAAfter = await api('GET', `/api/products/${cA?.id}`, { token: admin });
  check('ลบสินค้ากลุ่มได้ — สินค้าย่อยไม่ถูกลบตาม แค่หลุดจากกลุ่มนั้น',
    groupDel.status === 200 && cAAfter.status === 200 && skus(cAAfter.body.inGroups) === 'R19-G1', { del: groupDel.body, inGroups: cAAfter.body.inGroups });

  // ── สินค้ากลุ่มที่ลบแบบซ่อน แล้วบิลเดิมถูกยกเลิกและออกใหม่ ──
  // ลบกลุ่ม = ล้างรายการย่อยของกลุ่ม · ถ้าออกบิลใหม่แล้วจดรายการย่อย "ตอนนี้" ทับ snapshot เดิม บรรทัดจะกลายเป็นสินค้าธรรมดา "ประกอบด้วย" หาย
  const vs = await api('POST', '/api/franchises', { token: admin, body: { username: 'r19vshop', password: 'r19vshop-pass-1' } });
  const vsid = vs.body.franchise?.id;
  const vc1 = (await mk('R19-VC1')).body.product;
  const vc2 = (await mk('R19-VC2')).body.product;
  const vset = (await mk('R19-VSET', { isGroup: true, itemProductIds: [vc1?.id, vc2?.id], franchiseId: vsid, startDate: '2026-01-01' })).body.product;
  await api('POST', '/api/sales-entries', { token: admin, body: { periodCode: '2029-08-H1', productId: vset?.id, grossAmount: 3000 } });
  const vbill1 = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: vsid, periodCode: '2029-08-H1' } });
  const vdel = await api('DELETE', `/api/products/${vset?.id}`, { token: admin });
  const vvoid = await api('POST', `/api/invoices/${vbill1.body.id}/void`, { token: admin, body: { reason: 'แก้บิลหลังลบสินค้ากลุ่ม' } });
  const ventry = (await api('GET', `/api/sales-entries?periodCode=2029-08-H1&franchiseId=${vsid}`, { token: admin })).body.items
    ?.find((e) => e.productId === vset?.id);
  const vbill2 = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: vsid, periodCode: '2029-08-H1' } });
  const vline2 = vbill2.body.lines?.find((l) => l.productId === vset?.id);
  check('สินค้ากลุ่มที่ลบแบบซ่อน: ยกเลิกบิลแล้วออกใหม่ บรรทัดยังเป็นสินค้ากลุ่มพร้อม "ประกอบด้วย" เดิม (ไม่กลายเป็นสินค้าธรรมดา)',
    vbill1.status === 201 && vdel.body?.mode === 'SOFT' && vvoid.status === 200
      && ventry?.isGroup === true && skus(ventry?.components) === 'R19-VC1,R19-VC2'
      && vbill2.status === 201 && vline2?.isGroup === true && skus(vline2?.components) === 'R19-VC1,R19-VC2',
    { del: vdel.body, entry: ventry, line: vline2 });
}

/* ── ลบร้านค้า (R20 · 30 ก.ย. 69 "อันนี้ด้วย ลบได้") ─────────────────────
 * ถาวร · ส่วนกลาง + รหัส 6 หลัก (ผู้ใช้ทุกคนของร้านหลุดและเข้าไม่ได้อีก) · พักร้านชั่วคราวยังใช้สถานะ ระงับ/ปิด
 * ไม่มีประวัติ = ลบทิ้งจริง ชื่อร้านว่างใช้ใหม่ได้ · มีบิล/ประวัติ = ซ่อนถาวร บิลเก่ายังอยู่ครบ (ฐานข้อมูลตัดสินผ่าน FK)
 * ห้ามลบเมื่อยังมีเงินค้างทางใดทางหนึ่ง: สลิปรอตรวจ · บิลค้างชำระ · ยอดยังไม่ออกบิล · ยอดยกมาที่ทางเรายังติดร้าน
 * ใช้ร้านของหมวดนี้เองทั้งหมด (ร้าน A/B ถูกใช้ต่อในหมวดอื่น)
 */
section('ลบร้านค้า');
{
  const DEL_CHAT = '7700501';
  const errOf = (r) => r.body?.error?.message ?? '';
  const mkShop = async (username) => (await api('POST', '/api/franchises', { token: admin, body: { username, password: `${username}-pass-1` } })).body;
  const mkProd = async (sku, franchiseId) => (await api('POST', '/api/products', {
    token: admin, body: { sku, name: `สินค้า ${sku}`, commissionPct: 10, franchiseId, startDate: '2026-01-01' },
  })).body.product;
  const entryOf = (productId, periodCode, grossAmount) => api('POST', '/api/sales-entries', { token: admin, body: { periodCode, productId, grossAmount } });
  const del = (fid, opts = {}) => api('DELETE', `/api/franchises/${fid}`, { token: admin, ...opts });
  const deleteMsgs = (from, username) => telegram.messages.slice(from).filter((m) => m.text.includes(`ลบร้าน ${username}</b>`));

  // ── ร้านใหม่ที่ยังไม่เคยใช้งาน → ลบทิ้งจริง (HARD) ──
  const fresh = await mkShop('delfresh');
  const ffid = fresh.franchise?.id;
  const fprod = await mkProd('DEL-FRESH-P', ffid);
  const noCode = await del(ffid, { elevate: false });
  check('ลบร้านโดยไม่ใส่รหัส 6 หลักไม่ได้', noCode.status === 403 && noCode.body.error?.code === 'ELEVATION_REQUIRED', noCode.body);
  await flushTelegram();
  let mark = telegram.messages.length;
  const hard = await del(ffid);
  check('ร้านที่ยังไม่เคยมีบิล/ประวัติ → ลบทิ้งจริง (HARD) พร้อมผู้ใช้ของร้าน',
    hard.status === 200 && hard.body.deleted === true && hard.body.id === ffid && hard.body.username === 'delfresh'
      && hard.body.mode === 'HARD' && hard.body.users === 1, hard.body);
  const freshLeft = db.prepare(`SELECT
      (SELECT COUNT(*) FROM franchises WHERE id = ?) AS shops,
      (SELECT COUNT(*) FROM users WHERE franchise_id = ? OR username = 'delfresh') AS users,
      (SELECT COUNT(*) FROM product_assignments WHERE franchise_id = ?) AS assignments`).get(ffid, ffid, ffid);
  check('ร้าน ผู้ใช้ และสัญญามอบหมายหายจากฐานข้อมูล · เปิดดูได้ 404',
    freshLeft.shops === 0 && freshLeft.users === 0 && freshLeft.assignments === 0
      && (await api('GET', `/api/franchises/${ffid}`, { token: admin })).status === 404, freshLeft);
  check('สินค้าที่ร้านถืออยู่กลับมาว่าง (ไม่ถูกลบตาม)',
    (await api('GET', `/api/products/${fprod?.id}`, { token: admin })).body?.currentAssignment === null);
  const reused = await api('POST', '/api/franchises', { token: admin, body: { username: 'delfresh', password: 'delfresh-pass-2' } });
  check('ลบจริงแล้วชื่อร้านว่าง ใช้สร้างร้านใหม่ได้', reused.status === 201, reused.body);
  await flushTelegram();
  const hardMsg = deleteMsgs(mark, 'delfresh');
  check('ลบร้าน → แจ้งกลุ่มส่วนกลาง (ลบทิ้งทั้งหมด · ใครลบ · เวลา)',
    hardMsg.length === 1 && hardMsg[0].chat_id === TG_CHAT && /ลบทิ้งทั้งหมด/.test(hardMsg[0].text)
      && /โดย: <b>.*superadmin/.test(hardMsg[0].text) && /เวลา:/.test(hardMsg[0].text), telegram.messages.slice(mark).map((m) => m.text));

  // ── ด่าน: เงินที่ยังค้างอยู่ต้องจบก่อน ──
  const ds = await mkShop('delshop');
  const dfid = ds.franchise?.id;
  const dprod = await mkProd('DEL-SHOP-P', dfid);
  const ownerTok = (await shopLogin('delshop', 'delshop-pass-1', dfid)).body.token;
  await api('POST', `/api/franchises/${dfid}/users`, { token: ownerTok, body: { username: 'delshop-staff', password: 'delstaff-pass-1' } });
  const staffTok = (await shopLogin('delshop-staff', 'delstaff-pass-1', dfid)).body.token;
  await api('POST', '/api/sales-agents', { token: admin, body: { username: 'delsale', password: 'delsale-pass-1', name: 'เซลหมวดลบร้าน' } });
  const saleTok = (await api('POST', '/api/auth/login', { body: { username: 'delsale', password: 'delsale-pass-1' } })).body.token;
  const byRole = [];
  for (const tok of [ownerTok, staffTok, saleTok]) {
    const r = await api('DELETE', `/api/franchises/${dfid}`, { token: tok });
    byRole.push([r.status, r.body?.error?.code]);
  }
  check('เจ้าของร้าน / ผู้ช่วย / เซล ลบร้านไม่ได้ (403 เพราะไม่ใช่ส่วนกลาง ไม่ใช่แค่ไม่ได้ใส่รหัส)',
    byRole.every(([s, code]) => s === 403 && code !== 'ELEVATION_REQUIRED'), byRole);

  const dentry = await entryOf(dprod?.id, '2029-10-H1', 30000);
  const gUnbilled = await del(dfid);
  check('มียอดขายที่ยังไม่ออกบิล → ลบไม่ได้ (409)',
    dentry.status === 201 && gUnbilled.status === 409 && errOf(gUnbilled) === 'ร้าน delshop มียอดขายที่ยังไม่ออกบิล 1 รายการ — ออกบิลหรือลบยอดก่อน', gUnbilled.body);
  const dbill = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: dfid, periodCode: '2029-10-H1' } });
  const owed = Number(dbill.body.netTotal ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const gOpen = await del(dfid);
  check('มีบิลค้างชำระ → ลบไม่ได้ (409 บอกจำนวนบิลและยอดค้าง)',
    dbill.status === 201 && gOpen.status === 409 && errOf(gOpen) === `ร้าน delshop มีบิลค้างชำระ 1 ใบ (${owed} บาท) — รับชำระหรือยกเลิกบิลก่อน`, gOpen.body);
  const dsub = await api('POST', '/api/payments', {
    token: ownerTok, body: { invoiceId: dbill.body.id, amount: dbill.body.netTotal, paidAt: todayTh, slipUrl: await uploadSlip(ownerTok) },
  });
  const gSlip = await del(dfid);
  check('มีสลิปรอตรวจ → ลบไม่ได้ (409 ให้ตรวจสลิปก่อน)',
    dsub.status === 201 && gSlip.status === 409 && errOf(gSlip) === 'ร้าน delshop มีสลิปรอตรวจ 1 รายการ — ตรวจสลิปก่อน', gSlip.body);
  // ยอดติดลบทั้งรอบ = ทางเราติดเงินร้าน (ยอดยกไปหักรอบหน้า) — ร้านแยก เพราะยกเลิกยอดยกมาจากหน้าเว็บไม่ได้
  const cs = await mkShop('delcredit');
  const cfid = cs.franchise?.id;
  await entryOf((await mkProd('DEL-CREDIT-P', cfid))?.id, '2029-10-H1', -5000);
  const cbill = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: cfid, periodCode: '2029-10-H1' } });
  const gCredit = await del(cfid);
  check('ทางเรายังมียอดยกมาค้างให้ร้าน (รอบที่ยอดติดลบ) → ลบไม่ได้ (409)',
    cbill.status === 201 && gCredit.status === 409 && errOf(gCredit) === 'ทางเรายังมียอดยกมาค้างให้ร้านนี้ 500.00 บาท — ใช้หักบิลหรือยกเลิกยอดยกมาก่อน', gCredit.body);
  check('ลบไม่สำเร็จ = ไม่มีอะไรเปลี่ยน (ร้านยังอยู่ ผู้ใช้ยังใช้งานได้)',
    (await api('GET', `/api/franchises/${dfid}`, { token: admin })).status === 200 && (await api('GET', `/api/franchises/${cfid}`, { token: admin })).status === 200
      && (await api('GET', '/api/auth/me', { token: ownerTok })).status === 200
      && db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'franchise.delete' AND entity_id IN (?, ?)").get(dfid, cfid).n === 0);

  // ── มีบิลแล้ว → ซ่อนถาวร (SOFT) ──
  await api('POST', `/api/payments/${dsub.body.id}/approve`, { token: admin, body: {} });
  const paid = (await api('GET', `/api/invoices/${dbill.body.id}`, { token: admin })).body;
  check('ตั้งฉาก: บิลของร้านจ่ายครบ + ร้านเชื่อม Telegram ของตัวเอง', paid.status === 'PAID' && await linkTelegram(ownerTok, DEL_CHAT), paid.status);
  const oldKey = await shopLoginKey(dfid);
  const tvBefore = db.prepare('SELECT id, token_version FROM users WHERE franchise_id = ? ORDER BY id').all(dfid);
  await flushTelegram();
  mark = telegram.messages.length;
  const soft = await del(dfid);
  check('ร้านที่มีบิลแล้ว → ลบแบบซ่อน (SOFT) · ผู้ใช้ของร้าน 2 คน',
    soft.status === 200 && soft.body.deleted === true && soft.body.id === dfid && soft.body.username === 'delshop'
      && soft.body.mode === 'SOFT' && soft.body.users === 2, soft.body);
  const frow = db.prepare('SELECT status, deleted_at, deleted_by_user_id, login_key_hash, login_key_enc FROM franchises WHERE id = ?').get(dfid);
  check('แถวร้านยังอยู่ (บิลเก่าอ้างถึง) · สถานะ DELETED + เวลา + คนลบ · กุญแจลิงก์เข้าระบบถูกล้าง',
    frow?.status === 'DELETED' && Boolean(frow.deleted_at) && frow.deleted_by_user_id === adminId
      && frow.login_key_hash === null && frow.login_key_enc === null, frow);
  const urows = db.prepare('SELECT id, status, token_version, telegram_chat_id FROM users WHERE franchise_id = ? ORDER BY id').all(dfid);
  check('ผู้ใช้ทุกคนของร้าน: ปิดใช้งาน + token_version + 1 + ล้างแชต Telegram',
    urows.length === 2 && urows.every((u, i) => u.status === 'DISABLED' && u.token_version === tvBefore[i]?.token_version + 1 && u.telegram_chat_id === null), urows);
  check('ทุกคนในร้านหลุดจากระบบทันที (เจ้าของและผู้ช่วย)',
    (await api('GET', '/api/auth/me', { token: ownerTok })).status === 401 && (await api('GET', '/api/auth/me', { token: staffTok })).status === 401);
  shopKeys.delete(dfid);
  const loginOld = (username, password) => api('POST', '/api/auth/login', { body: { username, password, loginKey: oldKey } });
  const oldOwner = await loginOld('delshop', 'delshop-pass-1');
  const oldStaff = await loginOld('delshop-staff', 'delstaff-pass-1');
  const wrongPw = await loginOld('delshop', 'not-the-password');
  check('เข้าด้วยลิงก์เดิม + รหัสถูกไม่ได้ — 401 ข้อความเดียวกับรหัสผิด (ไม่บอกว่าร้านถูกลบ)',
    [oldOwner, oldStaff, wrongPw].every((r) => r.status === 401 && !r.body?.token)
      && errOf(oldOwner) === errOf(wrongPw) && errOf(oldStaff) === errOf(wrongPw), [oldOwner.body, oldStaff.body, wrongPw.body]);
  const shopList = (await api('GET', '/api/franchises', { token: admin })).body.items ?? [];
  const ready = (await api('GET', '/api/invoices/readiness?periodCode=2029-10-H1', { token: admin })).body.items ?? [];
  check('หายจากรายการร้านและตัวเลือกร้าน (ออกบิล) · เปิดดู / ลิงก์เข้าระบบ / ผู้ใช้ของร้าน ได้ 404',
    !shopList.some((f) => f.id === dfid) && !ready.some((r) => r.franchiseId === dfid)
      && (await api('GET', `/api/franchises/${dfid}`, { token: admin })).status === 404
      && (await api('GET', `/api/franchises/${dfid}/login-link`, { token: admin })).status === 404
      && (await api('GET', `/api/franchises/${dfid}/users`, { token: admin })).status === 404);
  const patchDeleted = await api('PATCH', `/api/franchises/${dfid}`, { token: admin, body: { contactName: 'แก้หลังลบ' } });
  const sameName = await api('POST', '/api/franchises', { token: admin, body: { username: 'DelShop', password: 'delshop-pass-2' } });
  check('แก้ไขร้านที่ลบแล้วไม่ได้ (409) · สร้างร้านใหม่ชื่อเดิมไม่ได้ (409 · ตัวพิมพ์ใหญ่ก็ไม่ได้)',
    patchDeleted.status === 409 && errOf(patchDeleted).includes('ถูกลบแล้ว')
      && sameName.status === 409 && errOf(sameName) === 'ชื่อ DelShop เคยใช้กับร้านที่ลบไปแล้ว (บิลเก่ายังอ้างถึง) — ใช้ชื่ออื่น', [patchDeleted.body, sameName.body]);
  const billList = (await api('GET', '/api/invoices?status=PAID', { token: admin })).body.items ?? [];
  check('บิลเก่ายังเปิดดูได้ครบพร้อมชื่อร้าน (ส่วนกลาง)',
    paid.franchiseUsername === 'delshop' && (await api('GET', `/api/invoices/${dbill.body.id}`, { token: admin })).body?.franchiseUsername === 'delshop'
      && billList.some((i) => i.id === dbill.body.id && i.franchiseUsername === 'delshop'), billList.filter((i) => i.id === dbill.body.id));
  const oldSales = (await api('GET', '/api/sales-entries?periodCode=2029-10-H1', { token: admin })).body.items ?? [];
  check('ยอดขายรอบเก่าของร้านยังอยู่ในหน้ายอดขาย (ยอดรวมกับบิลยังตรงกัน)',
    oldSales.some((e) => e.id === dentry.body.id && e.franchiseUsername === 'delshop'), oldSales.map((e) => e.franchiseUsername));
  const reissue = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: dfid, periodCode: '2029-10-H1' } });
  const addCharge = await api('POST', `/api/invoices/${dbill.body.id}/adjustments`, { token: admin, body: { kind: 'CHARGE', label: 'ค่าหลังลบร้าน', amount: 10 } });
  check('ออกบิลใหม่ / แก้บิลเก่าของร้านที่ลบแล้วไม่ได้ (409)',
    reissue.status === 409 && addCharge.status === 409 && errOf(addCharge).includes('ถูกลบแล้ว'), [reissue.body, addCharge.body]);
  const asgEnd = db.prepare('SELECT end_date FROM product_assignments WHERE franchise_id = ? ORDER BY id DESC LIMIT 1').get(dfid)?.end_date;
  const next = await mkShop('delshop-next');
  const moved = await api('POST', '/api/assignments', { token: admin, body: { productId: dprod?.id, franchiseId: next.franchise?.id, startDate: todayTh } });
  check('สัญญาสินค้าของร้านปิดวันนี้ · สินค้ามอบหมายให้ร้านอื่นได้ตั้งแต่วันนี้',
    asgEnd === todayTh && moved.status === 201, { asgEnd, moved: moved.body });
  const toDeleted = await api('POST', '/api/assignments', { token: admin, body: { productId: fprod?.id, franchiseId: dfid, startDate: todayTh } });
  check('มอบหมายสินค้าให้ร้านที่ลบแล้วไม่ได้ (409)', toDeleted.status === 409 && errOf(toDeleted).includes('ถูกลบแล้ว'), toDeleted.body);
  await notifyShopForTest(dfid);
  await flushTelegram();
  const softMsg = deleteMsgs(mark, 'delshop');
  check('ลบแบบซ่อน → แจ้งกลุ่มส่วนกลาง (ซ่อนถาวร · ลิงก์ใช้ไม่ได้) · ไม่มีข้อความไปหาแชตของร้านที่ลบแล้ว',
    softMsg.length === 1 && softMsg[0].chat_id === TG_CHAT && /ซ่อนถาวร/.test(softMsg[0].text) && /ลิงก์เข้าระบบของร้านใช้ไม่ได้แล้ว/.test(softMsg[0].text)
      && !telegram.messages.slice(mark).some((m) => String(m.chat_id) === DEL_CHAT), telegram.messages.slice(mark).map((m) => [m.chat_id, m.text]));
  check('ลบซ้ำได้ 404', (await del(dfid)).status === 404);
  const delLogs = db.prepare("SELECT entity_id, detail FROM audit_logs WHERE action = 'franchise.delete' AND entity_id IN (?, ?) ORDER BY id")
    .all(ffid, dfid).map((r) => ({ id: r.entity_id, ...JSON.parse(r.detail) }));
  const acts = (await api('GET', '/api/activity?actions=franchise.delete&limit=10', { token: admin })).body.items ?? [];
  check('ประวัติ "ลบร้านค้า" จดชื่อร้านและวิธีลบ (HARD/SOFT)',
    delLogs.length === 2 && delLogs[0].username === 'delfresh' && delLogs[0].mode === 'HARD' && delLogs[1].username === 'delshop' && delLogs[1].mode === 'SOFT'
      && acts.some((a) => a.what === 'ลบร้านค้า' && a.target === 'delfresh'), { delLogs, acts: acts.map((a) => [a.what, a.target]) });

  /*
   * ── ฐานข้อมูลเป็นคนตัดสิน: ไม่มีบิลเลย แต่ผู้ใช้เคยเข้าระบบ (ประวัติอ้างถึงผู้ใช้) → ซ่อนแทนลบจริง ──
   * การลองลบจริงลบสัญญามอบหมายไปก่อนจะชน FK ที่ผู้ใช้ — สัญญายังอยู่ (แล้วถูกปิดแบบซ่อน) = ทรานแซกชันแรกถูกย้อนทั้งก้อนจริง
   */
  const ls = await mkShop('dellogged');
  const lfid = ls.franchise?.id;
  const later = new Date(Date.parse(todayTh) + 20 * 86400000).toISOString().slice(0, 10);
  const lprod = (await api('POST', '/api/products', {
    token: admin, body: { sku: 'DEL-LOGGED-P', name: 'สินค้าเริ่มขายเดือนหน้า', commissionPct: 10, franchiseId: lfid, startDate: later },
  })).body.product;
  const loggedIn = await shopLogin('dellogged', 'dellogged-pass-1', lfid);
  const lsDel = await del(lfid);
  const lusers = db.prepare('SELECT status FROM users WHERE franchise_id = ?').all(lfid);
  const lasg = db.prepare('SELECT start_date, end_date FROM product_assignments WHERE product_id = ?').all(lprod?.id);
  check('ร้านที่ไม่มีบิลแต่ผู้ใช้เคยเข้าระบบ → ซ่อนแทนลบจริง และการลองลบจริงถูกย้อนทั้งก้อน (ผู้ใช้และสัญญายังอยู่ ผู้ใช้ถูกปิด)',
    loggedIn.status === 200 && lsDel.status === 200 && lsDel.body.mode === 'SOFT' && lusers.length === 1 && lusers[0].status === 'DISABLED'
      && lasg.length === 1, { del: lsDel.body, lusers, lasg });
  check('สัญญาที่ยังไม่ถึงวันเริ่มของร้านที่ลบ ถูกปิดเป็นวันนี้ทั้งสองวัน (ไม่ติด "วันจบ ≥ วันเริ่ม")',
    lasg[0]?.start_date === todayTh && lasg[0]?.end_date === todayTh, lasg);
}

/* ── ลบรายการค่าใช้จ่าย/ส่วนลดตั้งต้น ─────────────────────────
 * เจ้าของระบบ: "หน้านี้ต้องกดลบได้" — ลบจริงได้เสมอ (ต่างจากสินค้าที่มีบิลแล้วได้แค่ซ่อน) เพราะบิลเก็บชื่อ/% /ยอดของรายการไว้เองแล้ว
 * ลบแล้วบิลเก่าต้องยังแสดงเหมือนเดิมทุกตัวเลข แค่หลุดความเชื่อมโยงกับรายการตั้งต้น */
section('ลบรายการค่าใช้จ่าย/ส่วนลดตั้งต้น (บิลเก่าไม่เปลี่ยน)');
{
  const cs = await api('POST', '/api/franchises', { token: admin, body: { username: 'chgdel', password: 'chgdel-pass-1' } });
  const cfid = cs.body.franchise?.id;
  const ctok = (await shopLogin('chgdel', 'chgdel-pass-1', cfid)).body.token;
  const cprod = (await api('POST', '/api/products', {
    token: admin, body: { sku: 'CHG-DEL-1', name: 'สินค้าทดสอบลบรายการ', commissionPct: 10, franchiseId: cfid, startDate: '2026-01-01' },
  })).body.product;
  await api('POST', '/api/sales-entries', { token: admin, body: { periodCode: '2029-07-H1', productId: cprod?.id, grossAmount: 10000 } });
  const item = await api('POST', '/api/charge-items', { token: admin, body: { name: 'ค่าทดสอบก่อนลบ', kind: 'CHARGE', defaultAmount: 150 } });
  const bill = await api('POST', '/api/invoices/generate', {
    token: admin, body: { franchiseId: cfid, periodCode: '2029-07-H1', adjustments: [{ chargeItemId: item.body.id }] },
  });
  const adjBefore = bill.body.adjustments?.find((a) => a.label === 'ค่าทดสอบก่อนลบ');
  check('ตั้งฉาก: บิลใส่รายการตั้งต้นแล้ว (1,000 + 150)',
    bill.status === 201 && adjBefore?.amount === 150 && adjBefore?.chargeItemId === item.body.id && bill.body.netTotal === 1150, bill.body);

  check('ร้านค้าลบรายการตั้งต้นไม่ได้',
    (await api('DELETE', `/api/charge-items/${item.body.id}`, { token: ctok })).status === 403);
  const del = await api('DELETE', `/api/charge-items/${item.body.id}`, { token: admin });
  check('ส่วนกลางลบได้ แม้เคยใช้ในบิลแล้ว (บอกจำนวนบิลที่เคยใช้)',
    del.status === 200 && del.body.deleted === true && del.body.usedOnBills === 1, del.body);
  const after = await api('GET', `/api/invoices/${bill.body.id}`, { token: admin });
  const adjAfter = after.body.adjustments?.find((a) => a.label === 'ค่าทดสอบก่อนลบ');
  check('บิลเก่ายังแสดงชื่อและยอดเดิมครบ ยอดรวมไม่ขยับ (แค่หลุดจากรายการตั้งต้น)',
    adjAfter?.amount === 150 && adjAfter?.chargeItemId === null && after.body.netTotal === 1150, after.body.adjustments);
  const listed = (await api('GET', '/api/charge-items?status=', { token: admin })).body.items ?? [];
  check('ไม่โผล่ในรายการให้เลือกแล้ว และลบซ้ำได้ 404',
    !listed.some((c) => c.id === item.body.id)
      && (await api('DELETE', `/api/charge-items/${item.body.id}`, { token: admin })).status === 404);
  const log = db.prepare("SELECT detail FROM audit_logs WHERE action = 'charge_item.delete' AND entity_id = ?").get(item.body.id);
  check('ลบถูกจดประวัติพร้อมชื่อรายการ (แถวถูกลบไปแล้ว หาชื่อจาก id ไม่ได้)',
    Boolean(log) && JSON.parse(log.detail).name === 'ค่าทดสอบก่อนลบ', log);
}

/* ── บิลค่าคอมเซล ──────────────────────────────────────────────
 * ออกบิลร้านก่อน แล้วส่วนกลางค่อย "ทำบิลค่าคอม": ติ๊กบรรทัดจากบิลร้าน (% ของยอดเต็ม หรือกรอกเอง) + เหมาต่อรอบ + ค่าคอมอื่น ๆ
 * กติกาเงินอยู่ที่เซิร์ฟเวอร์: บรรทัดเดียวจ่ายค่าคอมได้ครั้งเดียว · ยกเลิกแล้วติ๊กใหม่ได้
 * บิลร้านถูกยกเลิก → ถอดออกจากบิลค่าคอมที่ยังไม่จ่าย (ไม่เหลืออะไร = ยกเลิกทั้งใบ) · ที่จ่ายแล้วไม่แตะ
 */
section('บิลค่าคอมเซล: ติ๊กรายการจากบิลร้าน + เหมาต่อรอบ + ค่าคอมอื่น ๆ');
{
  const cs = await api('POST', '/api/franchises', { token: admin, body: { username: 'commshop', password: 'commshop-pass-1' } });
  const cfid = cs.body.franchise?.id;
  const mkp = async (sku, pct) => (await api('POST', '/api/products', {
    token: admin, body: { sku, name: `สินค้าคอม ${sku}`, commissionPct: pct, franchiseId: cfid, startDate: '2026-01-01' },
  })).body.product;
  const cm1 = await mkp('CM-1', 10);
  const cm2 = await mkp('CM-2', 20);
  const cm3 = await mkp('CM-3', 5);
  const sc = (await api('POST', '/api/sales-agents', { token: admin, body: { username: 'salec', password: 'salec-pass-123', name: 'เซลซี' } })).body.agent;
  const sd = (await api('POST', '/api/sales-agents', { token: admin, body: { username: 'saled', password: 'saled-pass-123', name: 'เซลดี' } })).body.agent;
  await api('POST', '/api/sales-agents/links', {
    token: admin, body: { salesAgentId: sc?.id, items: [{ productId: cm1?.id, commissionPct: 5, fixedAmount: 300 }, { productId: cm2?.id, commissionPct: 10 }] },
  });
  await api('POST', '/api/sales-agents/links', { token: admin, body: { salesAgentId: sd?.id, items: [{ productId: cm3?.id, commissionPct: 8 }] } });
  const entry = async (productId, grossAmount, periodCode) => (await api('POST', '/api/sales-entries', {
    token: admin, body: { periodCode, productId, grossAmount },
  })).body;
  const ce1 = await entry(cm1?.id, 10000, '2029-01-H1');
  const ce2 = await entry(cm2?.id, 20000, '2029-01-H1');
  const ce3 = await entry(cm3?.id, 5000, '2029-01-H1');
  const cinv1 = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: cfid, periodCode: '2029-01-H1' } });
  const candOf = async (agentId) => (await api('GET', `/api/sales-agents/${agentId}/commission-candidates`, { token: admin })).body;
  const billFor = (agentId, body, token = admin) => api('POST', `/api/sales-agents/${agentId}/commission-bills`, { token, body });
  const commOf = async (id) => (await api('GET', `/api/sales-agents/commissions/${id}`, { token: admin })).body;
  const listOf = async (agentId) => (await api('GET', `/api/sales-agents/commissions?salesAgentId=${agentId}`, { token: admin })).body.items ?? [];

  check('ออกบิลร้านได้ และไม่เกิดค่าคอมเซลเอง', cinv1.status === 201 && (await listOf(sc?.id)).length === 0, cinv1.body);
  let cand = await candOf(sc?.id);
  const ci = (id) => cand.items?.find((i) => i.entryId === id);
  check('รายการที่ติ๊กได้: เฉพาะสินค้าที่เซลถือดีล พร้อม % ของดีลเป็นค่าตั้งต้น',
    ci(ce1.id)?.grossAmount === 10000 && ci(ce1.id).deal?.pct === 5 && ci(ce2.id)?.deal?.pct === 10 && !ci(ce3.id)
      && ci(ce1.id).invoiceNo === cinv1.body.invoiceNo, cand.items);
  check('เหมาต่อรอบขึ้นให้ติ๊ก 1 รายการต่อร้าน × รอบ (300)',
    cand.fixed?.length === 1 && cand.fixed[0].amount === 300 && cand.fixed[0].periodCode === '2029-01-H1', cand.fixed);
  const fixKey = cand.fixed?.[0]?.key;

  // ตรวจทุกบรรทัดก่อนเขียน — ผิดบรรทัดเดียวไม่มีอะไรถูกบันทึก
  const invalid = [
    ['ติ๊กรายการของสินค้าที่เซลคนอื่นถือดีลไม่ได้', { items: [{ entryId: ce3.id, mode: 'PCT', pct: 5 }] }],
    ['เลือก "% ของยอดเต็ม" แต่ส่งจำนวนเงินมาด้วย ไม่รับ', { items: [{ entryId: ce1.id, mode: 'PCT', pct: 5, amount: 1 }] }],
    ['เลือก "กรอกเอง" แต่ไม่ใส่จำนวนเงิน ไม่รับ', { items: [{ entryId: ce1.id, mode: 'MANUAL' }] }],
    ['กรอกค่าคอมติดลบบนยอดขายปกติไม่ได้ (หักคืนใช้ค่าคอมอื่น ๆ)', { items: [{ entryId: ce1.id, mode: 'MANUAL', amount: -5 }] }],
    ['ค่าคอมอื่น ๆ จำนวนเงินเป็นศูนย์ไม่ได้', { others: [{ label: 'ว่าง', amount: 0 }] }],
    ['ค่าคอมอื่น ๆ ต้องมีชื่อรายการ', { others: [{ label: '   ', amount: 100 }] }],
    ['ยอดรวมบิลค่าคอมต้องมากกว่า 0', { others: [{ label: 'หักคืน', amount: -100 }] }],
    ['ไม่เลือกอะไรเลยไม่ได้', {}],
  ];
  for (const [label, body] of invalid) {
    const r = await billFor(sc?.id, body);
    check(label, r.status === 400, r.body);
  }
  check('ตรวจไม่ผ่านแล้วไม่มีบิลค่าคอมค้างอยู่', (await listOf(sc?.id)).length === 0);

  const bill1 = await billFor(sc?.id, {
    items: [{ entryId: ce1.id, mode: 'PCT', pct: 5 }, { entryId: ce2.id, mode: 'MANUAL', amount: 1234.56 }],
    fixed: [{ key: fixKey }],
    others: [{ label: 'โบนัสเปิดร้านใหม่', amount: 1000 }, { label: 'หักคืนที่จ่ายเกินรอบก่อน', amount: -200 }],
    note: 'รอบแรก',
  });
  // 10,000 × 5% = 500 · กรอกเอง 1,234.56 · เหมา 300 · อื่น ๆ 1,000 − 200 → 2,834.56
  check('ทำบิลค่าคอม: % ของยอดเต็ม + กรอกเอง + เหมาต่อรอบ + ค่าคอมอื่น ๆ (ติดลบได้) = 2,834.56',
    bill1.status === 201 && bill1.body.totalAmount === 2834.56 && bill1.body.pctAmount === 1734.56 && bill1.body.fixedAmount === 1100
      && bill1.body.baseAmount === 30000 && bill1.body.lines?.length === 5 && bill1.body.status === 'PENDING', bill1.body);
  const l1 = bill1.body.lines?.find((l) => l.entryId === ce1.id);
  const l2 = bill1.body.lines?.find((l) => l.entryId === ce2.id);
  check('บรรทัดบอกบิลร้าน วิธีคิด ยอดเต็ม % และยอดคอม',
    l1?.mode === 'PCT' && l1.modeLabel === '% ของยอดเต็ม' && l1.baseAmount === 10000 && l1.pct === 5 && l1.amount === 500
      && l1.invoiceNo === cinv1.body.invoiceNo && l2?.mode === 'MANUAL' && l2.modeLabel === 'กรอกเอง' && l2.pct === null
      && l2.amount === 1234.56, bill1.body.lines);
  check('เลขบิลค่าคอม = COM-วันที่ไทย-เซล', bill1.body.billNo === `COM-${todayTh.replace(/-/g, '')}-salec`, bill1.body.billNo);
  check('บรรทัดเดียวกันทำบิลค่าคอมซ้ำไม่ได้ (กันจ่ายซ้ำ)', (await billFor(sc?.id, { items: [{ entryId: ce1.id, mode: 'PCT', pct: 5 }] })).status === 400);
  check('เหมาต่อรอบเดิมใส่ซ้ำไม่ได้', (await billFor(sc?.id, { fixed: [{ key: fixKey }] })).status === 400);
  cand = await candOf(sc?.id);
  check('รายการที่ทำบิลแล้วหายจากรายการที่ติ๊กได้', !ci(ce1.id) && !ci(ce2.id) && cand.fixed?.length === 0, cand);
  const second = await billFor(sc?.id, { others: [{ label: 'ค่าเดินทาง', amount: 10 }] });
  check('วันเดียวกันทำบิลค่าคอมใบที่สองได้ เลขต่อท้าย -2', second.status === 201 && second.body.billNo?.endsWith('-salec-2'), second.body.billNo);

  // ยกเลิก → รายการกลับมาให้ติ๊กใหม่ได้
  const saleCTok = (await api('POST', '/api/auth/login', { body: { username: 'salec', password: 'salec-pass-123' } })).body.token;
  const voidBill = (id, reason, token = admin) => api('POST', `/api/sales-agents/commissions/${id}/void`, { token, body: { reason } });
  check('ยกเลิกบิลค่าคอมต้องมีเหตุผล', (await voidBill(bill1.body.id, 'x')).status === 400);
  check('เซลยกเลิกบิลค่าคอมเองไม่ได้', (await voidBill(bill1.body.id, 'ขอยกเลิก', saleCTok)).status === 403);
  const v1 = await voidBill(bill1.body.id, 'ติ๊กผิดรายการ');
  check('ยกเลิกบิลค่าคอมที่ยังไม่จ่ายได้ พร้อมเหตุผล',
    v1.status === 200 && v1.body.status === 'VOID' && v1.body.voidReason === 'ติ๊กผิดรายการ' && Boolean(v1.body.voidedAt), v1.body);
  check('ยกเลิกซ้ำไม่ได้', (await voidBill(bill1.body.id, 'ยกเลิกอีกครั้ง')).status === 409);
  check('บิลที่ยกเลิกแล้วบันทึกจ่ายไม่ได้', (await api('POST', `/api/sales-agents/commissions/${bill1.body.id}/pay`, { token: admin, body: {} })).status === 409);
  cand = await candOf(sc?.id);
  check('ยกเลิกแล้ว รายการกลับมาให้ติ๊กทำบิลใหม่ได้', Boolean(ci(ce1.id)) && Boolean(ci(ce2.id)) && cand.fixed?.length === 1, cand);

  // บิลร้านถูกยกเลิก → ถอดออกจากบิลค่าคอมที่ยังไม่จ่าย · ที่จ่ายแล้วไม่แตะ
  const billPaid = await billFor(sc?.id, { items: [{ entryId: ce1.id, mode: 'PCT', pct: 5 }], fixed: [{ key: cand.fixed?.[0]?.key }] });
  const billPend = await billFor(sc?.id, { items: [{ entryId: ce2.id, mode: 'PCT', pct: 10 }], others: [{ label: 'ค่าเดินทาง', amount: 150 }] });
  const ce4 = await entry(cm1?.id, 8000, '2029-01-H2');
  const cinv2 = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: cfid, periodCode: '2029-01-H2' } });
  cand = await candOf(sc?.id);
  const onlyInv2 = await billFor(sc?.id, {
    items: [{ entryId: ce4.id, mode: 'MANUAL', amount: 400 }],
    fixed: (cand.fixed ?? []).filter((f) => f.invoiceId === cinv2.body.id).map((f) => ({ key: f.key })),
  });
  check('ตั้งฉาก: บิลค่าคอม 3 ใบ (800 · 2,150 · เฉพาะบิลร้านใบที่สอง 700)',
    billPaid.body.totalAmount === 800 && billPend.body.totalAmount === 2150 && onlyInv2.body.totalAmount === 700,
    [billPaid.body, billPend.body, onlyInv2.body].map((b) => b.totalAmount ?? b));
  const paid = await api('POST', `/api/sales-agents/commissions/${billPaid.body.id}/pay`, { token: admin, body: {} });
  check('บันทึกจ่ายบิลค่าคอมได้', paid.status === 200 && paid.body.status === 'PAID', paid.body);
  check('จ่ายซ้ำไม่ได้', (await api('POST', `/api/sales-agents/commissions/${billPaid.body.id}/pay`, { token: admin, body: {} })).status === 409);
  check('จ่ายแล้วยกเลิกไม่ได้ (จ่ายเกินให้หักด้วยค่าคอมอื่น ๆ ติดลบในบิลถัดไป)', (await voidBill(billPaid.body.id, 'ขอยกเลิก')).status === 409);

  await api('POST', `/api/invoices/${cinv1.body.id}/void`, { token: admin, body: { reason: 'ทดสอบยกเลิกบิลร้าน' } });
  const pendAfter = await commOf(billPend.body.id);
  check('ยกเลิกบิลร้าน → บิลค่าคอมที่ยังไม่จ่ายถูกถอดรายการของบิลร้านใบนั้น เหลือค่าคอมอื่น ๆ และคิดยอดใหม่ (150)',
    pendAfter.status === 'PENDING' && pendAfter.lines?.length === 1 && pendAfter.lines[0].kind === 'OTHER' && pendAfter.totalAmount === 150, pendAfter);
  const paidAfter = await commOf(billPaid.body.id);
  check('…บิลค่าคอมที่จ่ายแล้วไม่ถูกแตะ (ติดป้ายว่าบิลร้านถูกยกเลิก)',
    paidAfter.status === 'PAID' && paidAfter.totalAmount === 800 && paidAfter.lines?.length === 2
      && paidAfter.lines.every((l) => l.invoiceVoided === true), paidAfter);
  check('การถอดรายการถูกจดประวัติ',
    db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'sales_commission.lines_removed' AND entity_id = ?").get(billPend.body.id).n === 1);
  await api('POST', `/api/invoices/${cinv2.body.id}/void`, { token: admin, body: { reason: 'ทดสอบยกเลิกบิลร้านใบที่สอง' } });
  const emptied = await commOf(onlyInv2.body.id);
  check('บิลค่าคอมที่ไม่เหลือรายการ ถูกยกเลิกเองพร้อมบอกเหตุผล',
    emptied.status === 'VOID' && emptied.voidReason === `บิลร้าน ${cinv2.body.invoiceNo} ถูกยกเลิก`, emptied);
  const reissue = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: cfid, periodCode: '2029-01-H1' } });
  cand = await candOf(sc?.id);
  check('ออกบิลร้านใหม่: รายการที่อยู่ในบิลค่าคอมที่จ่ายแล้วติ๊กซ้ำไม่ได้ · รายการที่ถูกถอดออกติ๊กได้อีก',
    reissue.status === 201 && !ci(ce1.id) && Boolean(ci(ce2.id)) && !(cand.fixed ?? []).some((f) => f.periodCode === '2029-01-H1'), cand);

  // สิทธิ์: เซลเห็นแค่ของตัวเอง · ร้าน/เซลทำบิลค่าคอมไม่ได้
  const myC = await api('GET', '/api/sales-agents/me/commissions', { token: saleCTok });
  check('เซลเห็นบิลค่าคอมของตัวเองพร้อมรายการ',
    myC.body.items?.some((c) => c.id === billPaid.body.id && c.lines.length === 2) && myC.body.items.every((c) => c.agentUsername === 'salec'), myC.body.items);
  const saleDTok = (await api('POST', '/api/auth/login', { body: { username: 'saled', password: 'saled-pass-123' } })).body.token;
  check('เซลคนอื่นไม่เห็นบิลค่าคอมนี้ (แม้ใส่ตัวกรองเป็นเซลคนอื่น)',
    (await api('GET', '/api/sales-agents/me/commissions', { token: saleDTok })).body.items?.length === 0
      && (await api('GET', `/api/sales-agents/commissions?salesAgentId=${sc?.id}`, { token: saleDTok })).body.items?.length === 0);
  check('เซลเปิดบิลค่าคอมของเซลคนอื่นไม่ได้', (await api('GET', `/api/sales-agents/commissions/${billPaid.body.id}`, { token: saleDTok })).status === 403);
  check('เซลดูรายการที่ติ๊กได้ / ทำบิลค่าคอมเองไม่ได้',
    (await api('GET', `/api/sales-agents/${sc?.id}/commission-candidates`, { token: saleCTok })).status === 403
      && (await billFor(sc?.id, { others: [{ label: 'ขอเอง', amount: 1 }] }, saleCTok)).status === 403);
  check('ร้านค้าเรียกหน้าบิลค่าคอมไม่ได้',
    (await api('GET', `/api/sales-agents/${sc?.id}/commission-candidates`, { token: tokenA })).status === 403
      && (await billFor(sc?.id, { others: [{ label: 'x', amount: 1 }] }, tokenA)).status === 403
      && (await api('GET', `/api/sales-agents/commissions/${billPaid.body.id}`, { token: tokenA })).status === 403);
  const onlyBills = (await api('GET', `/api/sales-agents/commissions?kind=BILL&salesAgentId=${sc?.id}`, { token: admin })).body.items ?? [];
  check('กรองเฉพาะบิลค่าคอมได้ (kind=BILL)', onlyBills.length === 5 && onlyBills.every((c) => c.kind === 'BILL'), onlyBills.map((c) => [c.kind, c.billNo]));
}

/* ── เซลที่ได้แค่ค่าคอมอื่น ๆ ─────────────────────────────────
 * เจ้าของระบบ: ไม่ต้องบังคับผูกดีลสินค้า — เซลบางคนได้แค่ค่าแนะนำร้าน/โบนัส
 */
section('เซลที่ได้แค่ค่าคอมอื่น ๆ (ไม่ต้องผูกดีลสินค้า)');
{
  const s = (await api('POST', '/api/sales-agents', { token: admin, body: { username: 'saleonly', password: 'saleonly-pass-1', name: 'เซลค่าแนะนำ' } })).body.agent;
  const cand = await api('GET', `/api/sales-agents/${s?.id}/commission-candidates`, { token: admin });
  check('เซลที่ไม่มีดีลเลย ไม่มีรายการให้ติ๊ก (ไม่ใช่ error)',
    cand.status === 200 && cand.body.items?.length === 0 && cand.body.fixed?.length === 0, cand.body);
  const only = await api('POST', `/api/sales-agents/${s?.id}/commission-bills`, { token: admin, body: { others: [{ label: 'ค่าแนะนำร้านใหม่', amount: 500 }] } });
  check('ทำบิลค่าคอมที่มีแต่ค่าคอมอื่น ๆ ได้',
    only.status === 201 && only.body.totalAmount === 500 && only.body.lines?.length === 1
      && only.body.lines[0].kind === 'OTHER' && only.body.lines[0].label === 'ค่าแนะนำร้านใหม่', only.body);
  const stok = (await api('POST', '/api/auth/login', { body: { username: 'saleonly', password: 'saleonly-pass-1' } })).body.token;
  const me = await api('GET', '/api/sales-agents/me', { token: stok });
  check('เซลเห็นยอดค้างจ่ายและบิลล่าสุดในหน้าแรกของตัวเอง',
    me.status === 200 && me.body.summary?.pending === 500 && me.body.recentBills?.some((b) => b.id === only.body.id)
      && me.body.byMonth?.length >= 1 && me.body.products?.length === 0, me.body);
  const mine = await api('GET', '/api/sales-agents/me/commissions', { token: stok });
  check('เซลเห็นเฉพาะบิลค่าคอมของตัวเอง', mine.body.items?.length === 1 && mine.body.items[0].id === only.body.id, mine.body.items);
  check('เซลเปิดบิลค่าคอมของเซลคนอื่นไม่ได้', (await api('GET', `/api/sales-agents/commissions/${c1.id}`, { token: stok })).status === 403);
  check('เซลบันทึกจ่ายให้ตัวเองไม่ได้', (await api('POST', `/api/sales-agents/commissions/${only.body.id}/pay`, { token: stok, body: {} })).status === 403);
  const paid = await api('POST', `/api/sales-agents/commissions/${only.body.id}/pay`, { token: admin, body: {} });
  check('จ่ายบิลที่มีแต่ค่าคอมอื่น ๆ ได้', paid.status === 200 && paid.body.status === 'PAID', paid.body);
}

/* ── แก้ดีลที่ผูกไว้แล้ว ─────────────────────────────────────
 * แก้ % / เหมาต่อรอบ / หมายเหตุได้ตรงที่แสดงดีล — มีผลกับบิลค่าคอมที่ทำหลังจากนี้เท่านั้น
 * บิลค่าคอมที่ทำไปแล้วเก็บตัวเลขไว้ในตัวเอง (ไม่เปลี่ยนตาม)
 */
section('แก้ดีลที่ผูกไว้แล้ว (% · เหมาต่อรอบ · หมายเหตุ)');
{
  const ds = await api('POST', '/api/franchises', { token: admin, body: { username: 'dealshop', password: 'dealshop-pass-1' } });
  const dfid = ds.body.franchise?.id;
  const dtok = (await shopLogin('dealshop', 'dealshop-pass-1', dfid)).body.token;
  const prod = (await api('POST', '/api/products', {
    token: admin, body: { sku: 'DEAL-P', name: 'สินค้าดีลแก้ได้', commissionPct: 10, franchiseId: dfid, startDate: '2026-01-01' },
  })).body.product;
  const holder = (await api('POST', '/api/sales-agents', { token: admin, body: { username: 'saledeal', password: 'saledeal-pass-1', name: 'เซลถือดีล' } })).body.agent;
  await api('POST', '/api/sales-agents', { token: admin, body: { username: 'saledeal2', password: 'saledeal2-pass-1', name: 'เซลอีกคน' } });
  const holderTok = (await api('POST', '/api/auth/login', { body: { username: 'saledeal', password: 'saledeal-pass-1' } })).body.token;
  const otherTok = (await api('POST', '/api/auth/login', { body: { username: 'saledeal2', password: 'saledeal2-pass-1' } })).body.token;
  const created = await api('POST', '/api/sales-agents/links', {
    token: admin, body: { salesAgentId: holder?.id, items: [{ productId: prod?.id, commissionPct: 5, fixedAmount: 300 }] },
  });
  const link = created.body.items?.[0];
  check('ตั้งฉาก: ดีล 5% + เหมา 300', created.status === 201 && link?.commissionPct === 5 && link.fixedAmount === 300, created.body);
  const e1 = (await api('POST', '/api/sales-entries', { token: admin, body: { periodCode: '2029-08-H1', productId: prod?.id, grossAmount: 10000 } })).body;
  await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: dfid, periodCode: '2029-08-H1' } });
  let cand = (await api('GET', `/api/sales-agents/${holder?.id}/commission-candidates`, { token: admin })).body;
  const itemOf = (id) => cand.items?.find((i) => i.entryId === id);
  const oldBill = await api('POST', `/api/sales-agents/${holder?.id}/commission-bills`, {
    token: admin, body: { items: [{ entryId: e1.id, mode: 'PCT', pct: itemOf(e1.id)?.deal?.pct }], fixed: [{ key: cand.fixed?.[0]?.key }] },
  });
  check('ตั้งฉาก: บิลค่าคอมก่อนแก้ดีล = 10,000 × 5% + 300 = 800', oldBill.status === 201 && oldBill.body.totalAmount === 800, oldBill.body);
  const linesOf = async () => JSON.stringify((await api('GET', `/api/sales-agents/commissions/${oldBill.body.id}`, { token: admin }))
    .body.lines?.map((l) => [l.kind, l.mode, l.pct, l.baseAmount, l.amount]));
  const before = await linesOf();

  const patchLink = (body, token = admin) => api('PATCH', `/api/sales-agents/links/${link?.id}`, { token, body });
  check('เซลแก้ดีลของตัวเองไม่ได้', (await patchLink({ commissionPct: 50 }, holderTok)).status === 403);
  check('เซลคนอื่นแก้ดีลไม่ได้', (await patchLink({ commissionPct: 50 }, otherTok)).status === 403);
  check('ร้านค้าแก้ดีลไม่ได้', (await patchLink({ commissionPct: 50 }, dtok)).status === 403);
  check('เซล/ร้านปิดดีลเองไม่ได้',
    (await api('POST', `/api/sales-agents/links/${link?.id}/end`, { token: holderTok, body: {} })).status === 403
      && (await api('POST', `/api/sales-agents/links/${link?.id}/end`, { token: dtok, body: {} })).status === 403);
  check('ดีลยังเหมือนเดิมหลังคนที่ไม่มีสิทธิ์พยายามแก้',
    (await api('GET', `/api/sales-agents/links/${link?.id}`, { token: admin })).body.commissionPct === 5);
  check('แก้จนไม่เหลือทั้ง % และเหมาไม่ได้', (await patchLink({ commissionPct: null, fixedAmount: null })).status === 400);
  check('% เกิน 100 ไม่รับ', (await patchLink({ commissionPct: 150 })).status === 400);
  const edited = await patchLink({ commissionPct: 7, fixedAmount: 400, note: 'ปรับเรต' });
  check('ส่วนกลางแก้ % · เหมาต่อรอบ · หมายเหตุ ของดีลที่ผูกไว้แล้วได้ (ยังคิดจากยอดขายเต็ม · ดีลยังเปิดอยู่)',
    edited.status === 200 && edited.body.commissionPct === 7 && edited.body.fixedAmount === 400 && edited.body.note === 'ปรับเรต'
      && edited.body.basis === 'GROSS' && edited.body.endDate === null, edited.body);
  check('แก้ดีลถูกจดประวัติ',
    db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'sales_link.update' AND entity_id = ?").get(link?.id).n === 1);
  const after = await linesOf();
  check('บิลค่าคอมที่ทำไปแล้วไม่เปลี่ยนตามดีลที่แก้',
    before === after && (await api('GET', `/api/sales-agents/commissions/${oldBill.body.id}`, { token: admin })).body.totalAmount === 800, { before, after });
  const e2 = (await api('POST', '/api/sales-entries', { token: admin, body: { periodCode: '2029-08-H2', productId: prod?.id, grossAmount: 20000 } })).body;
  await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: dfid, periodCode: '2029-08-H2' } });
  cand = (await api('GET', `/api/sales-agents/${holder?.id}/commission-candidates`, { token: admin })).body;
  check('บิลค่าคอมที่ทำหลังจากนี้ใช้ค่าตั้งต้นใหม่ (7% · เหมา 400)',
    itemOf(e2.id)?.deal?.pct === 7 && itemOf(e2.id).deal.fixedAmount === 400 && cand.fixed?.length === 1 && cand.fixed[0].amount === 400, cand);

  const ended = await api('POST', `/api/sales-agents/links/${link?.id}/end`, { token: admin, body: {} });
  check('ปิดดีลโดยไม่ต้องเลือกวันที่ (ปิดวันนี้)', ended.status === 200 && ended.body.endDate === todayTh && ended.body.isOpen === false, ended.body);
  cand = (await api('GET', `/api/sales-agents/${holder?.id}/commission-candidates`, { token: admin })).body;
  check('ปิดดีลแล้ว รายการจากบิลร้านที่ออกไปแล้วยังทำบิลค่าคอมให้เซลได้ (ป้ายดีลปิดแล้ว)',
    itemOf(e2.id)?.deal?.isOpen === false && itemOf(e2.id).deal.pct === 7, cand.items);
  const closedEdit = await patchLink({ commissionPct: 6 });
  check('ดีลที่ปิดแล้วยังแก้ตัวเลขได้ (ใช้เป็นค่าตั้งต้นของรายการเก่า)',
    closedEdit.status === 200 && closedEdit.body.commissionPct === 6 && closedEdit.body.endDate === todayTh, closedEdit.body);
}

/* ── สินค้ากลุ่ม (ชุด) ───────────────────────────────────────
 * สินค้ากลุ่มคือสินค้าหนึ่งชิ้น: กรอกยอดขายก้อนเดียว คิด % ของกลุ่มบรรทัดเดียว
 * รายการย่อยเป็นแค่เช็กลิสต์ว่าในชุดมีอะไร — บิลต้องจำรายการย่อย ณ ตอนออกบิลไว้ (แก้กลุ่มทีหลังบิลเก่าไม่เปลี่ยน)
 */
section('สินค้ากลุ่ม (ชุด) — คิดบิลก้อนเดียว ติ๊กรายการย่อย');
{
  const gs = await api('POST', '/api/franchises', { token: admin, body: { username: 'groupshop', password: 'groupshop-pass-1' } });
  const gfid = gs.body.franchise?.id;
  const gtok = (await shopLogin('groupshop', 'groupshop-pass-1', gfid)).body.token;
  const mk = (sku, extra = {}) => api('POST', '/api/products', {
    token: admin, body: { sku, name: `ชื่อ ${sku}`, commissionPct: 10, franchiseId: gfid, startDate: '2026-01-01', ...extra },
  });
  const skus = (arr) => (arr ?? []).map((x) => x.sku).join(',');
  const errOf = (r) => r.body?.error?.message ?? '';
  const i1 = (await mk('GI-1')).body.product;
  const i2 = (await mk('GI-2')).body.product;
  const i3 = (await mk('GI-3')).body.product;
  const i4 = (await mk('GI-4')).body.product;
  await api('PATCH', `/api/products/${i4?.id}`, { token: admin, body: { status: 'ARCHIVED' } });
  check('สินค้าธรรมดาไม่ใช่กลุ่ม (ไม่มีรายการย่อย)', i1?.isGroup === false && i1.items?.length === 0 && i1.inGroups?.length === 0, i1);

  const g = await mk('GSET-1', { isGroup: true, itemProductIds: [i2?.id, i1?.id, i1?.id] });
  const g1 = g.body.product;
  check('สร้างสินค้ากลุ่มพร้อมติ๊กรายการย่อย (เรียงตามที่ติ๊ก · ติ๊กซ้ำนับครั้งเดียว)',
    g.status === 201 && g1?.isGroup === true && skus(g1.items) === 'GI-2,GI-1' && g1.items[0].status === 'ACTIVE', g.body);
  const created = db.prepare("SELECT detail FROM audit_logs WHERE action = 'product.create' AND entity_id = ?").get(g1?.id);
  check('ประวัติการสร้างบอกว่าเป็นกลุ่ม และมีรายการย่อยอะไร',
    JSON.parse(created?.detail ?? '{}').isGroup === true && JSON.parse(created.detail).items?.join() === 'GI-2,GI-1', created);
  const empty = await mk('GSET-X1', { isGroup: true, itemProductIds: [] });
  check('สินค้ากลุ่มต้องมีรายการย่อยอย่างน้อย 1 รายการ',
    empty.status === 400 && errOf(empty).includes('สินค้ากลุ่มต้องมีสินค้าย่อยอย่างน้อย 1 รายการ'), empty.body);
  const nested = await mk('GSET-X2', { isGroup: true, itemProductIds: [g1?.id, i3?.id] });
  check('เอาสินค้ากลุ่มไปเป็นรายการย่อยของกลุ่มอื่นไม่ได้ (ไม่ซ้อนกลุ่ม)',
    nested.status === 400 && errOf(nested).includes('สินค้ากลุ่มใส่สินค้ากลุ่มอื่นเป็นรายการย่อยไม่ได้'), nested.body);
  const withArchived = await mk('GSET-X3', { isGroup: true, itemProductIds: [i4?.id] });
  check('สินค้าที่ปิดใช้งานแล้ว ติ๊กเข้ากลุ่มใหม่ไม่ได้', withArchived.status === 400 && errOf(withArchived).includes('GI-4'), withArchived.body);
  check('ร้านค้าสร้างสินค้ากลุ่มเองไม่ได้', (await api('POST', '/api/products', {
    token: gtok, body: { sku: 'GSET-SHOP', name: 'x', commissionPct: 1, isGroup: true, itemProductIds: [i1?.id] },
  })).status === 403);

  const toGroup = await api('PATCH', `/api/products/${i1?.id}`, { token: admin, body: { isGroup: true, itemProductIds: [i3?.id] } });
  check('สินค้าที่อยู่ในกลุ่มอยู่แล้ว เปลี่ยนเป็นสินค้ากลุ่มไม่ได้ (ต้องเอาออกจากกลุ่มก่อน)',
    toGroup.status === 400 && errOf(toGroup).includes('สินค้านี้อยู่ในสินค้ากลุ่ม') && errOf(toGroup).includes('GSET-1'), toGroup.body);
  check('ร้านค้าแก้รายการย่อยของกลุ่มไม่ได้',
    (await api('PATCH', `/api/products/${g1?.id}`, { token: gtok, body: { itemProductIds: [i3?.id] } })).status === 403);
  const replaced = await api('PATCH', `/api/products/${g1?.id}`, { token: admin, body: { itemProductIds: [i3?.id, i2?.id] } });
  check('แก้รายการย่อย = แทนที่ทั้งรายการ', replaced.status === 200 && skus(replaced.body.items) === 'GI-3,GI-2', replaced.body);
  const itemsAudit = db.prepare("SELECT detail FROM audit_logs WHERE action = 'product.group_items' AND entity_id = ? ORDER BY id DESC").get(g1?.id);
  check('ประวัติบอกว่าเพิ่ม/เอาออกรายการไหน',
    JSON.stringify(JSON.parse(itemsAudit?.detail ?? '{}')) === JSON.stringify({ sku: 'GSET-1', added: ['GI-3'], removed: ['GI-1'] }), itemsAudit);
  const listed = (await api('GET', '/api/products', { token: admin })).body.items ?? [];
  check('รายการสินค้าบอกว่าสินค้าไหนอยู่ในกลุ่มไหน',
    skus(listed.find((p) => p.sku === 'GI-2')?.inGroups) === 'GSET-1' && skus(listed.find((p) => p.sku === 'GSET-1')?.items) === 'GI-3,GI-2',
    listed.filter((p) => /^G/.test(p.sku)).map((p) => [p.sku, skus(p.items), skus(p.inGroups)]));
  const shopGroups = (await api('GET', '/api/products?isGroup=1', { token: gtok })).body.items ?? [];
  check('ร้านเห็นสินค้ากลุ่มของตัวเองพร้อมรายการย่อย', shopGroups.length === 1 && skus(shopGroups[0].items) === 'GI-3,GI-2', shopGroups);

  // ยอดขายของกลุ่ม = ก้อนเดียว → บิลบรรทัดเดียว % ของกลุ่ม + บอกว่าในชุดมีอะไร
  const ge = await api('POST', '/api/sales-entries', { token: admin, body: { periodCode: '2029-07-H1', productId: g1?.id, grossAmount: 10000 } });
  check('กรอกยอดขายของสินค้ากลุ่มเป็นยอดรวมก้อนเดียว (10,000 × 10% = 1,000)',
    ge.status === 201 && ge.body.isGroup === true && skus(ge.body.components) === 'GI-3,GI-2' && ge.body.commissionAmount === 1000, ge.body);
  const gbill = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: gfid, periodCode: '2029-07-H1' } });
  const gline = gbill.body.lines?.find((l) => l.productId === g1?.id);
  check('บิลแสดงสินค้ากลุ่มบรรทัดเดียว พร้อมรายการย่อย',
    gbill.status === 201 && gbill.body.lines?.length === 1 && gline?.isGroup === true && skus(gline.components) === 'GI-3,GI-2'
      && gbill.body.commissionTotal === 1000, gbill.body);
  await api('PATCH', `/api/products/${g1?.id}`, { token: admin, body: { itemProductIds: [i1?.id] } });
  const oldView = await api('GET', `/api/invoices/${gbill.body.id}`, { token: admin });
  check('แก้รายการย่อยหลังออกบิล — บิลเดิมยังแสดงรายการย่อย ณ ตอนออกบิล',
    skus(oldView.body.lines?.find((l) => l.productId === g1?.id)?.components) === 'GI-3,GI-2', oldView.body.lines);
  const shopView = await api('GET', `/api/invoices/${gbill.body.id}`, { token: gtok });
  check('ร้านเห็นรายการย่อยของสินค้ากลุ่มในบิลของตัวเอง',
    shopView.status === 200 && skus(shopView.body.lines?.find((l) => l.productId === g1?.id)?.components) === 'GI-3,GI-2', shopView.body.lines);
  check('ร้านอื่นเปิดบิลนี้ไม่ได้', (await api('GET', `/api/invoices/${gbill.body.id}`, { token: tokenB })).status === 403);
}

/* ── ทำงานพร้อมกันหลายจอ ───────────────────────────────────
 * php -S ของชุดเทสต์รับทีละคำขอ — จำลองสองจอด้วยสองโปรเซส (e2e:call) ที่วิ่งพร้อมกัน
 * โปรเซสที่สามถือล็อกแถวไว้ก่อน สองจอจึงอ่านข้อมูลก่อนล็อกแล้วไปรอคิวพร้อมกันแน่นอน (ไม่ขึ้นกับจังหวะเครื่อง)
 */
async function whileRowLocked(table, id, work, seconds = 4) {
  const marker = path.join(stack.dataDir, `row-lock-${table}-${id}-${Date.now()}`);
  const holder = call('holdRowLock', { table, id, seconds, marker });
  for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const locked = fs.existsSync(marker);
  const results = await work();
  await holder;
  return { locked, results };
}
const settle = (promise) => promise.then((ok) => ({ ok }), (err) => ({ err: err.message }));

section('ทำงานพร้อมกันหลายจอ: ยอดบิลไม่ทับกัน · บิลค่าคอมไม่จ่ายซ้ำ · ทรานแซกชันไม่ commit ครึ่ง ๆ');
{
  const probe = await call('txProbe');
  check('คำสั่งฐานข้อมูลที่พังกลางทรานแซกชัน → โยน error และไม่มีอะไรถูกบันทึก (ทั้งก่อนและหลังคำสั่งที่พัง)',
    probe?.threw === true && probe.leftover === 0, probe);

  const rs = await api('POST', '/api/franchises', { token: admin, body: { username: 'raceshop', password: 'raceshop-pass-1' } });
  const rfid = rs.body.franchise?.id;
  const mk = async (sku, pct) => (await api('POST', '/api/products', {
    token: admin, body: { sku, name: `สินค้าพร้อมกัน ${sku}`, commissionPct: pct, franchiseId: rfid, startDate: '2026-01-01' },
  })).body.product;
  const [rp1, rp2, rp3] = [await mk('RACE-1', 10), await mk('RACE-2', 5), await mk('RACE-3', 10)];
  const entryOf = async (productId, grossAmount, periodCode = '2029-05-H1') => (await api('POST', '/api/sales-entries', {
    token: admin, body: { periodCode, productId, grossAmount },
  })).body;
  const re1 = await entryOf(rp1?.id, 1000);
  const re2 = await entryOf(rp2?.id, 400);
  const rinv = await api('POST', '/api/invoices/generate', {
    token: admin, body: { franchiseId: rfid, periodCode: '2029-05-H1', adjustments: [{ kind: 'CHARGE', label: 'ค่าบริการ 10%', pct: 10 }] },
  });
  // 1,000 × 10% = 100 · 400 × 5% = 20 → 120 · ค่าบริการ 10% = 12 → 132
  check('ตั้งฉาก: บิล 2 บรรทัด ส่วนต่าง 120 + ค่าบริการ 10% = 132',
    rinv.status === 201 && rinv.body.commissionTotal === 120 && rinv.body.chargeTotal === 12 && rinv.body.netTotal === 132, rinv.body);

  // สองจอแก้คนละบรรทัดของบิลเดียวพร้อมกัน — ยอดรวมต้องรวมของทั้งสองจอ (50 + 0 = 50 · ค่าบริการ 5 · สุทธิ 55)
  const lineRace = await whileRowLocked('invoices', rinv.body.id, () => Promise.all([
    settle(call('updateInvoiceLine', { invoiceId: rinv.body.id, entryId: re1.id, input: { mode: 'MANUAL', amount: 50 } })),
    settle(call('updateInvoiceLine', { invoiceId: rinv.body.id, entryId: re2.id, input: { mode: 'MANUAL', amount: 0 } })),
  ]));
  const afterRace = (await api('GET', `/api/invoices/${rinv.body.id}`, { token: admin })).body;
  const lineSum = db.prepare('SELECT COALESCE(SUM(commission_amount_satang), 0) AS s FROM sales_entries WHERE invoice_id = ?').get(rinv.body.id).s;
  check('สองจอแก้วิธีคิดยอดคนละบรรทัดพร้อมกัน → ยอดบิลรวมของทั้งสองจอ (50 · ค่าบริการ 5 · สุทธิ 55) ไม่ทับกัน',
    lineRace.locked && lineRace.results.every((r) => r.ok) && afterRace.commissionTotal === 50 && Number(lineSum) === 5000
      && afterRace.chargeTotal === 5 && afterRace.netTotal === 55,
    { results: lineRace.results.map((r) => r.err ?? 'ok'), commission: afterRace.commissionTotal, lineSum, charge: afterRace.chargeTotal, net: afterRace.netTotal });

  // สองจอทำบิลค่าคอมจากรายการเดียวกันพร้อมกัน — ได้บิลเดียว อีกจอได้ 409 ไม่มีบิลผีที่ยอดไม่ตรงกับรายการ
  const agent = (await api('POST', '/api/sales-agents', { token: admin, body: { username: 'salerace', password: 'salerace-pass-1', name: 'เซลพร้อมกัน' } })).body.agent;
  await api('POST', '/api/sales-agents/links', { token: admin, body: { salesAgentId: agent?.id, items: [{ productId: rp3?.id, commissionPct: 5, fixedAmount: 200 }] } });
  const re3 = await entryOf(rp3?.id, 8000, '2029-05-H2');
  await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: rfid, periodCode: '2029-05-H2' } });
  const rcand = (await api('GET', `/api/sales-agents/${agent?.id}/commission-candidates`, { token: admin })).body;
  const billInput = { items: [{ entryId: re3.id, mode: 'PCT', pct: 5 }], fixed: [{ key: rcand.fixed?.[0]?.key }] };
  check('ตั้งฉาก: รายการและเหมาต่อรอบของเซลพร้อมให้ติ๊ก',
    rcand.items?.some((i) => i.entryId === re3.id) && rcand.fixed?.length === 1, rcand);
  const billRace = await whileRowLocked('sales_agents', agent?.id, () => Promise.all([
    settle(call('createCommissionBill', { agentId: agent?.id, input: billInput })),
    settle(call('createCommissionBill', { agentId: agent?.id, input: billInput })),
  ]));
  const okBills = billRace.results.filter((r) => r.ok);
  const bills = db.prepare("SELECT id, status, total_satang FROM sales_commissions WHERE kind = 'BILL' AND sales_agent_id = ?").all(agent?.id);
  const mismatched = db.prepare(`SELECT COUNT(*) AS n FROM sales_commissions c
      WHERE c.kind = 'BILL' AND c.sales_agent_id = ?
        AND c.total_satang <> (SELECT COALESCE(SUM(l.amount_satang), 0) FROM sales_commission_lines l WHERE l.commission_id = c.id)`).get(agent?.id).n;
  check('สองจอทำบิลค่าคอมจากรายการเดียวกันพร้อมกัน → ได้บิลเดียว (600 = 8,000 × 5% + เหมา 200) อีกจอได้ "เพิ่งถูกทำบิลค่าคอมไปแล้ว"',
    billRace.locked && okBills.length === 1 && okBills[0].ok.totalAmount === 600
      && billRace.results.some((r) => /เพิ่งถูกทำบิลค่าคอมไปแล้ว/.test(r.err ?? '')) && bills.length === 1,
    { results: billRace.results.map((r) => r.err ?? r.ok?.billNo), bills });
  check('ไม่มีบิลค่าคอมที่ยอดหัวบิลไม่ตรงกับผลรวมรายการ และไม่มีประวัติชี้บิลที่ไม่มีอยู่จริง',
    Number(mismatched) === 0
      && db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'sales_commission.bill_create' AND (entity_id = 0 OR entity_id IS NULL)").get().n === 0,
    { mismatched });
}

/* ── ข้อมูลเก่า/ขอบ ๆ ของเซล ────────────────────────────────
 * ชื่อเซลยาว (เลขบิลค่าคอม VARCHAR(64)) · ดีลที่ยังไม่ถึงวันเริ่ม (จากหน้าเว็บรุ่นก่อน) · ค่าคอมแบบเก่าหลังออกบิลร้านใหม่
 */
section('เซล: ชื่อยาว · ปิดดีลที่ยังไม่ถึงวันเริ่ม · ค่าคอมแบบเก่าหลังยกเลิกแล้วออกบิลร้านใหม่');
{
  const name40 = `s${'x'.repeat(39)}`;
  check('ชื่อผู้ใช้เซลยาวเกิน 40 ตัวไม่รับ (ชื่ออยู่ในเลขบิลค่าคอม)',
    (await api('POST', '/api/sales-agents', { token: admin, body: { username: `${name40}y`, password: 'longname-pass-1', name: 'ชื่อยาวเกิน' } })).status === 400);
  const longAgent = (await api('POST', '/api/sales-agents', { token: admin, body: { username: name40, password: 'longname-pass-1', name: 'ชื่อยาว 40' } })).body.agent;
  const billOther = (agentId, amount) => api('POST', `/api/sales-agents/${agentId}/commission-bills`, {
    token: admin, body: { others: [{ label: 'ค่าแนะนำ', amount }] },
  });
  const lb1 = await billOther(longAgent?.id, 100);
  const lb2 = await billOther(longAgent?.id, 200);
  check('เซลชื่อยาว 40 ตัว ทำบิลค่าคอมได้ วันเดียวกันใบที่สองต่อท้าย -2',
    lb1.status === 201 && lb1.body.billNo === `COM-${todayTh.replace(/-/g, '')}-${name40}` && lb2.status === 201 && lb2.body.billNo?.endsWith(`${name40}-2`),
    [lb1.body, lb2.body].map((b) => b.billNo ?? b));
  // เซลเก่าที่ชื่อยาวกว่านั้น (สร้างก่อนมีเพดาน — username รับได้ถึง 100 ตัว)
  const name90 = `legacy${'z'.repeat(84)}`;
  db.prepare('UPDATE sales_agents SET username = ? WHERE id = ?').run(name90, longAgent?.id);
  const lb3 = await billOther(longAgent?.id, 300);
  check('เซลเก่าที่ชื่อยาว 90 ตัว ยังทำบิลค่าคอมได้ (ตัดชื่อในเลขบิล ไม่ใช่ 404/500)',
    lb3.status === 201 && lb3.body.totalAmount === 300 && lb3.body.billNo?.length <= 64 && lb3.body.billNo.startsWith(`COM-${todayTh.replace(/-/g, '')}-legacy`),
    lb3.body);

  // ดีลที่ตั้งวันเริ่มไว้ในอนาคต — หน้าเว็บตอนนี้ไม่มีช่องวันที่ ปุ่ม "ปิดดีล" ต้องใช้ได้
  const fs1 = await api('POST', '/api/franchises', { token: admin, body: { username: 'futureshop', password: 'futureshop-pass-1' } });
  const ffid = fs1.body.franchise?.id;
  const fprod = (await api('POST', '/api/products', {
    token: admin, body: { sku: 'FUTURE-P', name: 'สินค้าดีลอนาคต', commissionPct: 10, franchiseId: ffid, startDate: '2026-01-01' },
  })).body.product;
  const fa = (await api('POST', '/api/sales-agents', { token: admin, body: { username: 'salefuture', password: 'salefuture-pass-1', name: 'เซลดีลอนาคต' } })).body.agent;
  const fb = (await api('POST', '/api/sales-agents', { token: admin, body: { username: 'salefuture2', password: 'salefuture2-pass-1', name: 'เซลคนถัดไป' } })).body.agent;
  const future = new Date(Date.parse(todayTh) + 17 * 86400000).toISOString().slice(0, 10);
  const fl = (await api('POST', '/api/sales-agents/links', {
    token: admin, body: { salesAgentId: fa?.id, startDate: future, items: [{ productId: fprod?.id, commissionPct: 5 }] },
  })).body.items?.[0];
  check('ตั้งฉาก: ดีลที่เริ่มในอนาคต', fl?.startDate === future && fl.isOpen === true, fl);
  const fend = await api('POST', `/api/sales-agents/links/${fl?.id}/end`, { token: admin, body: {} });
  check('กดปิดดีลที่ยังไม่ถึงวันเริ่มได้ (ยกเลิกดีลที่ยังไม่เริ่ม — ไม่ใช่ 400 "วันปิดต้องไม่ก่อนวันเริ่ม")',
    fend.status === 200 && fend.body.endDate === todayTh && fend.body.startDate === todayTh && fend.body.isOpen === false && fend.body.isActive === false, fend.body);
  const faudit = db.prepare("SELECT detail FROM audit_logs WHERE action = 'sales_link.end' AND entity_id = ? ORDER BY id DESC").get(fl?.id);
  check('ประวัติจดวันเริ่มเดิมของดีลที่ถูกยกเลิก', JSON.parse(faudit?.detail ?? '{}').cancelledBeforeStart === future, faudit);
  const fnext = await api('POST', '/api/sales-agents/links', { token: admin, body: { salesAgentId: fb?.id, items: [{ productId: fprod?.id, commissionPct: 6 }] } });
  check('ปิดแล้วผูกสินค้านี้ให้เซลคนอื่นได้ในวันเดียวกัน', fnext.status === 201 && fnext.body.items?.[0]?.salesAgentId === fb?.id, fnext.body);
  check('กดปิดซ้ำ = ไม่ทำอะไร (ไม่ error)', (await api('POST', `/api/sales-agents/links/${fl?.id}/end`, { token: admin, body: {} })).status === 200);

  // ค่าคอมแบบเก่า (DEAL) ที่จ่ายไปแล้วในระบบเดิม — ยกเลิกบิลร้านแล้วออกใหม่ รายการเดิมต้องไม่กลับมาให้จ่ายซ้ำ
  const ls = await api('POST', '/api/franchises', { token: admin, body: { username: 'legacyshop', password: 'legacyshop-pass-1' } });
  const lfid = ls.body.franchise?.id;
  const lprod = (await api('POST', '/api/products', {
    token: admin, body: { sku: 'LEGACY-P', name: 'สินค้าค่าคอมเก่า', commissionPct: 10, franchiseId: lfid, startDate: '2026-01-01' },
  })).body.product;
  const la = (await api('POST', '/api/sales-agents', { token: admin, body: { username: 'salelegacy', password: 'salelegacy-pass-1', name: 'เซลระบบเดิม' } })).body.agent;
  await api('POST', '/api/sales-agents/links', { token: admin, body: { salesAgentId: la?.id, items: [{ productId: lprod?.id, commissionPct: 5, fixedAmount: 100 }] } });
  const lentry = (await api('POST', '/api/sales-entries', { token: admin, body: { periodCode: '2029-06-H1', productId: lprod?.id, grossAmount: 6000 } })).body;
  const linv = (await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: lfid, periodCode: '2029-06-H1' } })).body;
  const lrow = db.prepare('SELECT franchise_id, period_id FROM invoices WHERE id = ?').get(linv.id);
  db.prepare(`INSERT INTO sales_commissions
      (sales_agent_id, franchise_id, period_id, invoice_id, kind, basis, base_amount_satang, commission_pct_bp,
       pct_amount_satang, fixed_satang, total_satang, status, paid_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'DEAL', 'GROSS', 600000, 500, 30000, 10000, 40000, 'PAID', '2029-06-20', UTC_TIMESTAMP(), UTC_TIMESTAMP())`)
    .run(la?.id, lrow.franchise_id, lrow.period_id, linv.id);
  const lcandOf = async () => (await api('GET', `/api/sales-agents/${la?.id}/commission-candidates`, { token: admin })).body;
  let lcand = await lcandOf();
  check('ตั้งฉาก: รายการที่จ่ายไปแล้วในระบบเดิม (แถว DEAL) ไม่อยู่ในรายการที่ติ๊กได้',
    !lcand.items?.some((i) => i.entryId === lentry.id) && lcand.fixed?.length === 0, lcand);
  await api('POST', `/api/invoices/${linv.id}/void`, { token: admin, body: { reason: 'ทดสอบออกบิลใหม่หลังจ่ายค่าคอมแบบเก่า' } });
  const lreissue = await api('POST', '/api/invoices/generate', { token: admin, body: { franchiseId: lfid, periodCode: '2029-06-H1' } });
  lcand = await lcandOf();
  const lagent = (await api('GET', `/api/sales-agents/${la?.id}`, { token: admin })).body;
  check('ยกเลิกบิลร้านแล้วออกใหม่ → รายการที่จ่ายไปแล้วในระบบเดิมยังติ๊กซ้ำไม่ได้ (ทั้งรายการสินค้าและเหมาต่อรอบ · ตัวเลขข้างชื่อเซลเป็น 0)',
    lreissue.status === 201 && lreissue.body.id !== linv.id && !lcand.items?.some((i) => i.entryId === lentry.id)
      && lcand.fixed?.length === 0 && lagent.uncommissionedCount === 0,
    { items: lcand.items, fixed: lcand.fixed, count: lagent.uncommissionedCount });
}

/* ── ยอดส่วนต่างที่กรอกเอง (R21 · รุ่น 2.3.0) ────────────────────
 * หน้ายอดขายมีช่องที่สอง "ยอดส่วนต่างที่กรอกเอง" (manualAmount) — ยอดเต็ม × % ยังอยู่ ตอนออกบิลเลือกได้ทีละบรรทัด
 * manual_amount_satang = ค่าของหน้ายอดขาย · bill_mode + commission_amount_satang = ยอดที่ใช้ออกบิลจริง
 */
section('ยอดส่วนต่างที่กรอกเองในหน้ายอดขาย (เลือกตอนออกบิล)');
{
  const ms = await api('POST', '/api/franchises', { token: admin, body: { username: 'manualshop', password: 'manualshop-pass-1' } });
  const mfid = ms.body.franchise?.id;
  const mtok = (await shopLogin('manualshop', 'manualshop-pass-1', mfid)).body.token;
  const mk = async (sku, pct) => (await api('POST', '/api/products', {
    token: admin, body: { sku, name: `สินค้ายอดกรอกเอง ${sku}`, commissionPct: pct, franchiseId: mfid, startDate: '2026-01-01' },
  })).body.product;
  const [m1, m2, m3, m4, m5] = [await mk('MAN-1', 12.5), await mk('MAN-2', 10), await mk('MAN-3', 20), await mk('MAN-4', 10), await mk('MAN-5', 10)];
  const MP = '2029-09-H1';
  const up = (body, token = admin) => api('POST', '/api/sales-entries', { token, body: { periodCode: MP, ...body } });
  const entryRow = (id) => db.prepare('SELECT gross_amount_satang AS g, manual_amount_satang AS m, bill_mode AS mode, commission_amount_satang AS c FROM sales_entries WHERE id = ?').get(id);
  const lastAudit = (action, id) => JSON.parse(db.prepare('SELECT detail FROM audit_logs WHERE action = ? AND entity_id = ? ORDER BY id DESC LIMIT 1').get(action, id)?.detail ?? '{}');
  const readyOf = async () => (await api('GET', `/api/invoices/readiness?periodCode=${MP}`, { token: admin })).body.items?.find((i) => i.franchiseId === mfid);
  const lineOf = (body, id) => body?.lines?.find((l) => l.id === id);

  // บันทึกยอด: ยอดเต็มยังบังคับ · ช่องที่สองไม่บังคับ
  const e1 = (await up({ productId: m1?.id, grossAmount: 100000, manualAmount: 8000 })).body;
  check('กรอกยอดส่วนต่างเอง → ออกบิลจะใช้ยอดนั้น (MANUAL 8,000) · ยังบอกยอดเต็ม × % (100,000 × 12.5% = 12,500) ให้เทียบ',
    e1.billMode === 'MANUAL' && e1.commissionAmount === 8000 && e1.manualAmount === 8000 && e1.pctAmount === 12500
      && e1.grossAmount === 100000 && e1.netAmount === 92000, e1);
  const e3 = (await up({ productId: m3?.id, grossAmount: 4000 })).body;
  check('ไม่กรอกช่องที่สอง → คิดจากยอดเต็ม × % แบบเดิม (PCT 800 · manualAmount = null)',
    e3.billMode === 'PCT' && e3.commissionAmount === 800 && e3.pctAmount === 800 && e3.manualAmount === null, e3);
  check('ประวัติการบันทึกยอดจดยอดที่กรอกเองไว้ (entry.create · manualSatang)',
    lastAudit('entry.create', e1.id).manualSatang === 800000 && lastAudit('entry.create', e3.id).manualSatang === null);

  // กติกาเดียวกับ "กรอกยอดเอง" ตอนออกบิล — ผิดแล้วไม่มีรายการถูกบันทึก
  const bad = [
    ['ยอดที่กรอกเองติดลบบนยอดขายปกติไม่ได้', { grossAmount: 20000, manualAmount: -1 }],
    ['ยอดที่กรอกเองเกินยอดเต็มไม่ได้', { grossAmount: 20000, manualAmount: 20000.01 }],
    ['ยอดเต็มติดลบ (คืนของ) กรอกยอดเองเป็นบวกไม่ได้', { grossAmount: -500, manualAmount: 100 }],
    ['ยอดเต็มเป็น 0 กรอกยอดเองอย่างอื่นนอกจาก 0 ไม่ได้', { grossAmount: 0, manualAmount: 1 }],
    ['ยอดที่กรอกเองเกิน 100 ล้านบาทไม่ได้ (แม้ยอดเต็มสูงกว่า)', { grossAmount: 200000000, manualAmount: 100000000.01 }],
    ['ตัวเลขยาวผิดปกติ → 400 บอกว่าเกินกำหนด (ไม่ใช่ระบบพัง)', { grossAmount: 20000, manualAmount: 1e15 }],
  ];
  for (const [label, body] of bad) {
    const r = await up({ productId: m2?.id, ...body });
    check(label, r.status === 400 && /ยอดส่วนต่างที่กรอกเอง/.test(r.body?.error?.message ?? ''), r.body);
  }
  check('ตรวจไม่ผ่านแล้วไม่มีรายการถูกบันทึก',
    db.prepare('SELECT COUNT(*) AS n FROM sales_entries WHERE product_id = ?').get(m2?.id).n === 0);
  const neg = await up({ productId: m4?.id, grossAmount: -1000, manualAmount: -300 });
  const zero = await up({ productId: m4?.id, grossAmount: -1000, manualAmount: 0 });
  check('ยอดเต็มติดลบกรอกยอดเองติดลบได้ (ไม่เกินยอดเต็ม) · กรอก 0 ได้เสมอ',
    neg.status === 201 && neg.body.billMode === 'MANUAL' && neg.body.commissionAmount === -300
      && zero.status === 201 && zero.body.commissionAmount === 0 && zero.body.manualAmount === 0, [neg.body, zero.body]);
  await api('DELETE', `/api/sales-entries/${zero.body.id}`, { token: admin });

  // ไม่ส่งคีย์ = คงค่าเดิม · แก้ยอดเต็มจนยอดที่กรอกไว้ใช้ไม่ได้ = 400 (ไม่ล้างให้เงียบ ๆ)
  const keep = await up({ productId: m1?.id, grossAmount: 90000 });
  check('แก้ยอดเต็มโดยไม่ส่งช่องที่สอง → ยอดที่กรอกไว้ยังอยู่ (MANUAL 8,000 · ยอดเต็ม × % = 11,250)',
    keep.status === 201 && keep.body.manualAmount === 8000 && keep.body.billMode === 'MANUAL'
      && keep.body.commissionAmount === 8000 && keep.body.pctAmount === 11250, keep.body);
  const shrink = await up({ productId: m1?.id, grossAmount: 5000 });
  const flip = await up({ productId: m1?.id, grossAmount: -5000 });
  check('แก้ยอดเต็มจนยอดที่กรอกไว้เกิน/คนละเครื่องหมาย → 400 บอกให้แก้หรือล้างช่องยอดส่วนต่าง · รายการไม่เปลี่ยน',
    shrink.status === 400 && /ยอดส่วนต่างที่กรอกเอง/.test(shrink.body?.error?.message ?? '') && flip.status === 400
      && Number(entryRow(e1.id).g) === 9000000 && Number(entryRow(e1.id).m) === 800000, [shrink.body, flip.body]);
  const both = await up({ productId: m1?.id, grossAmount: 5000, manualAmount: 4000 });
  check('แก้ยอดเต็มพร้อมยอดที่กรอกเองในครั้งเดียวได้', both.status === 201 && both.body.commissionAmount === 4000 && both.body.grossAmount === 5000, both.body);
  await up({ productId: m1?.id, grossAmount: 90000, manualAmount: 8000 });

  const e2 = (await up({ productId: m2?.id, grossAmount: 20000, manualAmount: 1500 })).body;
  const cleared = await up({ productId: m2?.id, grossAmount: 20000, manualAmount: null });
  check('ล้างช่องที่สอง (null) → กลับไปคิดจากยอดเต็ม × % (20,000 × 10% = 2,000)',
    e2.billMode === 'MANUAL' && cleared.status === 201 && cleared.body.billMode === 'PCT' && cleared.body.commissionAmount === 2000
      && cleared.body.manualAmount === null && entryRow(e2.id).m === null, cleared.body);
  check('ประวัติการแก้ยอดจดว่าล้างยอดที่กรอกเอง (entry.update · manualSatang = null)',
    'manualSatang' in lastAudit('entry.update', e2.id) && lastAudit('entry.update', e2.id).manualSatang === null, lastAudit('entry.update', e2.id));

  const bulk = await api('POST', '/api/sales-entries/bulk', {
    token: admin,
    body: { items: [
      { periodCode: MP, productId: m2?.id, grossAmount: 20000, manualAmount: 1500 },
      { periodCode: MP, productId: m3?.id, grossAmount: 4000, manualAmount: null },
      { periodCode: MP, productId: m5?.id, grossAmount: 3000, manualAmount: 3000.01 },
    ] },
  });
  const bsaved = (pid) => bulk.body?.saved?.find((s) => s.productId === pid);
  check('บันทึกยอดทั้งหมด: ส่งยอดที่กรอกเองรายแถวได้ · แถวที่ผิดบอกเป็นรายแถว ไม่ล้มทั้งชุด (207)',
    bulk.status === 207 && bulk.body.saved?.length === 2 && bulk.body.errors?.length === 1 && bulk.body.errors[0].productId === m5?.id
      && bsaved(m2?.id)?.billMode === 'MANUAL' && bsaved(m2?.id)?.commissionAmount === 1500
      && bsaved(m3?.id)?.billMode === 'PCT' && bsaved(m3?.id)?.manualAmount === null, bulk.body);
  /*
   * ทางบันทึกทั้งหมดต้องแยก "ไม่ส่งคีย์" กับ null แบบเดียวกับทีละแถว — ข้อบนส่ง null ให้แถวที่ไม่มียอดที่กรอกไว้อยู่แล้ว
   * จึงยังไม่พิสูจน์ว่า null ล้างได้จริง (ถ้า null ถูกตีเป็น "ไม่ส่ง" หน้าเว็บจะลบยอดที่กรอกไว้ไม่ได้เลย และยอดเก่ากลับมาเงียบ ๆ)
   */
  const bulkKeep = await api('POST', '/api/sales-entries/bulk', {
    token: admin,
    body: { items: [
      { periodCode: MP, productId: m2?.id, grossAmount: 20000 },
      { periodCode: MP, productId: m1?.id, grossAmount: 90000, manualAmount: null },
    ] },
  });
  const bkSaved = (pid) => bulkKeep.body?.saved?.find((s) => s.productId === pid);
  check('บันทึกยอดทั้งหมด: ไม่ส่งคีย์ = คงยอดที่กรอกไว้ (MAN-2 1,500) · null = ล้างจริงกลับเป็น % (MAN-1 90,000 × 12.5% = 11,250)',
    bulkKeep.status === 201 && bkSaved(m2?.id)?.billMode === 'MANUAL' && bkSaved(m2?.id)?.manualAmount === 1500
      && bkSaved(m1?.id)?.billMode === 'PCT' && bkSaved(m1?.id)?.commissionAmount === 11250 && bkSaved(m1?.id)?.manualAmount === null
      && entryRow(e1.id).m === null, bulkKeep.body);
  const bulkShrink = await api('POST', '/api/sales-entries/bulk', {
    token: admin, body: { items: [{ periodCode: MP, productId: m2?.id, grossAmount: 1000 }] },
  });
  check('บันทึกยอดทั้งหมด: แก้ยอดเต็มจนยอดที่กรอกไว้เกิน → แถวนั้นไม่ผ่าน (207 + ข้อความยอดส่วนต่าง) · รายการไม่เปลี่ยน',
    bulkShrink.status === 207 && bulkShrink.body.saved?.length === 0
      && /ยอดส่วนต่างที่กรอกเอง/.test(bulkShrink.body.errors?.[0]?.message ?? '')
      && Number(entryRow(e2.id).g) === 2000000 && Number(entryRow(e2.id).m) === 150000, bulkShrink.body);
  await up({ productId: m1?.id, grossAmount: 90000, manualAmount: 8000 });

  const shopUp =await up({ productId: m1?.id, grossAmount: 90000, manualAmount: 1 }, mtok);
  const shopBulk = await api('POST', '/api/sales-entries/bulk', {
    token: mtok, body: { items: [{ periodCode: MP, productId: m1?.id, grossAmount: 90000, manualAmount: 1 }] },
  });
  check('ร้านกรอกยอดส่วนต่างเองไม่ได้ (403 ทั้งทีละแถวและทั้งหมด) · ยอดที่กรอกไว้ไม่ขยับ',
    shopUp.status === 403 && shopBulk.status === 403 && Number(entryRow(e1.id).m) === 800000, [shopUp.status, shopBulk.status]);
  let dbRejected = false;
  try { db.prepare('UPDATE sales_entries SET manual_amount_satang = gross_amount_satang + 1 WHERE id = ?').run(e1.id); } catch { dbRejected = true; }
  check('ฐานข้อมูลกันยอดที่กรอกเองเกินยอดเต็มอีกชั้น (CHECK ck_entries_manual)', dbRejected && Number(entryRow(e1.id).m) === 800000);

  let ready = await readyOf();
  check('หน้าพร้อมออกบิลนับรายการที่ใช้ยอดที่กรอกไว้ (manualCount 2) · ยอดรอออกบิลใช้ยอดนั้น (8,000 + 1,500 + 800 = 10,300)',
    ready?.manualCount === 2 && ready.pendingCommission === 10300 && ready.status === 'READY', ready);

  // ออกบิล: ไม่ส่งวิธีคิด = ยอดที่กรอกไว้ · เลือก % = ยอดเต็ม × %
  const gen = await api('POST', '/api/invoices/generate', {
    token: admin, body: { franchiseId: mfid, periodCode: MP, entryIds: [e1.id, e2.id], lines: [{ entryId: e1.id, mode: 'PCT' }] },
  });
  const inv = gen.body?.id;
  check('ออกบิล: บรรทัดที่ไม่เลือกวิธีคิดใช้ยอดที่กรอกไว้เป็นค่าตั้งต้น (MAN-2 → 1,500)',
    gen.status === 201 && lineOf(gen.body, e2.id)?.billMode === 'MANUAL' && lineOf(gen.body, e2.id)?.commissionAmount === 1500, gen.body);
  check('ออกบิล: เลือก "คิดจากยอดเต็ม × %" ให้บรรทัดที่กรอกยอดไว้ → 90,000 × 12.5% = 11,250 (รวม 12,750)',
    lineOf(gen.body, e1.id)?.billMode === 'PCT' && lineOf(gen.body, e1.id)?.commissionAmount === 11250 && gen.body?.commissionTotal === 12750, gen.body);
  check('เลือกวิธีคิดตอนออกบิลไม่แก้ยอดที่กรอกไว้ในหน้ายอดขาย · บรรทัดบิลของส่วนกลางบอกทั้งสองยอด',
    Number(entryRow(e1.id).m) === 800000 && lineOf(gen.body, e1.id)?.manualAmount === 8000 && lineOf(gen.body, e1.id)?.pctAmount === 11250,
    lineOf(gen.body, e1.id));

  const toPreset = await api('PATCH', `/api/invoices/${inv}/lines/${e1.id}`, { token: admin, body: { mode: 'MANUAL' } });
  check('แก้บรรทัดเป็น "กรอกยอดเอง" โดยไม่ใส่จำนวนเงิน = ใช้ยอดที่กรอกไว้ 8,000 (รวม 9,500) · ประวัติบอกว่าใช้ยอดที่กรอกไว้',
    toPreset.status === 200 && lineOf(toPreset.body, e1.id)?.billMode === 'MANUAL' && lineOf(toPreset.body, e1.id)?.commissionAmount === 8000
      && toPreset.body.commissionTotal === 9500 && lastAudit('invoice.line.update', inv).preset === true, toPreset.body);
  const backPct = await api('PATCH', `/api/invoices/${inv}/lines/${e1.id}`, { token: admin, body: { mode: 'PCT' } });
  check('สลับกลับเป็น % ได้ (11,250 · รวม 12,750) · ยอดที่กรอกไว้ยังอยู่',
    backPct.status === 200 && lineOf(backPct.body, e1.id)?.commissionAmount === 11250 && backPct.body.commissionTotal === 12750
      && Number(entryRow(e1.id).m) === 800000, backPct.body);
  const typed = await api('PATCH', `/api/invoices/${inv}/lines/${e2.id}`, { token: admin, body: { mode: 'MANUAL', amount: 1000 } });
  check('พิมพ์จำนวนเงินอื่นตอนแก้บรรทัด → บิลใช้ 1,000 แต่ยอดที่กรอกไว้ในหน้ายอดขายยังเป็น 1,500',
    typed.status === 200 && lineOf(typed.body, e2.id)?.commissionAmount === 1000 && lineOf(typed.body, e2.id)?.manualAmount === 1500
      && Number(entryRow(e2.id).m) === 150000 && lastAudit('invoice.line.update', inv).preset === false, lineOf(typed.body, e2.id));

  const noPreset = await api('POST', `/api/invoices/${inv}/lines`, {
    token: admin, body: { entryIds: [e3.id], lines: [{ entryId: e3.id, mode: 'MANUAL' }] },
  });
  check('"กรอกยอดเอง" ไม่ใส่จำนวนเงิน กับรายการที่ไม่ได้กรอกยอดไว้ → 400 ต้องใส่จำนวนเงิน (เหมือนเดิม)',
    noPreset.status === 400 && /ต้องใส่จำนวนเงิน/.test(noPreset.body?.error?.message ?? ''), noPreset.body);
  const e5 = (await up({ productId: m5?.id, grossAmount: 3000, manualAmount: 250 })).body;
  const added = await api('POST', `/api/invoices/${inv}/lines`, {
    token: admin, body: { entryIds: [e5.id, e3.id], lines: [{ entryId: e5.id, mode: 'MANUAL' }] },
  });
  check('เพิ่มรายการเข้าบิล: "กรอกยอดเอง" ไม่ใส่จำนวนเงิน = ยอดที่กรอกไว้ 250 · รายการที่ไม่ได้กรอกคิดตาม % 800 (รวม 13,300)',
    added.status === 200 && lineOf(added.body, e5.id)?.commissionAmount === 250 && lineOf(added.body, e3.id)?.billMode === 'PCT'
      && lineOf(added.body, e3.id)?.commissionAmount === 800 && added.body.commissionTotal === 13300, added.body);

  const shopView = await api('GET', `/api/invoices/${inv}`, { token: mtok });
  check('ร้านเห็นบรรทัดที่กำหนดยอดเป็น MANUAL ตามยอดที่ใช้จริง แต่ไม่เห็นยอดที่กรอกไว้ในหน้ายอดขาย (ไม่มี manualAmount)',
    shopView.status === 200 && lineOf(shopView.body, e2.id)?.billMode === 'MANUAL' && lineOf(shopView.body, e2.id)?.commissionAmount === 1000
      && shopView.body.lines?.length === 4 && shopView.body.lines.every((l) => !('manualAmount' in l)), shopView.body?.lines);

  // ยกเลิกบิล → รายการคงวิธีที่เลือกตอนออกบิล · บันทึกยอดใหม่ = กลับไปใช้ค่าตั้งต้นของหน้ายอดขาย
  await api('POST', `/api/invoices/${inv}/void`, { token: admin, body: { reason: 'ทดสอบยอดส่วนต่างที่กรอกเอง' } });
  const afterVoid = (await api('GET', `/api/sales-entries/${e1.id}`, { token: admin })).body;
  ready = await readyOf();
  check('ยกเลิกบิลแล้ว รายการคงวิธีที่เลือกตอนออกบิล (MAN-1 = % 11,250) · นับเฉพาะรายการที่ใช้ยอดที่กรอกไว้ตรงตัว (MAN-5 → 1)',
    afterVoid.billMode === 'PCT' && afterVoid.commissionAmount === 11250 && afterVoid.manualAmount === 8000 && ready?.manualCount === 1,
    { afterVoid, ready });
  const rerec = await up({ productId: m1?.id, grossAmount: 90000 });
  check('บันทึกยอดใหม่หลังยกเลิกบิล → กลับไปใช้ยอดที่กรอกไว้ (MANUAL 8,000) · ประวัติบอกว่าวิธีที่เลือกตอนออกบิลถูกล้าง',
    rerec.status === 201 && rerec.body.billMode === 'MANUAL' && rerec.body.commissionAmount === 8000
      && lastAudit('entry.update', e1.id).modesReset === true, rerec.body);
  await up({ productId: m2?.id, grossAmount: 20000 });
  ready = await readyOf();
  check('พร้อมออกบิลอีกครั้ง: manualCount 3 · ยอดรอออกบิล 8,000 + 1,500 + 250 + 800 = 10,550',
    ready?.manualCount === 3 && ready.pendingCommission === 10550 && ready.status === 'READY', ready);

  // ออกบิลหลายร้านพร้อมกันไม่มีที่เลือกวิธีคิด → ใช้ยอดที่กรอกไว้เอง · ค่าคอมเซลไม่เกี่ยวกับยอดที่กรอกเอง (คิดจากยอดเต็ม)
  const sm = (await api('POST', '/api/sales-agents', { token: admin, body: { username: 'salemanual', password: 'salemanual-pass-1', name: 'เซลยอดกรอกเอง' } })).body.agent;
  await api('POST', '/api/sales-agents/links', { token: admin, body: { salesAgentId: sm?.id, items: [{ productId: m1?.id, commissionPct: 5 }] } });
  const bulkIssue = await api('POST', '/api/invoices/generate-bulk', { token: admin, body: { periodCode: MP, franchiseIds: [mfid] } });
  const binv = (await api('GET', `/api/invoices/${bulkIssue.body?.created?.[0]?.invoiceId}`, { token: admin })).body;
  check('ออกบิลหลายร้านพร้อมกันใช้ยอดที่กรอกไว้ (8,000 + 1,500 + 250 + 800 = 10,550)',
    bulkIssue.status === 201 && binv.commissionTotal === 10550 && lineOf(binv, e1.id)?.billMode === 'MANUAL'
      && lineOf(binv, e1.id)?.commissionAmount === 8000 && lineOf(binv, e3.id)?.billMode === 'PCT', { bulk: bulkIssue.body, lines: binv.lines });
  check('ออกบิลแล้ว manualCount = 0', (await readyOf())?.manualCount === 0);
  const mbill = await api('POST', `/api/sales-agents/${sm?.id}/commission-bills`, { token: admin, body: { items: [{ entryId: e1.id, mode: 'PCT', pct: 5 }] } });
  check('ค่าคอมเซลยังคิดจากยอดเต็ม ไม่ใช่ยอดที่กรอกเอง (90,000 × 5% = 4,500)',
    mbill.status === 201 && mbill.body.lines?.[0]?.baseAmount === 90000 && mbill.body.totalAmount === 4500, mbill.body);
}

section('captcha หน้าเข้าสู่ระบบ: หลาย IP ผลัดกันเดารหัสบัญชีเดียว (botnet)');
{
  const botKeys = {};
  for (const u of ['botshop', 'botshop2', 'botshop3']) {
    const created = await api('POST', '/api/franchises', { token: admin, body: { username: u, password: `${u}-pass-1` } });
    botKeys[u] = await shopLoginKey(created.body.franchise.id);
  }
  // IP ละครั้ง — ด่านเดิม (10 ครั้งต่อ IP) ไม่มีวันเห็น ต้องเป็นด่านที่นับตามชื่อบัญชี
  // ส่ง key ของลิงก์ร้านไปด้วยเสมอ (คนร้ายที่ได้ลิงก์ร้านไปแล้ว) — ครั้งที่รหัสผิดยังเป็น 401 ที่ถูกนับแบบเดิม
  let ipSeq = 0;
  const loginAs = (username, password, extra = {}) => api('POST', '/api/auth/login', {
    body: { username, password, ...(botKeys[username] ? { loginKey: botKeys[username] } : {}), ...extra },
    headers: { 'x-forwarded-for': `203.0.113.${++ipSeq}` },
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
