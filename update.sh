#!/usr/bin/env bash
# =============================================================================
# update.sh — อัปเดต PayNest เป็นรุ่นล่าสุด (รันจบเองโดยไม่ถามอะไร)
#
#   sudo ./update.sh
#   ./update.sh --dry-run     ดูว่ามีอะไรใหม่และจะทำอะไรบ้าง โดยไม่แก้อะไรในเครื่อง
#   ./update.sh --help        ค่าที่ตั้งได้ทั้งหมด
#
# สำรองข้อมูล → git fetch + merge --ff-only → composer install → app:install → (reload PHP-FPM) → ตรวจ /health
# composer พัง = ถอยโค้ดกลับรุ่นเดิมให้เอง · app:install พัง = ไม่กู้ฐานข้อมูลเอง (ข้อมูลใหม่ของร้านจะหาย) แต่พิมพ์คำสั่งกู้ให้
# ขั้นตอนเดียวกับ DEPLOY.md ข้อ 7 · ไฟล์นี้ทำงานลำพังได้ ไม่พึ่งไฟล์อื่น
# exit code: 0 = สำเร็จ (หรือเป็นรุ่นล่าสุดอยู่แล้ว) · 1 = ไม่สำเร็จ (ดูข้อความ ✗) · 2 = ตัวเลือกผิด
# =============================================================================
# สั่งด้วย sh update.sh (dash) → สลับไปใช้ bash เอง
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -Eeuo pipefail
IFS=$' \t\n'
umask 022
export LC_ALL=C

SCRIPT_NAME=update.sh
LOG_KIND=update
FAIL_TITLE='อัปเดตไม่สำเร็จ'
STEP_TOTAL=11
REQUIRED_EXTS="intl mbstring mysqli curl gd openssl zlib"
KNOWN_VARS="BRANCH REMOTE SKIP_BACKUP APP_URL RELOAD_FPM WEB_USER PHP_BIN COMPOSER_BIN DRY_RUN"
BOOL_VARS="SKIP_BACKUP DRY_RUN"

usage() {
    cat <<'TXT'
update.sh — อัปเดต PayNest เป็นรุ่นล่าสุด (ไม่ถามอะไร รันจบเอง)

วิธีใช้
  sudo ./update.sh [ตัวเลือก]

สิ่งที่ทำตามลำดับ
  1. ตรวจเครื่อง + ล็อกกันรันซ้อน (ต้องติดตั้งไว้แล้ว — ด้วย deploy.sh หรือทำมือตาม DEPLOY.md: มี .env และกุญแจลับ)
  2. หยุดถ้ามีไฟล์โค้ดถูกแก้บนเครื่อง (ไม่ stash/reset ของคุณให้)
  3. จดรุ่นเดิม  4. สำรองข้อมูล (php spark app:backup — ไม่สำเร็จ = ไม่อัปเดต)
  5. git fetch + merge --ff-only (ไม่มีของใหม่ = ไม่เปลี่ยนโค้ด แค่ตรวจ vendor/ + รัน app:install)
  6. composer install (โค้ดใหม่พัง = ถอยโค้ดกลับรุ่นเดิมให้เอง)  7. แก้เจ้าของไฟล์ writable/
  8. php spark app:install (พัง = พิมพ์คำสั่งกู้ข้อมูลจากไฟล์สำรองให้ ไม่กู้เอง)
  9. reload PHP-FPM (ถ้าจำเป็น)  10. ตรวจ /health  11. สรุป

ตัวเลือก
  --dry-run        แสดงว่ามีอะไรใหม่และจะทำอะไร โดยไม่แก้อะไรในเครื่อง
  --help           แสดงหน้านี้
  ทุกค่าด้านล่างตั้งเป็นตัวแปรสภาพแวดล้อม หรือส่งเป็นตัวเลือกตัวเล็กก็ได้ เช่น --branch=main --reload-fpm=1

ค่าที่ตั้งได้
  BRANCH        branch ที่จะอัปเดต (ค่าตั้งต้น: branch ปัจจุบัน — ต้องตรงกับที่ checkout อยู่)
  REMOTE        ที่เก็บโค้ดต้นทาง (ค่าตั้งต้น: origin)
  SKIP_BACKUP   1 = ไม่สำรองก่อนอัปเดต — ไม่แนะนำอย่างยิ่ง (ค่าตั้งต้น: 0)
  APP_URL       ที่อยู่เว็บสำหรับตรวจ /health (ค่าตั้งต้น: app.baseURL ใน .env)
  RELOAD_FPM    auto = reload เมื่อ opcache.validate_timestamps=0 · 1 = reload เสมอ · 0 = ไม่ reload (ค่าตั้งต้น: auto)
  WEB_USER      ผู้ใช้ของเว็บ (ค่าตั้งต้น: หาเอง www → www-data → nginx → apache)
  PHP_BIN       โปรแกรม PHP 8.2+ (ค่าตั้งต้น: /www/server/php/<รุ่นสูงสุด>/bin/php → php)
  COMPOSER_BIN  โปรแกรม composer (ค่าตั้งต้น: composer → .composer-bin/composer.phar → ดาวน์โหลด)

หมายเหตุ
  - รันด้วย root: php spark ทุกคำสั่งรันในนาม WEB_USER · ไม่ใช่ root: ต้องเป็นผู้ใช้เดียวกับ WEB_USER
  - git fetch ใช้สิทธิ์ของผู้ที่รันสคริปต์ (root) — repo ส่วนตัวต้องมี SSH key/deploy key ของผู้ใช้นั้น
  - ไม่พิมพ์รหัสผ่านใด ๆ ออกหน้าจอ/log · log อยู่ที่ writable/logs/update-<วันเวลา>.log
  - SSH หลุดระหว่างอัปเดต = สคริปต์ทำต่อจนจบเอง ดูผลใน log · app:install พังแล้วรันซ้ำ = ยังพิมพ์คำสั่งกู้ของรุ่นก่อนอัปเดตให้
  - ติดตั้งแบบทำมือมาก่อนมีสคริปต์นี้: อัปเดตครั้งแรกทำมือตาม DEPLOY.md ข้อ 7 (git pull) ครั้งเดียว แล้วค่อยใช้ ./update.sh
    อย่าคัดลอกไฟล์ update.sh มาวางเอง
TXT
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
                printf -v "$name" '%s' "$value"
                ;;
            --?*)
                name=$(opt_to_var "$1")
                word_in "$name" "$KNOWN_VARS" || die_usage "ไม่รู้จักตัวเลือก: $1"
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

# ทุกคำสั่ง git ของสคริปต์: ปิด hook และ fsmonitor เสมอ (ค่าจาก -c ชนะค่าใน .git/config)
# อัปเดตไม่ต้องใช้ hook อยู่แล้ว — ปิดไว้อีกชั้น กันโปรแกรมที่ใครแอบวางใน .git ถูกรันด้วยสิทธิ์ root
# ไม่ใส่ -c safe.directory: root ห้ามรัน git ใน repo ที่ผู้ใช้อื่นแก้ได้ (ดู check_repo_owner)
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C "$APP_DIR" "$@"; }

is_git_repo() { [ -e "$APP_DIR/.git" ] && have git; }

uid_of() { ls -lnd "$1" 2>/dev/null | awk '{ print $3; exit }'; }

