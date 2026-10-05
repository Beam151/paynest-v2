import { api, qs, session } from '../api.js';
import { dateTh, card, delta, el, int, money, monthTh, pct, stat, table, totalCell } from '../ui.js';
import { monthOptions, periodLabel, periodOf, periodOptions, periodShort, shiftMonth, shiftPeriod, todayIso } from '../period.js';
import { render } from '../app.js';
import { viewState } from '../viewState.js';
import { barTrend } from '../charts.js';

const KEY = 'franchise.reportState';
const TABS = [
  { id: 'month', label: 'รายเดือน' },
  { id: 'period', label: 'รายรอบบิล' },
  { id: 'compare', label: 'เทียบเดือน / เทียบรอบ' },
  { id: 'range', label: 'เทียบช่วงวันที่เดียวกัน' },
];

function loadState() {
  const nowPeriod = periodOf();
  const nowMonth = nowPeriod.slice(0, 7);
  const defaults = {
    tab: 'month',
    fromMonth: shiftMonth(nowMonth, -5),
    toMonth: nowMonth,
    fromPeriod: shiftPeriod(nowPeriod, -5),
    toPeriod: nowPeriod,
    granularity: 'month',
    current: nowMonth,
    previous: shiftMonth(nowMonth, -1),
    currentPeriod: nowPeriod,
    previousPeriod: shiftPeriod(nowPeriod, -1),
    aStart: `${nowMonth}-01`,
    aEnd: todayIso(),
    against: 'prev_month',
    franchiseId: '',
  };
  try { return { ...defaults, ...JSON.parse(viewState.getItem(KEY) ?? '{}') }; } catch { return defaults; }
}

function saveState(patch) {
  viewState.setItem(KEY, JSON.stringify({ ...loadState(), ...patch }));
  render();
}

/** การ์ดส่วนต่าง — เขียว/แดงตามทิศทาง · ยอดดอลลาร์ไม่มีเครื่องหมาย (ลูกศรบอกทิศแล้ว เหมือนยอดบาท) */
const diffStat = (label, amount, growthPct, sub, usd) => stat(
  label,
  delta(amount, growthPct),
  sub,
  { tone: amount >= 0 ? 'income' : 'warn', icon: amount >= 0 ? '▲' : '▼', usd: Math.abs(usd ?? 0) },
);

/** แถวรวมท้ายตารางรายเดือน/รายรอบ — ยอดบาทพร้อมบรรทัดเทียบดอลลาร์ */
const totalFooter = (total) => ['รวมทั้งช่วง',
  totalCell(total.grossAmount, total.grossAmountUsd),
  totalCell(total.commissionAmount, total.commissionAmountUsd),
  totalCell(total.netAmount, total.netAmountUsd),
  '', int(total.entryCount)];

const TOTAL_COLUMNS = [
  { label: 'ยอดขายเต็ม', num: true, render: (r) => money(r.grossAmount) },
  { label: 'ส่วนต่างที่ต้องจ่าย', num: true, render: (r) => money(r.commissionAmount) },
  { label: 'เหลือของร้าน', num: true, render: (r) => money(r.netAmount) },
  { label: '% เฉลี่ย', num: true, render: (r) => pct(r.effectiveCommissionPct) },
  { label: 'รายการ', num: true, render: (r) => int(r.entryCount) },
];

export async function reportsView() {
  const state = loadState();
  const isSuper = session.isSuper;
  const franchises = isSuper ? (await api.get('/api/franchises')).items : [];
  const scope = { franchiseId: state.franchiseId };

  const tabs = el('div', { class: 'btn-row tabs' },
    ...TABS.map((t) => el('button', {
      class: `btn ${state.tab === t.id ? '' : 'ghost'}`,
      onclick: () => saveState({ tab: t.id }),
    }, t.label)));

  const franchisePicker = isSuper && el('div', { class: 'field' },
    el('label', {}, 'ร้านค้า'),
    el('select', { onchange: (e) => saveState({ franchiseId: e.target.value }) },
      el('option', { value: '', selected: state.franchiseId === '' }, 'ทุกร้าน'),
      ...franchises.map((f) => el('option', {
        value: String(f.id),
        selected: String(f.id) === state.franchiseId,
      }, f.username))));

  const body = state.tab === 'month' ? await monthTab(state, scope)
    : state.tab === 'period' ? await periodTab(state, scope)
      : state.tab === 'compare' ? await compareTab(state, scope)
        : await rangeTab(state, scope);

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'รายงานเปรียบเทียบ'),
        el('p', {}, 'เทียบได้ทั้งรายเดือน รายรอบบิลครึ่งเดือน และช่วงวันที่เดียวกันข้ามเดือน/ข้ามปี')),
      franchisePicker || ''),
    tabs,
    body);
}

