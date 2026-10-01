#!/usr/bin/env bash
# =============================================================================
# deploy.sh — ติดตั้ง PayNest ครั้งแรกบนเซิร์ฟเวอร์ (รันซ้ำได้: ของที่มีแล้วไม่ทำซ้ำ ไม่ล้างข้อมูล)
#
#   sudo ./deploy.sh
#   (ในเชลล์ root) read -rsp 'DB_PASS: ' DB_PASS; echo
#                  DB_PASS=$DB_PASS APP_URL=https://paynest.live DB_NAME=paynest DB_USER=paynest ./deploy.sh
#   ./deploy.sh --dry-run     ดูว่าจะทำอะไรบ้าง โดยไม่แก้อะไรในเครื่อง
#   ./deploy.sh --help        ค่าที่ตั้งได้ทั้งหมด
#
# รันจบเองโดยไม่ถามอะไร · ทุกค่ามีค่าตั้งต้น/หาเอง และตั้งทับได้ด้วยตัวแปรสภาพแวดล้อมหรือ --ตัวเลือก
# ขั้นตอนเดียวกับ DEPLOY.md ข้อ 1 (ติดตั้ง) และข้อ 3 (cron) · ไฟล์นี้ทำงานลำพังได้ ไม่พึ่งไฟล์อื่น
# exit code: 0 = สำเร็จ · 1 = ไม่สำเร็จ (ดูข้อความ ✗) · 2 = ตัวเลือกผิด
# =============================================================================
# สั่งด้วย sh deploy.sh (dash) → สลับไปใช้ bash เอง
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -Eeuo pipefail
IFS=$' \t\n'
umask 022
export LC_ALL=C

SCRIPT_NAME=deploy.sh
LOG_KIND=deploy
FAIL_TITLE='ติดตั้งไม่สำเร็จ'
STEP_TOTAL=10
REQUIRED_EXTS="intl mbstring mysqli curl gd openssl zlib"
KNOWN_VARS="APP_URL DB_HOST DB_PORT DB_NAME DB_USER DB_PASS DB_PASS_FILE DB_ROOT_USER DB_ROOT_PASS DB_ROOT_PASS_FILE TRUST_PROXY SKIP_CRON SKIP_DB_CREATE ALLOW_NEW_SECRETS BRANCH WEB_USER PHP_BIN COMPOSER_BIN DRY_RUN"
BOOL_VARS="SKIP_CRON SKIP_DB_CREATE ALLOW_NEW_SECRETS DRY_RUN"
SECRET_VARS="DB_PASS DB_ROOT_PASS" # ห้ามส่งเป็น --ตัวเลือก (จะโผล่ใน ps ให้ทุกคนในเครื่องเห็น)

usage() {
    cat <<'EOF'
deploy.sh — ติดตั้ง PayNest ครั้งแรก (รันซ้ำได้ — ของที่มีแล้วไม่ทำซ้ำ ไม่ล้างข้อมูล)

วิธีใช้
  sudo ./deploy.sh [ตัวเลือก]
  ส่งรหัสผ่านทางตัวแปรสภาพแวดล้อมในเชลล์ root (sudo -s ก่อน) — ไม่ขึ้นจอ ไม่เข้า history ไม่โผล่ใน ps:
    read -rsp 'DB_PASS: ' DB_PASS; echo
    DB_PASS=$DB_PASS APP_URL=https://paynest.live DB_NAME=paynest DB_USER=paynest ./deploy.sh
  (อย่าพิมพ์ sudo DB_PASS='…' ./deploy.sh — รหัสจะอยู่ในรายการ ps ของ sudo ตลอดการติดตั้ง)

ตัวเลือก
  --dry-run        แสดงว่าจะทำอะไรบ้าง โดยไม่แก้อะไรในเครื่อง
  --help           แสดงหน้านี้
  ทุกค่าด้านล่างตั้งเป็นตัวแปรสภาพแวดล้อม หรือส่งเป็นตัวเลือกตัวเล็กก็ได้
  เช่น --app-url=https://paynest.live  --db-name=paynest  --skip-cron  (ตัวเลือกชนะตัวแปรสภาพแวดล้อม)
  ยกเว้นรหัสผ่าน: --db-pass / --db-root-pass ใช้ไม่ได้ — ใช้ตัวแปรสภาพแวดล้อม หรือ DB_PASS_FILE / DB_ROOT_PASS_FILE

ค่าที่ตั้งได้
  APP_URL         ที่อยู่เว็บ เช่น https://paynest.live — ใส่ใน app.baseURL และใช้ตรวจ /health ตอนจบ
                  (ค่าตั้งต้น: ไม่มี = ข้ามการตรวจ /health)
  DB_HOST         ที่อยู่ฐานข้อมูล (ค่าตั้งต้น: 127.0.0.1)
  DB_PORT         พอร์ตฐานข้อมูล (ค่าตั้งต้น: 3306)
  DB_NAME         ชื่อฐานข้อมูล (ค่าตั้งต้น: paynest)
  DB_USER         ผู้ใช้ฐานข้อมูลของระบบ (ค่าตั้งต้น: paynest)
  DB_PASS         รหัสของ DB_USER (ค่าตั้งต้น: สุ่มให้ 32 ตัวแล้วเก็บใน .env)
  DB_PASS_FILE    อ่าน DB_PASS จากบรรทัดแรกของไฟล์นี้แทน (ไฟล์ควรเป็น chmod 600)
  DB_ROOT_USER    ผู้ใช้ MySQL ที่สร้างฐานข้อมูล/ผู้ใช้ได้ เช่น root
                  (ค่าตั้งต้น: ไม่มี = ลอง mysql -uroot ผ่าน socket เมื่อรันด้วย root)
  DB_ROOT_PASS    รหัสของ DB_ROOT_USER (ค่าตั้งต้น: ว่าง)
  DB_ROOT_PASS_FILE  อ่าน DB_ROOT_PASS จากบรรทัดแรกของไฟล์นี้แทน
  TRUST_PROXY     1 = มี Cloudflare (เมฆสีส้ม) หรือ load balancer อยู่หน้าเว็บ (ค่าตั้งต้น: 0)
  SKIP_CRON       1 = ไม่ตั้ง cron ให้ จะตั้งเองในหน้า Cron ของ aaPanel (ค่าตั้งต้น: 0)
  SKIP_DB_CREATE  1 = ไม่สร้างฐานข้อมูล/ผู้ใช้ให้ สร้างไว้เองแล้ว (ค่าตั้งต้น: 0)
  ALLOW_NEW_SECRETS  1 = ยอมให้สุ่มกุญแจลับใหม่ เมื่อฐานข้อมูลติดตั้งแล้วแต่ไม่พบ secrets.json
                  (ค่าตั้งต้น: 0 = หยุด — กุญแจใหม่ทำให้ Google Authenticator และลิงก์ของร้านใช้ไม่ได้ทั้งหมด)
  BRANCH          branch ที่ตั้งใจใช้ — แค่ตรวจและแสดงผล (ค่าตั้งต้น: branch ปัจจุบัน)
  WEB_USER        ผู้ใช้ของเว็บ/PHP-FPM (ค่าตั้งต้น: หาเอง www → www-data → nginx → apache)
  PHP_BIN         โปรแกรม PHP 8.2+ (ค่าตั้งต้น: /www/server/php/<รุ่นสูงสุด>/bin/php → php)
  COMPOSER_BIN    โปรแกรม composer (ค่าตั้งต้น: composer → .composer-bin/composer.phar → ดาวน์โหลด)

หมายเหตุ
  - มี .env อยู่แล้ว = ไม่แก้ไฟล์นั้นเลย ค่าฐานข้อมูลอ่านจาก .env (DB_* ที่ส่งมาจะถูกละไว้)
  - รันด้วย root: คำสั่ง php spark ทุกคำสั่งรันในนาม WEB_USER · ไม่ใช่ root: ต้องเป็นผู้ใช้เดียวกับ WEB_USER
  - เครื่องมี PHP หลายรุ่น: ตั้ง PHP_BIN ให้ตรงกับรุ่นที่เว็บใช้ เช่น PHP_BIN=/www/server/php/82/bin/php
  - ไม่พิมพ์รหัสผ่านใด ๆ ออกหน้าจอ/log · log อยู่ที่ writable/logs/deploy-<วันเวลา>.log
  - ขั้นตอนที่ต้องทำเองต่อ (เว็บเซิร์ฟเวอร์, SSL, Telegram ฯลฯ) สรุปให้ตอนจบ — ดู DEPLOY.md
EOF
}

# ─── ตัวเลือก ────────────────────────────────────────────────────────────────

die_usage() {
    printf '✗ %s\n  ดูวิธีใช้: ./%s --help\n' "$1" "$SCRIPT_NAME" >&2
    exit 2
}

word_in() { # word list...
    case " $2 " in *" $1 "*) return 0 ;; esac
    return 1
}

opt_to_var() { # --db-name → DB_NAME
    printf '%s' "${1#--}" | tr 'abcdefghijklmnopqrstuvwxyz-' 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_'
}

die_secret_flag() { # --db-pass DB_PASS
    die_usage "ห้ามส่งรหัสผ่านเป็นตัวเลือก $1 — ผู้ใช้อื่นในเครื่องเห็นได้ใน ps
  ใช้ตัวแปรสภาพแวดล้อมในเชลล์ root: read -rsp '$2: ' $2; echo; $2=\$$2 ./$SCRIPT_NAME
  หรือเก็บในไฟล์ chmod 600 แล้วส่ง ${2}_FILE=/root/ไฟล์ ./$SCRIPT_NAME"
}

parse_args() {
    local name value
    while [ $# -gt 0 ]; do
        case $1 in
            -h | --help) usage; exit 0 ;;
            -n | --dry-run) DRY_RUN=1 ;;
            --*=*)
                name=$(opt_to_var "${1%%=*}")
                value=${1#*=}
                word_in "$name" "$KNOWN_VARS" || die_usage "ไม่รู้จักตัวเลือก: ${1%%=*}"
                word_in "$name" "$SECRET_VARS" && die_secret_flag "${1%%=*}" "$name"
                printf -v "$name" '%s' "$value"
                ;;
            --?*)
                name=$(opt_to_var "$1")
                word_in "$name" "$KNOWN_VARS" || die_usage "ไม่รู้จักตัวเลือก: $1"
                word_in "$name" "$SECRET_VARS" && die_secret_flag "$1" "$name"
                if word_in "$name" "$BOOL_VARS"; then
                    printf -v "$name" '%s' 1
                elif [ $# -ge 2 ]; then
                    printf -v "$name" '%s' "$2"
                    shift
                else
                    die_usage "ตัวเลือก $1 ต้องมีค่า เช่น $1=ค่า"
                fi
                ;;
            *) die_usage "ไม่รู้จักตัวเลือก: $1" ;;
        esac
        shift
    done
}

# ─── ที่อยู่ของสคริปต์ (ตาม symlink แบบไม่พึ่ง readlink -f) ────────────────────