# สิ่งใน .git ที่สั่งให้ git รันโปรแกรมได้ (คืนทีละบรรทัด · ว่าง = สะอาด)
# อ่าน config เป็นข้อความด้วย --file (ไม่รันอะไรจากในไฟล์) · hook ตัวอย่างของ git (*.sample) ไม่นับ
# credential helper ชื่อธรรมดา (store / cache / manager) ไม่นับ — นับเฉพาะแบบ "!คำสั่ง"
git_dir_findings() {
    local gd="$APP_DIR/.git" f
    if [ -d "$gd/hooks" ]; then
        for f in "$gd/hooks"/*; do
            [ -e "$f" ] || continue
            case $f in *.sample) ;; *) printf '%s\n' "hook: ${f#"$APP_DIR"/}" ;; esac
        done
    fi
    if [ -f "$gd/config" ]; then
        git config --file "$gd/config" --list 2>/dev/null | awk '
            { i = index($0, "="); k = tolower(i ? substr($0, 1, i - 1) : $0); v = i ? substr($0, i + 1) : "" }
            (k ~ /^core\.(hookspath|sshcommand|askpass|gitproxy)$/) ||
            (k == "core.fsmonitor" && v != "false" && v != "0" && v != "") ||
            (k ~ /^include(if\..*)?\.path$/) || (k ~ /^filter\./) || (k ~ /^merge\..*\.driver$/) ||
            (k ~ /^diff\..*\.(textconv|command)$/) || (k ~ /^remote\..*\.(uploadpack|receivepack)$/) ||
            (k ~ /helper$/ && v ~ /^!/) { print "config: " k }' || true
    fi
    if [ -s "$gd/info/attributes" ]; then printf '%s\n' 'attributes: .git/info/attributes'; fi
    return 0
}

# รันด้วย root แล้วโค้ด/.git เป็นของผู้ใช้เว็บ (aaPanel ตั้งโฟลเดอร์เว็บเป็นของ www เป็นค่าตั้งต้น):
# ถ้าผู้ใช้เว็บแก้ .git ได้ (hooks / core.fsmonitor / core.sshCommand) git ที่ root รันจะรันโปรแกรมของเขาด้วยสิทธิ์ root
# = เว็บโดนเจาะแล้วยึดเครื่องได้ — จึงตรวจ .git ก่อน: สะอาด → เปลี่ยนเจ้าของโค้ดเป็น root ให้เอง แล้วทำงานต่อ (เจ้าของระบบ: "รันจบในตัว")
# เจอของแปลกปลอม → หยุด ให้คนตรวจเอง (ไม่แตะอะไร)
repo_owned_by_web() { # → พาธแรกที่เป็นของผู้ใช้เว็บ (ว่าง = ไม่มี)
    local p web_uid
    web_uid=$(id -u "$WEB_USER")
    for p in "$APP_DIR" "$APP_DIR/.git" "$APP_DIR/.git/config" "$APP_DIR/.git/hooks"; do
        [ -e "$p" ] || continue
        if [ "$(uid_of "$p")" = "$web_uid" ]; then printf '%s\n' "$p" && return 0; fi
    done
    return 0
}

check_repo_owner() {
    [ "$IS_ROOT" = 1 ] || return 0
    local bad findings manual
    bad=$(repo_owned_by_web)
    [ -z "$bad" ] && return 0
    manual="chown -R root:root $APP_DIR; chown -R $WEB_USER:$WEB_GROUP $APP_DIR/writable $APP_DIR/.env"
    findings=$(git_dir_findings)
    if [ -n "$findings" ]; then
        fail "โค้ด ($bad) เป็นของผู้ใช้เว็บ $WEB_USER และใน .git มีสิ่งที่สั่งให้ git รันโปรแกรมได้ — ไม่รัน git ด้วยสิทธิ์ root:" \
            "$findings" \
            "ตรวจว่าเป็นของที่ตั้งใจใส่ไว้เองหรือไม่ (ถ้าไม่ใช่ = เว็บอาจโดนเจาะ) ลบออก แล้วรันใหม่ — หรือเปลี่ยนเจ้าของเอง:" \
            "  $manual" \
            "  หรือรันในนามผู้ใช้เว็บแทน root: sudo -u $WEB_USER WEB_USER=$WEB_USER ./$SCRIPT_NAME"
    fi
    if [ "$DRY_RUN" = 1 ]; then
        plan "โค้ดเป็นของผู้ใช้เว็บ $WEB_USER (ค่าตั้งต้นของ aaPanel) — .git ไม่มีสิ่งแปลกปลอม จะเปลี่ยนเจ้าของโค้ดเป็น root (writable/ และ .env ยังเป็นของ $WEB_USER · ข้าม .user.ini)"
        return 0
    fi
    # เว็บอ่านโค้ดได้ตามเดิม (สิทธิ์อ่านไม่เปลี่ยน) · ที่ต้องเขียน (writable/) และอ่าน (.env) ยังเป็นของผู้ใช้เว็บ
    # .user.ini ของ aaPanel ถูกล็อกไว้ (chattr +i) เปลี่ยนเจ้าของไม่ได้อยู่แล้ว — ข้าม · -h = ไม่ตามลิงก์
    find "$APP_DIR" \( -path "$APP_DIR/writable" -o -path "$APP_DIR/.env" \) -prune -o ! -name .user.ini -exec chown -h root:root {} + 2>/dev/null || true
    if [ -d "$APP_DIR/writable" ] && [ ! -L "$APP_DIR/writable" ]; then chown -R "$WEB_USER:$WEB_GROUP" "$APP_DIR/writable"; fi
    if [ -f "$APP_DIR/.env" ] && [ ! -L "$APP_DIR/.env" ]; then chown "$WEB_USER:$WEB_GROUP" "$APP_DIR/.env"; fi
    bad=$(repo_owned_by_web)
    [ -z "$bad" ] || fail "เปลี่ยนเจ้าของ $bad เป็น root ไม่ได้" "รันเอง: $manual แล้วรัน sudo ./$SCRIPT_NAME ใหม่"
    ok "โค้ดเคยเป็นของ $WEB_USER (ค่าตั้งต้นของ aaPanel) — ตรวจ .git แล้วไม่พบสิ่งแปลกปลอม เปลี่ยนเจ้าของโค้ดเป็น root แล้ว (writable/ และ .env ยังเป็นของ $WEB_USER)"
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
            $m  = $connect($env('PN_ADMIN_USER'), $env('PN_ADMIN_PASS'), null);
            $db = str_replace('`', '``', $env('PN_DB_NAME'));
            $m->query("CREATE DATABASE IF NOT EXISTS `{$db}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
            foreach (preg_split('/\s+/', trim($env('PN_DB_USER_HOSTS'))) as $host) {
                $who = "'" . $m->real_escape_string($env('PN_DB_USER')) . "'@'" . $m->real_escape_string($host) . "'";
                $m->query("CREATE USER IF NOT EXISTS {$who} IDENTIFIED BY '" . $m->real_escape_string($env('PN_DB_PASS')) . "'");
                $m->query("GRANT ALL PRIVILEGES ON `{$db}`.* TO {$who}");
            }
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
}

# ─── ตรวจเครื่อง (เหมือน deploy.sh) ─────────────────────────────────────────


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
        # หาบรรทัดที่ขึ้นต้นด้วย "Composer " (บรรทัดบอกรุ่น) — PHP บางเครื่องพิมพ์ notice (ขึ้นต้นด้วยบรรทัดว่าง) ก่อนรุ่นของ composer
        # เดิมอ่านบรรทัดแรกเฉย ๆ เลยได้บรรทัดว่าง แล้วเตือนว่าเรียกไม่ได้ ทั้งที่ composer ใช้ได้ (เจอบน aaPanel)
        v=$(run_composer --version --no-ansi 2>/dev/null </dev/null | sed -n '/^Composer /{p;q;}' || true)
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
        # notice/deprecation ของ PHP ไปออก stderr — ยังเห็นในจอและ log แต่ไม่ปนกับผลลัพธ์ที่สคริปต์อ่าน
        "$PHP_BIN" -d display_errors=stderr "$COMPOSER_BIN" "$@"
    else
        "$COMPOSER_BIN" "$@"
    fi
}

composer_install() {
    (cd "$APP_DIR" && run_composer install --no-dev --optimize-autoloader --no-interaction --no-progress --no-ansi </dev/null)
}

# ─── ขั้นที่ 1: ล็อก + ตรวจความพร้อม ────────────────────────────────────────

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

load_db_from_env() {
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

preflight() {
    step "ตรวจความพร้อมของเครื่อง + ล็อกกันรันซ้อน"
    detect_os
    detect_user
    if [ "$DRY_RUN" = 1 ]; then
        plan "จะสร้างล็อก writable/update.lock (กันรัน update.sh/deploy.sh ซ้อนกัน)"
    else
        acquire_lock
        ok "ล็อกแล้ว (writable/update.lock · PID $$)"
    fi
    [ -f "$APP_DIR/spark" ] && [ -f "$APP_DIR/composer.json" ] ||
        fail "$APP_DIR ไม่ใช่โฟลเดอร์ของ PayNest (ไม่มี spark / composer.json)" "วาง $SCRIPT_NAME ไว้ที่รากโปรเจกต์ (ข้าง ๆ spark) แล้วรันจากตรงนั้น"
    ok "โฟลเดอร์ของระบบ: $APP_DIR"
    have git || fail "ไม่พบ git — update.sh ต้องใช้ git (apt install git)"
    [ -e "$APP_DIR/.git" ] || fail "โฟลเดอร์นี้ไม่ใช่ git clone — อัปเดตด้วย update.sh ไม่ได้" "ติดตั้งใหม่ด้วย git clone ตาม DEPLOY.md (ย้าย .env และ writable/data ไปด้วย)"
    check_repo_owner
    local gerr
    if ! gerr=$(g rev-parse --git-dir 2>&1 >/dev/null); then
        case $gerr in
            *dubious* | *safe.directory*)
                fail "git ไม่ยอมทำงานในโฟลเดอร์นี้ (เจ้าของโฟลเดอร์ไม่ใช่ $(id -un))" \
                    "รันครั้งเดียว: git config --global --add safe.directory $APP_DIR แล้วรันใหม่"
                ;;
            *) fail "git ใช้กับโฟลเดอร์นี้ไม่ได้: $gerr" ;;
        esac
    fi
    ok "$(git --version)"
    detect_php
    detect_composer
    [ -f "$APP_DIR/.env" ] || fail "ยังไม่มี .env — ยังไม่เคยติดตั้งบนเครื่องนี้" "ติดตั้งก่อน: sudo ./deploy.sh"
    DATA_DIR=$(data_dir)
    PENDING_FILE=$DATA_DIR/update-pending.env
    if [ -f "$DATA_DIR/secrets.json" ]; then
        ok "พบ .env และ $DATA_DIR/secrets.json (ติดตั้งไว้แล้ว)"
    elif secrets_in_env; then
        ok "พบ .env (กุญแจลับตั้งไว้ใน .env: paynest.jwtSecret / paynest.encryptionKey)"
    else
        fail "ไม่พบ $DATA_DIR/secrets.json — ยังไม่เคยติดตั้งบนเครื่องนี้ (หรือกุญแจลับหาย)" \
            "ติดตั้งก่อน: sudo ./deploy.sh" \
            "กุญแจลับหาย: กู้จาก $DATA_DIR/backups/secrets.json (DEPLOY.md ข้อ 6) — ห้ามรัน app:install ก่อนกู้ (ระบบจะสุ่มกุญแจใหม่)"
    fi
    load_db_from_env
    if [ "$(g config --get core.fileMode 2>/dev/null || true)" != false ]; then
        if [ "$DRY_RUN" = 1 ]; then
            plan "git config core.fileMode false (ไม่นับการเปลี่ยนสิทธิ์ไฟล์ว่าเป็นการแก้โค้ด)"
        else
            g config core.fileMode false
            ok "git config core.fileMode false (ไม่นับการเปลี่ยนสิทธิ์ไฟล์ว่าเป็นการแก้โค้ด)"
        fi
    fi
    # vendor/ หาย/ไม่ครบ (อัปเดตรอบก่อนหยุดกลางทาง, git pull เองแล้วลืม composer) — app:backup ก็ใช้ vendor/ ต้องซ่อมก่อน
    if [ ! -f "$APP_DIR/vendor/autoload.php" ]; then
        if [ "$DRY_RUN" = 1 ]; then
            plan "ไม่มี vendor/autoload.php — จะรัน composer install ก่อนสำรองข้อมูล"
        else
            info "ไม่มี vendor/autoload.php — รัน composer install ก่อน (สำรองข้อมูลต้องใช้)"
            composer_install || fail "composer install ไม่สำเร็จ — ดูข้อความของ composer ด้านบน (ยังไม่ได้แตะโค้ดหรือฐานข้อมูล)" \
                "ขาดส่วนขยาย PHP / เน็ตหลุด: แก้แล้วรัน ./$SCRIPT_NAME ใหม่"
            ok "composer install เสร็จ (vendor/)"
        fi
    fi
}

# ─── ขั้นที่ 2–5: git ────────────────────────────────────────────────────────

step_dirty_check() {
    step "ตรวจว่าไม่มีไฟล์โค้ดถูกแก้บนเครื่อง"
    local dirty
    dirty=$(g status --porcelain --untracked-files=no)
    if [ -z "$dirty" ]; then
        ok "ไม่มีไฟล์โค้ดถูกแก้ (git status สะอาด)"
        return
    fi
    printf '%s\n' "$dirty" | indent
    stop_or_fail "มีไฟล์โค้ดถูกแก้บนเครื่องนี้ (รายการด้านบน) — ไม่อัปเดตทับ และไม่ stash/reset ให้" \
        "การแก้บนเครื่องจะชนกับโค้ดใหม่ หรือถูกทับหายไป — เลือกเองว่าจะทำอย่างไร:" \
        "  ดูว่าแก้อะไร:            git -C $APP_DIR diff" \
        "  ไม่ต้องการแล้ว (ทิ้ง):    git -C $APP_DIR checkout -- <ไฟล์>" \
        "  ต้องการเก็บไว้:           ส่งการแก้นั้นให้นักพัฒนาใส่ในโค้ดหลัก แล้วค่อยทิ้งบนเครื่อง" \
        "แล้วรัน ./$SCRIPT_NAME ใหม่"
}

step_record_old() {
    step "รุ่นปัจจุบัน"
    OLD_COMMIT=$(g rev-parse HEAD)
    OLD_SHORT=$(g rev-parse --short HEAD)
    OLD_VERSION=$(code_version)
    CUR_BRANCH=$(g symbolic-ref --short -q HEAD 2>/dev/null || true)
    ok "รุ่น ${OLD_VERSION:-?} · commit $OLD_SHORT · branch ${CUR_BRANCH:-(detached HEAD)}"
    # RESTORE_* = สภาพก่อนอัปเดต สำหรับคำสั่งกู้/สรุป — ปกติคือรุ่นตอนนี้ · มีงานค้างจากรอบก่อน = ของรอบนั้น
    RESTORE_COMMIT=$OLD_COMMIT RESTORE_SHORT=$OLD_SHORT RESTORE_VERSION=$OLD_VERSION RESTORE_BACKUP=''
    load_pending
}

# ─── งานค้างจากรอบก่อน (app:install พัง / หยุดกลางทาง) ───────────────────────
# <dataDir>/update-pending.env จด commit/รุ่นก่อนอัปเดต + ไฟล์สำรองก่อนอัปเดต ตั้งแต่ก่อน merge จนกว่า app:install ผ่าน
# รันซ้ำหลังพัง = คำสั่งกู้และสรุปยังอ้างของรอบแรก (ไม่ใช่ HEAD ที่เป็นโค้ดใหม่แล้ว หรือไฟล์สำรองที่มีข้อมูลครึ่ง ๆ กลาง ๆ)

PENDING_LOADED=0
PENDING_CREATED=0

load_pending() {
    [ -n "${PENDING_FILE:-}" ] && [ -f "$PENDING_FILE" ] || return 0
    local k v c='' ver='' b='' at='' rest
    # ไฟล์อยู่ในโฟลเดอร์ของผู้ใช้เว็บ — อ่านเป็นข้อมูลอย่างเดียว (ไม่ source) และรับเฉพาะค่าที่หน้าตาถูกต้อง
    while IFS='=' read -r k v || [ -n "$k" ]; do
        case $k in
            OLD_COMMIT) case $v in '' | *[!0-9a-f]*) ;; *) if [ "${#v}" -eq 40 ]; then c=$v; fi ;; esac ;;
            OLD_VERSION) case $v in *[!0-9A-Za-z.+_-]*) ;; *) ver=$v ;; esac ;;
            BACKUP_FILE)
                rest=${v#"$DATA_DIR"/backups/db/}
                case $rest in "$v" | */* | *[!0-9A-Za-z._-]*) ;; paynest-*.sql.gz) if [ -f "$v" ]; then b=$v; fi ;; esac
                ;;
            AT) case $v in *[!0-9:\ -]*) ;; *) at=$v ;; esac ;;
        esac
    done <"$PENDING_FILE"
    if [ -z "$c" ] || ! g cat-file -e "$c^{commit}" 2>/dev/null; then
        warn "ไฟล์ $PENDING_FILE ไม่ถูกต้อง — ไม่ใช้ (ลบทิ้งได้)"
        return 0
    fi
    PENDING_LOADED=1
    CODE_CHANGED=1 # โค้ดเปลี่ยนไปแล้วตั้งแต่รอบก่อน — รอบนี้ต้องทำต่อให้จบ (reload PHP-FPM, สรุปแบบอัปเดต)
    RESTORE_COMMIT=$c
    RESTORE_SHORT=$(g rev-parse --short "$c")
    RESTORE_VERSION=$ver
    RESTORE_BACKUP=$b
    warn "การอัปเดตรอบก่อน${at:+ ($at)} ยังไม่จบ (app:install ไม่ผ่าน หรือหยุดกลางทาง) — รุ่นก่อนอัปเดตคือ ${ver:-?} ($RESTORE_SHORT)"
    info "ไฟล์สำรองก่อนอัปเดต: ${b:-ไม่มี (รอบนั้น SKIP_BACKUP=1 หรือไฟล์ถูกลบ)} — คำสั่งกู้และสรุปของรอบนี้อ้างรุ่น/ไฟล์นี้"
}

