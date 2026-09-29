import { api, qs, session } from '../api.js';
import {
  badge, card, commBadge, confirmAction, copyText, dateTh, dateTimeTh, el, formModal, infoModal, int,
  loginSetModal, loginSetText, loginUrl, money, pct, randomPassword, resetPasswordModal, stat, table, toast,
} from '../ui.js';
import { periodLabel, todayIso } from '../period.js';
import { render } from '../app.js';
import { activityButton } from './activity.js';
import { viewState } from '../viewState.js';
import { avatar } from '../charts.js';
import { commissionDetail, commissionSubtitle, commissionTitle, isBill } from './commissionLines.js';
// ตัวคิดเลข/ตรวจตัวเลขชุดเดียวกับหน้าออกบิล — พรีวิวต้องปัดเศษและเตือนเหมือนเซิร์ฟเวอร์เป๊ะ
// componentsLine: บรรทัด "ประกอบด้วย" ของสินค้ากลุ่ม คำเดียวกับบิลร้าน (ตัวช่วยกลางที่เดียว)
import { commissionOf, componentsLine, dealTerms, parseAmount, parsePct, sumBaht } from './billLines.js';

const TAB_KEY = 'franchise.agentTab';
const COMM_STATUS_KEY = 'franchise.commStatus';
const COMM_AGENT_KEY = 'franchise.commAgent';

// เพดานต่อบิลค่าคอมเดียวกับเซิร์ฟเวอร์ — ตรวจก่อนส่ง จะได้บอกได้ตรง ๆ ว่าเกินตรงไหน
const MAX_BILL_ITEMS = 500;
const MAX_BILL_FIXED = 200;
const MAX_BILL_OTHERS = 50;

/**
 * ดีลเปิดอยู่ = ยังไม่มีวันปิด (ปิดดีลคือกดปุ่มเดียว ระบบลงวันปิดเป็นวันนี้ให้เอง)
 * ดีลเก่าที่เคยตั้งวันสิ้นสุดล่วงหน้าไว้ ยังนับว่าเปิดจนถึงวันนั้น
 */
const dealOpen = (l) => !l.endDate || l.endDate > todayIso();

/** สถานะดีลแบบอ่านอย่างเดียว — เจ้าของระบบไม่ให้มีช่องวันที่ในดีลแล้ว วันที่เป็นแค่บันทึกว่าเกิดเมื่อไร */
const dealStatus = (l) => (dealOpen(l)
  ? el('div', {}, badge('ACTIVE'),
    el('div', { class: 'sub-line' }, `เริ่ม ${dateTh(l.startDate)}${l.endDate ? ` · ถึง ${dateTh(l.endDate)}` : ''}`))
  : el('div', {}, badge('CLOSED'), el('div', { class: 'sub-line' }, `ปิดแล้ว ${dateTh(l.endDate)}`)));

/** เงื่อนไขดีลของแถวดีล (ช่อง commissionPct/fixedAmount) — คำเดียวกับที่โชว์ในหน้าทำบิลค่าคอม */
const linkTerms = (l) => dealTerms({ pct: l.commissionPct, fixedAmount: l.fixedAmount });

const muted = (text = '—') => el('span', { class: 'muted' }, text);

/** ค่าในช่องกรอกเทียบกับตัวเลขของดีล — '' = ไม่มี (null) · ใช้ดูว่าผู้ใช้แก้จริงไหม */
const typedNumber = (raw) => {
  const s = String(raw ?? '').trim();
  return s === '' ? null : Number(s);
};

/**
 * ช่องตัวเลขของดีลพร้อมหน่วยกำกับ — ดีลเดิมมีตัวเลขเต็มช่องแล้ว placeholder หายไป
 * เหลือ "5" กับ "300" เฉย ๆ บนมือถือแยกไม่ออกว่าช่องไหนคือ % ช่องไหนคือเหมา
 */
const unitField = (input, before, after) => el('label', { style: 'display:inline-flex;align-items:center;gap:6px' },
  before ? el('span', { class: 'muted', style: 'font-size:12px' }, before) : '',
  input,
  el('span', { class: 'muted', style: 'font-size:12px' }, after));

/**
 * ตรวจตัวเลขของดีลหนึ่งแถว → { commissionPct, fixedAmount } (null = ไม่มีช่องนั้น) หรือ throw พร้อมบอกว่าต้องแก้ตรงไหน
 * กติกาเดียวกับเซิร์ฟเวอร์: ต้องมีอย่างน้อย % หรือเหมาต่อรอบ — ใช้ทั้งดีลใหม่ ดีลเดิมในหน้าต่างตั้งค่าคอม และฟอร์มแก้ดีล
 */
function dealNumbers(pctRaw, fixedRaw, { prefix = '', emptyMessage } = {}) {
  const p = parsePct(pctRaw);
  const f = parseAmount(fixedRaw, 1, { capAtGross: false });
  if (p.empty && f.empty) {
    throw new Error(`${prefix}${emptyMessage ?? 'กรอกอย่างน้อยหนึ่งช่อง — % ของยอดขายเต็ม หรือเหมาต่อรอบ'}`);
  }
  if (p.error) throw new Error(`${prefix}% ${p.error}`);
  if (f.error) throw new Error(`${prefix}เหมาต่อรอบ${f.error.startsWith('ค่าคอมต้อง') ? 'ต้องเป็น 0 หรือมากกว่า' : ` ${f.error}`}`);
  return { commissionPct: p.empty ? null : p.value, fixedAmount: f.empty ? null : f.value };
}

// ดีลที่เหลือไม่มีทั้ง % และเหมา = ไม่ได้อะไรเลย — ถ้าตั้งใจเลิกให้คอม ทางที่ถูกคือปิดดีล (สินค้าจะได้ผูกให้คนอื่นได้)
const EDIT_EMPTY = 'ต้องเหลืออย่างน้อยหนึ่งช่อง — % ของยอดขายเต็ม หรือเหมาต่อรอบ (ถ้าจะเลิกให้คอมสินค้านี้ ให้กด "ปิดดีล" แทน)';

// แก้ดีลไม่ย้อนไปแตะบิลค่าคอมเก่า (รายการในบิลเก็บตัวเลขตอนทำบิลไว้แล้ว) — บอกให้ชัดทุกที่ที่แก้ได้
const EDIT_EFFECT = 'แก้แล้วมีผลกับบิลค่าคอมที่ทำหลังจากนี้ — บิลค่าคอมที่ทำไปแล้วไม่เปลี่ยน';

/*
 * % ส่วนต่างของสินค้า (ที่ร้านจ่ายทางเรา) ต่อ productId — เจ้าของระบบ: "ตอนผูกดีลเซล ต้องโชว์ด้วยว่าสินค้าถูกตั้งกี่เปอร์เซ็นต์"
 * คนตั้ง % ให้เซลต้องเห็นว่าทางเราได้จากสินค้านั้นเท่าไร จะได้ไม่ตั้งค่าคอมเซลเกินส่วนต่างโดยไม่รู้ตัว
 * อ่านจากรายการสินค้าในหน้านี้ ไม่ได้ใส่ไว้ในข้อมูลดีลจากเซิร์ฟเวอร์ — ข้อมูลดีลเซลเปิดดูได้ด้วย แต่ส่วนต่างเป็นตัวเลขของทางเรา
 * ตั้งค่าตอนโหลดหน้า (salesAgentsView) — หน้านี้เป็นของส่วนกลางอย่างเดียว
 */
let productPctById = new Map();
const productPctOf = (productId) => productPctById.get(Number(productId)) ?? null;

/**
 * บรรทัดเทียบ % ใต้แถวดีล: ส่วนต่างของสินค้า vs % ค่าคอมเซล
 * ค่าคอมเซลคิดจากยอดขายเต็ม ส่วนต่างก็คิดจากยอดขายเต็ม — % ของเซลเท่ากับหรือเกินส่วนต่าง = ทางเราจ่ายเซลหมดหรือขาดทุนจากสินค้านั้น
 * เตือนเฉย ๆ ไม่ห้าม (บางดีลตั้งใจยอมขาดทุนเพื่อเปิดตลาด)
 */
function marginHint(productId, agentPctRaw) {
  if (!productId) return '';
  const productPct = productPctOf(productId);
  const agentPct = typedNumber(agentPctRaw);
  const over = productPct !== null && agentPct !== null && agentPct >= productPct;
  return el('div', {
    class: 'sub-line',
    style: `flex-basis:100%;${over ? 'color:var(--warn);font-weight:600' : ''}`,
  },
  productPct === null
    ? 'ไม่พบ % ส่วนต่างของสินค้านี้'
    : `สินค้านี้ตั้งส่วนต่างไว้ ${pct(productPct)} (ร้านจ่ายทางเรา)`,
  agentPct !== null ? ` · ค่าคอมเซล ${pct(agentPct)} ของยอดขายเต็ม` : '',
  over ? ' — ⚠ ค่าคอมเซลเท่ากับหรือมากกว่าส่วนต่างที่ได้จากร้าน' : '');
}

/** คอลัมน์ "ส่วนต่างสินค้า" ของตารางดีล — วางคู่กับ % ของเซลให้เทียบกันได้ทันที */
const productPctColumn = {
  label: 'ส่วนต่างสินค้า',
  num: true,
  sortValue: (l) => productPctOf(l.productId) ?? -1,
  render: (l) => {
    const p = productPctOf(l.productId);
    return p === null ? muted() : pct(p);
  },
};

/**
 * แก้เงื่อนไขดีลเดิม — ได้แค่ % / เหมาต่อรอบ / หมายเหตุ (เจ้าของระบบให้ตัดวันที่และตัวเลือกฐานทิ้งแล้ว)
 * ฟอร์มเดียวใช้ทั้งแท็บ "ดีล สินค้า ↔ เซล" และรายละเอียดเซล — onSaved บอกว่าต้องวาดอะไรใหม่หลังบันทึก
 */
function dealEditModal(link, { onSaved }) {
  return formModal({
    title: `แก้เงื่อนไขดีล ${link.agentUsername} ↔ ${link.sku}`,
    fields: [
      { name: 'commissionPct', label: '% ของยอดขายเต็ม', type: 'number', step: '0.01', value: link.commissionPct ?? '', hint: 'เว้นว่าง = ไม่มี %' },
      { name: 'fixedAmount', label: 'เหมาต่อรอบ (บาท)', type: 'number', step: '0.01', value: link.fixedAmount ?? '', hint: 'เว้นว่าง = ไม่มีเหมา · คิดครั้งเดียวต่อร้านต่อรอบ' },
      { name: 'note', label: 'หมายเหตุ', value: link.note ?? '' },
    ],
    preview: (v) => el('div', { class: 'notice-box m-0' },
      el('strong', {}, EDIT_EFFECT),
      el('div', { class: 'sub-line mt-4' },
        `${link.productName ?? link.sku}${link.franchiseUsername ? ` · ร้าน ${link.franchiseUsername}` : ''} · `
        + `เริ่ม ${dateTh(link.startDate)} · % คิดจากยอดขายเต็มของร้าน (ก่อนหักส่วนต่าง)`),
      // เทียบกับส่วนต่างของสินค้าสด ๆ ตามที่พิมพ์ — เห็นก่อนกดบันทึกว่าตั้งเกินส่วนต่างไหม
      marginHint(link.productId, v.commissionPct)),
    onSubmit: async (v) => {
      const numbers = dealNumbers(v.commissionPct, v.fixedAmount, { emptyMessage: EDIT_EMPTY });
      const note = v.note ?? '';
      await api.patch(`/api/sales-agents/links/${link.id}`, {
        // ส่ง null ตรง ๆ เพื่อ "ลบ" ตัวเลขช่องที่เว้นว่าง (ไม่ส่ง = คงค่าเดิม)
        ...numbers,
        // หมายเหตุส่งเฉพาะตอนแก้จริง ประวัติจะได้ไม่มีรายการแก้ที่ไม่ได้แก้อะไร
        ...(note !== (link.note ?? '') ? { note } : {}),
      });
      toast(`แก้ดีล ${link.sku} แล้ว — ใช้กับบิลค่าคอมที่ทำหลังจากนี้`, 'success');
      await onSaved?.();
    },
  });
}

