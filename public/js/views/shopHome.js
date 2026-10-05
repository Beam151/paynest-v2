import { api, qs, session } from '../api.js';
import {
  alertBanner, badge, card, dateTh, el, icon, iconFor, infoModal, int, money, pct, periodBar, sumUsd, table, toast, usdNote, usdText,
} from '../ui.js';
import { barTrend, compact, donut, shareBar } from '../charts.js';
import { periodLabel, periodOptions, periodShort, setWorkingPeriod, shiftPeriod, todayIso, workingPeriod } from '../period.js';
import { hasPermission, render } from '../app.js';
import { activityButton } from './activity.js';
import { rejectedToRedo } from './payments.js';

/*
 * หน้าแรกของร้าน — ตอบคำถามของเจ้าของร้านตามลำดับที่เขาคิด
 *   1. "รอบนี้ร้านได้เท่าไร"          → ตัวเลขใหญ่บนสุด ไม่ใช่ยอดที่ต้องจ่าย
 *   2. "มีอะไรต้องทำไหม"              → สลิปตีกลับ / บิลใกล้ครบกำหนด / ขอบคุณเมื่อจ่ายแล้ว
 *   3. "ทางเรามีข่าวอะไร"             → กระดานประกาศ
 *   4. "ร้านเราไปทางไหน"              → แนวโน้ม 6 เดือน เทียบปีก่อน สินค้ามาแรง/ขาลง
 *   5. "บิลนี้มาจากไหน"               → บิลแบบอ่านเป็นประโยค
 * ระบบต้องให้อะไรกับร้านก่อนทวงเงิน ร้านถึงจะอยากเปิดเข้ามาดู
 */

const TREND_LENGTH = 12; // 12 รอบ = 6 เดือน พอเห็นฤดูกาลขายของร้าน

export async function shopHomeView() {
  const periodCode = workingPeriod();
  const prevCode = shiftPeriod(periodCode, -1);
  const lastYearCode = shiftPeriod(periodCode, -24);
  const canSeeBills = hasPermission('bills');
  const viewing = Boolean(session.viewAs);

  const [data, trend, lastYear, products, prevProducts, standing, invoices, news, onboarding, unpaid, mySubmissions] = await Promise.all([
    api.get(`/api/reports/dashboard${qs({ periodCode })}`),
    api.get(`/api/reports/by-period${qs({ from: shiftPeriod(periodCode, -(TREND_LENGTH - 1)), to: periodCode })}`).catch(() => ({ rows: [] })),
    api.get(`/api/reports/by-period${qs({ from: lastYearCode, to: lastYearCode })}`).then((r) => r.total).catch(() => null),
    api.get(`/api/reports/breakdown${qs({ from: periodCode, to: periodCode, groupBy: 'product' })}`).catch(() => ({ rows: [] })),
    api.get(`/api/reports/breakdown${qs({ from: prevCode, to: prevCode, groupBy: 'product' })}`).catch(() => ({ rows: [] })),
    api.get(`/api/reports/standing${qs({ periodCode })}`).catch(() => null),
    canSeeBills ? api.get(`/api/invoices${qs({ periodCode })}`).then((r) => r.items).catch(() => []) : Promise.resolve([]),
    api.get('/api/announcements').catch(() => ({ items: [] })),
    // เช็กลิสต์เป็นของผู้ใช้คนนั้น — ระหว่างดูมุมร้าน ของที่ได้จะเป็นของแอดมินเอง จึงไม่โชว์
    viewing ? Promise.resolve(null) : api.get('/api/auth/onboarding').catch(() => null),
    canSeeBills ? api.get('/api/payments/outstanding').then((r) => r.items).catch(() => null) : Promise.resolve(null),
    canSeeBills ? api.get('/api/payments').then((r) => r.items).catch(() => []) : Promise.resolve([]),
  ]);

  const periodPicker = el('select', {
    onchange: (e) => { setWorkingPeriod(e.target.value); render(); },
  }, ...periodOptions().map((o) => el('option', { value: o.value, selected: o.value === periodCode }, o.label)));

  const shopName = session.viewAs?.username ?? session.user?.franchiseUsername ?? '';

  return el('div', { class: 'shop-home' },
    el('div', { class: 'page-head' },
      el('div', {}, el('h1', {}, greeting()), el('p', {}, `ร้าน ${shopName} · ${periodLabel(periodCode)}`)),
      periodBar(periodPicker),
      el('div', { class: 'btn-row' }, activityButton(undefined, { title: 'ประวัติรายการ' }))),

    heroCard({ data, lastYear, standing, periodCode }),
    ...billBanners({ unpaid, mySubmissions, canSeeBills }),
    standing?.recentlyPaid && canSeeBills ? thanksCard(standing.recentlyPaid) : '',
    onboardingCard(onboarding),
    announcementsCard(news.items.filter((a) => a.state === 'ACTIVE'), { viewing }),

    // 12 แท่งแคบ — ป้ายแยกสองบรรทัดเท่ากันทุกแท่ง ("ต้น" / "ก.ย.") แท่งจึงเริ่มที่ฐานเดียวกัน
    card(`ยอดขายของร้าน ${TREND_LENGTH} รอบล่าสุด`,
      barTrend(trend.rows.map((r) => ({
        label: twoLine(periodShort(r.bucket)),
        value: r.grossAmount,
      })), { highlight: twoLine(periodShort(periodCode)) })),

    el('div', { class: 'chart-row' },
      card('สินค้าตัวไหนทำเงินให้ร้าน',
        donut(products.rows.map((r) => ({ label: r.bucket, sub: r.label, value: r.grossAmount })),
          { centerLabel: 'ยอดขายรวม (฿)' })),
      moversCard(products.rows, prevProducts.rows, prevCode)),

    canSeeBills ? billStoryCard(invoices.filter((r) => r.status !== 'VOID'), periodCode) : '');
}