save_pending() { # จดก่อนแตะโค้ด/ฐานข้อมูล — มีของรอบก่อนอยู่แล้ว = ไม่ทับ
    if [ "$PENDING_LOADED" = 1 ] || [ "$PENDING_CREATED" = 1 ] || [ "$DRY_RUN" = 1 ]; then return 0; fi
    # เขียนในนามผู้ใช้เว็บ (เจ้าของโฟลเดอร์ข้อมูล) — root ไม่เขียนตามชื่อไฟล์ในโฟลเดอร์ที่ผู้ใช้อื่นแก้ได้
    if printf 'OLD_COMMIT=%s\nOLD_VERSION=%s\nBACKUP_FILE=%s\nAT=%s\n' "$OLD_COMMIT" "$OLD_VERSION" "$BACKUP_FILE" "$(date '+%Y-%m-%d %H:%M')" |
        as_web sh -c 'umask 077 && cat >"$1"' sh "$PENDING_FILE" 2>"$TMPD/pending.err"; then
        PENDING_CREATED=1
    else
        warn "จดสถานะการอัปเดตที่ $PENDING_FILE ไม่ได้: $(cat "$TMPD/pending.err") — ถ้าพังแล้วรันซ้ำ ให้ใช้คำสั่งกู้ที่พิมพ์ในรอบนี้"
    fi
}

