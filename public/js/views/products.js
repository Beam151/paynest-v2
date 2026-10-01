import { api, qs, session } from '../api.js';
import { badge, card, confirmAction, dateTh, el, formModal, infoModal, int, pct, table, toast } from '../ui.js';
import { todayIso } from '../period.js';
import { render } from '../app.js';
import { activityButton } from './activity.js';
import { viewState } from '../viewState.js';
import { componentsLine, groupBadge } from './billLines.js';

const STATUS_KEY = 'franchise.productStatus';
const KIND_KEY = 'franchise.productKind';

// เพดานเดียวกับเซิร์ฟเวอร์ — ชุดใหญ่กว่านี้ไม่มีจริง และบรรทัด "ประกอบด้วย" ในบิลจะยาวจนอ่านไม่ได้
const MAX_COMPONENTS = 100;

/*
 * เลิกขายมีสองแบบ (เจ้าของระบบกลับคำตัดสินเดิมที่ว่า "ลบไม่ได้" เมื่อ 30 ก.ย. 69 — "ทำลบได้ดีกว่า"):
 *   ปิดใช้งาน = ชั่วคราว เปิดกลับได้ สัญญา/ดีลค้างไว้ตามเดิม
 *   ลบ       = ถาวร (ส่วนกลางสูงสุดเท่านั้น) — เซิร์ฟเวอร์เลือกเอง: ไม่เคยมีประวัติ = ลบทิ้งจริง ·
 *              มีบิลอ้างถึง = ซ่อนถาวร (สถานะ DELETED) บิลเก่ายังอ่านรหัส/ชื่อได้ · สินค้าที่ถูกลบไม่อยู่ในแท็บไหนเลย
 * ส่วนกลางสลับดูได้ ใช้งาน / ปิดใช้งาน / ทั้งหมด · ร้านเห็นเฉพาะที่ใช้งานอยู่เหมือนเดิม
 */
const STATUS_TABS = [
  { value: 'ACTIVE', label: 'ใช้งาน' },
  { value: 'ARCHIVED', label: 'ปิดใช้งาน' },
  { value: '', label: 'ทั้งหมด' },
];

/*
 * ตัวกรองชนิดสินค้า (เฉพาะส่วนกลาง) — ซ้อนกับแท็บสถานะได้ เช่น "สินค้ากลุ่ม" ที่ "ปิดใช้งาน"
 * เป็นตัวเลือกแยกจากแท็บสถานะ ไม่ใช่แท็บเพิ่ม เพราะแท็บสถานะเป็นของเดิมที่คนคุ้นแล้ว (ใช้งาน/ปิดใช้งาน/ทั้งหมด)
 */
const KIND_OPTIONS = [
  { value: '', label: 'ทั้งหมด' },
  { value: 'GROUP', label: 'สินค้ากลุ่ม' },
  { value: 'SINGLE', label: 'สินค้าเดี่ยว' },
];
const kindMatch = (p, kind) => !kind || (kind === 'GROUP' ? Boolean(p.isGroup) : !p.isGroup);
const statusMatch = (p, status) => !status || p.status === status;

/**
 * สวิตช์ "สินค้ากลุ่ม" + รายการติ๊กสินค้าย่อยที่ค้นหาได้ ในหน้าต่างสร้าง/แก้สินค้า
 *
 * เจ้าของระบบเลือกให้ "กลุ่มคือสินค้าชิ้นหนึ่ง": กรอกยอดขายเป็นยอดรวมของทั้งชุด บิลคิด % ของกลุ่มบรรทัดเดียว
 * สินค้าย่อยเป็นแค่ข้อมูลว่าในชุดมีอะไร (ไม่มียอดแยก ไม่คิดเงินแยก)
 * ติ๊กได้เฉพาะสินค้าเดี่ยว ไม่รวมตัวเอง — กลุ่มซ้อนกลุ่มไม่ได้ (เซิร์ฟเวอร์ก็ปฏิเสธ แต่ไม่โชว์ให้เลือกตั้งแต่แรกดีกว่า)
 * สินค้าที่ปิดใช้งาน: โชว์เฉพาะที่อยู่ในชุดอยู่แล้ว (คงไว้ได้) — ของใหม่ติ๊กเพิ่มไม่ได้
 *
 * ส่งเข้า formModal ทางช่อง preview (คืน node เดิมทุกครั้ง) — ติ๊ก/คำค้นเก็บอยู่ใน node นี้เอง
 * formModal วาดพรีวิวใหม่ทุกครั้งที่พิมพ์ช่องอื่น ถ้าสร้าง node ใหม่ทุกครั้ง ที่ติ๊กไว้จะหายหมด
 */
