import { el, money, pct, table } from '../ui.js';

/*
 * ตัวแก้ "วิธีคิดยอด" รายสินค้าตอนออกบิล (R1) + ตัวคิดเลข/ตรวจตัวเลขที่ใช้ร่วมกัน
 * ใช้ระหว่าง "ออกใบเรียกเก็บ" กับ "เพิ่มรายการเข้าบิล" — สองที่ต้องคิดเลขเหมือนกันเป๊ะ
 * ถ้าแยกเขียนสองชุด วันหนึ่งจะมีอันหนึ่งถูกแก้แล้วอีกอันลืม ยอดที่เห็นก่อนกดจะไม่ตรงกับบิลจริง
 * หน้าทำบิลค่าคอมเซล (salesAgents.js) ก็หยิบ commissionOf/parsePct/parseAmount/sumBaht จากที่นี่ ด้วยเหตุผลเดียวกัน
 *
 * ตัวเลขในนี้เป็นพรีวิวเท่านั้น เซิร์ฟเวอร์คิดใหม่เองทั้งหมดตอนบันทึก (และตรวจกติกาเดียวกันซ้ำ)
 */

// เพดานเดียวกับเซิร์ฟเวอร์ — ตัวเลขยาวเกินทำให้ฝั่ง PHP แปลงเงินไม่ได้ จึงกันตั้งแต่ตอนพิมพ์
const MAX_AMOUNT = 100_000_000;

/**
 * Money::commissionOf ฝั่งเบราว์เซอร์ — คิดเป็นสตางค์ × basis point แล้วปัดครึ่งขึ้น (ปัดออกจากศูนย์)
 * ต้องปัดแบบเดียวกับเซิร์ฟเวอร์ ไม่งั้นพรีวิวเพี้ยน 1 สตางค์แล้วคนเข้าใจว่าระบบคิดผิด
 */
export function commissionOf(grossBaht, pctValue) {
  const satang = Math.round(Number(grossBaht) * 100);
  const bp = Math.round(Number(pctValue) * 100);
  if (!Number.isFinite(satang) || !Number.isFinite(bp)) return 0;
  const product = Math.abs(satang * bp);
  const rounded = Math.floor(product / 10000) + (product % 10000 >= 5000 ? 1 : 0);
  return ((satang * bp) < 0 ? -rounded : rounded) / 100;
}

/** รวมเงินแบบสตางค์ — บวกทศนิยมตรง ๆ หลายสิบบรรทัดแล้วเศษลอย (0.1 + 0.2) */
export const sumBaht = (list) => list.reduce((s, n) => s + Math.round(Number(n || 0) * 100), 0) / 100;

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** % ที่พิมพ์ — คืน { empty } | { value } | { error } */
export function parsePct(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { empty: true };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 100) return { error: 'ต้องเป็นตัวเลข 0–100' };
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return { error: 'ทศนิยมไม่เกิน 2 ตำแหน่ง' };
  return { value: n };
}

/**
 * จำนวนเงินที่พิมพ์เอง — คืน { empty } | { value } | { error }
 * capAtGross: ยอดที่เรียกเก็บจากร้านต้องไม่เกินยอดเงินเต็มของสินค้านั้น (ส่วนต่างเกินยอดขายไม่มีจริง)
 * ส่วนค่าคอมเซลกรอกเกินยอดเต็มได้ (เป็นเงินที่เราตกลงกับเซลเอง) แต่เครื่องหมายต้องไปทางเดียวกับยอดขาย
 */