clear_pending() {
    if [ -n "${PENDING_FILE:-}" ]; then rm -f "$PENDING_FILE" 2>/dev/null || true; fi
    PENDING_CREATED=0
}

step_backup() {
    step "สำรองข้อมูลก่อนอัปเดต (php spark app:backup)"
    local out=$TMPD/backup.out rc=0 dir newest pre
    BACKUP_FILE='' BACKUP_PLAIN=''
    if is_true "$SKIP_BACKUP"; then
        warn "SKIP_BACKUP=1 — ไม่สำรองข้อมูลก่อนอัปเดต (ไม่แนะนำอย่างยิ่ง: migration บางตัวย้อนกลับไม่ได้ ถ้าพังต้องกู้จากไฟล์สำรองเมื่อคืน)"
        return
    fi
    if [ "$DRY_RUN" = 1 ]; then
        plan "จะรัน: php spark app:backup ในนาม $WEB_USER (ไม่สำเร็จ = หยุด ไม่อัปเดต)"
        return
    fi
    # รันด้วย root: ไฟล์ใน writable/ ที่เคยถูกสร้างด้วย root (เผลอรัน php spark ด้วย root) ทำให้ app:backup ในนามผู้ใช้เว็บพัง
    if [ "$IS_ROOT" = 1 ] && [ ! -L "$APP_DIR/writable" ]; then chown -R "$WEB_USER:$WEB_GROUP" "$APP_DIR/writable"; fi
    spark_capture "$out" app:backup || rc=$?
    if [ "$rc" != 0 ]; then
        fail "สำรองข้อมูลไม่สำเร็จ (exit code $rc) — ไม่อัปเดต (ยังไม่ได้แตะโค้ดหรือฐานข้อมูล)" \
            "ดูข้อความด้านบน · ดิสก์เต็ม? df -h · สิทธิ์โฟลเดอร์? chown -R $WEB_USER:$WEB_GROUP $APP_DIR/writable"
    fi
    BACKUP_FILE=$(after_marker "$out" 'สำรองแล้ว: ')
    BACKUP_FILE=${BACKUP_FILE% (*}
    if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
        dir=$DATA_DIR/backups/db
        newest=$(ls -t "$dir" 2>/dev/null | sed -n '1p' || true)
        BACKUP_FILE=${newest:+$dir/$newest}
    fi
    # app:backup ตั้งชื่อไฟล์ถึงระดับนาที — รันซ้ำในนาทีเดียวกัน (เช่นรันซ้ำทันทีหลัง app:install พัง) จะทับไฟล์นี้
    # ด้วยข้อมูลที่อัปเดตไปครึ่งทาง → ทำ hard link ชื่อเฉพาะของรอบนี้ (app:backup เขียนไฟล์ใหม่แล้ว rename ทับ link นี้จึงยังเป็นข้อมูลเดิม)
    # ชื่อยังขึ้นต้น paynest- และลงท้าย .sql.gz → ถูกลบตามรอบเก็บ 30 วันเหมือนไฟล์อื่น
    if [ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ]; then
        pre=${BACKUP_FILE%.sql.gz}-pre-update-$(date +%H%M%S).sql.gz
        if [ ! -e "$pre" ] && { as_web ln "$BACKUP_FILE" "$pre" 2>/dev/null || as_web cp -p "$BACKUP_FILE" "$pre" 2>/dev/null; }; then
            BACKUP_PLAIN=$BACKUP_FILE
            BACKUP_FILE=$pre
        else
            warn "ทำสำเนาชื่อเฉพาะของไฟล์สำรองไม่ได้ — รันซ้ำในนาทีเดียวกันจะทับไฟล์ ${BACKUP_FILE##*/}"
        fi
    fi
    ok "สำรองแล้ว: ${BACKUP_FILE:-(หาไฟล์ไม่เจอ — ดูข้อความด้านบน)}"
    if [ "$PENDING_LOADED" != 1 ]; then RESTORE_BACKUP=$BACKUP_FILE; fi
}

setup_git_env() {
    # ห้าม git ถามรหัส/ยืนยัน host key — ไม่มีใครตอบ (ค้างตลอดไป)
    export GIT_TERMINAL_PROMPT=0
    if [ -z "${GIT_SSH_COMMAND:-}" ] && [ -z "${GIT_SSH:-}" ] && [ -z "$(g config --get core.sshCommand 2>/dev/null || true)" ]; then
        export GIT_SSH_COMMAND='ssh -o BatchMode=yes'
    fi
}

MOVED_ASIDE=''

# ไฟล์ deploy.sh / update.sh ที่คัดลอกมาวางเอง (ไม่อยู่ใน git) แต่รุ่นใหม่มี — git merge จะไม่ยอมทับ → ย้ายไปเป็น *.before-update
move_untracked_scripts() { # target
    local f
    for f in deploy.sh update.sh; do
        if [ -e "$APP_DIR/$f" ] && ! g ls-files --error-unmatch -- "$f" >/dev/null 2>&1 && g cat-file -e "$1:$f" 2>/dev/null; then
            mv -f "$APP_DIR/$f" "$APP_DIR/$f.before-update"
            MOVED_ASIDE="$MOVED_ASIDE $f"
            info "$f บนเครื่องไม่ได้อยู่ใน git (คัดลอกมาวางเอง) แต่รุ่นใหม่มีไฟล์นี้ — ย้ายไปเป็น $f.before-update ก่อน merge"
        fi
    done
}

restore_moved_scripts() { # คืนไฟล์ที่ย้ายไว้ (merge ไม่ผ่าน / ถอยโค้ดกลับ)
    local f
    for f in $MOVED_ASIDE; do
        if [ ! -e "$APP_DIR/$f" ] && [ -e "$APP_DIR/$f.before-update" ]; then mv -f "$APP_DIR/$f.before-update" "$APP_DIR/$f" 2>/dev/null || true; fi
    done
    MOVED_ASIDE=''
}

drop_moved_scripts() { # อัปเดตจบแล้ว: สำเนาที่เหมือนรุ่นใหม่ทุกไบต์ลบทิ้ง · ต่างกัน = เก็บไว้ให้ดู
    local f
    for f in $MOVED_ASIDE; do
        if cmp -s "$APP_DIR/$f" "$APP_DIR/$f.before-update"; then
            rm -f "$APP_DIR/$f.before-update"
        else
            info "$f ที่คัดลอกมาวางเองเก็บไว้ที่ $f.before-update (ต่างจากรุ่นใน git — ดูแล้วลบทิ้งได้)"
        fi
    done
    MOVED_ASIDE=''
}

step_fetch() {
    step "ดึงโค้ดใหม่ (git fetch + merge --ff-only)"
    local target err remote_hash
    setup_git_env
    if [ -z "$CUR_BRANCH" ]; then
        stop_or_fail "โค้ดไม่ได้อยู่บน branch ใด (detached HEAD) — ไม่รู้จะอัปเดตตาม branch ไหน" \
            "สลับไป branch ที่ใช้งาน เช่น: git -C $APP_DIR checkout main แล้วรันใหม่"
        BRANCH=${BRANCH:-?}
        NEW_COUNT=0
        return
    fi
    BRANCH=${BRANCH:-$CUR_BRANCH}
    if [ "$BRANCH" != "$CUR_BRANCH" ]; then
        stop_or_fail "BRANCH=$BRANCH แต่โค้ดอยู่ที่ branch $CUR_BRANCH — ไม่สลับ branch ให้" \
            "สลับเองก่อน: git -C $APP_DIR checkout $BRANCH แล้วรัน ./$SCRIPT_NAME ใหม่"
    fi
    local remotes
    remotes=$(g remote)
    case "
$remotes
" in
        *"
$REMOTE
"*) ;;
        *) fail "ไม่มี remote ชื่อ $REMOTE (มี: $(printf '%s' "$remotes" | tr '\n' ' '))" "ระบุเอง เช่น REMOTE=origin" ;;
    esac
    target=refs/remotes/$REMOTE/$BRANCH
    if [ "$DRY_RUN" = 1 ]; then
        remote_hash=$(g ls-remote "$REMOTE" "refs/heads/$BRANCH" 2>"$TMPD/git.err" | awk '{print $1; exit}' || true)
        if [ -z "$remote_hash" ]; then
            warn "(รันจริงจะหยุดตรงนี้) อ่าน $REMOTE/$BRANCH ไม่ได้: $(cat "$TMPD/git.err")"
            NEW_COUNT=0
        elif [ "$remote_hash" = "$OLD_COMMIT" ]; then
            NEW_COUNT=0
            ok "$REMOTE/$BRANCH = ${remote_hash:0:7} — เป็นรุ่นล่าสุดอยู่แล้ว (รันจริงจะไม่เปลี่ยนโค้ด — ตรวจ vendor/ แล้วรัน app:install)"
        elif g cat-file -e "$remote_hash^{commit}" 2>/dev/null; then
            NEW_COUNT=$(g rev-list --count "HEAD..$remote_hash")
            plan "มี commit ใหม่ $NEW_COUNT commit บน $REMOTE/$BRANCH — จะ git fetch แล้ว git merge --ff-only:"
            g log --oneline --no-decorate -n 20 "HEAD..$remote_hash" | indent
        else
            NEW_COUNT=1
            plan "$REMOTE/$BRANCH มีของใหม่ (${remote_hash:0:7} — ยังไม่ได้ดึงจึงนับจำนวนไม่ได้) → จะ git fetch แล้ว git merge --ff-only"
        fi
        return
    fi
    if ! g fetch --no-tags "$REMOTE" "+refs/heads/$BRANCH:$target" 2>"$TMPD/git.err"; then
        err=$(cat "$TMPD/git.err")
        printf '%s\n' "$err" | indent
        local kept='ยังไม่ได้เปลี่ยนโค้ด'
        if [ -n "$BACKUP_FILE" ]; then kept="$kept (ไฟล์สำรองที่เพิ่งทำยังอยู่)"; fi
        fail "git fetch $REMOTE $BRANCH ไม่สำเร็จ — $kept" \
            "ไม่มีเน็ต / repo ส่วนตัวต้องมี SSH key หรือ deploy key ของผู้ใช้ $(id -un) · ลองเอง: git -C $APP_DIR fetch $REMOTE"
    fi
    NEW_HEAD=$(g rev-parse "$target")
    NEW_COUNT=$(g rev-list --count "HEAD..$target")
    if [ "$NEW_COUNT" = 0 ]; then
        local ahead
        ahead=$(g rev-list --count "$target..HEAD")
        ok "เป็นรุ่นล่าสุดอยู่แล้ว — ไม่มี commit ใหม่บน $REMOTE/$BRANCH"
        if [ "$ahead" != 0 ]; then warn "เครื่องนี้มี $ahead commit ที่ $REMOTE/$BRANCH ไม่มี (commit บนเครื่องเซิร์ฟเวอร์?) — ไม่แตะ"; fi
        return
    fi
    if ! g merge-base --is-ancestor HEAD "$target"; then
        fail "อัปเดตแบบ fast-forward ไม่ได้ — branch บนเครื่องกับ $REMOTE/$BRANCH แยกทางกัน (ไม่ merge/rebase ให้)" \
            "สาเหตุ: มี commit บนเครื่องนี้ที่ $REMOTE ไม่มี หรือ $REMOTE ถูก force push · โค้ดยังเป็นรุ่นเดิม" \
            "ดู: git -C $APP_DIR log --oneline --graph -n 20 HEAD $REMOTE/$BRANCH" \
            "ถ้าแน่ใจว่าจะใช้ของ $REMOTE ทั้งหมด (ทิ้ง commit บนเครื่อง): git -C $APP_DIR reset --hard $REMOTE/$BRANCH แล้วรันใหม่"
    fi
    info "commit ใหม่ $NEW_COUNT commit:"
    g log --oneline --no-decorate -n 20 "HEAD..$target" | indent
    if [ "$NEW_COUNT" -gt 20 ]; then info "… (แสดง 20 commit ล่าสุด)"; fi
    move_untracked_scripts "$target"
    save_pending
    if ! g merge --ff-only --quiet "$target" >"$TMPD/git.out" 2>&1; then
        indent <"$TMPD/git.out"
        restore_moved_scripts
        if [ "$PENDING_CREATED" = 1 ]; then clear_pending; fi
        if grep -q 'would be overwritten' "$TMPD/git.out"; then
            fail "git merge ไม่สำเร็จ — ไฟล์บนเครื่อง (รายการด้านบน) ไม่อยู่ใน git แต่รุ่นใหม่มีไฟล์ชื่อเดียวกัน (git ไม่ทับให้) · โค้ดยังเป็นรุ่นเดิม" \
                "ย้ายไฟล์เหล่านั้นออกไปก่อน เช่น: mv <ไฟล์> <ไฟล์>.bak แล้วรัน ./$SCRIPT_NAME ใหม่"
        fi
        fail "git merge --ff-only ไม่สำเร็จ — โค้ดยังเป็นรุ่นเดิม"
    fi
    CODE_CHANGED=1
    ok "อัปเดตโค้ดแล้ว: $OLD_SHORT → $(g rev-parse --short HEAD)"
}

