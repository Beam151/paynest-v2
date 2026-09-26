import { api, qs } from '../api.js';
import { badge, card, commBadge, dateTh, el, infoModal, int, money, pct, stat, table } from '../ui.js';
import { periodLabel } from '../period.js';
import { render } from '../app.js';
import { viewState } from '../viewState.js';

const STATUS_KEY = 'franchise.myCommStatus';

/**
 * หน้าแรกของเซล — ตอบคำถามเดียว: "รอบนี้ได้เท่าไร ได้รับแล้วหรือยัง"
 *
 * รายละเอียดของรอบอยู่ในป๊อปอัพ ไม่กางในตาราง เพราะมันคือ "ใบสรุปของรอบนั้น"
 * แบบเดียวกับที่ส่วนกลางเปิดดูบิลของร้าน
 * ส่วนรายการสินค้าที่ถือดีลแยกไปเมนู "สินค้าที่ถือดีล" — คนละคำถามกัน
 */
export async function myCommissionsView() {
  const statusFilter = viewState.getItem(STATUS_KEY) ?? '';
  const [me, comms] = await Promise.all([
    api.get('/api/sales-agents/me'),
    // ใบสรุปของรอบต้องเห็นทุกรายการเสมอ — ตัวกรองสถานะใช้กับตารางรายรอบด้านล่าง
    api.get('/api/sales-agents/me/commissions'),
  ]);

  const statusPicker = el('select', {
    onchange: (e) => { viewState.setItem(STATUS_KEY, e.target.value); render(); },
  }, ...[
    { value: '', label: 'ทุกสถานะ' },
    { value: 'PENDING', label: 'รอบที่ยังรอรับ' },
    { value: 'PAID', label: 'รอบที่ได้รับแล้ว' },
  ].map((o) => el('option', { value: o.value, selected: o.value === statusFilter }, o.label)));

  // ตัวกรองสถานะเดิมไปกรองแค่รายการในป๊อปอัพ ตารางหลักไม่เปลี่ยนเลย — กรองที่ตารางรายรอบแทน
  const received = (r) => r.totalAmount - r.pendingAmount > 0;
  const rows = me.byPeriod.filter((r) => (statusFilter === 'PENDING' ? r.pendingAmount > 0
    : statusFilter === 'PAID' ? received(r) && r.pendingAmount === 0 : true));

  /** ใบสรุปของรอบหนึ่ง — โครงเดียวกับใบเรียกเก็บที่ส่วนกลางออกให้ร้าน */
  const periodModal = (row) => {
    const items = comms.items.filter((c) => c.periodCode === row.periodCode);
    const fromDeals = items.filter((c) => !c.isManual);
    const manual = items.filter((c) => c.isManual);
    const sum = (list) => Number(list.reduce((t, c) => t + c.totalAmount, 0).toFixed(2));
    const received = Number((row.totalAmount - row.pendingAmount).toFixed(2));

    const modal = infoModal({
      title: `รอบ ${periodLabel(row.periodCode)}`,
      width: 760,
      content: null,
    });

    modal.body.append(
      el('div', { class: 'stat-grid' },
        stat('รวมคอมรอบนี้', money(row.totalAmount) + ' ฿', `${int(items.length)} รายการ`, { tone: 'sales', icon: '🎯' }),
        stat('ได้รับแล้ว', money(received) + ' ฿', null, { tone: 'income', icon: '✓' }),
        stat('ยังรอรับ', money(row.pendingAmount) + ' ฿', 'ส่วนกลางยังไม่ได้จ่าย',
          { tone: row.pendingAmount > 0 ? 'due' : 'income', icon: row.pendingAmount > 0 ? '⏳' : '✓' })),

      el('h3', { style: 'margin:6px 0 8px' }, 'คอมจากสินค้าที่ถือดีล'),
      table([
        {
          label: 'ร้านที่ขาย',
          render: (r) => el('div', {}, el('strong', {}, r.franchiseUsername ?? '—'),
            el('div', { class: 'sub-line' }, r.invoiceNo ?? '—')),
        },
        {
          label: 'ฐานที่คิด',
          num: true,
          render: (r) => el('div', {}, money(r.baseAmount), el('div', { class: 'sub-line' }, r.basisLabel)),
        },
        { label: 'จาก %', num: true, render: (r) => (r.commissionPct === null ? el('span', { class: 'muted' }, '—') : `${money(r.pctAmount)} (${pct(r.commissionPct)})`) },
        { label: 'เหมาต่อรอบ', num: true, render: (r) => (r.fixedAmount ? money(r.fixedAmount) : el('span', { class: 'muted' }, '—')) },
        { label: 'รวม', num: true, render: (r) => el('strong', {}, money(r.totalAmount)) },
        { label: 'สถานะ', render: (r) => commBadge(r.status, { forAgent: true }) },
      ], fromDeals, {
        sortable: false,
        empty: 'รอบนี้ไม่มีคอมจากดีล',
        footer: fromDeals.length ? ['', '', '', 'รวมจากดีล', money(sum(fromDeals)), ''] : undefined,
      }),

      // โผล่เฉพาะตอนมีจริง — รอบไหนไม่มีก็ไม่ต้องมีหัวข้อว่างให้รก
      manual.length ? el('h3', { style: 'margin:18px 0 8px' }, 'ค่าคอมอื่น ๆ') : '',
      manual.length
        ? table([
          {
            label: 'รายการ',
            render: (r) => el('div', {}, el('strong', {}, r.label),
              r.note ? el('div', { class: 'sub-line' }, r.note) : ''),
          },
          { label: 'จำนวนเงิน', num: true, render: (r) => el('strong', {}, money(r.totalAmount)) },
          { label: 'สถานะ', render: (r) => commBadge(r.status, { forAgent: true }) },
          { label: 'วันที่ได้รับ', render: (r) => (r.paidAt ? dateTh(r.paidAt) : el('span', { class: 'muted' }, '—')) },
        ], manual, {
          sortable: false,
          footer: ['รวมค่าคอมอื่น ๆ', money(sum(manual)), '', ''],
        })
        : '',

      el('div', { class: 'notice-box', style: 'margin:18px 0 0' },
        row.pendingAmount > 0
          ? `รอบนี้ยังรอรับ ${money(row.pendingAmount)} ฿ จากทั้งหมด ${money(row.totalAmount)} ฿`
          : `รอบนี้ได้รับครบ ${money(row.totalAmount)} ฿ แล้ว`));
  };

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'รายได้ของฉัน'),
        el('p', {}, `${me.agent.name} · ${me.agent.username} — ค่าคอมเกิดทุกครั้งที่ส่วนกลางออกบิลที่มีสินค้าที่คุณถือดีล`)),
      el('div', { class: 'field' }, statusPicker)),

    el('div', { class: 'stat-grid' },
      stat('รอรับ', money(me.summary.pending) + ' ฿', 'ส่วนกลางยังไม่ได้จ่าย',
        { tone: me.summary.pending > 0 ? 'due' : 'muted', icon: '⏳' }),
      stat('ได้รับแล้วสะสม', money(me.summary.paid) + ' ฿', 'ตั้งแต่เริ่มทำ', { tone: 'income', icon: '✓' }),
      stat('รวมทั้งหมด', money(Number((me.summary.pending + me.summary.paid).toFixed(2))) + ' ฿',
        `จาก ${int(me.byPeriod.length)} รอบบิล`, { tone: 'sales', icon: '🎯' }),
      stat('สินค้าที่ถือดีลอยู่', int(me.summary.activeProducts),
        el('a', { href: '#/my-deals' }, 'ดูเงื่อนไขคอม →'), { tone: 'muted', icon: '📦' })),

    card('รายได้แต่ละรอบบิล',
      table([
        {
          label: 'รอบบิล',
          sortValue: (r) => r.periodCode,
          render: (r) => el('strong', {}, periodLabel(r.periodCode)),
        },
        { label: 'จำนวนรายการ', num: true, render: (r) => int(r.entries) },
        {
          label: 'ได้รับแล้ว',
          num: true,
          sortValue: (r) => r.totalAmount - r.pendingAmount,
          render: (r) => (r.totalAmount - r.pendingAmount > 0
            ? el('strong', { class: 'text-success' }, money(Number((r.totalAmount - r.pendingAmount).toFixed(2))))
            : el('span', { class: 'muted' }, '—')),
        },
        {
          label: 'ยังรอรับ',
          num: true,
          sortValue: (r) => r.pendingAmount,
          render: (r) => (r.pendingAmount
            ? el('strong', { class: 'text-warn' }, money(r.pendingAmount))
            : el('span', { class: 'muted' }, '—')),
        },
        { label: 'รวมทั้งรอบ', num: true, sortValue: (r) => r.totalAmount, render: (r) => el('strong', {}, money(r.totalAmount)) },
        {
          label: '',
          sortable: false,
          render: (r) => el('button', { class: 'btn sm', onclick: () => periodModal(r) }, 'ดูใบสรุป'),
        },
      ], rows, {
        empty: statusFilter
          ? 'ไม่มีรอบที่ตรงกับสถานะที่เลือก'
          : 'ยังไม่มีค่าคอมเกิดขึ้น — จะเริ่มมีเมื่อส่วนกลางออกบิลที่มีสินค้าที่คุณถือดีล',
      }),
      { tight: true }));
}