/** ปิดดีล = กดยืนยันอย่างเดียว ระบบลงวันปิดเป็นวันนี้ (เจ้าของระบบไม่อยากให้เลือกวัน) */
const endDeal = (link, { onDone }) => confirmAction(
  `ปิดดีล ${link.agentUsername} ↔ ${link.sku}?\n\n`
  + 'บิลร้านที่ออกไปแล้วยังติ๊กทำบิลค่าคอมให้เซลคนนี้ได้ตามเดิม (ขึ้นป้าย "ดีลปิดแล้ว") · '
  + 'ปิดแล้วสินค้านี้ผูกดีลให้เซลคนอื่นได้ — จะให้ถือต่อต้องผูกดีลใหม่',
  async () => {
    await api.post(`/api/sales-agents/links/${link.id}/end`, {});
    toast(`ปิดดีล ${link.sku} แล้ว`, 'success');
    await onDone?.();
  },
);

export async function salesAgentsView() {
  const tab = viewState.getItem(TAB_KEY) ?? 'agents';
  const [{ items: agents }, { items: products }, { items: allLinks }] = await Promise.all([
    api.get('/api/sales-agents'),
    // โหลดทุกสถานะ — ตารางดีลต้องโชว์ % ส่วนต่างของสินค้าที่ปิดใช้งานไปแล้วด้วย (ตัวเลือกผูกดีลใหม่กรองเฉพาะที่ใช้งานอยู่ข้างล่าง)
    api.get('/api/products'),
    api.get('/api/sales-agents/links'),
  ]);
  productPctById = new Map(products.map((p) => [Number(p.id), p.commissionPct ?? null]));

  const agentOptions = agents.filter((a) => a.status === 'ACTIVE')
    .map((a) => ({ value: String(a.id), label: `${a.username} — ${a.name}` }));
  const agentById = (id) => agents.find((a) => String(a.id) === String(id)) ?? null;

  /*
   * สินค้าที่เลือกผูกดีลได้ ต้องเข้าเงื่อนไขสองข้อ
   *   1. มีร้านถือสิทธิ์ขายอยู่ — ไม่งั้นไม่มียอดให้คิดคอม
   *   2. ยังไม่มีเซลคนอื่นถือดีลที่เปิดอยู่ — 1 สินค้ามีเจ้าของดีลได้คนเดียว (ต้องปิดดีลเดิมก่อน)
   * กันไว้ตั้งแต่ตอนเลือก ดีกว่าปล่อยให้กดบันทึกแล้วค่อยเด้ง error กลับมา
   */
  const takenProductIds = new Set(allLinks.filter(dealOpen).map((l) => l.productId));
  const productOptions = products
    .filter((p) => p.status === 'ACTIVE' && p.currentAssignment && !takenProductIds.has(p.id))
    .map((p) => ({
      value: String(p.id),
      label: `${p.sku} — ${p.name} (${p.currentAssignment.franchiseUsername}) · ส่วนต่าง ${pct(p.commissionPct)}`,
    }));

  const tabs = el('div', { class: 'btn-row tabs' },
    ...[
      { id: 'agents', label: `รายชื่อเซล (${int(agents.length)} คน)` },
      { id: 'links', label: `ดีล สินค้า ↔ เซล (${int(allLinks.length)} ดีล)` },
      // ชื่อเดียวกับที่เจ้าของระบบเรียกและในคู่มือ — ข้างในเป็นบิลค่าคอม (ทำบิล · จ่าย · ยกเลิก)
      { id: 'commissions', label: 'ค่าคอมที่ต้องจ่าย' },
    ].map((t) => el('button', {
      class: `btn ${tab === t.id ? '' : 'ghost'}`,
      onclick: () => { viewState.setItem(TAB_KEY, t.id); render(); },
    }, t.label)));

  const createAgentModal = () => formModal({
    title: 'เพิ่มเซลใหม่',
    submitLabel: 'สร้างเซล',
    fields: [
      {
        name: 'username',
        label: 'Username',
        required: true,
        placeholder: 'sale03',
        maxlength: 40, // ชื่อเซลอยู่ในเลขบิลค่าคอม — เซิร์ฟเวอร์รับไม่เกิน 40 ตัว
        hint: 'ใช้เข้าสู่ระบบและเป็นตัวระบุเซล · a-z 0-9 . _ - เท่านั้น · ไม่เกิน 40 ตัว',
      },
      // สุ่มไว้ให้เลย — สร้างเสร็จแล้วคัดลอกส่งเซลเป็นชุด (ลิงก์ + ชื่อผู้ใช้ + รหัส) ไม่ต้องคิดรหัสเอง
      { name: 'password', label: 'รหัสผ่าน', required: true, value: randomPassword(), hint: 'สุ่มให้แล้ว แก้เองได้ · อย่างน้อย 8 ตัวอักษร' },
      { name: 'name', label: 'ชื่อเซล', required: true, placeholder: 'สมชาย (เซลภาคกลาง)' },
      { name: 'phone', label: 'เบอร์โทร' },
      { name: 'email', label: 'อีเมล' },
    ],
    // ดีลไม่บังคับ — เซลบางคนได้แค่ค่าคอมอื่น ๆ ก็ได้ อย่าให้เข้าใจว่าต้องผูกดีลก่อนถึงจะจ่ายได้
    preview: () => el('div', { class: 'notice-box m-0' },
      'เซลได้ค่าคอมได้สองทาง (ใช้ทางใดทางหนึ่งหรือทั้งสองก็ได้): % จากยอดขายเต็มของสินค้าที่ผูกดีล '
      + 'และค่าคอมอื่น ๆ ที่กรอกเป็นจำนวนเงิน — ทั้งสองอย่างจ่ายผ่าน "🧾 ทำบิลค่าคอม"'),
    onSubmit: async (v) => {
      const res = await api.post('/api/sales-agents', v);
      render();
      // รหัสผ่านโชว์ได้ครั้งเดียวตอนนี้ (เก็บแบบเข้ารหัสทางเดียว) — ส่งเป็นชุดให้เซลเลย
      loginSetModal({
        heading: `สร้างเซล ${v.username} แล้ว — ส่งข้อมูลเข้าระบบให้เซล`,
        title: `เซล ${v.username}`,
        url: loginUrl(),
        username: res.user?.username ?? v.username,
        password: v.password,
        mustChange: Boolean(res.user?.mustChangePassword),
      });
    },
  });

  /**
   * ตั้งค่าคอม (ดีล) ของเซล — ดีลเดิมที่ยังเปิดอยู่ขึ้นก่อนเป็นแถวที่แก้ได้ แล้วตามด้วยแถว "+ เพิ่มสินค้า" สำหรับดีลใหม่
   *
   * เจ้าของระบบ: "ตรงที่ผูกดีลไปแล้ว สามารถแก้ไขได้" — เดิมหน้าต่างนี้เพิ่มได้อย่างเดียว คนเปิดมาเห็นแต่ช่องว่าง
   * นึกว่าเซลยังไม่มีดีล หรือต้องไปหาปุ่มแก้ในแท็บอื่น
   *
   * ไม่มีช่องวันที่ ไม่มีตัวเลือกฐาน และไม่มี "ค่าคอมอื่น ๆ" ในนี้ (เจ้าของระบบสั่ง):
   *   - % คิดจากยอดขายเต็มของร้านเสมอ
   *   - ดีลเริ่มวันที่บันทึก จบเมื่อกด "ปิดดีล"
   *   - ค่าคอมอื่น ๆ ใส่ตอนทำบิลค่าคอม ไม่ต้องเลือกรอบ
   * ดีลไม่บังคับ — เซลที่ได้แค่ค่าคอมอื่น ๆ ไม่ต้องผูกอะไรเลย จึงไม่มีแถวใหม่ให้ตั้งแต่เปิด
   *
   * บันทึกตามลำดับ: แก้ดีลเดิม (เฉพาะที่ตัวเลขเปลี่ยน) → ปิดดีลที่กดปิด (ถามยืนยันก่อน) → ผูกดีลใหม่
   * ปิดก่อนผูกใหม่ — สินค้าที่เพิ่งปิดจะได้ไม่ชนตอนผูกให้คนใหม่ในรอบเดียวกัน
   * สามขั้นเป็นคนละคำขอ: พังกลางทาง = บอกว่าอะไรเข้าไปแล้ว และส่วนที่เข้าแล้วไม่ถูกส่งซ้ำเมื่อกดบันทึกอีกครั้ง
   *
   * เปิดจากแถวเซล (preset.salesAgentId) จะล็อกชื่อเซลไว้เลย ไม่ต้องเลือกซ้ำ
   * เซลที่หยุดใช้งานแล้วก็เปิดได้ — ยังต้องแก้/ปิดดีลเดิมของเขาได้ (เซิร์ฟเวอร์ไม่ให้ผูกดีลใหม่ ปุ่มเพิ่มจึงปิดไว้)
   */
  const dealModal = (preset = {}) => {
    const lockedAgent = preset.salesAgentId ? agentById(preset.salesAgentId) : null;
    const canAdd = !lockedAgent || lockedAgent.status === 'ACTIVE';
    let agentId = lockedAgent ? String(lockedAgent.id) : '';

    const rows = []; // ดีลใหม่: { productId, commissionPct, fixedAmount }
    let current = []; // ดีลเดิมที่ยังเปิดอยู่: { link, pct, fixed, closing }
    const rowBox = el('div', {});
    const usedProducts = () => new Set(rows.map((r) => r.productId).filter(Boolean));
    const skuOf = (productId) => products.find((p) => String(p.id) === String(productId))?.sku ?? `#${productId}`;

    /** ดีลเดิมของเซลที่เลือก — ข้อมูลชุดเดียวกับแท็บดีล (วาดใหม่ทุกครั้งที่บันทึก จึงไม่เก่ากว่าหน้าจอ) */
    const loadCurrent = () => {
      current = allLinks
        .filter((l) => agentId && String(l.salesAgentId) === String(agentId) && dealOpen(l))
        .map((l) => ({
          link: l,
          pct: l.commissionPct === null || l.commissionPct === undefined ? '' : String(l.commissionPct),
          fixed: l.fixedAmount === null || l.fixedAmount === undefined ? '' : String(l.fixedAmount),
          closing: false,
        }));
    };
    const isChanged = (s) => typedNumber(s.pct) !== (s.link.commissionPct ?? null)
      || typedNumber(s.fixed) !== (s.link.fixedAmount ?? null);
    loadCurrent();

    /** แถวดีลเดิม — สินค้าเปลี่ยนไม่ได้ (จะเปลี่ยนสินค้า = ปิดดีลนี้แล้วเพิ่มสินค้าใหม่) */
    function currentRow(s) {
      const l = s.link;
      const pctBox = el('input', {
        type: 'number', step: '0.01', inputmode: 'decimal', placeholder: '% ของยอดขายเต็ม', value: s.pct,
        style: 'width:130px', 'aria-label': `% ของยอดขายเต็ม — ${l.sku}`,
      });
      const fixedBox = el('input', {
        type: 'number', step: '0.01', inputmode: 'decimal', placeholder: 'เหมาต่อรอบ', value: s.fixed,
        style: 'width:120px', 'aria-label': `เหมาต่อรอบ — ${l.sku}`,
      });
      const closeBtn = el('button', { class: 'btn ghost sm danger', type: 'button' });
      const flag = el('span', {});
      const info = el('div', { class: 'sub-line' },
        `${l.productName ?? ''}${l.franchiseUsername ? ` · ร้าน ${l.franchiseUsername}` : ''} · เริ่ม ${dateTh(l.startDate)}`);
      const hint = el('div', { style: 'flex-basis:100%' });
      const row = el('div', { class: 'adj-row' },
        el('div', { style: 'flex:1 1 220px;min-width:180px' }, el('strong', {}, l.sku), ' ', flag, info),
        unitField(pctBox, '', '%'),
        el('span', { class: 'muted', style: 'font-size:12px' }, 'และ/หรือ'),
        unitField(fixedBox, 'เหมา', '฿/รอบ'),
        closeBtn,
        hint);

      // อัปเดตเฉพาะแถวนี้ ไม่วาดช่องกรอกใหม่ระหว่างพิมพ์ (เคอร์เซอร์ไม่หลุด)
      // แถวที่จะปิดจางเฉพาะข้อมูล — ปุ่ม "ไม่ปิดแล้ว" ต้องเห็นชัดให้กดกลับได้
      const paint = () => {
        pctBox.disabled = s.closing;
        fixedBox.disabled = s.closing;
        closeBtn.textContent = s.closing ? 'ไม่ปิดแล้ว' : 'ปิดดีล';
        info.style.opacity = s.closing ? '.55' : '';
        hint.replaceChildren(s.closing ? '' : marginHint(l.productId, s.pct));
        flag.replaceChildren(s.closing
          ? el('span', { class: 'badge red' }, 'จะปิดดีลเมื่อกดบันทึก')
          : isChanged(s) ? el('span', { class: 'badge blue' }, 'แก้แล้ว — ยังไม่บันทึก') : '');
      };
      pctBox.addEventListener('input', () => { s.pct = pctBox.value; paint(); });
      fixedBox.addEventListener('input', () => { s.fixed = fixedBox.value; paint(); });
      closeBtn.addEventListener('click', () => { s.closing = !s.closing; paint(); });
      paint();
      return row;
    }

    function drawRows() {
      const taken = usedProducts();
      rowBox.replaceChildren(
        current.length
          ? el('div', { class: 'adj-block m-0', style: 'margin-bottom:12px' },
            el('div', { class: 'adj-block-head' },
              el('div', {},
                el('h3', {}, `🤝 ดีลที่ถืออยู่ (${current.length})`),
                el('div', { class: 'sub-line' },
                  `แก้ % / เหมาต่อรอบได้ตรงนี้ — ${EDIT_EFFECT} · "ปิดดีล" = เลิกถือสินค้านั้นตั้งแต่วันนี้`))),
            ...current.map(currentRow))
          : '',

        el('div', { class: 'adj-block m-0' },
          el('div', { class: 'adj-block-head' },
            el('div', {},
              el('h3', {}, current.length ? `📦 เพิ่มสินค้าที่ผูกดีล (${rows.length})` : `📦 สินค้าที่ผูกดีล (${rows.length})`),
              el('div', { class: 'sub-line' },
                '% คิดจากยอดขายเต็มของร้าน (ก่อนหักส่วนต่าง) · เซลได้เงินเมื่อทำบิลค่าคอมแล้วติ๊กรายการของสินค้านี้')),
            el('button', {
              class: 'btn sm',
              type: 'button',
              // เลือกครบทุกชิ้นที่ว่างแล้ว เพิ่มแถวไปก็ไม่มีอะไรให้เลือก
              disabled: !canAdd || rows.length >= productOptions.length,
              onclick: () => { rows.push({ productId: '', commissionPct: '', fixedAmount: '' }); drawRows(); },
            }, '+ เพิ่มสินค้า')),

          ...rows.map((row, i) => {
            // ซ่อนสินค้าที่แถวอื่นเลือกไปแล้ว กันผูกซ้ำตั้งแต่ตอนเลือก
            const choices = productOptions.filter((o) => !taken.has(o.value) || o.value === row.productId);

            const productSel = el('select', { style: 'flex:1 1 260px;min-width:220px', 'aria-label': `สินค้าแถวที่ ${i + 1}` },
              el('option', { value: '', selected: !row.productId }, 'เลือกสินค้า…'),
              ...choices.map((o) => el('option', { value: o.value, selected: o.value === row.productId }, o.label)));
            productSel.addEventListener('change', () => { row.productId = productSel.value; drawRows(); });

            const pctBox = el('input', {
              type: 'number', step: '0.01', inputmode: 'decimal', placeholder: '% ของยอดขายเต็ม', value: row.commissionPct,
              style: 'width:130px', 'aria-label': `% ของยอดขายเต็ม แถวที่ ${i + 1}`,
            });
            // บรรทัดเทียบกับส่วนต่างของสินค้า — วาดเฉพาะบรรทัดนี้ตอนพิมพ์ ช่องกรอกไม่ถูกสร้างใหม่ (เคอร์เซอร์ไม่หลุด)
            const hint = el('div', { style: 'flex-basis:100%' }, marginHint(row.productId, row.commissionPct));
            pctBox.addEventListener('input', () => {
              row.commissionPct = pctBox.value;
              hint.replaceChildren(marginHint(row.productId, row.commissionPct));
            });

            const fixedBox = el('input', {
              type: 'number', step: '0.01', inputmode: 'decimal', placeholder: 'เหมาต่อรอบ', value: row.fixedAmount,
              style: 'width:120px', 'aria-label': `เหมาต่อรอบ แถวที่ ${i + 1}`,
            });
            fixedBox.addEventListener('input', () => { row.fixedAmount = fixedBox.value; });

            return el('div', { class: 'adj-row' },
              productSel,
              unitField(pctBox, '', '%'),
              el('span', { class: 'muted', style: 'font-size:12px' }, 'และ/หรือ'),
              unitField(fixedBox, 'เหมา', '฿/รอบ'),
              el('button', {
                class: 'btn ghost sm danger',
                type: 'button',
                onclick: () => { rows.splice(i, 1); drawRows(); },
              }, 'ลบ'),
              hint);
          }),

          rows.length
            ? el('div', { class: 'sub-line mt-6' },
              'แต่ละชิ้นกรอกอย่างน้อยหนึ่งช่อง — % ของยอดขายเต็ม หรือเหมาต่อรอบ (คิดครั้งเดียวต่อร้านต่อรอบ)')
            : el('div', { class: 'sub-line' },
              !canAdd
                ? 'เซลคนนี้หยุดใช้งานอยู่ — ผูกดีลใหม่ไม่ได้ (แก้/ปิดดีลเดิมด้านบนได้) · เปิดใช้งานเซลก่อนที่ปุ่ม "แก้ไข" ของแถวเซล'
                : !productOptions.length
                  ? 'สินค้าทุกชิ้นที่มีร้านถือสิทธิ์ขายอยู่ มีเซลถือดีลครบแล้ว — ถ้าจะเปลี่ยนมือ ให้ "ปิดดีล" เดิมก่อน'
                  : current.length
                    ? 'กด "+ เพิ่มสินค้า" ถ้าจะให้เซลคนนี้ถือสินค้าเพิ่ม'
                    : 'ไม่บังคับ — เซลที่ได้แค่ค่าคอมอื่น ๆ ไม่ต้องผูกดีล (ใส่ค่าคอมอื่น ๆ ตอนทำบิลค่าคอม) · กด "+ เพิ่มสินค้า" ถ้าจะให้ได้ % จากยอดขายสินค้า')));
    }
    drawRows();

    return formModal({
      title: lockedAgent ? `ตั้งค่าคอมให้ ${lockedAgent.username} — ${lockedAgent.name}` : 'ตั้งค่าคอม (ผูกดีลสินค้า) ให้เซล',
      submitLabel: 'บันทึกดีล',
      width: 760,
      fields: [
        // เปิดจากแถวเซลแล้วรู้อยู่แล้วว่าใคร ชื่ออยู่บนหัวโมดัล — ไม่ต้องมีช่องให้กดผิด
        lockedAgent ? null : { name: 'salesAgentId', label: 'เซล', type: 'select', required: true, options: agentOptions },
        {
          name: 'note',
          label: current.length || !lockedAgent ? 'หมายเหตุของดีลที่เพิ่มใหม่ (ไม่บังคับ)' : 'หมายเหตุของดีล (ไม่บังคับ)',
          hint: 'ใช้กับสินค้าที่เพิ่มในครั้งนี้ · หมายเหตุของดีลเดิมแก้ได้ที่ "แก้ไข" ในรายละเอียดเซล',
        },
      ].filter(Boolean),
      preview: (v) => {
        // เลือกเซลคนอื่น (เปิดแบบไม่ล็อก) = ดีลเดิมที่โชว์ต้องเป็นของคนใหม่ — ที่พิมพ์แก้ไว้ของคนเก่าทิ้งไป
        if (!lockedAgent && (v.salesAgentId ?? '') !== agentId) {
          agentId = v.salesAgentId ?? '';
          loadCurrent();
          drawRows();
        }
        return { node: rowBox, canSubmit: true };
      },
      onSubmit: async (v) => {
        if (!agentId) throw new Error('เลือกเซลก่อน');
        const salesAgentId = Number(agentId);
        const username = agentById(agentId)?.username ?? '';

        // ตรวจทุกแถวให้ผ่านก่อนยิงคำขอแรก — ผิดแถวเดียวไม่มีอะไรถูกบันทึก
        // แถวที่พิมพ์ตัวเลขไว้แต่ลืมเลือกสินค้า — เดิมถูกทิ้งเงียบ ๆ คนตั้งนึกว่าบันทึกไปแล้ว
        rows.forEach((r, i) => {
          if (!r.productId && (r.commissionPct !== '' || r.fixedAmount !== '')) {
            throw new Error(`แถวสินค้าที่ ${i + 1} ยังไม่ได้เลือกสินค้า — เลือกสินค้าหรือกด ลบ แถวนั้น`);
          }
        });
        const items = rows.filter((r) => r.productId).map((r) => ({
          productId: Number(r.productId),
          ...dealNumbers(r.commissionPct, r.fixedAmount, { prefix: `สินค้า ${skuOf(r.productId)}: ` }),
        }));
        const edits = current.filter((s) => !s.closing && isChanged(s)).map((s) => ({
          s,
          body: dealNumbers(s.pct, s.fixed, { prefix: `ดีล ${s.link.sku}: `, emptyMessage: EDIT_EMPTY }),
        }));
        const closing = current.filter((s) => s.closing);

        if (!items.length && !edits.length && !closing.length) {
          if (!current.length) throw new Error('ยังไม่ได้เลือกสินค้า — กด "+ เพิ่มสินค้า" แล้วเลือกสินค้าที่จะให้เซลได้ %');
          toast('ไม่มีอะไรเปลี่ยน — ดีลเดิมยังเหมือนเดิม', 'info');
          return;
        }
        if (closing.length && !window.confirm(
          `ปิดดีล ${closing.map((s) => s.link.sku).join(', ')} ของ ${username}?\n\n`
          + 'บิลร้านที่ออกไปแล้วยังติ๊กทำบิลค่าคอมให้เซลคนนี้ได้ตามเดิม (ขึ้นป้าย "ดีลปิดแล้ว") · '
          + 'ปิดแล้วสินค้านี้ผูกดีลให้เซลคนอื่นได้',
        )) {
          throw new Error('ยังไม่ได้บันทึกอะไร — กด "ไม่ปิดแล้ว" ที่ดีลที่ยังไม่อยากปิด แล้วกดบันทึกอีกครั้ง');
        }

        const done = { edit: 0, end: 0, add: 0 };
        const summary = () => [
          done.edit ? `แก้ดีล ${done.edit}` : '',
          done.end ? `ปิดดีล ${done.end}` : '',
          done.add ? `เพิ่มดีล ${done.add}` : '',
        ].filter(Boolean).join(' · ');
        try {
          for (const { s, body } of edits) {
            // ตัวเลขใหม่กลายเป็น "ค่าเดิม" ทันที — พังขั้นถัดไปแล้วกดบันทึกซ้ำ แถวนี้จะไม่ถูกส่งซ้ำ
            s.link = await api.patch(`/api/sales-agents/links/${s.link.id}`, body);
            done.edit += 1;
          }
          for (const s of closing) {
            await api.post(`/api/sales-agents/links/${s.link.id}/end`, {});
            current = current.filter((x) => x !== s);
            done.end += 1;
          }
          if (items.length) {
            // ทรานแซกชันเดียวฝั่งเซิร์ฟเวอร์ — ชนสักชิ้นไม่มีชิ้นไหนถูกผูก
            const res = await api.post('/api/sales-agents/links', { salesAgentId, ...(v.note ? { note: v.note } : {}), items });
            rows.length = 0;
            done.add = res.count ?? items.length;
          }
        } catch (err) {
          if (!done.edit && !done.end && !done.add) throw err;
          // บางส่วนเข้าไปแล้ว — วาดแถวตามของจริง แล้วบอกให้ชัดว่าอะไรเข้าแล้ว อะไรยังค้าง
          drawRows();
          render();
          throw new Error(`บันทึกไปแล้วบางส่วน (${summary()}) แต่ขั้นถัดไปไม่ผ่าน: ${err.fullMessage ?? err.message} `
            + '— แก้ตามข้อความแล้วกดบันทึกอีกครั้ง (ส่วนที่บันทึกแล้วไม่ถูกส่งซ้ำ)');
        }

        toast(`บันทึกดีลของ ${username} แล้ว — ${summary()}`, 'success');
        render();
      },
    });
  };

  /**
   * ทำบิลค่าคอมให้เซล — บิลค่าคอม 1 ใบ = จ่ายเซล 1 ครั้ง
   *
   * เจ้าของระบบ: "แต่ละรอบจ่ายค่าคอมไม่เหมือนกัน" — จึงไม่คิดอัตโนมัติตอนออกบิลร้านแล้ว
   * ให้ติ๊กเองว่าจะจ่ายรายการไหน จากบิลร้านที่ออกไปแล้ว (ไม่ต้องรอร้านจ่าย) เฉพาะสินค้าที่เซลคนนี้ถือดีล
   * แต่ละรายการคิด "% ของยอดเต็ม" (ตั้งต้น = % ของดีล) หรือ "กรอกเอง" + ค่าคอมอื่น ๆ ที่ไม่ต้องเลือกรอบ
   *
   * ตัวเลขในนี้เป็นพรีวิว เซิร์ฟเวอร์ตรวจและคิดใหม่เองตอนบันทึก
   * รายการหนึ่งจ่ายเป็นค่าคอมได้ครั้งเดียว (ฐานข้อมูลกันไว้) — ชนกับคนอื่นเมื่อไรโหลดรายการใหม่ให้
   *
   * preset.salesAgentId + lock: เปิดจากแถวเซล = ล็อกชื่อเซล · จากแท็บบิลค่าคอม = เลือกไว้ให้แต่เปลี่ยนได้
   */
  const commissionBillModal = (preset = {}) => {
    const locked = preset.lock ? agentById(preset.salesAgentId) : null;

    /*
     * สถานะทั้งหมดอยู่นอกฟอร์ม — พรีวิวของ formModal ถูกเรียกซ้ำทุกครั้งที่พิมพ์หมายเหตุ
     * ถ้าวาดใหม่ทุกครั้ง ติ๊ก/ตัวเลขที่กรอกไว้จะหาย และเคอร์เซอร์หลุดระหว่างพิมพ์
     */
    let agentId = locked ? String(locked.id) : (agentById(preset.salesAgentId) ? String(preset.salesAgentId) : '');
    let loadSeq = 0;
    let loaded = false;
    const items = new Map(); // entryId → { item, on, mode, pct, amount, refs }
    const fixed = new Map(); // key → { f, on, amount, refs }
    let others = []; // [{ label, amount }]
    let groups = []; // บิลร้านละกลุ่ม: { invoiceNo, …, rows: [state], box }

    const content = el('div');
    const othersBox = el('div');
    const totalBox = el('div', { class: 'notice-box', style: 'margin:12px 0 0' });
    const toggleAll = el('input', { type: 'checkbox' });
    const pickedCount = el('span', { class: 'sub-line' });

    const picker = locked ? null : el('select', { 'aria-label': 'เซลที่จะทำบิลค่าคอมให้' },
      el('option', { value: '', selected: !agentId }, 'เลือกเซล…'),
      ...agents.map((a) => el('option', { value: String(a.id), selected: String(a.id) === agentId },
        `${a.username} — ${a.name}${a.status === 'ACTIVE' ? '' : ' (หยุดใช้งาน)'}`)));
    picker?.addEventListener('change', () => {
      agentId = picker.value;
      // ค่าคอมอื่น ๆ ที่พิมพ์ไว้เป็นของเซลคนก่อน — เปลี่ยนคนแล้วเริ่มใหม่ ไม่ให้ติดไปจ่ายผิดคน
      others = [];
      load();
    });

    /* ── ตัวเลขของแต่ละแถว: { amount } หรือ { amount: 0, error } ── */

    const itemResult = (s) => {
      const gross = Number(s.item.grossAmount);
      if (s.mode === 'MANUAL') {
        // กรอกเองเกินยอดเต็มได้ (ตกลงกับเซลเอง) แต่เครื่องหมายต้องไปทางเดียวกับยอดขาย — กติกาเดียวกับเซิร์ฟเวอร์
        const r = parseAmount(s.amount, gross, { capAtGross: false });
        if (r.empty) return { amount: 0, error: 'ใส่จำนวนเงิน' };
        return r.error ? { amount: 0, error: r.error } : { amount: r.value };
      }
      const p = parsePct(s.pct);
      if (p.empty) return { amount: 0, error: 'ใส่ %' };
      if (p.error) return { amount: 0, error: `% ${p.error}` };
      return { amount: commissionOf(gross, p.value), pct: p.value };
    };

    const fixedResult = (s) => {
      const r = parseAmount(s.amount, 1, { capAtGross: false });
      if (r.empty) return { amount: 0, error: 'ใส่จำนวนเงิน' };
      if (!r.error && r.value > 0) return { amount: r.value };
      return { amount: 0, error: r.error && !r.error.startsWith('ค่าคอมต้อง') ? r.error : 'ต้องมากกว่า 0' };
    };

    const otherResult = (o) => {
      const label = o.label.trim();
      // ติดลบได้ (หักคืนค่าคอมที่จ่ายเกิน) — ส่งตัวเองเป็น "ยอดเต็ม" เพื่อข้ามการตรวจเครื่องหมาย
      const r = parseAmount(o.amount, o.amount, { capAtGross: false });
      if (!label) return { amount: 0, error: 'ต้องมีชื่อรายการ' };
      if (label.length > 200) return { amount: 0, error: 'ชื่อรายการยาวเกิน 200 ตัวอักษร' };
      if (r.empty) return { amount: 0, error: 'ต้องใส่จำนวนเงิน' };
      if (r.error) return { amount: 0, error: r.error };
      if (r.value === 0) return { amount: 0, error: 'จำนวนเงินต้องไม่เป็น 0 (ติดลบได้ ถ้าเป็นการหักคืน)' };
      return { amount: r.value, label };
    };

    function compute() {
      const onItems = [...items.values()].filter((s) => s.on);
      const onFixed = [...fixed.values()].filter((s) => s.on);
      // แถวค่าคอมอื่น ๆ ที่ว่างทั้งแถว (กดเพิ่มไว้เฉย ๆ) ไม่นับ — กรอกครึ่งเดียวถึงจะเตือน
      const filled = others.filter((o) => o.label.trim() !== '' || String(o.amount).trim() !== '');
      const itemRes = onItems.map((s) => ({ s, ...itemResult(s) }));
      const fixedRes = onFixed.map((s) => ({ s, ...fixedResult(s) }));
      const otherRes = filled.map((o) => ({ o, ...otherResult(o) }));
      const error = [
        ...itemRes.map((r) => r.error && `บิล ${r.s.item.invoiceNo} · ${r.s.item.sku}: ${r.error}`),
        ...fixedRes.map((r) => r.error && `เหมาต่อรอบ ร้าน ${r.s.f.franchiseUsername} ${periodLabel(r.s.f.periodCode)}: ${r.error}`),
        ...otherRes.map((r) => r.error && `ค่าคอมอื่น ๆ แถวที่ ${others.indexOf(r.o) + 1}: ${r.error}`),
      ].find(Boolean) ?? null;
      const itemsTotal = sumBaht(itemRes.map((r) => r.amount));
      const fixedTotal = sumBaht(fixedRes.map((r) => r.amount));
      const othersTotal = sumBaht(otherRes.map((r) => r.amount));
      return {
        itemRes,
        fixedRes,
        otherRes,
        itemsTotal,
        fixedTotal,
        othersTotal,
        grossTotal: sumBaht(onItems.map((s) => s.item.grossAmount)),
        total: sumBaht([itemsTotal, fixedTotal, othersTotal]),
        lineCount: itemRes.length + fixedRes.length + otherRes.length,
        error,
      };
    }

    /* ── วาด/อัปเดต ── */

    // ป้ายเป็นข้อความทุกคอลัมน์ — บนมือถือตารางพลิกเป็นการ์ด แล้วใช้ป้ายนี้บอกว่าช่องคืออะไร
    const COLS = ['เลือก', 'สินค้า', 'ยอดขายเต็ม', 'วิธีคิด', '% ของยอดเต็ม', 'จำนวนเงิน (บาท)', 'ค่าคอม'];
    const NUM_COLS = new Set([2, 4, 5, 6]);
    const td = (i, ...children) => el('td', { class: NUM_COLS.has(i) ? 'num' : '', 'data-label': COLS[i] }, ...children);
    const numberIn = (cls, value, placeholder, label) => el('input', {
      type: 'number', step: '0.01', inputmode: 'decimal', class: cls, value, placeholder, 'aria-label': label,
    });

    /** อัปเดตเฉพาะช่องของแถวนี้ — ไม่สร้างช่องกรอกใหม่ระหว่างพิมพ์ (เคอร์เซอร์ไม่หลุด) */
    function paintItem(s) {
      const r = s.refs;
      const manual = s.mode === 'MANUAL';
      const res = itemResult(s);
      r.mode.disabled = !s.on;
      r.pctIn.disabled = !s.on || manual;
      r.amountIn.disabled = !s.on;
      r.amountIn.hidden = !manual;
      r.pctIn.classList.toggle('invalid', s.on && !manual && Boolean(res.error));
      r.amountIn.classList.toggle('invalid', s.on && manual && Boolean(res.error));
      r.computed.textContent = res.error ? '—' : money(res.amount);
      r.error.textContent = s.on && res.error ? res.error : '';
      r.tr.classList.toggle('line-off', !s.on);
    }

    function paintFixed(s) {
      const r = s.refs;
      const res = fixedResult(s);
      r.amountIn.disabled = !s.on;
      r.amountIn.classList.toggle('invalid', s.on && Boolean(res.error));
      r.computed.textContent = res.error ? '—' : money(res.amount);
      r.error.textContent = s.on && res.error ? res.error : '';
      r.tr.classList.toggle('line-off', !s.on);
    }

    const paintRow = (s) => (s.item ? paintItem(s) : paintFixed(s));

    function paintTotals() {
      const all = [...items.values(), ...fixed.values()];
      const onCount = all.filter((s) => s.on).length;
      toggleAll.checked = all.length > 0 && onCount === all.length;
      toggleAll.indeterminate = onCount > 0 && onCount < all.length;
      pickedCount.textContent = `(${onCount}/${all.length})`;
      for (const g of groups) {
        const n = g.rows.filter((s) => s.on).length;
        g.box.checked = n === g.rows.length;
        g.box.indeterminate = n > 0 && n < g.rows.length;
      }

      const t = compute();
      totalBox.replaceChildren(
        el('strong', {}, `รวมบิลค่าคอม ${money(t.total)} ฿`),
        el('div', { class: 'sub-line mt-4' }, [
          `สินค้า ${t.itemRes.length} รายการ (ยอดเต็ม ${money(t.grossTotal)}) → ${money(t.itemsTotal)}`,
          `เหมาต่อรอบ ${t.fixedRes.length} → ${money(t.fixedTotal)}`,
          `ค่าคอมอื่น ๆ ${t.otherRes.length} → ${money(t.othersTotal)}`,
        ].join(' · ')),
        t.error
          ? el('div', { class: 'text-danger mt-4' }, `⚠ ${t.error}`)
          : t.lineCount && t.total <= 0
            ? el('div', { class: 'text-danger mt-4' }, '⚠ ยอดรวมบิลค่าคอมต้องมากกว่า 0')
            : '');
    }

    const setOn = (s, on) => {
      s.on = on;
      s.refs.box.checked = on;
      paintRow(s);
    };

    toggleAll.addEventListener('change', () => {
      for (const s of [...items.values(), ...fixed.values()]) setOn(s, toggleAll.checked);
      paintTotals();
    });

    const tickBox = (s, label) => {
      const box = el('input', { type: 'checkbox', checked: s.on, 'aria-label': label });
      box.addEventListener('change', () => { s.on = box.checked; paintRow(s); paintTotals(); });
      return box;
    };

    function itemRow(s) {
      const it = s.item;
      const box = tickBox(s, `เลือก ${it.sku} จากบิล ${it.invoiceNo}`);
      const mode = el('select', { class: 'line-mode', 'aria-label': `วิธีคิดค่าคอมของ ${it.sku}` },
        el('option', { value: 'PCT', selected: s.mode === 'PCT' }, '% ของยอดเต็ม'),
        el('option', { value: 'MANUAL', selected: s.mode === 'MANUAL' }, 'กรอกเอง'));
      const pctIn = numberIn('line-pct', s.pct, '%', `% ค่าคอมของ ${it.sku}`);
      pctIn.min = '0';
      pctIn.max = '100';
      const amountIn = numberIn('line-amount', s.amount, 'บาท', `ค่าคอมที่กรอกเองของ ${it.sku}`);
      const computed = el('span', { class: 'line-computed' });
      const error = el('span', { class: 'line-error' });

      mode.addEventListener('change', () => {
        // สลับเป็น "กรอกเอง" ครั้งแรก: เติมยอดที่ % คิดได้ตอนนั้นให้ — แก้ต่อจากเลขนั้นง่ายกว่าพิมพ์ใหม่
        if (mode.value === 'MANUAL' && s.amount === '') {
          const r = itemResult(s);
          if (!r.error) { s.amount = String(r.amount); amountIn.value = s.amount; }
        }
        s.mode = mode.value;
        paintItem(s);
        paintTotals();
      });
      pctIn.addEventListener('input', () => { s.pct = pctIn.value; paintItem(s); paintTotals(); });
      amountIn.addEventListener('input', () => { s.amount = amountIn.value; paintItem(s); paintTotals(); });

      const tr = el('tr', {},
        td(0, box),
        td(1, el('div', {},
          el('strong', {}, it.sku), ' ',
          // ดีลปิดไปแล้วแต่บิลร้านออกตอนที่ยังถือดีลอยู่ — ยังจ่ายได้ แค่บอกให้รู้
          it.deal && it.deal.isOpen === false ? el('span', { class: 'badge gray' }, 'ดีลปิดแล้ว') : '',
          el('div', { class: 'sub-line' }, it.productName ?? ''),
          // สินค้ากลุ่ม = รายการเดียว คิดจากยอดเต็มของทั้งกลุ่ม — บอกแค่ว่าในชุดมีอะไร (ไม่มี components = ไม่วาด)
          componentsLine(it.components),
          el('div', { class: 'sub-line' }, `ดีล: ${dealTerms(it.deal)}`))),
        td(2, money(it.grossAmount)),
        td(3, mode),
        td(4, pctIn),
        // ช่องกรอกเงินอยู่ตรง ๆ ใต้ td — บนมือถือ CSS ซ่อนทั้งช่องเมื่อไม่ได้ใช้ (td:has(> input[hidden]))
        td(5, amountIn),
        td(6, el('div', { class: 'line-cell' }, computed, error)));
      s.refs = { tr, box, mode, pctIn, amountIn, computed, error };
      paintItem(s);
      return tr;
    }

    function fixedRow(s) {
      const f = s.f;
      const box = tickBox(s, `เลือกเหมาต่อรอบ ร้าน ${f.franchiseUsername} ${periodLabel(f.periodCode)}`);
      const amountIn = numberIn('line-amount', s.amount, 'บาท', `เหมาต่อรอบของร้าน ${f.franchiseUsername}`);
      amountIn.addEventListener('input', () => { s.amount = amountIn.value; paintFixed(s); paintTotals(); });
      const computed = el('span', { class: 'line-computed' });
      const error = el('span', { class: 'line-error' });
      const tr = el('tr', {},
        td(0, box),
        td(1, el('div', {},
          el('strong', {}, 'เหมาต่อรอบ'),
          el('div', { class: 'sub-line' }, `ร้าน ${f.franchiseUsername} · ${periodLabel(f.periodCode)}`),
          // คิดครั้งเดียวต่อ (เซล × ร้าน × รอบ) — ถ้าติ๊กไปแล้วในบิลค่าคอมใบอื่น แถวนี้จะไม่ขึ้นมาอีก
          el('div', { class: 'sub-line' }, 'ครั้งเดียวต่อร้านต่อรอบ · ตั้งต้นตามดีล แก้ได้'))),
        td(2, muted()),
        td(3, muted('จำนวนเงินคงที่')),
        td(4, muted()),
        td(5, amountIn),
        td(6, el('div', { class: 'line-cell' }, computed, error)));
      s.refs = { tr, box, amountIn, computed, error };
      paintFixed(s);
      return tr;
    }

    /**
     * จัดกลุ่มตามบิลร้าน — คนทำบิลค่าคอมคิดเป็น "บิลร้านใบไหนจ่ายเซลไปแล้วบ้าง"
     * เหมาต่อรอบของ (ร้าน × รอบ) อยู่ท้ายกลุ่มของบิลร้านใบนั้น (หนึ่งร้านหนึ่งรอบมีบิลเดียว)
     */
    function buildGroups() {
      const byInvoice = new Map();
      const groupOf = (src) => {
        if (!byInvoice.has(src.invoiceId)) {
          byInvoice.set(src.invoiceId, {
            invoiceId: src.invoiceId,
            invoiceNo: src.invoiceNo,
            invoiceStatus: src.invoiceStatus,
            franchiseUsername: src.franchiseUsername,
            periodCode: src.periodCode,
            rows: [],
          });
        }
        return byInvoice.get(src.invoiceId);
      };
      for (const s of items.values()) groupOf(s.item).rows.push(s);
      for (const s of fixed.values()) groupOf(s.f).rows.push(s);
      return [...byInvoice.values()];
    }

    function groupHead(g) {
      const box = el('input', { type: 'checkbox', 'aria-label': `เลือกทั้งบิล ${g.invoiceNo}` });
      box.addEventListener('change', () => {
        for (const s of g.rows) setOn(s, box.checked);
        paintTotals();
      });
      g.box = box;
      return el('tr', { class: 'bill-group-head' },
        el('td', { colspan: COLS.length, 'data-label': '' },
          el('label', {},
            box,
            `🧾 ${g.invoiceNo ?? '—'}`,
            el('span', { class: 'sub-line' }, `ร้าน ${g.franchiseUsername ?? '—'} · ${periodLabel(g.periodCode)}`)),
          // ไม่ต้องรอร้านจ่าย — แค่บอกสถานะบิลร้านไว้ประกอบการตัดสินใจ
          g.invoiceStatus ? el('span', { style: 'margin-left:8px' }, badge(g.invoiceStatus)) : ''));
    }

    function drawOthers() {
      othersBox.replaceChildren(el('div', { class: 'adj-block' },
        el('div', { class: 'adj-block-head' },
          el('div', {},
            el('h3', {}, `💰 ค่าคอมอื่น ๆ (${others.length})`),
            el('div', { class: 'sub-line' },
              'จ่ายเป็นก้อน ไม่ผูกกับสินค้าและไม่ต้องเลือกรอบ เช่นโบนัสปิดดีล ค่าเดินทาง · ใส่ติดลบได้ ถ้าเป็นการหักคืน')),
          el('button', {
            class: 'btn sm',
            type: 'button',
            disabled: others.length >= MAX_BILL_OTHERS,
            onclick: () => { others.push({ label: '', amount: '' }); drawOthers(); paintTotals(); },
          }, '+ เพิ่มรายการ')),
        ...others.map((o, i) => {
          const labelBox = el('input', {
            type: 'text', placeholder: 'ชื่อรายการ', value: o.label, maxlength: 200,
            style: 'flex:1 1 220px;min-width:160px', 'aria-label': `ชื่อค่าคอมอื่น ๆ แถวที่ ${i + 1}`,
          });
          labelBox.addEventListener('input', () => { o.label = labelBox.value; paintTotals(); });
          const amountBox = el('input', {
            type: 'number', step: '0.01', inputmode: 'decimal', placeholder: 'จำนวนเงิน ฿', value: o.amount,
            style: 'width:150px', 'aria-label': `จำนวนเงินค่าคอมอื่น ๆ แถวที่ ${i + 1}`,
          });
          amountBox.addEventListener('input', () => { o.amount = amountBox.value; paintTotals(); });
          return el('div', { class: 'adj-row' },
            labelBox,
            amountBox,
            el('button', {
              class: 'btn ghost sm danger',
              type: 'button',
              onclick: () => { others.splice(i, 1); drawOthers(); paintTotals(); },
            }, 'ลบ'));
        }),
        others.length ? '' : el('div', { class: 'sub-line' }, 'ไม่มี — กด "+ เพิ่มรายการ" ถ้าจะจ่ายก้อนพิเศษหรือหักคืนในบิลนี้')));
    }

    function draw() {
      groups = buildGroups();
      const tickable = items.size + fixed.size;
      const tbody = el('tbody', {}, ...groups.flatMap((g) => [
        groupHead(g),
        ...g.rows.map((s) => (s.item ? itemRow(s) : fixedRow(s))),
      ]));

      content.replaceChildren(
        tickable
          ? el('div', { class: 'line-editor' },
            el('div', { class: 'sub-line mb-8' },
              'ติ๊กรายการจากบิลร้านที่จะจ่ายในบิลค่าคอมนี้ — ไม่ต้องรอร้านจ่ายบิลก่อน · '
              + '% คิดจากยอดขายเต็ม (ตั้งต้นตาม % ของดีล) หรือเลือก "กรอกเอง" · ที่ไม่ติ๊กไว้จะยังค้างให้ทำบิลครั้งหน้า'),
            // "เลือกทั้งหมด" อยู่เหนือตาราง — บนมือถือหัวตารางถูกซ่อน ถ้าอยู่ในหัวตารางจะหายไปด้วย
            el('label', { class: 'check-all' }, toggleAll, 'เลือกทั้งหมด', pickedCount),
            el('div', { class: 'table-scroll' },
              el('table', {},
                el('thead', {}, el('tr', {}, ...COLS.map((c, i) => el('th', { class: NUM_COLS.has(i) ? 'num' : '' }, c)))),
                tbody)))
          : el('div', { class: 'notice-box m-0' },
            'ยังไม่มีรายการจากบิลร้านของสินค้าที่เซลคนนี้ถือดีล — ใส่ค่าคอมอื่น ๆ ได้'),
        othersBox,
        totalBox);
      drawOthers();
      paintTotals();
    }

    /**
     * โหลดรายการที่ทำบิลได้ของเซลคนนี้
     * keepState: โหลดใหม่หลังชนกับคนอื่น — ติ๊ก/ตัวเลขของรายการที่ยังเหลืออยู่คงไว้ ค่าคอมอื่น ๆ ก็คงไว้
     */
    async function load({ keepState = false } = {}) {
      const seq = ++loadSeq;
      loaded = false;
      if (!agentId) {
        content.replaceChildren(el('div', { class: 'sub-line' },
          'เลือกเซลก่อน — รายการจากบิลร้านของสินค้าที่เซลคนนั้นถือดีลจะขึ้นตรงนี้'));
        return;
      }
      content.replaceChildren(el('div', { class: 'sub-line' }, 'กำลังโหลดรายการ…'));
      let res;
      try {
        res = await api.get(`/api/sales-agents/${agentId}/commission-candidates`);
      } catch (err) {
        if (seq === loadSeq) {
          content.replaceChildren(el('div', { class: 'alert-box m-0' }, `โหลดรายการไม่ได้ — ${err.fullMessage ?? err.message}`));
        }
        return;
      }
      if (seq !== loadSeq) return; // เปลี่ยนเซลระหว่างรอ — ผลนี้เก่าแล้ว ห้ามเขียนทับของเซลคนใหม่

      const prevItems = keepState ? new Map(items) : new Map();
      const prevFixed = keepState ? new Map(fixed) : new Map();
      items.clear();
      fixed.clear();
      for (const it of res.items ?? []) {
        const prev = prevItems.get(it.entryId);
        items.set(it.entryId, prev
          ? { ...prev, item: it, refs: null }
          // ตั้งต้นไม่ติ๊ก — เงินออกจากบริษัท ต้องเป็นรายการที่ตั้งใจเลือกเท่านั้น (ติ๊กทั้งหมดได้ด้วยปุ่มเดียว)
          : { item: it, on: false, mode: 'PCT', pct: String(it.deal?.pct ?? 0), amount: '', refs: null });
      }
      for (const f of res.fixed ?? []) {
        const prev = prevFixed.get(f.key);
        fixed.set(f.key, prev ? { ...prev, f, refs: null } : { f, on: false, amount: String(f.amount ?? ''), refs: null });
      }
      // ไม่มีอะไรให้ติ๊ก = ทางเดียวที่เหลือคือค่าคอมอื่น ๆ — เปิดแถวว่างรอไว้เลย (เซลที่ไม่มีดีลก็จ่ายได้)
      if (!items.size && !fixed.size && !others.length) others.push({ label: '', amount: '' });
      loaded = true;
      draw();
    }

    const root = el('div', {},
      picker
        ? el('div', { class: 'field', style: 'margin-bottom:12px' }, el('label', {}, 'ทำบิลค่าคอมให้เซล *'), picker)
        : '',
      content);

    formModal({
      title: locked ? `ทำบิลค่าคอมให้ ${locked.username} — ${locked.name}` : 'ทำบิลค่าคอมให้เซล',
      submitLabel: '🧾 บันทึกบิลค่าคอม',
      // ตารางมีช่องกรอกหลายคอลัมน์ — โมดัลปกติ 520px แคบจนต้องเลื่อนข้าง
      width: 920,
      fields: [{
        name: 'note',
        label: 'หมายเหตุของบิลค่าคอม (ไม่บังคับ)',
        placeholder: 'เช่น ค่าคอมรอบสิ้นเดือน ก.ย.',
        hint: 'เซลเห็นหมายเหตุนี้ในบิลของตัวเอง',
      }],
      // คืนกล่องเดิมทุกครั้ง — พิมพ์หมายเหตุแล้วตารางที่ติ๊กไว้ต้องอยู่ครบ
      preview: () => ({ node: root, canSubmit: true }),
      onSubmit: async (v) => {
        if (!agentId) throw new Error('เลือกเซลที่จะทำบิลค่าคอมให้ก่อน');
        if (!loaded) throw new Error('ยังโหลดรายการไม่เสร็จ — รอสักครู่แล้วกดใหม่');
        const t = compute();
        if (t.error) throw new Error(t.error);
        if (!t.lineCount) throw new Error('เลือกอย่างน้อยหนึ่งรายการ หรือใส่ค่าคอมอื่น ๆ');
        if (t.itemRes.length > MAX_BILL_ITEMS) throw new Error(`บิลค่าคอมหนึ่งใบติ๊กสินค้าได้ไม่เกิน ${MAX_BILL_ITEMS} รายการ — แบ่งทำสองบิล`);
        if (t.fixedRes.length > MAX_BILL_FIXED) throw new Error(`เหมาต่อรอบได้ไม่เกิน ${MAX_BILL_FIXED} รายการต่อบิล — แบ่งทำสองบิล`);
        if (t.otherRes.length > MAX_BILL_OTHERS) throw new Error(`ค่าคอมอื่น ๆ ได้ไม่เกิน ${MAX_BILL_OTHERS} รายการต่อบิล`);
        if (t.total <= 0) throw new Error('ยอดรวมบิลค่าคอมต้องมากกว่า 0 — รายการหักคืนต้องรวมอยู่กับรายการที่จ่ายในบิลเดียวกัน');
        if ((v.note ?? '').length > 500) throw new Error('หมายเหตุยาวเกิน 500 ตัวอักษร');

        const body = {
          // ส่งเฉพาะช่องของวิธีที่เลือก — % ห้ามมี amount · กรอกเองห้ามมี pct (เซิร์ฟเวอร์ตอบ 400)
          items: t.itemRes.map(({ s, amount, pct }) => (s.mode === 'MANUAL'
            ? { entryId: s.item.entryId, mode: 'MANUAL', amount }
            : { entryId: s.item.entryId, mode: 'PCT', pct })),
          fixed: t.fixedRes.map(({ s, amount }) => ({ key: s.f.key, amount })),
          others: t.otherRes.map(({ label, amount }) => ({ label, amount })),
          ...(v.note ? { note: v.note } : {}),
        };

        let res;
        try {
          res = await api.post(`/api/sales-agents/${agentId}/commission-bills`, body);
        } catch (err) {
          /*
           * บางรายการเพิ่งถูกทำบิลไปจากอีกหน้าจอ หรือบิลร้านเพิ่งถูกยกเลิก — โหลดรายการใหม่ให้
           * (ติ๊ก/ตัวเลขของรายการที่ยังอยู่คงไว้) แล้วให้ตรวจก่อนกดอีกครั้ง ไม่ส่งซ้ำเอง
           */
          if (err.status === 409 || (err.status === 400 && /ไม่อยู่ในรายการ/.test(err.message))) {
            await load({ keepState: true });
            // ข้อความเซิร์ฟเวอร์บอกให้ "โหลดใหม่" — โหลดให้แล้ว จึงเอาแค่ท่อนแรก แล้วบอกขั้นต่อไปแทน
            throw new Error(`${String(err.message).split(' — ')[0]} — โหลดรายการใหม่ให้แล้ว `
              + '(รายการที่ถูกทำบิลไปแล้วหายจากตาราง) ตรวจยอดแล้วกดบันทึกอีกครั้ง');
          }
          throw err;
        }

        const agent = agentById(agentId);
        toast(`ทำบิลค่าคอม ${res?.billNo ?? ''} ให้ ${agent?.username ?? ''} แล้ว — รวม ${money(res?.totalAmount ?? t.total)} ฿ (ยังไม่ได้จ่าย)`, 'success');
        // พาไปที่บิลที่เพิ่งทำ — ขั้นต่อไปคือโอนเงินให้เซลแล้วกด "จ่ายแล้ว"
        viewState.setItem(TAB_KEY, 'commissions');
        viewState.setItem(COMM_STATUS_KEY, 'PENDING');
        viewState.setItem(COMM_AGENT_KEY, String(agentId));
        render();
      },
    });
    load();
  };

  const body = tab === 'agents' ? agentsTab(agents, { createAgentModal, dealModal, commissionBillModal })
    : tab === 'links' ? linksTab(allLinks, { dealModal })
      : await commissionsTab(agents, { commissionBillModal });

  /*
   * หัวหน้ามีแค่ "ประวัติ" กับ "+ เพิ่มเซล" — เจ้าของระบบให้เอาปุ่มผูกดีลมุมขวาบนออก
   * ตั้งค่าคอม/ทำบิลค่าคอมเป็นเรื่องของเซลทีละคน จึงอยู่ที่แถวของเซล (ทำบิลค่าคอมแบบเลือกเซลอยู่ในแท็บ "ค่าคอมที่ต้องจ่าย")
   */
  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'เซล และค่าคอมจากการหาลูกค้า'),
        el('p', { style: 'max-width:66ch' },
          'เซลได้ค่าคอมเมื่อทำบิลค่าคอม: ติ๊กรายการจากบิลร้านของสินค้าที่เซลถือดีล (% ของยอดขายเต็ม หรือกรอกเอง) '
          + 'และใส่ค่าคอมอื่น ๆ ได้ · ตั้งค่าคอม (ผูกดีล) และทำบิลค่าคอมที่แถวของเซลแต่ละคน')),
      el('div', { class: 'btn-row' },
        activityButton(['agent', 'sales_link', 'sales_commission'], { title: 'ประวัติเซลและค่าคอม' }),
        el('button', { class: 'btn', onclick: createAgentModal }, '+ เพิ่มเซล'))),
    tabs,
    body);
}

