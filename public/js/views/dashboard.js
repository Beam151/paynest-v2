import { api, qs, session } from '../api.js';
import { badge, card, dateTh, delta, el, iconFor, int, money, pct, periodBar, stat, table, totalCell, usdText } from '../ui.js';
import { avatar, barTrend, colorFor, donut, gauge, shareBar } from '../charts.js';
import { periodLabel, periodOptions, periodShort, setWorkingPeriod, shiftPeriod, workingPeriod } from '../period.js';
import { render } from '../app.js';
import { activityButton } from './activity.js';
import { shopHomeView } from './shopHome.js';

const TREND_LENGTH = 6; // ย้อนหลัง 6 รอบ = 3 เดือน กำลังพอดีกับความกว้างจอ

export async function dashboardView() {
  // ร้านค้าถามคนละคำถามกับส่วนกลางโดยสิ้นเชิง — แยกเป็นหน้าของตัวเอง (shopHome.js)
  if (!session.isSuper) return shopHomeView();

  const periodCode = workingPeriod();
  const trendFrom = shiftPeriod(periodCode, -(TREND_LENGTH - 1));

  const [data, byFranchise, byProduct, invoices, trend, ledger] = await Promise.all([
    api.get(`/api/reports/dashboard${qs({ periodCode })}`),
    api.get(`/api/reports/breakdown${qs({ from: periodCode, to: periodCode, groupBy: 'franchise' })}`),
    api.get(`/api/reports/breakdown${qs({ from: periodCode, to: periodCode, groupBy: 'product' })}`)
      .catch(() => ({ rows: [] })),
    api.get(`/api/invoices${qs({ periodCode })}`).catch(() => ({ items: [] })),
    api.get(`/api/reports/by-period${qs({ from: trendFrom, to: periodCode })}`).catch(() => ({ rows: [] })),
    api.get(`/api/ledger${qs({ periodCode })}`),
  ]);

  const periodPicker = el('select', {
    onchange: (e) => { setWorkingPeriod(e.target.value); render(); },
  }, ...periodOptions().map((o) => el('option', { value: o.value, selected: o.value === periodCode }, o.label)));

  const d = data.diff;

  /*
   * อัตราเก็บเงิน = จ่ายแล้วกี่ % ของที่ออกบิลไปทั้งหมด (ไม่ใช่แค่ของรอบนี้)
   * ไม่นับบิลที่ยกเลิก — บิลยกเลิกมียอดค้าง 0 จึงเคยถูกนับเป็น "เก็บได้แล้ว" ทั้งใบ ตัวเลขสูงเกินจริง
   */
  const liveBills = invoices.items.filter((i) => i.status !== 'VOID');
  const billed = liveBills.reduce((s, i) => s + i.netTotal, 0);
  const collected = liveBills.reduce((s, i) => s + i.paid, 0);
  const collectRate = billed > 0 ? (collected / billed) * 100 : 0;

  const avgPct = data.current.effectiveCommissionPct;

  const head = (title, sub) => el('div', { class: 'page-head' },
    el('div', {}, el('h1', {}, title), el('p', {}, sub)),
    periodBar(periodPicker),
    el('div', { class: 'btn-row' },
      activityButton(undefined, { title: 'ประวัติรายการ' })));

  const trendCard = (title) => card(title,
    barTrend(
      trend.rows.map((r) => ({
        label: periodShort(r.bucket),
        value: r.grossAmount,
        sub: r.commissionAmount ? `ส่วนต่าง ${money(r.commissionAmount)}` : null,
      })),
      { highlight: periodShort(periodCode) }));

  const compareCard = card(`เทียบกับรอบก่อนหน้า (${data.previousPeriod.key})`,
    el('div', { class: 'stat-grid m-0' },
      stat('ยอดขายรอบนี้', money(data.current.grossAmount) + ' ฿', null, { tone: 'sales', usd: data.current.grossAmountUsd }),
      stat('ยอดขายรอบก่อน', money(data.previousPeriod.grossAmount) + ' ฿', null,
        { tone: 'muted', usd: data.previousPeriod.grossAmountUsd }),
      // ลูกศรบอกทิศแล้ว — ยอดดอลลาร์ของส่วนต่างจึงไม่มีเครื่องหมาย เหมือนยอดบาทใน delta()
      stat('เปลี่ยนแปลงยอดขาย', delta(d.grossAmount, d.grossGrowthPct), 'เทียบรอบครึ่งเดือนก่อน',
        { tone: d.grossAmount >= 0 ? 'income' : 'warn', icon: d.grossAmount >= 0 ? '▲' : '▼', usd: Math.abs(d.grossAmountUsd ?? 0) }),
      stat('เปลี่ยนแปลงส่วนต่าง', delta(d.commissionAmount, d.commissionGrowthPct),
        `${d.entryCount >= 0 ? '+' : ''}${int(d.entryCount)} รายการ`,
        {
          tone: d.commissionAmount >= 0 ? 'income' : 'warn',
          icon: d.commissionAmount >= 0 ? '▲' : '▼',
          usd: Math.abs(d.commissionAmountUsd ?? 0),
        })));

  /* ── ภาพรวมของส่วนกลาง ──────────────────────────────────────
   * บนสุดคือ "ต้องทำอะไรวันนี้" — กดแล้วไปถึงงานนั้นเลย
   * กราฟวิเคราะห์ย้ายลงล่าง (เดิม 9 บล็อก ส่วนใหญ่เป็นกราฟ แต่ไม่บอกว่าต้องทำอะไร)
   */
  const [readiness, unpaidAll] = await Promise.all([
    api.get(`/api/invoices/readiness${qs({ periodCode })}`).catch(() => null),
    api.get('/api/payments/outstanding').then((r) => r.items).catch(() => []),
  ]);

  const overdue = unpaidAll.filter((r) => r.isOverdue);
  const overdueByShop = [...overdue.reduce((m, r) => {
    const cur = m.get(r.franchiseUsername) ?? { amount: 0, days: 0 };
    m.set(r.franchiseUsername, { amount: cur.amount + r.outstanding, days: Math.max(cur.days, r.daysOverdue) });
    return m;
  }, new Map())].sort((a, b) => b[1].amount - a[1].amount);
  const namesOf = (status) => (readiness?.items ?? []).filter((r) => r.status === status).map((r) => r.username);
  const noSales = namesOf('NO_SALES');
  const listNames = (names) => (names.length > 4 ? `${names.slice(0, 4).join(', ')} และอีก ${names.length - 4} ร้าน` : names.join(', '));

  const tiles = [
    data.pendingPayments.count > 0 && todoTile({
      tone: 'warn', icon: '👀',
      title: `ตรวจสลิป ${int(data.pendingPayments.count)} ใบ`,
      detail: `รวม ${money(data.pendingPayments.amount)} ฿${usdText(data.pendingPayments.amountUsd)} — ยอดจะตัดออกจากบิลเมื่อยืนยันรับเงิน`,
      href: '#/invoices?tab=slips&period=all',
    }),
    overdue.length > 0 && todoTile({
      tone: 'danger', icon: '⏰',
      title: `ทวงบิลเลยกำหนด ${int(overdueByShop.length)} ร้าน`,
      detail: overdueByShop.slice(0, 3).map(([name, x]) => `${name} ${money(x.amount)} ฿ (${int(x.days)} วัน)`).join(' · ')
        + (overdueByShop.length > 3 ? ` · และอีก ${overdueByShop.length - 3} ร้าน` : ''),
      href: '#/invoices?tab=bills&status=OVERDUE&period=all',
    }),
    noSales.length > 0 && todoTile({
      tone: 'due', icon: '📝',
      title: `กรอกยอดขาย ${int(noSales.length)} ร้าน`,
      detail: `รอบ ${periodLabel(periodCode)}: ${listNames(noSales)}`,
      href: '#/sales',
    }),
    readiness?.summary.ready > 0 && todoTile({
      tone: 'sales', icon: '🧾',
      title: `ออกบิล ${int(readiness.summary.ready)} ร้าน`,
      detail: `รอบ ${periodLabel(periodCode)}: ${listNames(namesOf('READY'))} — ติ๊กแล้วออกทีเดียวได้`,
      href: '#/invoices?tab=ready',
    }),
    readiness?.summary.addedLater > 0 && todoTile({
      tone: 'sales', icon: '➕',
      title: `ยอดใหม่ยังไม่เข้าบิล ${int(readiness.summary.addedLater)} ร้าน`,
      detail: 'กรอกยอดเพิ่มหลังออกบิลไปแล้ว — เพิ่มเข้าบิลเดิมก่อนร้านจ่าย',
      href: '#/invoices?tab=ready',
    }),
  ].filter(Boolean);

  return el('div', {},
    head('ภาพรวมรอบบิล', `${periodLabel(periodCode)} · ทุกร้าน`),

    card('ต้องทำวันนี้', tiles.length
      ? el('div', { class: 'todo-grid' }, ...tiles)
      : el('div', { class: 'notice-box', style: 'margin:0;background:var(--success-soft);color:var(--success)' },
        `✓ ไม่มีงานค้าง — รอบ ${periodLabel(periodCode)} ออกบิลครบ ไม่มีสลิปรอตรวจ และไม่มีบิลเลยกำหนด`)),

    el('div', { class: 'stat-grid' },
      stat('ยอดขายเต็มรอบนี้', money(data.current.grossAmount) + ' ฿',
        `${int(data.current.entryCount)} รายการ · ${int(data.current.productCount)} สินค้า`,
        { tone: 'sales', icon: '🛒', usd: data.current.grossAmountUsd }),
      stat('ส่วนต่างที่เรียกเก็บ', money(data.current.commissionAmount) + ' ฿',
        avgPct === null ? 'ยังไม่มียอด' : `เฉลี่ย ${pct(avgPct)} ของยอดเต็ม`,
        { tone: 'income', icon: '💰', usd: data.current.commissionAmountUsd }),
      // ยอดค้างเป็นของทุกรอบ ไม่ใช่รอบนี้ — บอกไว้บนการ์ดเลย ไม่งั้นดูเหมือนตัวเลขของรอบที่เลือก
      stat('ร้านยังไม่จ่าย (ทุกรอบ)', money(data.outstanding.amount) + ' ฿',
        `${int(data.outstanding.invoices)} ใบเรียกเก็บ`, { tone: 'due', icon: '⏳', usd: data.outstanding.amountUsd }),
      stat('เหลือเป็นของร้าน', money(data.current.netAmount) + ' ฿', 'ยอดเต็มหักส่วนต่างแล้ว',
        { tone: 'muted', icon: '🏪', usd: data.current.netAmountUsd })),

    card('ใบเรียกเก็บของรอบนี้',
      table([
        { label: 'เลขที่', key: 'invoiceNo' },
        { label: 'ร้านค้า', render: (r) => r.franchiseUsername },
        { label: 'ส่วนต่าง', num: true, render: (r) => money(r.commissionTotal) },
        adjustmentColumn,
        { label: 'ยอดที่ต้องจ่าย', num: true, render: (r) => el('strong', {}, money(r.netTotal)) },
        { label: 'ค้างชำระ', num: true, render: (r) => money(r.outstanding) },
        { label: 'สถานะ', render: (r) => badge(r.status), sortValue: (r) => r.status },
      ], invoices.items, { empty: 'ยังไม่ได้ออกใบเรียกเก็บของรอบนี้' }), {
        tight: true,
        actions: el('a', { class: 'btn ghost sm', href: '#/invoices' }, 'ไปหน้าบิล →'),
      }),
    card('ยอดแยกตามร้านในรอบนี้', franchiseTable(byFranchise), { tight: true }),

    // ── ส่วนวิเคราะห์ ──
    el('div', { class: 'chart-row' },
      card(null, el('div', { class: 'gauge-pair' },
        gauge({
          value: billed > 0 ? collectRate : null,
          label: 'เก็บเงินได้แล้ว',
          tone: collectRate >= 80 ? 'income' : collectRate >= 40 ? 'due' : 'warn',
          sub: billed > 0
            ? el('span', {}, el('strong', {}, money(collected)), ` จาก ${money(billed)} ฿`)
            : 'รอบนี้ยังไม่ได้ออกใบเรียกเก็บ',
          caption: billed > 0 ? `${int(liveBills.length)} ใบเรียกเก็บในรอบนี้` : 'ออกบิลแล้วตัวเลขจะขึ้นที่นี่',
        }),
        gauge({
          value: avgPct,
          label: 'ส่วนต่างเฉลี่ย',
          tone: 'sales',
          sub: avgPct === null
            ? 'รอบนี้ยังไม่มียอด'
            : el('span', {}, el('strong', {}, money(data.current.commissionAmount)), ` จากยอดเต็ม ${money(data.current.grossAmount)} ฿`),
          caption: 'คิดจากยอดที่บันทึกไว้จริงในรอบนี้',
        })), { tight: true }),

      card('สัดส่วนยอดขายแยกตามร้าน',
        donut(byFranchise.rows.map((r) => ({ label: r.bucket, sub: r.label, value: r.grossAmount })),
          { centerLabel: 'ยอดขายรวม (฿)' }))),

    trendCard(`แนวโน้ม ${TREND_LENGTH} รอบล่าสุด`),
    compareCard,
    card('สินค้าขายดีในรอบนี้', topProductTable(data.topProducts), { tight: true }),
    ledgerCard(ledger, periodCode));
}