const twoLine = (label) => label.replace(' ', '\n');

/** ทักตามช่วงเวลาของไทย — เล็ก ๆ แต่ทำให้หน้าแรกไม่เหมือนรายงานบัญชี */
function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' }).format(new Date()));
  const part = hour < 11 ? 'สวัสดีตอนเช้า' : hour < 16 ? 'สวัสดีตอนบ่าย' : hour < 19 ? 'สวัสดีตอนเย็น' : 'สวัสดีตอนค่ำ';
  const who = session.viewAs ? '' : (session.user?.displayName || session.user?.username || '');
  return `${part}${who ? ` คุณ${who}` : ''} 👋`;
}

const growth = (now, before) => (before > 0 ? ((now - before) / before) * 100 : null);

function trendChip(value, text) {
  if (value === null) return '';
  const up = value >= 0;
  return el('span', { class: `hero-chip ${up ? 'up' : 'down'}` },
    `${up ? '▲' : '▼'} ${pct(Math.abs(value))} ${text}`);
}

/**
 * ตัวเลขใหญ่ = เงินที่ร้านได้เก็บไว้ (ยอดขาย − ส่วนต่าง) ไม่ใช่ยอดที่ต้องจ่ายเรา
 * อันดับโชว์เฉพาะร้านที่อยู่ครึ่งบน — ร้านท้ายตารางเห็น "อันดับ 12 จาก 12" ทุกรอบมีแต่เสียกำลังใจ
 */