resolve_app_dir() {
    local src=${BASH_SOURCE[0]} dir
    while [ -h "$src" ]; do
        dir=$(cd -P "$(dirname "$src")" && pwd)
        src=$(readlink "$src")
        case $src in /*) ;; *) src=$dir/$src ;; esac
    done
    cd -P "$(dirname "$src")" && pwd
}

# ─── หน้าจอ + log ────────────────────────────────────────────────────────────

setup_colors() {
    C_OK='' C_ERR='' C_WARN='' C_HEAD='' C_DIM='' C_B='' C_0=''
    if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
        C_OK=$'\033[32m' C_ERR=$'\033[31m' C_WARN=$'\033[33m' C_HEAD=$'\033[1;36m' C_DIM=$'\033[2m' C_B=$'\033[1m' C_0=$'\033[0m'
    fi
}

STEP_NO=0
CURRENT_STEP='เริ่มต้น'
WARNINGS=0

step() {
    STEP_NO=$((STEP_NO + 1))
    CURRENT_STEP="[$STEP_NO/$STEP_TOTAL] $1"
    printf '\n%s%s%s\n' "$C_HEAD" "$CURRENT_STEP" "$C_0"
}
ok() { printf '  %s✓%s %s\n' "$C_OK" "$C_0" "$*"; }
warn() {
    printf '  %s⚠ %s%s\n' "$C_WARN" "$*" "$C_0"
    WARNINGS=$((WARNINGS + 1))
}
info() { printf '    %s\n' "$*"; }
plan() { printf '  %s→ [dry-run] %s%s\n' "$C_DIM" "$*" "$C_0"; }
indent() { sed -e '/^[[:space:]]*$/d' -e 's/^/    │ /'; }

# fail "ข้อความหลัก" ["บรรทัดอธิบาย" ...] — พิมพ์ ✗ แล้วจบด้วย exit 1
fail() {
    printf '  %s✗ %s%s\n' "$C_ERR" "$1" "$C_0"
    shift
    local line
    for line in "$@"; do info "$line"; done
    finish_failed 1
}

finish_failed() {
    printf '\n%s✗ %s — หยุดที่ขั้น %s%s\n' "$C_ERR" "$FAIL_TITLE" "$CURRENT_STEP" "$C_0"
    if [ -n "${LOG_FILE:-}" ]; then printf '  log: %s\n' "$LOG_FILE"; fi
    printf '  แก้ตามข้อความด้านบนแล้วรัน ./%s ใหม่ได้เลย (รันซ้ำได้ ไม่ล้างข้อมูล)\n' "$SCRIPT_NAME"
    exit "$1"
}

on_err() {
    local rc=$1 cmd=$2
    # ERR ที่เกิดใน subshell ซ้อน: ปล่อยให้ระดับบนรายงานครั้งเดียว
    if [ "${BASH_SUBSHELL:-0}" -gt "${MAIN_SUBSHELL:-0}" ]; then exit "$rc"; fi
    trap - ERR
    printf '  %s✗ คำสั่งล้มเหลว (exit code %s): %s%s\n' "$C_ERR" "$rc" "$cmd" "$C_0"
    finish_failed 1
}

# สำเนาทุกบรรทัดลง log (fd 3 · ตัดสีออก) — ไม่สนใจ Ctrl-C/SSH หลุด เพื่อเก็บข้อความของสคริปต์ให้ครบจนจบ
# จอหาย (SSH หลุด / tee ตาย) = เลิกเขียนจอ แต่เขียน log ต่อ
log_tee() {
    trap '' INT TERM HUP PIPE
    local line plain tty_ok=1
    while IFS= read -r line || [ -n "$line" ]; do
        plain=$line
        if [ -n "$C_0" ]; then
            plain=${plain//"$C_OK"/} plain=${plain//"$C_ERR"/} plain=${plain//"$C_WARN"/} plain=${plain//"$C_HEAD"/}
            plain=${plain//"$C_DIM"/} plain=${plain//"$C_B"/} plain=${plain//"$C_0"/}
        fi
        printf '%s\n' "$plain" >&3
        if [ "$tty_ok" = 1 ]; then printf '%s\n' "$line" 2>/dev/null || tty_ok=0; fi
    done
}

# เปิด log แบบ O_EXCL (set -C) — ไม่เขียนทับ/ไม่ตาม symlink ที่ใครวางไว้ใน writable/logs (ผู้ใช้เว็บเขียนโฟลเดอร์นั้นได้)
open_log_fd() { # path → fd 3
    if [ -e "$1" ] || [ -L "$1" ]; then return 1; fi
    set -C
    if ! { exec 3>"$1"; } 2>/dev/null; then
        set +C
        return 1
    fi
    set +C
    if [ ! -f /dev/fd/3 ] || [ -L "$1" ]; then # เปิดได้แต่ไม่ใช่ไฟล์ธรรมดา (symlink ไปอุปกรณ์ที่วางแข่งเวลา) — ไม่ใช้
        exec 3>&-
        return 1
    fi
}

open_log() {
    local dir=$APP_DIR/writable/logs stamp rnd wu
    if [ "$(id -u)" = 0 ] && { [ -L "$APP_DIR/writable" ] || [ -L "$dir" ]; }; then
        printf '✗ %s เป็น symlink — ไม่เขียน log ตาม symlink ด้วยสิทธิ์ root (แก้ให้เป็นโฟลเดอร์จริงแล้วรันใหม่)\n' "$dir" >&2
        exit 1
    fi
    if ! mkdir -p "$dir" 2>/dev/null || [ ! -w "$dir" ]; then
        printf '✗ เขียนโฟลเดอร์ log ไม่ได้: %s (สิทธิ์ไม่พอ)\n' "$dir" >&2
        printf '  ต้องรันด้วย root: sudo ./%s · หรือรันในนามผู้ใช้เว็บที่เป็นเจ้าของโฟลเดอร์ writable/\n' "$SCRIPT_NAME" >&2
        exit 1
    fi
    stamp=$(date +%Y%m%d-%H%M%S)
    LOG_FILE=$dir/$LOG_KIND-$stamp.log
    umask 027
    if ! open_log_fd "$LOG_FILE"; then
        rnd=$(od -An -N4 -tx4 /dev/urandom 2>/dev/null | tr -d ' \n' || true)
        LOG_FILE=$dir/$LOG_KIND-$stamp-${rnd:-$RANDOM$RANDOM}.log
        if ! open_log_fd "$LOG_FILE"; then
            printf '✗ สร้างไฟล์ log ใน %s ไม่ได้\n' "$dir" >&2
            exit 1
        fi
    fi
    umask 022
    # รันด้วย root: ให้ผู้ใช้เว็บเป็นเจ้าของ log (เหมือนไฟล์อื่นใน writable/) — chown ผ่าน fd ที่เปิดไว้ (ไม่ตามชื่อไฟล์ที่อาจถูกสลับ)
    if [ "$(id -u)" = 0 ]; then
        wu=${WEB_USER:-}
        if [ -z "$wu" ]; then for _c in www www-data nginx apache; do if id -u "$_c" >/dev/null 2>&1; then wu=$_c && break; fi; done; fi
        if [ -n "$wu" ] && id -u "$wu" >/dev/null 2>&1 && [ "$(id -u "$wu")" != 0 ]; then
            if [ -e /proc/self/fd/3 ]; then
                chown "$wu:$(id -gn "$wu")" /proc/self/fd/3 2>/dev/null || true
            else
                chown -h "$wu:$(id -gn "$wu")" "$LOG_FILE" 2>/dev/null || true
            fi
        fi
    fi
}

# ─── เครื่องมือทั่วไป ───────────────────────────────────────────────────────

have() { command -v "$1" >/dev/null 2>&1; }

is_true() {
    case ${1:-} in 1 | y | Y | yes | YES | true | TRUE | on | ON) return 0 ;; esac
    return 1
}

# หนีอักขระสำหรับค่าในเครื่องหมาย '…' ทั้งใน .env และ SQL: \ → \\ และ ' → \'
esc_sq() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g"; }

# quote สำหรับ /bin/sh (ใช้กับ su -c)
sh_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# อ่านค่าจากไฟล์ .env แบบเดียวกับ CodeIgniter (บรรทัดแรกที่เจอชนะ · รองรับ '…' "…" และ # คอมเมนต์ท้ายบรรทัด)
env_get() { # file key → พิมพ์ค่า (ไม่มี = exit 1)
    PN_KEY=$2 awk '
        BEGIN { want = ENVIRON["PN_KEY"]; found = 0 }
        /^[ \t]*#/ { next }
        {
            line = $0
            sub(/^[ \t]*export[ \t]+/, "", line)
            i = index(line, "=")
            if (i == 0) next
            k = substr(line, 1, i - 1); gsub(/^[ \t]+|[ \t]+$/, "", k)
            if (k != want) next
            v = substr(line, i + 1); gsub(/^[ \t]+|[ \t\r]+$/, "", v)
            q = substr(v, 1, 1)
            if (q == "\047" || q == "\"") {
                out = ""; n = length(v); j = 2
                while (j <= n) {
                    c = substr(v, j, 1)
                    if (c == "\\" && j < n) {
                        d = substr(v, j + 1, 1)
                        if (d == q || d == "\\") { out = out d; j += 2; continue }
                    }
                    if (c == q) break
                    out = out c; j++
                }
                v = out
            } else {
                h = index(v, " #"); if (h > 0) v = substr(v, 1, h - 1)
                gsub(/[ \t]+$/, "", v)
            }
            print v; found = 1; exit
        }
        END { exit(found ? 0 : 1) }
    ' "$1"
}

# ตั้งค่า key ในไฟล์ .env (แทนบรรทัดแรกที่ไม่ใช่คอมเมนต์ · ไม่มี = ต่อท้าย) — awk → ไฟล์ชั่วคราว → mv
env_set() { # file key rendered-value
    (umask 077 && PN_KEY=$2 PN_VAL=$3 awk '
        BEGIN { k = ENVIRON["PN_KEY"]; v = ENVIRON["PN_VAL"]; done = 0 }
        {
            if (!done && $0 !~ /^[ \t]*#/) {
                i = index($0, "=")
                if (i > 0) {
                    kk = substr($0, 1, i - 1); gsub(/^[ \t]+|[ \t]+$/, "", kk)
                    if (kk == k) { print substr($0, 1, i) " " v; done = 1; next }
                }
            }
            print
        }
        END { if (!done) print k " = " v }
    ' "$1" >"$1.tmp")
    mv -f "$1.tmp" "$1"
}

# ข้อความหลัง marker ในบรรทัดแรกที่เจอ (ไม่ใช้ | head ที่อาจโดน SIGPIPE ตอน pipefail)
after_marker() { # file marker
    PN_M=$2 awk 'BEGIN { m = ENVIRON["PN_M"] } { i = index($0, m); if (i) { print substr($0, i + length(m)); exit } }' "$1"
}

code_version() {
    sed -n "/const VERSION = /{s/.*const VERSION = '\([^']*\)'.*/\1/p;q;}" "$APP_DIR/app/Config/Paynest.php" 2>/dev/null || true
}

# ไม่ใส่ -c safe.directory: root ห้ามรัน git ใน repo ที่ผู้ใช้อื่นแก้ได้ (ดู check_repo_owner)
g() { git -C "$APP_DIR" "$@"; }

is_git_repo() { [ -e "$APP_DIR/.git" ] && have git; }

uid_of() { ls -lnd "$1" 2>/dev/null | awk '{ print $3; exit }'; }

# รันด้วย root: โฟลเดอร์โค้ด/.git ต้องไม่ใช่ของผู้ใช้เว็บ — ถ้าผู้ใช้เว็บแก้ .git ได้ (core.fsmonitor / hooks /
# core.sshCommand) git ที่ root รันจะรันโปรแกรมของเขาด้วยสิทธิ์ root = เว็บโดนเจาะแล้วยึดเครื่องได้
check_repo_owner() {
    [ "$IS_ROOT" = 1 ] || return 0
    local p web_uid bad=''
    web_uid=$(id -u "$WEB_USER")
    for p in "$APP_DIR" "$APP_DIR/.git" "$APP_DIR/.git/config" "$APP_DIR/.git/hooks"; do
        [ -e "$p" ] || continue
        if [ "$(uid_of "$p")" = "$web_uid" ]; then bad=$p && break; fi
    done
    [ -z "$bad" ] && return 0
    fail "โค้ด ($bad) เป็นของผู้ใช้เว็บ $WEB_USER — ไม่รัน git ด้วยสิทธิ์ root ในโฟลเดอร์ที่ผู้ใช้เว็บแก้ได้" \
        "(ถ้าเว็บโดนเจาะ คนร้ายแก้ .git แล้วได้สิทธิ์ root ตอนสคริปต์รัน git) — เลือกทางใดทางหนึ่ง:" \
        "  ให้ root เป็นเจ้าของโค้ด (เว็บยังอ่านได้ตามปกติ — ต้องเขียนได้แค่ writable/ และอ่าน .env):" \
        "    chown -R root:root $APP_DIR; chown -R $WEB_USER:$WEB_GROUP $APP_DIR/writable $APP_DIR/.env" \
        "    (aaPanel: .user.ini ขึ้น Operation not permitted — ไม่เป็นไร) แล้วรัน sudo ./$SCRIPT_NAME ใหม่" \
        "  หรือรันในนามผู้ใช้เว็บแทน root: sudo -u $WEB_USER WEB_USER=$WEB_USER ./$SCRIPT_NAME"
}

# รันในนามผู้ใช้เว็บ: root → runuser / sudo / su · ไม่ใช่ root → รันตรง (ตรวจแล้วว่าเป็นผู้ใช้เดียวกัน)
as_web() {
    if [ "$IS_ROOT" != 1 ]; then
        "$@"
        return
    fi
    if have runuser; then
        runuser -u "$WEB_USER" -- "$@"
    elif have sudo; then
        sudo -n -u "$WEB_USER" -- "$@"
    else
        local cmd arg
        cmd="cd $(sh_quote "$APP_DIR") &&"
        for arg in "$@"; do cmd="$cmd $(sh_quote "$arg")"; done
        su -s /bin/sh -c "$cmd" "$WEB_USER"
    fi
}

