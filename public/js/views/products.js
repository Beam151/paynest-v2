import { api, qs, session } from '../api.js';
import { badge, card, confirmAction, dateTh, el, formModal, infoModal, pct, table, toast } from '../ui.js';
import { todayIso } from '../period.js';
import { render } from '../app.js';
import { activityButton } from './activity.js';

export async function productsView() {
  const isSuper = session.isSuper;
  const [{ items: products }, franchises] = await Promise.all([
    api.get(`/api/products${qs({ status: 'ACTIVE' })}`),
    isSuper ? api.get('/api/franchises').then((r) => r.items) : Promise.resolve([]),
  ]);

  const franchiseOptions = [
    { value: '', label: '— ยังไม่มอบหมาย —' },
    ...franchises.filter((f) => f.status === 'ACTIVE').map((f) => ({ value: String(f.id), label: f.username })),
  ];

  const createModal = () => formModal({
    title: 'สร้างสินค้าใหม่',
    fields: [
      { name: 'sku', label: 'รหัสสินค้า', required: true, placeholder: 'COFFEE-KIT' },
      { name: 'name', label: 'ชื่อสินค้า', required: true },
      {
        name: 'commissionPct',
        label: '% ส่วนต่างที่ร้านต้องจ่าย',
        type: 'number',
        step: '0.01',
        required: true,
        hint: 'ตัดจากยอดขายของสินค้าชิ้นนี้ · สินค้าคนละชิ้นตั้งคนละ % ได้',
      },
      { name: 'franchiseId', label: 'มอบหมายให้ร้าน', type: 'select', options: franchiseOptions, hint: 'สินค้า 1 ชิ้นมอบหมายได้ร้านเดียว' },
      { name: 'description', label: 'รายละเอียด' },
    ],
    onSubmit: async (v) => {
      await api.post('/api/products', { ...v, franchiseId: v.franchiseId ? Number(v.franchiseId) : undefined });
      toast(`สร้างสินค้า ${v.sku} แล้ว`, 'success');
      render();
    },
  });

  const assignModal = (product) => formModal({
    title: `มอบหมาย ${product.sku}`,
    submitLabel: 'มอบหมาย',
    fields: [
      { name: 'franchiseId', label: 'ร้านค้า', type: 'select', required: true, options: franchiseOptions.slice(1) },
      { name: 'startDate', label: 'เริ่มวันที่', type: 'date', required: true, value: todayIso() },
      { name: 'endDate', label: 'สิ้นสุดวันที่', type: 'date', hint: 'เว้นว่าง = ไม่กำหนด' },
      { name: 'note', label: 'หมายเหตุ' },
    ],
    onSubmit: async (v) => {
      await api.post('/api/assignments', { ...v, productId: product.id, franchiseId: Number(v.franchiseId) });
      toast('มอบหมายสินค้าแล้ว', 'success');
      render();
    },
  });

  const editModal = (product) => formModal({
    title: `แก้ไข ${product.sku}`,
    fields: [
      { name: 'name', label: 'ชื่อสินค้า', required: true, value: product.name },
      {
        name: 'commissionPct',
        label: '% ส่วนต่างที่ร้านต้องจ่าย',
        type: 'number',
        step: '0.01',
        required: true,
        value: product.commissionPct,
        hint: 'แก้แล้วมีผลกับยอดที่บันทึกใหม่เท่านั้น ยอดเก่าไม่เปลี่ยน',
      },
      {
        name: 'status',
        label: 'สถานะ',
        type: 'select',
        value: product.status,
        options: [{ value: 'ACTIVE', label: 'ใช้งาน' }, { value: 'ARCHIVED', label: 'เก็บเข้าคลัง' }],
      },
    ],
    onSubmit: async (v) => {
      await api.patch(`/api/products/${product.id}`, v);
      toast('บันทึกแล้ว', 'success');
      render();
    },
  });

  const historyModal = async (product) => {
    const full = await api.get(`/api/products/${product.id}`);
    const modal = infoModal({ title: `ประวัติการมอบหมาย — ${product.sku}`, content: null });
    modal.body.append(table([
      { label: 'ร้านค้า', render: (a) => el('strong', {}, a.franchiseUsername) },
      { label: 'ช่วงเวลา', render: (a) => `${dateTh(a.startDate)} → ${a.endDate ? dateTh(a.endDate) : 'ไม่กำหนด'}` },
      { label: '%', num: true, render: (a) => pct(a.effectiveCommissionPct) },
      { label: 'สถานะ', render: (a) => badge(a.isActive ? 'ACTIVE' : 'CLOSED') },
      {
        label: '',
        render: (a) => (isSuper && a.isActive
          ? el('button', {
            class: 'btn ghost sm',
            onclick: () => formModal({
              title: `ปิดสัญญา ${product.sku}`,
              submitLabel: 'ปิดสัญญา',
              fields: [{
                name: 'endDate',
                label: 'ปิดสัญญาวันที่',
                type: 'date',
                required: true,
                value: todayIso(),
                hint: 'หลังปิดแล้วจะมอบหมายสินค้าชิ้นนี้ให้ร้านอื่นได้',
              }],
              onSubmit: async (v) => {
                await api.post(`/api/assignments/${a.id}/end`, v);
                toast('ปิดสัญญาแล้ว', 'success');
                modal.close();
                render();
              },
            }),
          }, 'ปิดสัญญา')
          : ''),
      },
    ], full.assignments, { empty: 'สินค้าชิ้นนี้ยังไม่เคยถูกมอบหมาย' }));
  };

  const columns = [
    { label: 'รายการ', render: (p) => el('div', {}, el('strong', {}, p.sku), el('div', { class: 'sub-line' }, p.name)) },
    {
      label: 'เจ้าของสิทธิ์ขาย',
      render: (p) => (p.currentAssignment
        ? el('div', {},
          el('strong', {}, p.currentAssignment.franchiseUsername),
          el('div', { class: 'sub-line' }, `ตั้งแต่ ${dateTh(p.currentAssignment.startDate)}`))
        : el('span', { class: 'badge amber' }, 'ยังไม่มอบหมาย')),
    },
    {
      label: '% ส่วนต่าง',
      num: true,
      render: (p) => el('strong', {}, pct(p.commissionPct)),
      sortValue: (p) => p.commissionPct,
    },
    { label: 'สถานะ', render: (p) => badge(p.status) },
  ];

  if (isSuper) {
    columns.push({
      label: '',
      render: (p) => el('div', { class: 'btn-row' },
        p.currentAssignment
          ? el('button', { class: 'btn ghost sm', onclick: () => historyModal(p) }, 'สัญญา')
          : el('button', { class: 'btn sm', onclick: () => assignModal(p) }, 'มอบหมาย'),
        el('button', { class: 'btn ghost sm', onclick: () => editModal(p) }, 'แก้ไข'),
        // สินค้าที่เคยมียอดขายจะโดนฝั่งเซิร์ฟเวอร์ปฏิเสธ พร้อมบอกให้ไปปิดใช้งานแทน
        el('button', {
          class: 'btn ghost sm danger',
          onclick: () => confirmAction(
            `ลบสินค้า ${p.sku} ถาวร?`,
            async () => {
              await api.del(`/api/products/${p.id}`);
              toast(`ลบ ${p.sku} แล้ว`, 'success');
              render();
            },
          ),
        }, 'ลบ')),
    });
  } else {
    columns.push({
      label: '',
      render: (p) => el('button', { class: 'btn ghost sm', onclick: () => historyModal(p) }, 'ดูสัญญา'),
    });
  }

  const unassigned = products.filter((p) => !p.currentAssignment).length;

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, isSuper ? 'สินค้าทั้งหมด' : 'สินค้าที่ได้รับมอบหมาย'),
        el('p', {}, isSuper
          ? `${products.length} รายการ · ยังไม่มอบหมาย ${unassigned} รายการ · สินค้า 1 ชิ้นมอบหมายได้ร้านเดียวต่อช่วงเวลา`
          : `${products.length} รายการที่คุณมีสิทธิ์ขายและต้องรายงานยอด`)),
      el('div', { class: 'btn-row' },
        activityButton(['product', 'assignment']),
        isSuper && el('button', { class: 'btn', onclick: createModal }, '+ สร้างสินค้าใหม่'))),

    card(null, table(columns, products, {
      search: 'ค้นหารหัสหรือชื่อสินค้า…',
      empty: isSuper
        ? { icon: '📦', title: 'ยังไม่มีสินค้า', detail: 'สร้างสินค้าแล้วมอบหมายให้ร้านพร้อม % ส่วนต่าง', action: { label: '+ สร้างสินค้าแรก', onClick: createModal } }
        : { icon: '📦', title: 'ทางเรายังไม่ได้มอบหมายสินค้าให้ร้าน' },
    }), { tight: true }));
}
