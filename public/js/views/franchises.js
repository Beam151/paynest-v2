import { api, session } from '../api.js';
import { elevated } from '../elevation.js';
import { badge, card, confirmAction, el, formModal, infoModal, int, money, table, toast } from '../ui.js';
import { hashParam, render } from '../app.js';
import { statementView } from './statement.js';
import { activityButton } from './activity.js';
import { avatar } from '../charts.js';

export async function franchisesView() {
  // #/franchises?shop=12 = หน้ารายร้าน
  const shopId = Number(hashParam('shop'));
  if (shopId) return statementView(shopId);

  const [{ items }, unpaid] = await Promise.all([
    api.get('/api/franchises'),
    api.get('/api/payments/outstanding').then((r) => r.items).catch(() => []),
  ]);
  // ยอดค้างต่อร้าน — ตอบ "ร้านไหนค้างเท่าไร" ได้จากรายชื่อเลย ไม่ต้องไปไล่หน้าบิล
  const owing = new Map();
  for (const inv of unpaid) {
    const cur = owing.get(inv.franchiseId) ?? { amount: 0, overdue: 0, days: 0 };
    cur.amount += inv.outstanding;
    if (inv.isOverdue) { cur.overdue += inv.outstanding; cur.days = Math.max(cur.days, inv.daysOverdue); }
    owing.set(inv.franchiseId, cur);
  }

  const createModal = () => formModal({
    title: 'สร้างร้านค้าใหม่',
    submitLabel: 'สร้างร้านค้า',
    fields: [
      {
        name: 'username',
        label: 'Username',
        required: true,
        placeholder: 'bkk02',
        hint: 'ใช้เข้าสู่ระบบและเป็นตัวระบุร้านค้า · a-z 0-9 . _ - เท่านั้น',
      },
      { name: 'password', label: 'รหัสผ่าน', required: true, hint: 'อย่างน้อย 8 ตัวอักษร' },
      { name: 'contactName', label: 'ผู้ติดต่อ' },
      { name: 'phone', label: 'เบอร์โทร' },
      { name: 'email', label: 'อีเมล' },
    ],
    onSubmit: async (v) => {
      await api.post('/api/franchises', v);
      toast(`สร้างร้านค้าแล้ว — ให้ลูกค้าล็อกอินด้วย ${v.username}`, 'success');
      render();
    },
  });

  const editModal = (row) => formModal({
    title: `แก้ข้อมูล ${row.username}`,
    fields: [
      { name: 'contactName', label: 'ผู้ติดต่อ', value: row.contactName ?? '' },
      { name: 'phone', label: 'เบอร์โทร', value: row.phone ?? '' },
      { name: 'email', label: 'อีเมล', value: row.email ?? '' },
      {
        name: 'status',
        label: 'สถานะ',
        type: 'select',
        value: row.status,
        options: [
          { value: 'ACTIVE', label: 'ใช้งาน' },
          { value: 'SUSPENDED', label: 'ระงับชั่วคราว' },
          { value: 'CLOSED', label: 'ปิดร้าน' },
        ],
      },
    ],
    onSubmit: async (v) => {
      await api.patch(`/api/franchises/${row.id}`, v);
      toast('บันทึกแล้ว', 'success');
      render();
    },
  });

  const showUsers = async (row) => {
    const { items: users } = await api.get(`/api/franchises/${row.id}/users`);
    const modal = infoModal({ title: `ยูสเซอร์ของ ${row.username}`, content: null });
    modal.body.append(
      el('div', { class: 'login-hint', style: 'margin-bottom:14px' },
        'ส่วนกลางสร้างให้ได้แค่บัญชีเจ้าของตอนเปิดร้านเท่านั้น — ผู้ช่วยคนถัดไปเจ้าของบัญชีเพิ่มเองจากหน้า "บัญชีของฉัน"'),
      table([
        { label: 'ชื่อผู้ใช้', render: (u) => el('strong', {}, u.username) },
        { label: 'ชื่อที่แสดง', render: (u) => u.displayName ?? '—' },
        {
          label: 'ประเภท',
          render: (u) => el('span', { class: `badge ${u.isOwner ? 'blue' : 'gray'}` }, u.isOwner ? 'เจ้าของบัญชี' : 'ผู้ช่วย'),
        },
        { label: 'สถานะ', render: (u) => badge(u.status) },
        {
          label: '',
          render: (u) => el('div', { class: 'btn-row' },
            el('button', {
              class: 'btn ghost sm',
              onclick: () => formModal({
                title: `ตั้งรหัสผ่านใหม่ให้ ${u.username}`,
                fields: [{ name: 'newPassword', label: 'รหัสผ่านใหม่', required: true, hint: 'อย่างน้อย 8 ตัวอักษร' }],
                onSubmit: async (v) => {
                  await api.post(`/api/franchises/${row.id}/users/${u.id}/reset-password`, v);
                  toast('ตั้งรหัสผ่านใหม่แล้ว', 'success');
                },
              }),
            }, 'ตั้งรหัสใหม่'),
            // ร้านทำมือถือหาย — ปลดให้ล็อกอินด้วยรหัสผ่านได้ แล้วค่อยให้ร้านตั้งใหม่เอง
            u.twoFactorEnabled
              ? el('button', {
                class: 'btn ghost sm',
                onclick: () => confirmAction(
                  `ปลด Google Authenticator ของ ${u.username}? ใช้เมื่อยืนยันแล้วว่าเป็นเจ้าของบัญชีจริงที่ทำมือถือหาย`,
                  async () => {
                    await elevated(
                      (opts) => api.post(`/api/auth/users/${u.id}/reset-2fa`, {}, opts),
                      `ปลด 2FA ของ ${u.username} — คนที่ได้รหัสผ่านร้านไปจะเข้าได้ทันที ต้องยืนยันว่าเป็นคุณ`,
                    );
                    toast('ปลดแล้ว — ร้านล็อกอินด้วยรหัสผ่านได้ และควรตั้งใหม่ทันที', 'success');
                    modal.close();
                  },
                ),
              }, '📱 ปลด 2FA')
              : '',
            el('button', {
              class: 'btn ghost sm',
              onclick: () => confirmAction(
                `${u.status === 'ACTIVE' ? 'ปิด' : 'เปิด'}การใช้งานบัญชี ${u.username}?`,
                async () => {
                  await api.patch(`/api/franchises/${row.id}/users/${u.id}/status`, {
                    status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
                  });
                  toast('อัปเดตแล้ว', 'success');
                  modal.close();
                  render();
                },
              ),
            }, u.status === 'ACTIVE' ? 'ปิดใช้งาน' : 'เปิดใช้งาน')),
        },
      ], users));
  };

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'ร้านค้า'),
        el('p', {}, 'username เดียวใช้ทั้งเข้าระบบและระบุร้านค้า — ผู้ช่วยเพิ่มเติม เจ้าของบัญชีเป็นคนเพิ่มเอง')),
      el('div', { class: 'btn-row' },
        activityButton(['franchise']),
        el('button', { class: 'btn', onclick: createModal }, '+ สร้างร้านค้าใหม่'))),

    card(null, table([
      {
        label: 'Username',
        sortValue: (r) => r.username,
        render: (r) => el('a', { href: `#/franchises?shop=${r.id}`, class: 'plain-link', title: 'ดูบิล ยอดค้าง และเงินที่ได้รับของร้านนี้' },
          avatar(r.username, { sub: r.contactName })),
      },
      {
        label: 'ผู้ติดต่อ',
        render: (r) => el('div', {}, r.contactName ?? '—', el('div', { class: 'sub-line' }, r.phone ?? r.email ?? '')),
      },
      {
        label: 'ค้างชำระ',
        num: true,
        sortValue: (r) => owing.get(r.id)?.amount ?? 0,
        render: (r) => {
          const o = owing.get(r.id);
          if (!o || o.amount <= 0) return el('span', { class: 'muted' }, '—');
          return el('div', {},
            el('strong', {}, money(o.amount)),
            o.overdue > 0 ? el('div', { class: 'overdue-tag' }, `เลยกำหนด ${money(o.overdue)} · ${int(o.days)} วัน`) : '');
        },
      },
      { label: 'สินค้าที่ถือ', num: true, render: (r) => int(r.activeProductCount ?? 0) },
      { label: 'ยูสเซอร์', num: true, render: (r) => int(r.userCount ?? 0) },
      { label: 'สถานะ', render: (r) => badge(r.status) },
      {
        label: '',
        render: (r) => el('div', { class: 'btn-row' },
          el('button', {
            class: 'btn ghost sm',
            title: 'ดูว่าร้านค้ารายนี้เห็นอะไรบ้าง',
            onclick: () => {
              session.setViewAs({ role: 'FRANCHISE', id: r.id, username: r.username });
              location.hash = '#/dashboard';
              render();
            },
          }, '👁 ดูมุมมองนี้'),
          el('a', { class: 'btn ghost sm', href: `#/franchises?shop=${r.id}` }, 'บิลและยอดค้าง'),
          el('button', { class: 'btn ghost sm', onclick: () => showUsers(r) }, 'ยูสเซอร์'),
          el('button', { class: 'btn ghost sm', onclick: () => editModal(r) }, 'แก้ไข')),
      },
    ], items, { search: 'ค้นหา username หรือผู้ติดต่อ…', empty: { icon: '🏪', title: 'ยังไม่มีร้านค้า', detail: 'สร้างร้านแล้วส่งชื่อผู้ใช้/รหัสผ่านให้ร้านเข้าระบบได้เลย', action: { label: '+ สร้างร้านแรก', onClick: createModal } } }), { tight: true }));
}
