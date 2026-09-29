import { viewState } from './viewState.js';

/**
 * ปุ่มคัดลอกข้อความ — ร้านโอนจากมือถือ กดค้างเพื่อเลือกตัวเลขบนจอเล็กยากและพลาดง่าย
 * clipboard API ใช้ได้เฉพาะ https/localhost — ใช้ไม่ได้ก็ถอยไปวิธีเก่า
 */
export function copyButton(text, label = '📋 คัดลอก', { iconOnly = false, toastText } = {}) {
  const button = el('button', {
    type: 'button',
    class: iconOnly ? 'copy-icon' : 'btn ghost sm',
    // ปุ่มไอคอนล้วนต้องมีชื่อให้ screen reader และคำอธิบายตอนชี้ค้าง
    'aria-label': iconOnly ? label.replace(/^📋\s*/, '') : undefined,
    title: iconOnly ? label.replace(/^📋\s*/, '') : undefined,
    onclick: async () => {
      await writeClipboard(String(text));
      // toastText: ข้อความยาว/ลับ (ลิงก์เข้าระบบของร้าน) ไม่ต้องโชว์ซ้ำทั้งก้อนในแถบแจ้ง
      toast(toastText ?? `คัดลอกแล้ว: ${text}`, 'success');
      // ปุ่มไอคอน: เปลี่ยนเป็นเครื่องหมายถูกครู่หนึ่ง ให้เห็นว่ากดติดแล้วตรงนั้นเลย
      if (iconOnly) {
        button.classList.add('done');
        button.replaceChildren(icon('check'));
        setTimeout(() => { button.classList.remove('done'); button.replaceChildren(icon('clipboard-copy')); }, 1500);
      }
    },
  }, iconOnly ? icon('clipboard-copy') : label);
  return button;
}

/** คืน true เมื่อคัดลอกได้จริง — ถอยไปวิธีเก่าเมื่อ clipboard API ใช้ไม่ได้ (http ที่ไม่ใช่ localhost) */
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

/**
 * คัดลอกแล้วบอกผลด้วยข้อความที่กำหนด (ไม่โชว์เนื้อหาที่คัดลอก — อาจมีรหัสผ่านอยู่ข้างใน)
 * ต้องเรียกตรง ๆ ในจังหวะที่ผู้ใช้กด: Safari ไม่ยอมให้คัดลอกหลังรอ API แล้ว จึงต้องโหลดข้อมูลไว้ก่อน
 */
export async function copyText(text, doneMessage = 'คัดลอกแล้ว') {
  const ok = await writeClipboard(String(text));
  if (ok) toast(doneMessage, 'success');
  else toast('คัดลอกไม่ได้ — กดค้างที่ข้อความเพื่อเลือกแล้วคัดลอกเอง', 'error');
  return ok;
}

/*
 * ไอคอน SVG ชุดเดียวทั้งระบบ (public/icons.svg — สร้างด้วย tools/build-icons.mjs)
 * เดิมใช้ emoji ซึ่งแต่ละเครื่องวาดไม่เหมือนกัน และ screen reader อ่านออกเสียง
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
export function icon(name, { className = 'icon' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `/icons.svg#i-${name}`);
  svg.append(use);
  return svg;
}

/*
 * emoji เดิมที่ส่งเข้ามาตาม view ต่าง ๆ → ไอคอนชุดเดียวกัน
 * แปลงที่จุดเดียวแทนการไล่แก้ทุกที่ที่เรียก stat()/เมนู — emoji ที่ไม่มีคู่ก็ยังแสดงเหมือนเดิม
 */
const EMOJI_ICON = {
  '📊': 'layout-dashboard', '🎯': 'target', '📦': 'package', '🏪': 'store', '🤝': 'handshake',
  '🧾': 'receipt', '💰': 'wallet', '🏷': 'tag', '🏦': 'landmark', '📒': 'notebook-text', '📈': 'trending-up',
  '⚙': 'settings', '⏏': 'log-out', '☰': 'menu', '🛒': 'shopping-cart', '⏳': 'hourglass', '✓': 'circle-check',
  '👀': 'eye', '👁': 'eye', '📝': 'file-pen-line', '⭐': 'star', '↩': 'undo-2', '⏰': 'alarm-clock', '🙋': 'user',
  '➕': 'plus', '💳': 'credit-card', '📨': 'send', '📱': 'smartphone', '🔑': 'key-round', '🔐': 'lock', '🔓': 'lock-open',
  '🔔': 'bell', '🌙': 'moon', '🕗': 'clock', '🛡': 'shield-check',
  '🏠': 'house', '📣': 'megaphone', '📅': 'calendar', '📌': 'pin', '🎉': 'party-popper', '📖': 'book-open',
};
export const iconFor = (emoji) => {
  const name = EMOJI_ICON[String(emoji ?? '').replace(/\uFE0F/g, '').trim()];
  return name ? icon(name) : emoji;
};

/** ตัวช่วยสร้าง DOM: el('div', {class:'x'}, 'ข้อความ', el('span', {}, '...')) */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') node.value = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const clear = (node) => { node.replaceChildren(); return node; };

const moneyFmt = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat('th-TH');

// ทศนิยมทั้งระบบไม่เกิน 2 ตำแหน่ง — เงินตรึง 2 ตำแหน่ง ส่วน % ตัดศูนย์ท้ายทิ้ง (12.50 -> 12.5)
const pctFmt = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });

export const money = (n) => moneyFmt.format(Number(n ?? 0));
export const int = (n) => intFmt.format(Number(n ?? 0));
export const pct = (n) => (n === null || n === undefined ? '—' : `${pctFmt.format(Number(n))}%`);

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/*
 * ในระบบมีสองชนิดปนกัน ต้องแยกให้ออก ไม่งั้นวันที่เพี้ยนไปหนึ่งวัน
 *
 *   'YYYY-MM-DD'            = วันล้วนที่คนกรอกเอง (วันที่โอน, ครบกำหนด) — เป็นวันไทยอยู่แล้ว ห้ามขยับ
 *   'YYYY-MM-DD HH:MM:SS'   = เวลาที่ระบบประทับด้วย datetime('now') ซึ่งเป็น UTC — ต้องบวกเป็นเวลาไทยก่อน
 *
 * เดิมตัดเอา 10 ตัวแรกทั้งคู่ เวลา UTC ตั้งแต่ 17:00 เป็นต้นไป (เที่ยงคืนบ้านเรา)
 * จึงโชว์เป็นวันของเมื่อวาน — บิลที่ออกตอนตีหนึ่งจะขึ้นว่าออกเมื่อวาน
 */