/* ── รายเดือน (แยก H1/H2) ─────────────────────── */
async function monthTab(state, scope) {
  const data = await api.get(`/api/reports/by-month${qs({ from: state.fromMonth, to: state.toMonth, ...scope })}`);

  const rows = data.rows.flatMap((m) => [
    { ...m, _label: monthTh(m.bucket), _bold: true },
    ...m.halves.map((h) => ({ ...h, _label: `　${periodLabel(h.bucket)}`, _bold: false })),
  ]);

  return el('div', {},
    el('div', { class: 'filters', style: 'margin-bottom:16px' },
      monthField('ตั้งแต่เดือน', state.fromMonth, (v) => saveState({ fromMonth: v })),
      monthField('ถึงเดือน', state.toMonth, (v) => saveState({ toMonth: v }))),

    el('div', { class: 'stat-grid' },
      stat('ยอดขายเต็มรวม', money(data.total.grossAmount) + ' ฿', `${int(data.total.entryCount)} รายการ`,
        { tone: 'sales', icon: '🛒', usd: data.total.grossAmountUsd }),
      stat('ส่วนต่างรวม', money(data.total.commissionAmount) + ' ฿', null,
        { tone: 'income', icon: '💰', usd: data.total.commissionAmountUsd }),
      stat('% เฉลี่ยทั้งช่วง', pct(data.total.effectiveCommissionPct),
        null, { tone: 'muted', icon: '📊' })),

    card('แนวโน้มยอดขายรายเดือน',
      barTrend(data.rows.map((m) => ({
        label: monthTh(m.bucket),
        value: m.grossAmount,
        sub: m.commissionAmount ? `ส่วนต่าง ${money(m.commissionAmount)}` : null,
      })))),

    card('ยอดรายเดือน พร้อมแยกครึ่งเดือน',
      table([
        {
          label: 'ช่วงเวลา',
          render: (r) => (r._bold ? el('strong', {}, r._label) : el('span', { class: 'muted' }, r._label)),
        },
        ...TOTAL_COLUMNS,
      ], rows, { footer: totalFooter(data.total) }), { tight: true }));
}

/* ── รายรอบบิล ────────────────────────────────── */
async function periodTab(state, scope) {
  const data = await api.get(`/api/reports/by-period${qs({ from: state.fromPeriod, to: state.toPeriod, ...scope })}`);

  return el('div', {},
    el('div', { class: 'filters', style: 'margin-bottom:16px' },
      periodField('ตั้งแต่รอบ', state.fromPeriod, (v) => saveState({ fromPeriod: v })),
      periodField('ถึงรอบ', state.toPeriod, (v) => saveState({ toPeriod: v }))),

    el('div', { class: 'stat-grid' },
      stat('ยอดขายเต็มรวม', money(data.total.grossAmount) + ' ฿', null, { tone: 'sales', icon: '🛒', usd: data.total.grossAmountUsd }),
      stat('ส่วนต่างรวม', money(data.total.commissionAmount) + ' ฿', null,
        { tone: 'income', icon: '💰', usd: data.total.commissionAmountUsd }),
      stat('จำนวนรอบ', String(data.rows.length), `${int(data.total.entryCount)} รายการ`, { tone: 'muted', icon: '🗓' })),

    card('แนวโน้มยอดขายรายรอบบิล',
      barTrend(data.rows.map((r) => ({
        label: periodShort(r.bucket),
        value: r.grossAmount,
        sub: r.commissionAmount ? `ส่วนต่าง ${money(r.commissionAmount)}` : null,
      })))),

    card('ยอดรายรอบบิลครึ่งเดือน',
      table([
        {
          label: 'รอบบิล',
          render: (r) => el('strong', {}, periodLabel(r.bucket)),
        },
        ...TOTAL_COLUMNS,
      ], data.rows, { footer: totalFooter(data.total) }), { tight: true }));
}

