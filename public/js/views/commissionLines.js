import { commBadge, dateTh, el, money, pct, stat, table, totalCell, usdOf } from '../ui.js';
import { periodLabel } from '../period.js';

/*
 * ชิ้นส่วนแสดง "บิลค่าคอม" ของเซล — ใช้ร่วมกันระหว่างหน้าเซลของส่วนกลาง (salesAgents.js)
 * กับหน้ารายได้ของเซลเอง (myCommissions.js) ให้สองฝั่งอ่านตัวเลขชุดเดียวกันด้วยคำเดียวกัน
 *
 * บิลค่าคอมหนึ่งใบ = เซลหนึ่งคน ติ๊กรายการจากบิลร้านได้หลายใบ หลายร้าน หลายรอบ + เหมาต่อรอบ + ค่าคอมอื่น ๆ
 * แถวที่เกิดก่อนมีบิลค่าคอม (คิดอัตโนมัติรายบิลร้าน / ค่าคอมอื่น ๆ แบบเลือกรอบ) ยังอ่าน จ่าย และยกเลิกได้
 * — แถวพวกนั้นไม่มีรายการย่อย จึงโชว์หัวแถว (ฐาน % เหมา) แทน
 */

const muted = (text = '—') => el('span', { class: 'muted' }, text);

export const isBill = (r) => r.kind === 'BILL';
const isLegacyManual = (r) => !isBill(r) && (r.isManual || r.kind === 'MANUAL');

/** เลขที่ที่คนอ่าน — บิลใหม่มีเลข COM-… · แถวแบบเดิมไม่มีเลข ใช้ชื่อรายการ/เลขบิลร้านแทน */
export function commissionTitle(r) {
  if (isBill(r)) return r.billNo ?? r.title ?? `บิลค่าคอม #${r.id}`;
  if (isLegacyManual(r)) return r.label ?? r.title ?? 'ค่าคอมอื่น ๆ';
  return `ค่าคอมบิล ${r.invoiceNo ?? '—'}`;
}

/** สรุปสั้น ๆ ว่าก้อนนี้มาจากอะไร โดยไม่ต้องเปิดดู (ตารางไม่ตัดบรรทัด — ต้องสั้น) */
export function commissionSubtitle(r) {
  if (isBill(r)) {
    const lines = r.lines ?? [];
    const count = (kind) => lines.filter((l) => l.kind === kind).length;
    const shops = new Set(lines.map((l) => l.franchiseUsername).filter(Boolean));
    return [
      count('ITEM') ? `สินค้า ${count('ITEM')}` : null,
      count('FIXED') ? `เหมา ${count('FIXED')}` : null,
      count('OTHER') ? `อื่น ๆ ${count('OTHER')}` : null,
      shops.size ? `${shops.size} ร้าน` : null,
    ].filter(Boolean).join(' · ') || 'ไม่มีรายการ';
  }
  // แถวแบบเดิมผูกกับรอบบิลเสมอ — บอกรอบไว้ เพราะเป็นทางเดียวที่แยกก้อนเก่า ๆ ออกจากกัน
  if (isLegacyManual(r)) return `อื่น ๆ แบบเดิม · ${periodLabel(r.periodCode)}`;
  return `แบบเดิม · ${r.franchiseUsername ?? '—'} · ${periodLabel(r.periodCode)}`;
}

/* ── แถวแบบเดิม: หัวแถวบอกฐาน/%/เหมา ─────────────────────────── */

const BASIS_LABEL = { GROSS: 'ยอดขายเต็ม', COMMISSION: 'ส่วนต่างที่ร้านค้าจ่าย', MIXED: 'หลายแบบ', MANUAL: 'กรอกเอง' };
const basisLabelOf = (r) => r.basisLabel ?? BASIS_LABEL[r.basis] ?? '—';

/** ช่อง "ฐานที่คิด" ของแถวแบบเดิม — ค่าคอมอื่น ๆ ไม่มีฐาน */
function baseCell(r) {
  if (isLegacyManual(r)) return muted();
  return el('div', {}, money(r.baseAmount), el('div', { class: 'sub-line' }, basisLabelOf(r)));
}