const THAI_DATE_PARTS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' });

/** เวลาที่ระบบประทับเป็น UTC — บอก JS ให้ชัดด้วย Z ไม่งั้นมันเดาเป็นเวลาเครื่อง */
export const utcToThai = (stamp) => THAI_DATE_PARTS.format(new Date(`${stamp.replace(' ', 'T')}Z`));

/** วันที่แบบไทย "5 ก.ย. 69" (ปี พ.ศ.) — รับทั้ง YYYY-MM-DD และเวลาประทับ UTC ของระบบ */
export function dateTh(iso) {
  if (!iso) return '—';
  const dayOnly = iso.length > 10 ? utcToThai(iso) : iso.slice(0, 10);
  const [y, m, d] = dayOnly.split('-').map(Number);
  return `${d} ${THAI_MONTHS[m - 1]} ${String((y + 543) % 100).padStart(2, '0')}`;
}

/** วันและเวลาไทย "5 ก.ย. 69 14:32 น." — สำหรับเวลาที่ระบบประทับ (UTC) */
export function dateTimeTh(stamp) {
  if (!stamp) return '—';
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(`${stamp.replace(' ', 'T')}Z`));
  return `${dateTh(stamp)} ${time} น.`;
}

export function monthTh(key) {
  const [y, m] = String(key).split('-').map(Number);
  return `${THAI_MONTHS[m - 1]} ${String((y + 543) % 100).padStart(2, '0')}`;
}

export function toast(message, type = 'info') {
  const node = el('div', { class: `toast ${type}` }, message);
  document.getElementById('toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 250);
  }, type === 'error' ? 5200 : 2800);
}

const BADGES = {
  ACTIVE: 'green', SUSPENDED: 'amber', CLOSED: 'gray', ARCHIVED: 'gray', DISABLED: 'gray',
  DRAFT: 'blue', SUBMITTED: 'blue', APPROVED: 'blue', INVOICED: 'green',
  OPEN: 'amber', PARTIAL: 'blue', PAID: 'green', VOID: 'red', LOCKED: 'gray',
};
const LABELS = {
  // ARCHIVED ใช้ร่วมกันทั้งสินค้าและรายการค่าใช้จ่าย — เจ้าของระบบเรียกว่า "ปิดใช้งาน" (ลบไม่ได้ เปิดกลับได้)
  ACTIVE: 'ใช้งาน', SUSPENDED: 'ระงับ', CLOSED: 'ปิด', ARCHIVED: 'ปิดใช้งาน', DISABLED: 'ปิดใช้งาน',
  // ยอดที่บันทึกแล้วพร้อมเรียกเก็บทันที — สามสถานะแรกจึงสื่อความหมายเดียวกันกับผู้ใช้
  // (SUBMITTED/APPROVED เหลือไว้รองรับข้อมูลเก่าที่บันทึกตอนยังมีขั้นอนุมัติ)
  DRAFT: 'บันทึกแล้ว', SUBMITTED: 'บันทึกแล้ว', APPROVED: 'บันทึกแล้ว', INVOICED: 'ออกบิลแล้ว',
  OPEN: 'ค้างชำระ', PARTIAL: 'ชำระบางส่วน', PAID: 'ชำระครบ', VOID: 'ยกเลิก', LOCKED: 'ปิดรอบ',
};

export const badge = (status) => el('span', { class: `badge ${BADGES[status] ?? 'gray'}` }, LABELS[status] ?? status);

/*
 * สถานะของการแจ้งชำระ (สลิป) — คนละเรื่องกับสถานะบิล
 * เดิมยืมป้ายของบิลมาใช้: ถูกปฏิเสธขึ้น "ยกเลิก" และอนุมัติงวดเดียวขึ้น "ชำระครบ"
 * ร้านจึงเข้าใจว่าจ่ายครบแล้วทั้งที่ยังค้าง หรือไม่รู้ว่าสลิปโดนตีกลับ
 */
const SLIP_BADGES = {
  PENDING: ['amber', 'รอตรวจสอบ'],
  APPROVED: ['green', 'ได้รับเงินแล้ว'],
  REJECTED: ['red', 'ถูกปฏิเสธ'],
  CANCELLED: ['gray', 'ยกเลิกแล้ว'],
};
/*
 * สถานะค่าคอมของเซล — เดิมยืมป้ายของบิล ("ค้างชำระ"/"ชำระครบ") ซึ่งเป็นภาษาของคนที่เป็นหนี้
 * เซลคือคนรอรับเงิน ส่วนกลางคือคนจ่าย จึงใช้คำคนละชุดตามมุมคนดู
 */
export const commBadge = (status, { forAgent = false } = {}) => {
  const [tone, label] = {
    PENDING: ['amber', forAgent ? 'รอรับ' : 'ยังไม่จ่าย'],
    PAID: ['green', forAgent ? 'ได้รับแล้ว' : 'จ่ายแล้ว'],
    VOID: ['gray', 'ยกเลิก'],
  }[status] ?? ['gray', status];
  return el('span', { class: `badge ${tone}` }, label);
};

export const slipBadge = (status) => {
  const [tone, label] = SLIP_BADGES[status] ?? ['gray', status];
  return el('span', { class: `badge ${tone}` }, label);
};

export function field(label, input, hint) {
  return el('div', { class: 'field' },
    el('label', {}, label),
    input,
    hint && el('span', { class: 'hint' }, hint));
}

export function input(props = {}) {
  return el('input', { type: 'text', ...props });
}

export function select(options, props = {}) {
  const node = el('select', props,
    ...options.map((o) => el('option', { value: o.value, selected: o.value === props.value }, o.label)));
  if (props.value !== undefined) node.value = props.value;
  return node;
}

export function card(title, bodyNode, { actions, tight } = {}) {
  return el('div', { class: 'card' },
    title && el('div', { class: 'card-head' }, el('h2', {}, title), actions && el('div', { class: 'btn-row' }, actions)),
    el('div', { class: `card-body${tight ? ' tight' : ''}` }, bodyNode));
}

/** ดึงข้อความที่มองเห็นจริงออกจากเซลล์ เพื่อใช้ค้นหา/เรียงลำดับ */
function cellText(column, row) {
  if (column.sortValue) return column.sortValue(row);
  if (column.key) return row[column.key];
  const rendered = column.render?.(row);
  if (rendered instanceof Node) return rendered.textContent ?? '';
  return rendered ?? '';
}

