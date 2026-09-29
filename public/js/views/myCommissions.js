import { api } from '../api.js';
import { badge, card, commBadge, dateTh, el, infoModal, int, monthTh, money, stat, table } from '../ui.js';
import { todayIso } from '../period.js';
import { render } from '../app.js';
import { viewState } from '../viewState.js';
import { barTrend } from '../charts.js';
import { commissionDetail, commissionSubtitle, commissionTitle } from './commissionLines.js';
import { dealTerms } from './billLines.js';

const STATUS_KEY = 'franchise.myCommStatus';

/**
 * หน้าแรกของเซล — ตอบคำถามเดียว: "ได้เท่าไร ได้รับแล้วหรือยัง"
 *
 * ค่าคอมมาเป็น "บิลค่าคอม" ที่ส่วนกลางทำให้เป็นครั้ง ๆ (ติ๊กรายการจากบิลร้าน + ค่าคอมอื่น ๆ)
 * ไม่ได้ผูกกับรอบบิลแล้ว — สรุปรายเดือนแทนรายรอบ
 * รายการในบิลแต่ละใบอยู่ในป๊อปอัพ ("ใบสรุป") แบบเดียวกับที่ส่วนกลางเปิดดู
 * ส่วนรายการสินค้าที่ถือดีลแยกไปเมนู "สินค้าที่ถือดีล" — คนละคำถามกัน
 */
export async function myCommissionsView() {
  const statusFilter = viewState.getItem(STATUS_KEY) ?? '';
  const [me, comms] = await Promise.all([
    api.get('/api/sales-agents/me'),
    api.get('/api/sales-agents/me/commissions'),
  ]);

  const statusPicker = el('select', {
    onchange: (e) => { viewState.setItem(STATUS_KEY, e.target.value); render(); },
  }, ...[
    { value: '', label: 'ทุกบิล (ไม่รวมที่ยกเลิก)' },
    { value: 'PENDING', label: 'รอรับ' },
    { value: 'PAID', label: 'ได้รับแล้ว' },
    { value: 'VOID', label: 'ยกเลิก' },
  ].map((o) => el('option', { value: o.value, selected: o.value === statusFilter }, o.label)));

  // บิลที่ยกเลิกไม่ใช่เงินที่จะได้ — ซ่อนไว้ก่อน เลือกดูเองได้ถ้าอยากรู้ว่าถูกยกเลิกเพราะอะไร
  const bills = comms.items.filter((r) => (statusFilter ? r.status === statusFilter : r.status !== 'VOID'));
  const liveCount = comms.items.filter((r) => r.status !== 'VOID').length;

  // เซิร์ฟเวอร์ส่ง 12 เดือนล่าสุด — กราฟอ่านจากซ้าย (เก่า) ไปขวา (ใหม่)
  const byMonth = [...(me.byMonth ?? [])].sort((a, b) => String(a.month).localeCompare(String(b.month)));
  const thisMonth = todayIso().slice(0, 7);
  // เซิร์ฟเวอร์ส่งยอดที่จ่ายแล้วมาให้ (ไม่นับที่ยกเลิก) — รุ่นที่ไม่มีช่องนี้ใช้ รวม − ค้าง แทน
  const receivedOf = (m) => Number((m.paidAmount ?? (m.totalAmount - m.pendingAmount)).toFixed(2));

  const billModal = (row) => infoModal({
    title: commissionTitle(row),
    width: 860,
    content: commissionDetail(row, { forAgent: true }),
  });

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'รายได้ของฉัน'),
        el('p', { style: 'max-width:66ch' },
          `${me.agent.name} · ${me.agent.username} — ส่วนกลางรวมรายการจากบิลร้านของสินค้าที่คุณถือดีล (และค่าคอมอื่น ๆ) `
          + 'ทำเป็น "บิลค่าคอม" แล้วโอนให้เป็นครั้ง ๆ')),
      el('div', { class: 'field' }, statusPicker)),

    el('div', { class: 'stat-grid' },
      stat('รอรับ', money(me.summary.pending) + ' ฿', 'ส่วนกลางยังไม่ได้จ่าย',
        { tone: me.summary.pending > 0 ? 'due' : 'muted', icon: '⏳' }),
      stat('ได้รับแล้วสะสม', money(me.summary.paid) + ' ฿', 'ตั้งแต่เริ่มทำ', { tone: 'income', icon: '✓' }),
      stat('รวมทั้งหมด', money(Number((me.summary.pending + me.summary.paid).toFixed(2))) + ' ฿',
        `จาก ${int(liveCount)} บิลค่าคอม`, { tone: 'sales', icon: '🎯' }),
      stat('สินค้าที่ถือดีลอยู่', int(me.summary.activeProducts),
        el('a', { href: '#/my-deals' }, 'ดูเงื่อนไขคอม →'), { tone: 'muted', icon: '📦' })),

    byMonth.length
      ? card('ค่าคอมรายเดือน',
        el('div', {},
          barTrend(byMonth.map((m) => ({ label: monthTh(m.month), value: m.totalAmount })), { highlight: monthTh(thisMonth) }),
          table([
            { label: 'เดือน', sortValue: (r) => r.month, render: (r) => el('strong', {}, monthTh(r.month)) },
            { label: 'บิลค่าคอม', num: true, render: (r) => int(r.count) },
            {
              label: 'ได้รับแล้ว',
              num: true,
              render: (r) => (receivedOf(r) > 0
                ? el('strong', { class: 'text-success' }, money(receivedOf(r)))
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
            { label: 'รวมทั้งเดือน', num: true, sortValue: (r) => r.totalAmount, render: (r) => el('strong', {}, money(r.totalAmount)) },
          ], [...byMonth].reverse(), { sortable: false })),
        { tight: true })
      : '',

    card('บิลค่าคอมของฉัน',
      table([
        { label: 'เลขที่', sortValue: (r) => commissionTitle(r), render: (r) => el('strong', {}, commissionTitle(r)) },
        { label: 'วันที่', sortValue: (r) => r.createdAt ?? '', render: (r) => dateTh(r.createdAt) },
        { label: 'รายการ', render: (r) => commissionSubtitle(r) },
        { label: 'ยอดรวม', num: true, sortValue: (r) => r.totalAmount, render: (r) => el('strong', {}, money(r.totalAmount)) },
        {
          label: 'สถานะ',
          render: (r) => el('div', {}, commBadge(r.status, { forAgent: true }),
            r.status === 'PAID' && r.paidAt ? el('div', { class: 'sub-line' }, `ได้รับ ${dateTh(r.paidAt)}`) : ''),
        },
        {
          label: '',
          sortable: false,
          render: (r) => el('button', { class: 'btn sm', onclick: () => billModal(r) }, 'ดูรายการ'),
        },
      ], bills, {
        empty: statusFilter
          ? 'ไม่มีบิลค่าคอมที่ตรงกับสถานะที่เลือก'
          : 'ยังไม่มีบิลค่าคอม — ส่วนกลางจะทำบิลค่าคอมให้เมื่อถึงรอบจ่าย',
      }),
      { tight: true }));
}