spark() { as_web "$PHP_BIN" "$APP_DIR/spark" "$@" --no-header; }

# รันคำสั่ง spark เก็บผลไว้ในไฟล์แล้วแสดงแบบย่อหน้า — คืน exit code ของคำสั่ง
spark_capture() { # outfile args...
    local out=$1 rc=0
    shift
    spark "$@" </dev/null >"$out" 2>&1 || rc=$?
    indent <"$out"
    return "$rc"
}

php_db_tool() { # mode — ค่าเชื่อมต่อส่งทางตัวแปร PN_* (ไม่โผล่ใน ps / log)
    "$PHP_BIN" "$TMPD/dbtool.php" "$1"
}

write_db_tool() {
    cat >"$TMPD/dbtool.php" <<'PHP'
<?php
// ตัวช่วยฐานข้อมูลของ deploy.sh / update.sh — รหัสผ่านอ่านจากตัวแปรสภาพแวดล้อม ไม่พิมพ์ออกมา
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
$env = static fn (string $k): string => (string) getenv($k);
$connect = static function (string $user, string $pass, ?string $db) use ($env): mysqli {
    $m = mysqli_init();
    $m->options(MYSQLI_OPT_CONNECT_TIMEOUT, 10);
    $m->real_connect($env('PN_DB_HOST'), $user, $pass, $db, (int) $env('PN_DB_PORT'));
    $m->set_charset('utf8mb4');
    return $m;
};
try {
    switch ($argv[1] ?? '') {
        case 'check':
            $m = $connect($env('PN_DB_USER'), $env('PN_DB_PASS'), $env('PN_DB_NAME'));
            echo $m->server_info, "\n";
            exit(0);
        case 'create':
            // stdout: created = สร้างผู้ใช้ใหม่ด้วยรหัสนี้ (อย่างน้อยหนึ่ง host) · existed = มีผู้ใช้อยู่ก่อนแล้ว (ไม่เปลี่ยนรหัส)
            // พังหลังสร้างผู้ใช้ไปแล้ว = exit 13 (รหัสใน .env ใช้กับผู้ใช้นั้นแล้ว ห้ามลบ .env)
            $m       = $connect($env('PN_ADMIN_USER'), $env('PN_ADMIN_PASS'), null);
            $created = false;
            try {
                $db = str_replace('`', '``', $env('PN_DB_NAME'));
                $m->query("CREATE DATABASE IF NOT EXISTS `{$db}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
                foreach (preg_split('/\s+/', trim($env('PN_DB_USER_HOSTS'))) as $host) {
                    $who = "'" . $m->real_escape_string($env('PN_DB_USER')) . "'@'" . $m->real_escape_string($host) . "'";
                    $m->query("CREATE USER IF NOT EXISTS {$who} IDENTIFIED BY '" . $m->real_escape_string($env('PN_DB_PASS')) . "'");
                    if ($m->warning_count === 0) { // มีอยู่แล้ว = ได้ Note 1973 (MariaDB) / 3163 (MySQL)
                        $created = true;
                    }
                    $m->query("GRANT ALL PRIVILEGES ON `{$db}`.* TO {$who}");
                }
            } catch (mysqli_sql_exception $e) {
                fwrite(STDERR, '[' . $e->getCode() . '] ' . $e->getMessage() . "\n");
                exit($created ? 13 : 11);
            }
            echo $created ? "created\n" : "existed\n";
            exit(0);
        case 'migrations-max':
            $m = $connect($env('PN_DB_USER'), $env('PN_DB_PASS'), $env('PN_DB_NAME'));
            try {
                echo (int) $m->query('SELECT COALESCE(MAX(id), 0) FROM migrations')->fetch_row()[0], "\n";
            } catch (mysqli_sql_exception) {
                echo "0\n"; // ยังไม่มีตาราง = ยังไม่เคยติดตั้ง
            }
            exit(0);
        case 'migrations-since':
            $m   = $connect($env('PN_DB_USER'), $env('PN_DB_PASS'), $env('PN_DB_NAME'));
            $res = $m->query('SELECT version, class FROM migrations WHERE id > ' . (int) $env('PN_SINCE') . ' ORDER BY id');
            foreach ($res as $row) {
                $parts = explode('\\', (string) $row['class']);
                echo $row['version'], '_', end($parts), "\n";
            }
            exit(0);
    }
    fwrite(STDERR, "unknown mode\n");
    exit(12);
} catch (mysqli_sql_exception $e) {
    fwrite(STDERR, '[' . $e->getCode() . '] ' . $e->getMessage() . "\n");
    // 1044/1045/1698 = สิทธิ์/รหัสไม่ถูก · 1049 = ยังไม่มีฐานข้อมูล → สร้างให้ได้ · อื่น ๆ = ต่อเซิร์ฟเวอร์ไม่ได้
    exit(in_array($e->getCode(), [1044, 1045, 1049, 1698], true) ? 10 : 11);
}
PHP
}

# ส่งค่าเชื่อมต่อของระบบให้ dbtool ทางตัวแปรสภาพแวดล้อม
db_app() { # mode
    PN_DB_HOST=$DB_HOST PN_DB_PORT=$DB_PORT PN_DB_NAME=$DB_NAME PN_DB_USER=$DB_USER PN_DB_PASS=$DB_PASS php_db_tool "$1"
}

http_check() { # url → พิมพ์ "code body" · curl ไม่มี = exit 127
    local url=$1 code
    have curl || return 127
    code=$(curl -sS --max-time 15 -o "$TMPD/health.out" -w '%{http_code}' "$url" 2>"$TMPD/health.err") || code=000
    printf '%s' "$code"
}

# กุญแจลับตั้งไว้ใน .env ทั้งสองตัว = ระบบไม่ใช้ secrets.json (Secrets::load)
secrets_in_env() {
    [ -f "$APP_DIR/.env" ] &&
        [ -n "$(env_get "$APP_DIR/.env" paynest.jwtSecret 2>/dev/null || true)" ] &&
        [ -n "$(env_get "$APP_DIR/.env" paynest.encryptionKey 2>/dev/null || true)" ]
}

data_dir() { # โฟลเดอร์ข้อมูลของระบบ ตาม paynest.dataDir / PAYNEST_DATA_DIR (ค่าตั้งต้น writable/data)
    local d=${PAYNEST_DATA_DIR:-}
    if [ -z "$d" ] && [ -f "$APP_DIR/.env" ]; then d=$(env_get "$APP_DIR/.env" paynest.dataDir 2>/dev/null || true); fi
    if [ -z "$d" ]; then d=$APP_DIR/writable/data; fi
    case $d in /*) ;; *) d=$APP_DIR/$d ;; esac
    printf '%s' "${d%/}"
}

# ─── ล็อก: กันรัน deploy.sh / update.sh ซ้อนกัน ───────────────────────────────

LOCK_HELD=0
write_lock_info() { # set -C: ไม่เขียนตาม symlink/ไฟล์ที่ใครวางไว้ในล็อก
    if ! (set -C && printf '%s\n' "$$" >"$LOCK_DIR/pid" && printf '%s\n' "${0##*/}" >"$LOCK_DIR/name") 2>/dev/null; then
        rm -rf "$LOCK_DIR" 2>/dev/null || true
        fail "เขียนข้อมูลล็อก $LOCK_DIR ไม่ได้ — ลองใหม่อีกครั้ง"
    fi
    LOCK_HELD=1
}

acquire_lock() {
    LOCK_DIR=$APP_DIR/writable/update.lock
    mkdir -p "$APP_DIR/writable" 2>/dev/null || true
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        write_lock_info
        return
    fi
    if [ ! -d "$LOCK_DIR" ]; then
        fail "สร้างล็อก $LOCK_DIR ไม่ได้ — เขียนโฟลเดอร์ $APP_DIR/writable ไม่ได้ (สิทธิ์ไม่พอ)" \
            "ต้องรันด้วย root: sudo ./$SCRIPT_NAME · หรือรันในนามผู้ใช้เว็บที่เป็นเจ้าของ writable/"
    fi
    local other cmd owner stale
    other=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    owner=$(cat "$LOCK_DIR/name" 2>/dev/null || true)
    if [ -z "$other" ] && [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin -1 2>/dev/null)" ]; then
        fail "มีการติดตั้ง/อัปเดตอีกตัวกำลังเริ่มทำงาน — รอให้จบก่อนแล้วค่อยรันใหม่"
    fi
    if [ -n "$other" ]; then
        cmd=$(ps -p "$other" -o command= 2>/dev/null || true)
        case $cmd in
            *deploy.sh* | *update.sh* | *"${owner:-update.sh}"*)
                fail "มีการติดตั้ง/อัปเดตอีกตัวกำลังทำงานอยู่ (PID $other) — รอให้จบก่อนแล้วค่อยรันใหม่" \
                    "ถ้าแน่ใจว่าไม่มีตัวไหนทำงานอยู่จริง: rm -rf $LOCK_DIR"
                ;;
        esac
    fi
    # ยึดล็อกค้างแบบ "ย้ายออก" (rename เป็น atomic) แล้วตรวจว่าที่ย้ายมาคือล็อกค้างตัวเดิมจริง
    # — สองตัวเจอล็อกค้างพร้อมกัน: ตัวหลังจะย้ายไม่ได้ หรือย้ายได้ล็อกใหม่ของอีกตัวแล้วคืนให้
    stale=$LOCK_DIR.stale.$$
    if ! mv "$LOCK_DIR" "$stale" 2>/dev/null; then
        fail "มีการติดตั้ง/อัปเดตอีกตัวเพิ่งยึดล็อกไป — รอให้จบก่อนแล้วค่อยรันใหม่"
    fi
    if [ "$(cat "$stale/pid" 2>/dev/null || true)" != "$other" ]; then
        if [ ! -e "$LOCK_DIR" ]; then mv "$stale" "$LOCK_DIR" 2>/dev/null || true; fi
        fail "มีการติดตั้ง/อัปเดตอีกตัวเพิ่งยึดล็อกไป — รอให้จบก่อนแล้วค่อยรันใหม่"
    fi
    rm -rf "$stale"
    mkdir "$LOCK_DIR" 2>/dev/null || fail "สร้างล็อก $LOCK_DIR ไม่ได้ — มีอีกตัวเพิ่งเริ่มทำงาน ลองใหม่ภายหลัง"
    warn "พบล็อกค้างจากรอบก่อน (PID ${other:-?} ไม่ได้ทำงานแล้ว) — ยึดล็อกต่อแล้ว"
    write_lock_info
}

cleanup() {
    if [ "$LOCK_HELD" = 1 ]; then rm -rf "$LOCK_DIR" 2>/dev/null || true; fi
    if [ -n "${TMPD:-}" ]; then rm -rf "$TMPD" 2>/dev/null || true; fi
    rm -f "$APP_DIR/.env.tmp-deploy" "$APP_DIR/.env.tmp-deploy.tmp" 2>/dev/null || true
    if [ "${ENV_CREATED_THIS_RUN:-0}" = 1 ] && [ "${KEEP_NEW_ENV:-0}" != 1 ] && [ -f "$APP_DIR/.env" ]; then
        # .env ที่เพิ่งสร้างแต่ใช้ต่อฐานข้อมูลไม่ได้ — ลบทิ้งให้รอบหน้าสร้างใหม่จาก DB_* ที่ส่งมา
        rm -f "$APP_DIR/.env" 2>/dev/null || true
    fi
}

# ─── ขั้นที่ 1: ตรวจความพร้อม ───────────────────────────────────────────────

detect_os() {
    local os name
    os=$(uname -s 2>/dev/null || echo unknown)
    if [ "$os" = Linux ]; then
        name=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"' || true)
        OS_LABEL=${name:-Linux}
    elif [ "$os" = Darwin ]; then
        OS_LABEL="macOS $(sw_vers -productVersion 2>/dev/null || true)"
    else
        OS_LABEL=$os
    fi
    IS_AAPANEL=0
    if [ -d /www/server/panel ]; then IS_AAPANEL=1; fi
    if [ "$IS_AAPANEL" = 1 ]; then OS_LABEL="$OS_LABEL · aaPanel"; fi
    if [ "$os" = Linux ]; then
        ok "ระบบปฏิบัติการ: $OS_LABEL"
    else
        warn "ระบบปฏิบัติการ: $OS_LABEL — สคริปต์นี้ทำมาสำหรับ Linux (ใช้ทดสอบได้)"
    fi
}