function heroCard({ data, lastYear, standing, periodCode }) {
  const cur = data.current;
  const hasSales = cur.grossAmount > 0;
  const rank = standing?.rank;
  const showRank = rank && rank.of >= 3 && rank.position <= Math.ceil(rank.of / 2);
  const streak = standing?.onTimeStreak ?? 0;

  return el('section', { class: 'shop-hero' },
    el('div', { class: 'shop-hero-main' },
      el('div', { class: 'shop-hero-label' }, `รอบ ${periodLabel(periodCode)} ร้านได้`),
      el('div', { class: 'shop-hero-value' }, hasSales ? money(cur.netAmount) : '—', hasSales ? el('small', {}, ' ฿') : ''),
      hasSales ? usdNote(cur.netAmountUsd) : '',
      el('div', { class: 'shop-hero-sub' }, hasSales
        ? `ขายได้ ${money(cur.grossAmount)} ฿ · หักส่วนต่าง ${money(cur.commissionAmount)} ฿ (${pct(cur.effectiveCommissionPct)})`
        : 'รอบนี้ยังไม่มียอดขาย — ยอดจะขึ้นเมื่อทางเราบันทึกยอดของรอบนี้'),
      el('div', { class: 'hero-chips' },
        hasSales ? trendChip(growth(cur.grossAmount, data.previousPeriod.grossAmount), 'จากรอบก่อน') : '',
        hasSales && lastYear ? trendChip(growth(cur.grossAmount, lastYear.grossAmount), 'จากช่วงเดียวกันปีก่อน') : '',
        showRank ? el('span', { class: 'hero-chip gold' }, `${rank.position <= 3 ? ['🥇', '🥈', '🥉'][rank.position - 1] : '🏆'} ยอดขายอันดับ ${int(rank.position)} จาก ${int(rank.of)} สาขา`) : '',
        streak >= 2 ? el('span', { class: 'hero-chip gold' }, `🔥 จ่ายตรงเวลา ${int(streak)} รอบติด`) : '')),
    el('div', { class: 'shop-hero-side' },
      heroFigure('ยอดขาย', cur.grossAmount, { usd: cur.grossAmountUsd }),
      heroFigure('ส่วนต่าง', cur.commissionAmount, { usd: cur.commissionAmountUsd }),
      heroFigure('สินค้าที่ขาย', cur.productCount, { unit: 'รายการ', format: int })));
}

// ตัวเลขข้างการ์ดใหญ่ — ต่ำกว่าล้านเขียนเต็ม (128,450 อ่านง่ายกว่า "1.3 แสน") เกินล้านค่อยย่อ
const heroAmount = (n) => (Math.abs(n) >= 1e6 ? compact(n) : int(Math.round(n)));
const heroFigure = (label, value, { unit = '฿', format = heroAmount, usd } = {}) => el('div', { class: 'shop-hero-fig' },
  el('span', {}, label), el('strong', {}, `${format(value)} ${unit}`, usdNote(usd)));

/**
 * สิ่งที่ต้องทำเรื่องบิล — เรียงจากเร่งที่สุด
 * ภาษาสุภาพ ไม่ใช่ภาษาทวงหนี้: ร้านคือลูกค้าของระบบ ไม่ใช่ลูกหนี้
 */
