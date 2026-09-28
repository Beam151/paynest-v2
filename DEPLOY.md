# คู่มือขึ้นเซิร์ฟเวอร์และดูแลระบบ

สำหรับคนดูแลเซิร์ฟเวอร์ — ทำตามทีละขั้นได้เลย ไม่ต้องอ่านโค้ด

**สิ่งที่ต้องมี:** เครื่อง Linux (ใช้ aaPanel ได้) · PHP 8.2+ แบบ PHP-FPM · Composer 2 · MariaDB 10.4+ หรือ MySQL 8.0.16+
· nginx หรือ Apache · โดเมนที่ชี้มาที่เครื่อง · บัญชี Telegram

ส่วนขยาย PHP ที่ต้องเปิด: `intl` `mbstring` `mysqli` `curl` `gd` `openssl` `zlib`

- aaPanel: App Store → PHP 8.2 → Setting → Install extensions → ติดตั้ง `intl` และ `mbstring` (ถ้ายังไม่ได้ติดตั้ง)
  ตัวอื่นติดมากับ PHP ของ aaPanel อยู่แล้ว จึงไม่มีในรายการนั้น
- เช็กว่าครบ: `php -m | grep -iE '^(intl|mbstring|mysqli|curl|gd|openssl|zlib)$'` ต้องขึ้น 7 บรรทัด
  (หรือรัน `composer install` ไปเลย ถ้าขาดตัวไหนจะหยุดและบอกชื่อ)

> ⚠ **ทุกคำสั่ง `php spark` บนเครื่องจริง ต้องรันในนามผู้ใช้ของเว็บ** (aaPanel = `www` · Ubuntu = `www-data`)
> ไฟล์ที่ระบบสร้าง (กุญแจลับ, ไฟล์สำรอง, รูปสลิป) ตั้งสิทธิ์ให้เจ้าของอ่านได้คนเดียว —
> ถ้ารันด้วย root ไฟล์จะเป็นของ root แล้วเว็บ (PHP-FPM) อ่านไม่ได้ ตัวอย่างในคู่มือนี้จึงขึ้นต้นด้วย `sudo -u www`

---

## 1. ติดตั้งครั้งแรก

```bash
git clone <ที่เก็บโค้ด> /www/wwwroot/paynest        # หรือโฟลเดอร์ไหนก็ได้
cd /www/wwwroot/paynest
git config core.fileMode false                     # ไม่นับการเปลี่ยนสิทธิ์ไฟล์ (chmod) ว่าเป็นการแก้โค้ด
composer install --no-dev --optimize-autoloader
```

> ⚠ **อย่าคัดลอกโฟลเดอร์ `writable/data/` หรือไฟล์ `.env` จากเครื่อง dev ขึ้นมา** — ในนั้นมีกุญแจลับของเครื่อง dev และรหัสตัวอย่าง
> เครื่องจริงต้องเริ่มจากว่าง ระบบสร้างให้เองตอนติดตั้ง

**สร้างฐานข้อมูล** (aaPanel: Databases → Add database เลือก `utf8mb4` ก็ได้)

```sql
CREATE DATABASE paynest CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'paynest'@'localhost' IDENTIFIED BY '<รหัสยาว ๆ สุ่มเอง>';
GRANT ALL PRIVILEGES ON paynest.* TO 'paynest'@'localhost';
```

**ตั้งค่าเครื่อง** — คัดลอกไฟล์ตัวอย่างแล้วแก้เฉพาะฐานข้อมูลกับโดเมน (ที่เหลือมีค่าตั้งต้นที่ปลอดภัยอยู่แล้ว)

```bash
cp env .env
nano .env        # database.default.* และ app.baseURL · CI_ENVIRONMENT ต้องเป็น production (ค่าในไฟล์ตัวอย่าง)
chown -R www:www writable .env && chmod 600 .env
sudo -u www php spark app:install
```

`app:install` สร้างตาราง + สุ่มกุญแจลับ (`writable/data/secrets.json`) + สร้างแอดมินคนแรก
รันซ้ำได้ทุกเมื่อ ไม่ล้างข้อมูล (ใช้ตอนอัปเดตด้วย)