# ─── ขั้นที่ 6–8: composer + สิทธิ์ + app:install ───────────────────────────

step_composer() {
    step "ติดตั้งไลบรารี (composer install)"
    if [ "$DRY_RUN" = 1 ]; then
        if [ "$NEW_COUNT" = 0 ]; then
            plan "จะรัน: composer install --no-dev --optimize-autoloader (ไม่มีโค้ดใหม่ — แค่ตรวจว่า vendor/ ครบ ไม่กี่วินาที)"
        else
            plan "จะรัน: composer install --no-dev --optimize-autoloader --no-interaction --no-progress (พัง = ถอยโค้ดกลับ $OLD_SHORT ให้เอง)"
        fi
        return
    fi
    if [ "$NEW_COUNT" = 0 ]; then
        # ไม่มีโค้ดใหม่ก็ยังรัน: ซ่อม vendor/ ที่ไม่ครบ (รอบก่อนหยุดกลางทาง / git pull เองแล้วลืม composer) — ไม่มีอะไรต้องทำ = เสร็จเร็ว
        composer_install || fail "composer install ไม่สำเร็จ — vendor/ อาจไม่ครบ (โค้ดไม่ได้เปลี่ยนในรอบนี้)" \
            "ดูข้อความของ composer ด้านบน (ขาดส่วนขยาย PHP? เน็ตหลุด?) แก้แล้วรัน ./$SCRIPT_NAME ใหม่"
        ok "composer install เสร็จ (vendor/ ตรงกับโค้ดปัจจุบัน)"
        return
    fi
    if composer_install; then
        ok "composer install เสร็จ"
        return
    fi
    printf '  %s✗ composer install ไม่สำเร็จ — ถอยโค้ดกลับรุ่นเดิม (%s)%s\n' "$C_ERR" "$OLD_SHORT" "$C_0"
    g reset --hard --quiet "$OLD_COMMIT"
    restore_moved_scripts
    CODE_CHANGED=$PENDING_LOADED
    # กลับเป็นสภาพก่อนรอบนี้แล้ว และยังไม่ได้แตะฐานข้อมูล — สถานะ "อัปเดตค้าง" ของรอบนี้ไม่ต้องเก็บ
    if [ "$PENDING_CREATED" = 1 ]; then clear_pending; fi
    ok "git reset --hard $OLD_SHORT — โค้ดกลับเป็นรุ่น ${OLD_VERSION:-?} แล้ว"
    if composer_install; then
        ok "composer install ของรุ่นเดิมเสร็จ"
        fail "อัปเดตไม่สำเร็จ ถอยกลับรุ่นเดิมแล้ว ระบบยังใช้งานได้" \
            "ยังไม่ได้แตะฐานข้อมูล · ดูข้อความของ composer ด้านบน (ขาดส่วนขยาย PHP? เน็ตหลุด?) แก้แล้วรัน ./$SCRIPT_NAME ใหม่"
    fi
    fail "อัปเดตไม่สำเร็จ ถอยโค้ดกลับรุ่นเดิมแล้ว แต่ composer install ของรุ่นเดิมก็ไม่ผ่าน — vendor/ อาจไม่ครบ" \
        "ยังไม่ได้แตะฐานข้อมูล · แก้ composer ให้ทำงานได้ แล้วรัน: cd $APP_DIR && composer install --no-dev --optimize-autoloader" \
        "จากนั้นค่อยรัน ./$SCRIPT_NAME ใหม่"
}