/** เมนูแยกอีกหน้า — "ของเรามีอะไรบ้าง" คนละคำถามกับ "ได้เท่าไร" */
export async function myDealsView() {
  const me = await api.get('/api/sales-agents/me');
  // ดีลเปิดอยู่ = ยังไม่มีวันปิด (ดีลเก่าที่ตั้งวันสิ้นสุดไว้ล่วงหน้า นับว่าเปิดจนถึงวันนั้น)
  const isOpen = (l) => !l.endDate || l.endDate > todayIso();
  const active = me.products.filter(isOpen);

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'สินค้าที่ถือดีล'),
        el('p', { style: 'max-width:66ch' },
          'สินค้าที่คุณผลักดัน และเงื่อนไขคอมของแต่ละชิ้น — % คิดจากยอดขายเต็มของร้าน '
          + 'ส่วนกลางติ๊กรายการของสินค้าเหล่านี้จากบิลร้านมาทำเป็นบิลค่าคอมให้คุณ · '
          // ส่วนกลางแก้ดีลได้แล้ว — เซลเห็นเลขเปลี่ยนแล้วต้องรู้ว่าบิลที่ได้ไปแล้วไม่ถูกคิดใหม่
          + 'ส่วนกลางแก้เงื่อนไขได้ ตัวเลขใหม่ใช้กับบิลค่าคอมที่ทำหลังจากนั้น (บิลที่ทำไปแล้วไม่เปลี่ยน)'))),

    el('div', { class: 'stat-grid' },
      stat('ถือดีลอยู่ตอนนี้', int(active.length), 'ที่ยังได้รับคอมต่อเนื่อง', { tone: 'sales', icon: '📦' }),
      stat('ร้านที่เกี่ยวข้อง', int(new Set(active.map((l) => l.franchiseUsername).filter(Boolean)).size),
        'ร้านที่ขายสินค้าของคุณอยู่', { tone: 'muted', icon: '🏪' }),
      stat('รอรับ', money(me.summary.pending) + ' ฿',
        el('a', { href: '#/my-sales' }, 'ดูบิลค่าคอม →'),
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
      { label: 'เงื่อนไขคอม', render: (l) => dealTerms({ pct: l.commissionPct, fixedAmount: l.fixedAmount }) },
      {
        label: 'สถานะ',
        sortValue: (l) => (isOpen(l) ? `0${l.startDate}` : `1${l.endDate}`),
        render: (l) => (isOpen(l)
          ? el('div', {}, badge('ACTIVE'), el('div', { class: 'sub-line' }, `เริ่ม ${dateTh(l.startDate)}`))
          : el('div', {}, badge('CLOSED'), el('div', { class: 'sub-line' }, `ปิดแล้ว ${dateTh(l.endDate)}`))),
      },
    ], me.products, {
      search: 'ค้นหาสินค้าหรือร้าน…',
      empty: 'ยังไม่มีสินค้าในความดูแล — ส่วนกลางเป็นคนผูกดีลให้ (ไม่มีดีลก็ยังได้ค่าคอมอื่น ๆ ได้)',
    }), { tight: true }));
}
