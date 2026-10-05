import { api, qs } from '../api.js';
import { card, confirmAction, dateTh, dollars, el, formModal, int, money, periodBar, stat, table, toast, usdText } from '../ui.js';
import { periodLabel, periodOptions, periodRange, setWorkingPeriod, todayIso, workingPeriod } from '../period.js';
import { render } from '../app.js';
import { activityButton } from './activity.js';


/**
 * สมุดรายรับ-รายจ่ายของส่วนกลาง
 *
 * คนละเรื่องกับหน้า "ค่าใช้จ่าย/ส่วนลด" ซึ่งเป็นรายการที่เอาไปเรียกเก็บจากร้าน
 * หน้านี้คือต้นทุนและรายได้อื่นของเราเอง ไม่ไปโผล่ในบิลของใคร
 */
export async function ledgerView() {
  const periodCode = workingPeriod();
  const range = periodRange(periodCode);
  const res = await api.get(`/api/ledger${qs({ periodCode })}`);
  const s = res.summary;

  const periodPicker = el('select', {
    onchange: (e) => { setWorkingPeriod(e.target.value); render(); },
  }, ...periodOptions().map((o) => el('option', { value: o.value, selected: o.value === periodCode }, o.label)));

  const entryModal = (row) => formModal({
    title: row ? `แก้ไข — ${row.label}` : `บันทึกรายการ — รอบ ${periodLabel(periodCode)}`,
    submitLabel: row ? 'บันทึกการแก้ไข' : 'บันทึกรายการ',
    fields: [
      {
        name: 'kind',
        label: 'ประเภท',
        type: 'select',
        value: row?.kind ?? 'EXPENSE',
        options: [
          { value: 'EXPENSE', label: 'รายจ่าย (เงินออก)' },
          { value: 'INCOME', label: 'รายรับอื่น (เงินเข้า)' },
        ],
      },
      {
        name: 'label',
        label: 'ชื่อรายการ',
        required: true,
        value: row?.label ?? '',
        placeholder: 'เช่น ค่าขนส่งสินค้า / ค่าเช่าโกดัง / เงินคืนจากซัพพลายเออร์',
      },
      { name: 'amount', label: 'จำนวนเงิน (บาท)', type: 'number', step: '0.01', required: true, value: row?.amount ?? '' },
      {
        name: 'spentOn',
        label: 'วันที่เกิดรายการ',
        type: 'date',
        value: row?.spentOn ?? todayIso(),
        hint: 'เว้นว่างได้ ถ้าเป็นรายการของทั้งรอบ',
      },
      { name: 'note', label: 'หมายเหตุ', value: row?.note ?? '' },
    ],
    /*
     * บอกขอบเขตของหน้านี้ตรงจุดที่คนกำลังจะกรอก
     * เคยเข้าใจผิดว่าต้องมาคีย์เงินที่ร้านโอนเข้ามาด้วย ทั้งที่ตัวนั้นมาจากสลิปเองอยู่แล้ว
     */
    preview: (v) => el('div', { class: 'notice-box m-0' },
      v.kind === 'INCOME'
        ? 'เงินเข้าที่ไม่ได้มาจากบิล เช่น เงินคืนจากซัพพลายเออร์ ดอกเบี้ย ขายของเก่า'
        : 'ต้นทุนของส่วนกลาง เช่น ค่าขนส่ง ค่าเช่าโกดัง เงินเดือน',
      el('div', { class: 'sub-line mt-4' },
        'เงินที่ร้านโอนมาไม่ต้องคีย์ที่นี่ — ระบบนับให้เองตอนอนุมัติสลิป')),
    onSubmit: async (v) => {
      if (row) await api.patch(`/api/ledger/${row.id}`, v);
      else await api.post('/api/ledger', { ...v, periodCode });
      toast(row ? 'แก้ไขแล้ว' : 'บันทึกรายการแล้ว', 'success');
      render();
    },
  });

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'รายรับ-รายจ่ายของเรา'),
        el('p', { style: 'max-width:46ch' },
          `${periodLabel(periodCode)} — ต้นทุนและรายได้อื่นของส่วนกลาง ไม่เกี่ยวกับบิลที่เรียกเก็บจากร้าน`)),
      periodBar(periodPicker),
      el('div', { class: 'btn-row' },
        activityButton(['ledger'], { title: 'ประวัติรายรับ-รายจ่าย' }),
        el('button', { class: 'btn', onclick: () => entryModal(null) }, '+ บันทึกรายการ'))),

    el('div', { class: 'stat-grid' },
      // มาจากสลิปที่อนุมัติแล้วโดยอัตโนมัติ ไม่ได้คีย์ที่หน้านี้ — บอกไว้ให้ชัด ไม่งั้นดูเหมือนต้องกรอกเอง
      stat('เก็บเงินได้จริงในรอบนี้', money(s.collected) + ' ฿',
        `จากที่เรียกเก็บไป ${money(s.billed)} ฿${usdText(s.billedUsd)} · มาจากสลิปที่อนุมัติแล้ว ไม่ต้องคีย์`,
        { tone: 'sales', icon: '🏦', usd: s.collectedUsd }),
      stat('รายรับอื่น', money(s.income) + ' ฿', 'เงินเข้าที่ไม่ได้มาจากการเรียกเก็บ', { tone: 'income', icon: '➕', usd: s.incomeUsd }),
      stat('รายจ่าย', money(s.expense) + ' ฿', 'ต้นทุนของส่วนกลางในรอบนี้',
        { tone: s.expense > 0 ? 'warn' : 'muted', icon: '➖', usd: s.expenseUsd }),
      // ใช้เงินที่เก็บได้จริง ไม่ใช่ยอดที่เรียกเก็บ — เงินที่ร้านยังไม่จ่ายยังไม่ใช่กำไร
      stat('เหลือจริงในรอบนี้', money(s.net) + ' ฿', 'เก็บได้จริง + รายรับอื่น − รายจ่าย',
        { tone: s.net >= 0 ? 'income' : 'warn', icon: s.net >= 0 ? '✓' : '⚠', usd: s.netUsd })),

    card(null, table([
      {
        label: 'ประเภท',
        render: (r) => el('span', { class: `badge ${r.kind === 'INCOME' ? 'green' : 'amber'}` }, r.kindLabel),
        sortValue: (r) => r.kindLabel,
      },
      {
        label: 'รายการ',
        render: (r) => el('div', {}, el('strong', {}, r.label),
          r.note ? el('div', { class: 'sub-line' }, r.note) : ''),
        sortValue: (r) => r.label,
      },
      {
        label: 'จำนวน',
        num: true,
        sortValue: (r) => r.signedAmount,
        render: (r) => el('strong', { style: `color:var(--${r.kind === 'INCOME' ? 'success' : 'danger'})` },
          `${r.kind === 'INCOME' ? '+' : '−'}${money(r.amount)}`),
      },
      { label: 'วันที่', render: (r) => (r.spentOn ? dateTh(r.spentOn) : el('span', { class: 'muted' }, 'ทั้งรอบ')), sortValue: (r) => r.spentOn ?? '' },
      { label: 'บันทึกโดย', render: (r) => el('span', { class: 'muted' }, r.createdBy ?? '—') },
      {
        label: '',
        render: (r) => el('div', { class: 'btn-row' },
          el('button', { class: 'btn ghost sm', onclick: () => entryModal(r) }, 'แก้ไข'),
          el('button', {
            class: 'btn ghost sm danger',
            onclick: () => confirmAction(`ลบรายการ "${r.label}"?`, async () => {
              await api.del(`/api/ledger/${r.id}`);
              toast('ลบแล้ว', 'success');
              render();
            }),
          }, 'ลบ')),
      },
    ], res.items, {
      search: 'ค้นหารายการ…',
      empty: `รอบ ${periodLabel(periodCode)} ยังไม่มีต้นทุนหรือรายรับอื่นที่บันทึกไว้\n`
        + 'ตารางนี้เก็บเฉพาะค่าใช้จ่ายของส่วนกลาง (ค่าขนส่ง ค่าเช่า เงินเดือน) '
        + 'และเงินเข้าที่ไม่ได้มาจากบิล\nเงินที่ร้านโอนเข้ามาอยู่ในการ์ด "เก็บเงินได้จริง" ด้านบน ระบบนับให้เอง',
      footer: res.items.length
        ? ['', 'รวมในรอบนี้',
          el('div', {}, `+${money(s.income)} / −${money(s.expense)}`,
            s.incomeUsd || s.expenseUsd
              ? el('div', { class: 'usd-note' }, `≈ +${dollars(s.incomeUsd)} / −${dollars(s.expenseUsd)}`)
              : ''),
          '', '', '']
        : undefined,
    }), { tight: true }));
}