step_ownership() {
    step "เจ้าของไฟล์ writable/"
    if [ "$IS_ROOT" != 1 ]; then
        ok "ข้าม — ไม่ได้รันด้วย root (ไฟล์เป็นของ $WEB_USER อยู่แล้ว)"
        return
    fi
    if [ "$DRY_RUN" = 1 ]; then
        plan "chown -R $WEB_USER:$WEB_GROUP writable"
        return
    fi
    if [ -L "$APP_DIR/writable" ]; then fail "$APP_DIR/writable เป็น symlink — ไม่แก้เจ้าของตาม symlink ด้วย root (ทำให้เป็นโฟลเดอร์จริงแล้วรันใหม่)"; fi
    chown -R "$WEB_USER:$WEB_GROUP" "$APP_DIR/writable"
    ok "chown -R $WEB_USER:$WEB_GROUP writable"
}

print_restore_help() {
    local s='' backup=$RESTORE_BACKUP php=$PHP_BIN
    if [ "$IS_ROOT" = 1 ]; then s="sudo -u $WEB_USER "; fi
    if [ -z "$backup" ]; then
        backup=$(ls -t "$DATA_DIR/backups/db" 2>/dev/null | sed -n '1p' || true)
        backup=${backup:+$DATA_DIR/backups/db/$backup}
        info "⚠ ไม่มีไฟล์สำรองที่ทำก่อนอัปเดต (SKIP_BACKUP=1) — ไฟล์ล่าสุดที่มี: ${backup:-ไม่มี} (ตรวจเวลาไฟล์ว่าก่อนอัปเดตจริง)"
    fi
    info "ไม่ได้กู้ฐานข้อมูลคืนให้อัตโนมัติ — ข้อมูลที่ร้านเพิ่งบันทึกหลังสำรองจะหาย ให้คนดูแลตัดสินใจ"
    info "ทางที่ 1 (แนะนำก่อน): แก้ตาม error ด้านบน แล้วรัน ./$SCRIPT_NAME ใหม่ (หรือ ${s}$php $APP_DIR/spark app:install)"
    info "ทางที่ 2: ถอยกลับรุ่นก่อนอัปเดต ${RESTORE_VERSION:-?} ($RESTORE_SHORT) + กู้ฐานข้อมูลจากไฟล์สำรองก่อนอัปเดต (DEPLOY.md ข้อ 6):"
    if [ "$CODE_CHANGED" != 1 ]; then
        info "  (รอบนี้ไม่มี commit ใหม่ — ถ้าก่อนหน้านี้ git pull เอง รุ่นก่อน pull ดูได้จาก: git -C $APP_DIR reflog -n 5)"
    fi
    info "  # หยุดรับงานก่อน: aaPanel → Website → Stop และปิด cron ชั่วคราว"
    info "  cd $APP_DIR"
    info "  git reset --hard $RESTORE_COMMIT"
    info "  composer install --no-dev --optimize-autoloader"
    info "  mysql -u root -p -e \"DROP DATABASE $DB_NAME; CREATE DATABASE $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci\""
    info "  gunzip -c ${backup:-<ไฟล์สำรอง>.sql.gz} | mysql -u root -p $DB_NAME"
    if [ "$IS_ROOT" = 1 ]; then info "  chown -R $WEB_USER:$WEB_GROUP writable"; fi
    info "  ${s}$php spark app:install"
    info "  rm -f $PENDING_FILE    # ล้างสถานะ \"อัปเดตค้าง\""
    info "  # เปิดเว็บ + cron คืน"
}