export function parseAmount(raw, gross, { capAtGross = true } = {}) {
  const s = String(raw ?? '').trim().replace(/,/g, '');
  if (s === '') return { empty: true };
  const n = Number(s);
  if (!Number.isFinite(n)) return { error: 'ตัวเลขไม่ถูกต้อง' };
  if (Math.abs(n) > MAX_AMOUNT) return { error: 'จำนวนเงินเกินกำหนด' };
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return { error: 'ทศนิยมไม่เกิน 2 ตำแหน่ง' };
  // 0 ได้เสมอ · ไม่ใช่ 0 ต้องเครื่องหมายเดียวกับยอดเต็ม (รอบที่คืนของ ยอดติดลบ ส่วนต่างก็ติดลบตาม)
  const wrongSign = n !== 0 && sign(n) !== sign(Number(gross));
  if (capAtGross && (wrongSign || Math.abs(n) > Math.abs(Number(gross)))) {
    return { error: `ยอดที่เรียกเก็บต้องอยู่ระหว่าง 0 ถึงยอดเงินเต็ม (${money(gross)} บาท)` };
  }
  if (!capAtGross && wrongSign) {
    return { error: Number(gross) < 0 ? 'ยอดเต็มติดลบ — ค่าคอมต้องเป็น 0 หรือติดลบ' : 'ค่าคอมต้องเป็น 0 หรือมากกว่า' };
  }
  return { value: Math.round(n * 100) / 100 };
}

/**
 * ยอดเงินเต็มที่พิมพ์ในหน้ายอดขาย — คืน { empty } | { value } | { error }
 * ติดลบได้ (รอบที่คืนของ) · ทศนิยมเท่าเซิร์ฟเวอร์ — ตรวจตรงนี้ให้รู้ตั้งแต่ยังไม่กดบันทึก
 * ยอดเต็มไม่มีเพดาน 100 ล้านแบบยอดที่กรอกเอง (MAX_AMOUNT) — เซิร์ฟเวอร์รับยอดเต็มเกินนั้น และหน้านี้ก่อนรุ่น 2.3.0 ก็ไม่กัน
 * กันแค่เลขที่ใหญ่จนคิดเป็นสตางค์ไม่ตรงแล้ว (เกิน Number.MAX_SAFE_INTEGER สตางค์)
 */
const MAX_GROSS = Math.floor(Number.MAX_SAFE_INTEGER / 100);
export function parseGross(raw) {
  const s = String(raw ?? '').trim().replace(/,/g, '');
  if (s === '') return { empty: true };
  const n = Number(s);
  if (!Number.isFinite(n)) return { error: 'ตัวเลขไม่ถูกต้อง' };
  if (Math.abs(n) > MAX_GROSS) return { error: 'จำนวนเงินเกินกำหนด' };
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return { error: 'ทศนิยมไม่เกิน 2 ตำแหน่ง' };
  return { value: Math.round(n * 100) / 100 };
}

/**
 * ยอดส่วนต่างที่ส่วนกลางกรอกไว้เองในหน้ายอดขาย (R21) — null = ไม่ได้กรอก ใช้ยอดเต็ม × %
 * ไคลเอนต์ที่ได้ข้อมูลจากเซิร์ฟเวอร์รุ่นก่อน 2.3.0 ไม่มีช่องนี้ (undefined) ถือว่าไม่ได้กรอกเหมือนกัน
 */
export const presetOf = (entry) => (entry?.manualAmount === null || entry?.manualAmount === undefined
  ? null
  : Number(entry.manualAmount));

/*
 * สินค้ากลุ่ม (ชุด) — ขายและคิดบิลเป็นบรรทัดเดียวด้วย % ของกลุ่ม ส่วนสินค้าย่อยเป็นแค่ข้อมูลว่าในชุดมีอะไร
 * ป้ายกับบรรทัด "ประกอบด้วย" อยู่ที่นี่ที่เดียว เพราะโผล่หลายหน้า (ออกบิล/เพิ่มรายการ/ดูบิล/หน้าจ่ายเงินของร้าน/ยอดขาย/สินค้า)
 * ถ้าแต่ละหน้าเขียนเอง คำจะเพี้ยนกันไป แล้วร้านกับส่วนกลางคุยกันคนละคำ
 */
export const groupBadge = (count) => el('span', {
  class: 'badge blue badge-group',
  title: 'สินค้ากลุ่ม — ขายและคิดบิลเป็นยอดเดียวของทั้งชุด',
}, count ? `กลุ่ม · ${count} รายการ` : 'กลุ่ม');