// ตัวเลขที่คนกรอก/ระบบแสดง เช่น "1,250.50", "12.5%", "-300" — ต้องเป็นตัวเลขทั้งก้อนเท่านั้น
// ไม่งั้น "BEAN-1KG" จะถูกนับเป็นเลข -1 แล้วลำดับเพี้ยน
const NUMERIC_RE = /^-?[\d,]+(\.\d+)?%?$/;

function numericValue(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw ?? '').trim().replace(/[฿\s]/g, '');
  if (!s || !NUMERIC_RE.test(s)) return null;
  const n = Number(s.replace(/[,%]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '' || String(v).trim() === '—';

/**
 * เรียงตัวเลขแบบตัวเลข เรียงข้อความแบบไทย — ค่าว่างไปท้ายแถวเสมอไม่ว่าจะเรียงทางไหน
 *
 * ตัดสินว่าคอลัมน์นี้เป็น "ตัวเลข" หรือไม่ทีเดียวจากทุกแถว ไม่ใช่ตัดสินทีละคู่
 * เพราะถ้าบางคู่เทียบแบบเลขบางคู่เทียบแบบข้อความ ผลเรียงจะมั่วทันที
 */
function compareBy(column, dir, rows) {
  // คิดค่าของแต่ละแถวครั้งเดียว — cellText อาจต้องวาดเซลล์ใหม่ทั้งเซลล์ เรียกซ้ำในทุกการเทียบจะช้ามาก
  const valueOf = new Map(rows.map((r) => [r, cellText(column, r)]));
  const filled = [...valueOf.values()].filter((v) => !isBlank(v));
  const numericColumn = filled.length > 0 && filled.every((v) => numericValue(v) !== null);

  return (a, b) => {
    const av = valueOf.get(a);
    const bv = valueOf.get(b);
    if (isBlank(av) || isBlank(bv)) {
      if (isBlank(av) && isBlank(bv)) return 0;
      return isBlank(av) ? 1 : -1; // ค่าว่างลงท้ายเสมอ ไม่กลับด้านตาม dir
    }
    const result = numericColumn
      ? numericValue(av) - numericValue(bv)
      : String(av).localeCompare(String(bv), 'th', { numeric: true });
    return dir === 'asc' ? result : -result;
  };
}

/**
 * ตาราง — columns: [{ key, label, num, render(row), sortValue(row), sortable:false }]
 * options:
 *   footer     อาเรย์ของเซลล์สรุปท้ายตาราง
 *   rowClass   ฟังก์ชันคืนคลาสของแถว ใช้เน้นแถวที่ผิดปกติ
 *   sortable   กดหัวคอลัมน์เพื่อเรียงลำดับ (ค่าเริ่มต้น: เปิดเมื่อมีตั้งแต่ 3 แถวขึ้นไป)
 *   search     ช่องค้นหาเหนือตาราง — ใส่ข้อความ placeholder ที่อยากได้ หรือ true
 *
 * การเรียง/ค้นหาทำในเบราว์เซอร์ล้วน ๆ ไม่ยิง API ซ้ำ จึงตอบสนองทันที
 */
/*
 * ลำดับตารางในหน้า — ใช้เป็นกุญแจจำการเรียง/คำค้นของแต่ละตาราง
 * app.js เรียก beginRender() ทุกครั้งที่วาดหน้า ตารางลำดับเดิมจึงได้กุญแจเดิม
 */
let tableSeq = 0;
export function beginRender() { tableSeq = 0; }

/**
 * ช่องว่างที่บอกว่า "ต่อไปทำอะไร" — ไอคอนจาง ๆ + ข้อความ + ปุ่มพาไปทำ
 * รับข้อความเฉย ๆ ก็ได้ (ใช้ไอคอนกล่องว่าง) หรือ { icon, title, detail, action: { label, onClick | href } }
 */
export function emptyState(spec) {
  const s = typeof spec === 'string' || spec instanceof Node ? { title: spec } : spec;
  const action = s.action
    ? (s.action.href
      ? el('a', { class: 'btn sm', href: s.action.href }, s.action.label)
      : el('button', { class: 'btn sm', onclick: s.action.onClick }, s.action.label))
    : '';
  return el('div', { class: 'empty' },
    s.icon ? iconFor(s.icon) : icon('inbox'),
    el('div', {}, s.title),
    s.detail ? el('div', { class: 'sub-line' }, s.detail) : '',
    action);
}

export function table(columns, rows, { empty = 'ยังไม่มีข้อมูล', footer, sortable, search, rowClass, rowKey, expand } = {}) {
  // นับก่อน return เสมอ — ตารางว่างก็ต้องกินลำดับ ไม่งั้นตารางถัดไปได้กุญแจของคนอื่น
  const stateKey = `table:${tableSeq++}:${columns.map((c) => (typeof c.label === 'string' ? c.label : '')).join('|')}`;
  if (!rows.length) return emptyState(empty);

  const canSort = sortable ?? rows.length >= 3;
  const wrap = el('div', {});
  /*
   * การเรียงและคำค้นอยู่รอดการวาดหน้าใหม่ (บันทึกแถว/สลับแท็บ) — เดิมหายทุกครั้ง
   * เก็บใน viewState จึงล้างเองเมื่อย้ายไปหน้าอื่น
   */
  let saved = {};
  try { saved = JSON.parse(viewState.getItem(stateKey) ?? '{}'); } catch { /* ค่าเสีย — เริ่มใหม่ */ }
  let sortIndex = Number.isInteger(saved.sortIndex) && saved.sortIndex < columns.length ? saved.sortIndex : null;
  let sortDir = saved.sortDir === 'desc' ? 'desc' : 'asc';
  let keyword = typeof saved.keyword === 'string' ? saved.keyword : '';
  const remember = () => viewState.setItem(stateKey, JSON.stringify({ sortIndex, sortDir, keyword }));

  // ข้อความของแถวไว้ค้นหา — คิดครั้งเดียวต่อแถว (เดิมสร้าง DOM ทุกเซลล์ใหม่ทุกครั้งที่กดแป้น)
  const textCache = new Map();
  const rowText = (row) => {
    if (!textCache.has(row)) textCache.set(row, columns.map((c) => String(cellText(c, row))).join(' ').toLowerCase());
    return textCache.get(row);
  };
  let searchTimer = null;

  // ติด data-label ไว้ให้ทุกเซลล์ เพื่อให้จอมือถือพลิกตารางเป็นการ์ดแล้วยังรู้ว่าตัวเลขคืออะไร
  const cell = (c, content) => el('td', {
    class: c.num ? 'num' : '',
    'data-label': typeof c.label === 'string' ? c.label : '',
  }, content);

  const searchBox = search
    ? el('div', { class: 'table-tools' },
      el('span', { class: 'search-ico' }, '🔍'),
      el('input', {
        type: 'search',
        placeholder: typeof search === 'string' ? search : 'ค้นหาในตาราง…',
        value: keyword,
        oninput: (e) => {
          clearTimeout(searchTimer);
          const next = e.target.value.trim().toLowerCase();
          searchTimer = setTimeout(() => { keyword = next; remember(); draw(); }, 120);
        },
      }),
      el('span', { class: 'table-count' }))
    : null;

  const head = el('thead', {}, el('tr', {}, ...columns.map((c, i) => {
    const allowed = canSort && c.sortable !== false && (c.key || c.render || c.sortValue) && c.label;
    return el('th', {
      class: `${c.num ? 'num' : ''}${allowed ? ' sortable' : ''}`,
      onclick: allowed
        ? () => {
          sortDir = sortIndex === i && sortDir === 'asc' ? 'desc' : 'asc';
          sortIndex = i;
          remember();
          draw();
        }
        : undefined,
    }, c.label, allowed && el('span', { class: 'sort-ico' }, '↕'));
  })));

  const body = el('tbody', {});
  const foot = footer ? el('tfoot', {}, el('tr', {}, ...footer.map((c, i) => cell(columns[i] ?? {}, c)))) : null;

  function draw() {
    let visible = rows;
    if (keyword) {
      visible = rows.filter((r) => rowText(r).includes(keyword));
    }
    if (sortIndex !== null) visible = [...visible].sort(compareBy(columns[sortIndex], sortDir, visible));

    head.querySelectorAll('th').forEach((th, i) => {
      th.classList.toggle('sorted', i === sortIndex);
      const ico = th.querySelector('.sort-ico');
      if (ico) ico.textContent = i === sortIndex ? (sortDir === 'asc' ? '↑' : '↓') : '↕';
    });

    if (searchBox) {
      searchBox.querySelector('.table-count').textContent =
        keyword ? `เจอ ${visible.length} จาก ${rows.length} แถว` : `${rows.length} แถว`;
    }
    // ซ่อนแถวสรุปตอนกำลังค้นหา เพราะยอดรวมจะไม่ตรงกับแถวที่เห็น
    if (foot) foot.style.display = keyword ? 'none' : '';

    /*
     * rowClass(row) ใช้เน้นแถวที่ต้องรีบจัดการ เช่นบิลที่เลยกำหนดชำระ
     * rowKey(row)   ติด data-row-key ไว้ให้ flashRows พาผู้ใช้มาหาแถวที่เจาะจงได้
     * expand(row)   คืน node = กางรายละเอียดเป็นแถวเต็มความกว้างต่อท้ายแถวนั้นเลย
     *               (วางไว้ใต้ตารางแทนจะทำให้ต้องเลื่อนจอไปหา แล้วลืมว่ากางของแถวไหนอยู่)
     */
    clear(body).append(...visible.flatMap((row) => {
      const tr = el('tr', {
        class: rowClass?.(row) || '',
        'data-row-key': rowKey ? String(rowKey(row)) : undefined,
      }, ...columns.map((c) => cell(c, c.render ? c.render(row) : row[c.key])));

      const panel = expand?.(row);
      if (!panel) return [tr];

      tr.classList.add('row-open');
      return [tr, el('tr', { class: 'row-expanded' },
        el('td', { colspan: columns.length }, panel))];
    }));

    if (!visible.length) {
      body.append(el('tr', {}, el('td', { colspan: columns.length },
        el('div', { class: 'empty' }, `ไม่พบแถวที่ตรงกับ "${keyword}"`))));
    }
  }

  draw();
  wrap.append(
    searchBox ?? '',
    el('div', { class: 'table-scroll' }, el('table', {}, head, body, foot ?? '')));
  return wrap;
}

/**
 * การ์ดตัวเลขสรุป
 * tone ใช้สื่อความหมายด้วยสี: sales(ยอดขาย) · income(เงินที่ได้) · due(ค้างจ่าย) · warn(ต้องจัดการ) · muted
 */
/**
 * แถบเตือนที่กดได้ — กดแล้วพาไปยังรายการที่มันเตือนถึงทันที
 *
 * เตือนแล้วปล่อยให้ผู้ใช้ไปหาเองว่ารายการอยู่ไหนคือการผลักงานกลับไปให้คน
 * ทำเป็น <button> จริงเพื่อให้กด Tab/Enter ได้ ไม่ใช่ div ที่แปะ onclick เฉย ๆ
 *
 * tone: 'danger' = ต้องรีบจัดการ (แดง), 'warn' = รู้ไว้ (ส้ม)
 */
export function alertBanner({ tone = 'danger', title, detail, actionLabel, onClick, compact = false }) {
  return el('button', {
    type: 'button',
    // compact = บรรทัดเดียว ใช้ตอนมีหลายแถบพร้อมกันจะได้ไม่กินที่จนดันตารางตกจอ
    class: [tone === 'warn' ? 'notice-box' : 'alert-box', onClick ? 'banner-link' : '', compact ? 'compact' : '']
      .filter(Boolean).join(' '),
    // รายละเอียดที่ตัดออกตอน compact ยังอ่านได้จากการชี้ค้าง
    title: compact && detail ? detail : undefined,
    onclick: onClick,
  },
  el('div', { class: 'banner-text' },
    el('strong', {}, title),
    detail && !compact ? el('div', {}, detail) : ''),
  onClick ? el('span', { class: 'banner-go' }, `${actionLabel ?? 'ดูรายการ'} →`) : '');
}

/**
 * เลื่อนจอไปหาแถวที่ต้องดู แล้วกะพริบให้เห็นว่าอันไหน
 *
 * เรียกหลัง render() เสร็จ — ใช้ requestAnimationFrame สองชั้นเพราะชั้นเดียว
 * ยังเจอ DOM ก่อนที่ layout จะเสร็จ ทำให้ scrollIntoView คำนวณตำแหน่งผิด
 */
export function flashRows(selector, { max = 12 } = {}) {
  const run = () => {
    const rows = [...document.querySelectorAll(selector)].slice(0, max);
    if (!rows.length) return;
    rows[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    for (const row of rows) {
      row.classList.remove('row-flash');
      // บังคับให้เบราว์เซอร์คำนวณ style ใหม่ ไม่งั้นการถอด-ใส่คลาสในเฟรมเดียวจะไม่รีสตาร์ต animation
      void row.offsetWidth;
      row.classList.add('row-flash');
      row.addEventListener('animationend', () => row.classList.remove('row-flash'), { once: true });
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
}

/**
 * แถบเลือกรอบบิลประจำหน้า — วางบนหัวหน้าเสมอ
 *
 * ทุกตัวเลขในหน้าเป็นข้อมูลของรอบที่เลือกอยู่ ตัวเลือกนี้จึงไม่ใช่ "ตัวกรองหนึ่งในหลายตัว"
 * แต่เป็นตัวกำหนดขอบเขตของทั้งหน้า ต้องเด่นและอยู่คนละที่กับช่องกรองย่อย
 */
export function periodBar(selectNode, { label = 'รอบบิล', extra } = {}) {
  return el('div', { class: 'period-bar' },
    el('span', { class: 'period-label' }, `📅 ${label}`),
    selectNode,
    // ช่องต่อท้ายสำหรับของที่เป็นสมบัติของรอบเอง เช่นอัตราแลกเปลี่ยน
    extra ?? '');
}

export function stat(label, value, sub, { tone = 'muted', icon } = {}) {
  return el('div', { class: `stat tone-${tone}` },
    el('div', { class: 'label' }, icon && el('span', { class: 'stat-ico' }, iconFor(icon)), label),
    el('div', { class: 'value' }, value),
    sub && el('div', { class: 'sub' }, sub));
}

/** แสดงส่วนต่างพร้อมลูกศรขึ้น/ลง */
export function delta(amount, growthPct) {
  const up = Number(amount) >= 0;
  const growth = growthPct === null || growthPct === undefined ? '' : ` (${up ? '+' : ''}${pct(growthPct)})`;
  return el('span', { class: `delta ${up ? 'up' : 'down'}` }, `${up ? '▲' : '▼'} ${money(Math.abs(amount))}${growth}`);
}

/**
 * รายชื่อไฟล์ที่เลือกในช่องแนบหลายไฟล์ + รูปย่อ — ให้เห็นก่อนกดยืนยันว่าเลือกถูกไฟล์
 * รูปย่อใช้ object URL ของไฟล์ในเครื่อง (ยังไม่ได้อัปโหลด) ต้องคืนหน่วยความจำเองเมื่อเลือกใหม่/ปิดฟอร์ม
 */
function fileListPreview(inputNode, { max } = {}) {
  const list = el('div', { class: 'file-list' });
  let urls = [];
  const release = () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; };
  const paint = () => {
    release();
    const files = [...(inputNode.files ?? [])];
    list.replaceChildren(...files.map((file) => {
      const isImage = /^image\/(jpeg|png|gif|webp)$/i.test(file.type);
      let thumb = el('span', { class: 'file-chip-ico' }, file.type === 'application/pdf' ? '📄' : '🖼');
      if (isImage) {
        const url = URL.createObjectURL(file);
        urls.push(url);
        thumb = el('img', { src: url, alt: '' });
        // รูปที่เบราว์เซอร์นี้เปิดไม่ได้ (เช่น HEIC บนคอม) — โชว์ไอคอนแทนรูปแตก
        thumb.addEventListener('error', () => thumb.replaceWith(el('span', { class: 'file-chip-ico' }, '🖼')), { once: true });
      }
      return el('span', { class: 'file-chip', title: file.name }, thumb, el('span', { class: 'file-chip-name' }, file.name));
    }),
    max && files.length > max
      ? el('span', { class: 'hint text-danger' }, `เลือกได้สูงสุด ${max} ไฟล์ — ตอนนี้เลือกไว้ ${files.length}`)
      : '');
  };
  inputNode.addEventListener('change', paint);
  return { list, release };
}

/**
 * โมดัลฟอร์ม — fields: [{ name, label, type, options, value, hint, required }]
 * onSubmit(values) คืน promise; throw เพื่อให้โมดัลค้างไว้พร้อมข้อความผิดพลาด
 * width: ความกว้างสูงสุด (px) — ฟอร์มที่มีตารางแก้ได้หลายคอลัมน์ (เช่นออกบิล) แคบ 520px ไม่พอ
 * ช่อง type 'file' + multiple: true → ค่าเป็นอาเรย์ของ File (ไม่ได้เลือก = undefined) · max = จำนวนไฟล์ที่เตือน
 */
export function formModal({ title, fields, submitLabel = 'บันทึก', onSubmit, preview, onClose, width }) {
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const inputs = {};
  const fileLists = [];

  const rows = {};
  // label เป็นฟังก์ชันได้ เพื่อให้เปลี่ยนตามค่าช่องอื่น (เช่น เลือก % แล้วหัวข้อเปลี่ยนเป็น "% ของส่วนต่าง")
  const labelOf = (f, values = {}) => (typeof f.label === 'function' ? f.label(values) : f.label);

  // options เป็นฟังก์ชันได้ เพื่อให้ตัวเลือกเปลี่ยนตามค่าช่องอื่น
  // (เช่นเลือกรอบบิลแล้ว ร้านที่ออกบิลรอบนั้นไปแล้วต้องหายจากลิสต์)
  const optionsOf = (f, values = {}) => (typeof f.options === 'function' ? f.options(values) : f.options);

  /*
   * ค่าตั้งต้นของทุกช่อง ใช้ตอนวาดรอบแรกเท่านั้น (ยังอ่านจาก DOM ไม่ได้ เพราะยังไม่มี DOM)
   * ถ้าไม่ส่งให้ options() ช่องที่กรองตามค่าช่องอื่นจะวาดลิสต์ผิดในรอบแรก
   * แล้วค่าที่ตั้งไว้จะหลุดไปเป็นตัวเลือกแรกของลิสต์ผิด ๆ นั้น
   */
  const initialValues = Object.fromEntries(
    fields.filter((f) => f.value !== undefined).map((f) => [f.name, f.value]),
  );

  const body = el('div', { class: 'form-grid' }, ...fields.map((f) => {
    // select ที่ไม่ได้กำหนดค่าเริ่มต้น ปล่อยให้เบราว์เซอร์เลือกตัวเลือกแรกเอง
    // (ถ้าบังคับเป็น '' ช่องจะโชว์ว่างทั้งที่มีตัวเลือกอยู่)
    /*
     * checklist = กลุ่มติ๊กหลายข้อ เก็บค่าเป็นอาเรย์ของคีย์ที่ติ๊กไว้
     * ทำเป็น type ของตัวเองเพราะ <input type=checkbox> หลายตัวต้องรวบเป็นค่าเดียว
     */
    if (f.type === 'checklist') {
      const boxes = new Map();
      const chosen = new Set(f.value ?? []);
      const group = el('div', { class: 'checklist' },
        ...optionsOf(f, initialValues).map((o) => {
          const box = el('input', { type: 'checkbox', checked: chosen.has(o.value) });
          boxes.set(o.value, box);
          return el('label', { class: 'check-item' },
            box,
            el('div', {},
              el('strong', {}, o.label),
              o.hint ? el('div', { class: 'sub-line' }, o.hint) : ''));
        }));
      // ให้ collect() อ่านค่าผ่าน .value ได้เหมือนช่องอื่น ไม่ต้องแยกเคสเพิ่ม
      Object.defineProperty(group, 'value', {
        get: () => [...boxes].filter(([, box]) => box.checked).map(([key]) => key),
      });
      inputs[f.name] = group;
      rows[f.name] = field(labelOf(f) + (f.required ? ' *' : ''), group, f.hint);
      return rows[f.name];
    }

    const node = f.type === 'select'
      ? select(optionsOf(f, initialValues), f.value === undefined ? {} : { value: f.value })
      : f.type === 'file'
        // ช่องแนบไฟล์ไม่ตั้งค่า value ได้ (เบราว์เซอร์ห้าม) จึงไม่ส่ง value เข้าไป
        ? el('input', { type: 'file', accept: f.accept ?? 'image/*', multiple: f.multiple ? true : undefined })
        : f.type === 'textarea'
          ? el('textarea', { rows: f.rows ?? 5, maxlength: f.maxlength, placeholder: f.placeholder ?? '' }, f.value ?? '')
          : el('input', { type: f.type ?? 'text', value: f.value ?? '', step: f.step, maxlength: f.maxlength, placeholder: f.placeholder ?? '' });
    // ช่องที่แก้ไม่ได้ในบริบทนั้น — ยังโชว์ค่าให้เห็น แต่กดเปลี่ยนไม่ได้
    // collect() ยังอ่านค่าเดิมส่งไป ฝั่งเซิร์ฟเวอร์เห็นค่าเท่าเดิมจึงไม่นับเป็นการแก้
    if (f.disabled) node.disabled = true;
    inputs[f.name] = node;
    if (f.type === 'file' && f.multiple) {
      const picked = fileListPreview(node, { max: f.max });
      fileLists.push(picked);
      rows[f.name] = field(labelOf(f) + (f.required ? ' *' : ''), el('div', { class: 'file-pick' }, node, picked.list), f.hint);
      rows[f.name].style.gridColumn = '1 / -1'; // รูปย่อหลายรูปต้องใช้เต็มแถว
      return rows[f.name];
    }
    rows[f.name] = field(labelOf(f) + (f.required ? ' *' : ''), node, f.hint);
    if (f.type === 'textarea') rows[f.name].style.gridColumn = '1 / -1'; // ข้อความยาวใช้เต็มแถว
    return rows[f.name];
  }));

  const submitBtn = el('button', { class: 'btn' }, submitLabel);
  const backdrop = el('div', { class: 'modal-backdrop' });
  const close = () => { fileLists.forEach((p) => p.release()); backdrop.remove(); onClose?.(); };

  /** ช่องที่ถูกซ่อนอยู่ ไม่ถูกนับเป็นค่าและไม่ถูกบังคับกรอก */
  const isVisible = (f, values) => !f.showWhen || f.showWhen(values);

  const collect = () => {
    const values = {};
    for (const f of fields) {
      // กลุ่มติ๊กคืนอาเรย์เสมอ แม้ไม่ได้ติ๊กอะไรเลย (อาเรย์ว่าง = ไม่ให้สิทธิ์อะไรเลย ซึ่งตั้งใจได้)
      if (f.type === 'checklist') {
        values[f.name] = inputs[f.name].value;
        continue;
      }
      // ช่องไฟล์คืน File object ไม่ใช่ข้อความ — .value ของมันเป็น path หลอก ใช้ไม่ได้
      // แบบหลายไฟล์คืนอาเรย์ แต่ไม่ได้เลือกเลยยังเป็น undefined — required ตรวจแบบเดียวกับช่องอื่นได้
      if (f.type === 'file') {
        const files = [...(inputs[f.name].files ?? [])];
        if (f.multiple) {
          if (files.length) values[f.name] = files;
        } else if (files[0]) {
          values[f.name] = files[0];
        }
        continue;
      }
      const raw = f.type === 'password' ? String(inputs[f.name].value ?? '') : String(inputs[f.name].value ?? '').trim();
      if (raw !== '') values[f.name] = f.type === 'number' ? Number(raw) : raw;
    }
    // รอบสอง: ตัดค่าของช่องที่ซ่อนอยู่ทิ้ง (ต้องรู้ค่าช่องอื่นก่อนถึงจะตัดสินได้)
    for (const f of fields) if (!isVisible(f, values)) delete values[f.name];
    return values;
  };

  /** ซ่อน/แสดงช่อง อัปเดตหัวข้อ และตัวเลือกใน select ตามค่าที่เลือกในช่องอื่น */
  const refreshVisibility = () => {
    const values = collect();
    for (const f of fields) {
      rows[f.name].style.display = isVisible(f, values) ? '' : 'none';
      if (typeof f.label === 'function') {
        rows[f.name].querySelector('label').textContent = labelOf(f, values) + (f.required ? ' *' : '');
      }

      if (typeof f.options === 'function') {
        const node = inputs[f.name];
        const wanted = optionsOf(f, values);
        // วาดใหม่เฉพาะตอนรายการเปลี่ยนจริง ไม่งั้นค่าที่ผู้ใช้เลือกไว้จะถูกรีเซ็ตทุกครั้ง
        const same = node.options.length === wanted.length
          && [...node.options].every((o, i) => o.value === String(wanted[i].value));
        if (same) continue;

        const keep = node.value;
        clear(node).append(...wanted.map((o) => el('option', { value: o.value }, o.label)));
        // ค่าที่เลือกไว้ยังอยู่ในลิสต์ใหม่ก็คงไว้ ถ้าหายไปแล้วค่อยเด้งไปตัวแรก
        node.value = wanted.some((o) => String(o.value) === keep) ? keep : (wanted[0]?.value ?? '');
      }
    }
  };

  /**
   * กล่องพรีวิวที่อัปเดตตามค่าในฟอร์ม (เช่น โชว์ยอดที่จะถูกเรียกเก็บก่อนกดยืนยัน)
   * preview() คืน node ตรง ๆ ก็ได้ หรือคืน { node, canSubmit:false } เพื่อปิดปุ่มยืนยัน
   * เมื่อรู้ล่วงหน้าแล้วว่ากดไปก็ไม่ผ่าน (เช่นรอบนี้ออกบิลไปแล้ว)
   */
  const previewBox = el('div', { style: 'margin-bottom:14px' });
  let previewToken = 0;
  const refreshPreview = async () => {
    if (!preview) return;
    const token = ++previewToken;
    try {
      const result = await preview(collect());
      if (token !== previewToken) return; // มีการเปลี่ยนค่าใหม่ระหว่างรอ — ทิ้งผลเก่า
      const blocked = result && typeof result === 'object' && !(result instanceof Node) && result.canSubmit === false;
      const content = blocked || (result && result.node !== undefined) ? result.node : result;
      clear(previewBox).append(content ?? '');
      submitBtn.disabled = Boolean(blocked);
      submitBtn.title = blocked ? 'ทำรายการนี้ไม่ได้ — ดูคำอธิบายด้านบน' : '';
    } catch (err) {
      if (token === previewToken) clear(previewBox).append(el('div', { class: 'hint' }, err.message));
    }
  };

  const hasConditional = fields.some((f) => f.showWhen || typeof f.label === 'function');
  if (preview || hasConditional) {
    for (const node of Object.values(inputs)) {
      const update = () => { refreshVisibility(); refreshPreview(); };
      // 'change' อย่างเดียวจะอัปเดตตอนคลิกออกจากช่อง — ช้าไปสำหรับช่องที่ต้องเห็นผลระหว่างพิมพ์
      // (เช่นกรอกอัตราแลกเปลี่ยนแล้วอยากเห็นยอดดอลลาร์ทันที) จึงฟัง 'input' ด้วย
      node.addEventListener('change', update);
      node.addEventListener('input', update);
    }
    refreshVisibility();
    refreshPreview();
  }

  /*
   * กล่อง error อยู่บนสุดของโมดัล แต่ปุ่มบันทึกอยู่ล่างสุด — โมดัลยาว (เช่น "ตั้งค่าคอม" ที่มีตารางรายการรอจ่ายคอม)
   * กดบันทึกจากท้ายหน้าต่างแล้ว error ไปขึ้นเหนือจอ ดูเหมือนกดแล้วไม่เกิดอะไร (รวมถึงข้อความ "บันทึกไปแล้วบางส่วน")
   * เลื่อนให้เห็นทุกครั้ง · 'nearest' = อยู่ในจออยู่แล้วก็ไม่เลื่อน
   */
  const showError = (message) => {
    errorBox.textContent = message;
    errorBox.style.display = '';
    errorBox.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  };

  const submit = async () => {
    const values = collect();
    for (const f of fields) {
      if (f.required && isVisible(f, values) && values[f.name] === undefined) {
        showError(`กรุณากรอก "${labelOf(f, values)}"`);
        return;
      }
    }
    submitBtn.disabled = true;
    errorBox.style.display = 'none';
    try {
      await onSubmit(values);
      close();
    } catch (err) {
      showError(err.fullMessage ?? err.message);
    } finally {
      submitBtn.disabled = false;
    }
  };

  submitBtn.addEventListener('click', submit);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  backdrop.append(el('div', { class: 'modal', style: width ? `max-width:${width}px` : undefined },
    el('header', {}, el('h2', {}, title), el('button', { class: 'close', onclick: close }, '×')),
    el('div', { class: 'body' }, errorBox, preview ? previewBox : '', body),
    el('footer', {}, el('button', { class: 'btn ghost', onclick: close }, 'ยกเลิก'), submitBtn)));

  document.body.append(backdrop);
  Object.values(inputs)[0]?.focus();
  return { close };
}

/** โมดัลแสดงข้อมูลเฉย ๆ (ไม่มีฟอร์ม) — คืน { close, body } ให้เติมเนื้อหาเพิ่มได้ */
export function infoModal({ title, content, width = 640, onClose }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const close = () => { backdrop.remove(); onClose?.(); };
  const body = el('div', { class: 'body' }, content);

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.append(el('div', { class: 'modal', style: `max-width:${width}px` },
    el('header', {}, el('h2', {}, title), el('button', { class: 'close', onclick: close }, '×')),
    body,
    el('footer', {}, el('button', { class: 'btn ghost', onclick: close }, 'ปิด'))));

  document.body.append(backdrop);
  return { close, body };
}

export async function confirmAction(message, run) {
  if (!window.confirm(message)) return false;
  try {
    await run();
    return true;
  } catch (err) {
    toast(err.fullMessage ?? err.message, 'error');
    return false;
  }
}

/* ── ชุดข้อมูลเข้าระบบ (ลิงก์ + ชื่อผู้ใช้ + รหัสผ่าน) ───────────────────────
   ส่งให้ลูกค้าเป็นก้อนเดียว กดคัดลอกครั้งเดียวแล้ววางในแชตได้เลย ไม่ต้องพิมพ์ทีละบรรทัด
   รหัสผ่านเก็บแบบ bcrypt (ทางเดียว) — ชุดที่มีรหัสผ่านจึงโชว์ได้แค่ตอนที่หน้าเว็บรู้รหัสอยู่
   คือหลังสร้างบัญชีหรือหลังตั้งรหัสใหม่เท่านั้น หลังจากนั้นดูย้อนหลังไม่ได้อีก */

// ชื่อระบบเดียวกับหัวเมนูและหน้าล็อกอิน (paynest.appName ฝั่งเซิร์ฟเวอร์ไม่ได้ส่งมาถึงหน้าเว็บ)
export const APP_NAME = 'ระบบจัดการร้าน';

/*
 * ตัดตัวที่หน้าตาคล้ายกัน (0 O 1 l I) — รหัสถูกอ่านออกเสียง/พิมพ์ตามจากแชตบนมือถือ
 * สุ่มด้วย crypto.getRandomValues + ทิ้งไบต์ที่เกิน (ไม่ใช้ % ตรง ๆ ตัวอักษรต้น ๆ จะออกบ่อยกว่า)
 */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function randomPassword(len = 10) {
  // เซิร์ฟเวอร์รับรหัสอย่างน้อย 8 ตัว — สั้นกว่านั้นส่งไปก็โดนตีกลับ
  const size = Math.max(8, Math.floor(Number(len) || 10));
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  for (;;) {
    let out = '';
    while (out.length < size) {
      for (const b of crypto.getRandomValues(new Uint8Array(size * 2))) {
        if (b < limit && out.length < size) out += PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length];
      }
    }
    // มีทั้งตัวอักษรและตัวเลข — ลูกค้าบางคนตั้งใจว่ารหัสต้องมีเลข เห็นตัวอักษรล้วนแล้วนึกว่าคัดลอกมาไม่ครบ
    if (/\d/.test(out) && /[A-Za-z]/.test(out)) return out;
  }
}

/** ลิงก์เต็มสำหรับส่งให้ลูกค้า — API ส่งมาแค่ path (/#/s/…) เพราะเซิร์ฟเวอร์ไม่รู้ว่าเราเปิดผ่านโดเมนไหน */
export const loginUrl = (path = '/#/login') => `${location.origin}${String(path).startsWith('/') ? '' : '/'}${path}`;

/**
 * ข้อความชุดข้อมูลเข้าระบบ (ข้อความล้วน ส่งในแชตได้ทุกแอป)
 *   title       ใครเป็นเจ้าของชุดนี้ เช่น 'ร้าน bkk01' / 'เซล sale01'
 *   url         ลิงก์เข้าระบบ — ร้าน = ลิงก์ของร้าน · เซล = loginUrl()
 *   password    ไม่มี = รหัสเดิมที่ดูย้อนหลังไม่ได้ (ใส่ passwordHint แทนข้อความตั้งต้นได้)
 *   mustChange  ระบบจะให้ตั้งรหัสใหม่ตอนเข้าครั้งแรก — บอกลูกค้าไว้ก่อน จะได้ไม่ตกใจ
 */
export function loginSetText({ title, url, username, password, mustChange = false, passwordHint } = {}) {
  const head = String(title ?? '').startsWith('ข้อมูลเข้าสู่ระบบ')
    ? title
    : `ข้อมูลเข้าสู่ระบบ ${APP_NAME}${title ? ` — ${title}` : ''}`;
  return [
    head,
    `ลิงก์: ${url || '(ขอลิงก์เข้าระบบจากทางเรา)'}`,
    `ชื่อผู้ใช้: ${username ?? ''}`,
    `รหัสผ่าน: ${password || passwordHint || '(ตามที่ตั้งไว้ — ถ้าลืม ให้ทางเราตั้งรหัสใหม่)'}`,
    mustChange ? 'เข้าครั้งแรกระบบจะให้ตั้งรหัสผ่านใหม่' : null,
  ].filter(Boolean).join('\n');
}

/**
 * กล่องชุดข้อมูลเข้าระบบ — ตัวหนังสือความกว้างเท่ากัน + ปุ่มใหญ่ "คัดลอกทั้งชุด"
 * opts เหมือน loginSetText + note (ข้อความใต้ปุ่ม · ไม่ส่ง = ใช้คำเตือนตั้งต้น · '' = ไม่มี)
 */
export function loginSetBox(opts = {}) {
  const text = loginSetText(opts);
  const note = opts.note !== undefined ? opts.note
    : opts.password
      ? '⚠ รหัสผ่านนี้แสดงครั้งเดียว — ระบบเก็บรหัสแบบเข้ารหัสทางเดียว ปิดหน้าต่างนี้แล้วดูอีกไม่ได้ · คัดลอกส่งให้เจ้าของบัญชีทางแชตส่วนตัวตอนนี้เลย'
      : 'รหัสผ่านที่ตั้งไว้แล้วดูย้อนหลังไม่ได้ (ระบบเก็บแบบเข้ารหัสทางเดียว) — ถ้าลืมรหัส ใช้ปุ่ม "🔑 ตั้งรหัสใหม่ + คัดลอก" แทน';
  return el('div', { class: 'login-set' },
    el('pre', {}, text),
    el('button', {
      type: 'button',
      class: 'btn block',
      onclick: () => copyText(text, 'คัดลอกข้อมูลเข้าระบบทั้งชุดแล้ว — วางในแชตส่งให้เจ้าของบัญชีได้เลย'),
    }, '📋 คัดลอกทั้งชุด'),
    note ? el('div', { class: `login-set-note${opts.password ? ' warn' : ''}` }, note) : '');
}

/** โมดัลโชว์ชุดข้อมูลเข้าระบบ (หลังสร้างบัญชี / ตั้งรหัสใหม่) */
export function loginSetModal({ heading, ...opts }) {
  return infoModal({
    title: heading ?? `ข้อมูลเข้าระบบของ ${opts.username}`,
    width: 520,
    content: loginSetBox(opts),
  });
}

/**
 * "🔑 ตั้งรหัสใหม่ + คัดลอก" — สุ่มรหัสให้ (แก้เองได้) → run(body) เรียก API → โชว์ชุดพร้อมรหัสให้คัดลอก
 * body = { newPassword, mustChange: true } เสมอ: รหัสนี้ผ่านมือคนอื่นมาแล้ว (แอดมิน/แชต)
 * เจ้าของบัญชีต้องตั้งรหัสของตัวเองตอนเข้าครั้งแรก ข้อความในชุดจึงบอกไว้ตรงกัน
 */
export function resetPasswordModal({ username, title, url, run, onDone, passwordHint }) {
  return formModal({
    title: `ตั้งรหัสผ่านใหม่ให้ ${username}`,
    submitLabel: 'ตั้งรหัสใหม่ แล้วคัดลอก',
    fields: [{
      name: 'newPassword',
      label: 'รหัสผ่านใหม่',
      required: true,
      value: randomPassword(),
      hint: 'สุ่มให้แล้ว (ไม่มีตัวที่หน้าตาคล้ายกันอย่าง 0/O หรือ 1/l/I) · แก้เองได้ อย่างน้อย 8 ตัวอักษร',
    }],
    preview: () => el('div', { class: 'notice-box m-0' },
      `รหัสเดิมของ ${username} ใช้ไม่ได้ทันที และ ${username} จะถูกออกจากระบบทุกเครื่อง · `
      + 'เข้าครั้งแรกด้วยรหัสนี้ ระบบจะให้ตั้งรหัสผ่านใหม่ของตัวเอง'),
    onSubmit: async (v) => {
      if (v.newPassword.length < 8) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');
      await run({ newPassword: v.newPassword, mustChange: true });
      loginSetModal({
        heading: `รหัสใหม่ของ ${username} — คัดลอกส่งให้เลย`,
        title, url, username, password: v.newPassword, mustChange: true, passwordHint,
      });
      onDone?.();
    },
  });
}