step_app_install() {
    step "อัปเดตฐานข้อมูล (php spark app:install ในนาม $WEB_USER)"
    local before=0 rc=0 out=$TMPD/install.out line
    MIGRATIONS_RAN=''
    if [ "$DRY_RUN" = 1 ]; then
        plan "จะรัน: php spark app:install (migration ที่ค้าง + จดรุ่น + แจ้ง Telegram 🟢 · พัง = พิมพ์คำสั่งกู้ให้ ไม่กู้เอง)"
        return
    fi
    save_pending # ไม่มี commit ใหม่ก็จด (เช่น git pull เองไว้ก่อน — migration จะรันตอนนี้)
    before=$(db_app migrations-max 2>/dev/null || echo 0)
    spark_capture "$out" app:install || rc=$?
    if [ "$rc" != 0 ]; then
        printf '  %s✗ php spark app:install ไม่สำเร็จ (exit code %s) — ดูข้อความด้านบน%s\n' "$C_ERR" "$rc" "$C_0"
        print_restore_help
        if [ "$CODE_CHANGED" = 1 ]; then
            fail "อัปเดตฐานข้อมูลไม่สำเร็จ — โค้ดเป็นรุ่นใหม่แล้ว แต่ฐานข้อมูลอาจอัปเดตไม่ครบ (ทำตามทางที่ 1 หรือ 2 ด้านบน)" \
                "รายละเอียด error: $APP_DIR/writable/logs/log-$(date +%Y-%m-%d).log"
        fi
        fail "php spark app:install ไม่สำเร็จ — ฐานข้อมูลอาจอัปเดตไม่ครบ (ทำตามทางที่ 1 หรือ 2 ด้านบน)" \
            "รายละเอียด error: $APP_DIR/writable/logs/log-$(date +%Y-%m-%d).log"
    fi
    clear_pending
    drop_moved_scripts
    MIGRATIONS_RAN=$(PN_SINCE=$before db_app migrations-since 2>/dev/null || true)
    INSTALL_VERSION=$(after_marker "$out" '✓ ระบบรุ่น ')
    case $INSTALL_VERSION in *อัปเดตจาก*) CODE_CHANGED=1 ;; esac # git pull เองไว้ก่อนแล้ว — ฐานข้อมูลเพิ่งตามมา
    # ไม่มีอะไรเปลี่ยน = ไม่ต้องกันไฟล์สำรองไว้ใต้ชื่อเฉพาะ (ไม่ให้รายการไฟล์สำรองยาวขึ้นทุกครั้งที่รัน)
    if [ "$CODE_CHANGED" != 1 ] && [ -n "$BACKUP_PLAIN" ] && [ -f "$BACKUP_PLAIN" ]; then
        rm -f "$BACKUP_FILE" 2>/dev/null || true
        BACKUP_FILE=$BACKUP_PLAIN
    fi
    if [ -n "$MIGRATIONS_RAN" ]; then
        ok "migration ที่รันรอบนี้ $(printf '%s\n' "$MIGRATIONS_RAN" | grep -c .) ไฟล์:"
        printf '%s\n' "$MIGRATIONS_RAN" | while IFS= read -r line; do info "· $line"; done
    else
        ok "ไม่มี migration ใหม่"
    fi
    ok "app:install สำเร็จ${INSTALL_VERSION:+ — $INSTALL_VERSION}"
}

# ─── ขั้นที่ 9–10: PHP-FPM + /health ────────────────────────────────────────