detect_user() {
    local me cand
    me=$(id -un)
    IS_ROOT=0
    if [ "$(id -u)" = 0 ]; then IS_ROOT=1; fi
    if [ -z "${WEB_USER:-}" ]; then
        for cand in www www-data nginx apache; do
            if id -u "$cand" >/dev/null 2>&1; then WEB_USER=$cand && break; fi
        done
    fi
    if [ -z "${WEB_USER:-}" ]; then
        if [ "$IS_ROOT" = 1 ]; then
            fail "ไม่พบผู้ใช้ของเว็บ (www, www-data, nginx, apache)" "ระบุเอง เช่น WEB_USER=www-data ./$SCRIPT_NAME"
        fi
        WEB_USER=$me
    fi
    id -u "$WEB_USER" >/dev/null 2>&1 || fail "ไม่มีผู้ใช้ชื่อ $WEB_USER ในเครื่อง" "ตั้ง WEB_USER ให้ตรงกับผู้ใช้ที่ PHP-FPM ใช้ (aaPanel = www · Ubuntu = www-data)"
    WEB_GROUP=$(id -gn "$WEB_USER")
    if [ "$IS_ROOT" = 1 ]; then
        if [ "$WEB_USER" = root ] || [ "$(id -u "$WEB_USER")" = 0 ]; then
            fail "WEB_USER ห้ามเป็น root — ไฟล์ที่ระบบสร้างจะเป็นของ root แล้วเว็บอ่านไม่ได้" "ตั้ง WEB_USER ให้ตรงกับผู้ใช้ของ PHP-FPM (aaPanel = www · Ubuntu = www-data)"
        fi
        local how=su
        if have runuser; then how=runuser; elif have sudo; then how=sudo; fi
        ok "รันด้วย root — คำสั่ง php spark จะรันในนามผู้ใช้เว็บ $WEB_USER (ผ่าน $how)"
    elif [ "$me" = "$WEB_USER" ]; then
        ok "รันในนามผู้ใช้เว็บ $WEB_USER — ข้ามการเปลี่ยนเจ้าของไฟล์ (chown)"
    else
        fail "ต้องรันด้วย root (sudo) หรือรันในนามผู้ใช้เว็บ $WEB_USER — ตอนนี้เป็น $me" \
            "sudo ./$SCRIPT_NAME" \
            "(ถ้า $me คือผู้ใช้ที่ PHP-FPM ใช้จริง: WEB_USER=$me ./$SCRIPT_NAME)"
    fi
}

php_ok() { # path → 0 ถ้าเป็น PHP ≥ 8.2 ที่มีส่วนขยายครบ
    local id mods ext
    [ -x "$1" ] || return 1
    id=$("$1" -r 'echo PHP_VERSION_ID;' 2>/dev/null) || return 1
    [ "${id:-0}" -ge 80200 ] 2>/dev/null || return 1
    mods=$("$1" -m 2>/dev/null | tr 'A-Z' 'a-z') || return 1
    for ext in $REQUIRED_EXTS; do
        case "
$mods
" in *"
$ext
"*) ;; *) return 1 ;; esac
    done
    return 0
}

# aaPanel: รุ่น PHP ที่เว็บของโฟลเดอร์นี้ใช้ — จาก vhost ที่ root = <APP_DIR>/public
# (nginx: include enable-php-82.conf · apache: php-cgi-82.sock) · ไม่เจอ = ว่าง
aapanel_site_php() {
    local f v
    for f in /www/server/panel/vhost/nginx/*.conf /www/server/panel/vhost/apache/*.conf; do
        [ -f "$f" ] || continue
        v=$(PN_ROOT=$APP_DIR/public awk '
            BEGIN { want = ENVIRON["PN_ROOT"]; hit = 0; ver = "" }
            {
                line = $0; gsub(/["\047;]/, " ", line)
                n = split(line, w, " ")
                for (i = 1; i < n; i++) if (w[i] == "root" || w[i] == "DocumentRoot") { p = w[i + 1]; sub(/\/+$/, "", p); if (p == want) hit = 1 }
                if (ver == "" && match($0, /enable-php-[0-9]+\.conf/)) ver = substr($0, RSTART + 11, RLENGTH - 16)
                if (ver == "" && match($0, /php-cgi-[0-9]+\.sock/)) ver = substr($0, RSTART + 8, RLENGTH - 13)
            }
            END { if (hit && ver != "" && ver != "00") print ver }' "$f" 2>/dev/null || true)
        if [ -n "$v" ]; then
            printf '%s' "$v"
            return 0
        fi
    done
    return 0
}

detect_php() {
    local cand ver id mods ext missing='' list='' n note=''
    SITE_PHP=$(aapanel_site_php)
    if [ -n "${PHP_BIN:-}" ]; then
        case $PHP_BIN in */*) ;; *) PHP_BIN=$(command -v "$PHP_BIN" 2>/dev/null || printf '%s' "$PHP_BIN") ;; esac
    else
        # aaPanel: /www/server/php/<84|83|82…>/bin/php — รุ่นที่เว็บนี้ใช้ (จาก vhost) ก่อน ไม่เจอ = รุ่นสูงสุดที่ใช้ได้ (≥ 8.2 + ส่วนขยายครบ)
        for cand in /www/server/php/*/bin/php; do
            [ -x "$cand" ] || continue
            n=${cand#/www/server/php/}
            n=${n%%/*}
            case $n in *[!0-9]*) continue ;; esac
            if [ "$n" -ge 82 ]; then list="$n $list"; fi
        done
        if [ -n "$SITE_PHP" ] && php_ok "/www/server/php/$SITE_PHP/bin/php"; then
            PHP_BIN=/www/server/php/$SITE_PHP/bin/php
            note=" — รุ่นเดียวกับที่เว็บนี้ใช้ใน aaPanel"
        elif [ -n "$list" ]; then
            for n in $(printf '%s\n' $list | sort -rn); do
                if php_ok "/www/server/php/$n/bin/php"; then PHP_BIN=/www/server/php/$n/bin/php && break; fi
            done
            if [ -z "${PHP_BIN:-}" ]; then PHP_BIN=/www/server/php/$(printf '%s\n' $list | sort -rn | sed -n '1p')/bin/php; fi
            if [ "$(printf '%s\n' $list | grep -c .)" -gt 1 ]; then
                warn "เครื่องมี PHP หลายรุ่น ($(printf '%s ' $(printf '%s\n' $list | sort -rn))) ใช้ $PHP_BIN — หาเว็บของโฟลเดอร์นี้ใน aaPanel ไม่เจอ (ยังไม่ได้ Add site?)"
                info "ถ้าเว็บใช้รุ่นอื่น ตั้งเอง เช่น PHP_BIN=/www/server/php/82/bin/php ./$SCRIPT_NAME (cron ใช้รุ่นเดียวกันนี้)"
            fi
        fi
        if [ -z "${PHP_BIN:-}" ]; then PHP_BIN=$(command -v php 2>/dev/null || true); fi
    fi
    if [ -z "${PHP_BIN:-}" ] || [ ! -x "$PHP_BIN" ]; then
        fail "ไม่พบ PHP${PHP_BIN:+ ($PHP_BIN)}" \
            "aaPanel: App Store → ติดตั้ง PHP 8.2 · Ubuntu: apt install php8.2-cli php8.2-fpm" \
            "หรือระบุเอง: PHP_BIN=/www/server/php/82/bin/php ./$SCRIPT_NAME"
    fi
    ver=$("$PHP_BIN" -r 'echo PHP_VERSION;' 2>/dev/null) || fail "เรียก $PHP_BIN ไม่ได้"
    id=$("$PHP_BIN" -r 'echo PHP_VERSION_ID;')
    PHP_MM=$("$PHP_BIN" -r 'echo PHP_MAJOR_VERSION . PHP_MINOR_VERSION;')
    PHP_DOT=$("$PHP_BIN" -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;')
    if [ "$id" -lt 80200 ]; then
        fail "PHP $ver ($PHP_BIN) เก่าเกินไป — ต้อง 8.2 ขึ้นไป" \
            "aaPanel: App Store → ติดตั้ง PHP 8.2 แล้วรัน PHP_BIN=/www/server/php/82/bin/php ./$SCRIPT_NAME"
    fi
    ok "PHP $ver ($PHP_BIN)$note"
    if [ -n "$SITE_PHP" ] && [ "$SITE_PHP" != "$PHP_MM" ]; then
        warn "เว็บนี้ใน aaPanel ใช้ PHP $SITE_PHP แต่สคริปต์ใช้ PHP $PHP_MM ($PHP_BIN) — ควรตั้ง PHP_BIN=/www/server/php/$SITE_PHP/bin/php"
    fi
    mods=$("$PHP_BIN" -m 2>/dev/null | tr 'A-Z' 'a-z')
    for ext in $REQUIRED_EXTS; do
        case "
$mods
" in *"
$ext
"*) ;; *) missing="$missing $ext" ;; esac
    done
    if [ -n "$missing" ]; then
        fail "PHP ยังไม่มีส่วนขยาย:$missing" \
            "aaPanel: App Store → PHP $PHP_DOT → Setting → Install extensions → ติดตั้ง$missing" \
            "(intl กับ mbstring ต้องติดตั้งเพิ่ม · ตัวอื่นติดมากับ PHP ของ aaPanel อยู่แล้ว)" \
            "Ubuntu: apt install$(for ext in $missing; do printf ' php%s-%s' "$PHP_DOT" "$ext"; done) แล้ว systemctl reload php$PHP_DOT-fpm" \
            "ตรวจ: $PHP_BIN -m | grep -iE '^(intl|mbstring|mysqli|curl|gd|openssl|zlib)\$' ต้องขึ้น 7 บรรทัด"
    fi
    ok "ส่วนขยาย PHP ครบ: $REQUIRED_EXTS"
    if [ "$("$PHP_BIN" -r 'echo function_exists("putenv") ? 1 : 0;')" != 1 ]; then
        fail "PHP ปิดฟังก์ชัน putenv ไว้ — CodeIgniter ใช้อ่านไฟล์ .env (php spark จะพัง)" \
            "aaPanel: App Store → PHP $PHP_DOT → Setting → Disabled functions → เอา putenv ออก"
    fi
    if [ "$("$PHP_BIN" -r 'echo function_exists("proc_open") ? 1 : 0;')" != 1 ]; then
        warn "PHP ปิดฟังก์ชัน proc_open ไว้ — composer อาจทำงานไม่ครบ (aaPanel: Disabled functions → เอา proc_open ออก)"
    fi
}

composer_kind() { # path → php (สคริปต์/phar ของ PHP) หรือ bin
    local first
    first=$(sed -n '1{/^#!.*php/p;q;}' "$1" 2>/dev/null || true)
    if [ -n "$first" ]; then echo php; return; fi
    case $1 in *.phar) echo php ;; *) echo bin ;; esac
}

download() { # url dest
    if have curl; then
        curl -fsSL --max-time 120 -o "$2" "$1"
    elif have wget; then
        wget -q -T 120 -O "$2" "$1"
    else
        PN_URL=$1 PN_DEST=$2 "$PHP_BIN" -r 'exit(@copy(getenv("PN_URL"), getenv("PN_DEST")) ? 0 : 1);'
    fi
}

detect_composer() {
    local local_phar=$APP_DIR/.composer-bin/composer.phar expected actual
    if [ -n "${COMPOSER_BIN:-}" ]; then
        case $COMPOSER_BIN in */*) ;; *) COMPOSER_BIN=$(command -v "$COMPOSER_BIN" 2>/dev/null || printf '%s' "$COMPOSER_BIN") ;; esac
        [ -f "$COMPOSER_BIN" ] && [ -r "$COMPOSER_BIN" ] || fail "ไม่พบ composer ที่ COMPOSER_BIN=$COMPOSER_BIN"
    elif have composer; then
        COMPOSER_BIN=$(command -v composer)
    elif [ -f "$local_phar" ]; then
        COMPOSER_BIN=$local_phar
    elif [ "$DRY_RUN" = 1 ]; then
        plan "ไม่พบ composer — จะดาวน์โหลดตัวติดตั้งทางการ ตรวจลายเซ็น SHA-384 แล้วติดตั้งไว้ที่ .composer-bin/composer.phar"
        COMPOSER_BIN=$local_phar
        COMPOSER_KIND=php
        return
    else
        info "ไม่พบ composer — ดาวน์โหลดตัวติดตั้งทางการจาก getcomposer.org"
        mkdir -p "$APP_DIR/.composer-bin"
        download https://composer.github.io/installer.sig "$TMPD/installer.sig" || fail "ดาวน์โหลด https://composer.github.io/installer.sig ไม่ได้ — เครื่องออกเน็ตได้ไหม?"
        download https://getcomposer.org/installer "$TMPD/composer-setup.php" || fail "ดาวน์โหลด https://getcomposer.org/installer ไม่ได้ — เครื่องออกเน็ตได้ไหม?"
        expected=$(tr -d ' \t\r\n' <"$TMPD/installer.sig")
        actual=$(PN_FILE=$TMPD/composer-setup.php "$PHP_BIN" -r 'echo hash_file("sha384", getenv("PN_FILE"));')
        if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
            fail "ลายเซ็นของตัวติดตั้ง composer ไม่ตรง (SHA-384) — ไม่ติดตั้ง" \
                "ไฟล์อาจถูกดัดแปลงระหว่างทาง ลองใหม่ภายหลัง หรือติดตั้ง composer เอง: https://getcomposer.org/download/"
        fi
        COMPOSER_HOME=${COMPOSER_HOME:-${HOME:-$APP_DIR/.composer-bin}/.composer} \
            "$PHP_BIN" "$TMPD/composer-setup.php" --quiet --install-dir="$APP_DIR/.composer-bin" --filename=composer.phar </dev/null ||
            fail "ติดตั้ง composer ไม่สำเร็จ"
        COMPOSER_BIN=$local_phar
        ok "ดาวน์โหลด composer แล้ว (ตรวจลายเซ็น SHA-384 ผ่าน) → .composer-bin/composer.phar"
    fi
    COMPOSER_KIND=$(composer_kind "$COMPOSER_BIN")
    if [ -x "$COMPOSER_BIN" ] || [ "$COMPOSER_KIND" = php ]; then
        local v
        v=$(run_composer --version --no-ansi 2>/dev/null </dev/null | sed -n '1p' || true)
        if [ -n "$v" ]; then
            ok "Composer: $COMPOSER_BIN ($v)"
        else
            warn "Composer: $COMPOSER_BIN — เรียก --version ไม่ได้ (จะลองติดตั้งต่อ)"
        fi
    else
        fail "รัน composer ที่ $COMPOSER_BIN ไม่ได้ (ไม่มีสิทธิ์ execute)"
    fi
}

