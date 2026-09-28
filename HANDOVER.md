# เอกสารส่งต่องาน (สำหรับนักพัฒนา)

อ่าน [README.md](README.md) ก่อน (ภาพรวม + กติกาธุรกิจ) แล้วค่อยอ่านไฟล์นี้
ขึ้นเซิร์ฟเวอร์ / cron / สำรองข้อมูล / เรื่องฉุกเฉิน อยู่ใน [DEPLOY.md](DEPLOY.md) · ด่านความปลอดภัยทั้งหมดอยู่ใน [SECURITY.md](SECURITY.md)

## สถานะตอนส่งมอบ (ก.ย. 2569)

- พอร์ตจากระบบเดิม (Node.js + Express + SQLite) มาเป็น CodeIgniter 4 + MySQL/MariaDB ครบทุก endpoint
  หน้าเว็บ (`public/`) เป็นชุดเดิมแทบไม่ได้แก้ — API ตอบ JSON รูปเดียวกับของเดิมทุกตัว
- ตรวจความตรงกับของเดิมแล้ว: ใส่ข้อมูลตัวอย่างชุดเดียวกันทั้งสองระบบ → ตารางเงินทั้ง 6 ตารางตรงกันทุกแถว
  และคำตอบ GET ทุก endpoint × ทุกบทบาท (135 คู่) ตรงกัน
- `composer test` ผ่านทั้งหมด: smoke 481 ข้อ + pentest 93 ข้อ (ชุดเดิมที่พอร์ตมา) — **รันก่อนส่งงานทุกครั้ง**
- ยังไม่ได้ขึ้นเซิร์ฟเวอร์จริง · ทดสอบบน PHP 8.2 + MariaDB 10.4 (Windows/XAMPP)

## แผนที่โค้ด