opcache_no_validate() { # 0 = opcache.validate_timestamps ปิดอยู่ (ไฟล์ใหม่ต้อง reload ถึงจะเห็น)
    local val f
    "$PHP_BIN" -i >"$TMPD/phpinfo.txt" 2>/dev/null || true
    val=$(awk -F' => ' '$1 == "opcache.validate_timestamps" { print $2; exit }' "$TMPD/phpinfo.txt")
    case $val in Off | off | 0 | false) return 0 ;; esac
    # Ubuntu: FPM ใช้ ini คนละชุดกับ CLI · aaPanel: php.ini ของรุ่นที่เว็บใช้
    for f in /etc/php/"$FPM_DOT"/fpm/php.ini /etc/php/"$FPM_DOT"/fpm/conf.d/*.ini /www/server/php/"$FPM_MM"/etc/php.ini; do
        [ -f "$f" ] || continue
        if grep -qiE '^[[:space:]]*opcache\.validate_timestamps[[:space:]]*=[[:space:]]*"?(0|off|false|no)"?[[:space:]]*$' "$f"; then return 0; fi
    done
    return 1
}

step_reload_fpm() {
    step "PHP-FPM"
    FPM_STATUS='ไม่ต้อง reload'
    local need=0 reason=''
    # รุ่นของ PHP-FPM ที่เว็บใช้: จาก vhost ของ aaPanel ถ้าเจอ (อาจต่างจาก PHP_BIN ของ CLI) ไม่งั้นรุ่นเดียวกับ PHP_BIN
    FPM_MM=${SITE_PHP:-$PHP_MM}
    FPM_DOT=${FPM_MM%?}.${FPM_MM#?}
    case $RELOAD_FPM in
        1 | yes | true) need=1 reason='RELOAD_FPM=1' ;;
        0 | no | false) FPM_STATUS='ไม่ reload (RELOAD_FPM=0)' ;;
        *)
            if [ "$CODE_CHANGED" != 1 ] && [ "$NEW_COUNT" = 0 ]; then
                FPM_STATUS='ไม่ต้อง reload (ไม่มีโค้ดใหม่)'
            elif opcache_no_validate; then
                need=1 reason='opcache.validate_timestamps=0 — PHP ไม่อ่านไฟล์ใหม่เองจนกว่าจะ reload'
            fi
            ;;
    esac
    if [ "$need" != 1 ]; then
        ok "$FPM_STATUS · RELOAD_FPM=$RELOAD_FPM"
        return
    fi
    info "ต้อง reload: $reason"
    if [ "$DRY_RUN" = 1 ]; then
        plan "จะ reload: /etc/init.d/php-fpm-$FPM_MM reload → systemctl reload php$FPM_DOT-fpm → systemctl reload php-fpm (อันแรกที่ใช้ได้)"
        FPM_STATUS='จะ reload'
        return
    fi
    if [ "$IS_ROOT" != 1 ]; then
        FPM_STATUS='ต้อง reload เอง (ไม่ใช่ root)'
        warn "ไม่ได้รันด้วย root — reload เอง: sudo /etc/init.d/php-fpm-$FPM_MM reload (aaPanel) หรือ sudo systemctl reload php$FPM_DOT-fpm"
        return
    fi
    if [ -x "/etc/init.d/php-fpm-$FPM_MM" ] && "/etc/init.d/php-fpm-$FPM_MM" reload >"$TMPD/fpm.out" 2>&1; then
        FPM_STATUS="reload แล้ว (/etc/init.d/php-fpm-$FPM_MM)"
    elif have systemctl && systemctl reload "php$FPM_DOT-fpm" >"$TMPD/fpm.out" 2>&1; then
        FPM_STATUS="reload แล้ว (php$FPM_DOT-fpm)"
    elif have systemctl && systemctl reload php-fpm >"$TMPD/fpm.out" 2>&1; then
        FPM_STATUS='reload แล้ว (php-fpm)'
    else
        FPM_STATUS='reload ไม่สำเร็จ — ทำเอง'
        warn "reload PHP-FPM ไม่สำเร็จ — ทำเอง: aaPanel → App Store → PHP $FPM_DOT → Reload (หรือ systemctl reload php$FPM_DOT-fpm)"
        return
    fi
    ok "$FPM_STATUS"
}

step_health() {
    step "ตรวจหน้าเว็บ (/health)"
    local code body base
    HEALTH_STATUS='ไม่ได้ตรวจ'
    if [ -z "$APP_URL" ]; then
        base=$(env_get "$APP_DIR/.env" app.baseURL 2>/dev/null || true)
        case $base in '' | *example.com*) ;; *) APP_URL=${base%/} ;; esac
    fi
    if [ -z "$APP_URL" ]; then
        warn "ไม่รู้ที่อยู่เว็บ (APP_URL ไม่ได้ส่ง และ app.baseURL ใน .env ยังเป็นค่าตัวอย่าง) — ข้าม"
        return
    fi
    if [ "$DRY_RUN" = 1 ]; then
        plan "จะตรวจ: curl $APP_URL/health (ต้องได้ 200)"
        return
    fi
    if ! have curl; then
        warn "ไม่พบ curl — ข้าม (เปิดเองในเบราว์เซอร์: $APP_URL/health)"
        return
    fi
    code=$(http_check "$APP_URL/health")
    body=$(cat "$TMPD/health.out" 2>/dev/null || true)
    body=${body:0:300}
    if [ "$code" = 200 ]; then
        HEALTH_STATUS='200 OK'
        ok "$APP_URL/health → 200 $body"
    else
        HEALTH_STATUS="ไม่ผ่าน ($code)"
        warn "$APP_URL/health → $code ${body:-$(cat "$TMPD/health.err" 2>/dev/null)}"
        info "\"failing\":\"database\" = ต่อฐานข้อมูลไม่ได้ · \"failing\":\"schedule\" = cron ไม่เดิน (DEPLOY.md ข้อ 3 และ 5)"
    fi
}

# ─── สรุป ────────────────────────────────────────────────────────────────────

step_summary() {
    step "สรุป"
    local new_short new_version mig count
    if [ "$DRY_RUN" = 1 ]; then
        printf '\n%s✓ dry-run จบ — ยังไม่ได้แก้อะไรในเครื่อง%s\n' "$C_OK" "$C_0"
        printf '  รันจริง: sudo ./%s\n' "$SCRIPT_NAME"
        exit 0
    fi
    new_short=$(g rev-parse --short HEAD)
    new_version=$(code_version)
    if [ -n "$MIGRATIONS_RAN" ]; then
        mig="$(printf '%s\n' "$MIGRATIONS_RAN" | grep -c .) ไฟล์: $(printf '%s\n' "$MIGRATIONS_RAN" | tr '\n' ' ')"
        mig=${mig% }
    else
        mig='ไม่มี'
    fi
    if [ "$CODE_CHANGED" != 1 ]; then
        printf '\n%s✓ เป็นรุ่นล่าสุดอยู่แล้ว%s — รัน app:install ซ้ำให้แล้ว (ไม่มีอะไรเปลี่ยน)\n' "$C_OK$C_B" "$C_0"
        printf '  รุ่น             %s (%s)\n' "${new_version:-?}" "$new_short"
    elif [ "$NEW_COUNT" = 0 ] && [ "$PENDING_LOADED" != 1 ]; then
        # โค้ดถูก git pull มาก่อนแล้ว (ทำมือ) — รอบนี้ฐานข้อมูลเพิ่งตามมา
        printf '\n%s✓ อัปเดตเสร็จแล้ว%s — โค้ดถูกดึงมาก่อนแล้ว รอบนี้อัปเดตฐานข้อมูลให้ตรง\n' "$C_OK$C_B" "$C_0"
        printf '  รุ่น             %s\n' "${INSTALL_VERSION:-${new_version:-?} ($new_short)}"
    else
        count=$(g rev-list --count "$RESTORE_COMMIT..HEAD" 2>/dev/null || echo "$NEW_COUNT")
        printf '\n%s✓ อัปเดตเสร็จแล้ว%s\n' "$C_OK$C_B" "$C_0"
        printf '  รุ่น             %s (%s) → %s (%s)\n' "${RESTORE_VERSION:-?}" "$RESTORE_SHORT" "${new_version:-?}" "$new_short"
        printf '  commit ใหม่      %s commit\n' "$count"
        if [ "$PENDING_LOADED" = 1 ]; then printf '                  (ต่อจากการอัปเดตรอบก่อนที่ยังไม่จบ — จบครบแล้ว)\n'; fi
    fi
    printf '  ไฟล์สำรอง        %s\n' "${BACKUP_FILE:-ไม่ได้สำรอง (SKIP_BACKUP=1)}"
    if [ "$PENDING_LOADED" = 1 ] && [ -n "$RESTORE_BACKUP" ] && [ "$RESTORE_BACKUP" != "$BACKUP_FILE" ]; then
        printf '  สำรองก่อนอัปเดต   %s\n' "$RESTORE_BACKUP"
    fi
    printf '  migration       %s\n' "$mig"
    printf '  PHP-FPM         %s\n' "${FPM_STATUS:-?}"
    printf '  /health         %s\n' "${HEALTH_STATUS:-?}"
    printf '  log             %s\n' "$LOG_FILE"
    if [ "$WARNINGS" -gt 0 ]; then printf '  %s⚠ มีคำเตือน %s ข้อ — ดูด้านบน%s\n' "$C_WARN" "$WARNINGS" "$C_0"; fi
    if [ "$CODE_CHANGED" = 1 ]; then
        printf '\nกลุ่ม Telegram จะได้ข้อความ "🟢 ระบบเริ่มทำงานแล้ว · อัปเดตเป็นรุ่น …" (ถ้าตั้งไว้) · ดูรุ่นในหน้า ตั้งค่าแจ้งเตือน → เวอร์ชันระบบ\n'
        if [ "$NEW_COUNT" = 0 ] && [ "$PENDING_LOADED" != 1 ]; then
            printf 'ถอยกลับรุ่นเดิมถ้าจำเป็น: DEPLOY.md ข้อ 6 (ไฟล์สำรองด้านบน + commit ก่อน git pull ดูจาก: git -C %s reflog -n 5)\n' "$APP_DIR"
        else
            printf 'ถอยกลับรุ่นเดิมถ้าจำเป็น: DEPLOY.md ข้อ 6 (ไฟล์สำรองก่อนอัปเดต + git reset --hard %s)\n' "$RESTORE_SHORT"
        fi
    else
        printf '\napp:install ส่ง "🟢 ระบบเริ่มทำงานแล้ว" เข้ากลุ่ม Telegram (ถ้าตั้งไว้) — มาจากการรันครั้งนี้ ไม่ใช่ระบบล่ม\n'
    fi
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
    printf '%sPayNest — อัปเดตระบบ (%s)%s%s\n' "$C_B" "$SCRIPT_NAME" "$mode_note" "$C_0"
    printf 'โฟลเดอร์: %s · %s\n' "$APP_DIR" "$(date '+%Y-%m-%d %H:%M:%S %Z')"
    if [ -n "$LOG_FILE" ]; then printf 'log: %s\n' "$LOG_FILE"; fi

    TMPD=$(mktemp -d "${TMPDIR:-/tmp}/paynest-update.XXXXXX")
    write_db_tool
    if [ -n "$APP_URL" ]; then
        case $APP_URL in http://?* | https://?*) ;; *) fail "APP_URL ต้องขึ้นต้นด้วย https:// หรือ http://" ;; esac
        while [ "${APP_URL%/}" != "$APP_URL" ]; do APP_URL=${APP_URL%/}; done
    fi

    preflight
    step_dirty_check
    step_record_old
    step_backup
    step_fetch
    step_composer
    step_ownership
    step_app_install
    step_reload_fpm
    step_health
    step_summary
    exit 0 # ต้อง exit เอง — bash 3.2 ไม่รัน trap EXIT ของ subshell ใน pipeline ถ้าฟังก์ชันแค่ return
}

# ─── เริ่ม ───────────────────────────────────────────────────────────────────

DRY_RUN=${DRY_RUN:-0}
parse_args "$@"
if is_true "$DRY_RUN"; then DRY_RUN=1; else DRY_RUN=0; fi
BRANCH=${BRANCH:-}
REMOTE=${REMOTE:-origin}
SKIP_BACKUP=${SKIP_BACKUP:-0}
APP_URL=${APP_URL:-}
RELOAD_FPM=${RELOAD_FPM:-auto}
case $RELOAD_FPM in
    auto | 0 | 1 | yes | no | true | false) ;;
    *) die_usage "RELOAD_FPM=$RELOAD_FPM ไม่รู้จัก — ใช้ auto / 0 / 1" ;;
esac
WEB_USER=${WEB_USER:-}
PHP_BIN=${PHP_BIN:-}
COMPOSER_BIN=${COMPOSER_BIN:-}
NEW_COUNT=0
CODE_CHANGED=0
BACKUP_FILE=''
BACKUP_PLAIN=''
PENDING_FILE=''
SITE_PHP=''
# รหัสผ่านฐานข้อมูลอ่านจาก .env เอง — ค่าที่ติดมากับสภาพแวดล้อม (export ไว้ตอน deploy) ไม่ส่งต่อให้ composer/php
unset DB_PASS DB_ROOT_PASS
export GIT_PAGER=cat
LOG_FILE=''
APP_DIR=$(resolve_app_dir)
cd "$APP_DIR"
setup_colors
trap '' HUP # SSH หลุดกลางทาง = ทำต่อจนจบ — สืบทอดถึง composer/php ด้วย

if [ "$DRY_RUN" = 1 ]; then
    main
    exit 0
fi

# เก็บ log (ตัดสีออก) — writable/logs/update-<วันเวลา>.log · 640 · รันด้วย root = ผู้ใช้เว็บเป็นเจ้าของ
open_log
set +e; main 2>&1 | log_tee; _rc=${PIPESTATUS[0]}; exit "$_rc"