/* ── เทียบเดือนต่อเดือน / รอบต่อรอบ ───────────── */
async function compareTab(state, scope) {
  const byPeriod = state.granularity === 'period';
  const current = byPeriod ? state.currentPeriod : state.current;
  const previous = byPeriod ? state.previousPeriod : state.previous;
  const data = await api.get(`/api/reports/compare${qs({ granularity: state.granularity, current, previous, ...scope })}`);

  const controls = el('div', { class: 'filters', style: 'margin-bottom:16px' },
    el('div', { class: 'field' },
      el('label', {}, 'เทียบแบบ'),
      el('select', { onchange: (e) => saveState({ granularity: e.target.value }) },
        el('option', { value: 'month', selected: !byPeriod }, 'รายเดือน'),
        el('option', { value: 'period', selected: byPeriod }, 'รายรอบบิล (ครึ่งเดือน)'))),
    byPeriod
      ? periodField('รอบปัจจุบัน', state.currentPeriod, (v) => saveState({ currentPeriod: v }))
      : monthField('เดือนปัจจุบัน', state.current, (v) => saveState({ current: v })),
    byPeriod
      ? periodField('เทียบกับรอบ', state.previousPeriod, (v) => saveState({ previousPeriod: v }))
      : monthField('เทียบกับเดือน', state.previous, (v) => saveState({ previous: v })));

  const label = (item) => (byPeriod ? `${item.key} · ${periodLabel(item.key)}` : monthTh(item.key));

  return el('div', {},
    controls,

    el('div', { class: 'stat-grid' },
      stat(`ยอดขาย ${label(data.current)}`, money(data.current.grossAmount) + ' ฿', `${int(data.current.entryCount)} รายการ`,
        { tone: 'sales', icon: '🛒', usd: data.current.grossAmountUsd }),
      stat(`ยอดขาย ${label(data.previous)}`, money(data.previous.grossAmount) + ' ฿', `${int(data.previous.entryCount)} รายการ`,
        { tone: 'muted', icon: '🕓', usd: data.previous.grossAmountUsd }),
      diffStat('เปลี่ยนแปลงยอดขาย', data.diff.grossAmount, data.diff.grossGrowthPct, 'เทียบกับช่วงก่อน', data.diff.grossAmountUsd),
      diffStat('เปลี่ยนแปลงส่วนต่าง', data.diff.commissionAmount, data.diff.commissionGrowthPct,
        `${data.diff.entryCount >= 0 ? '+' : ''}${int(data.diff.entryCount)} รายการ`, data.diff.commissionAmountUsd)),

    card('เทียบตัวเลขแบบเคียงกัน',
      table([
        { label: 'ตัวชี้วัด', render: (r) => r.metric },
        { label: label(data.current), num: true, render: (r) => r.a },
        { label: label(data.previous), num: true, render: (r) => r.b },
        { label: 'ส่วนต่าง', num: true, render: (r) => r.diff },
      ], [
        { metric: 'ยอดขายเต็ม', a: money(data.current.grossAmount), b: money(data.previous.grossAmount), diff: delta(data.diff.grossAmount, data.diff.grossGrowthPct) },
        { metric: 'ส่วนต่างที่ต้องจ่าย', a: money(data.current.commissionAmount), b: money(data.previous.commissionAmount), diff: delta(data.diff.commissionAmount, data.diff.commissionGrowthPct) },
        { metric: 'เหลือของร้าน', a: money(data.current.netAmount), b: money(data.previous.netAmount), diff: money(data.current.netAmount - data.previous.netAmount) },
        { metric: 'จำนวนรายการ', a: int(data.current.entryCount), b: int(data.previous.entryCount), diff: `${data.diff.entryCount >= 0 ? '+' : ''}${int(data.diff.entryCount)}` },
        { metric: 'สินค้าที่มียอด', a: int(data.current.productCount), b: int(data.previous.productCount), diff: `${data.current.productCount - data.previous.productCount >= 0 ? '+' : ''}${int(data.current.productCount - data.previous.productCount)}` },
      ]), { tight: true }),

    card('แยกตามรอบบิลย่อยในแต่ละช่วง',
      el('div', { style: 'display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))' },
        breakdownBlock(label(data.current), data.breakdown.current),
        breakdownBlock(label(data.previous), data.breakdown.previous))));
}

function breakdownBlock(title, rows) {
  return el('div', {},
    el('h3', { class: 'mb-8' }, title),
    table([
      { label: 'รอบบิล', key: 'bucket' },
      { label: 'ยอดเต็ม', num: true, render: (r) => money(r.grossAmount) },
      { label: 'ส่วนต่าง', num: true, render: (r) => money(r.commissionAmount) },
    ], rows, { empty: 'ไม่มียอดในช่วงนี้' }));
}