run_composer() {
    local home=${HOME:-}
    if [ -z "$home" ] && [ -z "${COMPOSER_HOME:-}" ]; then export COMPOSER_HOME=$APP_DIR/.composer-bin/home; fi
    if [ "$IS_ROOT" = 1 ]; then export COMPOSER_ALLOW_SUPERUSER=1; fi
    export COMPOSER_NO_INTERACTION=1
    if [ "$COMPOSER_KIND" = php ]; then
        "$PHP_BIN" "$COMPOSER_BIN" "$@"
    else
        "$COMPOSER_BIN" "$@"
    fi
}

composer_install() {
    (cd "$APP_DIR" && run_composer install --no-dev --optimize-autoloader --no-interaction --no-progress --no-ansi </dev/null)
}

detect_mysql_client() {
    MYSQL_CLIENT=''
    if have mysql; then
        MYSQL_CLIENT=$(command -v mysql)
    elif have mariadb; then
        MYSQL_CLIENT=$(command -v mariadb)
    fi
    if [ -n "$MYSQL_CLIENT" ]; then
        ok "โปรแกรมฐานข้อมูล: $MYSQL_CLIENT"
    else
        info "ไม่พบโปรแกรม mysql/mariadb (ไม่จำเป็น — ใช้แค่ตอนสร้างฐานข้อมูลด้วย root ผ่าน socket)"
    fi
}

preflight() {
    step "ตรวจความพร้อมของเครื่อง"
    detect_os
    detect_user
    case $APP_DIR in *[[:space:]]*) fail "โฟลเดอร์ของระบบห้ามมีช่องว่าง: $APP_DIR" "ย้ายไปไว้ที่เช่น /www/wwwroot/paynest แล้วรันใหม่" ;; esac
    [ -f "$APP_DIR/spark" ] && [ -f "$APP_DIR/env" ] && [ -f "$APP_DIR/composer.json" ] ||
        fail "$APP_DIR ไม่ใช่โฟลเดอร์ของ PayNest (ไม่มี spark / env / composer.json)" "วาง $SCRIPT_NAME ไว้ที่รากโปรเจกต์ (ข้าง ๆ spark) แล้วรันจากตรงนั้น"
    ok "โฟลเดอร์ของระบบ: $APP_DIR"
    if is_git_repo; then
        local gerr
        check_repo_owner
        if ! gerr=$(g rev-parse --git-dir 2>&1 >/dev/null); then
            case $gerr in
                *dubious* | *safe.directory*)
                    fail "git ไม่ยอมทำงานในโฟลเดอร์นี้ (เจ้าของโฟลเดอร์ไม่ใช่ $(id -un))" \
                        "รันครั้งเดียว: git config --global --add safe.directory $APP_DIR แล้วรันใหม่"
                    ;;
                *) fail "git ใช้กับโฟลเดอร์นี้ไม่ได้: $gerr" ;;
            esac
        fi
        GIT_BRANCH=$(g symbolic-ref --short -q HEAD 2>/dev/null || echo '(detached)')
        ok "$(git --version) · branch $GIT_BRANCH · commit $(g rev-parse --short HEAD)"
        if [ -n "${BRANCH:-}" ] && [ "$BRANCH" != "$GIT_BRANCH" ]; then
            warn "BRANCH=$BRANCH แต่โค้ดอยู่ที่ branch $GIT_BRANCH — ใช้ตามที่มีอยู่ (สลับเอง: git checkout $BRANCH แล้วรันใหม่)"
        fi
    elif have git; then
        warn "โฟลเดอร์นี้ไม่ใช่ git clone — ข้ามขั้น git (อัปเดตด้วย update.sh ไม่ได้ ต้อง git clone)"
    else
        warn "ไม่พบ git — ข้ามขั้น git (update.sh ต้องใช้ git: apt install git)"
    fi
    detect_php
    detect_composer
    detect_mysql_client
}

# ─── ค่าฐานข้อมูล + .env ─────────────────────────────────────────────────────

is_local_host() {
    case $1 in localhost | 127.0.0.1 | ::1) return 0 ;; esac
    return 1
}

validate_inputs() {
    if [ -n "$APP_URL" ]; then
        case $APP_URL in
            http://?* | https://?*) ;;
            *) fail "APP_URL ต้องขึ้นต้นด้วย https:// หรือ http:// เช่น APP_URL=https://paynest.live" ;;
        esac
        case $APP_URL in *[[:space:]\'\"\\]*) fail "APP_URL มีอักขระที่ใช้ไม่ได้ (ช่องว่าง/เครื่องหมายคำพูด)" ;; esac
        while [ "${APP_URL%/}" != "$APP_URL" ]; do APP_URL=${APP_URL%/}; done
    fi
    case $TRUST_PROXY in '' | *[!0-9]*) fail "TRUST_PROXY ต้องเป็นตัวเลข (0 = ไม่มี proxy · 1 = Cloudflare/load balancer)" ;; esac
}

validate_db_values() { # ตรวจค่าที่จะเขียนลง .env / ใช้สร้างฐานข้อมูล
    case $DB_HOST in '' | *[!A-Za-z0-9.:_-]*) fail "DB_HOST ไม่ถูกต้อง: '$DB_HOST'" ;; esac
    case $DB_PORT in '' | *[!0-9]*) fail "DB_PORT ต้องเป็นตัวเลข: '$DB_PORT'" ;; esac
    case $DB_NAME in '' | *[!A-Za-z0-9_]*) fail "DB_NAME ใช้ได้เฉพาะ a-z A-Z 0-9 _ : '$DB_NAME'" ;; esac
    case $DB_USER in '' | *[!A-Za-z0-9_]*) fail "DB_USER ใช้ได้เฉพาะ a-z A-Z 0-9 _ : '$DB_USER'" ;; esac
    if [ "${#DB_NAME}" -gt 64 ]; then fail "DB_NAME ยาวเกิน 64 ตัว"; fi
    if [ "${#DB_USER}" -gt 32 ]; then fail "DB_USER ยาวเกิน 32 ตัว"; fi
    case $DB_PASS in *'${'*) fail 'DB_PASS ห้ามมี ${ (CodeIgniter แปลเป็นตัวแปรใน .env)' ;; esac
}

generate_password() {
    # 32 ตัวจาก random_bytes (A-Z a-z 0-9 - _) · มีตัวใหญ่/เล็ก/ตัวเลข/สัญลักษณ์ครบ — ผ่าน validate_password ของ MySQL
    "$PHP_BIN" -r '
        do {
            $p = rtrim(strtr(base64_encode(random_bytes(24)), "+/", "-_"), "=");
        } while (! preg_match("/[A-Z]/", $p) || ! preg_match("/[a-z]/", $p) || ! preg_match("/[0-9]/", $p) || ! preg_match("/[-_]/", $p));
        echo $p;'
}

load_db_from_env() { # ค่าตั้งต้นเหมือน app/Config/Database.php เมื่อ .env ไม่มีบรรทัดนั้น
    local f=$APP_DIR/.env v
    v=$(env_get "$f" database.default.hostname 2>/dev/null) || v=127.0.0.1
    DB_HOST=$v
    v=$(env_get "$f" database.default.port 2>/dev/null) || v=3306
    DB_PORT=${v:-3306}
    v=$(env_get "$f" database.default.database 2>/dev/null) || v=''
    DB_NAME=$v
    v=$(env_get "$f" database.default.username 2>/dev/null) || v=''
    DB_USER=$v
    v=$(env_get "$f" database.default.password 2>/dev/null) || v=''
    DB_PASS=$v
}

step_env() {
    step "ไฟล์ตั้งค่าเครื่อง (.env)"
    local f=$APP_DIR/.env tmp given='' base
    if [ -f "$f" ]; then
        # ค่าที่ส่งมาแต่ .env เดิมชนะ — บอกให้รู้ (ไม่พิมพ์ค่ารหัสผ่าน)
        local old_host=$DB_HOST old_port=$DB_PORT old_name=$DB_NAME old_user=$DB_USER old_pass=$DB_PASS
        load_db_from_env
        if [ -n "$GIVEN_DB_HOST" ] && [ "$old_host" != "$DB_HOST" ]; then given="$given DB_HOST"; fi
        if [ -n "$GIVEN_DB_PORT" ] && [ "$old_port" != "$DB_PORT" ]; then given="$given DB_PORT"; fi
        if [ -n "$GIVEN_DB_NAME" ] && [ "$old_name" != "$DB_NAME" ]; then given="$given DB_NAME"; fi
        if [ -n "$GIVEN_DB_USER" ] && [ "$old_user" != "$DB_USER" ]; then given="$given DB_USER"; fi
        if [ -n "$old_pass" ] && [ "$old_pass" != "$DB_PASS" ]; then given="$given DB_PASS"; fi
        ok "ใช้ .env เดิม (ไม่แก้ไฟล์) — ฐานข้อมูล $DB_NAME ผู้ใช้ $DB_USER ที่ $DB_HOST:$DB_PORT"
        if [ -n "$given" ]; then
            warn "ค่าที่ส่งมา (${given# }) ต่างจาก .env — ใช้ค่าใน .env · ถ้าจะเปลี่ยน แก้ .env เอง หรือลบ .env แล้วรันใหม่"
        fi
        if [ -z "$DB_NAME" ] || [ -z "$DB_USER" ]; then
            fail ".env ไม่มี database.default.database / database.default.username" "แก้ $f ให้ครบแล้วรันใหม่"
        fi
        base=$(env_get "$f" app.baseURL 2>/dev/null || true)
        if [ -z "$APP_URL" ]; then
            case $base in '' | *example.com*) ;; *) APP_URL=${base%/} ;; esac
        elif [ "${base%/}" != "$APP_URL" ]; then
            warn "APP_URL=$APP_URL แต่ app.baseURL ใน .env เป็น '${base}' — ไม่แก้ .env (ใช้ APP_URL แค่ตรวจ /health)"
        fi
        if [ "$(env_get "$f" CI_ENVIRONMENT 2>/dev/null || true)" != production ]; then
            warn "CI_ENVIRONMENT ใน .env ไม่ใช่ production — เซิร์ฟเวอร์จริงต้องเป็น production (DEPLOY.md หัวข้อ ห้ามทำบนเครื่องจริง)"
        fi
        return
    fi

    validate_db_values
    local pass_note="ตามที่ส่งมา"
    if [ -z "$DB_PASS" ]; then pass_note="สุ่มใหม่ 32 ตัว"; fi
    if [ "$DRY_RUN" = 1 ]; then
        plan "จะสร้าง .env จากไฟล์ตัวอย่าง env แล้วแก้เฉพาะ: CI_ENVIRONMENT = production${APP_URL:+, app.baseURL = '$APP_URL/'}"
        plan "  database.default.* = $DB_HOST:$DB_PORT ฐานข้อมูล $DB_NAME ผู้ใช้ $DB_USER (รหัส: $pass_note)"
        if [ "$TRUST_PROXY" -gt 0 ]; then plan "  paynest.trustProxy = $TRUST_PROXY"; fi
        plan "  chmod 600 .env · เจ้าของ $WEB_USER"
        return
    fi
    if [ -z "$DB_PASS" ]; then
        DB_PASS=$(generate_password)
        [ "${#DB_PASS}" -eq 32 ] || fail "สุ่มรหัสฐานข้อมูลไม่สำเร็จ"
    fi
    tmp=$APP_DIR/.env.tmp-deploy
    (umask 077 && cp "$APP_DIR/env" "$tmp")
    env_set "$tmp" CI_ENVIRONMENT production
    if [ -n "$APP_URL" ]; then env_set "$tmp" app.baseURL "'$(esc_sq "$APP_URL/")'"; fi
    env_set "$tmp" database.default.hostname "$DB_HOST"
    env_set "$tmp" database.default.port "$DB_PORT"
    env_set "$tmp" database.default.database "$DB_NAME"
    env_set "$tmp" database.default.username "$DB_USER"
    env_set "$tmp" database.default.password "'$(esc_sq "$DB_PASS")'"
    if [ "$TRUST_PROXY" -gt 0 ]; then env_set "$tmp" paynest.trustProxy "$TRUST_PROXY"; fi
    chmod 600 "$tmp"
    if [ "$IS_ROOT" = 1 ]; then chown "$WEB_USER:$WEB_GROUP" "$tmp"; fi
    mv -f "$tmp" "$f"
    ENV_CREATED_THIS_RUN=1
    ok "สร้าง .env จากไฟล์ตัวอย่าง env (chmod 600 · เจ้าของ $WEB_USER)"
    info "CI_ENVIRONMENT = production${APP_URL:+ · app.baseURL = '$APP_URL/'}"
    info "ฐานข้อมูล $DB_NAME ผู้ใช้ $DB_USER ที่ $DB_HOST:$DB_PORT · รหัส: $pass_note (อยู่ใน .env — ไม่แสดงบนจอ)"
    if [ "$TRUST_PROXY" -gt 0 ]; then info "paynest.trustProxy = $TRUST_PROXY"; fi
    if [ -z "$APP_URL" ]; then
        warn "ไม่ได้ใส่ APP_URL — app.baseURL ยังเป็นค่าตัวอย่าง (แก้ใน .env ภายหลังได้) และจะข้ามการตรวจ /health"
    fi
}

