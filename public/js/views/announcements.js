import { api } from '../api.js';
import { card, confirmAction, dateTh, dateTimeTh, el, formModal, iconFor, infoModal, int, table, toast } from '../ui.js';
import { avatar } from '../charts.js';
import { todayIso } from '../period.js';
import { render } from '../app.js';

/*
 * กระดานประกาศถึงทุกร้าน — โปรโมชั่น สินค้าใหม่ วันหยุด ข่าวสาร
 * ร้านเห็นที่หน้าแรกของตัวเอง (ประกาศใหม่มีจุดสีฟ้าจนกว่าจะเปิดอ่าน)
 * ตั้งวันเริ่ม/วันหมดได้ — ประกาศวันหยุดล่วงหน้าแล้วให้หายเองหลังวันหยุด ไม่ต้องจำมาลบ
 */

const CATEGORIES = [
  { value: 'NEWS', label: '📣 ข่าวสาร' },
  { value: 'PROMO', label: '🏷️ โปรโมชั่น' },
  { value: 'PRODUCT', label: '📦 สินค้าใหม่' },
  { value: 'HOLIDAY', label: '📅 วันหยุด' },
];
const STATE_BADGE = {
  ACTIVE: ['green', 'กำลังแสดง'],
  SCHEDULED: ['blue', 'ตั้งเวลาไว้'],
  EXPIRED: ['gray', 'หมดอายุแล้ว'],
};

export async function announcementsView() {
  const { items } = await api.get('/api/announcements');
  const active = items.filter((a) => a.state === 'ACTIVE').length;

  const edit = (a) => formModal({
    title: a ? 'แก้ไขประกาศ' : 'ประกาศใหม่ถึงทุกร้าน',
    submitLabel: a ? 'บันทึก' : 'ประกาศ',
    fields: [
      { name: 'title', label: 'หัวข้อ', required: true, value: a?.title, placeholder: 'เช่น หยุดสงกรานต์ 13–15 เม.ย.' },
      { name: 'category', label: 'ประเภท', type: 'select', options: CATEGORIES, value: a?.category ?? 'NEWS' },
      { name: 'pinned', label: 'ปักหมุด', type: 'select', value: a?.pinned ? 'yes' : 'no',
        options: [{ value: 'no', label: 'ไม่ปัก' }, { value: 'yes', label: '📌 ปักไว้บนสุด' }] },
      { name: 'body', label: 'รายละเอียด', type: 'textarea', required: true, maxlength: 2000, value: a?.body },
      { name: 'startsAt', label: 'เริ่มแสดง', type: 'date', value: a?.startsAt ?? todayIso() },
      { name: 'endsAt', label: 'แสดงถึงวันที่', type: 'date', value: a?.endsAt ?? '', hint: 'เว้นว่าง = แสดงไปเรื่อย ๆ' },
    ],
    onSubmit: async (v) => {
      if (!v.title || !v.body) throw new Error('กรอกหัวข้อและรายละเอียดให้ครบ');
      if (v.endsAt && v.startsAt && v.endsAt < v.startsAt) throw new Error('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
      const payload = {
        title: v.title,
        body: v.body,
        category: v.category,
        pinned: v.pinned === 'yes',
        startsAt: v.startsAt,
        endsAt: v.endsAt ?? null,
      };
      if (a) await api.patch(`/api/announcements/${a.id}`, payload);
      else await api.post('/api/announcements', payload);
      toast(a ? 'บันทึกประกาศแล้ว' : 'ประกาศแล้ว — ร้านจะเห็นที่หน้าแรก', 'success');
      render();
    },
  });

  const newButton = el('button', { class: 'btn', onclick: () => edit(null) }, '+ ประกาศใหม่');

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {}, el('h1', {}, 'ประกาศถึงร้าน'),
        el('p', {}, `แสดงที่หน้าแรกของทุกร้าน · กำลังแสดง ${int(active)} เรื่อง`)),
      el('div', { class: 'btn-row' }, newButton)),

    card(null, items.length
      ? table([
        {
          label: 'ประกาศ',
          render: (a) => el('div', { class: 'avatar-row' },
            el('span', { class: 'ann-ico' }, iconFor(CATEGORIES.find((c) => c.value === a.category)?.label.split(' ')[0])),
            el('div', {},
              el('strong', {}, a.pinned ? '📌 ' : '', a.title),
              el('div', { class: 'sub-line', style: 'max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
                `${a.categoryLabel} · ${a.body}`))),
          sortValue: (a) => a.title,
        },
        {
          label: 'ช่วงแสดง',
          render: (a) => `${dateTh(a.startsAt)} – ${a.endsAt ? dateTh(a.endsAt) : 'ไม่กำหนด'}`,
          sortValue: (a) => a.startsAt,
        },
        { label: 'สถานะ', render: (a) => badgeOf(a.state), sortValue: (a) => a.state },
        {
          label: 'ร้านที่อ่านแล้ว',
          sortValue: (a) => (a.reach?.total ? a.reach.read / a.reach.total : -1),
          render: (a) => (a.state === 'SCHEDULED' || !a.reach
            ? el('span', { class: 'muted' }, '—')
            : el('button', { class: 'reach', onclick: () => readersModal(a), title: 'ดูว่าร้านไหนยังไม่อ่าน' },
              el('span', { class: 'reach-text' }, `${int(a.reach.read)}/${int(a.reach.total)} ร้าน`),
              el('span', { class: 'reach-track' },
                el('span', { style: `width:${a.reach.total ? Math.round((a.reach.read / a.reach.total) * 100) : 0}%` })))),
        },
        {
          label: '',
          sortable: false,
          render: (a) => el('div', { class: 'btn-row', style: 'justify-content:flex-end;flex-wrap:nowrap' },
            el('button', { class: 'btn ghost sm', onclick: () => edit(a) }, 'แก้ไข'),
            el('button', {
              class: 'btn ghost sm',
              onclick: () => confirmAction(`ลบประกาศ "${a.title}"? ร้านจะไม่เห็นอีก`, async () => {
                await api.del(`/api/announcements/${a.id}`);
                toast('ลบประกาศแล้ว', 'success');
                render();
              }),
            }, 'ลบ')),
        },
      ], items, { search: 'ค้นหาประกาศ…' })
      : el('div', { class: 'empty' },
        iconFor('📣'),
        el('div', {}, 'ยังไม่มีประกาศ'),
        el('div', { class: 'sub-line' }, 'แจ้งโปรโมชั่น สินค้าใหม่ หรือวันหยุด ให้ทุกร้านเห็นที่หน้าแรก'),
        el('button', { class: 'btn', onclick: () => edit(null) }, '+ เขียนประกาศแรก')),
    { tight: items.length > 0 }));
}

