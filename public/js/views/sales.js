import { api, qs } from '../api.js';
import {
  badge, card, confirmAction, el, formModal, int, money, pct, periodBar, stat, table, toast, totalCell, usdNote, usdOf,
} from '../ui.js';
import { periodOptions, periodRange, setWorkingPeriod, workingPeriod } from '../period.js';
import { render } from '../app.js';
import { activityButton } from './activity.js';
import { usdRateChip } from './periodRate.js';
import { viewState } from '../viewState.js';
import { avatar } from '../charts.js';
import { commissionOf, componentsLine, groupBadge, parseAmount, parseGross, presetOf, sumBaht } from './billLines.js';

const FRANCHISE_KEY = 'franchise.salesFranchise';

/*
 * ตัวเลขที่พิมพ์ไว้แต่ยังไม่ได้บันทึก — เก็บนอกหน้า ไม่ให้หายตอนหน้าวาดใหม่
 * เดิมกดบันทึกแถวหนึ่ง หน้าวาดใหม่ทั้งหน้า แล้วตัวเลขที่พิมพ์ค้างในแถวอื่นหายเงียบ ๆ
 * key = รอบ|สินค้า — เปลี่ยนรอบไปดูแล้วกลับมา ตัวเลขของรอบนั้นยังอยู่
 * value = { gross, manual } ข้อความในสองช่องของแถวนั้นทั้งคู่ (ไม่ใช่เฉพาะช่องที่เปลี่ยน)
 *   — "บันทึกทั้งหมด" ส่งได้ครบทั้งที่แถวนั้นอาจไม่อยู่บนจอ (ตัวกรองร้านซ่อนไว้) และตรวจกติกาได้จากตัวมันเอง
 */
const drafts = new Map();

/**
 * ตรวจตัวเลขของแถวก่อนส่ง — กติกาเดียวกับเซิร์ฟเวอร์ (เซิร์ฟเวอร์ตรวจซ้ำและเป็นคนตัดสิน)
 * ยอดเต็มต้องมี · ยอดส่วนต่างที่กรอกเองไม่บังคับ แต่ถ้ามีต้องอยู่ระหว่าง 0 ถึงยอดเต็ม (เครื่องหมายเดียวกัน — รอบคืนของติดลบได้)
 * คืน { gross, manual (ตัวเลข | null) } หรือ { error, field: 'gross' | 'manual' }
 */
function checkRow({ gross, manual }) {
  const g = parseGross(gross);
  if (g.empty) return { error: 'ใส่ยอดขายเต็มก่อน — ยอดส่วนต่างที่กรอกเองใช้คู่กับยอดเต็มเสมอ', field: 'gross' };
  if (g.error) return { error: `ยอดขายเต็ม: ${g.error}`, field: 'gross' };
  const m = parseAmount(manual, g.value);
  if (m.error) {
    return {
      error: m.error.startsWith('ยอดที่เรียกเก็บ')
        ? `ยอดส่วนต่างต้องอยู่ระหว่าง 0 ถึงยอดเต็ม (${money(g.value)} บาท)`
        : `ยอดส่วนต่างที่กรอกเอง: ${m.error}`,
      field: 'manual',
    };
  }
  return { gross: g.value, manual: m.empty ? null : m.value };
}

/** ส่วนต่างที่ % ให้ (ยอดเต็ม × %) ของยอดที่บันทึกแล้ว — เซิร์ฟเวอร์ส่ง pctAmount มา (รุ่นก่อน 2.3.0 ไม่มี = คิดเองแบบเดียวกัน) */
const pctAmountOf = (entry) => entry.pctAmount ?? commissionOf(entry.grossAmount, entry.commissionPct ?? 0);

/**
 * "ออกบิลจะใช้ยอดไหน" ของยอดที่บันทึกแล้ว — [คำอธิบาย, ยอด]
 * MANUAL ที่ตรงกับยอดที่กรอกไว้ = ยอดจากหน้านี้ · MANUAL ที่ไม่ตรง = ยอดที่กำหนดตอนออกบิล (บิลเดิมถูกยกเลิก ยอดกลับมารอออกใหม่ หรือออกบิลไปแล้ว)
 */
function usedOf(entry) {
  const preset = presetOf(entry);
  if (entry.billMode === 'MANUAL') {
    return preset !== null && preset === entry.commissionAmount
      ? ['ยอดที่กรอกเอง', entry.commissionAmount, 'PRESET']
      : ['ยอดที่กำหนดตอนออกบิล', entry.commissionAmount, 'BILL'];
  }
  return [`ยอดเต็ม × ${pct(entry.commissionPct)} =`, entry.commissionAmount, 'PCT'];
}

/** บรรทัดเล็ก "ออกบิลจะใช้: …" ใต้ช่องยอดส่วนต่าง — ตัวเลขที่บิลจะใช้ตัวหนา ให้กวาดตาเทียบกับคอลัมน์ข้าง ๆ ได้ */
const usedLine = (prefix, [label, amount], { unsaved = false } = {}) => el('div',
  { class: `sub-line used-line${unsaved ? ' unsaved' : ''}` },
  `${prefix} ${label} `, el('strong', {}, money(amount)));

// ปิดแท็บ/รีเฟรชขณะที่ยังมีตัวเลขไม่ได้บันทึก — ให้เบราว์เซอร์ถามก่อน
window.addEventListener('beforeunload', (e) => {
  if (drafts.size) e.preventDefault();
});

