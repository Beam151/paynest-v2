import { api, qs, session } from '../api.js';
import {
  badge, card, commBadge, confirmAction, copyText, dateTh, dateTimeTh, el, field, formModal, infoModal, int,
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
      + 'และค่าคอมอื่น ๆ ที่กรอกเป็นจำนวนเงิน — ทั้งสองอย่างอยู่ในหน้าต่าง "ตั้งค่าคอม" ของแถวเซล'),
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
   * ตั้งค่าคอม — หน้าต่างเดียวของเซลหนึ่งคน บนลงล่าง:
   *   🤝 ดีลที่ถืออยู่ → 📦 เพิ่มสินค้าที่ผูกดีล → 🧾 รายการจากบิลร้านที่รอจ่ายคอม → 💰 ค่าคอมอื่น ๆ → สรุป → หมายเหตุ
   *
   * เจ้าของระบบเห็นหน้าต่าง "ตั้งค่าคอม" (ดีลอย่างเดียว) กับ "ทำบิลค่าคอม" แยกกันคนละปุ่มแล้วบอกว่า
   * "อยู่หน้าเดียวกันแบบเดิมดีแล้ว ไม่แยกปุ่มแบบนี้" — จึงรวมกลับเป็นหน้าต่างเดียว ปุ่ม "บันทึก" ปุ่มเดียว
   * API ยังเป็นชุดเดิม (ดีลกับบิลค่าคอมเป็นคนละคำขอ) — หน้าต่างนี้แค่ยิงให้ครบตามลำดับ
   *
   * ดีล: ดีลที่ยังเปิดอยู่ขึ้นก่อนเป็นแถวที่แก้ได้ (เจ้าของระบบ: "ตรงที่ผูกดีลไปแล้ว สามารถแก้ไขได้") แล้วตามด้วยแถว "+ เพิ่มสินค้า"
   *   ไม่มีช่องวันที่ ไม่มีตัวเลือกฐาน (เจ้าของระบบสั่ง) — % คิดจากยอดขายเต็มเสมอ · ดีลเริ่มวันที่บันทึก จบเมื่อกด "ปิดดีล"
   *   ดีลไม่บังคับ — เซลที่ได้แค่ค่าคอมอื่น ๆ ไม่ต้องผูกอะไรเลย จึงไม่มีแถวใหม่ให้ตั้งแต่เปิด
   *
   * บิลค่าคอม (1 ใบ = จ่ายเซล 1 ครั้ง): เจ้าของระบบ "แต่ละรอบจ่ายค่าคอมไม่เหมือนกัน" — จึงไม่คิดอัตโนมัติตอนออกบิลร้าน
   *   ให้ติ๊กเองว่าจ่ายรายการไหน จากบิลร้านที่ออกแล้ว (ไม่ต้องรอร้านจ่าย) เฉพาะสินค้าที่เซลคนนี้ถือดีล
   *   แต่ละรายการคิด "% ของยอดเต็ม" (ตั้งต้น = % ของดีล) หรือ "กรอกเอง" + ค่าคอมอื่น ๆ ที่ไม่ต้องเลือกรอบ
   *   **ตั้งต้นไม่ติ๊กอะไรเลย** — เปิดมาแก้ดีลแล้วกดบันทึก ต้องไม่มีบิลค่าคอมงอกออกมาเอง (เงินออกจากบริษัทต้องตั้งใจเลือก)
   *   ตัวเลขเป็นพรีวิว เซิร์ฟเวอร์ตรวจและคิดใหม่เองตอนบันทึก · รายการหนึ่งจ่ายได้ครั้งเดียว (ฐานข้อมูลกันไว้)
   *
   * กดบันทึก: ตรวจทุกส่วนให้ผ่านก่อนยิงคำขอแรก (ผิดตรงไหน = ไม่มีอะไรถูกบันทึก) แล้วทำตามลำดับ
   *   แก้ดีลเดิม (เฉพาะที่ตัวเลขเปลี่ยน) → ปิดดีล (ถามยืนยันก่อน) → ผูกดีลใหม่ → ทำบิลค่าคอม (เฉพาะเมื่อติ๊ก/กรอกไว้)
   *   ปิดก่อนผูกใหม่ — สินค้าที่เพิ่งปิดจะได้ไม่ชนตอนผูกให้คนใหม่ในรอบเดียวกัน
   *   เป็นคนละคำขอ: พังกลางทาง = หยุดทันที บอกว่าอะไรเข้าไปแล้ว และส่วนที่เข้าแล้วไม่ถูกส่งซ้ำเมื่อกดบันทึกอีกครั้ง
   *
   * preset.salesAgentId + lock: เปิดจากแถวเซล/รายละเอียดเซล = ล็อกชื่อเซล · จากแท็บอื่น = เลือกไว้ให้แต่เปลี่ยนได้ (หรือยังไม่เลือก)
   * preset.onSaved + preset.links: เปิดจากรายละเอียดเซล — บันทึกแล้ววาดรายละเอียดใหม่ในที่เดิม (ไม่พาไปแท็บบิลค่าคอม)
   *   และใช้ดีลที่รายละเอียดเพิ่งโหลดมา (allLinks ของหน้าเก่ากว่า ถ้าแก้ดีลจากในรายละเอียดไปแล้ว)
   * เซลที่หยุดใช้งานก็เปิดได้: แก้/ปิดดีลเดิม และทำบิลค่าคอมที่ค้างจ่ายให้ได้ (เซิร์ฟเวอร์รับ — คนที่ออกไปแล้วยังต้องได้เงินที่ค้าง)
   * แต่ผูกดีลใหม่ไม่ได้ (เซิร์ฟเวอร์ไม่รับ ปุ่มเพิ่มจึงปิดไว้)
   */
  const commissionModal = (preset = {}) => {
    const locked = preset.lock ? agentById(preset.salesAgentId) : null;
    let agentId = locked ? String(locked.id) : (agentById(preset.salesAgentId) ? String(preset.salesAgentId) : '');
    const agentNow = () => agentById(agentId);
    const canAdd = () => agentNow()?.status === 'ACTIVE';
    const skuOf = (productId) => products.find((p) => String(p.id) === String(productId))?.sku ?? `#${productId}`;
    /*
     * preset.links: ดีลของเซลคนนี้ที่เพิ่งโหลดมา (เปิดจากรายละเอียดเซล) — ใช้แทน allLinks ของตอนวาดหน้า
     * รายละเอียดเซลเปิดค้างข้ามการวาดหน้าใหม่ได้ ถ้าใช้ allLinks เดิม: แก้ดีลเป็น 5.5% แล้วเปิด "ตั้งค่าคอม" ซ้ำ
     * จะขึ้น 5% ดีลที่เพิ่งปิดยังขึ้นว่าถืออยู่ และดีลที่เพิ่งผูกหายไป (กดเพิ่มซ้ำแล้วชน)
     */
    const linksOf = (id) => (preset.links && String(id) === String(preset.salesAgentId)
      ? preset.links
      : allLinks.filter((l) => String(l.salesAgentId) === String(id)));
    // ดีลทุกตัวของทุกเซล (รวมที่ปิดแล้ว) — ใช้คิดค่าตั้งต้นของเหมาต่อรอบใหม่เมื่อแก้ดีลในหน้าต่างนี้
    const linkById = new Map([...allLinks, ...(preset.links ?? [])].map((l) => [Number(l.id), l]));

    /*
     * สถานะทั้งหมดอยู่นอก DOM และวาดใหม่ทีละส่วน — ช่องกรอกไม่ถูกสร้างใหม่ระหว่างพิมพ์ (เคอร์เซอร์ไม่หลุด)
     * และติ๊ก/ตัวเลขที่กรอกไว้ส่วนหนึ่งไม่หายเมื่ออีกส่วนวาดใหม่
     */
    const rows = []; // ดีลใหม่: { productId, commissionPct, fixedAmount }
    let current = []; // ดีลเดิมที่ยังเปิดอยู่: { link, pct, fixed, closing }
    let loadSeq = 0;
    let loaded = false;
    const items = new Map(); // entryId → { item, on, mode, pct, amount, pctTouched, refs }
    const fixed = new Map(); // key → { f, on, amount, amountTouched, refs }
    let others = []; // [{ label, amount }]
    let groups = []; // บิลร้านละกลุ่ม: { invoiceNo, …, rows: [state], box }

    const toDealState = (l) => ({
      link: l,
      pct: l.commissionPct === null || l.commissionPct === undefined ? '' : String(l.commissionPct),
      fixed: l.fixedAmount === null || l.fixedAmount === undefined ? '' : String(l.fixedAmount),
      closing: false,
    });
    /** ดีลเดิมของเซลที่เลือก — ข้อมูลชุดเดียวกับแท็บดีล (หรือของรายละเอียดเซลที่เพิ่งโหลด) */
    const loadCurrent = () => {
      current = agentId ? linksOf(agentId).filter(dealOpen).map(toDealState) : [];
    };
    const isChanged = (s) => typedNumber(s.pct) !== (s.link.commissionPct ?? null)
      || typedNumber(s.fixed) !== (s.link.fixedAmount ?? null);
    const dealChanges = () => ({
      edit: current.filter((s) => !s.closing && isChanged(s)).length,
      end: current.filter((s) => s.closing).length,
      add: rows.filter((r) => r.productId).length,
    });
    loadCurrent();

    const main = el('div');
    const dealsBox = el('div');
    const candCount = el('span');
    const candContent = el('div');
    const othersBox = el('div');
    const totalBox = el('div', { class: 'notice-box', style: 'margin:12px 0 0' });
    const toggleAll = el('input', { type: 'checkbox' });
    const pickedCount = el('span', { class: 'sub-line' });
    const dealNote = el('input', { type: 'text', maxlength: 500, placeholder: 'เช่น ดีลเปิดตลาดภาคเหนือ' });
    const billNote = el('input', { type: 'text', maxlength: 500, placeholder: 'เช่น ค่าคอมรอบสิ้นเดือน ก.ย.' });

    /* ── ดีล ─────────────────────────────────────────────── */

    /*
     * แก้ % / เหมาของดีลในหน้าต่างเดียวกัน = ค่าตั้งต้นของรายการที่รอจ่ายคอมของดีลนั้นต้องเปลี่ยนตาม
     * ไม่งั้นแก้ดีลเป็น 6% แล้วติ๊กรายการในการบันทึกครั้งเดียวกัน บิลจะออกที่ 5% ตามค่าที่โหลดมาตอนเปิด
     * เปลี่ยนเฉพาะช่องที่ยังไม่ได้พิมพ์เอง — ตัวเลขที่ตั้งใจแก้ทีละรายการต้องไม่ถูกทับ
     * ดีลที่กดปิด = ไม่ส่งตัวเลขที่แก้ไว้ จึงกลับไปใช้ค่าเดิมของดีล
     */
    function syncDealDefaults(s) {
      const pctText = s.closing ? String(s.link.commissionPct ?? 0) : (s.pct.trim() === '' ? '0' : s.pct.trim());
      for (const it of items.values()) {
        if (it.pctTouched || Number(it.item.deal?.id) !== Number(s.link.id) || it.pct === pctText) continue;
        it.pct = pctText;
        if (it.refs) { it.refs.pctIn.value = pctText; paintItem(it); }
      }
      // เหมาต่อรอบ = ค่ามากสุดของดีลเซลคนนี้ในร้าน×รอบนั้น (กติกาเดียวกับเซิร์ฟเวอร์) — ดีลที่แก้อยู่ใช้ตัวเลขที่พิมพ์
      const fixedOf = (id) => {
        const edited = current.find((c) => Number(c.link.id) === Number(id));
        const raw = edited && !edited.closing ? typedNumber(edited.fixed) : (edited?.link ?? linkById.get(Number(id)))?.fixedAmount;
        return Number.isFinite(Number(raw)) ? Number(raw) : 0;
      };
      for (const fs of fixed.values()) {
        /*
         * ดีลของร้าน×รอบนั้น = ดีลที่มีเหมาอยู่แล้ว (dealIds) + ดีลของรายการที่รอจ่ายในบิลร้านใบเดียวกัน
         * (หนึ่งร้านหนึ่งรอบมีบิลเดียว) — ดีลที่ยังไม่มีเหมาไม่อยู่ใน dealIds ถ้าเพิ่งพิมพ์เหมาให้ดีลนั้นในหน้าต่างนี้
         * เซิร์ฟเวอร์จะนับหลังบันทึกดีล ค่าตั้งต้นจึงต้องนับด้วย ไม่งั้นบิลในการบันทึกเดียวกันได้เหมาตัวเก่าที่ต่ำกว่า
         */
        const ids = [...new Set([
          ...(fs.f.dealIds ?? []),
          ...[...items.values()]
            .filter((it) => String(it.item.invoiceId) === String(fs.f.invoiceId) && it.item.deal?.id)
            .map((it) => it.item.deal.id),
        ].map(Number))];
        if (fs.amountTouched || !ids.includes(Number(s.link.id))) continue;
        const best = Math.max(0, ...ids.map(fixedOf));
        // ไม่เหลือเหมาแล้ว — ปล่อยตัวเลขเดิมไว้ ถ้าติ๊กแล้วบันทึก เซิร์ฟเวอร์จะตอบว่าไม่อยู่ในรายการแล้ว และหน้าต่างโหลดใหม่ให้
        if (best <= 0 || String(best) === fs.amount) continue;
        fs.amount = String(best);
        if (fs.refs) { fs.refs.amountIn.value = fs.amount; paintFixed(fs); }
      }
    }

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
      const changed = () => { paint(); syncDealDefaults(s); paintTotals(); };
      pctBox.addEventListener('input', () => { s.pct = pctBox.value; changed(); });
      fixedBox.addEventListener('input', () => { s.fixed = fixedBox.value; changed(); });
      closeBtn.addEventListener('click', () => { s.closing = !s.closing; changed(); });
      paint();
      return row;
    }

    function drawDeals() {
      // สินค้าที่มีดีลในหน้าต่างนี้แล้ว (รวมที่เพิ่งผูกสำเร็จตอนบันทึกค้างครึ่งทาง) และที่แถวอื่นเลือกไว้ — เลือกซ้ำไม่ได้
      const held = new Set(current.map((s) => String(s.link.productId)));
      const addable = productOptions.filter((o) => !held.has(o.value));
      const taken = new Set(rows.map((r) => r.productId).filter(Boolean));
      dealsBox.replaceChildren(
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
                '% คิดจากยอดขายเต็มของร้าน (ก่อนหักส่วนต่าง) · บิลร้านที่ออกแล้วของสินค้าที่เพิ่มใหม่ จะขึ้นให้ติ๊กจ่ายคอมเมื่อเปิดหน้าต่างนี้ครั้งถัดไป')),
            el('button', {
              class: 'btn sm',
              type: 'button',
              // เลือกครบทุกชิ้นที่ว่างแล้ว เพิ่มแถวไปก็ไม่มีอะไรให้เลือก
              disabled: !canAdd() || rows.length >= addable.length,
              onclick: () => { rows.push({ productId: '', commissionPct: '', fixedAmount: '' }); drawDeals(); paintTotals(); },
            }, '+ เพิ่มสินค้า')),

          ...rows.map((row, i) => {
            // ซ่อนสินค้าที่แถวอื่นเลือกไปแล้ว กันผูกซ้ำตั้งแต่ตอนเลือก
            const choices = addable.filter((o) => !taken.has(o.value) || o.value === row.productId);

            const productSel = el('select', { style: 'flex:1 1 260px;min-width:220px', 'aria-label': `สินค้าแถวที่ ${i + 1}` },
              el('option', { value: '', selected: !row.productId }, 'เลือกสินค้า…'),
              ...choices.map((o) => el('option', { value: o.value, selected: o.value === row.productId }, o.label)));
            productSel.addEventListener('change', () => { row.productId = productSel.value; drawDeals(); paintTotals(); });

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
                onclick: () => { rows.splice(i, 1); drawDeals(); paintTotals(); },
              }, 'ลบ'),
              hint);
          }),

          rows.length
            ? el('div', { class: 'sub-line mt-6' },
              'แต่ละชิ้นกรอกอย่างน้อยหนึ่งช่อง — % ของยอดขายเต็ม หรือเหมาต่อรอบ (คิดครั้งเดียวต่อร้านต่อรอบ)')
            : el('div', { class: 'sub-line' },
              !canAdd()
                ? 'เซลคนนี้หยุดใช้งานอยู่ — ผูกดีลใหม่ไม่ได้ (แก้/ปิดดีลเดิมด้านบนได้) · เปิดใช้งานเซลก่อนที่ปุ่ม "แก้ไข" ของแถวเซล'
                : !addable.length
                  ? 'สินค้าทุกชิ้นที่มีร้านถือสิทธิ์ขายอยู่ มีเซลถือดีลครบแล้ว — ถ้าจะเปลี่ยนมือ ให้ "ปิดดีล" เดิมก่อน'
                  : current.length
                    ? 'กด "+ เพิ่มสินค้า" ถ้าจะให้เซลคนนี้ถือสินค้าเพิ่ม'
                    : 'ไม่บังคับ — เซลที่ได้แค่ค่าคอมอื่น ๆ ไม่ต้องผูกดีล (ใส่ในส่วน "ค่าคอมอื่น ๆ" ด้านล่าง) · กด "+ เพิ่มสินค้า" ถ้าจะให้ได้ % จากยอดขายสินค้า')));
    }

    /* ── รายการที่รอจ่ายคอม: ตัวเลขของแต่ละแถว = { amount } หรือ { amount: 0, error } ── */

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

    /** สรุปสด ๆ ว่ากดบันทึกแล้วจะเกิดอะไร — บิลค่าคอม (ถ้ามีรายการ) + ดีลที่เปลี่ยน */
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
      const d = dealChanges();
      const dealLine = [d.edit ? `แก้ดีล ${d.edit}` : '', d.end ? `ปิดดีล ${d.end}` : '', d.add ? `เพิ่มดีล ${d.add}` : '']
        .filter(Boolean).join(' · ');
      totalBox.replaceChildren(
        el('strong', {}, t.lineCount
          ? `บิลค่าคอมที่จะทำ: รวม ${money(t.total)} ฿ (สินค้า ${t.itemRes.length} · เหมา ${t.fixedRes.length} · อื่น ๆ ${t.otherRes.length})`
          : 'ไม่มีรายการ — บันทึกเฉพาะดีล'),
        t.lineCount
          ? el('div', { class: 'sub-line mt-4' }, [
            `สินค้า ${t.itemRes.length} รายการ (ยอดเต็ม ${money(t.grossTotal)}) → ${money(t.itemsTotal)}`,
            `เหมาต่อรอบ ${t.fixedRes.length} → ${money(t.fixedTotal)}`,
            `ค่าคอมอื่น ๆ ${t.otherRes.length} → ${money(t.othersTotal)}`,
          ].join(' · '))
          : '',
        el('div', { class: 'sub-line mt-4' }, dealLine ? `ดีลที่จะบันทึก: ${dealLine}` : 'ดีล: ยังไม่ได้แก้'),
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
      // พิมพ์ % เองแล้ว = ตั้งใจ แก้ดีลด้านบนทีหลังจะไม่ทับเลขนี้
      pctIn.addEventListener('input', () => { s.pct = pctIn.value; s.pctTouched = true; paintItem(s); paintTotals(); });
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
      amountIn.addEventListener('input', () => { s.amount = amountIn.value; s.amountTouched = true; paintFixed(s); paintTotals(); });
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
              'จ่ายเป็นก้อน ไม่ผูกกับสินค้าและไม่ต้องเลือกรอบ เช่นโบนัสปิดดีล ค่าเดินทาง · ใส่ติดลบได้ ถ้าเป็นการหักคืน · อยู่ในบิลค่าคอมใบเดียวกับรายการที่ติ๊ก')),
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
        others.length ? '' : el('div', { class: 'sub-line' }, 'ไม่มี — กด "+ เพิ่มรายการ" ถ้าจะจ่ายก้อนพิเศษหรือหักคืนในบิลค่าคอมครั้งนี้')));
    }

    function drawCandidates() {
      groups = buildGroups();
      const tickable = items.size + fixed.size;
      candCount.textContent = `(${tickable})`;
      const tbody = el('tbody', {}, ...groups.flatMap((g) => [
        groupHead(g),
        ...g.rows.map((s) => (s.item ? itemRow(s) : fixedRow(s))),
      ]));

      candContent.replaceChildren(tickable
        ? el('div', { class: 'line-editor' },
          // "เลือกทั้งหมด" อยู่เหนือตาราง — บนมือถือหัวตารางถูกซ่อน ถ้าอยู่ในหัวตารางจะหายไปด้วย
          el('label', { class: 'check-all' }, toggleAll, 'เลือกทั้งหมด', pickedCount),
          el('div', { class: 'table-scroll' },
            el('table', {},
              el('thead', {}, el('tr', {}, ...COLS.map((c, i) => el('th', { class: NUM_COLS.has(i) ? 'num' : '' }, c)))),
              tbody)))
        : el('div', { class: 'sub-line' },
          'ยังไม่มีรายการจากบิลร้านของสินค้าที่เซลคนนี้ถือดีล — ใส่ค่าคอมอื่น ๆ ด้านล่างได้'));
    }

    /**
     * โหลดรายการที่ทำบิลค่าคอมได้ของเซลคนนี้
     * keepState: โหลดใหม่หลังชนกับคนอื่น — ติ๊ก/ตัวเลขของรายการที่ยังเหลืออยู่คงไว้ (ค่าคอมอื่น ๆ ไม่ถูกแตะอยู่แล้ว)
     */
    async function load({ keepState = false } = {}) {
      const seq = ++loadSeq;
      loaded = false;
      if (!agentId) return;
      candCount.textContent = '';
      candContent.replaceChildren(el('div', { class: 'sub-line' }, 'กำลังโหลดรายการจากบิลร้าน…'));
      let res;
      try {
        res = await api.get(`/api/sales-agents/${agentId}/commission-candidates`);
      } catch (err) {
        if (seq === loadSeq) {
          candContent.replaceChildren(el('div', { class: 'alert-box m-0' },
            `โหลดรายการไม่ได้ — ${err.fullMessage ?? err.message} `,
            el('button', { class: 'btn ghost sm', type: 'button', onclick: () => load({ keepState: true }) }, 'ลองใหม่')));
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
          : { item: it, on: false, mode: 'PCT', pct: String(it.deal?.pct ?? 0), amount: '', pctTouched: false, refs: null });
      }
      for (const f of res.fixed ?? []) {
        const prev = prevFixed.get(f.key);
        fixed.set(f.key, prev
          ? { ...prev, f, refs: null }
          : { f, on: false, amount: String(f.amount ?? ''), amountTouched: false, refs: null });
      }
      // ดีลที่แก้ค้างไว้ในหน้าต่าง (ยังไม่บันทึก) ต้องเป็นค่าตั้งต้นของรายการที่เพิ่งโหลดด้วย
      for (const s of current) if (s.closing || isChanged(s)) syncDealDefaults(s);
      loaded = true;
      drawCandidates();
      paintTotals();
    }

    /* ── โครงหน้าต่าง ────────────────────────────────────── */

    const picker = locked ? null : el('select', { 'aria-label': 'เซล' },
      el('option', { value: '', selected: !agentId }, 'เลือกเซล…'),
      ...agents.map((a) => el('option', { value: String(a.id), selected: String(a.id) === agentId },
        `${a.username} — ${a.name}${a.status === 'ACTIVE' ? '' : ' (หยุดใช้งาน)'}`)));

    function drawAll() {
      if (!agentId) {
        main.replaceChildren(el('div', { class: 'sub-line' },
          'เลือกเซลก่อน — ดีลที่เซลถืออยู่ รายการจากบิลร้านที่รอจ่ายคอม และค่าคอมอื่น ๆ ของเซลคนนั้นจะขึ้นตรงนี้'));
        return;
      }
      main.replaceChildren(
        canAdd() ? '' : el('div', { class: 'notice-box' },
          'เซลคนนี้หยุดใช้งานอยู่ — แก้/ปิดดีลเดิม และทำบิลค่าคอมที่ค้างจ่ายได้ แต่ผูกดีลใหม่ไม่ได้'),
        dealsBox,
        el('div', { class: 'adj-block' },
          el('div', { class: 'adj-block-head' },
            el('div', {},
              el('h3', {}, '🧾 รายการจากบิลร้านที่รอจ่ายคอม ', candCount),
              el('div', { class: 'sub-line' },
                'ติ๊กรายการที่จะจ่ายในบิลค่าคอมครั้งนี้ — ไม่ต้องรอร้านจ่ายบิลก่อน · % คิดจากยอดขายเต็ม (ตั้งต้นตาม % ของดีล) '
                + 'หรือเลือก "กรอกเอง" · ที่ไม่ติ๊กยังค้างไว้ทำบิลครั้งหน้า · ไม่ติ๊กอะไรเลย = บันทึกเฉพาะดีล'))),
          candContent),
        othersBox,
        totalBox,
        el('div', { class: 'form-grid', style: 'margin-top:14px' },
          field('หมายเหตุของดีลที่เพิ่มใหม่ (ไม่บังคับ)', dealNote,
            'ใช้กับสินค้าที่เพิ่มในครั้งนี้ · หมายเหตุของดีลเดิมแก้ได้ที่ "แก้ไข" ในรายละเอียดเซล'),
          field('หมายเหตุของบิลค่าคอม (ไม่บังคับ)', billNote, 'เซลเห็นหมายเหตุนี้ในบิลของตัวเอง')));
      drawDeals();
      drawOthers();
      paintTotals();
    }

    picker?.addEventListener('change', () => {
      agentId = picker.value;
      // ทุกอย่างในหน้าต่างเป็นของเซลคนก่อน — เปลี่ยนคนแล้วเริ่มใหม่หมด ไม่ให้ดีล/ติ๊ก/ค่าคอมอื่น ๆ ที่พิมพ์ไว้ติดไปจ่ายผิดคน
      rows.length = 0;
      others = [];
      items.clear();
      fixed.clear();
      groups = [];
      dealNote.value = '';
      billNote.value = '';
      loadCurrent();
      drawAll();
      load();
    });

    const root = el('div', {},
      picker ? el('div', { style: 'margin-bottom:12px' }, field('เซล *', picker)) : '',
      main);
    drawAll();

    /** บันทึกแล้ว (ทั้งหมดหรือบางส่วน) — วาดสิ่งที่อยู่ข้างหลังใหม่ให้ตัวเลขตรงกับของจริง */
    const refreshBehind = async () => {
      if (preset.onSaved) await preset.onSaved();
      else render();
    };

    formModal({
      title: locked ? `ตั้งค่าคอมให้ ${locked.username} — ${locked.name}` : 'ตั้งค่าคอม / ทำบิลค่าคอมให้เซล',
      submitLabel: 'บันทึก',
      // ตารางรายการที่รอจ่ายคอมมีช่องกรอกหลายคอลัมน์ — โมดัลปกติ 520px แคบจนต้องเลื่อนข้าง
      width: 920,
      // ช่องทั้งหมดอยู่ในกล่องพรีวิวของเราเอง (ลำดับบนลงล่างตามที่คนทำงานคิด และไม่ถูกวาดใหม่ทุกครั้งที่พิมพ์)
      fields: [],
      preview: () => ({ node: root, canSubmit: true }),
      onSubmit: async () => {
        if (!agentId) throw new Error('เลือกเซลก่อน');
        const salesAgentId = Number(agentId);
        const username = agentNow()?.username ?? '';

        /* ── 1. ตรวจทุกส่วนให้ผ่านก่อนยิงคำขอแรก — ผิดตรงไหน ไม่มีอะไรถูกบันทึก ── */

        // แถวที่พิมพ์ตัวเลขไว้แต่ลืมเลือกสินค้า — เดิมถูกทิ้งเงียบ ๆ คนตั้งนึกว่าบันทึกไปแล้ว
        rows.forEach((r, i) => {
          if (!r.productId && (r.commissionPct !== '' || r.fixedAmount !== '')) {
            throw new Error(`แถวสินค้าที่ ${i + 1} ยังไม่ได้เลือกสินค้า — เลือกสินค้าหรือกด ลบ แถวนั้น`);
          }
        });
        const newDeals = rows.filter((r) => r.productId).map((r) => ({
          productId: Number(r.productId),
          ...dealNumbers(r.commissionPct, r.fixedAmount, { prefix: `สินค้า ${skuOf(r.productId)}: ` }),
        }));
        if (newDeals.length && !canAdd()) throw new Error(`เซล ${username} หยุดใช้งานอยู่ — ผูกดีลใหม่ไม่ได้ ลบแถวสินค้าใหม่ออกก่อน`);
        const edits = current.filter((s) => !s.closing && isChanged(s)).map((s) => ({
          s,
          body: dealNumbers(s.pct, s.fixed, { prefix: `ดีล ${s.link.sku}: `, emptyMessage: EDIT_EMPTY }),
        }));
        const closing = current.filter((s) => s.closing);
        const dealNoteText = dealNote.value.trim();
        // หมายเหตุที่ไม่มีที่ลง — บอกก่อน ดีกว่าทิ้งเงียบ ๆ แล้วคนพิมพ์นึกว่าบันทึกไปแล้ว
        if (dealNoteText && !newDeals.length) {
          throw new Error('มีหมายเหตุของดีลที่เพิ่มใหม่ แต่ยังไม่ได้เพิ่มสินค้า — เพิ่มสินค้า หรือลบหมายเหตุออก (หมายเหตุของดีลเดิมแก้ที่ "แก้ไข" ในรายละเอียดเซล)');
        }

        const t = compute();
        const wantBill = t.lineCount > 0;
        const billNoteText = billNote.value.trim();
        if (billNoteText && !wantBill) {
          throw new Error('มีหมายเหตุของบิลค่าคอม แต่ยังไม่ได้ติ๊กรายการหรือใส่ค่าคอมอื่น ๆ — ติ๊กรายการ หรือลบหมายเหตุออก');
        }
        if (wantBill) {
          // ยังไม่เห็นรายการจากบิลร้านครบ = ยังไม่ควรออกบิลค่าคอม (ดีลอย่างเดียวบันทึกได้ไม่ต้องรอ)
          if (!loaded) throw new Error('รายการจากบิลร้านยังโหลดไม่เสร็จ (หรือโหลดไม่ได้) — รอสักครู่หรือกด "ลองใหม่" แล้วกดบันทึกอีกครั้ง');
          if (t.error) throw new Error(t.error);
          if (t.itemRes.length > MAX_BILL_ITEMS) throw new Error(`บิลค่าคอมหนึ่งใบติ๊กสินค้าได้ไม่เกิน ${MAX_BILL_ITEMS} รายการ — แบ่งทำสองบิล`);
          if (t.fixedRes.length > MAX_BILL_FIXED) throw new Error(`เหมาต่อรอบได้ไม่เกิน ${MAX_BILL_FIXED} รายการต่อบิล — แบ่งทำสองบิล`);
          if (t.otherRes.length > MAX_BILL_OTHERS) throw new Error(`ค่าคอมอื่น ๆ ได้ไม่เกิน ${MAX_BILL_OTHERS} รายการต่อบิล`);
          if (t.total <= 0) throw new Error('ยอดรวมบิลค่าคอมต้องมากกว่า 0 — รายการหักคืนต้องรวมอยู่กับรายการที่จ่ายในบิลเดียวกัน');
          if (billNoteText.length > 500) throw new Error('หมายเหตุของบิลค่าคอมยาวเกิน 500 ตัวอักษร');
        }

        if (!newDeals.length && !edits.length && !closing.length && !wantBill) {
          toast('ไม่มีอะไรเปลี่ยน — ยังไม่ได้แก้ดีล ติ๊กรายการ หรือใส่ค่าคอมอื่น ๆ', 'info');
          return;
        }
        if (closing.length && !window.confirm(
          `ปิดดีล ${closing.map((s) => s.link.sku).join(', ')} ของ ${username}?\n\n`
          + 'บิลร้านที่ออกไปแล้วยังติ๊กทำบิลค่าคอมให้เซลคนนี้ได้ตามเดิม (ขึ้นป้าย "ดีลปิดแล้ว") · '
          + 'ปิดแล้วสินค้านี้ผูกดีลให้เซลคนอื่นได้',
        )) {
          throw new Error('ยังไม่ได้บันทึกอะไร — กด "ไม่ปิดแล้ว" ที่ดีลที่ยังไม่อยากปิด แล้วกดบันทึกอีกครั้ง');
        }

        /* ── 2. ยิงตามลำดับ แก้ → ปิด → เพิ่ม → บิลค่าคอม · พังตรงไหนหยุดตรงนั้น ── */

        const done = { edit: 0, end: 0, add: 0 };
        const dealSummary = () => [
          done.edit ? `แก้ดีล ${done.edit}` : '',
          done.end ? `ปิดดีล ${done.end}` : '',
          done.add ? `เพิ่มดีล ${done.add}` : '',
        ].filter(Boolean).join(' · ');
        let bill = null;
        let billStep = false;
        /*
         * ล็อกช่องเลือกเซลระหว่างยิง — เปลี่ยนคนกลางทาง = ดีลที่เพิ่งผูก/ปิดของคนเก่าไปปนในหน้าต่างของคนใหม่
         * และบิลค่าคอม (ค่าคอมอื่น ๆ ที่คำนวณไว้แล้ว) จะไปออกให้คนใหม่ · URL ใช้ salesAgentId ที่จับไว้ตอนกดด้วย
         */
        if (picker) picker.disabled = true;
        try {
          for (const { s, body } of edits) {
            // ตัวเลขใหม่กลายเป็น "ค่าเดิม" ทันที — พังขั้นถัดไปแล้วกดบันทึกซ้ำ แถวนี้จะไม่ถูกส่งซ้ำ
            s.link = await api.patch(`/api/sales-agents/links/${s.link.id}`, body);
            linkById.set(Number(s.link.id), s.link);
            done.edit += 1;
          }
          for (const s of closing) {
            await api.post(`/api/sales-agents/links/${s.link.id}/end`, {});
            current = current.filter((x) => x !== s);
            done.end += 1;
          }
          if (newDeals.length) {
            // ทรานแซกชันเดียวฝั่งเซิร์ฟเวอร์ — ชนสักชิ้นไม่มีชิ้นไหนถูกผูก
            const res = await api.post('/api/sales-agents/links', { salesAgentId, ...(dealNoteText ? { note: dealNoteText } : {}), items: newDeals });
            rows.length = 0;
            dealNote.value = '';
            done.add = res.count ?? newDeals.length;
            // ดีลที่เพิ่งผูกขึ้นเป็น "ดีลที่ถืออยู่" ทันที — ถ้าขั้นบิลค่าคอมพัง หน้าต่างยังเปิดอยู่และต้องตรงกับของจริง
            current.push(...(res.items ?? []).map(toDealState));
          }
          if (wantBill) {
            billStep = true;
            bill = await api.post(`/api/sales-agents/${salesAgentId}/commission-bills`, {
              // ส่งเฉพาะช่องของวิธีที่เลือก — % ห้ามมี amount · กรอกเองห้ามมี pct (เซิร์ฟเวอร์ตอบ 400)
              items: t.itemRes.map(({ s, amount, pct: p }) => (s.mode === 'MANUAL'
                ? { entryId: s.item.entryId, mode: 'MANUAL', amount }
                : { entryId: s.item.entryId, mode: 'PCT', pct: p })),
              fixed: t.fixedRes.map(({ s, amount }) => ({ key: s.f.key, amount })),
              others: t.otherRes.map(({ label, amount }) => ({ label, amount })),
              ...(billNoteText ? { note: billNoteText } : {}),
            });
          }
        } catch (err) {
          const saved = dealSummary();
          if (saved) {
            // บางส่วนเข้าไปแล้ว — วาดดีลตามของจริง (ที่แก้แล้วไม่ขึ้นป้าย "แก้แล้ว" อีก) แล้วบอกให้ชัดว่าอะไรเข้าแล้ว อะไรยังค้าง
            drawDeals();
            paintTotals();
            await refreshBehind();
          }
          /*
           * บางรายการเพิ่งถูกทำบิลไปจากอีกหน้าจอ หรือบิลร้านเพิ่งถูกยกเลิก — โหลดรายการใหม่ให้ในที่เดิม
           * (ติ๊ก/ตัวเลขของรายการที่ยังอยู่คงไว้) แล้วให้ตรวจก่อนกดอีกครั้ง ไม่ส่งซ้ำเอง
           */
          if (billStep && (err.status === 409 || (err.status === 400 && /ไม่อยู่ในรายการ/.test(err.message)))) {
            await load({ keepState: true });
            // ข้อความเซิร์ฟเวอร์บอกให้ "โหลดใหม่" — โหลดให้แล้ว จึงเอาแค่ท่อนแรก แล้วบอกขั้นต่อไปแทน
            throw new Error(`${saved ? `บันทึกดีลแล้ว (${saved}) แต่บิลค่าคอมยังไม่ได้ทำ: ` : ''}${String(err.message).split(' — ')[0]} `
              + '— โหลดรายการใหม่ให้แล้ว (รายการที่ถูกทำบิลไปแล้วหายจากตาราง) ตรวจยอดแล้วกดบันทึกอีกครั้ง'
              + (saved ? ' (ดีลที่บันทึกแล้วไม่ถูกส่งซ้ำ)' : ''));
          }
          if (!saved) throw err;
          throw new Error(`บันทึกไปแล้วบางส่วน (${saved}) แต่${billStep ? 'ทำบิลค่าคอม' : 'ขั้นถัดไป'}ไม่ผ่าน: ${err.fullMessage ?? err.message} `
            + '— แก้ตามข้อความแล้วกดบันทึกอีกครั้ง (ส่วนที่บันทึกแล้วไม่ถูกส่งซ้ำ)');
        } finally {
          if (picker) picker.disabled = false;
        }

        toast(`บันทึกของ ${username} แล้ว — ${[
          dealSummary(),
          bill ? `ทำบิลค่าคอม ${bill.billNo ?? ''} ${money(bill.totalAmount ?? t.total)} ฿ (ยังไม่ได้จ่าย)` : '',
        ].filter(Boolean).join(' · ')}`, 'success');
        // ทำบิลค่าคอมจากหน้ารายชื่อ/แท็บบิล = พาไปที่บิลที่เพิ่งทำ (ขั้นต่อไปคือโอนเงินให้เซลแล้วกด "จ่ายแล้ว")
        // เปิดจากรายละเอียดเซล = บิลขึ้นในส่วน "ค่าคอมของเซลคนนี้" ของหน้าต่างเดิมอยู่แล้ว ไม่ต้องพาไปไหน
        if (bill && !preset.onSaved) {
          viewState.setItem(TAB_KEY, 'commissions');
          viewState.setItem(COMM_STATUS_KEY, 'PENDING');
          viewState.setItem(COMM_AGENT_KEY, String(salesAgentId));
        }
        await refreshBehind();
      },
    });
    // เนื้อหาเข้าโมดัลหลังพรีวิวรอบแรก (ไม่ทันในจังหวะนี้) — โฟกัสหลังวาดเสร็จ ไม่งั้นโฟกัสลงช่องที่ยังไม่อยู่บนหน้า
    if (picker) setTimeout(() => picker.focus());
    load();
  };

  const body = tab === 'agents' ? agentsTab(agents, { createAgentModal, commissionModal })
    : tab === 'links' ? linksTab(allLinks, { commissionModal })
      : await commissionsTab(agents, { commissionModal });

  /*
   * หัวหน้ามีแค่ "ประวัติ" กับ "+ เพิ่มเซล" — เจ้าของระบบให้เอาปุ่มผูกดีลมุมขวาบนออก
   * ตั้งค่าคอม (ดีล + ทำบิลค่าคอม ในหน้าต่างเดียว) เป็นเรื่องของเซลทีละคน จึงอยู่ที่แถวของเซล
   * (แบบเลือกเซลเองอยู่ในแท็บ "ค่าคอมที่ต้องจ่าย")
   */
  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'เซล และค่าคอมจากการหาลูกค้า'),
        el('p', { style: 'max-width:66ch' },
          'เซลได้ค่าคอมเมื่อทำบิลค่าคอม: ติ๊กรายการจากบิลร้านของสินค้าที่เซลถือดีล (% ของยอดขายเต็ม หรือกรอกเอง) '
          + 'และใส่ค่าคอมอื่น ๆ ได้ · ทุกอย่างอยู่ในปุ่ม "ตั้งค่าคอม" ของแถวเซล (ดีล · รายการที่รอจ่ายคอม · ค่าคอมอื่น ๆ)')),
      el('div', { class: 'btn-row' },
        activityButton(['agent', 'sales_link', 'sales_commission'], { title: 'ประวัติเซลและค่าคอม' }),
        el('button', { class: 'btn', onclick: createAgentModal }, '+ เพิ่มเซล'))),
    tabs,
    body);
}