```
app/
  Config/
    Routes.php           เส้นทางทั้งหมด + ด่านตรวจของแต่ละเส้น  guard:auth,staff,perm.bills,…  (รายการ endpoint ที่ถูกต้องที่สุด)
    Paynest.php          ค่าของระบบ — ค่าตั้งต้นใช้ได้เลย · เปลี่ยนใน .env (paynest.*) หรือ env จริง (PAYNEST_*) · เลขรุ่น VERSION
    Filters.php          jsonbody (ก่อน /api/*) · guard (ตาม Routes) · appheaders (หลังทุกคำขอ แม้ 404)
    Database.php         การต่อฐานข้อมูล (ค่าจริงอยู่ใน .env · PAYNEST_DB_* ชนะเสมอ)
    Exceptions.php · Routing.php   error ทุกแบบตอบเป็น JSON — ไม่โชว์หน้า error ของเฟรมเวิร์ก แม้ลืมตั้ง production
  Controllers/
    Home.php             หน้า SPA · /health (แตะฐานข้อมูลจริง) · 404 แบบ JSON
    Api/*.php            ชั้น HTTP: ตรวจ input ด้วย V แล้วเรียก service — ไม่มีตรรกะธุรกิจ (หนึ่งไฟล์ต่อหนึ่งกลุ่ม)
  Filters/
    ApiGuard.php         auth (JWT + โหลดผู้ใช้) · บทบาท · สิทธิ์ผู้ช่วย · elevated (รหัส 6 หลัก) · rate limit + captcha ตอนล็อกอิน
    JsonBody.php         อ่าน JSON body: เกิน 256KB = 413 · JSON พัง = 400 · ข้อความช่องเดียวเกิน 2,000 ตัว = 400
    SecurityHeaders.php  CSP / HSTS / nosniff / COOP ฯลฯ ชุดเดียวกับ helmet ของระบบเดิม
  Services/              ตรรกะธุรกิจทั้งหมด (คำนวณบิล ค่าคอม แจ้งเตือน สำรอง ฯลฯ) — static method คืน array
    Scheduler.php        งานตั้งเวลาทั้งหมด (cron เรียก Scheduler::tick() ทุกนาที)
    VersionService.php   รุ่นของระบบ (VERSION + commit จาก .git) · app:install จดเวลาอัปเดตเมื่อรุ่นเปลี่ยน
  Libraries/
    Db.php               query ตรง ๆ: all / one / val / int / exec / insert / tx · ตั้ง UTC + STRICT ให้ทุก connection
    V.php + Validation/  ตัวตรวจ input แบบเดียวกับ zod ของระบบเดิม (ข้อความ error ภาษาไทยเหมือนเดิม)
    Money (สตางค์, basis point) · Period (รอบครึ่งเดือน) · Clock (เวลาไทย) · Permissions (สิทธิ์ผู้ช่วย)
    Jwt · Totp (Google Authenticator + QR) · SecretBox (AES-256-GCM) · SignedUrl (ลิงก์ไฟล์มีวันหมดอายุ)
    Secrets (กุญแจลับ → writable/data/secrets.json) · RateLimiter · ClientIp · AuthContext · ApiException
    Js.php               แปลงค่าแบบ JavaScript ให้ผลเท่าระบบเดิม (Number("") = 0, ความยาวสตริงนับแบบ UTF-16 ฯลฯ)
  Database/
    Migrations/          โครงสร้างฐานข้อมูล — เพิ่มไฟล์ใหม่เท่านั้น ห้ามแก้ไฟล์ที่รันไปแล้ว
    Seeds/DemoSeeder.php ข้อมูลตัวอย่าง (สุ่มแบบกำหนด seed — ได้ข้อมูลชุดเดียวกับระบบเดิมทุกตัวเลข) · dev เท่านั้น
  Commands/              php spark app:install · app:backup · app:reset · schedule:run · schedule:work · 2fa:reset
                         db:seed (ของเฟรมเวิร์ก แต่ seed ไม่สำเร็จแล้ว exit 1) · e2e:sql / e2e:call (ชุดทดสอบเท่านั้น)
  Manual/                คู่มือผู้ใช้ admin · shop · sales — ส่งผ่าน GET /api/manual เท่านั้น ไม่อยู่ใน public/ โดยตั้งใจ
  Views/spa.php          หน้า HTML หลักของ SPA
public/                  หน้าเว็บ ไม่มี build — แก้แล้วรีเฟรชเบราว์เซอร์ได้เลย
  index.php (CI4) · styles.css · icons.svg · fonts/
  js/app.js              เมนู, router (hash), สิทธิ์ต่อหน้า, แถบล่างบนมือถือ, โครงหน้าตอนโหลด
  js/api.js              fetch + token + ย่อรูปก่อนอัปโหลด
  js/ui.js               el() สร้าง DOM, table(), formModal(), infoModal(), badge, วันที่ พ.ศ., ปุ่มคัดลอก, ไอคอน
  js/charts.js           กราฟแท่ง, โดนัท, เกจ, แถบสัดส่วน (SVG/CSS ล้วน ไม่มีไลบรารี)
  js/period.js           รอบบิลฝั่งเบราว์เซอร์ + ป้ายวันที่ "1–15 ก.ย. 69"
  js/viewState.js        จำแท็บ/ตัวกรอง/การเรียงตารางของหน้าปัจจุบัน
  js/version.js          รุ่นของระบบท้ายเมนูซ้าย (กดดูรายละเอียด) + การ์ดเวอร์ชันในหน้าตั้งค่า
  js/views/*.js          หนึ่งไฟล์ต่อหนึ่งหน้า
tests/e2e/               smoke.mjs · pentest.mjs · lib/harness.mjs (ยิง HTTP ใส่เซิร์ฟเวอร์ PHP จริง) — ดู tests/README.md
tools/build-icons.mjs    สร้าง public/icons.svg
writable/data/           กุญแจลับ · รหัสแอดมินเริ่มต้น · สลิป/QR · ไฟล์สำรอง — ห้าม commit
```

หน้าที่สำคัญ: `dashboard.js` (หน้าแรกส่วนกลาง) · `shopHome.js` (หน้าแรกร้าน) · `invoices.js` + `payments.js` (บิล/ชำระ/ตรวจสลิป)
· `settings.js` (แจ้งเตือน, สำรอง, ตรวจเว็บล่ม) · `announcements.js` · `account.js` (บัญชี, 2FA, ผู้ช่วย, Telegram ของร้าน)

