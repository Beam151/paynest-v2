import { api, qs } from '../api.js';
import {
  badge, card, confirmAction, el, formModal, int, money, pct, periodBar, stat, table, toast,
} from '../ui.js';
import { periodOptions, periodRange, setWorkingPeriod, workingPeriod } from '../period.js';
import { render } from '../app.js';
import { activityButton } from './activity.js';
import { usdRateChip } from './periodRate.js';
import { viewState } from '../viewState.js';
import { avatar } from '../charts.js';
import { componentsLine, groupBadge } from './billLines.js';

const FRANCHISE_KEY = 'franchise.salesFranchise';

/*
 * ตัวเลขที่พิมพ์ไว้แต่ยังไม่ได้บันทึก — เก็บนอกหน้า ไม่ให้หายตอนหน้าวาดใหม่
 * เดิมกดบันทึกแถวหนึ่ง หน้าวาดใหม่ทั้งหน้า แล้วตัวเลขที่พิมพ์ค้างในแถวอื่นหายเงียบ ๆ
 * key = รอบ|สินค้า — เปลี่ยนรอบไปดูแล้วกลับมา ตัวเลขของรอบนั้นยังอยู่
 */
const drafts = new Map();

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
   * สินค้าที่ถูกปิดใช้งานไปแล้ว แต่มียอดบันทึกไว้ในรอบนี้ — ไม่อยู่ในรายการสินค้าที่ใช้งาน
   * ถ้าไม่โชว์ ยอดพวกนี้จะหายไปจากหน้าจอทั้งที่ยังถูกนับในยอดรวมและยังออกบิลได้
   * โชว์เป็นแถวอ่านอย่างเดียว (กรอกยอดใหม่ไม่ได้ — เซิร์ฟเวอร์ปฏิเสธ) แต่ยังลบยอดที่ยังไม่ออกบิลได้
   * ดึงรายการสินค้าที่ปิดใช้งานเฉพาะตอนมียอด (หรือตัวเลขที่พิมพ์ค้าง) ที่ไม่เข้าแถวไหนเลย — ปกติไม่ต้องยิงเพิ่ม
   */
  const shownIds = new Set(activeRows.map((r) => r.product.id));
  const orphans = entriesRes.items.filter((e) => !shownIds.has(e.productId));
  // ตัวเลขที่พิมพ์ค้างของสินค้าที่ไม่มีแถวในหน้านี้ — อาจถูกปิดใช้งานไปแล้ว หรือแค่ถูกตัวกรองร้านซ่อนไว้
  const strayDraftIds = [...drafts.keys()]
    .filter((k) => k.startsWith(`${periodCode}|`))
    .map((k) => Number(k.split('|')[1]))
    .filter((id) => !shownIds.has(id));
  const archivedIds = (orphans.length || strayDraftIds.length)
    ? new Set((await api.get(`/api/products${qs({ status: 'ARCHIVED' })}`)).items.map((p) => p.id))
    : new Set();
  const archivedRows = orphans
    .filter((e) => archivedIds.has(e.productId))
    .map((e) => ({
      archived: true,
      product: {
        id: e.productId,
        sku: e.sku,
        name: e.productName,
        status: 'ARCHIVED',
        commissionPct: e.commissionPct,
        isGroup: Boolean(e.isGroup),
        items: e.components ?? [],
        currentAssignment: { franchiseUsername: e.franchiseUsername },
      },
      entry: e,
    }));
  /*
   * ตัวเลขที่พิมพ์ค้างไว้ของสินค้าที่เพิ่งถูกปิดใช้งาน บันทึกไม่ได้แล้ว — ไม่ให้ค้างนับในปุ่ม "บันทึกทั้งหมด"
   * ต้องดูทุกตัวเลขค้างที่ไม่มีแถว ไม่ใช่แค่แถวที่มียอดบันทึกไว้แล้ว: สินค้าที่เพิ่งพิมพ์ยอดแรกแล้วถูกปิดใช้งาน
   * ไม่มีแถวให้เห็น แต่ปุ่มค้าง "(1)" กดแล้วพังทุกครั้ง และเบราว์เซอร์ถามทุกครั้งที่ปิด/รีเฟรช
   * ลบเฉพาะของสินค้าที่ปิดใช้งานจริง — ของร้านอื่นที่ตัวกรองซ่อนไว้ยังบันทึกผ่าน "บันทึกทั้งหมด" ได้ตามปกติ
   */
  for (const id of strayDraftIds) if (archivedIds.has(id)) drafts.delete(`${periodCode}|${id}`);
  const rows = [...activeRows, ...archivedRows];

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
  saveAll.addEventListener('click', async () => {
    const pending = draftsOfPeriod();
    if (!pending.length) return;
    saveAll.disabled = true;
    try {
      const res = await api.post('/api/sales-entries/bulk', {
        items: pending.map(([key, raw]) => ({ periodCode, productId: Number(key.split('|')[1]), grossAmount: raw })),
      });
      // แถวที่บันทึกไม่ผ่านยังค้างไว้ให้แก้ — ไม่ทิ้งตัวเลขที่พิมพ์ไว้
      const failed = new Set(res.errors.map((x) => x.productId));
      for (const [key] of pending) if (!failed.has(Number(key.split('|')[1]))) drafts.delete(key);
      if (res.errors.length) {
        toast(`บันทึก ${res.saved.length} แถว · ไม่ผ่าน ${res.errors.length} แถว: ${res.errors[0].message}`, 'error');
      } else {
        toast(`บันทึกแล้ว ${res.saved.length} แถว`, 'success');
      }
      render();
    } catch (err) {
      toast(err.fullMessage ?? err.message, 'error');
      saveAll.disabled = false;
    }
  });

  /** แถวของสินค้าที่ปิดใช้งาน — ยอดเป็นตัวหนังสือ แก้ไม่ได้ · ลบได้ถ้ายังไม่ออกบิล */
  function archivedCells(row) {
    const invoiced = row.entry.status === 'INVOICED';
    const negative = row.entry.grossAmount < 0;
    return {
      amount: el('div', { class: 'amount-cell', title: 'สินค้านี้ถูกปิดใช้งานแล้ว — เปิดใช้งานที่หน้าสินค้าก่อนจึงจะกรอก/แก้ยอดได้' },
        el('strong', {}, money(row.entry.grossAmount))),
      commission: el('div', { class: 'commission-cell' },
        el('strong', { style: negative ? 'color:var(--danger)' : '' }, money(row.entry.commissionAmount)),
        negative ? el('div', { class: 'sub-line' }, 'ยอดคืน') : ''),
      actions: el('div', { class: 'btn-row' },
        invoiced
          ? ''
          : el('button', {
            class: 'btn ghost sm danger',
            onclick: () => confirmAction(`ลบยอดของ ${row.product.sku} ในรอบนี้? (สินค้านี้ปิดใช้งานแล้ว ลบแล้วกรอกใหม่ไม่ได้จนกว่าจะเปิดใช้งาน)`, async () => {
              await api.del(`/api/sales-entries/${row.entry.id}`);
              toast('ลบแล้ว', 'success');
              render();
            }),
          }, 'ลบ')),
    };
  }

  function cellsOf(row) {
    if (cellCache.has(row)) return cellCache.get(row);
    if (row.archived) {
      const cells = archivedCells(row);
      cellCache.set(row, cells);
      return cells;
    }

    // entry ที่บันทึกแล้วใช้ % ที่ snapshot ไว้ ส่วนแถวที่ยังไม่กรอกใช้ % ปัจจุบันของสินค้า
    const pctValue = row.entry?.commissionPct ?? row.product.commissionPct ?? 0;
    const invoiced = row.entry?.status === 'INVOICED';
    const savedAmount = row.entry ? row.entry.grossAmount : null;

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
      class: 'amount-input',   // ไม่ใส่ min เพราะยอดคืนสินค้าเป็นค่าติดลบได้
      value: draft ?? (row.entry ? row.entry.grossAmount : ''),
      placeholder: '0.00',
      title: invoiced
        ? 'ออกบิลไปแล้ว แก้ไม่ได้ — ต้องยกเลิกบิลก่อน'
        : row.product.isGroup ? 'สินค้ากลุ่ม — กรอกยอดขายรวมของทั้งชุดเป็นยอดเดียว' : undefined,
    });

    const save = el('button', { class: 'btn sm' }, 'บันทึก');
    const edit = el('button', { class: 'btn ghost sm' }, 'แก้ไข');
    const cancel = el('button', { class: 'btn ghost sm' }, 'ยกเลิก');
    const remove = el('button', { class: 'btn ghost sm danger' }, 'ลบ');

    /*
     * ส่วนต่างที่คำนวณสด โชว์ในคอลัมน์ "ส่วนต่างที่ต้องจ่าย" เลย
     * เดิมโชว์เป็นบรรทัดเล็กใต้ช่องกรอก ซึ่งพูดเรื่องเดียวกับคอลัมน์ข้าง ๆ
     * เลยมีตัวเลขชุดเดียวกันอยู่สามที่ในแถวเดียว และดันแถวสูงขึ้นเท่าตัว
     */
    const commission = el('div', { class: 'commission-cell' });

    const refresh = () => {
      const raw = box.value.trim();
      const dirty = editing && raw !== '' && (savedAmount === null || Number(raw) !== savedAmount);
      if (dirty) drafts.set(draftKey, raw); else drafts.delete(draftKey);
      syncSaveAll();

      box.disabled = !editing || invoiced;
      box.classList.toggle('dirty', dirty);

      // ออกบิลแล้วแตะอะไรไม่ได้เลย · กำลังแก้ = บันทึก/ยกเลิก · ปกติ = แก้ไข/ลบ
      save.style.display = dirty ? '' : 'none';
      cancel.style.display = editing && row.entry ? '' : 'none';
      edit.style.display = !editing && !invoiced ? '' : 'none';
      remove.style.display = row.entry && !invoiced && !editing ? '' : 'none';

      if (dirty) {
        const est = Math.round(Number(raw) * pctValue) / 100;
        commission.replaceChildren(
          el('strong', { class: 'unsaved' }, money(est)),
          // บันทึกยอดใหม่ = เริ่มคิดตาม % ใหม่ ยอดที่เคยกำหนดเองตอนออกบิลไม่ติดมาด้วย
          el('div', { class: 'sub-line' }, row.entry?.billMode === 'MANUAL' ? 'ยังไม่บันทึก · บันทึกแล้วกลับไปคิดตาม %' : 'ยังไม่บันทึก'));
      } else if (row.entry) {
        const negative = row.entry.grossAmount < 0;
        commission.replaceChildren(
          el('strong', { style: negative ? 'color:var(--danger)' : '' }, money(row.entry.commissionAmount)),
          negative ? el('div', { class: 'sub-line' }, 'ยอดคืน') : '');
      } else {
        commission.replaceChildren(el('span', { class: 'muted' }, '—'));
      }
    };

    box.addEventListener('input', refresh);
    // กด Enter = บันทึกแถวนี้ ไม่ต้องเอื้อมไปกดปุ่ม
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && save.style.display !== 'none' && !save.disabled) save.click();
    });

    edit.addEventListener('click', () => {
      editing = true;
      refresh();
      box.focus();
      box.select();
    });

    cancel.addEventListener('click', () => {
      editing = false;
      box.value = savedAmount ?? '';   // คืนค่าที่บันทึกไว้ ทิ้งสิ่งที่เพิ่งพิมพ์
      refresh();
    });

    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const saved = await api.post('/api/sales-entries', {
          periodCode,
          productId: row.product.id,
          grossAmount: box.value,
        });
        drafts.delete(draftKey);
        toast(`บันทึก ${row.product.sku} แล้ว — ส่วนต่าง ${money(saved.commissionAmount)} ฿`, 'success');
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
      amount: el('div', { class: 'amount-cell' }, box, save),
      commission,
      actions: el('div', { class: 'btn-row' }, edit, cancel, remove),
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
   * ช่อง % — ยอดที่กำหนดเองตอนออกบิล (กรอกยอดเอง) ไม่ได้มาจาก % แล้ว
   * โชว์ % เดิมข้างยอดนั้นจะทำให้คนคูณตามแล้วงงว่าทำไมไม่ตรง จึงบอกว่ากรอกยอดเองแทน
   */
  const pctCell = (r) => (r.entry?.billMode === 'MANUAL'
    ? el('span', { class: 'badge blue', title: `กำหนดยอดตอนออกบิล (% ตั้งต้นของสินค้า ${pct(r.entry.commissionPct)})` }, 'กรอกยอดเอง')
    : el('span', { class: 'muted' }, pct(r.entry?.commissionPct ?? r.product.commissionPct ?? 0)));

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
        r.archived ? el('span', { class: 'badge gray', style: 'margin-left:6px' }, 'ปิดใช้งาน') : '',
        el('div', { class: 'sub-line' }, r.product.name),
        isGroupRow(r) ? componentsLine(componentsOf(r), { short: true }) : ''),
    },
    {
      label: 'ร้านค้า',
      sortValue: (r) => r.product.currentAssignment.franchiseUsername,
      render: (r) => avatar(r.product.currentAssignment.franchiseUsername, { sub: '' }),
    },
    { label: 'ยอดขายเต็ม (บาท)', num: true, sortValue: (r) => r.entry?.grossAmount ?? -Infinity, render: (r) => cellsOf(r).amount },
    {
      label: '%',
      num: true,
      sortValue: (r) => (r.entry?.billMode === 'MANUAL' ? '' : r.entry?.commissionPct ?? r.product.commissionPct ?? 0),
      render: pctCell,
    },
    { label: 'ส่วนต่างที่ต้องจ่าย', num: true, sortValue: (r) => r.entry?.commissionAmount ?? -Infinity, render: (r) => cellsOf(r).commission },
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
      stat('ยอดขายเต็ม', money(summary.grossTotal) + ' ฿', `${int(summary.count)} รายการ`, { tone: 'sales', icon: '🛒' }),
      stat('ออกบิลไปแล้ว', money(invoicedCommission) + ' ฿',
        `${int(entriesRes.items.length - billable)} รายการ — ตัวเลขนี้ตรงกับหน้า "ใบเรียกเก็บ"`,
        { tone: 'income', icon: '💰' }),
      // แยกให้เห็นว่าส่วนไหนขึ้นบิลแล้ว ส่วนไหนยัง — ไม่งั้นเลขหน้านี้จะดูไม่ตรงกับหน้าใบเรียกเก็บ
      stat('ยังไม่ได้เรียกเก็บ', money(pendingCommission) + ' ฿',
        period.usdRate
          ? `≈ $${(pendingCommission / period.usdRate).toFixed(2)} · ${int(billable)} รายการรอออกบิล`
          : `${int(billable)} รายการ รอออกบิล`,
        { tone: billable ? 'due' : 'muted', icon: '⏳' })),

    // ตัวกรองร้านอยู่ชิดขวาคู่กับหัวข้อตาราง แทนที่จะลอยเดี่ยว ๆ เป็นแถวของตัวเอง
    el('div', { class: 'toolbar' },
      el('h2', { class: 'section-title' }, `สินค้าที่ต้องกรอกยอดในรอบนี้ (${int(activeRows.length)})`,
        archivedRows.length ? el('span', { class: 'sub-line' }, ` + ปิดใช้งานแล้วแต่มียอด ${int(archivedRows.length)}`) : ''),
      el('div', { class: 'filters' },
        el('div', { class: 'field' }, el('label', {}, 'กรองตามร้านค้า'), franchisePicker),
        saveAll)),

    card(null, table(columns, rows, {
      rowClass: (r) => (r.entry ? '' : 'row-todo'),
      search: 'ค้นหาสินค้าหรือร้าน…',
      empty: 'รอบนี้ยังไม่มีสินค้าที่ถูกมอบหมายให้ร้านใด — ไปหน้า "สินค้า" เพื่อมอบหมายก่อน',
      // รวมเฉพาะยอดที่บันทึกแล้ว — ตัวเลขที่ยังพิมพ์ค้างอยู่ยังไม่ใช่ข้อมูลจริง
      footer: filled + archivedRows.length
        ? ['', `รวม ${int(filled + archivedRows.length)} รายการที่กรอกแล้ว`,
          money(summary.grossTotal), '', money(summary.commissionTotal), '', '']
        : undefined,
    }), { tight: true }));
}