/** ร้านไหนอ่านแล้ว / ยังไม่อ่าน — ยังไม่อ่านขึ้นก่อน พร้อมเบอร์โทร ประกาศสำคัญจะได้โทรตามได้เลย */
async function readersModal(a) {
  const { read, unread } = await api.get(`/api/announcements/${a.id}/readers`);
  infoModal({
    title: `ใครอ่านแล้ว — ${a.title}`,
    width: 620,
    content: el('div', {},
      el('p', { class: 'sub-line mt-0' },
        `อ่านแล้ว ${int(read.length)} จาก ${int(read.length + unread.length)} ร้าน · นับว่าอ่านเมื่อมีคนในร้านเปิดประกาศนี้ที่หน้าแรก`),
      el('h3', { style: 'margin:12px 0 8px' }, `ยังไม่อ่าน (${int(unread.length)})`),
      table([
        { label: 'ร้าน', render: (s) => avatar(s.username, { sub: s.contactName ?? '' }), sortValue: (s) => s.username },
        { label: 'โทร', render: (s) => (s.phone ? el('a', { href: `tel:${s.phone}` }, s.phone) : el('span', { class: 'muted' }, '—')) },
      ], unread, { sortable: false, empty: { icon: '✓', title: 'ทุกร้านอ่านแล้ว' } }),
      el('h3', { style: 'margin:18px 0 8px' }, `อ่านแล้ว (${int(read.length)})`),
      table([
        { label: 'ร้าน', render: (s) => avatar(s.username, { sub: s.readBy ? `เปิดอ่านโดย ${s.readBy}` : '' }), sortValue: (s) => s.username },
        { label: 'เมื่อ', render: (s) => dateTimeTh(s.readAt), sortValue: (s) => s.readAt },
      ], read, { sortable: false, empty: 'ยังไม่มีร้านไหนเปิดอ่าน' })),
  });
}

function badgeOf(state) {
  const [tone, label] = STATE_BADGE[state] ?? ['gray', state];
  return el('span', { class: `badge ${tone}` }, label);
}