function groupPicker({ product = null, allProducts }) {
  const wasGroup = Boolean(product?.isGroup);
  const initialIds = (product?.items ?? []).map((i) => i.id);
  const initial = new Set(initialIds);
  // Set จำลำดับที่ใส่ — ของเดิมคงลำดับเดิม (ลำดับที่โชว์ในบิล) ของที่ติ๊กเพิ่มต่อท้ายตามลำดับที่ติ๊ก
  const chosen = new Set(initialIds);
  const memberOf = product?.inGroups ?? [];
  // อยู่ในชุดอื่นอยู่แล้ว = เปลี่ยนตัวเองเป็นชุดไม่ได้ (จะกลายเป็นชุดซ้อนชุด) — บอกเหตุผลตรงสวิตช์เลย ไม่ต้องรอกดบันทึกแล้วโดนปฏิเสธ
  const locked = !wasGroup && memberOf.length > 0;

  const byId = new Map(allProducts.map((p) => [p.id, p]));
  // รายการย่อยที่ไม่อยู่ในลิสต์สินค้าที่โหลดมา (ไม่ควรเกิด) ยังต้องโชว์ ไม่งั้นกดบันทึกแล้วหายไปจากชุดเงียบ ๆ
  for (const item of product?.items ?? []) if (!byId.has(item.id)) byId.set(item.id, { ...item, isGroup: false });
  const candidates = [...byId.values()]
    .filter((p) => p.id !== product?.id && !p.isGroup && (p.status === 'ACTIVE' || initial.has(p.id)))
    // ของที่อยู่ในชุดแล้วขึ้นก่อน — เปิดแก้แล้วเห็นทันทีว่าชุดนี้มีอะไร ไม่ต้องไล่หาในลิสต์ยาว
    .sort((a, b) => (Number(initial.has(b.id)) - Number(initial.has(a.id)))
      || String(a.sku).localeCompare(String(b.sku), 'th', { numeric: true }));

  const toggle = el('input', { type: 'checkbox', checked: wasGroup, disabled: locked, 'aria-label': 'สินค้ากลุ่ม (ชุด)' });
  const search = el('input', { type: 'search', placeholder: 'ค้นหารหัสหรือชื่อสินค้าย่อย…', 'aria-label': 'ค้นหาสินค้าย่อย' });
  const onlyChosen = el('input', { type: 'checkbox' });
  const counter = el('span', { class: 'group-count' });
  const list = el('div', { class: 'group-list', role: 'group', 'aria-label': 'สินค้าย่อยในชุด' });
  const emptyNote = el('div', { class: 'sub-line group-empty' });
  const offWarning = el('div', { class: 'notice-box group-off', hidden: true },
    'ปิดสวิตช์แล้วบันทึก = เลิกเป็นสินค้ากลุ่ม รายการย่อยทั้งหมดจะถูกล้าง · บิลที่ออกไปแล้วยังโชว์รายการเดิมของบิลนั้น');

  const rows = candidates.map((p) => {
    const box = el('input', { type: 'checkbox', checked: chosen.has(p.id), 'aria-label': `ใส่ ${p.sku} ในชุด` });
    box.addEventListener('change', () => {
      if (box.checked && chosen.size >= MAX_COMPONENTS) {
        box.checked = false;
        toast(`สินค้ากลุ่มมีรายการย่อยได้สูงสุด ${MAX_COMPONENTS} รายการ — เอาบางรายการออกก่อน`, 'error');
        return;
      }
      if (box.checked) chosen.add(p.id); else chosen.delete(p.id);
      paint();
    });
    // ของชิ้นเดียวอยู่ได้หลายชุด (เช่นแก้วใบเดียวกันในสองเซต) — บอกไว้ให้รู้ ไม่ได้ห้าม
    const others = (p.inGroups ?? []).filter((g) => g.id !== product?.id);
    const node = el('label', { class: 'check-item' },
      box,
      el('div', {},
        el('strong', {}, p.sku),
        p.status === 'ARCHIVED' ? [' ', badge('ARCHIVED')] : '',
        el('div', { class: 'sub-line' }, p.name),
        p.status === 'ARCHIVED'
          ? el('div', { class: 'sub-line' }, 'ปิดใช้งานแล้ว — คงไว้ในชุดได้ · ถ้าเอาออกแล้วบันทึก จะใส่กลับไม่ได้จนกว่าจะเปิดใช้งาน')
          : '',
        others.length ? el('div', { class: 'sub-line' }, `อยู่ในกลุ่ม ${others.map((g) => g.sku).join(', ')} ด้วย`) : ''));
    return { p, node, text: `${p.sku} ${p.name}`.toLowerCase() };
  });
  list.append(...rows.map((r) => r.node));

  const body = el('div', { class: 'group-body' },
    el('div', { class: 'sub-line' },
      'กรอกยอดขายเป็นยอดรวมของทั้งกลุ่ม · บิลคิด % ของกลุ่มบรรทัดเดียว · รายการย่อยแสดงให้ร้านเห็นว่าในชุดมีอะไร'),
    el('div', { class: 'group-tools' },
      search,
      el('label', { class: 'group-only' }, onlyChosen, 'ดูเฉพาะที่เลือก'),
      counter),
    list,
    emptyNote);

  function paint() {
    const on = toggle.checked;
    body.hidden = !on;
    offWarning.hidden = on || !wasGroup;
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const r of rows) {
      const visible = (!q || r.text.includes(q)) && (!onlyChosen.checked || chosen.has(r.p.id));
      r.node.hidden = !visible;
      if (visible) shown += 1;
    }
    counter.textContent = `เลือกแล้ว ${int(chosen.size)} รายการ`;
    counter.classList.toggle('text-danger', chosen.size === 0);
    emptyNote.hidden = shown > 0;
    emptyNote.textContent = !rows.length
      ? 'ยังไม่มีสินค้าเดี่ยวให้เลือก — สร้างสินค้าย่อยก่อน แล้วค่อยกลับมาติ๊กเข้าชุด'
      : onlyChosen.checked && !chosen.size
        ? 'ยังไม่ได้ติ๊กสินค้าใดเลย'
        : `ไม่พบสินค้าที่ตรงกับ "${search.value.trim()}"`;
  }

  toggle.addEventListener('change', () => {
    paint();
    if (toggle.checked && rows.length) search.focus();
  });
  search.addEventListener('input', paint);
  onlyChosen.addEventListener('change', paint);

  /*
   * formModal ถอด node นี้ออกแล้วใส่กลับทุกครั้งที่พิมพ์ช่องอื่น — ตำแหน่งเลื่อนของรายการรีเซ็ตเป็นบนสุด
   * จำไว้แล้วคืนให้หลังใส่กลับ ไม่งั้นไล่ติ๊กไปครึ่งลิสต์ แก้ชื่อสินค้าทีเดียวต้องเลื่อนหาใหม่
   */
  let listTop = 0;
  list.addEventListener('scroll', () => { listTop = list.scrollTop; });

  const node = el('div', { class: 'group-picker' },
    el('label', { class: 'group-switch' },
      el('span', { class: 'switch' }, toggle, el('span', { class: 'slider' })),
      el('div', {},
        el('strong', {}, 'สินค้ากลุ่ม (ชุด) — ขายและคิดบิลเป็นก้อนเดียว'),
        el('div', { class: 'sub-line' }, locked
          ? `สินค้านี้อยู่ในสินค้ากลุ่ม ${memberOf.map((g) => g.sku).join(', ')} อยู่ — เอาออกจากกลุ่มก่อนจึงจะเปลี่ยนเป็นสินค้ากลุ่มได้`
          : 'เปิดเมื่อสินค้านี้เป็นชุดที่รวมสินค้าหลายชิ้น แล้วติ๊กว่าในชุดมีอะไรบ้าง'))),
    offWarning,
    body);
  paint();

  return {
    /** สำหรับ preview ของ formModal — คืน node เดิมพร้อมคืนตำแหน่งเลื่อนหลังถูกใส่กลับ */
    preview() {
      const top = listTop;
      requestAnimationFrame(() => { list.scrollTop = top; });
      return { node, canSubmit: true };
    },
    isGroup: () => toggle.checked,
    count: () => chosen.size,
    /** ตรวจก่อนบันทึก — throw ข้อความไทยให้หน้าต่างค้างไว้พร้อมบอกว่าต้องแก้อะไร */
    validate() {
      if (!toggle.checked) return;
      if (!chosen.size) {
        throw new Error('สินค้ากลุ่มต้องมีสินค้าย่อยอย่างน้อย 1 รายการ — ติ๊กสินค้าที่อยู่ในชุดก่อนบันทึก หรือปิดสวิตช์ "สินค้ากลุ่ม"');
      }
      if (chosen.size > MAX_COMPONENTS) {
        throw new Error(`สินค้ากลุ่มมีรายการย่อยได้สูงสุด ${MAX_COMPONENTS} รายการ — เอาออกอีก ${chosen.size - MAX_COMPONENTS} รายการ`);
      }
    },
    /**
     * ฟิลด์ที่ส่งไป API — ส่งเฉพาะเมื่อมีอะไรเปลี่ยนจริง (เซิร์ฟเวอร์บันทึกประวัติทุกครั้งที่รายการย่อยเปลี่ยน)
     * เทียบเป็นชุด ไม่เทียบลำดับ — ติ๊กออกแล้วติ๊กกลับไม่ได้ตั้งใจจะเปลี่ยนอะไร
     * PATCH ที่มี itemProductIds = แทนที่ทั้งรายการ จึงส่งครบทุกชิ้นที่ติ๊กไว้เสมอ
     */
    payload() {
      const on = toggle.checked;
      const ids = [...chosen];
      if (!product) return on ? { isGroup: true, itemProductIds: ids } : {};
      if (!on) return wasGroup ? { isGroup: false } : {};
      const same = wasGroup && ids.length === initial.size && ids.every((id) => initial.has(id));
      return same ? {} : { isGroup: true, itemProductIds: ids };
    },
  };
}