/**
 * "ประกอบด้วย: SKU-A, SKU-B, …" ใต้ชื่อสินค้ากลุ่ม — ไม่มีรายการย่อย = ไม่วาดอะไร
 * components = [{ sku, name, status? }] · บรรทัดของบิลที่ออกแล้วเซิร์ฟเวอร์ส่ง snapshot ตอนออกบิลมา
 * (แก้รายการย่อยทีหลัง บิลเก่ายังโชว์ของที่อยู่ในชุดตอนนั้น) หน้าจอจึงโชว์ตามที่ได้มาตรง ๆ ไม่ไปดึงของปัจจุบันมาแทน
 * short: ตัดเหลือบรรทัดเดียวสำหรับตารางยาว ๆ (ชี้ค้างดูครบพร้อมชื่อ) · ในบิลปล่อยขึ้นบรรทัดใหม่ได้ ร้านต้องอ่านครบ
 */
export function componentsLine(components, { short = false, prefix = 'ประกอบด้วย: ' } = {}) {
  const list = Array.isArray(components) ? components : [];
  if (!list.length) return '';
  return el('div', {
    class: `sub-line components-line${short ? ' short' : ''}`,
    title: list.map((c) => `${c.sku}${c.name ? ` — ${c.name}` : ''}${c.status === 'ARCHIVED' ? ' (ปิดใช้งาน)' : ''}`).join('\n'),
  }, prefix + list.map((c) => c.sku).join(', '));
}

/**
 * ช่อง "สินค้า" ของบรรทัดยอดขาย/บรรทัดบิล: รหัส (+ ป้ายกลุ่ม) · ชื่อ · รายการย่อย
 * ป้ายขึ้นเมื่อสินค้าเป็นกลุ่มอยู่ หรือบรรทัดนั้นมีรายการย่อยติดมา (บิลเก่าของสินค้าที่ภายหลังเลิกเป็นกลุ่ม)
 */
export function lineProductCell(line, { short = false } = {}) {
  const components = Array.isArray(line.components) ? line.components : [];
  return el('div', {},
    el('strong', {}, line.sku),
    line.isGroup || components.length ? [' ', groupBadge()] : '',
    el('div', { class: 'sub-line' }, line.productName ?? ''),
    componentsLine(components, { short }));
}

/*
 * ตัวเลือกวิธีคิดของบรรทัด — ค่ายังเป็น PCT / MANUAL สองแบบเท่าเดิม (เซิร์ฟเวอร์รู้จักแค่นี้)
 * รายการที่กรอกยอดส่วนต่างไว้ในหน้ายอดขาย ตัวเลือก MANUAL พูดถึงยอดนั้นตรง ๆ พร้อมตัวเลข
 * เจ้าของระบบขอ "เลือกได้ 2 กรณีตอนออกบิล" — ยอดที่กรอกไว้แล้ว หรือยอดเต็ม × % — จึงเห็นทั้งสองทางในช่องเดียว
 */
const billModes = (e) => [
  { value: 'PCT', label: 'คิดจากยอดเต็ม × %' },
  {
    value: 'MANUAL',
    label: presetOf(e) === null ? 'กรอกยอดเอง' : `ใช้ยอดส่วนต่างที่กรอกไว้ (${money(presetOf(e))})`,
  },
];

const numberInput = (cls, value, placeholder) => el('input', {
  type: 'number',
  step: '0.01',
  inputmode: 'decimal',
  class: cls,
  value: value ?? '',
  placeholder: placeholder ?? '',
});

/**
 * ตารางเลือกสินค้า + วิธีคิดยอดของแต่ละบรรทัด
 *
 * entries  รายการยอดขายที่ยังไม่ถูกออกบิล (จาก /api/sales-entries)
 * onChange('select' | 'value') — 'select' = ติ๊กเปลี่ยน (ชุดบรรทัดเปลี่ยน) · 'value' = ตัวเลขบรรทัดเดิมเปลี่ยน
 *
 * สร้างตารางครั้งเดียวแล้วแก้เฉพาะช่องที่เปลี่ยน — ถ้าวาดใหม่ทุกครั้งที่กดแป้น
 * ช่องที่กำลังพิมพ์ถูกสร้างใหม่ เคอร์เซอร์หลุด พิมพ์ต่อไม่ได้ (เหตุผลเดียวกับแถวค่าใช้จ่าย/ส่วนลด)
 */
