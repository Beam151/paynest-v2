/**
 * โครงของชุดเทสต์ end-to-end — ยิง HTTP ใส่เซิร์ฟเวอร์ PHP จริงบนฐานข้อมูลแยก (ไม่แตะข้อมูลที่ใช้ทำงาน)
 *
 * ใช้แค่ของที่มากับ Node (≥ 18) ไม่ต้อง npm install
 * ตั้งค่าผ่าน env (ไม่ตั้ง = ค่าตั้งต้นด้านล่าง):
 *   E2E_PHP        คำสั่ง php                      (php)
 *   E2E_DB_HOST    โฮสต์ MySQL/MariaDB             (127.0.0.1)
 *   E2E_DB_PORT    พอร์ต                           (3306)
 *   E2E_DB_USER    ผู้ใช้ที่สร้าง/ลบฐานข้อมูลได้      (root)
 *   E2E_DB_PASS    รหัสผ่าน                         (ว่าง)
 *   E2E_MYSQL_CLI  โปรแกรม mysql (ใช้ทดสอบกู้คืนไฟล์สำรอง — ไม่ตั้งก็ได้)
 *
 * ฐานข้อมูลของเทสต์ถูกลบแล้วสร้างใหม่ทุกครั้ง — ห้ามตั้งชื่อซ้ำกับฐานข้อมูลที่ใช้งานจริง
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PHP = process.env.E2E_PHP ?? 'php';
// variables_order=EGPCS: ให้ตัวแปรสภาพแวดล้อมของเทสต์ชนะ .env ของเครื่องนักพัฒนา (เช่น CI_ENVIRONMENT)
const PHP_FLAGS = ['-d', 'variables_order=EGPCS'];

export const DB = {
  host: process.env.E2E_DB_HOST ?? '127.0.0.1',
  port: process.env.E2E_DB_PORT ?? '3306',
  user: process.env.E2E_DB_USER ?? 'root',
  pass: process.env.E2E_DB_PASS ?? '',
};

/* ── ฐานข้อมูลของเทสต์ ─────────────────────────────────────── */