/** คอลัมน์ค่าใช้จ่าย/ส่วนลด — เลี่ยง "+0.00 / −0.00" ที่อ่านแล้วต้องหยุดคิดว่าแปลว่าอะไร */
const adjustmentColumn = {
  label: 'ค่าใช้จ่าย/ส่วนลด',
  num: true,
  sortValue: (r) => r.chargeTotal - r.discountTotal,
  render: (r) => (r.chargeTotal || r.discountTotal
    ? [r.chargeTotal ? `+${money(r.chargeTotal)}` : null,
      r.discountTotal ? `−${money(r.discountTotal)}` : null].filter(Boolean).join(' / ')
    : el('span', { class: 'muted' }, '—')),
};

/**
 * รายรับ-รายจ่ายของส่วนกลางในรอบนี้ — ปิดท้ายภาพรวมด้วยคำถามที่เจ้าของกิจการถามจริง
 * "รอบนี้เก็บเงินมาได้เท่าไร หักค่าใช้จ่ายของเราแล้วเหลือเท่าไร"
 *
 * ใช้ "เก็บได้จริง" ไม่ใช่ "ยอดที่เรียกเก็บ" — เงินที่ร้านยังไม่จ่ายยังไม่ใช่เงินของเรา
 */
function ledgerCard(ledger, periodCode) {
  const s = ledger.summary;
  const top = ledger.items.slice(0, 5);

  return card('รายรับ-รายจ่ายของเราในรอบนี้',
    el('div', {},
      el('div', { class: 'stat-grid m-0' },
        stat('เก็บเงินได้จริง', money(s.collected) + ' ฿', `จากที่เรียกเก็บไป ${money(s.billed)} ฿${usdText(s.billedUsd)}`,
          { tone: 'sales', icon: '🏦', usd: s.collectedUsd }),
        stat('รายรับอื่น', money(s.income) + ' ฿', 'เงินเข้าที่ไม่ได้มาจากบิล', { tone: 'income', icon: '➕', usd: s.incomeUsd }),
        stat('รายจ่ายของเรา', money(s.expense) + ' ฿', `${int(ledger.items.filter((i) => i.kind === 'EXPENSE').length)} รายการ`,
          { tone: s.expense > 0 ? 'warn' : 'muted', icon: '➖', usd: s.expenseUsd }),
        stat('เหลือจริงในรอบนี้', money(s.net) + ' ฿', 'เก็บได้จริง + รายรับอื่น − รายจ่าย',
          { tone: s.net >= 0 ? 'income' : 'warn', icon: s.net >= 0 ? '✓' : '⚠', usd: s.netUsd })),

      top.length
        ? el('div', { class: 'mt-14' },
          table([
            {
              label: 'รายการ',
              render: (r) => el('div', {},
                el('strong', {}, r.label),
                el('div', { class: 'sub-line' }, r.note ?? r.kindLabel)),
            },
            {
              label: 'จำนวน',
              num: true,
              render: (r) => el('strong', { style: `color:var(--${r.kind === 'INCOME' ? 'success' : 'danger'})` },
                `${r.kind === 'INCOME' ? '+' : '−'}${money(r.amount)}`),
            },
            { label: 'วันที่', render: (r) => (r.spentOn ? dateTh(r.spentOn) : el('span', { class: 'muted' }, 'ทั้งรอบ')) },
          ], top, { sortable: false }),
          el('div', { class: 'sub-line mt-8' },
            ledger.items.length > top.length ? `แสดง ${top.length} จาก ${int(ledger.items.length)} รายการ · ` : '',
            el('a', { href: '#/ledger' }, 'ดู/แก้ไขทั้งหมด →')))
        : el('div', { class: 'empty mt-14' },
          el('div', {}, `รอบ ${periodLabel(periodCode)} ยังไม่ได้บันทึกค่าใช้จ่ายของเรา`),
          el('div', { class: 'mt-6' },
            el('a', { href: '#/ledger' }, 'ไปบันทึกรายการ →')))));
}

