/**
 * กราฟทั้งหมดวาดด้วย SVG ล้วน ๆ ไม่พึ่งไลบรารีภายนอก
 * — โหลดเร็ว ปรับสีตามธีมได้ และซูมเท่าไรก็ไม่แตก
 *
 * ทุกกราฟรับตัวเลขที่คำนวณมาแล้วเท่านั้น ไม่ยุ่งกับ API เอง
 */
import { el, money, pct } from './ui.js';

/**
 * สีสำหรับชุดข้อมูลหลายก้อน — โทนเดียวกับระบบ (น้ำเงินหลัก เขียวเงินเข้า ส้มค้างจ่าย …)
 * สีสดพอให้แยกกันออก แต่ไม่จัดจนแย่งสายตาจากตัวเลข
 */
export const SERIES_COLORS = [
  '#2f5bd8', '#10a37f', '#f59e0b', '#8b5cf6', '#0ea5e9', '#f43f5e', '#84cc16', '#ec4899',
];
const OTHER_COLOR = '#aab4c5';

export const colorOf = (i) => SERIES_COLORS[i % SERIES_COLORS.length];

/** สีผูกกับชื่อ — ร้าน/สินค้าเดิมได้สีเดิมทุกกราฟและทุกหน้า (เดิมโดนัทใช้ลำดับ รูปย่อใช้ชื่อ สีจึงไม่ตรงกัน) */
export function colorFor(name) {
  const text = String(name ?? '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return colorOf(hash);
}

/** ตัวเลขย่อแบบไทย: 12,500 → "1.3 หมื่น" · 1,250,000 → "1.3 ล้าน" — ใช้บนแกน/แท่งที่พื้นที่น้อย */
const COMPACT = new Intl.NumberFormat('th-TH', { notation: 'compact', compactDisplay: 'long', maximumFractionDigits: 1 });
export const compact = (n) => (Math.abs(Number(n)) < 10000 ? money(n) : COMPACT.format(Number(n)));

const svgEl = (tag, props = {}, ...children) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, v);
  }
  for (const c of children.flat(3)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
};

/* ── เกจครึ่งวงกลม ─────────────────────────────────────────
 * ใช้บอกสัดส่วนที่มีเพดานชัดเจน เช่น "เก็บเงินได้กี่ % ของที่ออกบิลไป"
 */
export function gauge({ value, label, sub, tone = 'primary', caption }) {
  // value = null แปลว่า "ยังไม่มีข้อมูล" ไม่ใช่ "ศูนย์" — แสดงเป็นขีดเทาแทน กันอ่านผิด
  const empty = value === null || value === undefined;
  const ratio = empty ? 0 : Math.max(0, Math.min(1, Number(value) / 100));
  if (empty) tone = 'empty';
  const r = 62;
  const cx = 80;
  const cy = 76;
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const len = Math.PI * r;

  const fill = svgEl('path', {
    d: arc,
    class: 'gauge-fill',
    'stroke-dasharray': `${len} ${len}`,
    'stroke-dashoffset': len, // เริ่มที่ว่างเปล่า แล้วให้ CSS วิ่งเข้าหาค่าจริง
  });
  // หน่วงหนึ่งเฟรมเพื่อให้เบราว์เซอร์ทันจับ transition ตอนค่าเปลี่ยน
  requestAnimationFrame(() => { fill.style.strokeDashoffset = String(len * (1 - ratio)); });

  return el('div', { class: `gauge tone-${tone}` },
    svgEl('svg', { viewBox: '0 0 160 92', role: 'img', 'aria-label': `${label} ${pct(value)}` },
      svgEl('path', { d: arc, class: 'gauge-track' }),
      fill),
    el('div', { class: 'gauge-center' },
      el('div', { class: 'gauge-value' }, empty ? '—' : pct(value)),
      el('div', { class: 'gauge-label' }, label)),
    sub && el('div', { class: 'gauge-sub' }, sub),
    caption && el('div', { class: 'gauge-caption' }, caption));
}

/* ── โดนัท + รายการข้างล่าง ────────────────────────────────
 * segments: [{ label, value, sub }]
 */