function billBanners({ unpaid, mySubmissions, canSeeBills }) {
  if (!canSeeBills || unpaid === null) return [];
  const toBills = () => { location.hash = '#/invoices'; };
  const open = unpaid.filter((r) => r.status !== 'VOID' && r.outstanding > 0);
  const overdue = open.filter((r) => r.isOverdue);
  const upcoming = open.filter((r) => !r.isOverdue).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const pending = mySubmissions.filter((s) => s.status === 'PENDING');
  const sum = (rows) => Number(rows.reduce((t, r) => t + r.outstanding, 0).toFixed(2));
  // ร้านที่จ่ายเป็น USD: ผลรวมนี้เท่ากับยอดดอลลาร์ที่ต้องโอนของทุกใบ (แต่ละใบใช้อัตราที่ตรึงไว้กับบิล)
  const owedUsd = (rows) => usdText(sumUsd(rows, (r) => r.outstanding));
  const daysLeft = (iso) => Math.round((Date.parse(iso) - Date.parse(todayIso())) / 86400000);

  const out = rejectedToRedo(mySubmissions, unpaid).slice(0, 3).map((sub) => alertBanner({
    title: `สลิป ${money(sub.amount)} ฿ ของบิล ${sub.invoiceNo} ต้องแก้ไขเล็กน้อย`,
    detail: `เหตุผล: ${sub.rejectReason ?? 'ไม่ได้ระบุ'} — แนบสลิปใหม่ได้ที่หน้าบิล`,
    actionLabel: 'แจ้งใหม่',
    onClick: toBills,
  }));

  if (overdue.length) {
    out.push(alertBanner({
      title: `บิลเลยกำหนด ${int(overdue.length)} ใบ รวม ${money(sum(overdue))} ฿${owedUsd(overdue)}`,
      detail: 'โอนแล้วแนบสลิปได้เลย ทางเราตรวจแล้วตัดยอดให้ทันที',
      actionLabel: 'ไปชำระ',
      onClick: toBills,
    }));
  }
  if (upcoming.length) {
    const next = upcoming[0];
    const left = daysLeft(next.dueDate);
    out.push(alertBanner({
      tone: 'warn',
      title: `ยอดที่ต้องชำระ ${money(sum(upcoming))} ฿${owedUsd(upcoming)} (${int(upcoming.length)} ใบ)`,
      detail: `ใบถัดไปครบกำหนด ${dateTh(next.dueDate)}${left === 0 ? ' — วันนี้' : left > 0 ? ` — อีก ${int(left)} วัน` : ''}`,
      actionLabel: 'ดูบิล',
      onClick: toBills,
    }));
  }
  if (pending.length) {
    out.push(el('div', { class: 'notice-box info-box' },
      iconFor('⏳'), ` สลิป ${int(pending.length)} ใบ (${money(pending.reduce((t, s) => t + s.amount, 0))} ฿) อยู่ระหว่างทางเราตรวจ — ตรวจเสร็จจะแจ้งให้ทราบ`));
  }
  if (!out.length) {
    out.push(el('div', { class: 'notice-box', style: 'background:var(--success-soft);color:var(--success)' },
      '✓ ไม่มียอดค้างชำระ ขอบคุณที่ชำระตรงเวลาครับ'));
  }
  return out;
}

/** ข้อความขอบคุณหลังทางเรายืนยันรับเงิน — ขึ้นอยู่ 7 วันแล้วหายเอง */
function thanksCard(paid) {
  return el('section', { class: 'thanks-card' },
    el('div', { class: 'thanks-emoji', 'aria-hidden': 'true' }, '🎉'),
    el('div', { class: 'thanks-text' },
      el('strong', {}, `ขอบคุณครับ ทางเราได้รับเงิน ${money(paid.amount)} ฿ แล้ว`),
      el('span', {}, `บิล ${paid.invoiceNo} · รอบ ${periodLabel(paid.periodCode)} · ชำระครบเมื่อ ${dateTh(paid.paidAt?.slice(0, 10))}`)),
    el('button', { class: 'btn sm', onclick: () => receiptModal(paid.invoiceId) }, icon('receipt'), ' ดูใบรับเงิน'));
}

/**
 * ใบรับเงิน — หลักฐานว่าทางเราได้รับเงินแล้ว สำหรับร้านเก็บไว้/แคปส่งต่อ
 * ใช้ได้ทั้งจากหน้าแรกและหน้าบิล
 */