/** ตารางร้าน — ใส่แถบสัดส่วนให้เทียบขนาดกันได้ด้วยตา ไม่ต้องอ่านเลขทีละตัว */
function franchiseTable(breakdown) {
  const rows = breakdown.rows;
  const max = Math.max(...rows.map((r) => r.grossAmount), 0);

  return table([
    {
      label: 'ร้านค้า',
      render: (r) => avatar(r.bucket, { sub: r.label }),
      sortValue: (r) => r.bucket,
    },
    { label: 'สินค้า', num: true, render: (r) => int(r.productCount) },
    {
      label: 'ยอดเต็ม',
      num: true,
      sortValue: (r) => r.grossAmount,
      render: (r) => shareBar(r.grossAmount, max, { color: colorFor(r.bucket) }),
    },
    { label: 'ส่วนต่าง', num: true, render: (r) => money(r.commissionAmount), sortValue: (r) => r.commissionAmount },
    { label: '% เฉลี่ย', num: true, render: (r) => pct(r.effectiveCommissionPct), sortValue: (r) => r.effectiveCommissionPct },
  ], rows, {
    empty: 'รอบนี้ยังไม่มีร้านไหนกรอกยอด',
    search: 'ค้นหาร้าน…',
    footer: rows.length
      ? ['รวม', int(breakdown.total.productCount),
        totalCell(breakdown.total.grossAmount, breakdown.total.grossAmountUsd),
        totalCell(breakdown.total.commissionAmount, breakdown.total.commissionAmountUsd), '']
      : undefined,
  });
}