export function billLineEditor({ entries, onChange = () => {} }) {
  /*
   * สถานะของแต่ละบรรทัดอยู่นอกตาราง — ตั้งต้นจากค่าที่บันทึกไว้ (บิลที่ยกเลิกแล้วออกใหม่ได้วิธีคิดเดิมกลับมา)
   * billMode ของรายการที่กรอกยอดส่วนต่างไว้ในหน้ายอดขายเป็น MANUAL อยู่แล้ว (เซิร์ฟเวอร์ตั้งให้ตอนบันทึก) — ตั้งต้นจึงใช้ยอดนั้น
   * ช่องจำนวนเงิน: บรรทัดที่เป็น MANUAL อยู่ = ยอดของบรรทัด · นอกนั้นมียอดที่กรอกไว้ = ยอดนั้น (สลับมาแล้วได้เลขที่กรอกไว้ทันที)
   */
  const state = new Map(entries.map((e) => [e.id, {
    mode: e.billMode === 'MANUAL' ? 'MANUAL' : 'PCT',
    pct: e.commissionPct === null || e.commissionPct === undefined ? '' : String(e.commissionPct),
    amount: String(e.billMode !== 'MANUAL' && presetOf(e) !== null ? presetOf(e) : (e.commissionAmount ?? '')),
    // ยังไม่เคยพิมพ์ช่องจำนวนเงิน — สลับเป็น "กรอกยอดเอง" แล้วเติมยอดที่ % คิดได้ตอนนั้นให้ แก้ต่อจากเลขนั้นง่ายกว่า
    // (มียอดที่กรอกไว้ในหน้ายอดขาย = ถือว่ามีเลขในช่องแล้ว ไม่เอายอดจาก % มาทับ)
    amountTouched: e.billMode === 'MANUAL' || presetOf(e) !== null,
  }]));
  const selected = new Set(entries.map((e) => e.id)); // ค่าเริ่มต้น: เลือกทั้งหมด
  const byId = new Map(entries.map((e) => [e.id, e]));
  const refs = new Map();

  /** ยอดที่จะเรียกเก็บของบรรทัดนี้ตามวิธีคิดที่เลือก — { amount, error? } (ผิดรูปแบบ = นับเป็น 0 ไว้ก่อน) */
  const lineResult = (e) => {
    const s = state.get(e.id);
    if (s.mode === 'MANUAL') {
      const r = parseAmount(s.amount, e.grossAmount);
      if (r.empty) return { amount: 0, error: `สินค้า ${e.sku}: ต้องใส่ยอดที่เรียกเก็บ (หรือเปลี่ยนเป็นคิดจากยอดเต็ม × %)` };
      if (r.error) return { amount: 0, error: `สินค้า ${e.sku}: ${r.error}` };
      return { amount: r.value };
    }
    const p = parsePct(s.pct);
    if (p.error) return { amount: 0, error: `สินค้า ${e.sku}: % ${p.error}` };
    // เว้น % ว่าง = ใช้ % เดิมของรายการ (เซิร์ฟเวอร์ก็ใช้ค่านี้เมื่อไม่ได้ส่ง pct มา)
    const usePct = p.empty ? (e.commissionPct ?? 0) : p.value;
    return { amount: commissionOf(e.grossAmount, usePct), pct: usePct };
  };

  const toggleAll = el('input', { type: 'checkbox', checked: true });
  const pickedCount = el('span', { class: 'sub-line' });
  const grossFoot = el('span');
  const commissionFoot = el('strong');

  const paintRow = (e) => {
    const r = refs.get(e.id);
    if (!r) return;
    const s = state.get(e.id);
    const on = selected.has(e.id);
    const manual = s.mode === 'MANUAL';
    const res = lineResult(e);
    r.mode.disabled = !on;
    r.pctIn.disabled = !on || manual;
    r.amountIn.disabled = !on;
    r.amountIn.hidden = !manual;
    r.computed.hidden = manual;
    r.computed.textContent = res.error && !manual ? '—' : money(res.amount);
    r.pctIn.classList.toggle('invalid', on && !manual && Boolean(res.error));
    r.amountIn.classList.toggle('invalid', on && manual && Boolean(res.error));
    // บอกเหตุผลใต้ช่องเลย ไม่ต้องรอกดออกบิลแล้วค่อยเจอ error ด้านบน
    r.error.textContent = on && res.error ? res.error.replace(/^สินค้า [^:]+: /, '') : '';
    /*
     * ตัวเลือกบอกยอดที่กรอกไว้ แต่ช่องจำนวนเงินยังแก้ได้ — พิมพ์เป็นเลขอื่นแล้ว บอกไว้ใต้ช่องว่าไม่ใช่ยอดที่กรอกไว้แล้ว
     * (ไม่งั้นตัวเลือกเขียนว่า "ใช้ยอดที่กรอกไว้ (8,000.00)" แต่บิลออกเป็นอีกเลขหนึ่ง)
     */
    const preset = presetOf(e);
    r.note.textContent = manual && preset !== null && !res.error && res.amount !== preset
      ? `ไม่ใช่ยอดที่กรอกไว้ (${money(preset)})`
      : '';
    r.box.closest('tr')?.classList.toggle('line-off', !on);
  };

  const paintTotals = () => {
    const t = totals();
    pickedCount.textContent = `(${t.count}/${entries.length})`;
    grossFoot.textContent = money(t.gross);
    commissionFoot.textContent = money(t.commission);
    toggleAll.checked = selected.size === entries.length;
    toggleAll.indeterminate = selected.size > 0 && selected.size < entries.length;
  };

  /** บรรทัดนี้ใช้ยอดส่วนต่างที่กรอกไว้ในหน้ายอดขายตรงตัวหรือไม่ (ไม่ใช่แค่เลือก MANUAL แล้วพิมพ์เลขอื่น) */
  const usesPreset = (e) => {
    if (state.get(e.id).mode !== 'MANUAL' || presetOf(e) === null) return false;
    const r = lineResult(e);
    return !r.error && r.amount === presetOf(e);
  };

  function totals() {
    const picked = entries.filter((e) => selected.has(e.id));
    const results = picked.map(lineResult);
    const presetCount = picked.filter(usesPreset).length;
    return {
      count: picked.length,
      gross: sumBaht(picked.map((e) => e.grossAmount)),
      commission: sumBaht(results.map((r) => r.amount)),
      // ใช้ยอดที่กรอกไว้ในหน้ายอดขาย / พิมพ์ยอดเองตอนออกบิล — นับแยกกัน คนออกบิลจะได้รู้ว่ายอดมาจากไหน
      presetCount,
      manualCount: picked.filter((e) => state.get(e.id).mode === 'MANUAL').length - presetCount,
      error: results.find((r) => r.error)?.error ?? null,
    };
  }

  toggleAll.addEventListener('change', () => {
    for (const e of entries) {
      if (toggleAll.checked) selected.add(e.id); else selected.delete(e.id);
      refs.get(e.id).box.checked = toggleAll.checked;
      paintRow(e);
    }
    paintTotals();
    onChange('select');
  });

  /*
   * ปุ่มลัดเปลี่ยนวิธีคิดทีเดียวทุกบรรทัด — ร้านที่มี 30 สินค้าไม่ต้องไล่เปลี่ยนช่องทีละบรรทัด
   * ใช้กับทุกบรรทัด (รวมที่ไม่ได้ติ๊ก — ติ๊กกลับมาทีหลังได้วิธีเดียวกับที่เหลือ)
   * "ใช้ยอดที่กรอกไว้" แตะเฉพาะบรรทัดที่มียอดที่กรอกไว้ — บรรทัดอื่นไม่มีเลขให้ใช้ คงวิธีเดิมไว้
   */
  const setMode = (e, mode, amount) => {
    const s = state.get(e.id);
    const r = refs.get(e.id);
    s.mode = mode;
    r.mode.value = mode;
    if (amount !== undefined) {
      s.amount = String(amount);
      s.amountTouched = true;
      r.amountIn.value = s.amount;
    }
    paintRow(e);
  };
  const withPreset = entries.filter((e) => presetOf(e) !== null);
  const usePresetAll = el('button', {
    type: 'button',
    class: 'btn ghost sm',
    title: 'บรรทัดที่กรอกยอดส่วนต่างไว้ในหน้ายอดขาย ใช้ยอดนั้น (บรรทัดอื่นคงวิธีเดิม)',
    onclick: () => {
      for (const e of withPreset) setMode(e, 'MANUAL', presetOf(e));
      paintTotals();
      onChange('value');
    },
  }, `ใช้ยอดที่กรอกไว้ทุกรายการ (${withPreset.length})`);
  const usePctAll = el('button', {
    type: 'button',
    class: 'btn ghost sm',
    title: 'ทุกบรรทัดคิดจากยอดเงินเต็ม × % (ใช้ % ในช่องของแต่ละบรรทัด)',
    onclick: () => {
      for (const e of entries) setMode(e, 'PCT');
      paintTotals();
      onChange('value');
    },
  }, 'คิดจาก % ทุกรายการ');

  const grid = table([
    {
      // ป้ายเป็นข้อความเสมอ — บนมือถือตารางพลิกเป็นการ์ดแล้วใช้ป้ายนี้บอกว่าช่องคืออะไร
      label: 'เลือก',
      render: (e) => {
        const box = el('input', { type: 'checkbox', checked: true, 'aria-label': `เลือก ${e.sku}` });
        box.addEventListener('change', () => {
          if (box.checked) selected.add(e.id); else selected.delete(e.id);
          paintRow(e);
          paintTotals();
          onChange('select');
        });
        refs.set(e.id, { ...(refs.get(e.id) ?? {}), box });
        return box;
      },
    },
    // สินค้ากลุ่มเป็นบรรทัดเดียว คิด % ของกลุ่ม — บรรทัด "ประกอบด้วย" ให้คนออกบิลเห็นว่าในชุดมีอะไร
    { label: 'สินค้า', render: (e) => lineProductCell(e) },
    { label: 'ยอดเงินเต็ม', num: true, render: (e) => money(e.grossAmount) },
    {
      label: 'วิธีคิด',
      render: (e) => {
        const s = state.get(e.id);
        const mode = el('select', { class: 'line-mode', 'aria-label': `วิธีคิดยอดของ ${e.sku}` },
          ...billModes(e).map((o) => el('option', { value: o.value, selected: o.value === s.mode }, o.label)));
        mode.addEventListener('change', () => {
          if (mode.value === 'MANUAL' && !s.amountTouched) {
            const current = lineResult(e);
            s.amount = String(current.error ? e.commissionAmount : current.amount);
            refs.get(e.id).amountIn.value = s.amount;
          }
          s.mode = mode.value;
          paintRow(e);
          paintTotals();
          onChange('value');
        });
        refs.set(e.id, { ...(refs.get(e.id) ?? {}), mode });
        return mode;
      },
    },
    {
      label: '%',
      num: true,
      render: (e) => {
        const s = state.get(e.id);
        const pctIn = numberInput('line-pct', s.pct, e.commissionPct ?? '');
        pctIn.min = '0';
        pctIn.max = '100';
        pctIn.setAttribute('aria-label', `% ของ ${e.sku}`);
        pctIn.addEventListener('input', () => {
          s.pct = pctIn.value;
          paintRow(e);
          paintTotals();
          onChange('value');
        });
        refs.set(e.id, { ...(refs.get(e.id) ?? {}), pctIn });
        return pctIn;
      },
    },
    {
      label: 'ยอดที่เรียกเก็บ',
      num: true,
      render: (e) => {
        const s = state.get(e.id);
        const amountIn = numberInput('line-amount', s.amount, 'บาท');
        amountIn.setAttribute('aria-label', `ยอดที่เรียกเก็บของ ${e.sku}`);
        amountIn.addEventListener('input', () => {
          s.amount = amountIn.value;
          s.amountTouched = true;
          paintRow(e);
          paintTotals();
          onChange('value');
        });
        const computed = el('span', { class: 'line-computed' });
        const error = el('span', { class: 'line-error' });
        const note = el('span', { class: 'line-note' });
        refs.set(e.id, { ...(refs.get(e.id) ?? {}), amountIn, computed, error, note });
        return el('div', { class: 'line-cell' }, computed, amountIn, error, note);
      },
    },
  ], entries, {
    // เรียงลำดับไม่ได้โดยตั้งใจ — การเรียงคือวาดแถวใหม่ทั้งหมด ช่องที่กรอกค้างไว้จะถูกสร้างใหม่
    sortable: false,
    footer: ['', 'รวมที่เลือก', grossFoot, '', '', commissionFoot],
  });

  for (const e of entries) paintRow(e);
  paintTotals();

  const node = el('div', { class: 'line-editor' },
    // "เลือกทั้งหมด" + ปุ่มลัดอยู่เหนือตาราง ไม่ใช่ในหัวตาราง — บนมือถือหัวตารางถูกซ่อน ปุ่มพวกนี้จะหายไปด้วย
    el('div', { class: 'line-tools' },
      el('label', { class: 'check-all' }, toggleAll, 'เลือกทั้งหมด', pickedCount),
      withPreset.length ? usePresetAll : '',
      usePctAll),
    grid);

  return {
    node,
    entries,
    entry: (id) => byId.get(id),
    isSelected: (id) => selected.has(id),
    selectedIds: () => entries.filter((e) => selected.has(e.id)).map((e) => e.id),
    /** ยอดที่เรียกเก็บจริงของบรรทัด (หลังเลือกวิธีคิด) */
    effective: (e) => lineResult(e).amount,
    totals,
    /** ตรวจก่อนส่ง — throw ข้อความภาษาไทยให้ฟอร์มค้างไว้พร้อมบอกว่าต้องแก้บรรทัดไหน */
    validate() {
      const t = totals();
      if (!t.count) throw new Error('เลือกอย่างน้อยหนึ่งรายการที่จะเรียกเก็บ');
      if (t.error) throw new Error(t.error);
    },
    /** lines ที่ส่งให้เซิร์ฟเวอร์ — ส่งทุกบรรทัดที่เลือก เซิร์ฟเวอร์บันทึกเฉพาะบรรทัดที่ค่าเปลี่ยนจริง */
    linesPayload() {
      return entries.filter((e) => selected.has(e.id)).map((e) => {
        const s = state.get(e.id);
        if (s.mode === 'MANUAL') {
          return { entryId: e.id, mode: 'MANUAL', amount: parseAmount(s.amount, e.grossAmount).value };
        }
        // โหมด % ห้ามส่ง amount ไปด้วย (เซิร์ฟเวอร์ตอบ 400 เพราะไม่รู้ว่าจะเชื่อตัวไหน)
        const p = parsePct(s.pct);
        return { entryId: e.id, mode: 'PCT', ...(p.value !== undefined ? { pct: p.value } : {}) };
      });
    },
  };
}

/**
 * ข้อความเงื่อนไขดีลแบบสั้น: "5% ของยอดเต็ม + เหมา 300.00/รอบ"
 * % ของดีลคิดจากยอดขายเต็มเสมอ (เจ้าของระบบบังคับแบบเดียว) — ดีลเก่าที่เคยตั้งเป็น "ส่วนต่าง" ถูกย้ายเป็นยอดเต็มหมดแล้ว
 */
export function dealTerms(deal) {
  if (!deal) return '—';
  const parts = [];
  if (deal.pct !== null && deal.pct !== undefined) parts.push(`${pct(deal.pct)} ของยอดเต็ม`);
  if (deal.fixedAmount) parts.push(`เหมา ${money(deal.fixedAmount)}/รอบ`);
  return parts.join(' + ') || 'ไม่มีค่าคอม';
}