# ─── ฐานข้อมูล ───────────────────────────────────────────────────────────────

db_user_hosts() {
    if is_local_host "$DB_HOST"; then
        if [ "$DB_HOST" = ::1 ]; then echo 'localhost 127.0.0.1 ::1'; else echo 'localhost 127.0.0.1'; fi
    else
        echo '%'
    fi
}

create_db_sql() {
    local h who sql pass
    pass=$(esc_sq "$DB_PASS")
    sql="CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    for h in $(db_user_hosts); do
        who="'$DB_USER'@'$h'"
        sql="$sql
CREATE USER IF NOT EXISTS $who IDENTIFIED BY '$pass';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO $who;"
    done
    printf '%s\n' "$sql"
}

aapanel_db_help() {
    info "สร้างฐานข้อมูลเองแล้วรันใหม่:"
    info "  aaPanel: Databases → Add database → ชื่อ/ผู้ใช้/รหัส (utf8mb4) → Submit"
    info "  แล้วรันในเชลล์ root (sudo -s): read -rsp 'DB_PASS: ' DB_PASS; echo"
    info "                                 DB_PASS=\$DB_PASS DB_NAME=<ชื่อ> DB_USER=<ผู้ใช้> ./$SCRIPT_NAME"
    info "  หรือให้สคริปต์สร้างให้: read -rsp 'DB_ROOT_PASS: ' DB_ROOT_PASS; echo"
    info "                         DB_ROOT_PASS=\$DB_ROOT_PASS DB_ROOT_USER=root ./$SCRIPT_NAME"
    info "  (รหัส root ของ MySQL ใน aaPanel: Databases → Root password · อย่าใส่รหัสไว้หลัง sudo — โผล่ใน ps)"
    info "  สร้างใน aaPanel แล้วแต่ยังขึ้น Access denied: ลองเพิ่ม DB_HOST=localhost (ผู้ใช้ของ aaPanel อาจอนุญาตเฉพาะ localhost)"
}

# dry-run: บอกว่ารันจริงจะหยุดตรงนี้แล้วทำต่อ (ให้เห็นภาพทั้งหมด) · รันจริง: หยุด
stop_or_fail() {
    if [ "$DRY_RUN" = 1 ]; then
        warn "(รันจริงจะหยุดตรงนี้) $1"
        shift
        local line
        for line in "$@"; do info "$line"; done
        return 0
    fi
    fail "$@"
}

# หยุดที่ขั้นฐานข้อมูล: .env ที่เพิ่งสร้างรอบนี้ (ยังไม่ได้สร้างผู้ใช้ด้วยรหัสในนั้น) ลบทิ้ง ให้รอบหน้าใช้ DB_* ที่ส่งมาใหม่ได้
db_fail() {
    if [ "$DRY_RUN" = 1 ]; then
        warn "(รันจริงจะหยุดตรงนี้) $1"
        shift
        local line
        for line in "$@"; do info "$line"; done
        return 0
    fi
    if [ "${ENV_CREATED_THIS_RUN:-0}" = 1 ] && [ "${KEEP_NEW_ENV:-0}" != 1 ]; then
        rm -f "$APP_DIR/.env"
        ENV_CREATED_THIS_RUN=0
        info "ลบ .env ที่เพิ่งสร้างรอบนี้ออกแล้ว — รอบหน้าจะสร้างใหม่จาก DB_* ที่ส่งมา"
    fi
    fail "$@"
}

step_database() {
    step "ฐานข้อมูล"
    local err rc=0 ver
    if [ "$DRY_RUN" = 1 ] && [ -z "$DB_PASS" ]; then
        plan "จะสร้างฐานข้อมูล $DB_NAME (utf8mb4_unicode_ci) + ผู้ใช้ $DB_USER@($(db_user_hosts)) — วิธี: $(describe_admin_method)"
        return
    fi
    ver=$(db_app check 2>"$TMPD/db.err") || rc=$?
    if [ "$rc" = 0 ]; then
        ok "เชื่อมต่อฐานข้อมูลได้ — $DB_NAME ที่ $DB_HOST:$DB_PORT (เซิร์ฟเวอร์ $ver)"
        return
    fi
    err=$(cat "$TMPD/db.err")
    if [ "$rc" != 10 ]; then
        db_fail "เชื่อมต่อเซิร์ฟเวอร์ฐานข้อมูลที่ $DB_HOST:$DB_PORT ไม่ได้: $err" \
            "ตรวจว่า MySQL/MariaDB ทำงานอยู่ และ DB_HOST/DB_PORT ถูกต้อง (aaPanel: App Store → MySQL → Start)"
        return
    fi
    info "ยังเข้าฐานข้อมูลด้วยผู้ใช้ของระบบไม่ได้: $err"
    if is_true "$SKIP_DB_CREATE"; then
        db_fail "SKIP_DB_CREATE=1 — ไม่สร้างฐานข้อมูลให้ และค่าที่ใช้ยังเข้าฐานข้อมูลไม่ได้" \
            "ตรวจชื่อฐานข้อมูล/ผู้ใช้/รหัสให้ตรงกับที่สร้างไว้ (database.default.* ใน .env) แล้วรันใหม่"
        return
    fi
    validate_db_values
    if [ "$DRY_RUN" = 1 ]; then
        plan "จะสร้างฐานข้อมูล $DB_NAME (utf8mb4_unicode_ci) + ผู้ใช้ $DB_USER@($(db_user_hosts)) — วิธี: $(describe_admin_method)"
        return
    fi
    # USER_CREATED=1 เมื่อสร้างผู้ใช้ใหม่ด้วยรหัสใน .env สำเร็จ (แม้ขั้นถัดไปพัง) — ห้ามลบ .env (รหัสนั้นมีที่เดียวคือ .env)
    local res='' pre post
    USER_CREATED=0
    case $(admin_method) in
        root-user)
            info "สร้างฐานข้อมูล/ผู้ใช้ด้วยบัญชี $DB_ROOT_USER (DB_ROOT_USER) ..."
            rc=0
            res=$(PN_DB_HOST=$DB_HOST PN_DB_PORT=$DB_PORT PN_ADMIN_USER=$DB_ROOT_USER PN_ADMIN_PASS=$DB_ROOT_PASS \
                PN_DB_NAME=$DB_NAME PN_DB_USER=$DB_USER PN_DB_PASS=$DB_PASS PN_DB_USER_HOSTS=$(db_user_hosts) \
                php_db_tool create 2>"$TMPD/db.err") || rc=$?
            if [ "$rc" = 13 ]; then USER_CREATED=1 && KEEP_NEW_ENV=1; fi
            if [ "$rc" != 0 ] && [ "$USER_CREATED" = 1 ]; then
                db_fail "สร้างฐานข้อมูลด้วยบัญชี $DB_ROOT_USER ไม่ครบ: $(cat "$TMPD/db.err")" \
                    "สร้างผู้ใช้ $DB_USER ไปแล้วด้วยรหัสใน .env — เก็บ .env ไว้ (รหัสนั้นอยู่ที่นั่นที่เดียว)" \
                    "ตรวจสิทธิ์ของ $DB_ROOT_USER (ต้อง CREATE, CREATE USER และ GRANT OPTION) แล้วรันใหม่ได้เลย"
            elif [ "$rc" != 0 ]; then
                db_fail "สร้างฐานข้อมูลด้วยบัญชี $DB_ROOT_USER ไม่สำเร็จ: $(cat "$TMPD/db.err")" \
                    "ตรวจ DB_ROOT_USER / DB_ROOT_PASS และสิทธิ์ของบัญชีนั้น (ต้อง CREATE, CREATE USER และ GRANT OPTION)"
            fi
            if [ "$res" = created ]; then USER_CREATED=1; fi
            ;;
        socket)
            info "สร้างฐานข้อมูล/ผู้ใช้ด้วย $MYSQL_CLIENT -uroot (unix socket) ..."
            if ! pre=$(socket_user_count 2>"$TMPD/db.err"); then
                info "$(cat "$TMPD/db.err")"
                info "เข้า MySQL ด้วย root ผ่าน socket ไม่ได้ (เครื่องที่ตั้งรหัส root ไว้ เช่น aaPanel จะเป็นแบบนี้)"
                aapanel_db_help
                db_fail "ยังไม่มีฐานข้อมูล/ผู้ใช้ที่เข้าได้"
            fi
            rc=0
            create_db_sql | "$MYSQL_CLIENT" -uroot 2>"$TMPD/db.err" || rc=$?
            post=$(socket_user_count 2>/dev/null || echo "$pre")
            if [ "${post:-0}" -gt "${pre:-0}" ]; then USER_CREATED=1 && KEEP_NEW_ENV=1; fi
            if [ "$rc" != 0 ]; then
                db_fail "สร้างฐานข้อมูล/ผู้ใช้ด้วย $MYSQL_CLIENT -uroot ไม่สำเร็จ: $(cat "$TMPD/db.err")"
            fi
            ;;
        *)
            info "ไม่มีวิธีสร้างฐานข้อมูลอัตโนมัติ (ไม่ได้ส่ง DB_ROOT_USER และไม่ได้รันด้วย root บนเครื่องที่มีโปรแกรม mysql)"
            aapanel_db_help
            db_fail "ยังไม่มีฐานข้อมูล/ผู้ใช้ที่เข้าได้"
            ;;
    esac
    if [ "$USER_CREATED" = 1 ]; then
        ok "สร้างฐานข้อมูล $DB_NAME (utf8mb4_unicode_ci) + ผู้ใช้ $DB_USER@($(db_user_hosts)) แล้ว"
    else
        ok "สร้างฐานข้อมูล $DB_NAME (utf8mb4_unicode_ci) แล้ว (IF NOT EXISTS) · ผู้ใช้ $DB_USER มีอยู่ก่อนแล้ว — ไม่เปลี่ยนรหัสให้"
    fi
    rc=0
    ver=$(db_app check 2>"$TMPD/db.err") || rc=$?
    if [ "$rc" != 0 ]; then
        if [ "$USER_CREATED" = 1 ]; then
            fail "สร้างแล้วแต่ยังเข้าด้วยผู้ใช้ $DB_USER ไม่ได้: $(cat "$TMPD/db.err")" \
                "ตรวจ DB_HOST (ผู้ใช้สร้างไว้สำหรับ $(db_user_hosts)) แล้วรันใหม่ — .env เก็บไว้ (มีรหัสของผู้ใช้ที่เพิ่งสร้าง)"
        elif [ "${ENV_CREATED_THIS_RUN:-0}" = 1 ]; then
            db_fail "ผู้ใช้ $DB_USER มีอยู่ก่อนแล้วด้วยรหัสอื่น — สคริปต์ไม่เปลี่ยนรหัสของผู้ใช้เดิมให้: $(cat "$TMPD/db.err")" \
                "รันใหม่โดยส่ง DB_PASS ให้ตรงกับรหัสเดิมของ $DB_USER หรือใช้ DB_USER ชื่อใหม่"
        else
            fail "ผู้ใช้ $DB_USER มีอยู่ก่อนแล้ว แต่รหัสใน .env เข้าไม่ได้: $(cat "$TMPD/db.err")" \
                "แก้ database.default.password ใน $APP_DIR/.env ให้ตรงกับรหัสของ $DB_USER แล้วรันใหม่"
        fi
    fi
    ok "เชื่อมต่อฐานข้อมูลได้ — $DB_NAME ที่ $DB_HOST:$DB_PORT (เซิร์ฟเวอร์ $ver)"
}