## ข้อตกลงในโค้ด (ทำตามของเดิม)

- **คอมเมนต์เป็นภาษาไทย อธิบาย "ทำไม"** ไม่ใช่ "ทำอะไร" — โดยเฉพาะจุดที่เคยพังหรือเคยมีคนสับสน
- **เงินเก็บเป็นสตางค์ (จำนวนเต็ม)** ในฐานข้อมูลเสมอ แปลงด้วย `Money::toSatang()` / `Money::toBaht()` · % เก็บเป็น basis point
- **ข้อความ error ที่ผู้ใช้เห็นเป็นภาษาไทย** บอกว่าต้องทำอะไรต่อ ไม่ใช่แค่ว่าผิด (`ApiException::badRequest()` ฯลฯ)
- **วันที่บนหน้าจอเป็น พ.ศ. แบบสั้น** ใช้ `dateTh()`, `dateTimeTh()`, `periodLabel()` — ห้ามโชว์รหัสรอบดิบ ๆ (`2026-09-H1`)
- **เวลา**: ฐานข้อมูลเก็บ UTC (ทุก connection ตั้ง `time_zone = '+00:00'` ให้แล้ว) · ตรรกะที่ขึ้นกับ "วันนี้" ใช้เวลาไทยจาก `Clock`
- **หน้าเว็บ**: สร้าง DOM ด้วย `el()` (ไม่ใช้ innerHTML กับข้อมูลผู้ใช้ — กัน XSS) · สีใช้ตัวแปร CSS ใน `:root` ของ `styles.css`
- **ไอคอน**: ชุด Lucide ใน `public/icons.svg` เรียก `icon('ชื่อ')` หรือ `iconFor('emoji')`
  เพิ่มไอคอน: เติมชื่อใน `tools/build-icons.mjs` → `npm install --no-save lucide-static && node tools/build-icons.mjs`
- **ทุกการแก้ข้อมูลสำคัญเรียก `Audit::write()`** — ขึ้นในหน้า "ประวัติรายการ"
- **SQL เขียนตรง ๆ ผ่าน `Db`** พร้อม `?` placeholder เสมอ (ไม่ต่อสตริงด้วยค่าจากผู้ใช้) — ไม่ใช้ Model/Query Builder ของ CI4
  เพื่อให้ query อ่านเทียบกับระบบเดิมได้บรรทัดต่อบรรทัด

## วิธีทำงานที่เจอบ่อย

**แก้โครงสร้างฐานข้อมูล** — `php spark make:migration ชื่อ` แล้วเขียน `up()` · เครื่องจริงรันผ่าน `php spark app:install` ตอนอัปเดต
ข้อมูลเดิมต้องไม่พัง (ตั้ง DEFAULT หรือ UPDATE ค่าเดิมใน migration เดียวกัน)
⚠ MySQL ย้อน DDL ไม่ได้ (ต่างจาก SQLite) — migration ที่พังกลางทางจะค้างครึ่ง ๆ ลองกับสำเนาฐานข้อมูลก่อนเสมอ
MySQL ไม่มี unique index แบบมีเงื่อนไข (`WHERE`) — ใช้คอลัมน์ generated + unique แทน (ดูตัวอย่างใน migration แรก)

**ปล่อยงานขึ้นเครื่องจริง** — เลื่อน `VERSION` ใน `app/Config/Paynest.php` (แก้บั๊ก = เลขท้าย · ฟีเจอร์ใหม่ = เลขกลาง) แล้ว commit ไปด้วยกัน
เวลาอัปเดตจดเองตอนรัน `app:install` บนเครื่องจริง (ขึ้นท้ายเมนูซ้าย กดดูรายละเอียดได้ + หน้าตั้งค่าแจ้งเตือน + ข้อความ 🟢 ในกลุ่ม Telegram)
ลืมเลื่อนเลขก็ยังจดเวลาได้ (เทียบ commit ด้วย) แต่ทุกคนจะเห็นเลขรุ่นเดิม — บอกไม่ได้ว่ารุ่นไหนมีอะไร