export async function salesView() {
  const periodCode = workingPeriod();
  const franchiseFilter = viewState.getItem(FRANCHISE_KEY) ?? '';
  const range = periodRange(periodCode);

  const [entriesRes, productsRes, franchises, period] = await Promise.all([
    api.get(`/api/sales-entries${qs({ periodCode, franchiseId: franchiseFilter })}`),
    api.get(`/api/products${qs({ status: 'ACTIVE', franchiseId: franchiseFilter, onDate: range.end })}`),
    api.get('/api/franchises').then((r) => r.items),
    api.get(`/api/periods/${periodCode}`),
  ]);

  const entryByProduct = new Map(entriesRes.items.map((e) => [e.productId, e]));

  // สินค้าที่มีเจ้าของสิทธิ์ขายในรอบนี้ = แถวที่ต้องกรอกยอด
  const activeRows = productsRes.items
    .filter((p) => p.currentAssignment)
    .map((p) => ({ product: p, entry: entryByProduct.get(p.id) ?? null }));

  /*
   * ยอดที่บันทึกไว้ในรอบนี้แต่ไม่เข้าแถวของสินค้าที่ใช้งาน — สินค้าถูกปิดใช้งาน/ถูกลบ หรือร้านเจ้าของยอดถูกลบ
   * (สัญญาของร้านที่ถูกลบไม่นับเป็นเจ้าของสิทธิ์ขายแล้ว แม้ในรอบเก่าที่ร้านเคยถือ — สินค้าจึงไม่มีแถวให้ยอดนั้นไปอยู่)
   * ถ้าไม่โชว์ ยอดพวกนี้จะหายไปจากหน้าจอทั้งที่ยังถูกนับในยอดรวม (และของที่ปิดใช้งานยังออกบิลได้)
   * โชว์เป็นแถวอ่านอย่างเดียว (กรอกยอดใหม่ไม่ได้ — เซิร์ฟเวอร์ปฏิเสธ) แต่ยังลบยอดที่ยังไม่ออกบิลได้
   * ของที่ถูกลบ = ลบแบบซ่อนเพราะมีบิลอ้างถึง (ที่ไม่เคยมียอดถูกลบทิ้งจริง ไม่มียอดให้โผล่ที่นี่) — ยอดของมันจึงออกบิลไปแล้วแทบทั้งหมด
   * ดึงสถานะสินค้าเฉพาะตอนมียอด (หรือตัวเลขที่พิมพ์ค้าง) ที่ไม่เข้าแถวไหนเลย — ปกติไม่ต้องยิงเพิ่ม
   */
  const shownIds = new Set(activeRows.map((r) => r.product.id));
  const orphans = entriesRes.items.filter((e) => !shownIds.has(e.productId));
  // ตัวเลขที่พิมพ์ค้างของสินค้าที่ไม่มีแถวในหน้านี้ — อาจถูกปิดใช้งาน/ลบไปแล้ว หรือแค่ถูกตัวกรองร้านซ่อนไว้
  const strayDraftIds = [...drafts.keys()]
    .filter((k) => k.startsWith(`${periodCode}|`))
    .map((k) => Number(k.split('|')[1]))
    .filter((id) => !shownIds.has(id));
  /*
   * รายการสินค้า/ร้านไม่เคยส่งของที่ถูกลบมา (ทุกแท็บ ทุกตัวกรอง) — ไม่อยู่ในรายการเลย = ถูกลบแล้ว
   * ดึงสินค้าทุกสถานะทีเดียว (ไม่ใช่แค่ ARCHIVED) เพื่อแยก "ปิดใช้งาน" / "ลบแล้ว" / "ยังใช้งาน" ออกจากกันได้
   * รายชื่อร้านโหลดไว้แล้วสำหรับตัวกรองด้านบน ใช้ตัวเดียวกันบอกว่าร้านไหนถูกลบ
   */
  const statusById = (orphans.length || strayDraftIds.length)
    ? new Map((await api.get('/api/products')).items.map((p) => [p.id, p.status]))
    : new Map();
  const stateOf = (productId) => statusById.get(productId) ?? 'DELETED';
  const liveShopIds = new Set(franchises.map((f) => f.id));
  const retiredRows = orphans
    .filter((e) => stateOf(e.productId) !== 'ACTIVE' || !liveShopIds.has(e.franchiseId))
    .map((e) => ({
      readOnly: true,
      // สถานะสินค้า 'ARCHIVED' | 'DELETED' หรือ null (สินค้ายังใช้งาน แต่ร้านถูกลบ) — ใช้เลือกป้ายและคำอธิบายว่าทำไมแก้ไม่ได้
      retired: stateOf(e.productId) === 'ACTIVE' ? null : stateOf(e.productId),
      shopDeleted: !liveShopIds.has(e.franchiseId),
      product: {
        id: e.productId,
        sku: e.sku,
        name: e.productName,
        status: stateOf(e.productId),
        commissionPct: e.commissionPct,
        isGroup: Boolean(e.isGroup),
        items: e.components ?? [],
        currentAssignment: { franchiseUsername: e.franchiseUsername },
      },
      entry: e,
    }));
  /*
   * ตัวเลขที่พิมพ์ค้างไว้ของสินค้าที่เพิ่งถูกปิดใช้งาน/ลบ บันทึกไม่ได้แล้ว — ไม่ให้ค้างนับในปุ่ม "บันทึกทั้งหมด"
   * ต้องดูทุกตัวเลขค้างที่ไม่มีแถว ไม่ใช่แค่แถวที่มียอดบันทึกไว้แล้ว: สินค้าที่เพิ่งพิมพ์ยอดแรกแล้วถูกปิดใช้งาน
   * ไม่มีแถวให้เห็น แต่ปุ่มค้าง "(1)" กดแล้วพังทุกครั้ง และเบราว์เซอร์ถามทุกครั้งที่ปิด/รีเฟรช
   * ลบเฉพาะของสินค้าที่ปิดใช้งาน/ลบจริง — ของร้านอื่นที่ตัวกรองซ่อนไว้ยังบันทึกผ่าน "บันทึกทั้งหมด" ได้ตามปกติ
   */
  for (const id of strayDraftIds) if (stateOf(id) !== 'ACTIVE') drafts.delete(`${periodCode}|${id}`);
  // นับทีละเหตุผล (แถวหนึ่งนับที่เดียว: สินค้าก่อน แล้วค่อยร้าน) — ใช้บอกใต้หัวตารางว่าแถวอ่านอย่างเดียวมาจากไหน
  const archivedCount = retiredRows.filter((r) => r.retired === 'ARCHIVED').length;
  const deletedCount = retiredRows.filter((r) => r.retired === 'DELETED').length;
  const deletedShopCount = retiredRows.filter((r) => !r.retired && r.shopDeleted).length;
  const rows = [...activeRows, ...retiredRows];

  // ยอดส่วนต่างรวมของรอบ ใช้โชว์ตัวอย่างการแปลงเป็นดอลลาร์ในฟอร์มตั้งอัตรา
  const summaryCommission = entriesRes.summary.commissionTotal;

  const periodPicker = el('select', {
    onchange: (e) => { setWorkingPeriod(e.target.value); render(); },
  }, ...periodOptions().map((o) => el('option', { value: o.value, selected: o.value === periodCode }, o.label)));

  const franchisePicker = el('select', {
    onchange: (e) => { viewState.setItem(FRANCHISE_KEY, e.target.value); render(); },
  },
  el('option', { value: '', selected: franchiseFilter === '' }, 'ทุกร้าน'),
  ...franchises.map((f) => el('option', { value: String(f.id), selected: String(f.id) === franchiseFilter }, f.username)));

  /*
   * เซลล์ของแถวหนึ่งสร้างพร้อมกันทีเดียว เพราะช่องกรอกกับช่องส่วนต่างต้องคุยกัน
   * (พิมพ์ยอดแล้วส่วนต่างอัปเดตสด) แล้วเก็บไว้ใน cache เพื่อไม่ให้ค่าที่พิมพ์ค้างไว้
   * หายตอนผู้ใช้กดเรียงคอลัมน์หรือค้นหา ซึ่งทำให้ table() วาดแถวใหม่
   */
  const cellCache = new Map();

  /*
   * บันทึกทุกแถวที่พิมพ์ค้างไว้ในครั้งเดียว — เดิมต้องกดบันทึกทีละแถว 50 สินค้า = 50 รอบ
   * ปุ่มนับจากตัวเลขที่ยังไม่บันทึกของรอบนี้ อัปเดตทุกครั้งที่พิมพ์
   */
  const draftsOfPeriod = () => [...drafts].filter(([key]) => key.startsWith(`${periodCode}|`));
  const saveAll = el('button', { class: 'btn', hidden: true });
  const syncSaveAll = () => {
    const n = draftsOfPeriod().length;
    saveAll.hidden = n === 0;
    saveAll.textContent = `💾 บันทึกทั้งหมด (${n})`;
  };
  syncSaveAll();
  // ชื่อสินค้าไว้บอกในข้อความว่าแถวไหนยังบันทึกไม่ได้ (แถวที่ตัวกรองซ่อนไว้ไม่มีชื่อในหน้านี้ — ใช้เลขสินค้าแทน)
  const skuOf = (productId) => activeRows.find((r) => r.product.id === productId)?.product.sku ?? `สินค้า #${productId}`;
  saveAll.addEventListener('click', async () => {
    const pending = draftsOfPeriod();
    if (!pending.length) return;
    /*
     * ตรวจทุกแถวก่อนส่ง — แถวที่ผิดกติกาไม่ส่ง (ค้างไว้ให้แก้พร้อมเหตุผลใต้ช่อง) แถวที่ถูกส่งไปก่อน
     * ส่ง manualAmount ทุกแถวเสมอ (ตัวเลข หรือ null = ไม่ได้กรอก/ลบทิ้ง) — ไม่ส่งเลย เซิร์ฟเวอร์จะคงยอดเดิมไว้
     * ช่องที่ผู้ใช้ลบเลขออกจึงต้องส่ง null ไปบอกตรง ๆ ไม่งั้นยอดเก่ากลับมาเงียบ ๆ
     */
    const items = [];
    const invalid = [];
    for (const [key, draft] of pending) {
      const productId = Number(key.split('|')[1]);
      const check = checkRow(draft);
      if (check.error) invalid.push({ productId, message: check.error });
      else items.push({ periodCode, productId, grossAmount: draft.gross, manualAmount: check.manual });
    }
    const invalidNote = invalid.length
      ? `ยังบันทึกไม่ได้ ${invalid.length} แถว: ${skuOf(invalid[0].productId)} — ${invalid[0].message}`
      : '';
    if (!items.length) {
      toast(invalidNote, 'error');
      return;
    }
    saveAll.disabled = true;
    try {
      const res = await api.post('/api/sales-entries/bulk', { items });
      // แถวที่บันทึกไม่ผ่านยังค้างไว้ให้แก้ — ไม่ทิ้งตัวเลขที่พิมพ์ไว้
      const failed = new Set([...res.errors.map((x) => x.productId), ...invalid.map((x) => x.productId)]);
      for (const [key] of pending) if (!failed.has(Number(key.split('|')[1]))) drafts.delete(key);
      if (res.errors.length) {
        toast(`บันทึก ${res.saved.length} แถว · ไม่ผ่าน ${res.errors.length} แถว: ${res.errors[0].message}`
          + (invalidNote ? ` · ${invalidNote}` : ''), 'error');
      } else if (invalidNote) {
        toast(`บันทึก ${res.saved.length} แถว · ${invalidNote}`, 'error');
      } else {
        toast(`บันทึกแล้ว ${res.saved.length} แถว`, 'success');
      }
      render();
    } catch (err) {
      toast(err.fullMessage ?? err.message, 'error');
      saveAll.disabled = false;
    }
  });

  /*
   * แถวอ่านอย่างเดียว (สินค้าปิดใช้งาน/ถูกลบ หรือร้านถูกลบ) — ยอดเป็นตัวหนังสือ แก้ไม่ได้ · ลบยอดได้ถ้ายังไม่ออกบิล
   * (ของที่ถูกลบมียอดยังไม่ออกบิลได้เฉพาะตอนบิลเก่าถูกยกเลิกทีหลัง — ลบยอดนั้นได้ แต่กรอกใหม่ไม่ได้อีกเลย)
   * ข้อความบอกเหตุผลเรียงตามที่แก้ได้ยากสุดก่อน: สินค้าถูกลบ → ร้านถูกลบ → สินค้าปิดใช้งาน (เปิดกลับได้)
   */
  function retiredCells(row) {
    const invoiced = row.entry.status === 'INVOICED';
    const negative = row.entry.grossAmount < 0;
    const [why, afterDelete] = row.retired === 'DELETED'
      ? ['สินค้านี้ถูกลบแล้ว — ยอดนี้แก้ไม่ได้ (บิลเก่ายังแสดงสินค้านี้ตามเดิม)', 'สินค้านี้ถูกลบแล้ว ลบยอดแล้วกรอกใหม่ไม่ได้อีก']
      : row.shopDeleted
        ? [`ร้าน ${row.entry.franchiseUsername} ถูกลบแล้ว — ยอดนี้แก้ไม่ได้ (บิลเก่ายังแสดงร้านนี้ตามเดิม)`, `ร้าน ${row.entry.franchiseUsername} ถูกลบแล้ว ลบยอดแล้วกรอกให้ร้านนี้ใหม่ไม่ได้อีก`]
        : ['สินค้านี้ถูกปิดใช้งานแล้ว — เปิดใช้งานที่หน้าสินค้าก่อนจึงจะกรอก/แก้ยอดได้', 'สินค้านี้ปิดใช้งานแล้ว ลบแล้วกรอกใหม่ไม่ได้จนกว่าจะเปิดใช้งาน'];
    const preset = presetOf(row.entry);
    return {
      amount: el('div', { class: 'amount-cell', title: why }, el('strong', {}, money(row.entry.grossAmount))),
      commission: el('div', { class: 'commission-cell' },
        el(preset === null ? 'strong' : 'span', { style: negative ? 'color:var(--danger)' : '' }, money(pctAmountOf(row.entry))),
        negative ? el('div', { class: 'sub-line' }, 'ยอดคืน') : ''),
      manual: el('div', { class: 'commission-cell' },
        preset === null ? el('span', { class: 'muted' }, '—') : el('strong', {}, money(preset)),
        usedLine(invoiced ? 'ออกบิลแล้ว ใช้:' : 'ออกบิลจะใช้:', usedOf(row.entry))),
      actions: el('div', { class: 'btn-row' },
        invoiced
          ? ''
          : el('button', {
            class: 'btn ghost sm danger',
            onclick: () => confirmAction(`ลบยอดของ ${row.product.sku} ในรอบนี้? (${afterDelete})`, async () => {
              await api.del(`/api/sales-entries/${row.entry.id}`);
              toast('ลบแล้ว', 'success');
              render();
            }),
          }, 'ลบ')),
    };
  }

  function cellsOf(row) {
    if (cellCache.has(row)) return cellCache.get(row);
    if (row.readOnly) {
      const cells = retiredCells(row);
      cellCache.set(row, cells);
      return cells;
    }

    /*
     * % ของยอดที่บันทึกแล้วใช้ค่าที่ snapshot ไว้กับรายการ · ตัวเลขที่ยังไม่บันทึกใช้ % ปัจจุบันของสินค้า
     * (บันทึกยอดใหม่ เซิร์ฟเวอร์คิดด้วย % ปัจจุบันของสินค้าเสมอ — พรีวิวต้องใช้ตัวเดียวกัน)
     */
    const savedPct = row.entry?.commissionPct ?? row.product.commissionPct ?? 0;
    const draftPct = row.product.commissionPct ?? savedPct;
    const invoiced = row.entry?.status === 'INVOICED';
    const savedGross = row.entry ? row.entry.grossAmount : null;
    const savedManual = row.entry ? presetOf(row.entry) : null;

    /*
     * ยอดที่บันทึกแล้วจะถูกล็อกไว้ ต้องกด "แก้ไข" ก่อนถึงจะพิมพ์ทับได้
     * กันเผลอไปคลิกโดนช่องแล้วตัวเลขเปลี่ยนโดยไม่รู้ตัว — ตัวเลขพวกนี้คือเงินจริง
     */
    const draftKey = `${periodCode}|${row.product.id}`;
    const draft = invoiced ? undefined : drafts.get(draftKey);
    let editing = !row.entry || draft !== undefined;

    const box = el('input', {
      type: 'number',
      step: '0.01',
      inputmode: 'decimal',
      class: 'amount-input',   // ไม่ใส่ min เพราะยอดคืนสินค้าเป็นค่าติดลบได้
      value: draft?.gross ?? (row.entry ? row.entry.grossAmount : ''),
      placeholder: '0.00',
      'aria-label': `ยอดขายเต็มของ ${row.product.sku}`,
      title: invoiced
        ? 'ออกบิลไปแล้ว แก้ไม่ได้ — ต้องยกเลิกบิลก่อน'
        : row.product.isGroup ? 'สินค้ากลุ่ม — กรอกยอดขายรวมของทั้งชุดเป็นยอดเดียว' : undefined,
    });

    /*
     * ยอดส่วนต่างที่กรอกเอง (R21 · ไม่บังคับ) — ยอดบิลที่รู้อยู่แล้ว ไม่ต้องให้ระบบคิดจาก %
     * ยอดเต็มยังต้องกรอกเสมอ (รายงาน อันดับร้าน และค่าคอมเซลคิดจากยอดเต็ม)
     * ตอนออกบิลเลือกได้ทีละสินค้าว่าจะใช้ยอดนี้ หรือยอดเต็ม × % — ตั้งต้นใช้ยอดนี้ถ้ากรอกไว้
     */
    const manualBox = el('input', {
      type: 'number',
      step: '0.01',
      inputmode: 'decimal',
      class: 'amount-input manual-input',
      value: draft ? draft.manual : (savedManual ?? ''),
      placeholder: invoiced ? '—' : 'ถ้ามี',
      'aria-label': `ยอดส่วนต่างที่กรอกเองของ ${row.product.sku}`,
      title: invoiced
        ? 'ออกบิลไปแล้ว แก้ไม่ได้ — ต้องยกเลิกบิลก่อน'
        : 'ไม่บังคับ — กรอกเมื่อรู้ยอดที่จะเรียกเก็บอยู่แล้ว (0 ถึงยอดเต็ม) · เว้นว่าง = คิดจากยอดเต็ม × %',
    });

    const save = el('button', { class: 'btn sm' }, 'บันทึก');
    const edit = el('button', { class: 'btn ghost sm' }, 'แก้ไข');
    const cancel = el('button', { class: 'btn ghost sm' }, 'ยกเลิก');
    const remove = el('button', { class: 'btn ghost sm danger' }, 'ลบ');

    /*
     * ส่วนต่างที่ % ให้ คำนวณสดในคอลัมน์ "ส่วนต่างตาม %" · ยอดที่กรอกเองอยู่คอลัมน์ถัดไป
     * ใต้ช่องกรอกเองบอกว่าออกบิลจะใช้ยอดไหน — ตัวที่ใช้ตัวหนา อีกตัวจาง
     */
    const commission = el('div', { class: 'commission-cell' });
    const grossError = el('div', { class: 'line-error' });
    const manualError = el('div', { class: 'line-error' });
    const used = el('div');

    const refresh = () => {
      const rawGross = box.value.trim();
      const rawManual = manualBox.value.trim();
      // ช่องยอดเต็มว่างบนยอดที่บันทึกแล้ว = ยังไม่ได้แก้ (ลบยอดใช้ปุ่ม "ลบ") · ช่องกรอกเองว่าง = ล้างยอดที่กรอกไว้ (เปลี่ยนจริง)
      const grossChanged = rawGross !== '' && (savedGross === null || Number(rawGross) !== savedGross);
      const manualChanged = rawManual === '' ? savedManual !== null : (savedManual === null || Number(rawManual) !== savedManual);
      const dirty = editing && (grossChanged || manualChanged);
      if (dirty) drafts.set(draftKey, { gross: rawGross, manual: rawManual }); else drafts.delete(draftKey);
      syncSaveAll();

      box.disabled = !editing || invoiced;
      manualBox.disabled = !editing || invoiced;
      box.classList.toggle('dirty', dirty && grossChanged);
      manualBox.classList.toggle('dirty', dirty && manualChanged);

      const check = dirty ? checkRow({ gross: rawGross, manual: rawManual }) : null;
      box.classList.toggle('invalid', Boolean(check?.error) && check.field === 'gross');
      manualBox.classList.toggle('invalid', Boolean(check?.error) && check.field === 'manual');
      grossError.textContent = check?.error && check.field === 'gross' ? check.error : '';
      manualError.textContent = check?.error && check.field === 'manual' ? check.error : '';

      // ออกบิลแล้วแตะอะไรไม่ได้เลย · กำลังแก้ = บันทึก/ยกเลิก · ปกติ = แก้ไข/ลบ
      save.style.display = dirty ? '' : 'none';
      save.disabled = Boolean(check?.error);
      cancel.style.display = editing && row.entry ? '' : 'none';
      edit.style.display = !editing && !invoiced ? '' : 'none';
      remove.style.display = row.entry && !invoiced && !editing ? '' : 'none';

      if (dirty && check && !check.error) {
        const pctBaht = commissionOf(check.gross, draftPct);
        const manualUsed = check.manual !== null;
        commission.replaceChildren(
          el(manualUsed ? 'span' : 'strong', { class: 'unsaved' }, money(pctBaht)),
          el('div', { class: 'sub-line' }, 'ยังไม่บันทึก'));
        used.replaceChildren(usedLine('ออกบิลจะใช้:', manualUsed
          ? ['ยอดที่กรอกเอง', check.manual]
          : [`ยอดเต็ม × ${pct(draftPct)} =`, pctBaht], { unsaved: true }),
        // บันทึกใหม่ = กลับไปใช้ค่าจากหน้านี้ ยอดที่เคยกำหนดตอนออกบิล (บิลเดิมถูกยกเลิก) ไม่ติดมาด้วย
        row.entry && usedOf(row.entry)[2] === 'BILL'
          ? el('div', { class: 'sub-line' }, `แทนยอดที่กำหนดตอนออกบิลครั้งก่อน (${money(row.entry.commissionAmount)})`)
          : '');
      } else if (dirty) {
        // ตัวเลขยังผิดกติกา — ยังบอกไม่ได้ว่าบิลจะใช้ยอดไหน (เหตุผลอยู่ใต้ช่องที่ผิด) · ยอดเต็มถูกแล้วก็ยังโชว์ส่วนต่างตาม % ไว้เทียบ
        const g = parseGross(rawGross);
        commission.replaceChildren(g.value !== undefined
          ? el('span', { class: 'unsaved' }, money(commissionOf(g.value, draftPct)))
          : el('span', { class: 'muted' }, '—'));
        used.replaceChildren();
      } else if (row.entry) {
        const negative = row.entry.grossAmount < 0;
        commission.replaceChildren(
          el(row.entry.billMode === 'PCT' ? 'strong' : 'span', { style: negative ? 'color:var(--danger)' : '' },
            money(pctAmountOf(row.entry))),
          negative ? el('div', { class: 'sub-line' }, 'ยอดคืน') : '');
        used.replaceChildren(usedLine(invoiced ? 'ออกบิลแล้ว ใช้:' : 'ออกบิลจะใช้:', usedOf(row.entry)));
      } else {
        commission.replaceChildren(el('span', { class: 'muted' }, '—'));
        used.replaceChildren();
      }
    };

    box.addEventListener('input', refresh);
    manualBox.addEventListener('input', refresh);
    // กด Enter ที่ช่องไหนก็ได้ = บันทึกแถวนี้ ไม่ต้องเอื้อมไปกดปุ่ม
    const enterSaves = (e) => {
      if (e.key === 'Enter' && save.style.display !== 'none' && !save.disabled) save.click();
    };
    box.addEventListener('keydown', enterSaves);
    manualBox.addEventListener('keydown', enterSaves);

    edit.addEventListener('click', () => {
      editing = true;
      refresh();
      box.focus();
      box.select();
    });

    cancel.addEventListener('click', () => {
      editing = false;
      // คืนค่าที่บันทึกไว้ ทิ้งสิ่งที่เพิ่งพิมพ์
      box.value = savedGross ?? '';
      manualBox.value = savedManual ?? '';
      refresh();
    });

    save.addEventListener('click', async () => {
      const check = checkRow({ gross: box.value, manual: manualBox.value });
      if (check.error) {
        toast(`${row.product.sku}: ${check.error}`, 'error');
        return;
      }
      save.disabled = true;
      try {
        const saved = await api.post('/api/sales-entries', {
          periodCode,
          productId: row.product.id,
          grossAmount: box.value,
          // ส่งเสมอ — null = ไม่ได้กรอก/ลบยอดที่กรอกไว้ (ไม่ส่งเลย เซิร์ฟเวอร์จะคงยอดเดิมไว้)
          manualAmount: check.manual,
        });
        drafts.delete(draftKey);
        toast(`บันทึก ${row.product.sku} แล้ว — ออกบิลจะใช้ ${money(saved.commissionAmount)} ฿`
          + (saved.billMode === 'MANUAL' ? ' (ยอดที่กรอกเอง)' : ` (ยอดเต็ม × ${pct(saved.commissionPct)})`), 'success');
        render();
      } catch (err) {
        toast(err.fullMessage ?? err.message, 'error');
        save.disabled = false;
      }
    });

    remove.addEventListener('click', () => confirmAction(
      `ลบยอดของ ${row.product.sku} ในรอบนี้?`,
      async () => {
        await api.del(`/api/sales-entries/${row.entry.id}`);
        toast('ลบแล้ว', 'success');
        render();
      },
    ));

    refresh();

    const cells = {
      amount: el('div', { class: 'entry-cell' }, box, grossError),
      commission,
      manual: el('div', { class: 'entry-cell' }, manualBox, manualError, used),
      actions: el('div', { class: 'btn-row' }, save, edit, cancel, remove),
    };
    cellCache.set(row, cells);
    return cells;
  }

  /** ออกบิลแล้วล็อก แก้ไม่ได้ · ยังไม่ออกบิล = บันทึกแล้วพร้อมเรียกเก็บ */
  function statusCell(r) {
    if (!r.entry) return el('span', { class: 'badge gray' }, 'ยังไม่กรอก');
    if (r.entry.status !== 'INVOICED') return badge(r.entry.status);
    return el('div', {}, badge('INVOICED'),
      r.entry.invoiceNo ? el('div', { class: 'sub-line' }, r.entry.invoiceNo) : '');
  }

  /*
   * ช่อง % — โชว์ % เสมอ เพราะคอลัมน์ "ส่วนต่างตาม %" ข้าง ๆ คือยอดเต็ม × % นี้จริง ๆ (คูณตามแล้วตรง)
   * ยอดที่ใช้ยอดอื่น (กรอกเองในหน้านี้ / กำหนดตอนออกบิล) บอกไว้ใต้ช่องกรอกเองว่า "ออกบิลจะใช้" ยอดไหน
   */
  const pctCell = (r) => el('span', { class: 'muted' }, pct(r.entry?.commissionPct ?? r.product.commissionPct ?? 0));

  /*
   * สินค้ากลุ่ม (ชุด) = แถวเดียว กรอกยอดรวมของทั้งชุด คิด % ของกลุ่ม — รายการย่อยเป็นแค่ข้อมูลว่าในชุดมีอะไร
   * ยอดที่ออกบิลแล้วใช้รายการย่อยจากบรรทัดยอดขาย (เซิร์ฟเวอร์ส่ง snapshot ตอนออกบิลมา) ให้ตรงกับบิลใบนั้น
   * ยังไม่ออกบิล/ยังไม่กรอก ใช้รายการปัจจุบันของสินค้า
   * ออกบิลแล้วเชื่อบรรทัดยอดขายอย่างเดียว — สินค้าที่เพิ่งเปลี่ยนเป็นกลุ่มทีหลัง ต้องไม่โผล่ป้ายกลุ่มบนยอดที่บิลออกเป็นสินค้าเดี่ยว
   */
  const billed = (r) => Boolean(r.entry?.invoiceId);
  const componentsOf = (r) => (billed(r) ? (r.entry.components ?? []) : (r.product.items ?? []));
  const isGroupRow = (r) => (billed(r)
    ? Boolean(r.entry.isGroup || r.entry.components?.length)
    : Boolean(r.product.isGroup));

  const columns = [
    {
      label: 'สินค้า',
      sortValue: (r) => r.product.sku,
      render: (r) => el('div', {}, el('strong', {}, r.product.sku),
        isGroupRow(r) ? [' ', groupBadge()] : '',
        // ปิดใช้งาน (เทา · เปิดกลับได้) / ลบแล้ว (แดง · ถาวร) — ป้ายเดียวกับหน้าอื่นจาก badge()
        r.retired ? [' ', badge(r.retired)] : '',
        el('div', { class: 'sub-line' }, r.product.name),
        isGroupRow(r) ? componentsLine(componentsOf(r), { short: true }) : ''),
    },
    {
      label: 'ร้านค้า',
      sortValue: (r) => r.product.currentAssignment.franchiseUsername,
      // ร้านที่ถูกลบยังโชว์ชื่อเดิม (ยอด/บิลเก่าอ้างถึง) พร้อมป้าย "ลบแล้ว" — ไม่ให้เข้าใจว่ายังเป็นร้านที่ต้องกรอกยอด
      render: (r) => (r.shopDeleted
        ? el('div', { style: 'display:inline-flex;align-items:center;gap:6px' },
          avatar(r.product.currentAssignment.franchiseUsername, { sub: '' }), badge('DELETED'))
        : avatar(r.product.currentAssignment.franchiseUsername, { sub: '' })),
    },
    { label: 'ยอดขายเต็ม (บาท)', num: true, sortValue: (r) => r.entry?.grossAmount ?? -Infinity, render: (r) => cellsOf(r).amount },
    { label: '%', num: true, sortValue: (r) => r.entry?.commissionPct ?? r.product.commissionPct ?? 0, render: pctCell },
    // ป้ายคอลัมน์เป็นข้อความทุกช่อง — บนมือถือตารางพลิกเป็นการ์ดแล้วใช้ป้ายนี้บอกว่าตัวเลขคืออะไร
    { label: 'ส่วนต่างตาม %', num: true, sortValue: (r) => (r.entry ? pctAmountOf(r.entry) : -Infinity), render: (r) => cellsOf(r).commission },
    {
      label: 'ยอดส่วนต่างที่กรอกเอง (ถ้ามี)',
      num: true,
      sortValue: (r) => presetOf(r.entry) ?? -Infinity,
      render: (r) => cellsOf(r).manual,
    },
    { label: 'สถานะ', render: statusCell, sortValue: (r) => r.entry?.status ?? '' },
    { label: '', sortable: false, render: (r) => cellsOf(r).actions },
  ];

  const summary = entriesRes.summary;
  // "กรอกแล้ว x / y" นับเฉพาะสินค้าที่ใช้งานอยู่ — ของที่ปิดใช้งานไม่ใช่งานที่ต้องกรอก
  const filled = activeRows.filter((r) => r.entry).length;
  const notInvoiced = entriesRes.items.filter((e) => e.status !== 'INVOICED');
  const billable = notInvoiced.length;
  const pendingCommission = Number(notInvoiced.reduce((sum, e) => sum + e.commissionAmount, 0).toFixed(2));
  const invoicedCommission = Number((summary.commissionTotal - pendingCommission).toFixed(2));
  // ทั้งหน้าเป็นยอดของรอบเดียว — เทียบดอลลาร์ด้วยอัตราของรอบนี้ (ยังไม่ได้ตั้ง = อัตราล่าสุด · เซิร์ฟเวอร์เลือกมาให้ใน fxRate)
  const usd = (baht) => usdOf(baht, period.fxRate);

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'ยอดขายรายรอบครึ่งเดือน'),
        // รอบบิลอยู่ในแถบกลางแล้ว ไม่ต้องพูดซ้ำตรงนี้อีก
        el('p', {}, 'กรอกยอดเงินเต็มของแต่ละสินค้า ระบบคิดส่วนต่างให้อัตโนมัติ')),
      // รอบบิล + อัตราแลกเปลี่ยนของรอบนั้น อยู่ก้อนเดียวกันกลางหัวหน้า
      periodBar(periodPicker, {
        extra: usdRateChip(period, { baseAmount: summaryCommission }),
      }),
      el('div', { class: 'btn-row' },
        activityButton(['entry'], { title: 'ประวัติการกรอกยอดขาย' }),
        billable > 0 && el('a', { class: 'btn', href: '#/invoices' }, `ไปออกใบเรียกเก็บ (${billable})`))),


    el('div', { class: 'stat-grid' },
      stat('กรอกแล้ว', `${filled} / ${activeRows.length}`, 'สินค้าที่มีสิทธิ์ขายในรอบนี้',
        { tone: filled === activeRows.length && activeRows.length ? 'income' : 'due', icon: '📝' }),
      stat('ยอดขายเต็ม', money(summary.grossTotal) + ' ฿', `${int(summary.count)} รายการ`,
        { tone: 'sales', icon: '🛒', usd: usd(summary.grossTotal) }),
      stat('ออกบิลไปแล้ว', money(invoicedCommission) + ' ฿',
        `${int(entriesRes.items.length - billable)} รายการ — ตัวเลขนี้ตรงกับหน้า "ใบเรียกเก็บ"`,
        { tone: 'income', icon: '💰', usd: usd(invoicedCommission) }),
      // แยกให้เห็นว่าส่วนไหนขึ้นบิลแล้ว ส่วนไหนยัง — ไม่งั้นเลขหน้านี้จะดูไม่ตรงกับหน้าใบเรียกเก็บ
      stat('ยังไม่ได้เรียกเก็บ', money(pendingCommission) + ' ฿', `${int(billable)} รายการ รอออกบิล`,
        { tone: billable ? 'due' : 'muted', icon: '⏳', usd: usd(pendingCommission) })),

    // ตัวกรองร้านอยู่ชิดขวาคู่กับหัวข้อตาราง แทนที่จะลอยเดี่ยว ๆ เป็นแถวของตัวเอง
    el('div', { class: 'toolbar' },
      el('h2', { class: 'section-title' }, `สินค้าที่ต้องกรอกยอดในรอบนี้ (${int(activeRows.length)})`,
        archivedCount ? el('span', { class: 'sub-line' }, ` + ปิดใช้งานแล้วแต่มียอด ${int(archivedCount)}`) : '',
        deletedCount ? el('span', { class: 'sub-line' }, ` + สินค้าที่ลบแล้วแต่มียอด ${int(deletedCount)}`) : '',
        deletedShopCount ? el('span', { class: 'sub-line' }, ` + ยอดของร้านที่ลบแล้ว ${int(deletedShopCount)}`) : '',
        // ช่องใหม่ (R21) ไม่บังคับ — บอกครั้งเดียวเหนือตารางว่าใช้เมื่อไร และไปเลือกตอนไหน
        el('div', { class: 'sub-line' },
          'ช่อง "ยอดส่วนต่างที่กรอกเอง" ไม่บังคับ — กรอกเมื่อรู้ยอดที่จะเรียกเก็บอยู่แล้ว · ตอนออกบิลเลือกได้ทีละสินค้าว่าจะใช้ยอดนั้น หรือยอดเต็ม × %')),
      el('div', { class: 'filters' },
        el('div', { class: 'field' }, el('label', {}, 'กรองตามร้านค้า'), franchisePicker),
        saveAll)),

    el('div', { class: 'sales-grid' }, card(null, table(columns, rows, {
      rowClass: (r) => (r.entry ? '' : 'row-todo'),
      search: 'ค้นหาสินค้าหรือร้าน…',
      empty: 'รอบนี้ยังไม่มีสินค้าที่ถูกมอบหมายให้ร้านใด — ไปหน้า "สินค้า" เพื่อมอบหมายก่อน',
      // รวมเฉพาะยอดที่บันทึกแล้ว — ตัวเลขที่ยังพิมพ์ค้างอยู่ยังไม่ใช่ข้อมูลจริง
      // "ส่วนต่างตาม %" รวมเฉพาะยอดเต็ม × % · ยอดที่บิลใช้จริง (ปนยอดที่กรอกเอง) รวมไว้ใต้คอลัมน์กรอกเอง ตรงกับการ์ดสรุปด้านบน
      footer: filled + retiredRows.length
        ? ['', `รวม ${int(filled + retiredRows.length)} รายการที่กรอกแล้ว`,
          totalCell(summary.grossTotal, usd(summary.grossTotal)), '', money(sumBaht(entriesRes.items.map(pctAmountOf))),
          el('div', {}, el('strong', {}, money(summary.commissionTotal)), usdNote(usd(summary.commissionTotal)),
            el('div', { class: 'sub-line' }, 'รวมที่ออกบิลจะใช้')),
          '', '']
        : undefined,
    }), { tight: true })));
}