export async function receiptModal(invoiceId) {
  const inv = await api.get(`/api/invoices/${invoiceId}`);
  const paidAll = inv.outstanding <= 0 && inv.status === 'PAID';
  infoModal({
    title: `ใบรับเงิน — ${inv.invoiceNo}`,
    width: 560,
    content: el('div', { class: 'receipt' },
      el('div', { class: 'receipt-head' },
        el('div', {},
          el('div', { class: 'receipt-shop' }, `ร้าน ${inv.franchiseUsername}`),
          el('div', { class: 'sub-line' }, `บิล ${inv.invoiceNo} · รอบ ${periodLabel(inv.periodCode)}`)),
        el('span', { class: `receipt-stamp${paidAll ? '' : ' partial'}` }, paidAll ? 'ได้รับครบแล้ว' : 'ได้รับบางส่วน')),
      table([
        { label: 'วันที่รับ', render: (p) => dateTh(p.paidAt?.slice(0, 10)) },
        { label: 'ช่องทาง', render: (p) => el('div', {}, p.method ?? 'โอนเงิน', p.reference ? el('div', { class: 'sub-line' }, `อ้างอิง ${p.reference}`) : '') },
        { label: 'จำนวน', num: true, render: (p) => money(p.amount) },
      ], inv.payments, { sortable: false, empty: 'ยังไม่มีรายการรับเงิน', footer: ['รวมที่ได้รับ', '', money(inv.paid)] }),
      el('div', { class: 'receipt-foot' },
        el('div', {}, el('span', { class: 'muted' }, 'ยอดบิล '), el('strong', {}, `${money(inv.netTotal)} ฿`)),
        el('div', {}, el('span', { class: 'muted' }, 'คงเหลือ '), el('strong', {}, `${money(Math.max(0, inv.outstanding))} ฿`))),
      el('p', { class: 'sub-line', style: 'margin:14px 0 0;text-align:center' },
        'ทางเราได้รับเงินตามรายการข้างต้นเรียบร้อยแล้ว ขอบคุณครับ')),
  });
}

/** เช็กลิสต์เริ่มต้นใช้งาน — ทำครบหรือกดซ่อนแล้วไม่ขึ้นอีก */
function onboardingCard(ob) {
  if (!ob || ob.complete || ob.dismissed || !ob.total) return '';
  const progress = Math.round((ob.done / ob.total) * 100);
  return card(`เริ่มต้นใช้งาน (${int(ob.done)}/${int(ob.total)})`,
    el('div', {},
      el('div', { class: 'ob-progress' }, el('span', { style: `width:${progress}%` })),
      el('ol', { class: 'ob-steps' },
        ...ob.steps.map((s) => el('li', { class: s.done ? 'done' : '' },
          el('span', { class: 'ob-check', 'aria-hidden': 'true' }, s.done ? icon('check') : ''),
          el('span', { class: 'ob-text' }, el('strong', {}, s.label), el('span', { class: 'sub-line' }, s.hint)),
          s.done ? el('span', { class: 'sub-line' }, 'เรียบร้อย') : el('a', { class: 'btn ghost sm', href: s.href }, 'ไปทำ →'))))),
    {
      actions: el('button', {
        class: 'btn ghost sm',
        onclick: async () => {
          await api.post('/api/auth/onboarding', { dismissed: true });
          toast('ซ่อนแล้ว — กลับมาดูขั้นตอนได้ที่หน้าบัญชีของฉัน', 'success');
          render();
        },
      }, 'ซ่อน'),
    });
}

const CATEGORY_ICON = { NEWS: '📣', PROMO: '🏷️', PRODUCT: '📦', HOLIDAY: '📅' };

/**
 * ประกาศจากทางเรา — ยังไม่อ่านมีจุดสีฟ้า กดเปิดอ่านแล้วนับว่าอ่าน
 * โชว์ 3 เรื่องแรก (ปักหมุดขึ้นก่อน) ที่เหลือพับไว้
 */