**เพิ่ม API** — เพิ่มเส้นใน `app/Config/Routes.php` พร้อมด่านตรวจ `$g('auth,…')` → เมธอดใน `app/Controllers/Api/X.php`
ตรวจ input ด้วย `V::parse(V::object([...]), $this->body())` → ตรรกะใน `app/Services/XService.php`
ด่านตรวจ: `super` · `staff` · `agent` · `perm.bills` (สิทธิ์ผู้ช่วย) · ข้อมูลรายร้านใช้ `AuthContext::franchiseScope()` บังคับให้ร้านเห็นแค่ของตัวเอง
เรื่องอันตราย (แก้บัญชีรับเงิน, ตั้งค่า Telegram/แจ้งเตือน, ปลด 2FA คนอื่น) ใส่ `elevated` = ต้องใส่รหัส 6 หลักภายใน 5 นาที
เส้นที่เจาะจง (เช่น `…/me`) ต้องอยู่**ก่อน**เส้นที่มี `(:segment)` ในตำแหน่งเดียวกัน ไม่งั้นคำนั้นถูกจับเป็น id

**เพิ่มหน้าเว็บ** — สร้าง `public/js/views/x.js` export `async function xView()` คืน element →
ลงทะเบียนใน `ROUTES` ของ `public/js/app.js` (label, icon, roles) และ `NAV_GROUPS` · ถ้าผู้ช่วยต้องมีสิทธิ์ ใส่ `ROUTE_PERMISSION`
เพิ่มหรือย้ายเมนู ต้องแก้ `NAV` ใน `app/Controllers/Api/Manual.php` ให้ตรงด้วย (คู่มือบอกทางไปแต่ละหน้าจากค่านี้)

**เพิ่มเรื่องแจ้งเตือนของส่วนกลาง** — เติมใน `EVENTS` ของ `app/Services/NotificationService.php` (หน้าตั้งค่าขึ้นให้เอง)
แล้วเรียก `NotificationService::notify('key', ข้อความ)` · เรื่องความปลอดภัยใส่ `'locked' => true` (ปิดไม่ได้ ไม่สนช่วงห้ามรบกวน)

**เพิ่มเรื่องแจ้งเตือนของร้าน** — เติมใน `SHOP_EVENTS` แล้วเรียก `NotificationService::notifyShop($franchiseId, ข้อความ, 'key')`
ร้านเลือกเปิด/ปิดได้เองที่หน้าบัญชีของฉันทันที

**เพิ่มงานตามเวลา** — เพิ่มใน `Scheduler::tick()` · cron เรียกทุกนาที งานต้องตัดสินเองว่าถึงเวลาหรือยัง
(จำใน `SettingsService` ว่าทำไปแล้ววันไหน/ชั่วโมงไหน) และแยก try/catch — งานหนึ่งพังต้องไม่ลากงานอื่น
ทั้งรอบถือล็อก `schedule.tick` (รอบที่ซ้อนเข้ามาถูกข้าม) — ไม่ต้องกันสองโปรเซสทำงานเดียวกันเองในแต่ละงาน

**เพิ่มเทสต์** — ต่อท้ายใน `tests/e2e/smoke.mjs` เป็น `section('ชื่อ')` + `check('สิ่งที่ต้องจริง', เงื่อนไข, ข้อมูลตอนพัง)`
Telegram ในเทสต์เป็นเซิร์ฟเวอร์จำลอง (`telegram.messages`) ไม่ส่งออกจริง · section สุดท้ายต้องเป็นเรื่องล็อกรหัส (มันล็อก 15 นาที)
อ่าน/แก้ฐานข้อมูลตรง ๆ ในเทสต์ใช้ `db.prepare(sql).get/all/run()` (SQL แบบ MySQL) · เรียกงานเบื้องหลังใช้ `call('ชื่อ')`
(งานใหม่ต้องเพิ่มใน `app/Commands/E2eCall.php`) — ทั้งสองอย่างเรียก `php spark` ครั้งละโปรเซส ใช้เท่าที่จำเป็น

