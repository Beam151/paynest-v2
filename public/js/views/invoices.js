import { api, qs, session } from '../api.js';
import {
  alertBanner, badge, card, confirmAction, dateTh, el, field, flashRows, formModal, infoModal,
  int, money, pct, periodBar, stat, table, toast,
} from '../ui.js';
import { periodLabel, periodOf, periodOptions, setWorkingPeriod, storedWorkingPeriod, workingPeriod } from '../period.js';
import {
  bankAccountBox, breakdownTable, currencyTag, payCenterView, payMoney, paymentTotals,
  receivedMoneyTab, slipReviewTab, slipStatusPicker, usdLine,
} from './payments.js';
import { hashParam, render } from '../app.js';
import { activityButton } from './activity.js';
import { usdRateChip } from './periodRate.js';
import { viewState } from '../viewState.js';
import { avatar } from '../charts.js';
import { receiptModal } from './shopHome.js';

const FILTER_KEY = 'franchise.invoicePeriod';
const STATUS_KEY = 'franchise.invoiceStatus';
const SUPER_TAB_KEY = 'franchise.superBillTab';
const SHOP_TAB_KEY = 'franchise.shopBillTab';
// ใช้คีย์เดียวกับตัวกรองในแท็บสลิป (ประกาศไว้ใน payments.js) เพื่อตั้งค่าให้ก่อนสลับแท็บ
const PAY_STATUS_KEY = 'franchise.paySubStatus';

/* ตัวกรองสถานะ — "เลยกำหนด" ไม่ใช่สถานะในฐานข้อมูล แต่เป็นเงื่อนไขที่คนถามหาบ่อยสุด */
const STATUS_FILTERS = [
  { value: '', label: 'ทุกสถานะ', match: () => true },
  { value: 'OPEN', label: 'ค้างชำระ', match: (r) => r.status === 'OPEN' },
  { value: 'PARTIAL', label: 'ชำระบางส่วน', match: (r) => r.status === 'PARTIAL' },
  { value: 'PAID', label: 'ชำระครบ', match: (r) => r.status === 'PAID' },
  { value: 'OVERDUE', label: 'เลยกำหนด', match: (r) => r.isOverdue },
  { value: 'VOID', label: 'ยกเลิก', match: (r) => r.status === 'VOID' },
];

/**
 * บิลที่ส่งให้ร้านไปแล้วไม่ควรแก้ตัวเลขได้ตามใจ
 * ปลดล็อกเฉพาะตอนที่ยังไม่มีใครแตะเงิน: ยังไม่มีเงินเข้า และไม่มีสลิปรอตรวจ
 * ถ้าเลยจุดนั้นไปแล้วต้องยกเลิกใบเดิมแล้วออกใหม่ ร้านจะได้เห็นเลขที่ใบใหม่ว่าเปลี่ยนแล้ว
 */
const canEditInvoice = (inv) => inv.status === 'OPEN' && inv.paid === 0 && !inv.pendingSubmissions;

/** ยกเลิกได้ตราบใดที่ยังไม่มีเงินเข้า (เงินเข้าแล้วต้องคืนเงินก่อน ระบบยังไม่รองรับ) */
const canVoidInvoice = (inv) => inv.status !== 'VOID' && inv.paid === 0;

const lockReason = (inv) => {
  if (inv.status === 'VOID') return 'ใบนี้ถูกยกเลิกไปแล้ว แก้ไขไม่ได้';
  if (inv.paid > 0) return `ร้านจ่ายมาแล้ว ${money(inv.paid)} ฿ — แก้ยอดไม่ได้ ถ้าตัวเลขผิดต้องยกเลิกใบนี้แล้วออกใหม่`;
  if (inv.pendingSubmissions) return 'มีสลิปรอตรวจสอบอยู่ — ตรวจให้เสร็จก่อน หรือให้ร้านยกเลิกการแจ้งก่อนจึงจะแก้ได้';
  return 'ใบนี้แก้ไขไม่ได้';
};