export function donut(segments, { valueFormat = money, unit = '฿', centerLabel = 'รวม', onSelect } = {}) {
  const positive = segments.filter((s) => Number(s.value) > 0).sort((a, b) => Number(b.value) - Number(a.value));
  // เกิน 7 ชิ้น รวมที่เหลือเป็น "อื่น ๆ" — ไม่งั้นสีวนซ้ำและชิ้นเล็กอ่านไม่ออก
  const items = positive.length > 7
    ? [...positive.slice(0, 6), { label: `อื่น ๆ (${positive.length - 6})`, value: positive.slice(6).reduce((t, x) => t + Number(x.value), 0), other: true }]
    : positive;
  const colorAt = (s) => (s.other ? OTHER_COLOR : colorFor(s.label));
  const total = items.reduce((s, x) => s + Number(x.value), 0);

  if (!total) {
    return el('div', { class: 'donut-wrap' },
      el('div', { class: 'empty', style: 'width:100%' }, 'รอบนี้ยังไม่มียอดให้แสดง'));
  }

  const r = 56;
  const c = 2 * Math.PI * r;
  let acc = 0;

  const rings = items.map((s, i) => {
    const frac = Number(s.value) / total;
    const ring = svgEl('circle', {
      cx: 70, cy: 70, r,
      class: 'donut-seg',
      stroke: colorAt(s),
      'stroke-dasharray': `0 ${c}`,                  // เริ่มที่ 0 แล้วค่อยกางออก
      'stroke-dashoffset': -acc * c,
    }, svgEl('title', {}, `${s.label} — ${valueFormat(s.value)} ${unit} (${pct(frac * 100)})`));
    const from = acc;
    requestAnimationFrame(() => {
      ring.style.transitionDelay = `${i * 70}ms`;
      ring.setAttribute('stroke-dasharray', `${frac * c} ${c - frac * c}`);
      ring.setAttribute('stroke-dashoffset', String(-from * c));
    });
    acc += frac;
    return ring;
  });

  const legend = el('ul', { class: 'legend' }, ...items.map((s) => el('li', {
    class: onSelect ? 'clickable' : '',
    onclick: onSelect ? () => onSelect(s) : undefined,
  },
  el('span', { class: 'dot', style: `background:${colorAt(s)}` }),
  // sub ที่ซ้ำกับ label ไม่ต้องโชว์ (เช่นร้านที่ใช้ username เป็นชื่ออยู่แล้ว)
  el('span', { class: 'legend-label' }, s.label, s.sub && s.sub !== s.label && el('small', {}, s.sub)),
  el('span', { class: 'legend-value' },
    valueFormat(s.value),
    el('small', {}, pct((Number(s.value) / total) * 100))))));

  return el('div', { class: 'donut-wrap' },
    el('div', { class: 'donut' },
      svgEl('svg', { viewBox: '0 0 140 140', role: 'img' },
        svgEl('circle', { cx: 70, cy: 70, r, class: 'donut-track' }),
        ...rings),
      el('div', { class: 'donut-center' },
        el('strong', { title: `${valueFormat(total)} ${unit}` }, compact(total)),
        el('span', {}, centerLabel))),
    legend);
}

/* ── กราฟแท่งแนวโน้มรายรอบ ────────────────────────────────
 * points: [{ label, value, sub }] เรียงจากเก่าไปใหม่
 */
export function barTrend(points, { valueFormat = money, unit = '฿', highlight } = {}) {
  if (!points.length) return el('div', { class: 'empty' }, 'ยังไม่มีข้อมูลย้อนหลัง');
  const max = Math.max(...points.map((p) => Number(p.value) || 0), 1);

  return el('div', { class: 'bar-trend' },
    ...points.map((p, i) => {
      const value = Number(p.value) || 0;
      const h = Math.max(2, (value / max) * 100); // เหลือ 2% ไว้ให้แท่งศูนย์ยังเห็นเป็นเส้น
      const col = el('div', {
        class: `bar-col${p.label === highlight ? ' is-current' : ''}${value === 0 ? ' is-zero' : ''}`,
        title: `${p.label}: ${valueFormat(value)} ${unit}`,
      },
      el('div', { class: 'bar-amount' }, compact(value)),
      el('div', { class: 'bar-track' }, el('div', { class: 'bar-fill', style: 'height:0' })),
      el('div', { class: 'bar-label' }, p.label),
      p.sub && el('div', { class: 'bar-sub' }, p.sub));

      const fill = col.querySelector('.bar-fill');
      requestAnimationFrame(() => {
        fill.style.transitionDelay = `${i * 55}ms`;
        fill.style.height = `${h}%`;
      });
      return col;
    }));
}

/* ── แถบสัดส่วนในตาราง ────────────────────────────────────
 * ใช้แทนตัวเลขล้วน ๆ เพื่อให้เทียบขนาดกันได้ด้วยสายตา
 */
export function shareBar(value, max, { color, format = money } = {}) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const fill = el('span', { class: 'share-fill', style: `width:0;background:${color ?? 'var(--primary)'}` });
  requestAnimationFrame(() => { fill.style.width = `${ratio * 100}%`; });
  return el('div', { class: 'share' },
    el('span', { class: 'share-num' }, format(value)),
    el('span', { class: 'share-track' }, fill));
}

/* ── วงกลมอักษรย่อ ────────────────────────────────────────
 * สีผูกกับชื่อแบบคงที่ ร้านเดิมจึงได้สีเดิมทุกหน้า จำง่ายกว่าอ่านตัวอักษร
 */
export function avatar(name, { sub, size } = {}) {
  const text = String(name ?? '?');
  const color = colorFor(text);
  const initials = text.replace(/[^a-zA-Z0-9ก-๙]/g, '').slice(0, 2).toUpperCase() || '?';

  const chip = el('span', {
    class: 'avatar',
    style: `background:${color}1f;color:${color}${size ? `;width:${size}px;height:${size}px` : ''}`,
  }, initials);

  if (sub === undefined) return chip;
  return el('div', { class: 'avatar-row' }, chip,
    // ไม่พิมพ์บรรทัดล่างซ้ำกับชื่อด้านบน
    el('span', { class: 'avatar-text' }, el('strong', {}, text), sub && sub !== text && el('small', {}, sub)));
}