## ความปลอดภัย (ที่มีอยู่แล้ว — อย่าถอดออก)

รายละเอียดทุกด่านอยู่ใน **[SECURITY.md](SECURITY.md)** — กันอะไร ทำงานอย่างไร โค้ดอยู่ไหน และเรื่องฉุกเฉิน
อ่านก่อนแก้ `Filters/ApiGuard.php` · `Controllers/Api/Auth.php` · `Filters/SecurityHeaders.php` · `Filters/JsonBody.php`

สรุปสั้น ๆ: bcrypt + JWT 24 ชม. (`token_version`) · Google Authenticator บังคับส่วนกลาง · รหัส 6 หลักก่อนเรื่องอันตราย (`elevated`)
· กันเดารหัส 3 ชั้น (บัญชี+IP · IP · captcha ตามชื่อบัญชี) · ร้านเห็นแค่ของตัวเอง · CSP เข้ม ไม่มี CORS
· ไฟล์สลิปเปิดได้เฉพาะลิงก์ที่เซ็นแล้ว · secret ทุกตัวเข้ารหัสในฐานข้อมูล · เรื่องความปลอดภัยแจ้ง Telegram ปิดไม่ได้

`composer test:pentest` ลองโจมตีจริง 93 แบบ (SQL injection, XSS, ปลอม token, ข้ามสิทธิ์ร้าน, อัปโหลดไฟล์ปลอม,
เปิดไฟล์ `.env`/`secrets.json` ตรง ๆ ฯลฯ) — ทุกข้อต้องผ่าน

## สิ่งที่ต่างจากระบบเดิม (Node)

| เรื่อง | ระบบเดิม | รุ่นนี้ |
| --- | --- | --- |
| ฐานข้อมูล | SQLite ไฟล์เดียว | MySQL/MariaDB — ตาราง/คอลัมน์ชื่อเดิม ยกเว้น `app_settings.key` → `name` (`key` เป็นคำสงวน) |
| unique เฉพาะบางแถว | partial index (`… WHERE`) | คอลัมน์ generated + unique |
| งานเบื้องหลัง | ตัวจับเวลาในโปรเซส Node | cron `php spark schedule:run` ทุกนาที หรือ `schedule:work` รันค้าง |
| "🟢 ระบบเริ่มทำงาน" | ทุกครั้งที่โปรเซสเปิด | หลัง `app:install` และเมื่อ cron เงียบไปเกิน 10 นาทีแล้วกลับมา (= เครื่องเพิ่งฟื้น) |
| ส่ง Telegram | ส่งจากโปรเซสทันที | จดลง outbox แล้วส่งหลังตอบคำขอ (PHP-FPM ตอบผู้ใช้ก่อน) · cron ส่งตัวที่ค้าง/ลองใหม่ · ล็อกด้วย `GET_LOCK` กันส่งซ้ำ |
| rate limit | หน่วยความจำของโปรเซส | ตาราง `rate_limits` (PHP ไม่มีโปรเซสค้าง) |
| `/health` | ตรวจฐานข้อมูล | ตรวจฐานข้อมูล + งานตั้งเวลา — cron เงียบเกิน 10 นาที = 503 (เว็บขึ้นไม่ได้แปลว่างานเบื้องหลังเดินเหมือนระบบเดิม) |
| ไฟล์สำรอง | สำเนาไฟล์ `.db` | `.sql.gz` — dump ด้วย PHP แบบ consistent snapshot ไม่ต้องมี mysqldump |
| ค่าตั้ง | `.env` (`PORT`, `TRUST_PROXY`, `JWT_SECRET` …) | `.env` แบบ CI4 (`paynest.trustProxy` …) หรือ env จริง `PAYNEST_*` (ชื่อตามของเดิม เช่น `PAYNEST_JWT_SECRET`) |
| โหมด | `npm start` / `npm run dev` (`NODE_ENV`) | `CI_ENVIRONMENT = production` / `development` |
| ที่เก็บไฟล์ | `data/` | `writable/data/` (เปลี่ยนได้ที่ `paynest.dataDir`) |
| คู่มือ | `src/manual/` + `manual.routes.js` | `app/Manual/` + `app/Controllers/Api/Manual.php` |
| `trustProxy` | nginx proxy ไป Node = 1 | nginx + PHP-FPM = **0** (nginx ส่ง IP จริงให้ PHP อยู่แล้ว) · มี Cloudflare/load balancer อยู่หน้า = 1 |