/** ช่อง "จาก %" ของแถวแบบเดิม — ไม่มีอัตราเดียวแต่มียอด ก็ยังโชว์ยอด ไม่ใช่ "—" ทั้งช่อง */
function pctCell(r) {
  if (isLegacyManual(r)) return muted();
  if (r.commissionPct !== null && r.commissionPct !== undefined) return `${money(r.pctAmount)} (${pct(r.commissionPct)})`;
  if (Number(r.pctAmount)) return money(r.pctAmount);
  return muted();
}

function legacyTable(r) {
  return table([
    { label: 'ฐานที่คิด', num: true, render: baseCell },
    { label: 'จาก %', num: true, render: pctCell },
    {
      label: isLegacyManual(r) ? 'จำนวนเงิน' : 'เหมาต่อรอบ',
      num: true,
      render: (x) => (Number(x.fixedAmount) ? money(x.fixedAmount) : muted()),
    },
    { label: 'รวม', num: true, render: (x) => el('strong', {}, money(x.totalAmount)) },
  ], [r], { sortable: false });
}

/* ── รายการในบิลค่าคอม ───────────────────────────────────────── */

const KIND_LABEL = { ITEM: 'สินค้า', FIXED: 'เหมาต่อรอบ', OTHER: 'ค่าคอมอื่น ๆ' };

/** วิธีคิดของรายการ — สินค้า: % ของยอดเต็ม / กรอกเอง · เหมาและค่าคอมอื่น ๆ เป็นจำนวนเงินอยู่แล้ว */
function methodLabel(l) {
  if (l.kind === 'ITEM') return l.modeLabel ?? (l.mode === 'MANUAL' ? 'กรอกเอง' : '% ของยอดเต็ม');
  return KIND_LABEL[l.kind] ?? l.kind;
}

function whatCell(l) {
  if (l.kind === 'OTHER') {
    return el('div', {}, el('strong', {}, l.label ?? '—'),
      el('div', { class: 'sub-line' }, Number(l.amount) < 0 ? 'ค่าคอมอื่น ๆ · หักคืน' : 'ค่าคอมอื่น ๆ'));
  }
  if (l.kind === 'FIXED') return el('div', {}, el('strong', {}, 'เหมาต่อรอบ'), el('div', { class: 'sub-line' }, 'ต่อร้านต่อรอบ'));
  return el('div', {}, el('strong', {}, l.sku ?? '—'), el('div', { class: 'sub-line' }, l.productName ?? ''));
}

/**
 * บิลร้านที่รายการนี้มาจาก + ร้าน/รอบของบิลนั้น (รวมไว้ช่องเดียว ตารางในโมดัลจะได้ไม่ล้นจอ)
 * บิลร้านถูกยกเลิกทีหลัง (บิลค่าคอมจ่ายไปแล้วจึงไม่ถูกถอด) ต้องเห็นชัด จะได้ไปหักคืนในบิลค่าคอมใบถัดไป
 */
function invoiceCell(l) {
  if (!l.invoiceNo) return muted();
  return el('div', {}, l.invoiceNo,
    el('div', { class: 'sub-line' }, `${l.franchiseUsername ?? '—'} · ${l.periodCode ? periodLabel(l.periodCode) : '—'}`),
    l.invoiceVoided ? el('div', {}, el('span', { class: 'badge red' }, 'บิลร้านถูกยกเลิก')) : '');
}

/** ตารางรายการของบิลค่าคอม — ป้ายคอลัมน์เป็นข้อความทุกช่อง (มือถือพลิกเป็นการ์ดแล้วใช้ป้ายนี้) */
export function commissionLinesTable(r) {
  const lines = r.lines ?? [];
  return table([
    { label: 'บิลร้าน · ร้าน · รอบ', render: invoiceCell },
    { label: 'สินค้า / รายการ', render: whatCell },
    { label: 'วิธีคิด', render: (l) => methodLabel(l) },
    // ยอดเต็มมีเฉพาะรายการสินค้า — เหมา/ค่าคอมอื่น ๆ โชว์ 0.00 จะอ่านเป็นว่าร้านขายไม่ได้
    { label: 'ยอดเต็ม', num: true, render: (l) => (l.kind === 'ITEM' ? money(l.baseAmount) : muted()) },
    { label: '%', num: true, render: (l) => (l.kind === 'ITEM' && l.mode !== 'MANUAL' && l.pct !== null ? pct(l.pct) : muted()) },
    {
      label: 'ยอดคอม',
      num: true,
      render: (l) => el('strong', { class: Number(l.amount) < 0 ? 'text-danger' : '' }, money(l.amount)),
    },
  ], lines, {
    sortable: false,
    empty: 'ไม่มีรายการ',
    footer: ['', '', '', '', 'รวม', totalCell(r.totalAmount, usdOf(r.totalAmount, r.fxRate))],
  });
}