/* ── รายชื่อเซล ────────────────────────────────────────────── */
function agentsTab(agents, { createAgentModal, commissionModal }) {
  /**
   * รายละเอียดเซล — ดีลที่ถืออยู่แก้/ปิดได้ตรงนี้เลย (เจ้าของระบบ: "ตรงที่ผูกดีลไปแล้ว สามารถแก้ไขได้")
   * บันทึกแล้ววาดเนื้อหาใหม่ในโมดัลเดิม (ไม่ปิด คนแก้มักแก้ต่อหลายดีล) และวาดหน้าข้างหลังใหม่ให้ตัวเลขตรงกัน
   * ทั้งหน้าเป็นของส่วนกลางอย่างเดียว (เส้นทางและ API ด่าน super) — ปุ่มแก้/ปิดดีลจึงไม่ต้องเช็กบทบาทซ้ำ
   *
   * มีส่วน "ค่าคอมของเซลคนนี้" ด้วย — เจ้าของระบบเห็นแค่ยอด "คอมค้างจ่าย" แล้วถาม
   * "แล้วที่เขาได้ค่าคอมอื่น ๆ ทำไมไม่มีโชว์" จึงลิสต์บิลค่าคอมทุกใบ (ทุกสถานะ) พร้อมชื่อรายการค่าคอมอื่น ๆ ในแต่ละใบ
   */
  const detailModal = async (row) => {
    // ทุกสถานะ (ไม่ส่ง status) — ต้องเห็นทั้งที่รอจ่าย จ่ายแล้ว และที่ยกเลิกไป
    // โหลดค่าคอมไม่ได้ไม่ควรทำให้เปิดรายละเอียดเซลไม่ได้ทั้งหน้าต่าง — โชว์ข้อความในส่วนนั้นแทน
    const loadCommissions = () => api.get(`/api/sales-agents/commissions${qs({ salesAgentId: row.id })}`)
      .catch((err) => ({ error: err }));
    let full;
    let comms;
    try {
      [full, comms] = await Promise.all([api.get(`/api/sales-agents/${row.id}`), loadCommissions()]);
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
        const [data, list] = await Promise.all([api.get(`/api/sales-agents/${row.id}`), loadCommissions()]);
        fill(data, list);
      } catch (err) {
        // บันทึกผ่านไปแล้ว แค่โหลดรายละเอียดใหม่ไม่ได้ — อย่าให้ฟอร์มที่เรียกมาเข้าใจว่าบันทึกไม่สำเร็จ
        toast(`บันทึกแล้ว แต่โหลดรายละเอียดใหม่ไม่ได้ — ปิดแล้วเปิดใหม่ (${err.fullMessage ?? err.message})`, 'error');
      }
    };
    // ดู/จ่าย/ยกเลิกบิลค่าคอมจากในนี้ได้เลย — ทำแล้ววาดรายละเอียดใหม่ในที่เดิม
    const { viewModal } = commissionActions({ onChanged: refresh });
    /*
     * หน้าต่างเดียวกับปุ่ม "ตั้งค่าคอม" ของแถวเซล — บันทึกแล้ววาดรายละเอียดนี้ใหม่ (ไม่พาไปแท็บอื่น)
     * ส่งดีลชุดล่าสุดของรายละเอียดไปด้วย: commissionModal นี้มาจากตอนวาดหน้าก่อนเปิดรายละเอียด
     * ถ้าแก้/ปิด/ผูกดีลจากในนี้แล้ว (แถว "แก้ไข" หรือ "ตั้งค่าคอม" รอบก่อน) ดีลของหน้านั้นเก่าไปแล้ว
     */
    let latest = full;
    const openSettings = () => commissionModal({
      salesAgentId: String(row.id), lock: true, onSaved: refresh, links: latest.links ?? [],
    });

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
      empty: 'ยังไม่ได้ผูกดีล — ไม่บังคับ เซลได้แค่ค่าคอมอื่น ๆ ก็ได้ · ผูกดีลได้ที่ปุ่ม "ตั้งค่าคอม"',
      sortable: false,
    });

    /** ค่าคอมอื่น ๆ ในบิลใบนั้น (ชื่อ + ยอด) — ไม่ต้องกด "ดู" ก็รู้ว่าก้อนพิเศษที่จ่ายไปคืออะไร · ยาวเกินตัดเหลือ 3 */
    const otherLines = (r) => {
      const lines = isBill(r) ? (r.lines ?? []).filter((l) => l.kind === 'OTHER') : [];
      if (!lines.length) return '';
      return el('div', { class: 'sub-line mt-4' },
        ...lines.slice(0, 3).map((l) => el('div', {},
          `💰 ${l.label ?? 'ค่าคอมอื่น ๆ'} `,
          el('span', { class: Number(l.amount) < 0 ? 'text-danger' : '' }, `${money(l.amount)} ฿`))),
        lines.length > 3 ? el('div', {}, `และอีก ${lines.length - 3} รายการ`) : '');
    };

    // รอจ่ายขึ้นก่อน (ต้องจัดการ) → จ่ายแล้ว → ยกเลิกท้ายสุด · ในกลุ่มเดียวกันคงลำดับเดิมของเซิร์ฟเวอร์ (ใหม่ก่อน)
    const STATUS_ORDER = { PENDING: 0, PAID: 1, VOID: 2 };
    const commissionsSection = (data, list) => el('div', {},
      el('div', { class: 'adj-block-head', style: 'margin:18px 0 8px' },
        el('div', {},
          el('h3', {}, '💰 ค่าคอมของเซลคนนี้'),
          list.error
            ? ''
            : el('div', { class: 'sub-line' },
              `รอจ่าย ${money(list.summary?.pending)} ฿ · จ่ายแล้ว ${money(list.summary?.paid)} ฿`)),
        el('button', { class: 'btn sm', onclick: openSettings },
          `ตั้งค่าคอม${data.uncommissionedCount ? ` (${int(data.uncommissionedCount)} รอจ่าย)` : ''}`)),
      list.error
        ? el('div', { class: 'alert-box m-0' }, `โหลดค่าคอมไม่ได้ — ${list.error.fullMessage ?? list.error.message}`)
        : table([
          {
            label: 'เลขที่ / รายการ',
            render: (r) => el('div', {},
              el('strong', {}, commissionTitle(r)),
              el('div', { class: 'sub-line' }, commissionSubtitle(r)),
              otherLines(r)),
          },
          // บิลค่าคอมไม่มีรอบ (วันที่ทำบิล) · แถวแบบเดิมผูกกับรอบบิลร้าน
          { label: 'วันที่/รอบ', render: (r) => (isBill(r) ? dateTh(r.createdAt) : periodLabel(r.periodCode)) },
          { label: 'ยอด', num: true, render: (r) => el('strong', {}, money(r.totalAmount)) },
          { label: 'สถานะ', render: commStatusCell },
          { label: '', render: (r) => el('button', { class: 'btn ghost sm', onclick: () => viewModal(r) }, 'ดู') },
        ], [...(list.items ?? [])].sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3)), {
          sortable: false,
          rowClass: (r) => (r.status === 'VOID' ? 'row-void' : ''),
          empty: {
            icon: '💰',
            title: 'ยังไม่มีค่าคอม — กด "ตั้งค่าคอม" เพื่อทำบิลค่าคอมหรือใส่ค่าคอมอื่น ๆ',
            action: { label: 'ตั้งค่าคอม', onClick: openSettings },
          },
        }));

    function fill(data, list) {
      latest = data;
      modal.body.replaceChildren(
        el('div', { class: 'stat-grid' },
          stat('สินค้าที่ถือดีลอยู่', int(data.activeProductCount), null, { tone: 'sales', icon: '📦' }),
          stat('คอมค้างจ่าย', money(data.pendingCommission) + ' ฿', null, { tone: 'due', icon: '⏳' }),
          stat('จ่ายไปแล้วสะสม', money(data.paidCommission) + ' ฿', null, { tone: 'income', icon: '✓' })),
        commissionsSection(data, list),
        el('h3', { style: 'margin:18px 0 4px' }, 'ดีลที่ถืออยู่'),
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
    fill(full, comms);
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
      // ปุ่มหลายปุ่มเรียงบรรทัดเดียวล้นจอโน้ตบุ๊ก — ให้ขึ้นบรรทัดสองได้ แทนการเลื่อนตารางไปหาปุ่ม
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
        el('button', {
          class: 'btn ghost sm',
          /*
           * ปุ่มเดียว — ดีล รายการที่รอจ่ายคอม และค่าคอมอื่น ๆ อยู่ในหน้าต่างเดียวกัน
           * (เจ้าของระบบ: "อยู่หน้าเดียวกันแบบเดิมดีแล้ว ไม่แยกปุ่มแบบนี้")
           * เซิร์ฟเวอร์นับรายการจากบิลร้านที่ยังไม่ได้ทำบิลค่าคอมมาให้ (ถ้ามี) — บอกไว้ที่ปุ่มเลย ไม่ต้องเปิดดูทีละคน
           */
          onclick: () => commissionModal({ salesAgentId: String(r.id), lock: true }),
        }, `ตั้งค่าคอม${r.uncommissionedCount ? ` (${int(r.uncommissionedCount)} รอจ่าย)` : ''}`),
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
function linksTab(items, { commissionModal }) {
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
      // หน้าต่างเดียวกับปุ่ม "ตั้งค่าคอม" ของแถวเซล — เลือกเซลก่อนแล้วผูกดีลได้เลย
      action: { label: '+ ตั้งค่าคอม (ผูกดีล)', onClick: () => commissionModal() },
    },
  }), { tight: true }));
}