สคริปต์ซ่อมข้อมูลครั้งเดียวของระบบเดิม (`backfill-slips.mjs`, `recalc-commissions.mjs`) ไม่ได้พอร์ต — แก้ข้อมูลเก่าของระบบเดิมเท่านั้น

## สิ่งที่เจ้าของระบบตัดสินใจไว้แล้ว (อย่าเปลี่ยนโดยไม่ถาม)

- **ข้อความที่ร้านเห็นใช้คำว่า "ทางเรา" ไม่ใช่ "ส่วนกลาง"** และสุภาพแบบคู่ค้า ไม่ใช่ภาษาทวงหนี้
  (ข้อความที่แอดมินเห็นฝั่งเดียวใช้ "ส่วนกลาง"/"เรา" ได้)
- **แจ้งเตือนผ่าน Telegram เท่านั้น** — ไม่เอา LINE (มีค่าใช้จ่าย) · ไม่มีอีเมล
- **ไม่ทำ PWA / แอปมือถือ** — ใช้ผ่านเบราว์เซอร์ มีแถบเมนูล่างบนมือถือแทน
- **ล็อกอินหมดอายุ 24 ชม.** — ไม่เอา "จำฉันไว้ 30 วัน" (เจ้าของระบบมองว่าปลอดภัยกว่า)
- **captcha ถามเฉพาะบัญชีที่ถูกใส่รหัสผิดเกิน 5 ครั้งใน 1 ชม.** — ไม่ถามทุกคนทุกครั้ง และไม่ล็อกบัญชี (`LOGIN_THRESHOLD` · รายละเอียดใน SECURITY.md)
- **ไม่ทำไฟล์ PDF** ใบเรียกเก็บ/ใบรับเงิน — ดูบนจอได้
- **ไม่ให้ตั้งค่าผ่าน `.env` ถ้าเลี่ยงได้** — `.env` มีแค่การต่อฐานข้อมูล (เลี่ยงไม่ได้) ค่าที่ต้องเปลี่ยนระหว่างใช้งานทำเป็นหน้าตั้งค่าในเว็บ
  (เรื่องอันตรายกันด้วยรหัส 6 หลัก)
- **ร้านไม่เห็นข้อมูลร้านอื่นเด็ดขาด** — อันดับยอดขายบอกแค่ตำแหน่ง ไม่บอกชื่อ/ยอด และโชว์เฉพาะร้านที่อยู่ครึ่งบน
- **ยอดขายกรอกโดยส่วนกลางเท่านั้น** ร้านไม่มีหน้ากรอกยอด

## ไอเดียที่คุยไว้แล้วแต่ยังไม่ได้ทำ

1. **สรุปรายเดือนส่ง Telegram ให้ร้าน** ทุกวันที่ 1 — ยอดเดือนก่อน เทียบเดือนก่อนหน้า สินค้าขายดี จ่ายตรงเวลาไหม
   (เพิ่มเป็นเรื่องใหม่ใน `SHOP_EVENTS` + งานใน `Scheduler::tick()`)
2. **หน้า "ร้านที่ต้องดูแล"** สำหรับแอดมิน — ร้านที่ยอดตก 3 รอบติด หรือเริ่มจ่ายช้ากว่าปกติ
3. ภาษี (VAT / หัก ณ ที่จ่าย) — ยังไม่ได้คุยรายละเอียดกับเจ้าของระบบ

## จุดที่ควรรู้ก่อนแก้