export async function invoicesView() {
  const isSuper = session.isSuper;
  const statusFilter = viewState.getItem(STATUS_KEY) ?? hashParam('status') ?? '';

  /*
   * ดึงทุกรอบมาครั้งเดียวแล้วกรองฝั่งเบราว์เซอร์
   * จำเป็น เพราะแถบเตือน "เลยกำหนดชำระ" ต้องนับจากทุกรอบเสมอ
   * ถ้าให้เซิร์ฟเวอร์กรองตามรอบมาให้ พอเลือกดูรอบล่าสุดแล้วบิลเก่าที่ยังค้างจะเงียบหายไป
   */
  const [res, franchises, chargeItems, bankAccounts] = await Promise.all([
    api.get('/api/invoices'),
    isSuper ? api.get('/api/franchises').then((r) => r.items) : Promise.resolve([]),
    api.get('/api/charge-items').then((r) => r.items),
    // บัญชีที่เปิดใช้อยู่ ไว้ให้เลือกตอนออกบิลว่าให้ร้านโอนเข้าอันไหน
    isSuper ? api.get('/api/bank-accounts?status=ACTIVE').then((r) => r.items) : Promise.resolve([]),
  ]);
  const allInvoices = res.items;

  /*
   * ตั้งต้นที่รอบล่าสุดที่มีบิลจริง ไม่ใช่ "ทุกรอบ"
   * งานประจำวันเกิดที่รอบปัจจุบัน ส่วนรอบเก่าเปิดดูตอนต้องการเท่านั้น
   * (ยังเลือก "ทุกรอบบิล" เองได้ และแถบเตือนบิลค้างก็ยังนับข้ามรอบให้อยู่)
   */
  // ข้ามใบที่ยกเลิก ไม่งั้นรอบที่มีแต่ใบยกเลิกจะถูกเลือกเป็นค่าตั้งต้น แล้วเปิดมาเจอตารางว่าง
  const latestPeriod = allInvoices
    .filter((i) => i.status !== 'VOID')
    .map((i) => i.periodCode)
    .sort()
    .at(-1) ?? '';
  // ร้านไม่มีแถบเลือกรอบ — แท็บ "บิลทั้งหมด" จึงเห็นทุกรอบเสมอ
  const periodFilter = !isSuper ? (viewState.getItem(FILTER_KEY) ?? '')
    : viewState.getItem(FILTER_KEY) ?? (hashParam('period') === 'all' ? '' : null) ?? storedWorkingPeriod() ?? latestPeriod;

  // ตัวเลขเงินของส่วนกลางผูกกับรอบที่เลือก ป้ายบนแท็บจะได้ตรงกับที่เห็นจริงเมื่อกดเข้าไป
  const totals = isSuper ? await paymentTotals(periodFilter) : null;

  /*
   * ข้อมูลรอบที่เลือก ใช้โชว์/แก้อัตราแลกเปลี่ยนตรงแถบรอบบิล
   * เลือก "ทุกรอบบิล" อยู่จะไม่มีรอบเดียวให้ตั้งอัตรา จึงข้ามไป
   */
  const period = isSuper && periodFilter ? await api.get(`/api/periods/${periodFilter}`) : null;

  /*
   * อัตราของทุกรอบ ไว้ให้ฟอร์มออกบิลรู้ว่ารอบที่เลือกอยู่ตั้งอัตราไว้หรือยัง
   * (ถ้ายัง จะให้เลือกสกุลดอลลาร์ไม่ได้ เพราะแปลงไม่ออก)
   */
  const periodRates = new Map(
    isSuper
      ? (await api.get('/api/periods?limit=48')).items.map((x) => [x.code, x.usdRate])
      : [],
  );

  /** รอบบิล -> รายการ id ของร้านที่ออกบิลรอบนั้นไปแล้ว (ไม่นับใบที่ยกเลิก) */
  const invoicedByPeriod = new Map();
  for (const inv of allInvoices) {
    if (inv.status === 'VOID') continue;
    if (!invoicedByPeriod.has(inv.periodCode)) invoicedByPeriod.set(inv.periodCode, []);
    invoicedByPeriod.get(inv.periodCode).push(inv.franchiseId);
  }

  const chargeOptions = [
    { value: '', label: '— พิมพ์รายการเอง —' },
    ...chargeItems.map((c) => ({
      value: String(c.id),
      label: `${c.kindLabel}: ${c.name}${c.defaultPct !== null ? ` (${c.defaultPct}%)` : c.defaultAmount !== null ? ` (${money(c.defaultAmount)}฿)` : ''}`,
    })),
  ];

  /**
   * ฟอร์มเพิ่มค่าใช้จ่าย/ส่วนลด — เลือกจากรายการตั้งต้น หรือพิมพ์เองก็ได้
   * เลือกรายการตั้งต้นแล้วช่อง "ประเภท/ชื่อรายการ" จะหายไป เพราะได้มาจากรายการนั้นอยู่แล้ว
   */
  const typedByHand = (v) => !v.chargeItemId;

  const adjustmentModal = (invoice) => formModal({
    title: `เพิ่มค่าใช้จ่าย / ส่วนลด — ${invoice.invoiceNo}`,
    submitLabel: 'เพิ่มเข้าบิล',
    fields: [
      {
        name: 'chargeItemId',
        label: 'เลือกจากรายการตั้งต้น',
        type: 'select',
        options: chargeOptions,
        hint: 'เลือก "— พิมพ์รายการเอง —" ถ้าอยากตั้งชื่อรายการใหม่',
      },
      {
        name: 'kind',
        label: 'ประเภท',
        type: 'select',
        showWhen: typedByHand,
        options: [
          { value: 'CHARGE', label: 'ค่าใช้จ่าย (บวกเพิ่ม)' },
          { value: 'DISCOUNT', label: 'ส่วนลด (หักออก)' },
        ],
      },
      { name: 'label', label: 'ชื่อรายการ', showWhen: typedByHand, required: true },
      { name: 'amount', label: 'จำนวนเงิน (บาท)', type: 'number', step: '0.01' },
      { name: 'pct', label: 'หรือคิดเป็น % ของส่วนต่าง', type: 'number', step: '0.01', hint: `ส่วนต่างรอบนี้ ${money(invoice.commissionTotal)} ฿` },
      { name: 'note', label: 'หมายเหตุ' },
    ],
    onSubmit: async (v) => {
      await api.post(`/api/invoices/${invoice.id}/adjustments`, {
        ...v,
        chargeItemId: v.chargeItemId ? Number(v.chargeItemId) : undefined,
        kind: v.chargeItemId ? undefined : v.kind,
      });
      toast('เพิ่มรายการแล้ว ยอดที่ต้องจ่ายคำนวณใหม่ให้อัตโนมัติ', 'success');
      render();
    },
  });

  // กรองฝั่งเบราว์เซอร์ เพราะ "เลยกำหนด" คิดจากวันที่ ไม่ใช่คอลัมน์สถานะในฐานข้อมูล
  // แท็บ "ที่ต้องจ่าย" ใช้หน้าชำระเงินเดิมทั้งดุ้น (ฟอร์มแนบสลิป + ประวัติการแจ้ง)
  // ร้านค้าเห็นหน้าเดียวจบ: บิลที่ต้องจ่าย + ประวัติการชำระ (ซึ่งย้อนดูบิลเก่าได้ครบอยู่แล้ว)
  /*
   * ร้าน: "ที่ต้องจ่าย" (หน้าจ่ายเงิน) กับ "บิลทั้งหมด" (ย้อนดูทุกรอบ)
   * เดิมร้านเห็นแค่บิลที่ค้าง บิลที่ปิดด้วยยอดยกมา/บิล 0 บาท/บิลที่จ่ายแล้วหาไม่เจอเลย
   */
  const shopTab = isSuper ? null : (viewState.getItem(SHOP_TAB_KEY) ?? 'pay');
  const payCenter = isSuper || shopTab !== 'pay' ? '' : await payCenterView({ embedded: true });

  /*
   * ฝั่งส่วนกลางรวมสามงานของบิลใบเดียวกันไว้ที่นี่
   *   bills    ออกบิล / แก้บิล / ยกเลิก / ดูบิล
   *   slips    ตรวจสลิปที่ร้านแจ้งเข้ามาแล้วกดรับเงิน
   *   received เงินที่ตัดยอดไปแล้วจริง
   * เดิมแยกเป็นเมนู "ใบเรียกเก็บ" กับ "รายการชำระบิล" ซึ่งลิสต์บิลชุดเดียวกัน
   * ทำให้ต้องเด้งไปมาสองเมนูเพื่อจัดการบิลใบเดียว
   */
  const superTab = isSuper ? (viewState.getItem(SUPER_TAB_KEY) ?? hashParam('tab') ?? 'bills') : null;

  /*
   * ร้านไหนพร้อมออกบิล / ออกแล้ว / ยังไม่กรอกยอด — ต้องเป็นรอบเจาะจง
   * ถ้าเลือก "ทุกรอบ" ไว้ ใช้รอบที่กำลังทำงานแทน (ใช้ทั้งตัวเลขบนแท็บและเนื้อหาแท็บ)
   */
  const readyPeriod = periodFilter || workingPeriod();
  const readiness = isSuper ? await api.get(`/api/invoices/readiness${qs({ periodCode: readyPeriod })}`) : null;

  const superTabBody = superTab === 'slips' ? await slipReviewTab(periodFilter)
    : superTab === 'received' ? await receivedMoneyTab(periodFilter)
      : superTab === 'ready' ? readyTab(readiness)
        : null;

  /** สลับแท็บแล้วพาไปหาแถวที่ต้องการ (render เป็น async ต้องรอให้ตารางขึ้นก่อน) */
  const jumpToTab = async (tabId, selector, extra) => {
    viewState.setItem(SUPER_TAB_KEY, tabId);
    if (extra) extra();
    await render();
    if (selector) flashRows(selector);
  };

  /**
   * แท็บ "พร้อมออกบิล" — เห็นทุกร้านของรอบเดียวในตารางเดียว ติ๊กหลายร้านแล้วออกทีเดียว
   * เดิมต้องเปิดฟอร์มทีละร้าน และไม่มีอะไรเตือนถ้าลืมร้านไหนไป
   */
  function readyTab(data) {
    const READY_LABEL = {
      NO_SALES: ['gray', 'ยังไม่กรอกยอด'],
      READY: ['amber', 'พร้อมออกบิล'],
      INVOICED: ['green', 'ออกบิลแล้ว'],
    };
    const readyRows = data.items.filter((r) => r.status === 'READY');
    const chosen = new Set(readyRows.map((r) => r.franchiseId));
    const dueDate = el('input', { type: 'date' });
    const issue = el('button', { class: 'btn' });
    const summary = el('span', { class: 'sub-line' });

    const sync = () => {
      const picked = readyRows.filter((r) => chosen.has(r.franchiseId));
      const total = Number(picked.reduce((t, r) => t + r.pendingCommission, 0).toFixed(2));
      issue.textContent = `ออกบิล ${picked.length} ร้านที่เลือก`;
      issue.disabled = picked.length === 0;
      summary.textContent = picked.length ? `ส่วนต่างรวม ${money(total)} ฿ · ใช้บัญชีหลัก สกุลบาท` : 'ยังไม่ได้เลือกร้าน';
    };

    issue.addEventListener('click', () => {
      const ids = [...chosen];
      return confirmAction(`ออกบิลรอบ ${periodLabel(data.periodCode)} ให้ ${ids.length} ร้าน?`, async () => {
        const res = await api.post('/api/invoices/generate-bulk', {
          periodCode: data.periodCode,
          franchiseIds: ids,
          ...(dueDate.value ? { dueDate: dueDate.value } : {}),
        });
        if (res.errors.length) {
          toast(`ออกแล้ว ${res.created.length} ร้าน · ไม่ผ่าน ${res.errors.length}: ${res.errors.map((x) => `${x.username} (${x.message})`).join(', ')}`, 'error');
        } else {
          toast(`ออกบิลแล้ว ${res.created.length} ร้าน`, 'success');
        }
        render();
      });
    });

    const toggleAll = el('input', { type: 'checkbox', checked: readyRows.length > 0, style: 'width:auto' });
    const boxes = [];
    toggleAll.addEventListener('change', () => {
      for (const [id, box] of boxes) {
        box.checked = toggleAll.checked;
        if (toggleAll.checked) chosen.add(id); else chosen.delete(id);
      }
      sync();
    });
    sync();

    const goSales = () => { setWorkingPeriod(data.periodCode); location.hash = '#/sales'; };

    return el('div', {},
      el('div', { class: 'toolbar' },
        el('h2', { class: 'section-title' },
          `รอบ ${periodLabel(data.periodCode)} — พร้อมออกบิล ${int(data.summary.ready)} · ออกแล้ว ${int(data.summary.invoiced)}`
            + ` · ยังไม่กรอกยอด ${int(data.summary.noSales)}`)),
      !periodFilter
        ? el('div', { class: 'notice-box' }, `ตัวกรองเป็น "ทุกรอบ" — แสดงรอบที่กำลังทำงาน (${periodLabel(data.periodCode)}) · เลือกรอบอื่นได้ที่แถบรอบบิลด้านบน`)
        : '',
      card(null, table([
        {
          label: readyRows.length ? toggleAll : '',
          sortable: false,
          render: (r) => {
            if (r.status !== 'READY') return '';
            const box = el('input', { type: 'checkbox', checked: chosen.has(r.franchiseId), style: 'width:auto' });
            boxes.push([r.franchiseId, box]);
            box.addEventListener('change', () => {
              if (box.checked) chosen.add(r.franchiseId); else chosen.delete(r.franchiseId);
              toggleAll.checked = chosen.size === readyRows.length;
              sync();
            });
            return box;
          },
        },
        { label: 'ร้านค้า', sortValue: (r) => r.username, render: (r) => avatar(r.username, { sub: '' }) },
        {
          label: 'สถานะ',
          sortValue: (r) => r.status,
          render: (r) => {
            const [tone, text] = READY_LABEL[r.status];
            return el('div', {},
              el('span', { class: `badge ${tone}` }, text),
              r.addedLater ? el('div', { class: 'sub-line' }, `มียอดใหม่ ${int(r.pendingEntries)} รายการ ยังไม่ได้เพิ่มเข้าบิล`) : '');
          },
        },
        { label: 'รายการรอออกบิล', num: true, sortValue: (r) => r.pendingEntries, render: (r) => (r.pendingEntries ? int(r.pendingEntries) : '—') },
        {
          label: 'ส่วนต่างที่จะเรียกเก็บ',
          num: true,
          sortValue: (r) => r.pendingCommission,
          render: (r) => (r.status === 'INVOICED' && !r.addedLater
            ? el('span', { class: 'muted' }, `${r.invoiceNo} · ${money(r.invoiceNetTotal)}`)
            : r.pendingEntries ? el('strong', {}, money(r.pendingCommission)) : '—'),
        },
        {
          label: '',
          sortable: false,
          render: (r) => (r.status === 'NO_SALES'
            ? el('button', { class: 'btn ghost sm', onclick: goSales }, 'ไปกรอกยอด →')
            : r.addedLater
              ? el('button', {
                class: 'btn ghost sm',
                onclick: () => jumpToTab('bills', `[data-row-key="inv-${r.invoiceId}"]`),
              }, 'ไปเพิ่มเข้าบิล →')
              : ''),
        },
      ], data.items, {
        rowKey: (r) => `ready-${r.franchiseId}`,
        empty: `รอบ ${periodLabel(data.periodCode)} ยังไม่มีร้านที่มีสินค้าต้องขาย`,
      }), { tight: true }),
      readyRows.length
        ? el('div', { class: 'card mt-12' },
          el('div', { class: 'card-body' },
            el('div', { class: 'form-grid', style: 'align-items:end' },
              field('ครบกำหนดชำระ (ไม่ใส่ = 7 วันหลังจบรอบ)', dueDate),
              el('div', { style: 'display:grid;gap:4px' }, issue, summary)),
            el('div', { class: 'sub-line mt-8' },
              'ร้านที่ต้องใส่ส่วนลด/ค่าใช้จ่ายเฉพาะ — ออกไปก่อนแล้วกด "แก้ไขบิล" ทีหลังได้ ตราบใดที่ร้านยังไม่จ่าย')))
        : '');
  }

  const matchStatus = (STATUS_FILTERS.find((o) => o.value === statusFilter) ?? STATUS_FILTERS[0]).match;
  const visibleInvoices = allInvoices
    .filter((r) => !periodFilter || r.periodCode === periodFilter)
    .filter(matchStatus);

  // นับจากทุกใบที่โหลดมา ไม่ใช่แค่ใบที่ตัวกรองโชว์อยู่ — บิลเลยกำหนดต้องเตือนเสมอ
  const overdueInvoices = allInvoices.filter((r) => r.isOverdue);
  const overdueTotal = overdueInvoices.reduce((sum, r) => sum + r.outstanding, 0);

  /*
   * ใบที่ยกเลิกไม่นับรวมเป็นเงิน แต่ยังแสดงในตาราง
   * จึงต้องนับ "จำนวนใบ" แบบไม่รวมใบที่ยกเลิกด้วย ไม่งั้นจะเจอ 1 ใบ แต่ยอดรวม 0.00
   */
  const active = visibleInvoices.filter((r) => r.status !== 'VOID');
  const voided = visibleInvoices.length - active.length;
  const shown = {
    count: active.length,
    voided,
    netTotal: Number(active.reduce((sum, r) => sum + r.netTotal, 0).toFixed(2)),
    outstanding: Number(active.reduce((sum, r) => sum + r.outstanding, 0).toFixed(2)),
    overdueCount: active.filter((r) => r.isOverdue).length,
  };

  const statusPicker = el('select', {
    onchange: (e) => { viewState.setItem(STATUS_KEY, e.target.value); render(); },
  }, ...STATUS_FILTERS.map((o) => el('option', { value: o.value, selected: o.value === statusFilter }, o.label)));

  const periodPicker = el('select', {
    onchange: (e) => { viewState.setItem(FILTER_KEY, e.target.value); setWorkingPeriod(e.target.value); render(); },
  },
  el('option', { value: '', selected: periodFilter === '' }, 'ทุกรอบบิล'),
  ...periodOptions().map((o) => el('option', { value: o.value, selected: o.value === periodFilter }, o.label)));

  const generateModal = () => {
    // เก็บสถานะการติ๊กไว้นอกฟอร์ม เพราะ preview ถูกสร้างใหม่ทุกครั้งที่เปลี่ยนร้านค้า/รอบ
    let available = [];
    let selected = new Set();
    const adjustments = []; // ค่าใช้จ่าย/ส่วนลดที่จะติดไปกับบิลตั้งแต่ตอนออก

    // สร้างครั้งเดียวแล้วย้ายไปมา เพื่อไม่ให้สิ่งที่ผู้ใช้กรอกหายตอน preview วาดใหม่
    const adjBox = el('div');
    const totalLine = el('div', { class: 'notice-box', style: 'margin:10px 0 0' });

    const commissionOfSelected = () => available
      .filter((e) => selected.has(e.id))
      .reduce((s, e) => s + e.commissionAmount, 0);

    const itemById = (id) => chargeItems.find((c) => String(c.id) === String(id));

    /** จำนวนเงินจริงของแถวหนึ่ง — กรอกเองมาก่อน ถ้าเว้นว่างค่อยใช้ค่าตั้งต้นของรายการ */
    const amountOf = (a, commission) => {
      if (a.pct !== '' && a.pct !== undefined) return Math.round(commission * Number(a.pct)) / 100;
      if (a.amount !== '' && a.amount !== undefined) return Number(a.amount) || 0;
      const item = itemById(a.chargeItemId);
      if (!item) return 0;
      if (item.defaultPct !== null) return Math.round(commission * item.defaultPct) / 100;
      return item.defaultAmount ?? 0;
    };

    const kindOf = (a) => itemById(a.chargeItemId)?.kind ?? a.kind ?? 'CHARGE';
    const labelOfAdj = (a) => itemById(a.chargeItemId)?.name ?? (a.label || 'ยังไม่ได้ตั้งชื่อ');

    function refreshTotals() {
      const commission = commissionOfSelected();
      let charge = 0;
      let discount = 0;
      for (const a of adjustments) {
        const amt = amountOf(a, commission);
        if (kindOf(a) === 'DISCOUNT') discount += amt; else charge += amt;
      }
      const net = commission + charge - discount;
      totalLine.replaceChildren(
        el('strong', {}, `ยอดที่ลูกค้าต้องจ่าย ${money(net)} ฿`),
        el('div', { class: 'sub-line' },
          `ส่วนต่าง ${money(commission)} + ค่าใช้จ่าย ${money(charge)} − ส่วนลด ${money(discount)}`));
      totalLine.style.display = net < 0 ? '' : '';
    }

    function drawAdjustments() {
      const commission = commissionOfSelected();

      const rows = adjustments.map((a, i) => {
        const preset = el('select', { style: 'min-width:190px' },
          ...chargeOptions.map((o) => el('option', { value: o.value, selected: o.value === (a.chargeItemId ?? '') }, o.label)));
        preset.addEventListener('change', () => { a.chargeItemId = preset.value; drawAdjustments(); });

        const custom = !a.chargeItemId;

        const kindSel = el('select', { style: 'min-width:130px' },
          ...[{ value: 'CHARGE', label: 'ค่าใช้จ่าย (+)' }, { value: 'DISCOUNT', label: 'ส่วนลด (−)' }]
            .map((o) => el('option', { value: o.value, selected: o.value === (a.kind ?? 'CHARGE') }, o.label)));
        kindSel.addEventListener('change', () => { a.kind = kindSel.value; refreshRow(); });

        const nameBox = el('input', { type: 'text', placeholder: 'ชื่อรายการ', value: a.label ?? '', style: 'min-width:150px' });
        nameBox.addEventListener('input', () => { a.label = nameBox.value; });

        const amountBox = el('input', { type: 'number', step: '0.01', placeholder: 'บาท', value: a.amount ?? '', style: 'width:110px' });
        const pctBox = el('input', { type: 'number', step: '0.01', placeholder: '% ของส่วนต่าง', value: a.pct ?? '', style: 'width:130px' });
        const amountLabel = el('span', { class: 'adj-amount' });

        /**
         * อัปเดตเฉพาะตัวเลขของแถวนี้ ไม่วาดทั้งบล็อกใหม่
         * (ถ้าวาดใหม่ทุกครั้งที่กดแป้น ช่องที่กำลังพิมพ์จะถูกสร้างใหม่ เคอร์เซอร์หลุด พิมพ์ต่อไม่ได้)
         */
        const refreshRow = () => {
          const computed = amountOf(a, commissionOfSelected());
          amountLabel.textContent = kindOf(a) === 'DISCOUNT' ? `−${money(computed)}` : `+${money(computed)}`;
          refreshTotals();
        };

        // กรอกจำนวนเงินกับ % พร้อมกันไม่ได้ — กรอกช่องไหนให้ล้างอีกช่องทิ้ง
        amountBox.addEventListener('input', () => {
          a.amount = amountBox.value;
          a.pct = '';
          pctBox.value = '';
          refreshRow();
        });
        pctBox.addEventListener('input', () => {
          a.pct = pctBox.value;
          a.amount = '';
          amountBox.value = '';
          refreshRow();
        });

        const computed = amountOf(a, commission);
        amountLabel.textContent = kindOf(a) === 'DISCOUNT' ? `−${money(computed)}` : `+${money(computed)}`;

        return el('div', { class: 'adj-row' },
          preset,
          custom ? kindSel : '',
          custom ? nameBox : '',
          amountBox,
          el('span', { class: 'muted', style: 'font-size:12px' }, 'หรือ'),
          pctBox,
          amountLabel,
          el('button', {
            class: 'btn ghost sm danger',
            type: 'button',
            onclick: () => { adjustments.splice(i, 1); drawAdjustments(); },
          }, 'ลบ'));
      });

      /*
       * ทำเป็นกล่องแยกมีกรอบ ไม่ใช่ต่อท้ายตารางสินค้าเฉย ๆ
       * เพราะเป็นคนละขั้นตอนกัน (เลือกสินค้า -> บวก/ลบรายการอื่น) แล้วเดิมกลืนไปกับตาราง
       * จนหาไม่เจอว่าจะใส่ส่วนลดตรงไหน
       */
      adjBox.replaceChildren(el('div', { class: 'adj-block' },
        el('div', { class: 'adj-block-head' },
          el('div', {},
            el('h3', {}, '➕➖ ค่าใช้จ่ายอื่น / ส่วนลด'),
            el('div', { class: 'sub-line' }, 'บวกเพิ่มหรือหักออกจากส่วนต่าง ใส่ได้หลายรายการ')),
          el('button', {
            class: 'btn sm',
            type: 'button',
            onclick: () => { adjustments.push({ chargeItemId: '', kind: 'CHARGE', label: '', amount: '', pct: '' }); drawAdjustments(); },
          }, '+ เพิ่มรายการ')),
        rows.length
          ? el('div', {}, ...rows)
          : el('div', { class: 'sub-line' }, 'ยังไม่มี — กด "+ เพิ่มรายการ" เพื่อใส่ค่าใช้จ่ายหรือส่วนลดในบิลนี้'),
        totalLine));
      refreshTotals();
    }

    // พรีวิวของร้าน + รอบล่าสุด (ดู preview ด้านล่าง)
    let previewKey = null;
    let previewResult = null;
    let latestKey = null;
    const remember = (key, result) => {
      previewKey = key;
      previewResult = result;
      return result;
    };

    return formModal({
    title: 'ออกใบเรียกเก็บ',
    submitLabel: 'ออกใบเรียกเก็บ',
    fields: [
      {
        name: 'periodCode',
        label: 'รอบบิล',
        type: 'select',
        required: true,
        value: periodFilter || periodOf(),
        options: periodOptions(),
      },
      {
        name: 'franchiseId',
        label: 'ร้านค้า',
        type: 'select',
        required: true,
        // ร้านที่ออกบิลของรอบนั้นไปแล้วไม่ต้องขึ้นมาให้เลือก — หนึ่งรอบออกได้ใบเดียว
        options: (v) => {
          const taken = new Set(invoicedByPeriod.get(v.periodCode) ?? []);
          const open = franchises.filter((f) => !taken.has(f.id));
          return open.length
            ? open.map((f) => ({ value: String(f.id), label: f.username }))
            : [{ value: '', label: '— ทุกร้านออกบิลรอบนี้ครบแล้ว —' }];
        },
        hint: 'ร้านที่ออกบิลของรอบนี้ไปแล้วจะไม่แสดงในรายการ',
      },
      { name: 'dueDate', label: 'ครบกำหนดชำระ', type: 'date', hint: 'เว้นว่าง = 7 วันหลังจบรอบ' },
      {
        /*
         * สกุลที่ให้ร้านจ่าย — ยอดในระบบยังเป็นบาทเสมอ ตัวนี้บอกแค่ว่าร้านเห็น/โอนเป็นสกุลไหน
         * ตัวเลือกดอลลาร์ขึ้นเฉพาะรอบที่ตั้งอัตราไว้แล้ว ไม่งั้นแปลงไม่ได้
         */
        name: 'currency',
        label: 'ให้ชำระเป็นสกุลเงิน',
        type: 'select',
        options: (v) => {
          const rate = periodRates.get(v.periodCode ?? '');
          return [
            { value: 'THB', label: 'บาท (THB)' },
            rate
              ? { value: 'USD', label: `ดอลลาร์ (USD) · อัตรา ${money(rate)} ฿` }
              : { value: 'USD-disabled', label: 'ดอลลาร์ — รอบนี้ยังไม่ได้ตั้งอัตรา' },
          ];
        },
        hint: 'ยอดในระบบเก็บเป็นบาทเสมอ — เลือกดอลลาร์คือให้ร้านเห็นและโอนเป็นดอลลาร์',
      },
      {
        // บัญชีที่ร้านต้องโอนเข้า — ตรึงไว้กับบิลใบนี้ ถึงเปลี่ยนบัญชีหลักทีหลังใบนี้ก็ไม่เปลี่ยนตาม
        name: 'bankAccountId',
        label: 'ให้โอนเข้าบัญชี',
        type: 'select',
        value: String(bankAccounts.find((b) => b.isDefault)?.id ?? bankAccounts[0]?.id ?? ''),
        // กรองตามสกุลที่เลือกไว้ข้างบน — บัญชีบาทกับบัญชีดอลลาร์เป็นคนละเลขบัญชี โอนผิดใบเงินไม่เข้า
        options: (v) => {
          const usable = bankAccounts.filter((b) => b.currency === (v.currency ?? 'THB'));
          return usable.length
            ? usable.map((b) => ({
              value: String(b.id),
              label: `${b.bankName} · ${b.accountNumber}${b.isDefault ? ' (บัญชีหลัก)' : ''}`,
            }))
            : [{ value: '', label: `— ยังไม่มีบัญชีที่รับ${v.currency === 'USD' ? 'ดอลลาร์' : 'บาท'} —` }];
        },
        hint: bankAccounts.length
          ? 'ร้านจะเห็นบัญชีนี้บนบิล'
          : 'ยังไม่มีบัญชี — ไปเพิ่มที่เมนู "บัญชีรับเงิน" ก่อน ไม่งั้นร้านไม่รู้ว่าต้องโอนเข้าไหน',
      },
      { name: 'note', label: 'หมายเหตุ' },
    ],

    /**
     * ใบเรียกเก็บไม่ได้กรอกยอดเอง — ดึงจากยอดขายที่บันทึกไว้ในรอบนั้นและยังไม่ถูกออกบิล
     * พรีวิวนี้บอกให้เห็นก่อนกดว่ากำลังจะเรียกเก็บอะไรบ้าง หรือถ้ายังไม่มีก็บอกว่าต้องไปทำอะไรต่อ
     */
    preview: async (v) => {
      /*
       * รายการในพรีวิวขึ้นกับร้าน + รอบเท่านั้น
       * ช่องอื่น (หมายเหตุ วันครบกำหนด สกุล บัญชี) เปลี่ยนก็คืนของเดิม — เดิมสร้างใหม่ทุกตัวอักษร
       * แล้วติ๊กที่เอาออกไว้เด้งกลับเป็นเลือกทั้งหมด บิลจึงเรียกเก็บรายการที่ไม่ได้ตั้งใจเก็บ
       */
      const key = `${v.franchiseId ?? ''}|${v.periodCode ?? ''}`;
      if (key === previewKey) return previewResult;
      latestKey = key;
      available = [];
      selected = new Set();
      if (!v.franchiseId || !v.periodCode) {
        previewKey = key;
        previewResult = null;
        return null;
      }

      // หนึ่งร้าน/หนึ่งรอบ = ใบเดียว — บอกตั้งแต่ตอนเลือกว่ารอบนี้ออกไปแล้ว
      // ถามเซิร์ฟเวอร์ตรง ๆ ไม่ใช้รายการที่โหลดไว้ เพราะรายการนั้นอาจถูกตัวกรองรอบบิลตัดออกไป
      const sameSlot = await api.get(`/api/invoices${qs({ franchiseId: v.franchiseId, periodCode: v.periodCode })}`);
      // เปลี่ยนร้าน/รอบระหว่างรอ — ผลนี้เก่าแล้ว ห้ามเขียนทับรายการที่เลือกของร้านใหม่
      if (latestKey !== key) return null;
      const existing = sameSlot.items.find((i) => i.status !== 'VOID');
      if (existing) {
        return remember(key, {
          canSubmit: false, // กดไปก็ไม่ผ่าน ปิดปุ่มไว้เลยดีกว่าปล่อยให้เจอ error
          node: el('div', { class: 'notice-box m-0' },
            el('div', {}, el('strong', {}, `รอบ ${periodLabel(v.periodCode)} ออกใบเรียกเก็บไปแล้ว — ${existing.invoiceNo}`)),
            el('div', {}, 'หนึ่งรอบบิลออกได้ใบเดียว ถ้ามีรายการตกหล่นให้กด "+ รายการ" ที่ใบเดิม หรือยกเลิกใบเดิมก่อนแล้วออกใหม่'),
            el('div', { class: 'mt-6' },
              'จะเพิ่มค่าใช้จ่ายหรือส่วนลดในใบนี้ ให้กด "แก้ไขบิล" ที่แถวของใบนั้นในตาราง')),
        });
      }

      const all = await api.get(`/api/sales-entries${qs({ franchiseId: v.franchiseId, periodCode: v.periodCode })}`);
      if (latestKey !== key) return null;
      const billable = all.items.filter((e) => e.status !== 'INVOICED');

      if (!billable.length) {
        return remember(key, {
          canSubmit: false,
          node: el('div', { class: 'notice-box m-0' },
            el('div', {}, el('strong', {}, `รอบ ${periodLabel(v.periodCode)} ยังออกบิลไม่ได้`)),
            el('div', {}, `ร้านนี้ยังไม่มีการกรอกยอดขายในรอบ ${periodLabel(v.periodCode)} — ไปกรอกยอดเงินเต็มที่หน้า "ยอดขายรายรอบ" ก่อน`),
            // บอกด้วยว่าช่องใส่ส่วนลด/ค่าใช้จ่ายหายไปไหน ไม่ใช่ปล่อยให้งงว่าทำไมไม่มี
            el('div', { class: 'mt-6' },
              'ส่วน "ค่าใช้จ่ายอื่น / ส่วนลด" จะโผล่ขึ้นมาในหน้าต่างนี้เอง เมื่อเลือกร้านที่มียอดพร้อมเรียกเก็บแล้ว'),
            el('a', { href: '#/sales', style: 'display:inline-block;margin-top:6px' }, 'ไปหน้ายอดขายรายรอบ →')),
        });
      }

      available = billable;
      selected = new Set(billable.map((e) => e.id)); // ค่าเริ่มต้น: เลือกทั้งหมด

      const summaryLine = el('div', { class: 'sub-line' });
      const updateSummary = () => {
        const picked = available.filter((e) => selected.has(e.id));
        const gross = picked.reduce((s, e) => s + e.grossAmount, 0);
        const commission = picked.reduce((s, e) => s + e.commissionAmount, 0);
        summaryLine.textContent = picked.length
          ? `เลือก ${picked.length}/${available.length} รายการ · ยอดเงินเต็ม ${money(gross)} ฿ → ส่วนต่างที่จะเรียกเก็บ ${money(commission)} ฿`
          : 'ยังไม่ได้เลือกรายการใดเลย';
        summaryLine.style.color = picked.length ? '' : 'var(--danger)';
        // ติ๊ก/ไม่ติ๊กสินค้า = ส่วนต่างเปลี่ยน ค่าใช้จ่ายที่คิดเป็น % จึงต้องคิดใหม่ตาม
        drawAdjustments();
      };

      const toggleAll = el('input', { type: 'checkbox', checked: true, style: 'width:auto' });
      const boxes = new Map();
      toggleAll.addEventListener('change', () => {
        for (const [id, box] of boxes) {
          box.checked = toggleAll.checked;
          if (toggleAll.checked) selected.add(id); else selected.delete(id);
        }
        updateSummary();
      });

      const rows = table([
        {
          label: toggleAll,
          render: (e) => {
            const box = el('input', { type: 'checkbox', checked: true, style: 'width:auto' });
            boxes.set(e.id, box);
            box.addEventListener('change', () => {
              if (box.checked) selected.add(e.id); else selected.delete(e.id);
              toggleAll.checked = selected.size === available.length;
              updateSummary();
            });
            return box;
          },
        },
        { label: 'สินค้า', render: (e) => el('div', {}, el('strong', {}, e.sku), el('div', { class: 'sub-line' }, e.productName)) },
        { label: 'ยอดเงินเต็ม', num: true, render: (e) => money(e.grossAmount) },
        { label: '%', num: true, render: (e) => pct(e.commissionPct) },
        { label: 'ส่วนต่าง', num: true, render: (e) => money(e.commissionAmount) },
      ], available);

      updateSummary();

      drawAdjustments();

      return remember(key, el('div', { class: 'card', style: 'box-shadow:none;margin:0' },
        el('div', { class: 'card-body', style: 'padding:12px 14px' },
          el('div', { class: 'sub-line', style: 'margin-bottom:8px' },
            `เลือกรายการที่จะเรียกเก็บในใบนี้ — ยอดมาจากที่บันทึกไว้ในรอบ ${periodLabel(v.periodCode)} (กรอกที่หน้า "ยอดขายรายรอบ")`),
          rows,
          el('div', { class: 'mt-8' }, summaryLine),
          adjBox)));
    },

    onSubmit: async (v) => {
      if (available.length && selected.size === 0) {
        throw new Error('เลือกอย่างน้อยหนึ่งรายการที่จะเรียกเก็บ');
      }
      // ส่งเฉพาะแถวที่กรอกครบพอจะคิดเงินได้ — แถวเปล่าที่เผลอกดเพิ่มไว้ไม่ต้องส่ง
      const payload = adjustments
        .filter((a) => a.chargeItemId || (a.label && (a.amount !== '' || a.pct !== '')))
        .map((a) => (a.chargeItemId
          ? {
            chargeItemId: Number(a.chargeItemId),
            ...(a.amount !== '' ? { amount: Number(a.amount) } : {}),
            ...(a.pct !== '' ? { pct: Number(a.pct) } : {}),
          }
          : {
            kind: a.kind ?? 'CHARGE',
            label: a.label,
            ...(a.amount !== '' ? { amount: Number(a.amount) } : {}),
            ...(a.pct !== '' ? { pct: Number(a.pct) } : {}),
          }));

      if (v.currency === 'USD-disabled') {
        throw new Error(`รอบ ${periodLabel(v.periodCode)} ยังไม่ได้ตั้งอัตราแลกเปลี่ยน — ตั้งที่แถบรอบบิลก่อน แล้วค่อยออกบิลเป็นดอลลาร์`);
      }
      const inv = await api.post('/api/invoices/generate', {
        ...v,
        franchiseId: Number(v.franchiseId),
        bankAccountId: v.bankAccountId ? Number(v.bankAccountId) : undefined,
        entryIds: available.length ? [...selected] : undefined,
        adjustments: payload.length ? payload : undefined,
      });
      toast(`ออกใบ ${inv.invoiceNo} — ยอดที่ต้องจ่าย ${payMoney(inv, inv.payAmount)}`, 'success');
      render();
    },
    });
  };

  const detailModal = async (row, { edit = false } = {}) => {
    const inv = await api.get(`/api/invoices/${row.id}`);
    // ข้อ "เปิดดูบิล" ในเช็กลิสต์เริ่มต้นใช้งาน — นับเมื่อร้านเปิดบิลจริง (ระหว่างแอดมินดูมุมร้านไม่นับ)
    if (!isSuper && !session.viewAs) api.post('/api/auth/onboarding', { viewedBill: true }).catch(() => {});
    // แก้ตัวเลขได้เฉพาะบิลที่ยังไม่มีใครแตะเงิน — ถ้าร้านจ่ายมาแล้วหรือส่งสลิปรออยู่
    // การแก้ยอดจะทำให้สิ่งที่ร้านเห็นกับสิ่งที่จ่ายมาไม่ตรงกัน ต้องยกเลิกแล้วออกใหม่แทน
    const editable = edit && canEditInvoice(inv);
    const modal = infoModal({
      title: `${inv.invoiceNo} — ${inv.franchiseUsername}${edit ? ' (แก้ไข)' : ''}`,
      width: 760,
      content: null,
    });

    modal.body.append(
      el('div', { class: 'stat-grid' },
        stat('ยอดขายเต็ม', money(inv.grossTotal) + ' ฿', null, { tone: 'sales', icon: '🛒' }),
        stat('ยอดที่ต้องจ่าย', payMoney(inv, inv.payAmount),
          inv.isUsd
            ? `= ${money(inv.netTotal)} ฿ · อัตรา ${money(inv.usdRate)} ฿/USD`
            : `ส่วนต่าง ${money(inv.commissionTotal)} + ค่าใช้จ่าย ${money(inv.chargeTotal)} − ส่วนลด ${money(inv.discountTotal)}`),
        stat(isSuper ? 'ยังไม่ได้รับ' : 'คงเหลือต้องชำระ', money(inv.outstanding) + ' ฿', `ครบกำหนด ${dateTh(inv.dueDate)}`,
          { tone: inv.outstanding > 0 ? 'due' : 'income', icon: inv.outstanding > 0 ? '⏳' : '✓' })),
      usdLine(inv),

      // ร้าน: เล่าบิลเป็นประโยคเดียวก่อนเจอตาราง — ขายได้เท่าไร จ่ายเราเท่าไร เหลือเป็นของร้านเท่าไร
      isSuper ? '' : el('div', { class: 'notice-box info-box', style: 'display:block' },
        `ร้านขายได้ ${money(inv.grossTotal)} ฿ · ส่วนต่างของทางเรา ${money(inv.commissionTotal)} ฿`,
        inv.chargeTotal ? ` · ค่าใช้จ่ายอื่น +${money(inv.chargeTotal)} ฿` : '',
        inv.discountTotal ? ` · ส่วนลด −${money(inv.discountTotal)} ฿` : '',
        inv.creditApplied ? ` · หักยอดยกมา −${money(inv.creditApplied)} ฿` : '',
        el('div', { style: 'margin-top:4px' },
          `→ โอนให้ทางเรา `, el('strong', {}, `${money(inv.netTotal)} ฿`),
          ` · ร้านเก็บไว้ `, el('strong', {}, `${money(Math.max(0, inv.grossTotal - inv.netTotal))} ฿`))),

      // เปิดมาดูเฉย ๆ จะไม่มีปุ่มแก้อะไรเลย — ต้องกด "แก้ไขบิล" จากตารางถึงจะแก้ได้
      edit && !editable
        ? el('div', { class: 'alert-box' }, lockReason(inv))
        : '',

      editable && inv.pendingEntries > 0
        ? el('div', { class: 'btn-row tabs' },
          el('button', {
            class: 'btn',
            onclick: () => { modal.close(); addLinesModal(inv); },
          }, `+ เพิ่มรายการที่ยังไม่ได้เรียกเก็บ (${inv.pendingEntries})`))
        : '',

      el('h3', { style: 'margin:6px 0 8px' }, 'รายการสินค้าในใบนี้'),
      table([
        { label: 'รายการ', render: (l) => el('div', {}, el('strong', {}, l.sku), el('div', { class: 'sub-line' }, l.productName)) },
        { label: 'ยอดเต็ม', num: true, render: (l) => money(l.grossAmount) },
        { label: '%', num: true, render: (l) => pct(l.commissionPct) },
        { label: 'ส่วนต่าง', num: true, render: (l) => money(l.commissionAmount) },
      ], inv.lines, {
        footer: ['รวม', money(inv.grossTotal), '', money(inv.commissionTotal)],
      }),

      el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin:18px 0 8px' },
        el('h3', {}, 'ค่าใช้จ่ายอื่น / ส่วนลด'),
        editable ? el('button', {
          class: 'btn sm',
          onclick: () => { modal.close(); adjustmentModal(inv); },
        }, '+ เพิ่มรายการ') : ''),
      table([
        { label: 'รายการ', render: (a) => el('div', {}, a.label, el('div', { class: 'sub-line' }, a.note ?? a.kindLabel)) },
        { label: 'คิดจาก', render: (a) => (a.pct === null ? 'จำนวนเงินคงที่' : `${a.pct}% ของส่วนต่าง`) },
        {
          label: 'จำนวน',
          num: true,
          render: (a) => el('span', { style: a.kind === 'DISCOUNT' ? 'color:var(--success)' : '' },
            a.kind === 'DISCOUNT' ? `−${money(a.amount)}` : `+${money(a.amount)}`),
        },
        {
          label: '',
          render: (a) => (editable
            ? el('button', {
              class: 'btn ghost sm',
              onclick: () => confirmAction(`ลบรายการ "${a.label}" ออกจากบิล?`, async () => {
                await api.del(`/api/invoices/${inv.id}/adjustments/${a.id}`);
                toast('ลบรายการแล้ว', 'success');
                modal.close();
                render();
              }),
            }, 'ลบ')
            : ''),
        },
      ], inv.adjustments, { empty: 'ยังไม่มีค่าใช้จ่ายอื่นหรือส่วนลดในบิลนี้' }),

      el('h3', { style: 'margin:18px 0 8px' }, 'สรุปยอดที่ต้องจ่าย'),
      breakdownTable(inv),

      // เงินที่ได้รับแล้ว — ร้านเปิดใบรับเงินเก็บไว้เป็นหลักฐานได้
      inv.payments.length
        ? el('div', { class: 'mt-16' },
          el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px' },
            el('h3', {}, isSuper ? 'เงินที่ได้รับแล้ว' : 'ทางเราได้รับเงินแล้ว'),
            el('button', { class: 'btn ghost sm', onclick: () => receiptModal(inv.id) }, '🧾 ใบรับเงิน')),
          table([
            { label: 'วันที่', render: (p) => dateTh(p.paidAt?.slice(0, 10)) },
            { label: 'ช่องทาง', render: (p) => p.method ?? '—' },
            { label: 'จำนวน', num: true, render: (p) => money(p.amount) },
          ], inv.payments, { sortable: false }))
        : '',

      /*
       * ร้านต้องรู้ว่าโอนเข้าบัญชีไหน — ตรึงไว้ตั้งแต่ตอนออกบิล
       * แต่ถ้าเลือกผิดตั้งแต่แรก ต้องแก้ได้ตราบใดที่ยังไม่มีเงินเข้าและไม่มีสลิปรอตรวจ
       * (พอร้านโอนแล้ว สลิปที่ถืออยู่จะไม่ตรงกับบิล จึงล็อกด้วยกติกาเดียวกับการแก้ยอด)
       */
      el('div', { class: 'mt-16' },
        bankAccountBox(inv.bankAccount),
        editable
          ? el('div', { class: 'btn-row', style: 'margin-top:8px;justify-content:center' },
            el('button', {
              class: 'btn ghost sm',
              onclick: () => { modal.close(); billSettingsModal(inv); },
            }, '🏦 เปลี่ยนบัญชี / วันครบกำหนด'))
          : ''),

      /*
       * สรุปสถานะเงินแบบย่อ — คนละข้อความตามบทบาท
       * ส่วนกลางไม่มีสิทธิ์จ่ายแทนร้าน ตรงนี้จึงชี้ไปที่ "ตรวจสลิป" เท่านั้น
       * ส่วนร้านคือคนจ่าย จึงชี้ไปหน้าชำระเงินของตัวเอง
       */
      /*
       * รอบที่ร้านคืนของมากกว่าขาย — เราเป็นฝ่ายติดค้างร้าน
       * ไม่ได้โอนคืน แต่ยกไปหักบิลรอบหน้าให้เอง ต้องบอกให้ชัดว่ายกไปเท่าไร
       * ไม่งั้นร้านเห็นบิล 0 บาทแล้วนึกว่ายอดที่คืนไปหายเข้ากลีบเมฆ
       */
      inv.creditCarried > 0
        ? el('div', { class: 'notice-box', style: 'margin:18px 0 0' },
          `รอบนี้ยอดติดลบ ${money(inv.creditCarried)} ฿ — ${isSuper ? 'เราติดค้างร้าน' : 'ทางเราติดค้างร้านไว้'}`,
          el('div', { class: 'sub-line mt-4' },
            'ยกไปหักจากบิลรอบถัดไปให้อัตโนมัติ ไม่มีการโอนเงินคืน'))
        : '',

      inv.creditCarried > 0 ? '' : el('div', { class: inv.isOverdue ? 'alert-box' : 'notice-box', style: 'margin:18px 0 0' },
        inv.outstanding > 0
          ? `${isSuper ? 'ยังไม่ได้รับเงิน' : 'ยังค้างชำระ'} ${money(inv.outstanding)} ฿ `
            + `จากทั้งหมด ${money(inv.netTotal)} ฿`
            + (inv.isOverdue ? ` · เลยกำหนดมาแล้ว ${int(inv.daysOverdue)} วัน` : '')
          : `${isSuper ? 'ได้รับเงินครบ' : 'ชำระครบ'} ${money(inv.netTotal)} ฿ แล้ว`,
        inv.outstanding > 0
          ? el('div', { class: 'sub-line mt-4' },
            isSuper
              ? el('span', {}, 'รอร้านแจ้งชำระเข้ามา — ตรวจสลิปแล้วกดอนุมัติที่แท็บ ',
                el('a', {
                  href: '#/invoices',
                  onclick: (e) => { e.preventDefault(); modal.close(); jumpToTab('slips'); },
                }, 'สลิปรอตรวจ →'))
              : el('span', {}, 'โอนเงินแล้วกดปุ่ม "ชำระเงิน" ที่บิลใบนี้ได้เลย'))
          : ''));
  };

  /**
   * แก้ข้อมูลหัวบิลที่ไม่ใช่ตัวเลข — บัญชีปลายทาง วันครบกำหนด หมายเหตุ
   * เซิร์ฟเวอร์ใช้กติกาเดียวกับการแก้ยอด จึงกดได้เฉพาะบิลที่ยังไม่มีเงินขยับ
   */
  const billSettingsModal = (inv) => formModal({
    title: `แก้ข้อมูลบิล — ${inv.invoiceNo}`,
    submitLabel: 'บันทึก',
    fields: [
      /*
       * สกุลที่ให้ร้านจ่าย — ยอดในระบบยังเป็นบาทเท่าเดิม ตัวนี้เปลี่ยนแค่สิ่งที่ร้านเห็นและโอน
       * เลือกสกุลก่อน แล้วลิสต์บัญชีด้านล่างค่อยกรองตาม เพราะบัญชีบาทรับดอลลาร์ไม่ได้
       */
      {
        name: 'currency',
        label: 'สกุลเงินที่ให้ร้านจ่าย',
        type: 'select',
        value: inv.currency ?? 'THB',
        options: [
          { value: 'THB', label: 'บาท (THB)' },
          { value: 'USD', label: 'ดอลลาร์ (USD)' },
        ],
        hint: inv.usdRate
          ? `อัตราที่ตรึงไว้กับใบนี้ ${money(inv.usdRate)} ฿/USD`
          : 'รอบนี้ยังไม่ได้ตั้งอัตราแลกเปลี่ยน — เลือกดอลลาร์ไม่ได้จนกว่าจะตั้งที่แถบรอบบิล',
      },
      {
        name: 'bankAccountId',
        label: 'ให้โอนเข้าบัญชี',
        type: 'select',
        // บิลเก่าที่ออกก่อนมีระบบบัญชีจะยังไม่ผูกอะไรไว้ — ตั้งต้นให้เป็นบัญชีแรกที่รับสกุลเดียวกัน
        value: String(inv.bankAccount?.id
          ?? bankAccounts.find((b) => b.currency === (inv.currency ?? 'THB'))?.id
          ?? ''),
        options: (v) => {
          const usable = bankAccounts.filter((b) => b.currency === (v.currency ?? 'THB'));
          return usable.length
            ? usable.map((b) => ({
              value: String(b.id),
              label: `${b.bankName} · ${b.accountNumber}${b.isDefault ? ' (บัญชีหลัก)' : ''}`,
            }))
            : [{ value: '', label: `— ยังไม่มีบัญชีที่รับ${v.currency === 'USD' ? 'ดอลลาร์' : 'บาท'} —` }];
        },
        hint: 'ร้านจะเห็นบัญชีนี้บนบิลและในหน้าจ่ายเงิน',
      },
      { name: 'dueDate', label: 'ครบกำหนดชำระ', type: 'date', value: inv.dueDate },
      { name: 'note', label: 'หมายเหตุ', value: inv.note ?? '' },
    ],
    preview: (v) => {
      const currency = v.currency ?? 'THB';
      const picked = bankAccounts.find((b) => String(b.id) === String(v.bankAccountId));

      // ดอลลาร์ต้องมีอัตราตรึงไว้ ไม่มีก็แปลงยอดให้ร้านไม่ได้ — กันตั้งแต่ปุ่มเลย ไม่ต้องรอ error จากเซิร์ฟเวอร์
      if (currency === 'USD' && !inv.usdRate) {
        return {
          node: el('div', { class: 'alert-box m-0' },
            `รอบ ${periodLabel(inv.periodCode)} ยังไม่ได้ตั้งอัตราแลกเปลี่ยน`,
            el('div', { class: 'sub-line mt-4' },
              'ไปตั้งอัตราที่แถบรอบบิลด้านบนก่อน แล้วค่อยเปลี่ยนบิลใบนี้เป็นดอลลาร์')),
          canSubmit: false,
        };
      }
      if (!picked) {
        return {
          node: el('div', { class: 'alert-box m-0' },
            `ยังไม่มีบัญชีที่รับ${currency === 'USD' ? 'ดอลลาร์' : 'บาท'}`,
            el('div', { class: 'sub-line mt-4' },
              'ไปเพิ่มที่เมนู "บัญชีรับเงิน" ก่อน แล้วค่อยกลับมาเลือก')),
          canSubmit: false,
        };
      }

      const changedCurrency = currency !== (inv.currency ?? 'THB');
      const changedAccount = picked.id !== inv.bankAccount?.id;
      return el('div', { class: 'notice-box m-0' },
        changedCurrency || changedAccount ? '⚠ สิ่งที่ร้านจะเห็นเปลี่ยนไป' : 'ข้อมูลเดิมของบิลใบนี้',
        el('div', { class: 'mt-4' },
          el('strong', {}, currency === 'USD'
            ? `$${money(inv.netTotal / inv.usdRate)} (= ${money(inv.netTotal)} ฿)`
            : `${money(inv.netTotal)} ฿`)),
        el('div', { style: 'margin-top:2px' }, el('strong', {}, `${picked.bankName} · ${picked.accountNumber}`)),
        changedCurrency || changedAccount
          ? el('div', { class: 'sub-line mt-4' },
            'ร้านจะเห็นของใหม่ทันที — แจ้งร้านด้วยถ้าเคยส่งบิลเดิมไปแล้ว')
          : '');
    },
    onSubmit: async (v) => {
      await api.patch(`/api/invoices/${inv.id}`, {
        ...v,
        bankAccountId: v.bankAccountId ? Number(v.bankAccountId) : null,
      });
      toast('บันทึกข้อมูลบิลแล้ว', 'success');
      render();
    },
  });

  /** เติมยอดของรอบเดียวกันที่ยังไม่ได้เรียกเก็บเข้าใบนี้ (แทนการออกใบที่สอง) */
  const addLinesModal = (row) => formModal({
    title: `เพิ่มรายการเข้าบิล — ${row.invoiceNo}`,
    submitLabel: 'เพิ่มเข้าบิล',
    fields: [],
    preview: async () => {
      const all = await api.get(`/api/sales-entries${qs({ franchiseId: row.franchiseId, periodCode: row.periodCode })}`);
      const pending = all.items.filter((e) => e.status !== 'INVOICED');
      if (!pending.length) return el('div', { class: 'notice-box m-0' }, 'ไม่มีรายการค้างแล้ว');

      const addGross = pending.reduce((s, e) => s + e.grossAmount, 0);
      const addComm = pending.reduce((s, e) => s + e.commissionAmount, 0);

      return el('div', {},
        el('div', { class: 'sub-line', style: 'margin-bottom:8px' },
          `รอบ ${periodLabel(row.periodCode)} ออกได้ใบเดียว — ${pending.length} รายการนี้จะถูกเติมเข้าใบเดิม`),
        table([
          { label: 'รายการ', render: (e) => el('div', {}, el('strong', {}, e.sku), el('div', { class: 'sub-line' }, e.productName)) },
          { label: 'ยอดเงินเต็ม', num: true, render: (e) => money(e.grossAmount) },
          { label: '%', num: true, render: (e) => pct(e.commissionPct) },
          { label: 'ส่วนต่าง', num: true, render: (e) => money(e.commissionAmount) },
        ], pending, { sortable: false }),
        el('div', { class: 'notice-box', style: 'margin:10px 0 0' },
          `ส่วนต่างในบิลจะเพิ่มจาก ${money(row.commissionTotal)} เป็น ${money(row.commissionTotal + addComm)} ฿`,
          el('div', { class: 'sub-line' }, `ยอดขายเต็มรวมเพิ่มอีก ${money(addGross)} ฿ · ค่าใช้จ่าย/ส่วนลดที่คิดเป็น % จะคำนวณใหม่ให้`)));
    },
    onSubmit: async () => {
      await api.post(`/api/invoices/${row.id}/lines`, {});
      toast('เพิ่มรายการเข้าบิลแล้ว ยอดคำนวณใหม่ให้อัตโนมัติ', 'success');
      render();
    },
  });

  const columns = [
    {
      label: 'เลขที่',
      sortValue: (r) => r.invoiceNo,
      render: (r) => el('div', {}, el('strong', {}, r.invoiceNo), ' ', currencyTag(r),
        el('div', { class: 'sub-line' }, `ออก ${dateTh(r.issuedAt)}`)),
    },
    isSuper && {
      label: 'ร้านค้า',
      sortValue: (r) => r.franchiseUsername,
      render: (r) => avatar(r.franchiseUsername, { sub: '' }),
    },
    { label: 'รอบบิล', render: (r) => el('div', {}, r.periodCode, el('div', { class: 'sub-line' }, `${r.periodStart} → ${r.periodEnd}`)) },
    { label: 'ส่วนต่าง', num: true, render: (r) => money(r.commissionTotal) },
    { label: 'ค่าใช้จ่าย', num: true, render: (r) => (r.chargeTotal ? `+${money(r.chargeTotal)}` : el('span', { class: 'muted' }, '—')) },
    { label: 'ส่วนลด', num: true, render: (r) => (r.discountTotal ? `−${money(r.discountTotal)}` : el('span', { class: 'muted' }, '—')) },
    {
      label: 'ยอดที่ต้องจ่าย',
      num: true,
      sortValue: (r) => r.netTotal,
      render: (r) => el('div', {}, el('strong', {}, payMoney(r, r.payAmount)),
        r.isUsd ? el('div', { class: 'sub-line' }, `= ${money(r.netTotal)} ฿`) : ''),
    },
    { label: 'ค้างชำระ', num: true, render: (r) => money(r.outstanding) },
    {
      label: 'ครบกำหนด',
      sortValue: (r) => r.dueDate,
      render: (r) => el('div', {}, dateTh(r.dueDate),
        r.isOverdue ? el('div', { class: 'overdue-tag' }, `เลยกำหนด ${int(r.daysOverdue)} วัน`) : ''),
    },
    {
      label: 'สถานะ',
      sortValue: (r) => r.status,
      render: (r) => el('div', {}, badge(r.status),
        r.pendingSubmissions ? el('div', { class: 'sub-line' }, `แจ้งชำระรอตรวจ ${r.pendingSubmissions}`) : '',
        // บอกให้ครบคำ แทนที่จะเป็นตัวเลข +N บนปุ่มที่เดาความหมายไม่ออก
        isSuper && r.pendingEntries > 0 && !['PAID', 'VOID'].includes(r.status)
          ? el('div', { class: 'sub-line', style: 'color:var(--warn)' },
            `ยังมี ${int(r.pendingEntries)} รายการไม่ได้เรียกเก็บ`)
          : ''),
    },
    {
      label: '',
      render: (r) => el('div', { class: 'btn-row' },
        el('button', { class: 'btn ghost sm', onclick: () => detailModal(r) }, 'ดูบิล'),
        // ปุ่มแก้/ยกเลิกโผล่เฉพาะตอนที่ทำได้จริง จะได้ไม่กดแล้วเจอข้อความปฏิเสธ
        isSuper && canEditInvoice(r)
          ? el('button', { class: 'btn sm', onclick: () => detailModal(r, { edit: true }) }, 'แก้ไขบิล') : '',
        // มีสลิปค้างอยู่ก็จัดการได้จากแถวนี้เลย ไม่ต้องไปหาเองในอีกแท็บ
        isSuper && r.pendingSubmissions
          ? el('button', {
            class: 'btn sm',
            onclick: () => jumpToTab('slips', `[data-row-key="inv-${r.id}"]`, () => viewState.setItem(PAY_STATUS_KEY, 'PENDING')),
          }, `ตรวจสลิป (${int(r.pendingSubmissions)})`)
          : '',
        isSuper && canVoidInvoice(r)
          ? el('button', {
            class: 'btn ghost sm danger',
            onclick: () => formModal({
              title: `ยกเลิกใบ ${r.invoiceNo}`,
              submitLabel: 'ยกเลิกใบเรียกเก็บ',
              fields: [{
                name: 'reason',
                label: 'เหตุผลที่ยกเลิก',
                required: true,
                placeholder: 'เช่น ออกผิดร้าน / ยอดขายกรอกผิด ต้องแก้แล้วออกใหม่',
                hint: 'บันทึกไว้ในประวัติ — ย้อนดูทีหลังได้ว่ายกเลิกเพราะอะไร',
              }],
              preview: () => el('div', { class: 'alert-box m-0' },
                `${r.franchiseUsername} · ยอด ${money(r.netTotal)} ฿ — รายการยอดขายจะกลับมาพร้อมออกบิลใหม่`),
              onSubmit: async (v) => {
                await api.post(`/api/invoices/${r.id}/void`, { reason: v.reason });
                toast('ยกเลิกใบเรียกเก็บแล้ว', 'success');
                render();
              },
            }),
          }, 'ยกเลิก') : ''),
    },
  ].filter(Boolean);

  /*
   * ร้านค้ามีเมนูเดียวคือ "บิลของฉัน" แล้วแบ่งเป็นสองแท็บ
   * เดิมแยกเป็นเมนู "ใบเรียกเก็บ" กับ "ชำระเงิน" ซึ่งทั้งคู่ลิสต์บิลของร้านเหมือนกัน
   * ต่างแค่ว่าอันหนึ่งกรองเฉพาะที่ยังค้าง เลยดูซ้ำซ้อนจนไม่รู้ว่าต้องเข้าอันไหน
   */
  // ส่วนของตารางใบเรียกเก็บ (ตัวกรอง + ตาราง) โผล่เฉพาะแท็บของมันเอง
  // ตารางใบเรียกเก็บเป็นของฝั่งส่วนกลางเท่านั้น ร้านค้าดูย้อนหลังจากประวัติการชำระแทน
  const hideBillList = isSuper ? superTab !== 'bills' : shopTab !== 'all';

  const billsInPeriod = allInvoices.filter((r) => !periodFilter || r.periodCode === periodFilter).length;

  /** การ์ดตัวเลขของแท็บที่เปิดอยู่ — 3 ใบพอ ให้เหลือที่ไว้ดูตารางจริง */
  function statCards() {
    const scope = periodFilter ? `รอบ ${periodLabel(periodFilter)}` : 'ทุกรอบ';

    /*
     * แท็บสลิป/เงินเข้า คิดยอดจาก "รอบ" อย่างเดียว ไม่เอาตัวกรองสถานะบิลมาคิดด้วย
     * เพราะช่องนั้นถูกซ่อนอยู่ ถ้าค่าเก่าค้างไว้ตัวเลขจะเพี้ยนโดยที่ไม่มีอะไรบอก
     */
    const inPeriod = allInvoices.filter((r) => !periodFilter || r.periodCode === periodFilter);
    const outstandingInPeriod = Number(inPeriod.reduce((t, r) => t + r.outstanding, 0).toFixed(2));
    const billedInPeriod = Number(inPeriod
      .filter((r) => r.status !== 'VOID')
      .reduce((t, r) => t + r.netTotal, 0).toFixed(2));

    if (superTab === 'slips') {
      return [
        stat('สลิปรอตรวจ', money(totals.pendingAmount) + ' ฿', `${int(totals.pendingCount)} ใบ · ${scope}`,
          { tone: totals.pendingCount ? 'warn' : 'muted', icon: '👀' }),
        stat('ได้รับเงินแล้ว', money(totals.receivedTotal) + ' ฿', `${int(totals.receivedCount)} ครั้ง · ${scope}`,
          { tone: 'income', icon: '🏦' }),
        stat('ยังไม่ได้รับ', money(outstandingInPeriod) + ' ฿', scope,
          { tone: outstandingInPeriod > 0 ? 'due' : 'income', icon: outstandingInPeriod > 0 ? '⏳' : '✓' }),
      ];
    }
    if (superTab === 'received') {
      return [
        stat('ได้รับเงินแล้ว', money(totals.receivedTotal) + ' ฿', `${int(totals.receivedCount)} ครั้ง · ${scope}`,
          { tone: 'income', icon: '🏦' }),
        stat('ยังไม่ได้รับ', money(outstandingInPeriod) + ' ฿', `${int(billsInPeriod)} ใบใน${scope}`,
          { tone: outstandingInPeriod > 0 ? 'due' : 'income', icon: outstandingInPeriod > 0 ? '⏳' : '✓' }),
        stat('ยอดเรียกเก็บรวม', money(billedInPeriod) + ' ฿', scope, { tone: 'muted', icon: '💰' }),
      ];
    }

    // แท็บบิล (และฝั่งร้านค้า)
    return [
      stat('จำนวนใบ', String(shown.count),
        [
          shown.voided ? `ยกเลิก ${int(shown.voided)} ใบ (ไม่นับเป็นเงิน)` : null,
          periodFilter || statusFilter ? `กรองจากทั้งหมด ${int(res.summary.count)} ใบ` : null,
        ].filter(Boolean).join(' · ') || null,
        { tone: 'muted', icon: '🧾' }),
      stat('ยอดเรียกเก็บรวม', money(shown.netTotal) + ' ฿', 'รวมค่าใช้จ่ายและหักส่วนลดแล้ว',
        { tone: 'income', icon: '💰' }),
      stat(isSuper ? 'ยังไม่ได้รับ' : 'ยังค้างชำระ', money(shown.outstanding) + ' ฿',
        shown.overdueCount ? `เลยกำหนดแล้ว ${int(shown.overdueCount)} ใบ` : null,
        { tone: shown.outstanding > 0 ? 'due' : 'income', icon: shown.outstanding > 0 ? '⏳' : '✓' }),
    ];
  }

  /*
   * ลิงก์ #/invoices?invoice=ID (จากหน้ารายร้าน) = เปิดบิลใบนั้นให้เลย
   * เปิดครั้งเดียวต่อการเข้าหน้า — วาดหน้าซ้ำ (บันทึก/สลับแท็บ) จะไม่เด้งเปิดซ้ำ
   */
  const deepLinkId = Number(hashParam('invoice'));
  if (deepLinkId && !viewState.getItem('franchise.invoiceDeepLinked')) {
    viewState.setItem('franchise.invoiceDeepLinked', '1');
    const target = allInvoices.find((r) => r.id === deepLinkId);
    if (target) setTimeout(() => detailModal(target), 0);
  }

  const shopTabs = isSuper ? '' : el('div', { class: 'btn-row tabs' },
    ...[
      { id: 'pay', label: 'ที่ต้องจ่าย' },
      { id: 'all', label: `บิลทั้งหมด (${int(allInvoices.length)})` },
    ].map((t) => el('button', {
      class: `btn ${shopTab === t.id ? '' : 'ghost'}`,
      onclick: () => { viewState.setItem(SHOP_TAB_KEY, t.id); render(); },
    }, t.label)));

  const superTabs = !isSuper ? '' : el('div', { class: 'btn-row tabs' },
    ...[
      // ขั้นแรกของรอบ: ร้านไหนพร้อมออกบิล — ตัวเลขบนแท็บคือร้านที่ยังรอออก
      { id: 'ready', label: `พร้อมออกบิล${readiness.summary.ready ? ` (${int(readiness.summary.ready)})` : ''}` },
      // เลี่ยงชื่อ "ใบเรียกเก็บ" ที่ซ้ำกับหัวหน้า จนแยกไม่ออกว่านี่คือหน้าหรือแท็บ
      { id: 'bills', label: `บิล (${int(billsInPeriod)})` },
      { id: 'slips', label: `สลิปรอตรวจ${totals.pendingCount ? ` (${int(totals.pendingCount)})` : ''}` },
      { id: 'received', label: `เงินเข้าแล้ว (${int(totals.receivedCount)})` },
    ].map((t) => el('button', {
      class: `btn ${superTab === t.id ? '' : 'ghost'}`,
      onclick: () => { viewState.setItem(SUPER_TAB_KEY, t.id); render(); },
    }, t.label)));


  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, isSuper ? 'บิลและการชำระ' : 'บิลของฉัน'),
        // คำอธิบายสั้น ๆ พอ — ที่เหลือให้ตัวหน้าจออธิบายตัวเอง ไม่ใช่ดันตารางตกจอ
        el('p', {}, isSuper
          ? 'ออกบิล แก้บิล ตรวจสลิป และดูเงินเข้า — จบในหน้าเดียว'
          : 'ดูยอด แจ้งชำระ และย้อนดูบิลเก่า')),
      // รอบบิลกำหนดขอบเขตของทั้งหน้า จึงอยู่กลางหัวหน้า แยกจากกลุ่มปุ่มทางขวา
      isSuper
        ? periodBar(periodPicker, {
          // อัตราเป็นสมบัติของรอบ จึงอยู่ติดกับตัวเลือกรอบเหมือนหน้า "ยอดขายรายรอบ"
          extra: usdRateChip(period, { baseAmount: shown.netTotal, baseLabel: 'ยอดเรียกเก็บรวมรอบนี้' }),
        })
        : '',
      el('div', { class: 'btn-row' },
        activityButton(['invoice'], { title: 'ประวัติใบเรียกเก็บ' }),
        isSuper && el('button', { class: 'btn', onclick: generateModal }, '+ ออกใบเรียกเก็บ'))),

    // แท็บคือตัวนำทางหลักของหน้า ให้อยู่แถวของตัวเอง ไม่ต้องแชร์กับตัวกรองย่อย
    superTabs,
    shopTabs,

    /*
     * แถบเตือนวางเรียงกันในแถวเดียวแบบบรรทัดเดียว
     * เดิมซ้อนกันสองก้อน กินที่ 170px จนตารางตกจอ ทั้งที่แต่ละอันมีใจความบรรทัดเดียว
     */
    el('div', { class: 'banner-row' },
      // คิวงานค้าง — กดแล้วไปที่คิวเลย
      isSuper && superTab !== 'slips' && totals.pendingAllCount > 0
        ? alertBanner({
          tone: 'warn',
          compact: true,
          /*
           * นับข้ามทุกรอบ ไม่งั้นสลิปที่ค้างในรอบอื่นจะเงียบหายเพราะดันเลือกดูรอบนี้อยู่
           * แต่พอตัวเลขไม่ตรงกับตารางข้างล่าง ต้องกระทบไหล่บอกในบรรทัดเดียวกันเลย
           * ไม่ใช่ซ่อนไว้ใน tooltip ให้ต้องเอาเมาส์ไปชี้ถึงจะรู้ว่าทำไมไม่ตรง
           */
          title: `⚠ สลิปรอตรวจ ${int(totals.pendingAllCount)} ใบ · ${money(totals.pendingAllAmount)} ฿`
            + (periodFilter && totals.pendingAllCount > totals.pendingCount
              ? ` — ทุกรอบ (รอบนี้ ${int(totals.pendingCount)} ใบ)` : ''),
          detail: 'ยอดจะถูกตัดออกจากบิลเมื่อกดยืนยันรับเงินเท่านั้น',
          actionLabel: 'ไปตรวจ',
          // ล้างตัวกรองรอบด้วย จะได้เห็นสลิปค้างครบทุกใบตามที่เตือนไป
          onClick: () => jumpToTab('slips', null, () => viewState.setItem(FILTER_KEY, '')),
        })
        : '',

      // บิลเลยกำหนด — กดแล้วสลับตัวกรองเป็น "เลยกำหนด" แล้วกะพริบแถวให้เห็น
      (!isSuper || superTab !== 'bills' || !overdueInvoices.length)
        ? ''
        : alertBanner({
          compact: true,
          // นับข้ามรอบเช่นกัน จึงบอกในบรรทัดเดียวกันว่าต่างจากตารางข้างล่างตรงไหน
          title: `⚠ บิลเลยกำหนด ${overdueInvoices.length} ใบ · ${money(overdueTotal)} ฿`
            + (periodFilter && overdueInvoices.length > shown.overdueCount
              ? ` — ทุกรอบ (รอบนี้ ${int(shown.overdueCount)} ใบ)` : ''),
          detail: isSuper
            ? `ร้านที่ค้าง: ${[...new Set(overdueInvoices.map((r) => r.franchiseUsername))].join(', ')}`
            : 'กรุณาโอนแล้วแจ้งชำระพร้อมแนบสลิป',
          actionLabel: isSuper ? 'ดูบิล' : 'ไปจ่าย',
          onClick: async () => {
            viewState.setItem(STATUS_KEY, 'OVERDUE');
            viewState.setItem(FILTER_KEY, '');
            await render();
            flashRows('tr.row-overdue');
          },
        })),


    /*
     * การ์ดตัวเลข 3 ใบเสมอ และเปลี่ยนชุดตามแท็บที่เปิดอยู่
     * เดิมยัด 5 ใบรวมทุกเรื่อง กินที่ 242px แล้วส่วนใหญ่ก็ไม่เกี่ยวกับแท็บที่กำลังดู
     * ทุกรอบยังเป็นตัวเลขของ "รอบที่เลือก" จะได้ตรงกับตารางข้างล่างเสมอ
     */
    // แท็บ "ที่ต้องจ่าย" มีการ์ดสถิติของตัวเองอยู่บนสุดแล้ว
    // ถ้าปล่อยชุดนี้ไว้จะไปโผล่ท้ายหน้าแบบลอย ๆ ไม่รู้ว่าเป็นตัวเลขของอะไร
    (hideBillList && !isSuper) || superTab === 'ready' ? '' : el('div', { class: 'stat-grid' }, ...statCards()),

    // เนื้อหาหลักของแท็บ วางตำแหน่งเดียวกันหมด: หัวหน้า → แท็บ → เตือน → สถิติ → เนื้อหา
    payCenter,

    /*
     * หัวข้อตารางคู่กับตัวกรองในแถวเดียว — จังหวะเดียวกับหน้า "ยอดขายรายรอบ"
     * บอกด้วยว่ากำลังดูอะไรอยู่กี่รายการ แทนที่จะปล่อยช่องค้นหาลอยไม่มีหัวเรื่อง
     */
    hideBillList ? '' : el('div', { class: 'toolbar' },
      el('h2', { class: 'section-title' },
        `ใบเรียกเก็บ${periodFilter ? `ของรอบ ${periodLabel(periodFilter)}` : 'ทุกรอบ'} (${int(visibleInvoices.length)})`),
      // ร้านก็กรองได้ — หาบิลที่ยังค้าง/เลยกำหนดจากประวัติทั้งหมด
      el('div', { class: 'filters' },
        el('div', { class: 'field' }, el('label', {}, 'สถานะบิล'), statusPicker))),

    hideBillList ? '' : card(null, table(columns, visibleInvoices, {
      rowClass: (r) => (r.isOverdue ? 'row-overdue' : ''),
      // ให้ปุ่มจากแท็บอื่น ("ไปเพิ่มเข้าบิล") พามาถึงแถวของบิลใบนั้นได้
      rowKey: (r) => `inv-${r.id}`,
      search: 'ค้นหาเลขที่บิลหรือร้าน…',
      empty: isSuper
        ? 'ยังไม่มีใบเรียกเก็บ — กรอกยอดในหน้า "ยอดขายรายรอบ" ก่อน แล้วกดออกใบเรียกเก็บ'
        : 'ยังไม่มีใบเรียกเก็บของคุณ',
    }), { tight: true }),

    superTab === 'slips'
      ? el('div', { class: 'toolbar' },
        el('h2', { class: 'section-title' },
          `สลิปที่ร้านแจ้งเข้ามา${periodFilter ? ` — รอบ ${periodLabel(periodFilter)}` : ''}`),
        el('div', { class: 'filters' },
          el('div', { class: 'field' }, el('label', {}, 'สถานะการแจ้ง'), slipStatusPicker())))
      : superTab === 'received'
        ? el('div', { class: 'toolbar' },
          el('h2', { class: 'section-title' },
            `เงินที่เข้ามาแล้ว${periodFilter ? ` — รอบ ${periodLabel(periodFilter)}` : ''} (${int(totals.receivedCount)})`))
        : '',

    superTabBody ?? '');
}