export async function productsView() {
  const isSuper = session.isSuper;
  const saved = viewState.getItem(STATUS_KEY);
  const statusFilter = isSuper && STATUS_TABS.some((t) => t.value === saved) ? saved : 'ACTIVE';
  const [{ items: allProducts }, franchises] = await Promise.all([
    // ส่วนกลางดึงทุกสถานะทีเดียวแล้วกรองในเครื่อง — ได้ตัวเลขบนแท็บครบโดยไม่ต้องยิงสามรอบ
    api.get(`/api/products${qs({ status: isSuper ? '' : 'ACTIVE' })}`),
    isSuper ? api.get('/api/franchises').then((r) => r.items) : Promise.resolve([]),
  ]);
  const hasGroups = allProducts.some((p) => p.isGroup);
  const savedKind = viewState.getItem(KIND_KEY);
  // ยังไม่มีสินค้ากลุ่มเลย = ไม่โชว์ตัวกรองชนิดและไม่กรอง (ค่าที่จำไว้ไม่ทำให้ตารางว่างเปล่าแบบงง ๆ)
  const kindFilter = isSuper && hasGroups && KIND_OPTIONS.some((k) => k.value === savedKind) ? savedKind : '';
  // ตัวเลขบนแท็บสถานะนับตามชนิดที่เลือก และตัวเลขในตัวเลือกชนิดนับตามแท็บสถานะ — ตรงกับจำนวนแถวที่จะเห็นเมื่อกด
  const countOf = (status) => allProducts.filter((p) => statusMatch(p, status) && kindMatch(p, kindFilter)).length;
  const kindCountOf = (kind) => allProducts.filter((p) => statusMatch(p, statusFilter) && kindMatch(p, kind)).length;
  const products = allProducts.filter((p) => statusMatch(p, statusFilter) && kindMatch(p, kindFilter));

  /*
   * "อยู่ในกลุ่ม …" — ส่วนกลางเห็นทุกกลุ่ม · ร้านเห็นเฉพาะกลุ่มที่เป็นสินค้าของร้านเอง
   * (ของชิ้นเดียวอยู่ในชุดของร้านอื่นได้ รหัสชุดของร้านอื่นไม่ใช่เรื่องที่ร้านนี้ต้องรู้)
   */
  const ownIds = new Set(allProducts.map((p) => p.id));
  const inGroupsOf = (p) => (p.inGroups ?? []).filter((g) => isSuper || ownIds.has(g.id));

  const franchiseOptions = [
    { value: '', label: '— ยังไม่มอบหมาย —' },
    ...franchises.filter((f) => f.status === 'ACTIVE').map((f) => ({ value: String(f.id), label: f.username })),
  ];

  const createModal = () => {
    const picker = groupPicker({ allProducts });
    return formModal({
      title: 'สร้างสินค้าใหม่',
      width: 640,
      // ส่วนสินค้ากลุ่มวางต่อท้ายช่องกรอก (styles.css .group-picker) — กรอกรหัส/ชื่อ/% ก่อน แล้วค่อยบอกว่าเป็นชุดไหม
      preview: () => picker.preview(),
      fields: [
        { name: 'sku', label: 'รหัสสินค้า', required: true, placeholder: 'COFFEE-KIT' },
        { name: 'name', label: 'ชื่อสินค้า', required: true },
        {
          name: 'commissionPct',
          label: '% ส่วนต่างที่ร้านต้องจ่าย',
          type: 'number',
          step: '0.01',
          required: true,
          hint: 'ตัดจากยอดขายของสินค้าชิ้นนี้ · สินค้าคนละชิ้นตั้งคนละ % ได้',
        },
        { name: 'franchiseId', label: 'มอบหมายให้ร้าน', type: 'select', options: franchiseOptions, hint: 'สินค้า 1 ชิ้นมอบหมายได้ร้านเดียว' },
        {
          name: 'startDate',
          label: 'เริ่มสัญญาวันที่',
          type: 'date',
          value: todayIso(),
          showWhen: (v) => Boolean(v.franchiseId),
          hint: 'จะบันทึกยอดของรอบก่อนหน้า ให้ตั้งวันเริ่มย้อนไปถึงรอบนั้น · แก้ทีหลังได้ที่ "แก้ไข"',
        },
        { name: 'description', label: 'รายละเอียด', type: 'textarea', rows: 3, maxlength: 1000, placeholder: 'เช่น ขนาด สเปก เงื่อนไขการขาย' },
      ],
      onSubmit: async (v) => {
        picker.validate();
        await api.post('/api/products', {
          ...v,
          franchiseId: v.franchiseId ? Number(v.franchiseId) : undefined,
          startDate: v.franchiseId && v.startDate ? v.startDate : undefined,
          ...picker.payload(),
        });
        toast(picker.isGroup()
          ? `สร้างสินค้ากลุ่ม ${v.sku} แล้ว — ${picker.count()} รายการย่อย`
          : `สร้างสินค้า ${v.sku} แล้ว`, 'success');
        render();
      },
    });
  };

  const assignModal = (product) => formModal({
    title: `มอบหมาย ${product.sku}`,
    submitLabel: 'มอบหมาย',
    fields: [
      { name: 'franchiseId', label: 'ร้านค้า', type: 'select', required: true, options: franchiseOptions.slice(1) },
      { name: 'startDate', label: 'เริ่มวันที่', type: 'date', required: true, value: todayIso() },
      { name: 'endDate', label: 'สิ้นสุดวันที่', type: 'date', hint: 'เว้นว่าง = ไม่กำหนด' },
      { name: 'note', label: 'หมายเหตุ' },
    ],
    onSubmit: async (v) => {
      await api.post('/api/assignments', { ...v, productId: product.id, franchiseId: Number(v.franchiseId) });
      toast('มอบหมายสินค้าแล้ว', 'success');
      render();
    },
  });

  /**
   * สัญญากับร้านที่หน้าแก้ไขสินค้าให้แก้วันที่ — ที่ใช้อยู่วันนี้ก่อน ไม่มีก็ที่ยังไม่ถึงวันเริ่ม (ใกล้สุด) แล้วค่อยสัญญาล่าสุดที่จบไปแล้ว
   * สัญญาของร้านที่ถูกลบเป็นประวัติ แก้ไม่ได้ (เซิร์ฟเวอร์ก็ไม่ยอม) จึงไม่เอามาให้เลือก
   */
  const contractToEdit = (assignments) => {
    const live = assignments.filter((a) => a.franchiseStatus !== 'DELETED');
    const today = todayIso();
    return live.find((a) => a.isActive)
      ?? live.filter((a) => a.startDate > today).sort((a, b) => a.startDate.localeCompare(b.startDate))[0]
      ?? live.slice().sort((a, b) => b.startDate.localeCompare(a.startDate))[0]
      ?? null;
  };
  const contractState = (a) => {
    const today = todayIso();
    if (a.startDate > today) return 'ยังไม่ถึงวันเริ่ม';
    return a.endDate !== null && a.endDate < today ? 'จบไปแล้ว' : 'ใช้อยู่';
  };

  const editModal = async (product) => {
    const picker = groupPicker({ product, allProducts });
    // วันที่อยู่ที่สัญญากับร้าน (ไม่ใช่ตัวสินค้า) — โหลดสัญญาทั้งหมดของสินค้านี้ เพราะรายการสินค้ามีแค่สัญญาที่ใช้อยู่วันนี้
    const contract = contractToEdit((await api.get(`/api/products/${product.id}`)).assignments ?? []);
    return formModal({
      title: `แก้ไข ${product.sku}`,
      width: 640,
      preview: () => picker.preview(),
      fields: [
        { name: 'name', label: 'ชื่อสินค้า', required: true, value: product.name },
        {
          name: 'commissionPct',
          label: '% ส่วนต่างที่ร้านต้องจ่าย',
          type: 'number',
          step: '0.01',
          required: true,
          value: product.commissionPct,
          hint: 'แก้แล้วมีผลกับยอดที่บันทึกใหม่เท่านั้น ยอดเก่าไม่เปลี่ยน',
        },
        ...(contract ? [
          {
            name: 'contractStart',
            label: `เริ่มสัญญากับร้าน ${contract.franchiseUsername} (${contractState(contract)})`,
            type: 'date',
            required: true,
            value: contract.startDate,
            hint: 'ย้อนวันเริ่มได้ ถ้าต้องบันทึกยอดของรอบก่อนหน้า · ห้ามทับช่วงที่ร้านอื่นถือสินค้านี้',
          },
          {
            name: 'contractEnd',
            label: 'สิ้นสุดสัญญา',
            type: 'date',
            value: contract.endDate ?? '',
            hint: 'เว้นว่าง = ไม่กำหนด · รอบที่บันทึกยอดไว้แล้วต้องยังอยู่ในช่วงสัญญา',
          },
        ] : []),
        {
          name: 'status',
          label: 'สถานะ',
          type: 'select',
          value: product.status,
          options: [{ value: 'ACTIVE', label: 'ใช้งาน' }, { value: 'ARCHIVED', label: 'ปิดใช้งาน' }],
          hint: 'ปิดใช้งาน = ร้านไม่เห็น กรอกยอดใหม่ไม่ได้ · ยอดเดิมยังออกบิลได้ · เปิดกลับได้ทุกเมื่อ',
        },
        {
          name: 'description',
          label: 'รายละเอียด',
          type: 'textarea',
          rows: 3,
          maxlength: 1000,
          value: product.description ?? '',
          placeholder: 'เช่น ขนาด สเปก เงื่อนไขการขาย',
        },
      ],
      onSubmit: async (v) => {
        picker.validate();
        const { contractStart, contractEnd, ...fields } = v;
        if (contract && contractEnd && contractEnd < contractStart) {
          throw new Error('วันสิ้นสุดสัญญาต้องไม่ก่อนวันเริ่ม');
        }
        // ลบข้อความจนว่าง = ล้างรายละเอียดจริง (ส่ง null) ไม่ใช่เก็บสตริงว่างไว้ในฐานข้อมูล
        const description = (fields.description ?? '').trim();
        const group = picker.payload();
        // ส่งวันที่ไปเฉพาะเมื่อเปลี่ยนจริง — เซิร์ฟเวอร์บันทึกพร้อมตัวสินค้าในครั้งเดียว ติดข้อไหนก็ไม่มีอะไรถูกบันทึก
        const datesChanged = contract && (contractStart !== contract.startDate || (contractEnd || null) !== contract.endDate);
        await api.patch(`/api/products/${product.id}`, {
          ...fields,
          description: description === '' ? null : description,
          ...group,
          ...(datesChanged ? { assignment: { id: contract.id, startDate: contractStart, endDate: contractEnd || null } } : {}),
        });
        const note = group.isGroup === false
          ? ` — ${product.sku} เลิกเป็นสินค้ากลุ่มแล้ว`
          : group.itemProductIds ? ` — สินค้ากลุ่ม ${product.sku} มี ${group.itemProductIds.length} รายการย่อย` : '';
        const dateNote = datesChanged
          ? ` — สัญญากับ ${contract.franchiseUsername} ${dateTh(contractStart)} → ${contractEnd ? dateTh(contractEnd) : 'ไม่กำหนด'}`
          : '';
        toast(`บันทึกแล้ว${note}${dateNote}`, 'success');
        render();
      },
    });
  };

  const historyModal = async (product) => {
    const full = await api.get(`/api/products/${product.id}`);
    const modal = infoModal({ title: `ประวัติการมอบหมาย — ${product.sku}`, content: null });
    modal.body.append(table([
      { label: 'ร้านค้า', render: (a) => el('strong', {}, a.franchiseUsername) },
      { label: 'ช่วงเวลา', render: (a) => `${dateTh(a.startDate)} → ${a.endDate ? dateTh(a.endDate) : 'ไม่กำหนด'}` },
      { label: '%', num: true, render: (a) => pct(a.effectiveCommissionPct) },
      { label: 'สถานะ', render: (a) => badge(a.isActive ? 'ACTIVE' : 'CLOSED') },
      {
        label: '',
        render: (a) => (isSuper && a.isActive
          ? el('button', {
            class: 'btn ghost sm',
            onclick: () => formModal({
              title: `ปิดสัญญา ${product.sku}`,
              submitLabel: 'ปิดสัญญา',
              fields: [{
                name: 'endDate',
                label: 'ปิดสัญญาวันที่',
                type: 'date',
                required: true,
                value: todayIso(),
                hint: 'หลังปิดแล้วจะมอบหมายสินค้าชิ้นนี้ให้ร้านอื่นได้',
              }],
              onSubmit: async (v) => {
                await api.post(`/api/assignments/${a.id}/end`, v);
                toast('ปิดสัญญาแล้ว', 'success');
                modal.close();
                render();
              },
            }),
          }, 'ปิดสัญญา')
          : ''),
      },
    ], full.assignments, { empty: 'สินค้าชิ้นนี้ยังไม่เคยถูกมอบหมาย' }));
  };

  const columns = [
    {
      label: 'รายการ',
      render: (p) => el('div', {},
        el('strong', {}, p.sku),
        // สินค้ากลุ่ม: ป้ายบอกจำนวนชิ้นในชุด + รหัสสินค้าย่อยบรรทัดเดียว (ชี้ค้างดูครบพร้อมชื่อ)
        p.isGroup ? [' ', groupBadge((p.items ?? []).length)] : '',
        el('div', { class: 'sub-line' }, p.name),
        p.isGroup ? componentsLine(p.items, { short: true }) : '',
        // สินค้าที่เป็นชิ้นในชุด — บอกไว้ก่อนเผลอปิดใช้งาน/แก้ แล้วงงว่าทำไมเปลี่ยนเป็นสินค้ากลุ่มไม่ได้
        inGroupsOf(p).length
          ? el('div', {
            class: 'sub-line in-groups',
            title: inGroupsOf(p).map((g) => `${g.sku} — ${g.name}`).join('\n'),
          }, `อยู่ในกลุ่ม ${inGroupsOf(p).map((g) => g.sku).join(', ')}`)
          : '',
        // รายละเอียดยาวได้ — ตัดไว้บรรทัดเดียวในตาราง ชี้ค้างดูเต็มได้ (อ่านครบในหน้าต่างแก้ไข)
        p.description
          ? el('div', {
            class: 'sub-line',
            title: p.description,
            style: 'max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.8',
          }, p.description)
          : ''),
    },
    {
      label: 'เจ้าของสิทธิ์ขาย',
      render: (p) => (p.currentAssignment
        ? el('div', {},
          el('strong', {}, p.currentAssignment.franchiseUsername),
          el('div', { class: 'sub-line' }, `ตั้งแต่ ${dateTh(p.currentAssignment.startDate)}`))
        : el('span', { class: 'badge amber' }, 'ยังไม่มอบหมาย')),
    },
    {
      label: '% ส่วนต่าง',
      num: true,
      render: (p) => el('strong', {}, pct(p.commissionPct)),
      sortValue: (p) => p.commissionPct,
    },
    { label: 'สถานะ', render: (p) => badge(p.status) },
  ];

  /*
   * ปิดใช้งานไม่แตะสัญญา/ดีลที่เปิดอยู่ — เปิดใช้งานอีกครั้งแล้วกลับมาเหมือนเดิมทันที ไม่ต้องมอบหมายใหม่
   * ยอดที่บันทึกไว้แล้วยังออกบิลได้ตามปกติ (กันยอดค้างที่ยังไม่ได้เรียกเก็บหายไปเฉย ๆ)
   */
  const archive = (p) => confirmAction(
    `ปิดใช้งานสินค้า ${p.sku}?\n\n`
      + '• ร้านจะไม่เห็นสินค้านี้ และกรอกยอดใหม่ไม่ได้\n'
      + '• ยอดที่บันทึกไว้แล้วยังออกบิลได้ตามปกติ\n'
      + '• สัญญากับร้านและดีลของเซลยังอยู่ — เปิดใช้งานอีกครั้งเมื่อไรก็กลับมาใช้ต่อได้ทันที',
    async () => {
      await api.patch(`/api/products/${p.id}`, { status: 'ARCHIVED' });
      toast(`ปิดใช้งาน ${p.sku} แล้ว`, 'success');
      render();
    },
  );
  const activate = async (p) => {
    try {
      await api.patch(`/api/products/${p.id}`, { status: 'ACTIVE' });
      toast(`เปิดใช้งาน ${p.sku} อีกครั้งแล้ว`, 'success');
      render();
    } catch (err) {
      toast(err.fullMessage ?? err.message, 'error');
    }
  };

  /*
   * ลบถาวร — หน้าเว็บไม่เดาว่าจะลบทิ้งหรือซ่อน เซิร์ฟเวอร์ลองลบจริงก่อน ติดประวัติที่อ้างถึงอยู่ค่อยซ่อน (ตอบ mode มา)
   * คำยืนยันจึงอธิบายทั้งสองผล แล้วบอกผลจริงหลังลบตาม mode
   * ยอดที่ยังไม่ออกบิล / เป็นสินค้าย่อยชิ้นสุดท้ายของกลุ่ม → เซิร์ฟเวอร์ตอบ 409 พร้อมบอกว่าต้องทำอะไรก่อน (confirmAction ขึ้นเป็น toast แดง)
   */
  const remove = (p) => {
    const groups = inGroupsOf(p);
    return confirmAction(
      `ลบสินค้า ${p.sku} ถาวร?\n\n`
        + '• ยังไม่เคยมียอดขาย = ลบทิ้งทั้งหมด (สัญญา/ดีลของสินค้านี้ด้วย)\n'
        + '• มีบิลแล้ว = ซ่อนออกจากทุกหน้าถาวร บิลเก่ายังแสดงสินค้านี้เหมือนเดิม\n'
        + (groups.length ? `• ถูกเอาออกจากสินค้ากลุ่ม ${groups.map((g) => g.sku).join(', ')}\n` : '')
        + (p.isGroup ? '• สินค้าย่อยในชุดนี้ไม่ถูกลบ (แค่ไม่มีชุดนี้แล้ว)\n' : '')
        + '• ย้อนกลับไม่ได้ — ถ้าแค่หยุดขายชั่วคราวให้ใช้ "ปิดใช้งาน"',
      async () => {
        const res = await api.del(`/api/products/${p.id}`);
        const sku = res?.sku ?? p.sku;
        toast(res?.mode === 'SOFT'
          ? `ลบ ${sku} แล้ว — มียอดขาย/บิลเก่าอ้างถึง จึงซ่อนถาวร (บิลเก่ายังแสดงสินค้านี้ · สัญญา/ดีลที่เปิดอยู่ปิดวันนี้)`
          : `ลบ ${sku} ทิ้งแล้ว — ยังไม่เคยมียอดขาย จึงลบออกทั้งหมดรวมสัญญา/ดีลของสินค้านี้`, 'success');
        render();
      },
    );
  };

  if (isSuper) {
    columns.push({
      label: '',
      render: (p) => el('div', { class: 'btn-row' },
        p.currentAssignment
          ? el('button', { class: 'btn ghost sm', onclick: () => historyModal(p) }, 'สัญญา')
          // สินค้าที่ปิดใช้งานมอบหมายใหม่ไม่ได้ (เซิร์ฟเวอร์ปฏิเสธ) — ต้องเปิดใช้งานก่อน
          : p.status === 'ACTIVE' ? el('button', { class: 'btn sm', onclick: () => assignModal(p) }, 'มอบหมาย') : '',
        el('button', { class: 'btn ghost sm', onclick: () => editModal(p) }, 'แก้ไข'),
        // ปิดใช้งานเปิดกลับได้ จึงไม่ใช้สีแดง — สีแดงเหลือไว้ให้ "ลบ" ที่ย้อนกลับไม่ได้ ไม่งั้นสองปุ่มติดกันดูอันตรายเท่ากัน
        p.status === 'ACTIVE'
          ? el('button', { class: 'btn ghost sm', onclick: () => archive(p) }, 'ปิดใช้งาน')
          : el('button', { class: 'btn ghost sm', onclick: () => activate(p) }, 'เปิดใช้งาน'),
        el('button', { class: 'btn ghost sm danger', onclick: () => remove(p) }, 'ลบ')),
    });
  } else {
    columns.push({
      label: '',
      render: (p) => el('button', { class: 'btn ghost sm', onclick: () => historyModal(p) }, 'ดูสัญญา'),
    });
  }

  // นับเฉพาะสินค้าที่ใช้งานอยู่ — ของที่ปิดใช้งานไม่ต้องมอบหมาย ไม่ใช่งานค้าง
  const unassigned = allProducts.filter((p) => p.status === 'ACTIVE' && !p.currentAssignment).length;
  // หัวหน้าบอกภาพรวมทั้งหมดเสมอ ไม่เปลี่ยนตามตัวกรองที่เลือกอยู่
  const activeTotal = allProducts.filter((p) => p.status === 'ACTIVE').length;
  const groupTotal = allProducts.filter((p) => p.status === 'ACTIVE' && p.isGroup).length;

  const kindPicker = isSuper && hasGroups
    ? el('label', { class: 'kind-filter' },
      el('span', {}, 'ชนิดสินค้า'),
      el('select', {
        'aria-label': 'กรองชนิดสินค้า',
        onchange: (e) => { viewState.setItem(KIND_KEY, e.target.value); render(); },
      }, ...KIND_OPTIONS.map((k) => el('option', { value: k.value, selected: k.value === kindFilter },
        `${k.label} (${int(kindCountOf(k.value))})`))))
    : '';

  const tabs = isSuper
    ? el('div', { class: 'btn-row tabs' },
      ...STATUS_TABS.map((t) => el('button', {
        class: `btn ${statusFilter === t.value ? '' : 'ghost'}`,
        onclick: () => { viewState.setItem(STATUS_KEY, t.value); render(); },
      }, `${t.label} (${int(countOf(t.value))})`)),
      kindPicker)
    : '';

  const emptyOf = () => {
    if (!isSuper) return { icon: '📦', title: 'ทางเรายังไม่ได้มอบหมายสินค้าให้ร้าน' };
    if (kindFilter === 'GROUP') {
      return {
        icon: '📦',
        title: 'ไม่มีสินค้ากลุ่มในแท็บนี้',
        detail: 'ทำสินค้ากลุ่ม: กด "+ สร้างสินค้าใหม่" หรือ "แก้ไข" ที่สินค้าเดิม แล้วเปิดสวิตช์ "สินค้ากลุ่ม" และติ๊กสินค้าย่อย',
      };
    }
    if (kindFilter === 'SINGLE') return { icon: '📦', title: 'ไม่มีสินค้าเดี่ยวในแท็บนี้' };
    if (statusFilter === 'ARCHIVED') return { icon: '📦', title: 'ไม่มีสินค้าที่ปิดใช้งาน', detail: 'หยุดขายชั่วคราวให้กด "ปิดใช้งาน" (เปิดกลับได้ สัญญา/ดีลยังอยู่) · เลิกขายถาวรใช้ "ลบ"' };
    return { icon: '📦', title: 'ยังไม่มีสินค้า', detail: 'สร้างสินค้าแล้วมอบหมายให้ร้านพร้อม % ส่วนต่าง', action: { label: '+ สร้างสินค้าแรก', onClick: createModal } };
  };

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, isSuper ? 'สินค้าทั้งหมด' : 'สินค้าที่ได้รับมอบหมาย'),
        el('p', {}, isSuper
          ? `ใช้งาน ${int(activeTotal)} รายการ${groupTotal ? ` (สินค้ากลุ่ม ${int(groupTotal)})` : ''} · ยังไม่มอบหมาย ${int(unassigned)} รายการ · สินค้า 1 ชิ้นมอบหมายได้ร้านเดียวต่อช่วงเวลา · หยุดขายชั่วคราวให้ปิดใช้งาน (เปิดกลับได้) · ลบ = ถาวร`
          : `${products.length} รายการที่คุณมีสิทธิ์ขายและต้องรายงานยอด`)),
      el('div', { class: 'btn-row' },
        activityButton(['product', 'assignment']),
        isSuper && el('button', { class: 'btn', onclick: createModal }, '+ สร้างสินค้าใหม่'))),

    tabs,

    card(null, table(columns, products, {
      search: 'ค้นหารหัสหรือชื่อสินค้า…',
      empty: emptyOf(),
    }), { tight: true }));
}