socket_user_count() { # จำนวนแถวของ DB_USER ใน mysql.user (ผ่าน socket ด้วย root) — DB_USER ผ่าน validate_db_values แล้ว
    printf "SELECT COUNT(*) FROM mysql.user WHERE User='%s';\n" "$DB_USER" | "$MYSQL_CLIENT" -uroot -N -B
}

admin_method() {
    if [ -n "$DB_ROOT_USER" ]; then
        echo root-user
    elif [ "$IS_ROOT" = 1 ] && [ -n "$MYSQL_CLIENT" ] && is_local_host "$DB_HOST"; then
        echo socket
    else
        echo none
    fi
}

describe_admin_method() {
    case $(admin_method) in
        root-user) printf ' บัญชี %s (DB_ROOT_USER)' "$DB_ROOT_USER" ;;
        socket) printf ' %s -uroot ผ่าน socket' "$MYSQL_CLIENT" ;;
        *) printf 'ไม่มีวิธีอัตโนมัติ — ต้องสร้างเองใน aaPanel หรือส่ง DB_ROOT_USER/DB_ROOT_PASS (รันจริงจะหยุดที่ขั้นนี้)' ;;
    esac
}

# ─── สิทธิ์ไฟล์ ──────────────────────────────────────────────────────────────

step_permissions() {
    step "สิทธิ์ไฟล์ (writable/ + .env)"
    local data
    data=$APP_DIR/writable/data
    if [ "$DRY_RUN" = 1 ]; then
        plan "mkdir -p writable/data · chmod -R u+rwX,go-rwx writable/data"
        if [ "$IS_ROOT" = 1 ]; then plan "chown -R $WEB_USER:$WEB_GROUP writable .env"; fi
        return
    fi
    # ผู้ใช้เว็บเขียน writable/ ได้ — ถ้า writable/data หรือ .env กลายเป็น symlink (เช่นชี้ไป /etc) chmod -R ของ root จะไปแก้ที่ปลายทาง
    local p
    for p in "$APP_DIR/writable" "$data" "$APP_DIR/.env"; do
        if [ -L "$p" ]; then
            fail "$p เป็น symlink — ไม่แก้สิทธิ์ตาม symlink (อาจชี้ไปไฟล์ระบบ)" \
                "ตรวจ: ls -l $p · ทำให้เป็นโฟลเดอร์/ไฟล์จริง แล้วรันใหม่"
        fi
    done
    mkdir -p "$data"
    if [ "$IS_ROOT" = 1 ]; then
        chown -R "$WEB_USER:$WEB_GROUP" "$APP_DIR/writable" "$APP_DIR/.env"
        ok "chown -R $WEB_USER:$WEB_GROUP writable .env"
    else
        warn "ไม่ได้รันด้วย root — ข้าม chown (ไฟล์เป็นของ $(id -un) อยู่แล้ว)"
    fi
    chmod -R u+rwX,go-rwx "$data"
    ok "writable/data อ่านได้เฉพาะ $WEB_USER (chmod -R u+rwX,go-rwx)"
    if [ "$(ls -l "$APP_DIR/.env" | cut -c1-10)" != "-rw-------" ]; then
        chmod 600 "$APP_DIR/.env"
        ok "chmod 600 .env"
    fi
}

# ─── app:install ─────────────────────────────────────────────────────────────