/* ── รายชื่อเซล ────────────────────────────────────────────── */
function agentsTab(agents, { createAgentModal, dealModal, commissionBillModal }) {
  /**
   * รายละเอียดเซล — ดีลที่ถืออยู่แก้/ปิดได้ตรงนี้เลย (เจ้าของระบบ: "ตรงที่ผูกดีลไปแล้ว สามารถแก้ไขได้")
   * บันทึกแล้ววาดเนื้อหาใหม่ในโมดัลเดิม (ไม่ปิด คนแก้มักแก้ต่อหลายดีล) และวาดหน้าข้างหลังใหม่ให้ตัวเลขตรงกัน
   * ทั้งหน้าเป็นของส่วนกลางอย่างเดียว (เส้นทางและ API ด่าน super) — ปุ่มแก้/ปิดดีลจึงไม่ต้องเช็กบทบาทซ้ำ
   */
  const detailModal = async (row) => {
    let full;
    try {
      full = await api.get(`/api/sales-agents/${row.id}`);
    } catch (err) {
      toast(`เปิดรายละเอียดเซลไม่ได้ — ${err.fullMessage ?? err.message}`, 'error');
      return;
    }
    // กว้างพอให้ตารางดีล (มีคอลัมน์ส่วนต่างสินค้าเพิ่ม) กับปุ่ม แก้ไข/ปิดดีล อยู่ครบโดยไม่ต้องเลื่อนข้าง
    const modal = infoModal({ title: `${full.username} — ${full.name}`, width: 940, content: null });
    const title = `เซล ${full.username}`;
    // เซลเข้าทางหน้าล็อกอินปกติ (ลิงก์เฉพาะมีแค่ร้านค้า)
    const url = loginUrl();

    const refresh = async () => {
      render();
      try {
        fill(await api.get(`/api/sales-agents/${row.id}`));
      } catch (err) {
        // บันทึกผ่านไปแล้ว แค่โหลดรายละเอียดใหม่ไม่ได้ — อย่าให้ฟอร์มที่เรียกมาเข้าใจว่าบันทึกไม่สำเร็จ
        toast(`บันทึกแล้ว แต่โหลดรายละเอียดใหม่ไม่ได้ — ปิดแล้วเปิดใหม่ (${err.fullMessage ?? err.message})`, 'error');
      }
    };

    // ดีลที่ยังถืออยู่ขึ้นก่อน (แก้ได้) ดีลที่ปิดแล้วต่อท้าย (อ่านอย่างเดียว)
    const dealsTable = (links) => table([
      { label: 'สินค้า', render: (l) => el('div', {}, el('strong', {}, l.sku), el('div', { class: 'sub-line' }, l.productName)) },
      { label: 'ร้านที่ขาย', render: (l) => l.franchiseUsername ?? muted() },
      // ไม่มีคอลัมน์ "คิดจาก" แล้ว — % คิดจากยอดขายเต็มเสมอ บอกไว้ที่หัวคอลัมน์แทน
      productPctColumn,
      { label: '% ของยอดขายเต็ม', num: true, render: (l) => (l.commissionPct === null ? muted() : pct(l.commissionPct)) },
      { label: 'เหมาต่อรอบ (บาท)', num: true, render: (l) => (l.fixedAmount === null ? muted() : money(l.fixedAmount)) },
      // วันที่อ่านอย่างเดียว — ดีลไม่มีวันที่ให้แก้แล้ว
      { label: 'สถานะ', render: dealStatus },
      {
        label: '',
        render: (l) => (dealOpen(l)
          ? el('div', { class: 'btn-row' },
            el('button', { class: 'btn ghost sm', onclick: () => dealEditModal(l, { onSaved: refresh }) }, 'แก้ไข'),
            el('button', { class: 'btn ghost sm danger', onclick: () => endDeal(l, { onDone: refresh }) }, 'ปิดดีล'))
          : ''),
      },
    ], [...links.filter(dealOpen), ...links.filter((l) => !dealOpen(l))], {
      empty: 'ยังไม่ได้ผูกดีล — ไม่บังคับ เซลได้แค่ค่าคอมอื่น ๆ ก็ได้ · ผูกดีลได้ที่ปุ่ม "ตั้งค่าคอม" ของแถวเซล',
      sortable: false,
    });

    function fill(data) {
      modal.body.replaceChildren(
        el('div', { class: 'stat-grid' },
          stat('สินค้าที่ถือดีลอยู่', int(data.activeProductCount), null, { tone: 'sales', icon: '📦' }),
          stat('คอมค้างจ่าย', money(data.pendingCommission) + ' ฿', null, { tone: 'due', icon: '⏳' }),
          stat('จ่ายไปแล้วสะสม', money(data.paidCommission) + ' ฿', null, { tone: 'income', icon: '✓' })),
        el('h3', { style: 'margin:6px 0 4px' }, 'ดีลที่ถืออยู่'),
        el('div', { class: 'sub-line mb-8' }, `${EDIT_EFFECT} · ปิดดีลกดครั้งเดียว ไม่ต้องเลือกวันที่`),
        dealsTable(data.links ?? []),
        el('h3', { style: 'margin:18px 0 8px' }, 'ยูสเซอร์สำหรับเข้าระบบ'),
        el('div', { class: 'sub-line mb-8' },
          'รหัสผ่านที่ตั้งไว้แล้วดูย้อนหลังไม่ได้ — "📋 คัดลอกข้อมูลเข้าระบบ" ได้ลิงก์กับชื่อผู้ใช้ · '
          + 'ต้องส่งรหัสด้วย ใช้ "🔑 ตั้งรหัสใหม่ + คัดลอก" (เข้าครั้งแรกระบบจะให้เซลตั้งรหัสของตัวเอง)'),
        table([
          { label: 'ชื่อผู้ใช้', render: (u) => el('strong', {}, u.username) },
          { label: 'สถานะ', render: (u) => badge(u.status) },
          { label: 'เข้าล่าสุด', render: (u) => dateTimeTh(u.lastLoginAt) },
          {
            label: '',
            render: (u) => el('div', { class: 'btn-row' },
              el('button', {
                class: 'btn ghost sm',
                onclick: () => copyText(
                  loginSetText({ title, url, username: u.username }),
                  `คัดลอกข้อมูลเข้าระบบของ ${u.username} แล้ว (ไม่มีรหัสผ่าน — รหัสเดิมดูย้อนหลังไม่ได้)`,
                ),
              }, '📋 คัดลอกข้อมูลเข้าระบบ'),
              el('button', {
                class: 'btn ghost sm',
                onclick: () => resetPasswordModal({
                  username: u.username,
                  title,
                  url,
                  run: (body) => api.post(`/api/sales-agents/${data.id}/users/${u.id}/reset-password`, body),
                }),
              }, '🔑 ตั้งรหัสใหม่ + คัดลอก')),
          },
        ], data.users ?? [], { empty: 'ยังไม่มียูสเซอร์', sortable: false }));
    }
    fill(full);
  };

  const editModal = (row) => formModal({
    title: `แก้ไข ${row.username}`,
    fields: [
      { name: 'name', label: 'ชื่อเซล', required: true, value: row.name },
      { name: 'phone', label: 'เบอร์โทร', value: row.phone ?? '' },
      { name: 'email', label: 'อีเมล', value: row.email ?? '' },
      {
        name: 'status',
        label: 'สถานะ',
        type: 'select',
        value: row.status,
        options: [{ value: 'ACTIVE', label: 'ใช้งาน' }, { value: 'INACTIVE', label: 'หยุดใช้งาน' }],
      },
    ],
    onSubmit: async (v) => {
      await api.patch(`/api/sales-agents/${row.id}`, v);
      toast('บันทึกแล้ว', 'success');
      render();
    },
  });

  return el('div', {},
    el('div', { class: 'toolbar' },
      el('h2', { class: 'section-title' }, `เซลทั้งหมด ${int(agents.length)} คน`),
      el('div', { class: 'sub-line' }, 'หนึ่งแถว = เซลหนึ่งคน')),

    card(null, table([
    { label: 'Username / ชื่อเซล', render: (r) => avatar(r.username, { sub: r.name }), sortValue: (r) => r.username },
    { label: 'ติดต่อ', render: (r) => r.phone ?? r.email ?? '—' },
    // 0 ดีลเป็นเรื่องปกติ (เซลที่ได้แค่ค่าคอมอื่น ๆ) — โชว์เป็นตัวเลขธรรมดา ไม่ใช่ป้ายเตือน
    { label: 'สินค้าที่ถือดีล', num: true, render: (r) => int(r.activeProductCount) },
    { label: 'คอมค้างจ่าย', num: true, render: (r) => money(r.pendingCommission) },
    { label: 'ยูสเซอร์', num: true, render: (r) => (r.userCount ? int(r.userCount) : el('span', { class: 'badge amber' }, 'ยังไม่มี')) },
    { label: 'สถานะ', render: (r) => badge(r.status) },
    {
      label: '',
      // ปุ่มห้าปุ่มเรียงบรรทัดเดียวล้นจอโน้ตบุ๊ก — ให้ขึ้นบรรทัดสองได้ แทนการเลื่อนตารางไปหาปุ่ม
      render: (r) => el('div', { class: 'btn-row', style: 'flex-wrap:wrap;max-width:390px' },
        el('button', {
          class: 'btn ghost sm',
          title: 'ดูว่าเซลรายนี้เห็นอะไรบ้าง',
          onclick: () => {
            session.setViewAs({ role: 'SALES', id: r.id, username: r.username });
            location.hash = '#/my-sales';
            render();
          },
        }, '👁 ดูมุมมองนี้'),
        el('button', { class: 'btn ghost sm', onclick: () => detailModal(r) }, 'รายละเอียด'),
        el('button', { class: 'btn ghost sm', onclick: () => dealModal({ salesAgentId: String(r.id) }) }, 'ตั้งค่าคอม'),
        el('button', {
          class: 'btn ghost sm',
          // เซิร์ฟเวอร์นับรายการที่ยังไม่ได้ทำบิลค่าคอมมาให้ (ถ้ามี) — บอกไว้ที่ปุ่มเลย ไม่ต้องเปิดดูทีละคน
          onclick: () => commissionBillModal({ salesAgentId: String(r.id), lock: true }),
        }, `🧾 ทำบิลค่าคอม${r.uncommissionedCount ? ` (${int(r.uncommissionedCount)})` : ''}`),
        el('button', { class: 'btn ghost sm', onclick: () => editModal(r) }, 'แก้ไข')),
    },
  ], agents, {
    search: 'ค้นหาเซล…',
    empty: {
      icon: '🤝',
      title: 'ยังไม่มีเซล',
      detail: 'เพิ่มเซล แล้วผูกดีลสินค้า (ไม่บังคับ) — ค่าคอมจ่ายผ่านบิลค่าคอมที่ทำให้เซลเป็นครั้ง ๆ',
      action: { label: '+ เพิ่มเซลคนแรก', onClick: createAgentModal },
    },
  }), { tight: true }));
}