function announcementsCard(items, { viewing }) {
  if (!items.length) return '';
  const unread = items.filter((a) => !a.read).length;
  const SHOW = 3;

  const row = (a) => {
    const item = el('details', { class: `ann-item${a.read ? '' : ' unread'}` },
      el('summary', {},
        el('span', { class: 'ann-ico', 'aria-hidden': 'true' }, iconFor(CATEGORY_ICON[a.category] ?? '📣')),
        el('span', { class: 'ann-head' },
          el('strong', {}, a.pinned ? '📌 ' : '', a.title),
          el('span', { class: 'sub-line' }, `${a.categoryLabel} · ${dateTh(a.startsAt)}${a.endsAt ? ` ถึง ${dateTh(a.endsAt)}` : ''}`))),
      el('div', { class: 'ann-body' }, a.body));
    item.addEventListener('toggle', () => {
      if (!item.open || a.read || viewing) return;
      a.read = true;
      item.classList.remove('unread');
      api.post(`/api/announcements/${a.id}/read`, {}).catch(() => {});
    });
    return item;
  };

  const rest = items.slice(SHOW);
  const more = rest.length ? el('div', { class: 'ann-more', hidden: true }, ...rest.map(row)) : '';
  return card(unread ? `ประกาศจากทางเรา · ใหม่ ${int(unread)}` : 'ประกาศจากทางเรา',
    el('div', { class: 'ann-list' },
      ...items.slice(0, SHOW).map(row),
      more,
      rest.length ? el('button', {
        class: 'btn ghost sm mt-8',
        onclick: (e) => { more.hidden = false; e.currentTarget.remove(); },
      }, `ดูอีก ${int(rest.length)} เรื่อง`) : ''));
}

/**
 * สินค้ามาแรง / ขาลง — เทียบกับรอบก่อนทีละตัว
 * บอกร้านว่าควรสั่งตัวไหนเพิ่ม ตัวไหนควรดูสาเหตุ ซึ่งตัวเลขรวมบอกไม่ได้
 */
function moversCard(current, previous, prevCode) {
  const before = new Map(previous.map((r) => [r.bucket, r]));
  const now = new Map(current.map((r) => [r.bucket, r]));
  const keys = new Set([...before.keys(), ...now.keys()]);
  const moves = [...keys].map((k) => {
    const a = now.get(k)?.grossAmount ?? 0;
    const b = before.get(k)?.grossAmount ?? 0;
    return { sku: k, name: (now.get(k) ?? before.get(k)).label, now: a, before: b, diff: Number((a - b).toFixed(2)) };
  });
  const up = moves.filter((m) => m.diff > 0).sort((x, y) => y.diff - x.diff).slice(0, 3);
  const down = moves.filter((m) => m.diff < 0).sort((x, y) => x.diff - y.diff).slice(0, 3);

  if (!previous.length || (!up.length && !down.length)) {
    return card('สินค้ามาแรง / ขาลง', el('div', { class: 'empty' },
      iconFor('📈'), el('div', {}, `ต้องมียอดของรอบ ${periodLabel(prevCode)} ด้วยถึงจะเทียบได้`)));
  }

  const max = Math.max(...[...up, ...down].map((m) => Math.abs(m.diff)), 1);
  const list = (rows, tone) => rows.map((m) => el('div', { class: 'mover' },
    el('div', { class: 'mover-name' }, el('strong', {}, m.sku), el('span', { class: 'sub-line' }, m.name)),
    el('div', { class: `mover-diff ${tone}` },
      `${m.diff > 0 ? '▲' : '▼'} ${money(Math.abs(m.diff))}`,
      el('span', { class: 'sub-line' }, m.before ? pct(Math.abs(growth(m.now, m.before))) : 'ตัวใหม่')),
    el('div', { class: 'mover-bar' }, shareBar(Math.abs(m.diff), max, {
      color: tone === 'up' ? 'var(--success)' : 'var(--danger)',
      format: () => '',
    }))));

  return card(`สินค้ามาแรง / ขาลง (เทียบรอบ ${periodLabel(prevCode)})`,
    el('div', { class: 'movers' },
      up.length ? el('div', {}, el('h3', { class: 'mover-title up' }, '🚀 ขายดีขึ้น'), ...list(up, 'up')) : '',
      down.length ? el('div', {}, el('h3', { class: 'mover-title down' }, '🔻 ขายลดลง'), ...list(down, 'down')) : ''));
}

/**
 * บิลแบบอ่านเป็นประโยค — ร้านไม่ต้องรู้ศัพท์บัญชี
 * "ขายได้ → หักส่วนต่าง → บวกค่าใช้จ่าย → หักส่วนลด = ยอดที่โอนให้ทางเรา"
 */