/** เมนูแยกอีกหน้า — "ของเรามีอะไรบ้าง" คนละคำถามกับ "รอบนี้ได้เท่าไร" */
export async function myDealsView() {
  const me = await api.get('/api/sales-agents/me');
  const active = me.products.filter((l) => l.isActive);

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'สินค้าที่ถือดีล'),
        el('p', {}, 'สินค้าที่คุณผลักดัน และเงื่อนไขคอมของแต่ละชิ้น — ทุกครั้งที่ส่วนกลางออกบิลที่มีสินค้านี้ คุณได้ส่วนต่างตามนี้'))),

    el('div', { class: 'stat-grid' },
      stat('ถือดีลอยู่ตอนนี้', int(active.length), 'ที่ยังได้รับคอมต่อเนื่อง', { tone: 'sales', icon: '📦' }),
      stat('ร้านที่เกี่ยวข้อง', int(new Set(active.map((l) => l.franchiseUsername).filter(Boolean)).size),
        'ร้านที่ขายสินค้าของคุณอยู่', { tone: 'muted', icon: '🏪' }),
      stat('รอรับ', money(me.summary.pending) + ' ฿',
        el('a', { href: '#/my-sales' }, 'ดูรายได้แต่ละรอบ →'),
        { tone: me.summary.pending > 0 ? 'due' : 'muted', icon: '⏳' })),

    card(null, table([
      {
        label: 'สินค้า',
        sortValue: (l) => l.sku,
        render: (l) => el('div', {}, el('strong', {}, l.sku), el('div', { class: 'sub-line' }, l.productName)),
      },
      {
        label: 'ร้านที่ขาย',
        sortValue: (l) => l.franchiseUsername ?? '',
        render: (l) => l.franchiseUsername ?? el('span', { class: 'muted' }, '—'),
      },
      {
        label: 'เงื่อนไขคอม',
        render: (l) => el('div', {}, ...[
          l.commissionPct === null ? null : `${pct(l.commissionPct)} ของ${l.basisLabel}`,
          l.fixedAmount === null ? null : `เหมา ${money(l.fixedAmount)} ฿/รอบ`,
        ].filter(Boolean).map((t, i) => el('div', { class: i ? 'sub-line' : '' }, t))),
      },
      { label: 'ตั้งแต่', sortValue: (l) => l.startDate, render: (l) => dateTh(l.startDate) },
      { label: 'ถึง', render: (l) => (l.endDate ? dateTh(l.endDate) : el('span', { class: 'muted' }, 'ไม่กำหนด')) },
      { label: 'สถานะ', sortValue: (l) => String(l.isActive), render: (l) => badge(l.isActive ? 'ACTIVE' : 'CLOSED') },
    ], me.products, {
      search: 'ค้นหาสินค้าหรือร้าน…',
      empty: 'ยังไม่มีสินค้าในความดูแล — ส่วนกลางเป็นคนผูกดีลให้',
    }), { tight: true }));
}