/* ── ดีล ───────────────────────────────────────────────────── */
function linksTab(items, { dealModal }) {
  // แก้/ปิดดีลใช้ฟอร์มเดียวกับรายละเอียดเซล (ไม่มีวันที่ ไม่มีตัวเลือกฐาน) — บันทึกแล้ววาดทั้งหน้าใหม่
  const refresh = () => render();

  /*
   * นำด้วย "สินค้า" ไม่ใช่ "เซล" — แท็บนี้ 1 แถว = 1 ดีล ไม่ใช่ 1 คน
   * เดิมคอลัมน์แรกเป็นวงกลมชื่อเซลเหมือนแท็บ "รายชื่อเซล" เป๊ะ
   * ตาเลยอ่านว่าเป็นรายชื่อคนทั้งคู่ ทั้งที่เซลคนหนึ่งโผล่ได้หลายแถว
   */
  const active = items.filter(dealOpen).length;

  return el('div', {},
    el('div', { class: 'toolbar' },
      el('h2', { class: 'section-title' }, `ดีลทั้งหมด ${int(items.length)} ดีล`),
      el('div', { class: 'sub-line' },
        `หนึ่งแถว = สินค้าหนึ่งชิ้นที่มีเซลถืออยู่ · เปิดอยู่ ${int(active)} ดีล — เซลคนเดียวถือได้หลายชิ้น · % คิดจากยอดขายเต็มของร้าน`)),

    card(null, table([
    {
      label: 'สินค้า',
      sortValue: (r) => r.sku,
      render: (r) => el('div', {}, el('strong', {}, r.sku), el('div', { class: 'sub-line' }, r.productName)),
    },
    {
      label: 'ร้านที่ขาย',
      sortValue: (r) => r.franchiseUsername ?? '',
      render: (r) => (r.franchiseUsername ? avatar(r.franchiseUsername, { sub: '' }) : muted()),
    },
    {
      label: 'เซลที่ถือดีล',
      sortValue: (r) => r.agentUsername,
      render: (r) => avatar(r.agentUsername, { sub: r.agentName }),
    },
    productPctColumn,
    { label: 'เงื่อนไข', render: linkTerms },
    { label: 'สถานะ', sortValue: (r) => (dealOpen(r) ? `0${r.startDate}` : `1${r.endDate}`), render: dealStatus },
    {
      label: '',
      render: (r) => el('div', { class: 'btn-row' },
        // ดีลที่ปิดแล้วยังแก้ตัวเลขได้ — บิลร้านที่ออกตอนยังถือดีลยังติ๊กทำบิลค่าคอมได้ และใช้ % ของดีลนี้เป็นค่าตั้งต้น
        el('button', { class: 'btn ghost sm', onclick: () => dealEditModal(r, { onSaved: refresh }) }, 'แก้ไข'),
        dealOpen(r) ? el('button', { class: 'btn ghost sm danger', onclick: () => endDeal(r, { onDone: refresh }) }, 'ปิดดีล') : ''),
    },
  ], items, {
    search: 'ค้นหาสินค้า ร้าน หรือเซล…',
    empty: {
      icon: '📦',
      title: 'ยังไม่มีดีล',
      detail: 'ผูกเซลกับสินค้าที่เขาผลักดัน แล้วรายการของสินค้านั้นจะขึ้นให้ติ๊กตอนทำบิลค่าคอม (ไม่บังคับ — เซลได้แค่ค่าคอมอื่น ๆ ก็ได้)',
      action: { label: '+ ผูกดีล', onClick: () => dealModal() },
    },
  }), { tight: true }));
}