> **มี Cloudflare (เมฆสีส้ม) หรือ load balancer อยู่หน้าเว็บ?** ใส่ `paynest.trustProxy = 1` ใน `.env`
> nginx/Apache ที่รัน PHP เองไม่นับ (aaPanel แบบปกติ = ไม่ต้องตั้ง) — ตั้งผิดแล้วคนเดารหัสผิดคนเดียว ทุกร้านโดนล็อกไปด้วย

## 2. เว็บเซิร์ฟเวอร์ + HTTPS

**สำคัญที่สุด: root ของเว็บต้องเป็นโฟลเดอร์ `public/`** ไม่ใช่รากโปรเจกต์ — ไม่งั้นคนเปิด `.env` / โค้ด / ไฟล์ข้อมูลได้

**aaPanel:** Website → Add site (โดเมน, PHP 8.2, โฟลเดอร์ `/www/wwwroot/paynest`) แล้วเข้า Settings ของเว็บ:

- Site directory → **Running directory** = `/public` → Save
- URL rewrite → ใส่
  ```nginx
  location / {
      try_files $uri $uri/ /index.php$is_args$args;
  }
  ```
- SSL → Let's Encrypt → เปิด Force HTTPS
- Config file → หาบล็อก `location ~ .*\.(js|css)?$` ที่ aaPanel ใส่มาให้ แล้วเปลี่ยน `expires 12h;` เป็น
  `add_header Cache-Control "no-cache";` → Save
  (ค่าตั้งต้นของ aaPanel ให้เบราว์เซอร์ใช้ไฟล์ JS/CSS เก่าได้ 12 ชม. — อัปเดตระบบแล้วร้านจะยังเห็นหน้าจอเก่า
  `no-cache` = เบราว์เซอร์ถามเซิร์ฟเวอร์ทุกครั้ง ไฟล์ไม่เปลี่ยนก็ได้ 304 กลับไป เร็วเท่าเดิม)

**nginx ตั้งเอง:**

```nginx
server {
    listen 443 ssl http2;
    server_name shop.example.com;
    root /var/www/paynest/public;
    index index.php;
    client_max_body_size 10m;                 # รูปสลิปสูงสุด 8MB

    location / {
        try_files $uri $uri/ /index.php$is_args$args;
    }
    location ~* \.(js|css|svg)$ {               # อัปเดตแล้วเบราว์เซอร์ต้องได้ไฟล์ใหม่ทันที (ไม่เปลี่ยน = 304)
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }
    location ~ \.php$ {
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;
    }
    location ~ /\. { deny all; }              # .htaccess ฯลฯ
    # ssl_certificate … (certbot ใส่ให้)
}
```

**Apache:** ชี้ DocumentRoot ไปที่ `public/` · เปิด `mod_rewrite` (ใน `public/` มี `.htaccess` ให้แล้ว)

**ค่า PHP ที่ต้องปรับ** (aaPanel: PHP 8.2 → Configuration file / Configuration)

| ค่า | ตั้งเป็น | ทำไม |
| --- | --- | --- |
| `post_max_size` | `10M` | รูปสลิปสูงสุด 8MB (ค่าตั้งต้น 8M ไม่พอ) |
| `upload_max_filesize` | `10M` | เผื่อไว้ให้ตรงกัน |
| `memory_limit` | `128M` ขึ้นไป | ย่อ/ตรวจรูป, สำรองข้อมูล |

> aaPanel ปิดฟังก์ชัน `putenv` ไว้ในบางรุ่น — ถ้าเปิดเว็บแล้วเจอ error `Call to undefined function putenv()`
> ให้เอา `putenv` ออกจาก Disabled functions (CodeIgniter ใช้อ่านไฟล์ `.env`)

## 3. งานตั้งเวลา (cron) — ต้องตั้ง

ระบบไม่มีโปรเซสค้างเหมือนระบบเดิม — งานพวกนี้เกิดเฉพาะตอน cron เรียกทุกนาที:
ส่ง Telegram ที่ค้าง/ส่งไม่ผ่าน · อ่านข้อความถึงบอท (ร้านผูก Telegram) · สรุปรายวัน · เตือนร้านก่อน/หลังครบกำหนด
· ส่งประกาศ · เช็กดิสก์ · **สำรองข้อมูลทุกคืน ตี 3 ครึ่ง**

**aaPanel:** Cron → Add Cron → Type: Shell Script · Execution cycle: N Minutes = 1 · Script content:

```bash
su -s /bin/sh -c "/www/server/php/82/bin/php /www/wwwroot/paynest/spark schedule:run" www
```

**เครื่องทั่วไป:**

```bash
sudo crontab -u www-data -e
* * * * * php /var/www/paynest/spark schedule:run > /dev/null 2>&1
```

ลองสั่งเองดูผลของแต่ละงาน: `sudo -u www php spark schedule:run --verbose`

> ต้องการให้ร้านผูก Telegram เสร็จเร็วขึ้น (10 วินาทีแทนไม่เกิน 1 นาที): รัน `php spark schedule:work` ค้างไว้แทน cron
> ผ่าน Supervisor ของ aaPanel (user `www`) · ใช้คู่กับ cron ก็ได้ ไม่ทำงานซ้ำกัน

## 4. ตั้งค่าครั้งแรกในหน้าเว็บ

1. ดูรหัสแอดมินคนแรก: `cat writable/data/initial-admin-password.txt` (ระบบสุ่มให้ ไม่พิมพ์ออกหน้าจอ/log)
2. ล็อกอิน `superadmin` → ระบบบังคับเปลี่ยนรหัส → ตั้ง **Google Authenticator** → **เก็บรหัสสำรอง 10 ชุดไว้ที่ปลอดภัย**
3. ลบไฟล์รหัสเริ่มต้น: `rm writable/data/initial-admin-password.txt`
4. หน้า **ตั้งค่าแจ้งเตือน → เชื่อม Telegram**
   - คุยกับ @BotFather สร้างบอท ได้ token
   - สร้างกลุ่ม Telegram ใส่บอทกับเจ้าของกิจการ แล้วพิมพ์อะไรก็ได้ในกลุ่มหนึ่งครั้ง
   - วาง token → กดค้นหากลุ่ม → เลือกกลุ่ม → บันทึก