/* ── บิลค่าคอม ─────────────────────────────────────────────── */

/** ช่องสถานะของบิลค่าคอม — ป้าย + วันที่จ่าย / เหตุผลที่ยกเลิก (แท็บบิลค่าคอมและรายละเอียดเซลใช้ตัวเดียวกัน) */
const commStatusCell = (r) => el('div', {}, commBadge(r.status),
  r.status === 'PAID' && r.paidAt ? el('div', { class: 'sub-line' }, `จ่าย ${dateTh(r.paidAt)}`) : '',
  r.status === 'VOID' && r.voidReason ? el('div', { class: 'sub-line' }, r.voidReason) : '');

/**
 * ดู / จ่าย / ยกเลิกบิลค่าคอม — ใช้ทั้งแท็บ "ค่าคอมที่ต้องจ่าย" และส่วน "ค่าคอมของเซลคนนี้" ในรายละเอียดเซล
 * ให้สองที่ทำงานเหมือนกันทุกตัวอักษร · onChanged = วาดใหม่หลังจ่าย/ยกเลิก (แท็บ = ทั้งหน้า · รายละเอียดเซล = โมดัลเดิมด้วย)
 */
function commissionActions({ onChanged }) {
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
      await onChanged();
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
      await onChanged();
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

  return { payModal, voidModal, viewModal };
}