function billStoryCard(bills, periodCode) {
  if (!bills.length) {
    return card('บิลของรอบนี้', el('div', { class: 'empty' },
      iconFor('🧾'),
      el('div', {}, `รอบ ${periodLabel(periodCode)} ทางเรายังไม่ได้ออกบิล`),
      el('div', { class: 'sub-line' }, 'ออกบิลแล้วจะแจ้งให้ทราบ พร้อมรายละเอียดว่ายอดมาจากสินค้าอะไรบ้าง')));
  }
  return card('บิลของรอบนี้ อ่านง่าย ๆ', el('div', { class: 'story-list' }, ...bills.map((b) => {
    /*
     * ค่าคอมเซลที่หักในบิล (ร้านจ่ายให้เซลเอง) นับอยู่ใน discountTotal — แยกออกมาเป็นบรรทัดของมันเอง
     * ไม่ใช่ "ส่วนลดจากทางเรา" และไม่ใช่เงินที่ร้านเก็บไว้ (ร้านต้องจ่ายต่อให้เซล)
     */
    const toSales = b.salesDeductionTotal ?? 0;
    const discount = Number((b.discountTotal - toSales).toFixed(2));
    const steps = [
      { label: 'ร้านขายได้', amount: b.grossTotal, tone: 'muted' },
      { label: `ส่วนต่างของทางเรา (${pct(b.grossTotal ? (b.commissionTotal / b.grossTotal) * 100 : 0)})`, amount: b.commissionTotal, sign: '' },
      b.chargeTotal ? { label: 'ค่าใช้จ่ายอื่น', amount: b.chargeTotal, sign: '+' } : null,
      discount ? { label: 'ส่วนลดจากทางเรา', amount: discount, sign: '−', tone: 'good' } : null,
      toSales ? { label: 'หักค่าคอมเซล (ร้านจ่ายให้เซลเอง)', amount: toSales, sign: '−' } : null,
      b.creditApplied ? { label: 'หักยอดยกมาจากรอบก่อน', amount: b.creditApplied, sign: '−', tone: 'good' } : null,
    ].filter(Boolean);
    return el('div', { class: 'story' },
      el('div', { class: 'story-head' },
        el('strong', {}, b.invoiceNo), badge(b.status),
        el('span', { class: 'sub-line' }, `ครบกำหนด ${dateTh(b.dueDate)}`)),
      el('div', { class: 'story-lines' },
        ...steps.map((s) => el('div', { class: `story-line ${s.tone ?? ''}` },
          el('span', {}, s.label), el('span', {}, `${s.sign ?? ''}${money(s.amount)} ฿`))),
        el('div', { class: 'story-line total' },
          el('span', {}, 'ยอดที่โอนให้ทางเรา'), el('strong', {}, `${money(b.netTotal)} ฿`)),
        toSales ? el('div', { class: 'story-line' },
          el('span', {}, 'จ่ายค่าคอมให้เซลเอง'), el('span', {}, `${money(toSales)} ฿`)) : '',
        el('div', { class: 'story-line keep' },
          el('span', {}, 'ร้านเก็บไว้'), el('strong', {}, `${money(Math.max(0, b.grossTotal - b.netTotal - toSales))} ฿`))),
      el('div', { class: 'story-foot' },
        b.outstanding > 0
          ? el('span', {}, `ชำระแล้ว ${money(b.paid)} ฿ · คงเหลือ `, el('strong', {}, `${money(b.outstanding)} ฿`))
          : el('span', { class: 'text-success' }, '✓ ชำระครบแล้ว'),
        el('span', { class: 'btn-row' },
          b.paid > 0 ? el('button', { class: 'btn ghost sm', onclick: () => receiptModal(b.id) }, 'ใบรับเงิน') : '',
          el('a', { class: 'btn ghost sm', href: `#/invoices?invoice=${b.id}&period=all` }, 'ดูรายการสินค้า →'))));
  })), { actions: el('a', { class: 'btn ghost sm', href: '#/invoices' }, 'บิลทั้งหมด →') });
}