step_app_install() {
    step "ติดตั้งระบบ (php spark app:install ในนาม $WEB_USER)"
    local before=0 rc=0 out=$TMPD/install.out line data
    data=$(data_dir)
    if [ -f "$APP_DIR/.env" ]; then before=$(db_app migrations-max 2>/dev/null || echo 0); fi
    # ฐานข้อมูลติดตั้งแล้วแต่ secrets.json หาย: app:install จะสุ่มกุญแจใหม่ = Google Authenticator ทุกคน + ลิงก์ของร้านทุกร้านพัง
    if [ "${before:-0}" -gt 0 ] && [ ! -f "$data/secrets.json" ] && ! secrets_in_env && ! is_true "$ALLOW_NEW_SECRETS"; then
        local restore="กู้: cp $data/backups/secrets.json $data/secrets.json"
        if [ ! -f "$data/backups/secrets.json" ]; then restore="ไม่พบ $data/backups/secrets.json — หาไฟล์สำรองนอกเครื่องมาวางที่ $data/secrets.json"; fi
        if [ "$IS_ROOT" = 1 ]; then restore="$restore แล้ว chown $WEB_USER:$WEB_GROUP $data/secrets.json"; fi
        stop_or_fail "ฐานข้อมูล $DB_NAME ติดตั้งแล้ว แต่ไม่พบ $data/secrets.json — ไม่รัน app:install (จะสุ่มกุญแจลับใหม่ แล้ว Google Authenticator ของทุกคนและลิงก์ของร้านทุกร้านใช้ไม่ได้)" \
            "$restore (DEPLOY.md ข้อ 6) แล้วรันใหม่" \
            "ตั้งใจสุ่มกุญแจใหม่จริง (ทุกคนต้องตั้ง Google Authenticator ใหม่ · ส่งลิงก์ของร้านใหม่ทุกร้าน): ALLOW_NEW_SECRETS=1 ./$SCRIPT_NAME"
    fi
    if [ "$DRY_RUN" = 1 ]; then
        plan "จะรัน: php spark app:install (สร้างตาราง + กุญแจลับ + แอดมินคนแรก · รันซ้ำได้)"
        return
    fi
    spark_capture "$out" app:install || rc=$?
    if [ "$rc" != 0 ]; then
        fail "php spark app:install ไม่สำเร็จ (exit code $rc) — ดูข้อความด้านบน" \
            "รายละเอียดเพิ่มเติม: writable/logs/log-$(date +%Y-%m-%d).log"
    fi
    MIGRATIONS_RAN=$(PN_SINCE=$before db_app migrations-since 2>/dev/null || true)
    INSTALL_KEYS=$(after_marker "$out" 'ลิงก์เข้าระบบของร้าน — ')
    INSTALL_VERSION=$(after_marker "$out" '✓ ระบบรุ่น ')
    ADMIN_PASS_FILE=$(after_marker "$out" 'รหัสผ่านอยู่ในไฟล์ ')
    ADMIN_PASS_FILE=${ADMIN_PASS_FILE%% (*}
    if [ -n "$MIGRATIONS_RAN" ]; then
        ok "migration ที่รันรอบนี้ $(printf '%s\n' "$MIGRATIONS_RAN" | grep -c .) ไฟล์:"
        printf '%s\n' "$MIGRATIONS_RAN" | while IFS= read -r line; do info "· $line"; done
    else
        ok "ไม่มี migration ค้าง — โครงสร้างฐานข้อมูลเป็นรุ่นล่าสุดอยู่แล้ว"
    fi
    ok "app:install สำเร็จ"
}

# ─── cron ────────────────────────────────────────────────────────────────────

cron_list() {
    if [ "$IS_ROOT" = 1 ]; then crontab -u "$WEB_USER" -l; else crontab -l; fi
}

cron_install() { # file
    if [ "$IS_ROOT" = 1 ]; then crontab -u "$WEB_USER" "$1"; else crontab "$1"; fi
}

step_cron() {
    step "งานตั้งเวลา (cron ทุกนาที)"
    local line marker current rc out=$TMPD/schedule.out count
    marker="$APP_DIR/spark schedule:run"
    line="* * * * * $PHP_BIN $APP_DIR/spark schedule:run > /dev/null 2>&1"
    CRON_STATUS=''
    local panel_job
    panel_job=$(grep -lsF "$marker" /www/server/cron/* 2>/dev/null | sed -n '1p' || true)
    if is_true "$SKIP_CRON"; then
        CRON_STATUS="ข้าม (SKIP_CRON=1) — ต้องตั้งเองในหน้า Cron ของ aaPanel"
        warn "SKIP_CRON=1 — ไม่แตะ crontab · ตั้งเองใน aaPanel: Cron → Add Cron → Shell Script · ทุก 1 นาที:"
        info "su -s /bin/sh -c \"$PHP_BIN $APP_DIR/spark schedule:run\" $WEB_USER"
    elif [ -n "$panel_job" ]; then
        # ตั้งไว้ในหน้า Cron ของ aaPanel แล้ว (ติดตั้งแบบทำมือตาม DEPLOY.md ข้อ 3) — ไม่เพิ่มซ้ำใน crontab
        CRON_STATUS="มีในหน้า Cron ของ aaPanel อยู่แล้ว ($panel_job) — ไม่เพิ่มใน crontab"
        ok "$CRON_STATUS"
        info "ถ้างานนั้นถูกปิด (Stop) ไว้ ให้เปิดในหน้า Cron ของ aaPanel — /health จะขึ้น \"failing\":\"schedule\" ถ้าไม่มีงานเดิน"
    elif [ "$DRY_RUN" = 1 ]; then
        plan "จะตั้ง crontab ของ $WEB_USER ให้มีบรรทัดนี้บรรทัดเดียว (ลบบรรทัดเก่าของโฟลเดอร์นี้ก่อน):"
        plan "  $line"
        if ! have crontab; then warn "(รันจริงจะหยุดตรงนี้) ไม่พบคำสั่ง crontab — apt install cron หรือใช้ SKIP_CRON=1"; fi
    elif ! have crontab; then
        fail "ไม่พบคำสั่ง crontab" "Ubuntu: apt install cron · หรือรันใหม่ด้วย SKIP_CRON=1 แล้วตั้งในหน้า Cron ของ aaPanel (DEPLOY.md ข้อ 3)"
    else
        current=$(cron_list 2>/dev/null) || current=''
        {
            if [ -n "$current" ]; then printf '%s\n' "$current" | grep -vF "$marker" || true; fi
            printf '%s\n' "$line"
        } >"$TMPD/crontab.new"
        cron_install "$TMPD/crontab.new" 2>"$TMPD/cron.err" ||
            fail "ตั้ง crontab ของ $WEB_USER ไม่สำเร็จ: $(cat "$TMPD/cron.err")" \
                "รันใหม่ด้วย SKIP_CRON=1 แล้วตั้งในหน้า Cron ของ aaPanel แทน (DEPLOY.md ข้อ 3)"
        count=$(cron_list 2>/dev/null | grep -cF "$marker" || true)
        [ "$count" = 1 ] || fail "ตรวจ crontab แล้วพบบรรทัดของระบบ ${count:-0} บรรทัด (ควรเป็น 1)"
        CRON_STATUS="crontab ของ $WEB_USER (ทุกนาที)"
        ok "crontab ของ $WEB_USER มีบรรทัดนี้บรรทัดเดียว:"
        info "$line"
        info "aaPanel: crond ของเครื่องอ่าน crontab นี้อยู่แล้ว · ถ้าอยากเห็นในหน้า Cron ของ aaPanel แทน"
        info "  ให้รันใหม่ด้วย SKIP_CRON=1 (ลบบรรทัดนี้ออกเอง: crontab -u $WEB_USER -e) แล้วเพิ่มคำสั่งใน DEPLOY.md ข้อ 3"
    fi
    if [ "$DRY_RUN" = 1 ]; then
        plan "จะรัน php spark schedule:run หนึ่งครั้ง (ให้ /health เห็นว่างานตั้งเวลาเดินแล้ว)"
        return
    fi
    rc=0
    spark_capture "$out" schedule:run || rc=$?
    if [ "$rc" = 0 ]; then
        ok "รัน schedule:run หนึ่งครั้งแล้ว (heartbeat ใหม่สำหรับ /health)"
    else
        warn "schedule:run ครั้งแรกไม่สำเร็จ (exit code $rc) — ลองเอง: sudo -u $WEB_USER $PHP_BIN spark schedule:run --verbose"
    fi
}

# ─── /health ─────────────────────────────────────────────────────────────────

step_health() {
    step "ตรวจหน้าเว็บ (/health)"
    local code body
    HEALTH_STATUS='ไม่ได้ตรวจ'
    if [ -z "$APP_URL" ]; then
        warn "ไม่ได้ใส่ APP_URL — ข้าม (ตรวจเอง: curl -fsS https://<โดเมน>/health)"
        return
    fi
    if [ "$DRY_RUN" = 1 ]; then
        plan "จะตรวจ: curl $APP_URL/health (ต้องได้ 200)"
        return
    fi
    if ! have curl; then
        warn "ไม่พบ curl — ข้าม (ตรวจเองในเบราว์เซอร์: $APP_URL/health)"
        return
    fi
    code=$(http_check "$APP_URL/health")
    body=$(cat "$TMPD/health.out" 2>/dev/null || true)
    body=${body:0:300}
    if [ "$code" = 200 ]; then
        HEALTH_STATUS="200 OK"
        ok "$APP_URL/health → 200 $body"
    else
        HEALTH_STATUS="ไม่ผ่าน ($code)"
        warn "$APP_URL/health → ${code} ${body:-$(cat "$TMPD/health.err" 2>/dev/null)}"
        info "เว็บเซิร์ฟเวอร์/SSL อาจยังไม่ได้ตั้ง — ส่วนนั้นต้องทำเอง (DEPLOY.md ข้อ 2) แล้วเปิด $APP_URL/health ดูอีกครั้ง"
    fi
}

# ─── สรุป ────────────────────────────────────────────────────────────────────

step_summary() {
    step "สรุป"
    local version commit data admin_file
    version=$(code_version)
    commit=''
    if is_git_repo; then commit=$(g rev-parse --short HEAD 2>/dev/null || true); fi
    data=$(data_dir)
    admin_file=${ADMIN_PASS_FILE:-}
    if [ -z "$admin_file" ] && [ -f "$data/initial-admin-password.txt" ]; then admin_file=$data/initial-admin-password.txt; fi
    if [ "$DRY_RUN" = 1 ]; then
        printf '\n%s✓ dry-run จบ — ยังไม่ได้แก้อะไรในเครื่อง%s\n' "$C_OK" "$C_0"
        printf '  รันจริง: sudo ./%s (พร้อมค่าเดิมที่ส่งมา)\n' "$SCRIPT_NAME"
        return
    fi
    printf '\n%s✓ ติดตั้งเสร็จแล้ว%s\n' "$C_OK$C_B" "$C_0"
    printf '  รุ่นของระบบ     %s%s\n' "${version:-?}" "${commit:+ ($commit)}"
    if [ -n "${INSTALL_VERSION:-}" ]; then printf '  app:install     %s\n' "$INSTALL_VERSION"; fi
    if [ -n "${INSTALL_KEYS:-}" ]; then printf '  ลิงก์ของร้าน     %s\n' "$INSTALL_KEYS"; fi
    printf '  ฐานข้อมูล       %s · ผู้ใช้ %s · %s:%s (รหัสอยู่ใน .env)\n' "$DB_NAME" "$DB_USER" "$DB_HOST" "$DB_PORT"
    printf '  ไฟล์ตั้งค่า      %s/.env\n' "$APP_DIR"
    printf '  กุญแจลับ        %s/secrets.json\n' "$data"
    if [ -n "$admin_file" ]; then
        printf '  รหัสแอดมินแรก   ผู้ใช้ superadmin · รหัสอยู่ในไฟล์ %s\n' "$admin_file"
        printf '                  ดู: sudo cat %s\n' "$admin_file"
        printf '                  ลบไฟล์หลังเปลี่ยนรหัส: sudo rm %s\n' "$admin_file"
    else
        printf '  รหัสแอดมินแรก   มีแอดมินอยู่แล้ว (ไฟล์รหัสเริ่มต้นถูกลบไปแล้ว)\n'
    fi
    printf '  cron            %s\n' "${CRON_STATUS:-?}"
    printf '  /health         %s\n' "${HEALTH_STATUS:-?}"
    printf '  log             %s\n' "$LOG_FILE"
    if [ "$WARNINGS" -gt 0 ]; then printf '  %s⚠ มีคำเตือน %s ข้อ — ดูด้านบน%s\n' "$C_WARN" "$WARNINGS" "$C_0"; fi
    cat <<EOF

ที่ต้องทำเองต่อ (รายละเอียดใน DEPLOY.md)
  1. เว็บเซิร์ฟเวอร์ (ข้อ 2) — aaPanel: Website → Add site → โฟลเดอร์ $APP_DIR · PHP $PHP_DOT
     · Site directory → Running directory = /public → Save
     · URL rewrite → location / { try_files \$uri \$uri/ /index.php\$is_args\$args; }
     · SSL → Let's Encrypt → เปิด Force HTTPS
     · Config file → บล็อก js|css เปลี่ยน expires 12h; เป็น add_header Cache-Control "no-cache";
  2. ค่า PHP (ข้อ 2) — post_max_size = 10M · upload_max_filesize = 10M · memory_limit ≥ 128M
  3. หน้าเว็บ (ข้อ 4) — ล็อกอิน superadmin → เปลี่ยนรหัส → ตั้ง Google Authenticator → เก็บรหัสสำรอง
     → ลบไฟล์รหัสเริ่มต้น → เชื่อม Telegram → เพิ่มบัญชีรับเงิน → สร้างร้านแล้วส่งลิงก์ของร้านให้ร้าน
  4. ตรวจว่าเว็บล่ม (ข้อ 5) — UptimeRobot → https://<โดเมน>/health ทุก 5 นาที
  5. สำรองข้อมูลออกนอกเครื่อง (ข้อ 6) — aaPanel Cron → Backup directory → writable/data/backups

อัปเดตรุ่นถัดไป: sudo ./update.sh
EOF
}

# ─── main ────────────────────────────────────────────────────────────────────

main() {
    set -Eeuo pipefail # ตัวเรียกปิด -e ไว้เพื่ออ่าน exit code ของ pipeline — เปิดคืนในนี้
    MAIN_SUBSHELL=${BASH_SUBSHELL:-0}
    trap 'on_err $? "$BASH_COMMAND"' ERR
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap '' HUP # SSH หลุดกลางทาง = ทำต่อจนจบ (ผลอยู่ใน log) — ไม่ทิ้งระบบไว้ครึ่ง ๆ กลาง ๆ
    exec </dev/null 3>&- # fd 3 = log ของ log_tee — ไม่ส่งต่อให้ composer/php

    local mode_note=''
    if [ "$DRY_RUN" = 1 ]; then mode_note=' · dry-run: ไม่แก้อะไรในเครื่อง'; fi
    printf '%sPayNest — ติดตั้งระบบ (%s)%s%s\n' "$C_B" "$SCRIPT_NAME" "$mode_note" "$C_0"
    printf 'โฟลเดอร์: %s · %s\n' "$APP_DIR" "$(date '+%Y-%m-%d %H:%M:%S %Z')"
    if [ -n "$LOG_FILE" ]; then printf 'log: %s\n' "$LOG_FILE"; fi

    TMPD=$(mktemp -d "${TMPDIR:-/tmp}/paynest-deploy.XXXXXX")
    write_db_tool
    validate_inputs

    preflight
    if [ "$DRY_RUN" != 1 ]; then acquire_lock; fi

    step "ตั้งค่า git (core.fileMode false)"
    if ! is_git_repo; then
        warn "ไม่ใช่ git clone — ข้าม"
    elif [ "$DRY_RUN" = 1 ]; then
        plan "git config core.fileMode false (ไม่นับการเปลี่ยนสิทธิ์ไฟล์ว่าเป็นการแก้โค้ด)"
    else
        g config core.fileMode false
        ok "git config core.fileMode false"
    fi

    step "ติดตั้งไลบรารี (composer install)"
    if [ "$DRY_RUN" = 1 ]; then
        plan "จะรัน: composer install --no-dev --optimize-autoloader --no-interaction --no-progress"
    else
        composer_install || fail "composer install ไม่สำเร็จ — ดูข้อความของ composer ด้านบน" \
            "ขาดส่วนขยาย PHP: ติดตั้งตามชื่อที่ composer บอก · เน็ต/GitHub ช้า: รันใหม่ได้เลย"
        ok "composer install เสร็จ (vendor/)"
    fi

    step_env
    step_database
    KEEP_NEW_ENV=1
    step_permissions
    step_app_install
    step_cron
    step_health
    step_summary
    exit 0 # ต้อง exit เอง — bash 3.2 ไม่รัน trap EXIT ของ subshell ใน pipeline ถ้าฟังก์ชันแค่ return
}

# ─── เริ่ม ───────────────────────────────────────────────────────────────────

DRY_RUN=${DRY_RUN:-0}
parse_args "$@"
GIVEN_DB_HOST=${DB_HOST:+1} GIVEN_DB_PORT=${DB_PORT:+1} GIVEN_DB_NAME=${DB_NAME:+1} GIVEN_DB_USER=${DB_USER:+1}
if is_true "$DRY_RUN"; then DRY_RUN=1; else DRY_RUN=0; fi
APP_URL=${APP_URL:-}
DB_HOST=${DB_HOST:-127.0.0.1}
DB_PORT=${DB_PORT:-3306}
DB_NAME=${DB_NAME:-paynest}
DB_USER=${DB_USER:-paynest}
DB_PASS=${DB_PASS:-}
DB_PASS_FILE=${DB_PASS_FILE:-}
DB_ROOT_USER=${DB_ROOT_USER:-}
DB_ROOT_PASS=${DB_ROOT_PASS:-}
DB_ROOT_PASS_FILE=${DB_ROOT_PASS_FILE:-}
TRUST_PROXY=${TRUST_PROXY:-0}
SKIP_CRON=${SKIP_CRON:-0}
SKIP_DB_CREATE=${SKIP_DB_CREATE:-0}
ALLOW_NEW_SECRETS=${ALLOW_NEW_SECRETS:-0}
BRANCH=${BRANCH:-}
WEB_USER=${WEB_USER:-}
PHP_BIN=${PHP_BIN:-}
COMPOSER_BIN=${COMPOSER_BIN:-}
read_secret_file() { # file varname — บรรทัดแรกของไฟล์ (ตัด \r ท้ายบรรทัด)
    local v=''
    [ -f "$1" ] && [ -r "$1" ] || die_usage "อ่านไฟล์ $2_FILE=$1 ไม่ได้"
    IFS= read -r v <"$1" || [ -n "$v" ] || die_usage "ไฟล์ $2_FILE=$1 ว่าง"
    printf -v "$2" '%s' "${v%$'\r'}"
}
if [ -n "$DB_PASS_FILE" ]; then read_secret_file "$DB_PASS_FILE" DB_PASS; fi
if [ -n "$DB_ROOT_PASS_FILE" ]; then read_secret_file "$DB_ROOT_PASS_FILE" DB_ROOT_PASS; fi
# รหัสผ่านไม่ส่งต่อให้โปรแกรมลูก (composer รันโค้ดของแพ็กเกจ · php spark) — dbtool ได้ค่าทาง PN_* เฉพาะคำสั่งนั้น
export -n DB_PASS DB_ROOT_PASS 2>/dev/null || true
# git ห้ามถามอะไร (composer อาจ git clone แพ็กเกจ) · ไม่เปิด pager
export GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat
LOG_FILE=''
APP_DIR=$(resolve_app_dir)
cd "$APP_DIR"
setup_colors
trap '' HUP # SSH หลุดกลางทาง = ทำต่อจนจบ — สืบทอดถึง composer/php ด้วย

if [ "$DRY_RUN" = 1 ]; then
    main
    exit 0
fi

# เก็บ log (ตัดสีออก) — writable/logs/deploy-<วันเวลา>.log · 640 · รันด้วย root = ผู้ใช้เว็บเป็นเจ้าของ
open_log
set +e; main 2>&1 | log_tee; _rc=${PIPESTATUS[0]}; exit "$_rc"