function mysqlAdmin(sql) {
  const code = `mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
    $m = new mysqli(getenv('H'), getenv('U'), getenv('P'), '', (int) getenv('O'));
    $m->query(getenv('Q'));`;
  const r = spawnSync(PHP, ['-r', code], {
    env: { ...process.env, H: DB.host, U: DB.user, P: DB.pass, O: DB.port, Q: sql }, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`MySQL: ${r.stdout}${r.stderr}`);
}

export function freshDatabase(name) {
  if (!/^[a-z0-9_]+$/.test(name) || !/e2e|test/.test(name)) throw new Error(`ชื่อฐานข้อมูลเทสต์ต้องมีคำว่า e2e หรือ test: ${name}`);
  mysqlAdmin(`DROP DATABASE IF EXISTS \`${name}\``);
  mysqlAdmin(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

export function dropDatabase(name) {
  mysqlAdmin(`DROP DATABASE IF EXISTS \`${name}\``);
}

/** env ของโปรเซส PHP ที่ชี้ไปฐานข้อมูล/โฟลเดอร์ของเทสต์ */
export function phpEnv(dbName, extra = {}) {
  return {
    ...process.env,
    PAYNEST_E2E: '1',
    PAYNEST_DB_HOST: DB.host,
    PAYNEST_DB_PORT: String(DB.port),
    PAYNEST_DB_USER: DB.user,
    PAYNEST_DB_PASS: DB.pass,
    PAYNEST_DB_NAME: dbName,
    ...extra,
  };
}

/* ── เรียก php spark ─────────────────────────────────────── */

export function sparkSync(args, env) {
  return spawnSync(PHP, [...PHP_FLAGS, 'spark', ...args], { cwd: ROOT, env, encoding: 'utf8' });
}

/** เรียกแบบไม่บล็อก — จำเป็นเมื่อ PHP ต้องยิงกลับมาที่ Telegram จำลองในโปรเซสนี้ */
export function spark(args, env) {
  return new Promise((resolve) => {
    const child = spawn(PHP, [...PHP_FLAGS, 'spark', ...args], { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** JSON ท้ายสุดของ stdout (spark พิมพ์หัวข้อความก่อน) */
function lastJson(text) {
  const start = text.lastIndexOf('\n{') + 1;
  return JSON.parse(text.slice(start).trim());
}

/**
 * อ่าน/แก้ฐานข้อมูลตรง ๆ แบบเดียวกับ better-sqlite3 ของชุดเทสต์เดิม: db.prepare(sql).get/all/run(...params)
 * (SQL เป็น MySQL · error จากฐานข้อมูลถูกโยนเป็น Error)
 */
export function makeDb(env) {
  const run = (sql, params, mode) => {
    const r = sparkSync(['e2e:sql', JSON.stringify({ sql, params, mode })], env);
    const out = lastJson(r.stdout);
    if (out.error) throw new Error(out.error);
    return out;
  };
  return {
    prepare: (sql) => ({
      get: (...params) => run(sql, params, 'get').row ?? undefined,
      all: (...params) => run(sql, params, 'all').rows,
      run: (...params) => ({ changes: run(sql, params, 'run').changes }),
    }),
  };
}

/** เรียกงานเบื้องหลังของระบบ (ปกติ cron เรียก) — ดู app/Commands/E2eCall.php */
export function makeCall(env) {
  return async (fn, payload = {}) => {
    const r = await spark(['e2e:call', JSON.stringify({ fn, ...payload })], env);
    const out = lastJson(r.stdout);
    if (out.error) throw new Error(`${fn}: ${out.error}`);
    return out.result;
  };
}

/** Date ที่ "ตัวเลขแบบ UTC = นาฬิกาไทย" (แบบที่ชุดเทสต์เดิมส่งให้ runDueReminders) → '2026-09-26T10:00:00' */
export const thaiWall = (date) => date.toISOString().slice(0, 19);

/* ── Telegram จำลอง — เก็บข้อความที่ส่งมา และสั่งให้ล่มได้ ─────────── */

export async function startTelegramMock() {
  const telegram = { messages: [], failNext: 0, updates: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const [, token, method] = req.url.match(/^\/bot([^/]+)\/(\w+)$/) ?? [];
      if (token?.endsWith('BAD')) {
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false, description: `Unauthorized (token ${token})` }));
        return;
      }
      if (method === 'getMe') { res.end(JSON.stringify({ ok: true, result: { username: 'franchise_alert_bot' } })); return; }
      if (method === 'getUpdates') { res.end(JSON.stringify({ ok: true, result: telegram.updates })); return; }
      if (telegram.failNext > 0) {
        telegram.failNext -= 1;
        res.statusCode = 502;
        res.end(JSON.stringify({ ok: false, description: 'Bad Gateway (จำลอง)' }));
        return;
      }
      telegram.messages.push({ path: req.url, ...JSON.parse(raw) });
      res.end(JSON.stringify({ ok: true, result: { message_id: telegram.messages.length } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { telegram, server, url: `http://127.0.0.1:${server.address().port}` };
}

/* ── เซิร์ฟเวอร์ PHP ─────────────────────────────────────── */

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

export async function startServer(env) {
  const port = await freePort();
  const child = spawn(PHP, [...PHP_FLAGS, '-S', `127.0.0.1:${port}`, '-t', 'public', 'vendor/codeigniter4/framework/system/rewrite.php'], {
    cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (d) => { log = (log + d).slice(-4000); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return { base, stop: () => child.kill(), log: () => log };
    } catch { /* ยังไม่ขึ้น */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill();
  throw new Error(`เปิดเซิร์ฟเวอร์ PHP ไม่ขึ้น:\n${log}`);
}

/**
 * ตั้งฉากทั้งชุด: ฐานข้อมูลใหม่ → app:install → เปิดเซิร์ฟเวอร์
 * mode = production (บังคับ 2FA ส่วนกลาง) | development
 */
export async function startStack({ dbName, mode = 'production', env: extra = {}, telegram = true } = {}) {
  const tg = telegram ? await startTelegramMock() : null;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paynest-e2e-'));
  freshDatabase(dbName);
  const env = phpEnv(dbName, {
    CI_ENVIRONMENT: mode,
    PAYNEST_DATA_DIR: dataDir,
    PAYNEST_BACKUP_DIR: path.join(dataDir, 'backups'),
    ...(tg ? { PAYNEST_TELEGRAM_API_BASE: tg.url } : {}),
    ...extra,
  });
  const install = sparkSync(['app:install'], env);
  if (install.status !== 0) throw new Error(`app:install ล้มเหลว:\n${install.stdout}${install.stderr}`);
  const server = await startServer(env);
  return {
    ...server,
    env,
    dataDir,
    telegram: tg?.telegram,
    db: makeDb(env),
    call: makeCall(env),
    async stop() {
      server.stop();
      tg?.server.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/* ── รหัส 6 หลักของ Google Authenticator (TOTP SHA1 / 30 วินาที) ─────── */

function base32Decode(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of text.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[19] & 0x0f;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/* ── JWT HS256 (ใช้ปลอม token ในเทสต์ความปลอดภัย) ─────────────────── */

/** expiresIn แบบเดียวกับ jsonwebtoken: วินาที (ติดลบ = หมดอายุไปแล้ว) หรือ '30m' / '1h' / '7d' */
function toSeconds(value) {
  if (typeof value === 'number') return value;
  const m = /^(-?\d+)\s*([smhd]?)$/.exec(value);
  if (!m) throw new Error(`expiresIn ไม่รู้จัก: ${value}`);
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

export function jwtSign(payload, secret, { expiresIn } = {}) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, ...(expiresIn !== undefined ? { exp: now + toSeconds(expiresIn) } : {}) };
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(body)}`;
  return `${head}.${crypto.createHmac('sha256', secret).update(head).digest('base64url')}`;
}