- **MySQL ไม่เหมือน SQLite** (เคยทำให้ตัวเลขเพี้ยนระหว่างพอร์ต):
  - `UPDATE … SET a = …, b = a …` — MySQL ใช้ค่า `a` ที่เพิ่งแก้ในบรรทัดเดียวกัน (SQLite ใช้ค่าเดิม) เรียงลำดับ SET ให้ถูก (ดู `CreditService`)
  - `SUM()` / `AVG()` คืนเป็นสตริง DECIMAL — แปลงเป็น int ก่อนใช้เสมอ
  - เรียงแถวที่ค่าเท่ากันออกมาไม่แน่นอน — `ORDER BY` ที่หน้าจอพึ่งลำดับต้องมี `id DESC` ต่อท้าย
  - เปิด `ONLY_FULL_GROUP_BY` + STRICT — คอลัมน์ใน SELECT ต้องอยู่ใน GROUP BY หรือครอบด้วยฟังก์ชันรวม
- **body ที่ไม่ส่งฟิลด์ ≠ ส่ง `null`** — `V` แยกสองกรณีแบบ zod (ส่ง `null` = ล้างค่า · ไม่ส่ง = ไม่แตะ) อย่าใช้ `??` ปนกัน
- **ค่าใน `.env` แบบมีจุด (`paynest.x`) ถูกตัวแปรสภาพแวดล้อมจริงทับไม่ได้** (PHP แปลงจุดเป็น `_`) —
  จึงมี `PAYNEST_*` / `PAYNEST_DB_*` ไว้ให้ Docker และชุดทดสอบใช้
- **Telegram ส่งหลังตอบคำขอ** ใช้ `fastcgi_finish_request()` ของ PHP-FPM · บน `php spark serve` / Apache mod_php
  ผู้ใช้จะรอจนส่งเสร็จ (ช้าขึ้นนิดหน่อยตอน Telegram ช้า แต่ไม่พัง)
- **`php spark serve` ฟังเฉพาะ `localhost`** — เปิดด้วย `http://localhost:8080` ไม่ใช่ IP
- **หน้าเว็บแคชไฟล์ JS** — แก้แล้วไม่เห็นผล ให้กด Ctrl+Shift+R (Mac: Cmd+Shift+R)
- **ใบเรียกเก็บแก้ไม่ได้เมื่อมีเงินเข้าหรือมีสลิปรอตรวจ** — ตั้งใจ ไม่ใช่บั๊ก (สิ่งที่ร้านโอนต้องตรงกับบิล)
- **ข้อมูลในเครื่อง dev (`writable/data/`) ห้าม commit และห้ามคัดลอกขึ้นเครื่องจริง**
- **คู่มือผู้ใช้อยู่ที่ `app/Manual/{admin,shop,sales}.html`** — เปลี่ยนชื่อปุ่ม/เมนู/ขั้นตอนเมื่อไร แก้คู่มือตามด้วย
  เซิร์ฟเวอร์ส่งให้เฉพาะบทบาทของคนที่ล็อกอิน (`GET /api/manual`) ร้านขอคู่มือส่วนกลางไม่ได้
  โครง: หน้า "อยากทำอะไร" (`.m-home` ปุ่ม `data-guide`) → เปิดทีละเรื่อง (`section.m-guide#id`) แต่ละขั้นมีรูปจำลองหน้าจอ (`.m-shot` + ชิ้นส่วน `s-*`)
  `s-hl` = วงไฮไลต์ตรงที่ต้องกด · `{i:ชื่อ}` = ไอคอน · `{nav:หน้า}` = ทางไปหน้านั้น (เซิร์ฟเวอร์เขียนให้ทั้งแบบคอมและมือถือ)
  รูปจำลองเขียนแค่เนื้อหา + `data-nav`/`data-modal`/`data-tap-nav` — กรอบ เมนูซ้าย แถบล่าง วาดใน `public/js/views/manual.js`
  CSS อยู่ท้าย `styles.css` · แก้ไฟล์คู่มือแล้วเห็นผลทันที (เซิร์ฟเวอร์อ่านไฟล์ทุกครั้ง)