/* ── เทียบช่วงวันที่เดียวกัน ───────────────────── */
async function rangeTab(state, scope) {
  const data = await api.get(`/api/reports/compare-range${qs({
    aStart: state.aStart, aEnd: state.aEnd, against: state.against, ...scope,
  })}`);

  const controls = el('div', { class: 'filters', style: 'margin-bottom:16px' },
    el('div', { class: 'field' },
      el('label', {}, 'ตั้งแต่วันที่'),
      el('input', { type: 'date', value: state.aStart, onchange: (e) => saveState({ aStart: e.target.value }) })),
    el('div', { class: 'field' },
      el('label', {}, 'ถึงวันที่'),
      el('input', { type: 'date', value: state.aEnd, onchange: (e) => saveState({ aEnd: e.target.value }) })),
    el('div', { class: 'field' },
      el('label', {}, 'เทียบกับ'),
      el('select', { onchange: (e) => saveState({ against: e.target.value }) },
        ...[
          { value: 'prev_month', label: 'ช่วงวันเดียวกันของเดือนก่อน' },
          { value: 'prev_quarter', label: 'ช่วงวันเดียวกันของ 3 เดือนก่อน' },
          { value: 'prev_year', label: 'ช่วงวันเดียวกันของปีก่อน' },
        ].map((o) => el('option', { value: o.value, selected: o.value === state.against }, o.label)))));

  const warnings = data.warnings.length
    ? el('div', { class: 'error-box', style: 'background:var(--warn-soft);color:var(--warn)' },
      ...data.warnings.map((w) => el('div', {}, `⚠ ${w}`)),
      el('div', { style: 'margin-top:4px;font-size:12px' },
        'ยอดขายถูกเก็บเป็นรายรอบครึ่งเดือน จึงนับเฉพาะรอบที่อยู่ในช่วงแบบเต็มรอบ'))
    : '';

  const rangeText = (side) => `${dateTh(side.startDate)} – ${dateTh(side.endDate)}`;

  return el('div', {},
    controls,
    warnings,

    el('div', { class: 'stat-grid' },
      stat('ช่วง A (ที่เลือก)', money(data.current.grossAmount) + ' ฿', rangeText(data.current),
        { tone: 'sales', icon: 'A', usd: data.current.grossAmountUsd }),
      stat('ช่วง B (ที่เทียบ)', money(data.previous.grossAmount) + ' ฿', rangeText(data.previous),
        { tone: 'muted', icon: 'B', usd: data.previous.grossAmountUsd }),
      diffStat('เปลี่ยนแปลงยอดขาย', data.diff.grossAmount, data.diff.grossGrowthPct, 'A เทียบ B', data.diff.grossAmountUsd),
      diffStat('เปลี่ยนแปลงส่วนต่าง', data.diff.commissionAmount, data.diff.commissionGrowthPct, 'A เทียบ B', data.diff.commissionAmountUsd)),

    card('รายละเอียดสองช่วง',
      table([
        { label: 'ช่วง', render: (r) => el('div', {}, el('strong', {}, r.name), el('div', { class: 'sub-line' }, rangeText(r.data))) },
        { label: 'รอบบิลที่นับ', render: (r) => (r.data.periods.length ? r.data.periods.join(', ') : '—') },
        { label: 'ยอดขายเต็ม', num: true, render: (r) => money(r.data.grossAmount) },
        { label: 'ส่วนต่าง', num: true, render: (r) => money(r.data.commissionAmount) },
        { label: 'รายการ', num: true, render: (r) => int(r.data.entryCount) },
      ], [
        { name: 'ช่วง A', data: data.current },
        { name: 'ช่วง B', data: data.previous },
      ]), { tight: true }));
}

/* ── ตัวเลือกช่วงเวลา ─────────────────────────── */
function monthField(label, value, onChange) {
  return el('div', { class: 'field' },
    el('label', {}, label),
    el('select', { onchange: (e) => onChange(e.target.value) },
      ...monthOptions().map((o) => el('option', { value: o.value, selected: o.value === value }, o.label))));
}

function periodField(label, value, onChange) {
  return el('div', { class: 'field' },
    el('label', {}, label),
    el('select', { style: 'min-width:200px', onchange: (e) => onChange(e.target.value) },
      ...periodOptions().map((o) => el('option', { value: o.value, selected: o.value === value }, o.label))));
}