/* ── บิลค่าคอม ─────────────────────────────────────────────── */

/**
 * รายการบิลค่าคอม (แบนราบ หนึ่งแถว = หนึ่งบิล = จ่ายเซลหนึ่งครั้ง)
 * แถวแบบเดิม (คิดตอนออกบิลร้าน / ค่าคอมอื่น ๆ แบบเลือกรอบ) ปนอยู่ในลิสต์เดียวกัน — จ่ายหรือยกเลิกได้เหมือนกัน
 */
async function commissionsTab(agents, { commissionBillModal }) {
  const statusFilter = viewState.getItem(COMM_STATUS_KEY) ?? 'PENDING';
  const agentFilter = viewState.getItem(COMM_AGENT_KEY) ?? '';
  const res = await api.get(`/api/sales-agents/commissions${qs({ status: statusFilter, salesAgentId: agentFilter })}`);

  const payModal = (row) => formModal({
    title: `บันทึกจ่าย ${commissionTitle(row)} — ${row.agentUsername}`,
    submitLabel: 'บันทึกว่าจ่ายแล้ว',
    fields: [
      { name: 'paidAt', label: 'วันที่จ่าย', type: 'date', value: todayIso() },
      { name: 'note', label: 'หมายเหตุ', placeholder: 'เช่น โอนพร้อมเงินเดือน' },
    ],
    preview: () => el('div', { class: 'notice-box m-0' },
      `จ่ายให้ ${row.agentUsername} รวม ${money(row.totalAmount)} ฿ — โอนเงินก่อน แล้วค่อยกดบันทึก (จ่ายแล้วยกเลิกไม่ได้)`),
    onSubmit: async (v) => {
      await api.post(`/api/sales-agents/commissions/${row.id}/pay`, v);
      toast(`บันทึกจ่ายคอม ${money(row.totalAmount)} ฿ แล้ว`, 'success');
      render();
    },
  });

  /** ยกเลิกได้เฉพาะที่ยังไม่จ่าย — รายการจากบิลร้านในใบนั้นกลับไปให้ติ๊กทำบิลใหม่ได้ */
  const voidModal = (row) => formModal({
    title: `ยกเลิก ${commissionTitle(row)} — ${row.agentUsername}`,
    submitLabel: 'ยกเลิกบิลค่าคอม',
    fields: [{
      name: 'reason',
      label: 'เหตุผลที่ยกเลิก',
      required: true,
      placeholder: 'เช่น ติ๊กรายการผิด ต้องทำบิลใหม่',
      hint: 'บันทึกไว้ในประวัติ และเซลเห็นเหตุผลนี้ในบิลของตัวเอง',
    }],
    preview: () => el('div', { class: 'alert-box m-0' },
      `${row.agentUsername} · ${money(row.totalAmount)} ฿`,
      el('div', { class: 'sub-line mt-4' },
        isBill(row)
          ? 'รายการจากบิลร้านในใบนี้จะกลับไปให้ติ๊กทำบิลค่าคอมใหม่ได้'
          : 'รายการนี้จะไม่นับเป็นค่าคอมค้างจ่ายอีก')),
    onSubmit: async (v) => {
      if (v.reason.length < 3) throw new Error('เหตุผลสั้นเกินไป — พิมพ์อย่างน้อย 3 ตัวอักษร');
      await api.post(`/api/sales-agents/commissions/${row.id}/void`, { reason: v.reason });
      toast(`ยกเลิก ${commissionTitle(row)} แล้ว`, 'success');
      render();
    },
  });

  const viewModal = (row) => {
    const modal = infoModal({ title: `${commissionTitle(row)} — ${row.agentUsername}`, width: 880, content: null });
    modal.body.append(
      commissionDetail(row),
      row.status === 'PENDING'
        ? el('div', { class: 'btn-row', style: 'margin-top:14px;justify-content:flex-end' },
          el('button', { class: 'btn ghost sm danger', onclick: () => { modal.close(); voidModal(row); } }, 'ยกเลิกบิลนี้'),
          el('button', { class: 'btn sm', onclick: () => { modal.close(); payModal(row); } }, 'บันทึกว่าจ่ายแล้ว'))
        : '');
  };

  const filters = el('div', { class: 'filters', style: 'margin-bottom:16px' },
    el('div', { class: 'field' },
      el('label', {}, 'สถานะ'),
      el('select', { onchange: (e) => { viewState.setItem(COMM_STATUS_KEY, e.target.value); render(); } },
        ...[
          { value: 'PENDING', label: 'ยังไม่จ่าย' },
          { value: 'PAID', label: 'จ่ายแล้ว' },
          { value: 'VOID', label: 'ยกเลิก' },
          { value: '', label: 'ทั้งหมด' },
        ].map((o) => el('option', { value: o.value, selected: o.value === statusFilter }, o.label)))),
    el('div', { class: 'field' },
      el('label', {}, 'เซล'),
      el('select', { onchange: (e) => { viewState.setItem(COMM_AGENT_KEY, e.target.value); render(); } },
        el('option', { value: '', selected: agentFilter === '' }, 'ทุกคน'),
        ...agents.map((a) => el('option', { value: String(a.id), selected: String(a.id) === agentFilter },
          `${a.username} — ${a.name}`)))));

  // จ่ายทีเดียวทั้งหมด ทำได้เฉพาะตอนกรองเซลคนเดียว — โอนเงินจริงทำทีละคน กดรวมหลายคนพลาดง่าย
  const payAll = agentFilter ? res.items.filter((r) => r.status === 'PENDING') : [];
  const pendingOfAll = sumBaht(payAll.map((r) => r.totalAmount));

  return el('div', {},
    filters,
    el('div', { class: 'stat-grid' },
      stat('บิลค่าคอม', int(res.summary.count), 'ตามตัวกรองที่เลือก', { tone: 'muted', icon: '🧾' }),
      stat('ค้างจ่าย', money(res.summary.pending) + ' ฿', null,
        { tone: res.summary.pending > 0 ? 'due' : 'muted', icon: '⏳' }),
      stat('จ่ายแล้ว', money(res.summary.paid) + ' ฿', null, { tone: 'income', icon: '✓' })),

    el('div', { class: 'btn-row', style: 'margin-bottom:12px' },
      el('button', {
        class: 'btn',
        // กรองเซลไว้ = เลือกเซลคนนั้นให้เลย (ยังเปลี่ยนได้ในหน้าต่าง)
        onclick: () => commissionBillModal({ salesAgentId: agentFilter }),
      }, '🧾 ทำบิลค่าคอม'),
      payAll.length > 1
        ? el('button', {
          class: 'btn ghost',
          onclick: () => confirmAction(
            `บันทึกจ่ายบิลค่าคอมทั้งหมด ${payAll.length} ใบของ ${payAll[0].agentUsername} รวม ${money(pendingOfAll)} บาท?`,
            async () => {
              for (const r of payAll) await api.post(`/api/sales-agents/commissions/${r.id}/pay`, { paidAt: todayIso() });
              toast(`บันทึกจ่าย ${payAll.length} ใบแล้ว`, 'success');
              render();
            },
          ),
        }, `จ่ายทั้งหมด (${payAll.length})`)
        : ''),

    card(null, table([
      { label: 'เลขที่', sortValue: (r) => commissionTitle(r), render: (r) => el('strong', {}, commissionTitle(r)) },
      { label: 'เซล', sortValue: (r) => r.agentUsername, render: (r) => avatar(r.agentUsername, { sub: r.agentName }) },
      { label: 'วันที่', sortValue: (r) => r.createdAt ?? '', render: (r) => dateTh(r.createdAt) },
      // บิลใหม่: นับตามชนิดรายการ · แถวแบบเดิม: ร้าน/รอบที่มาของก้อนนั้น
      { label: 'รายการ', render: (r) => el('span', { class: isBill(r) ? '' : 'muted' }, commissionSubtitle(r)) },
      { label: 'ยอดรวม', num: true, sortValue: (r) => r.totalAmount, render: (r) => el('strong', {}, money(r.totalAmount)) },
      {
        label: 'สถานะ',
        render: (r) => el('div', {}, commBadge(r.status),
          r.status === 'PAID' && r.paidAt ? el('div', { class: 'sub-line' }, `จ่าย ${dateTh(r.paidAt)}`) : '',
          r.status === 'VOID' && r.voidReason ? el('div', { class: 'sub-line' }, r.voidReason) : ''),
      },
      {
        label: '',
        sortable: false,
        render: (r) => el('div', { class: 'btn-row' },
          el('button', { class: 'btn ghost sm', onclick: () => viewModal(r) }, 'ดู'),
          r.status === 'PENDING' ? el('button', { class: 'btn sm', onclick: () => payModal(r) }, 'จ่ายแล้ว') : '',
          r.status === 'PENDING' ? el('button', { class: 'btn ghost sm danger', onclick: () => voidModal(r) }, 'ยกเลิก') : ''),
      },
    ], res.items, {
      search: 'ค้นหาเลขที่หรือเซล…',
      empty: {
        icon: '🧾',
        title: statusFilter === 'PENDING' ? 'ไม่มีบิลค่าคอมที่ยังไม่จ่าย' : 'ไม่มีบิลค่าคอมตามตัวกรองนี้',
        detail: 'กด "🧾 ทำบิลค่าคอม" แล้วติ๊กรายการจากบิลร้านที่ออกแล้ว (หรือใส่ค่าคอมอื่น ๆ) ให้เซล',
      },
      footer: res.items.length
        ? ['', '', '', 'รวม (ไม่นับที่ยกเลิก)', money(res.summary.total ?? sumBaht([res.summary.pending, res.summary.paid])), '', '']
        : undefined,
    }), { tight: true }));
}
