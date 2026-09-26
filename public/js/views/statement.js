import { periodLabel } from '../period.js';
import { api, qs, session } from '../api.js';
import { badge, card, dateTh, el, int, money, stat, table } from '../ui.js';
import { render } from '../app.js';
import { avatar } from '../charts.js';

/**
 * หน้ารายร้าน (statement) — ตอบคำถาม "ร้านนี้ค้างเท่าไร ตั้งแต่เมื่อไร" ได้ในหน้าเดียว
 *
 * เดิมต้องไปหน้าบิล เปลี่ยนรอบเป็น "ทุกรอบ" แล้วพิมพ์ค้นหาชื่อร้านเอง
 * และไม่มีที่ไหนเห็นบิล + เงินที่ได้รับ + เครดิตยกมาของร้านเดียวพร้อมกัน
 */
export async function statementView(franchiseId) {
  const [shop, invoices, received, credits] = await Promise.all([
    api.get(`/api/franchises/${franchiseId}`),
    api.get(`/api/invoices${qs({ franchiseId })}`),
    api.get(`/api/payments/received${qs({ franchiseId })}`),
    api.get(`/api/franchises/${franchiseId}/credits`),
  ]);

  const live = invoices.items.filter((r) => r.status !== 'VOID');
  const owed = Number(live.reduce((t, r) => t + r.outstanding, 0).toFixed(2));
  const overdue = live.filter((r) => r.isOverdue);
  const overdueAmount = Number(overdue.reduce((t, r) => t + r.outstanding, 0).toFixed(2));
  const oldestOverdue = overdue.length ? Math.max(...overdue.map((r) => r.daysOverdue)) : 0;
  const billedTotal = Number(live.reduce((t, r) => t + r.netTotal, 0).toFixed(2));

  const back = el('a', { class: 'btn ghost', href: '#/franchises' }, '← รายชื่อร้าน');
  const viewAs = el('button', {
    class: 'btn ghost',
    title: 'ดูว่าร้านค้ารายนี้เห็นอะไรบ้าง',
    onclick: () => {
      session.setViewAs({ role: 'FRANCHISE', id: shop.id, username: shop.username });
      location.hash = '#/dashboard';
      render();
    },
  }, '👁 ดูมุมมองร้าน');

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, avatar(shop.username, { sub: shop.contactName ?? '' })),
        el('p', {}, [shop.phone, shop.email].filter(Boolean).join(' · ') || 'ยังไม่มีข้อมูลติดต่อ', ' · ', badge(shop.status))),
      el('div', { class: 'btn-row' }, back, viewAs)),

    el('div', { class: 'stat-grid' },
      stat('ค้างชำระทั้งหมด', money(owed) + ' ฿', `${int(live.filter((r) => r.outstanding > 0).length)} ใบ`,
        { tone: owed > 0 ? 'due' : 'income', icon: owed > 0 ? '⏳' : '✓' }),
      stat('เลยกำหนด', money(overdueAmount) + ' ฿',
        overdue.length ? `${int(overdue.length)} ใบ · นานสุด ${int(oldestOverdue)} วัน` : 'ไม่มี ✓',
        { tone: overdue.length ? 'warn' : 'income', icon: '⏰' }),
      stat('ได้รับเงินแล้วทั้งหมด', money(received.summary.total) + ' ฿', `จากที่เรียกเก็บ ${money(billedTotal)} ฿`,
        { tone: 'income', icon: '💰' }),
      stat('ยอดยกไปหักรอบหน้า', money(credits.summary.open) + ' ฿', 'เราติดค้างร้าน (คืนของมากกว่าขาย)',
        { tone: credits.summary.open > 0 ? 'sales' : 'muted', icon: '↩' })),

    card('บิลทุกรอบ', table([
      { label: 'รอบ', sortValue: (r) => r.periodCode, render: (r) => periodLabel(r.periodCode) },
      {
        label: 'เลขที่',
        sortValue: (r) => r.invoiceNo,
        render: (r) => el('a', { href: `#/invoices?period=all&invoice=${r.id}` }, r.invoiceNo),
      },
      { label: 'ยอดที่ต้องจ่าย', num: true, sortValue: (r) => r.netTotal, render: (r) => money(r.netTotal) },
      { label: 'ชำระแล้ว', num: true, sortValue: (r) => r.paid, render: (r) => money(r.paid) },
      {
        label: 'ค้าง',
        num: true,
        sortValue: (r) => r.outstanding,
        render: (r) => (r.outstanding ? el('strong', {}, money(r.outstanding)) : el('span', { class: 'muted' }, '—')),
      },
      {
        label: 'ครบกำหนด',
        sortValue: (r) => r.dueDate,
        render: (r) => el('div', {}, dateTh(r.dueDate),
          r.isOverdue ? el('div', { class: 'overdue-tag' }, `เลยกำหนด ${int(r.daysOverdue)} วัน`) : ''),
      },
      { label: 'สถานะ', sortValue: (r) => r.status, render: (r) => badge(r.status) },
    ], invoices.items, {
      rowClass: (r) => (r.isOverdue ? 'row-overdue' : ''),
      search: 'ค้นหาเลขที่บิลหรือรอบ…',
      empty: 'ยังไม่เคยออกบิลให้ร้านนี้',
    }), { tight: true }),

    el('div', { class: 'chart-row' },
      card('เงินที่ได้รับ', table([
        { label: 'วันที่', sortValue: (r) => r.paidAt, render: (r) => dateTh(r.paidAt) },
        { label: 'บิล', render: (r) => r.invoiceNo },
        { label: 'จำนวน', num: true, sortValue: (r) => r.amount, render: (r) => el('strong', { class: 'text-success' }, money(r.amount)) },
      ], received.items, { empty: 'ยังไม่มีเงินเข้า' }), { tight: true }),

      card('ยอดยกไปหักรอบหน้า', table([
        { label: 'จากบิล', render: (r) => r.sourceInvoiceNo ?? '—' },
        { label: 'ยอด', num: true, render: (r) => money(r.amount) },
        { label: 'เหลือ', num: true, render: (r) => money(r.remaining) },
        {
          label: 'สถานะ',
          render: (r) => el('span', { class: `badge ${r.status === 'OPEN' ? 'amber' : r.status === 'USED' ? 'green' : 'gray'}` },
            r.status === 'OPEN' ? 'รอหัก' : r.status === 'USED' ? 'หักครบแล้ว' : 'ยกเลิก'),
        },
      ], credits.items, { empty: 'ไม่มียอดยก' }), { tight: true })));
}