5. หน้า **บัญชีรับเงิน** → เพิ่มบัญชีธนาคาร + รูป QR
6. สร้างร้านที่หน้า **ร้านค้า** แล้วส่งชื่อผู้ใช้/รหัสผ่านให้ร้าน — ร้านเชื่อม Telegram ของตัวเองได้ที่หน้า "บัญชีของฉัน"
7. (แนะนำ) หน้า **ตั้งค่า → กันบอทเดารหัสผ่าน → เปิด captcha** — ถามเฉพาะบัญชีที่ถูกใส่รหัสผิดเกิน 5 ครั้งใน 1 ชั่วโมง
   - [Cloudflare](https://dash.cloudflare.com) (บัญชีฟรี) → Turnstile → Add widget → ใส่โดเมนของระบบ · Widget mode = Managed
   - คัดลอก Site key + Secret key มาวาง → กด "ทดสอบและบันทึก" → ผ่านช่องที่ขึ้นมา (ระบบบันทึกเมื่อคีย์ใช้กับเว็บนี้ได้จริง)
   - เครื่องต้องออกเน็ตไป `https://challenges.cloudflare.com` ได้ · รายละเอียดใน [SECURITY.md](SECURITY.md)

## 5. ตรวจว่าเว็บล่ม (UptimeRobot ฟรี)

ระบบที่ล่มไปแล้วแจ้งเตือนเองไม่ได้ ต้องมีตัวตรวจจากข้างนอก

1. สมัคร https://uptimerobot.com
2. Add New Monitor → HTTP(s) → URL `https://<โดเมน>/health` → ทุก 5 นาที
3. Alert Contacts → Telegram → เลือกกลุ่มเดียวกับที่ระบบแจ้งเตือน

`/health` ตอบ 503 (= ล่ม) ในสองกรณี — เปิด URL เองจะเห็นว่าเป็นเรื่องไหน:

- `"failing":"database"` — ฐานข้อมูลพัง/ต่อไม่ได้ (แอปยังตอบได้ก็ตาม)
- `"failing":"schedule"` — cron หยุดเดินเกิน 10 นาที (เว็บใช้ได้ แต่ไม่มีสำรองข้อมูล/เตือนร้าน) → ดูข้อ 3

สิ่งที่ระบบแจ้งเองเข้ากลุ่ม (ตั้งได้ในกลุ่ม "ระบบ / เซิร์ฟเวอร์"):
🟢 เพิ่งเริ่มทำงาน (หลังติดตั้ง/อัปเดต หรือ cron หายไปเกิน 10 นาทีแล้วกลับมา = เครื่องเพิ่งล่มแล้วฟื้น) ·
🚨 ขัดข้อง · 💾 ดิสก์ใกล้เต็ม · ❌ สำรองข้อมูลไม่สำเร็จ

## 6. สำรองข้อมูล

**ระบบสำรองเองทุกคืน ตี 3 ครึ่ง** (ผ่าน cron ข้อ 3) — ดูสถานะได้ที่หน้า **ตั้งค่าแจ้งเตือน → สำรองข้อมูล**

```
writable/data/backups/
  db/paynest-YYYY-MM-DD_HHMM.sql.gz   ฐานข้อมูลรายวัน เก็บย้อนหลัง 30 วัน
  secrets.json                        กุญแจลับ ⚠ หายแล้ว Google Authenticator ของทุกคนใช้ไม่ได้
  uploads/                            รูปสลิป/QR ทั้งหมด
```

สั่งสำรองทันที (เช่น ก่อนอัปเดต): `sudo -u www php spark app:backup` หรือกดปุ่ม "สำรองตอนนี้" ในหน้าเว็บ

### ⚠ ต้องคัดลอกออกนอกเครื่องอีกชั้น

ไฟล์สำรองอยู่บนดิสก์เดียวกับระบบ — เครื่องพัง/โดนลบทั้งเครื่อง ไฟล์สำรองก็หายด้วย
เลือกอย่างใดอย่างหนึ่ง:

- **aaPanel:** Cron → Backup directory → เลือก `writable/data/backups` → ส่งไป Google Drive / S3 / FTP → ทุกวัน 04:00
- **rclone:** `rclone sync /www/wwwroot/paynest/writable/data/backups remote:paynest-backups` ใส่ crontab ทุกวัน 04:00

ไฟล์สำรองมีกุญแจลับอยู่ด้วย — ที่ปลายทางต้องปลอดภัยเท่ากับตัวเซิร์ฟเวอร์ (ห้ามเปิดแชร์ลิงก์สาธารณะ)

### กู้ข้อมูลคืน

```bash
# 1) หยุดรับงาน: aaPanel → Website → Stop และปิด cron ข้อ 3 ชั่วคราว
cd /www/wwwroot/paynest
ls writable/data/backups/db/                                          # เลือกไฟล์ตามวันที่

# 2) ล้างฐานข้อมูลแล้วโหลดไฟล์สำรอง (สิทธิ์ของผู้ใช้ paynest ยังอยู่)
mysql -u root -p -e "DROP DATABASE paynest; CREATE DATABASE paynest CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
gunzip -c writable/data/backups/db/paynest-<วันที่>.sql.gz | mysql -u root -p paynest

# 3) เฉพาะกรณีไฟล์หาย
cp writable/data/backups/secrets.json writable/data/secrets.json      # กุญแจลับหาย
cp -n writable/data/backups/uploads/* writable/data/uploads/           # รูปสลิปหาย
chown -R www:www writable

# 4) ไฟล์สำรองเก่ากว่าการอัปเดตระบบครั้งล่าสุด? คำสั่งนี้อัปเดตโครงสร้างให้ (ไม่มีอะไรค้าง = ไม่ทำอะไร)
sudo -u www php spark app:install
# 5) เปิดเว็บ + cron คืน
```

นำเข้าผ่าน phpMyAdmin ก็ได้ (Import ไฟล์ `.sql.gz` เข้าฐานข้อมูลว่าง)
ข้อมูลที่เกิดหลังเวลาของไฟล์สำรองจะหายไป — แจ้งร้านให้แจ้งชำระซ้ำถ้าจำเป็น · บางคนอาจต้องล็อกอินใหม่

## 7. อัปเดตระบบ

```bash
cd /www/wwwroot/paynest
sudo -u www php spark app:backup                  # สำรองก่อนเสมอ
git pull
composer install --no-dev --optimize-autoloader
sudo -u www php spark app:install                 # อัปเดตโครงสร้างฐานข้อมูล (ไม่ล้างข้อมูล)
```

ไม่ต้องรีสตาร์ตอะไร — PHP อ่านไฟล์ใหม่เอง (ยกเว้นตั้ง OPcache แบบไม่ตรวจไฟล์ `opcache.validate_timestamps=0` ให้ reload PHP-FPM)
หลังอัปเดต กลุ่ม Telegram จะได้ข้อความ "🟢 ระบบเริ่มทำงานแล้ว · อัปเดตเป็นรุ่น … (เดิม …)"

ดูรุ่นที่ใช้อยู่และเวลาอัปเดตล่าสุด: ท้ายเมนูซ้ายของทุกคน — กดที่รุ่นเพื่อดูรายละเอียด (ส่วนกลางเห็น commit และรุ่นก่อนหน้าด้วย)
หรือหน้า **ตั้งค่าแจ้งเตือน → เวอร์ชันระบบ** (ล่างสุด)
เวลาอัปเดต = ตอนรัน `app:install` — ถ้าหน้านั้นเตือนว่า "ยังไม่ได้รัน app:install" แปลว่า git pull แล้วแต่ข้ามคำสั่งสุดท้าย ให้รันเลย

## 8. เรื่องฉุกเฉิน

| เหตุการณ์ | ทำอย่างไร |
| --- | --- |
| แอดมินทำมือถือหาย | ล็อกอินด้วยรหัสสำรอง 1 ชุด → ตั้ง Google Authenticator ใหม่ · รหัสสำรองหมด: ให้แอดมินอีกคนกด "ปลด 2FA" หรือรัน `sudo -u www php spark 2fa:reset <username>` บนเซิร์ฟเวอร์ |
| ร้านทำมือถือหาย (ร้านเปิด 2FA เอง) | แอดมินกด "ปลด 2FA" ที่หน้าร้านค้า (ต้องใส่รหัส 6 หลักของแอดมิน) |
| สงสัยว่ารหัส/เครื่องแอดมินหลุด | เปลี่ยนรหัสผ่าน → ทุกเครื่องที่ล็อกอินไว้หลุดทันที · ดู "ประวัติรายการ" ว่ามีใครแก้บัญชีรับเงินไหม |
| บัญชีถูกถาม captcha แต่ช่องขึ้นไม่ได้ (Cloudflare ล่ม / ลบ widget ไปแล้ว) | แอดมินที่ยังเข้าได้กด "ปิด" ที่หน้าตั้งค่า → กันบอทเดารหัสผ่าน · ไม่มีใครเข้าได้: `mysql -u paynest -p paynest -e "DELETE FROM app_settings WHERE name IN ('turnstile.siteKey', 'turnstile.secret');"` |
| อยากเตะทุกคนออกจากระบบ | ลบบรรทัด `jwtSecret` ใน `writable/data/secrets.json` (ระบบสุ่มใหม่ในคำขอถัดไป · Google Authenticator ไม่กระทบ) |
| `/health` บอก `schedule` | cron ไม่เดิน — ดูข้อ 3 · ลองสั่ง `sudo -u www php spark schedule:run --verbose` ดูว่ามี error อะไร |
| ดิสก์เต็ม | ลบไฟล์ใน `writable/data/backups/db/` ที่เก่ามาก (ที่คัดลอกออกนอกเครื่องแล้ว) หรือตั้ง `paynest.backupKeepDays = 14` ใน `.env` |
| ดู log | `writable/logs/log-<วันที่>.log` · error ของ nginx/PHP-FPM ใน aaPanel: Website → Logs |

## ห้ามทำบนเครื่องจริง

- ตั้ง `CI_ENVIRONMENT = development` — ไม่บังคับ Google Authenticator
- `php spark db:seed DemoSeeder` — ระบบไม่ยอมรันอยู่แล้ว (ใส่บัญชีรหัสตัวอย่าง)
- `php spark app:reset` — ระบบไม่ยอมรันอยู่แล้ว ถ้าจำเป็นต้องล้างจริง ให้ DROP DATABASE เองด้วยมือ
- รัน `php spark …` ด้วย root — ไฟล์ที่สร้างจะเป็นของ root แล้วเว็บอ่านไม่ได้
- ชี้ root ของเว็บไปที่รากโปรเจกต์แทน `public/`
- commit / ส่งต่อโฟลเดอร์ `writable/data/` หรือไฟล์ `.env` — มีกุญแจลับ รหัสฐานข้อมูล ข้อมูลร้าน และรูปสลิป