/** สินค้าขายดี — ติดเหรียญอันดับให้สามอันดับแรก */
function topProductTable(rows) {
  const max = Math.max(...rows.map((r) => r.grossAmount), 0);
  const MEDALS = ['🥇', '🥈', '🥉'];

  return table([
    {
      label: 'อันดับ',
      sortable: false,
      render: (r) => el('span', { class: 'rank' }, MEDALS[rows.indexOf(r)] ?? `${rows.indexOf(r) + 1}`),
    },
    {
      label: 'สินค้า',
      render: (r) => el('div', {}, el('strong', {}, r.bucket), el('div', { class: 'sub-line' }, r.label)),
      sortValue: (r) => r.bucket,
    },
    {
      label: 'ยอดเต็ม',
      num: true,
      sortValue: (r) => r.grossAmount,
      render: (r) => shareBar(r.grossAmount, max, { color: colorFor(r.bucket) }),
    },
    { label: 'ส่วนต่าง', num: true, render: (r) => money(r.commissionAmount), sortValue: (r) => r.commissionAmount },
  ], rows, { empty: 'รอบนี้ยังไม่มีการกรอกยอด' });
}

/** ช่อง "ต้องทำวันนี้" — ทั้งช่องเป็นลิงก์ไปที่งานนั้น */
function todoTile({ tone, icon, title, detail, href }) {
  return el('a', { class: `todo-tile tone-${tone}`, href },
    el('span', { class: 'todo-ico' }, iconFor(icon)),
    el('span', { class: 'todo-text' },
      el('strong', {}, title),
      el('span', { class: 'sub-line' }, detail)),
    el('span', { class: 'todo-go', 'aria-hidden': 'true' }, '→'));
}
