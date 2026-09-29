import { api } from '../api.js';
import { badge, card, confirmAction, el, formModal, money, table, toast } from '../ui.js';
import { render } from '../app.js';
import { activityButton } from './activity.js';

/** รายการค่าใช้จ่าย/ส่วนลดตั้งต้น ที่หยิบมาใส่บิลได้เร็ว ๆ ตอนออกใบเรียกเก็บ */
export async function chargeItemsView() {
  const { items } = await api.get('/api/charge-items?status=');

  const KIND_OPTIONS = [
    { value: 'CHARGE', label: 'ค่าใช้จ่าย (บวกเพิ่ม)' },
    { value: 'DISCOUNT', label: 'ส่วนลด (หักออก)' },
  ];

  // เลือกวิธีคิดก่อน แล้วค่อยโชว์ช่องกรอกที่ตรงกับวิธีนั้น
  const BASIS_OPTIONS = [
    { value: 'AMOUNT', label: 'จำนวนเงิน (บาท)' },
    { value: 'PERCENT', label: '% ของส่วนต่าง' },
    { value: 'EACH_TIME', label: 'กรอกทุกครั้งตอนออกบิล' },
  ];

  const basisOf = (row) => (row.defaultPct !== null ? 'PERCENT' : row.defaultAmount !== null ? 'AMOUNT' : 'EACH_TIME');

  /** แปลงค่าจากฟอร์มเป็น payload — ส่งเฉพาะช่องที่ตรงกับวิธีคิดที่เลือก */
  const toPayload = (v) => ({
    ...v,
    basis: undefined,
    amount: undefined,
    defaultAmount: v.basis === 'AMOUNT' ? v.amount : null,
    defaultPct: v.basis === 'PERCENT' ? v.amount : null,
  });

  // ช่องกรอกค่าเดียว หัวข้อเปลี่ยนตามวิธีคิดที่เลือก
  const amountField = (value) => ({
    name: 'amount',
    label: (v) => (v.basis === 'PERCENT' ? '% ของส่วนต่าง' : 'จำนวนเงิน (บาท)'),
    type: 'number',
    step: '0.01',
    required: true,
    value,
    showWhen: (v) => v.basis !== 'EACH_TIME',
  });

  const createModal = () => formModal({
    title: 'เพิ่มรายการตั้งต้น',
    fields: [
      { name: 'name', label: 'ชื่อรายการ', required: true, placeholder: 'ค่าอบรมพนักงาน' },
      { name: 'kind', label: 'ประเภท', type: 'select', required: true, options: KIND_OPTIONS },
      { name: 'basis', label: 'คิดแบบ', type: 'select', required: true, options: BASIS_OPTIONS },
      { ...amountField(''), hint: 'เลือก "กรอกทุกครั้ง" ถ้าจำนวนไม่คงที่' },
      { name: 'description', label: 'คำอธิบาย' },
    ],
    onSubmit: async (v) => {
      await api.post('/api/charge-items', toPayload(v));
      toast(`เพิ่มรายการ ${v.name} แล้ว`, 'success');
      render();
    },
  });

  const editModal = (row) => formModal({
    title: `แก้ไข ${row.name}`,
    fields: [
      { name: 'name', label: 'ชื่อรายการ', required: true, value: row.name },
      { name: 'basis', label: 'คิดแบบ', type: 'select', required: true, value: basisOf(row), options: BASIS_OPTIONS },
      amountField(row.defaultPct ?? row.defaultAmount ?? ''),
      { name: 'description', label: 'คำอธิบาย', value: row.description ?? '' },
      {
        name: 'status',
        label: 'สถานะ',
        type: 'select',
        value: row.status,
        // คำเดียวกับหน้าสินค้า — "ปิดใช้งาน" = ไม่โผล่ให้เลือกตอนออกบิลใหม่ บิลเก่าที่ใช้ไปแล้วไม่เปลี่ยน
        options: [{ value: 'ACTIVE', label: 'ใช้งาน' }, { value: 'ARCHIVED', label: 'ปิดใช้งาน' }],
      },
    ],
    onSubmit: async (v) => {
      await api.patch(`/api/charge-items/${row.id}`, toPayload(v));
      toast('บันทึกแล้ว', 'success');
      render();
    },
  });

  /*
   * ลบถาวร (เจ้าของระบบ: "หน้านี้ต้องกดลบได้") — บิลที่เคยใช้ไม่เสียหาย เพราะบิลเก็บชื่อและยอดของตัวเองไว้แล้ว
   * บอกให้ชัดตอนถาม คนลบจะได้ไม่กังวลว่าบิลเก่าจะเปลี่ยน · ถ้าแค่ไม่อยากให้เลือกชั่วคราว ใช้ "ปิดใช้งาน" แทน
   */
  const deleteItem = (row) => confirmAction(
    `ลบรายการ "${row.name}" ถาวร?\n\n`
    + 'บิลที่เคยใส่รายการนี้ยังแสดงชื่อและยอดเดิมครบ — แค่เลือกรายการนี้ตอนออกบิลใหม่ไม่ได้แล้ว\n'
    + 'ถ้าแค่ไม่อยากให้เลือกชั่วคราว ให้กด "แก้ไข" แล้วตั้งเป็น "ปิดใช้งาน" แทน',
    async () => {
      const res = await api.del(`/api/charge-items/${row.id}`);
      toast(res.usedOnBills
        ? `ลบ "${row.name}" แล้ว — บิลเดิม ${res.usedOnBills} รายการยังแสดงยอดเหมือนเดิม`
        : `ลบ "${row.name}" แล้ว`, 'success');
      render();
    },
  );

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'รายการค่าใช้จ่าย / ส่วนลด'),
        el('p', {}, 'ตั้งไว้ล่วงหน้าเพื่อหยิบใส่บิลได้เร็ว ตอนออกใบเรียกเก็บยังพิมพ์รายการใหม่เองได้เสมอ')),
      el('div', { class: 'btn-row' },
        activityButton(['charge_item']),
        el('button', { class: 'btn', onclick: createModal }, '+ เพิ่มรายการ'))),

    card(null, table([
      { label: 'ชื่อรายการ', render: (r) => el('strong', {}, r.name) },
      {
        label: 'ประเภท',
        render: (r) => el('span', { class: `badge ${r.kind === 'DISCOUNT' ? 'green' : 'amber'}` }, r.kindLabel),
      },
      {
        label: 'ค่าตั้งต้น',
        num: true,
        render: (r) => (r.defaultPct !== null ? `${r.defaultPct}% ของส่วนต่าง`
          : r.defaultAmount !== null ? `${money(r.defaultAmount)} ฿`
            : el('span', { class: 'muted' }, 'กรอกทุกครั้ง')),
      },
      { label: 'คำอธิบาย', render: (r) => el('span', { class: 'muted' }, r.description ?? '—') },
      { label: 'สถานะ', render: (r) => badge(r.status) },
      {
        label: '',
        render: (r) => el('div', { class: 'btn-row' },
          el('button', { class: 'btn ghost sm', onclick: () => editModal(r) }, 'แก้ไข'),
          el('button', { class: 'btn ghost sm danger', onclick: () => deleteItem(r) }, 'ลบ')),
      },
    ], items, { empty: { icon: '🏷', title: 'ยังไม่มีรายการค่าใช้จ่าย/ส่วนลด', detail: 'เช่น ค่าขนส่ง ค่าบริการรายเดือน ส่วนลดโปรโมชั่น — ตั้งไว้แล้วเลือกใส่บิลได้เลย', action: { label: '+ เพิ่มรายการแรก', onClick: createModal } } }), { tight: true }));
}