/**
 * รายการบิลค่าคอม (แบนราบ หนึ่งแถว = หนึ่งบิล = จ่ายเซลหนึ่งครั้ง)
 * แถวแบบเดิม (คิดตอนออกบิลร้าน / ค่าคอมอื่น ๆ แบบเลือกรอบ) ปนอยู่ในลิสต์เดียวกัน — จ่ายหรือยกเลิกได้เหมือนกัน
 */
async function commissionsTab(agents, { commissionModal }) {
  const statusFilter = viewState.getItem(COMM_STATUS_KEY) ?? 'PENDING';
  const agentFilter = viewState.getItem(COMM_AGENT_KEY) ?? '';
  const res = await api.get(`/api/sales-agents/commissions${qs({ status: statusFilter, salesAgentId: agentFilter })}`);
  const { payModal, voidModal, viewModal } = commissionActions({ onChanged: render });

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
        // หน้าต่างเดียวกับปุ่ม "ตั้งค่าคอม" ของแถวเซล · กรองเซลไว้ = เลือกเซลคนนั้นให้เลย (ยังเปลี่ยนได้ในหน้าต่าง)
        onclick: () => commissionModal({ salesAgentId: agentFilter }),
      }, 'ตั้งค่าคอม / ทำบิลค่าคอม'),
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
      { label: 'สถานะ', render: commStatusCell },
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
        detail: 'กด "ตั้งค่าคอม / ทำบิลค่าคอม" แล้วติ๊กรายการจากบิลร้านที่ออกแล้ว (หรือใส่ค่าคอมอื่น ๆ) ให้เซล',
      },
      footer: res.items.length
        ? ['', '', '', 'รวม (ไม่นับที่ยกเลิก)', money(res.summary.total ?? sumBaht([res.summary.pending, res.summary.paid])), '', '']
        : undefined,
    }), { tight: true }));
}