/**
 * รายละเอียดของบิลค่าคอมหนึ่งใบ (ใช้ในหน้าต่าง "ดู") — ตัวเลขสรุป + รายการ
 * forAgent: เซลดูของตัวเอง — ป้ายสถานะใช้คำของคนรอรับเงิน
 */
export function commissionDetail(r, { forAgent = false } = {}) {
  const bill = isBill(r);
  return el('div', {},
    el('div', { class: 'stat-grid' },
      stat('ยอดรวม', money(r.totalAmount) + ' ฿', bill ? commissionSubtitle(r) : null,
        { tone: 'sales', icon: '🎯', usd: usdOf(r.totalAmount, r.fxRate) }),
      stat('สถานะ', commBadge(r.status, { forAgent }),
        r.status === 'PAID' && r.paidAt ? `${forAgent ? 'ได้รับ' : 'จ่าย'}เมื่อ ${dateTh(r.paidAt)}` : null,
        { tone: r.status === 'PENDING' ? 'due' : r.status === 'PAID' ? 'income' : 'muted', icon: r.status === 'PAID' ? '✓' : '⏳' }),
      stat(bill ? 'วันที่ทำบิล' : 'รอบบิล', bill ? dateTh(r.createdAt) : periodLabel(r.periodCode), null, { tone: 'muted', icon: '📅' })),

    r.status === 'VOID'
      ? el('div', { class: 'alert-box' },
        el('strong', {}, `ยกเลิกแล้ว${r.voidedAt ? ` · ${dateTh(r.voidedAt)}` : ''}`),
        r.voidReason ? el('div', {}, r.voidReason) : '')
      : '',
    /*
     * หักจากบิลร้าน (R25) — ร้านเป็นคนจ่ายค่าคอมก้อนนี้ให้เซลเอง ส่วนกลางไม่ได้โอน
     * เซลต้องรู้ว่าเงินมาจากใคร · ส่วนกลางต้องรู้ว่ายกเลิกที่นี่ไม่ได้ (ต้องถอนจากฝั่งบิลร้าน)
     */
    r.settledByInvoice && r.status !== 'VOID'
      ? el('div', { class: 'notice-box' },
        el('strong', {}, `หักจากบิลร้าน ${r.settledByInvoice.invoiceNo} — ร้าน ${r.settledByInvoice.franchiseUsername} เป็นผู้จ่ายค่าคอมก้อนนี้`),
        el('div', { class: 'sub-line mt-4' }, forAgent
          ? 'ยอดนี้ถูกหักออกจากบิลของร้านแล้ว ร้านเป็นคนจ่ายให้คุณโดยตรง — ทางเราไม่ได้โอนซ้ำ'
          : 'ยอดนี้ถูกหักออกจากยอดที่ร้านต้องจ่ายแล้ว ไม่ต้องโอนให้เซลอีก · จะยกเลิกให้ไปที่บิลร้านใบนั้น (แก้ไขบิล → "ถอนการหัก" หรือยกเลิกบิลร้าน)'))
      : '',
    r.note ? el('div', { class: 'notice-box' }, `หมายเหตุ: ${r.note}`) : '',

    bill ? commissionLinesTable(r) : el('div', {},
      el('div', { class: 'sub-line mb-8' },
        isLegacyManual(r)
          ? 'ค่าคอมอื่น ๆ ที่บันทึกก่อนมีบิลค่าคอม'
          : `คิดอัตโนมัติตอนออกบิลร้าน ${r.invoiceNo ?? ''} (ก่อนมีบิลค่าคอม) · ร้าน ${r.franchiseUsername ?? '—'}`),
      legacyTable(r)));
}
