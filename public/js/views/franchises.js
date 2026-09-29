import { api, session } from '../api.js';
import { elevated } from '../elevation.js';
import {
  badge, card, confirmAction, copyButton, copyText, dateTimeTh, el, formModal, infoModal, int, loginSetBox, loginSetModal,
  loginSetText, loginUrl, money, randomPassword, resetPasswordModal, table, toast,
} from '../ui.js';
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

  /** ลิงก์เข้าระบบของร้าน (API ส่งมาแค่ path) — โหลดไม่ได้คืน null ให้คนเรียกบอกทางออกเอง */
  const fetchLink = (franchiseId) => api.get(`/api/franchises/${franchiseId}/login-link`).catch(() => null);

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
      // สุ่มไว้ให้เลย — ส่งให้ร้านเป็นชุดพร้อมลิงก์หลังกดสร้าง ไม่ต้องคิดรหัสเอง
      { name: 'password', label: 'รหัสผ่าน', required: true, value: randomPassword(), hint: 'สุ่มให้แล้ว แก้เองได้ · อย่างน้อย 8 ตัวอักษร' },
      { name: 'contactName', label: 'ผู้ติดต่อ' },
      { name: 'phone', label: 'เบอร์โทร' },
      { name: 'email', label: 'อีเมล' },
    ],
    onSubmit: async (v) => {
      const res = await api.post('/api/franchises', v);
      render();
      // ร้านเข้าได้ทางลิงก์ของร้านเท่านั้น — ชุดที่ส่งให้ต้องมีลิงก์ด้วย ไม่งั้นร้านได้รหัสไปก็เข้าไม่ได้
      const shop = res.franchise ?? { id: null, username: v.username };
      const link = res.loginLink ?? (shop.id ? await fetchLink(shop.id) : null);
      loginSetModal({
        heading: `สร้างร้าน ${shop.username} แล้ว — ส่งข้อมูลเข้าระบบให้ร้าน`,
        title: `ร้าน ${shop.username}`,
        url: link ? loginUrl(link.path) : null,
        username: res.user?.username ?? v.username,
        password: v.password,
        mustChange: Boolean(res.user?.mustChangePassword),
        note: link ? undefined
          : 'โหลดลิงก์เข้าระบบของร้านไม่ได้ — คัดลอกชุดนี้ไว้ก่อน (รหัสผ่านจะไม่แสดงอีก) แล้วกด "🔗 ลิงก์เข้าระบบ" ของร้านนี้ในตารางเพื่อส่งลิงก์ตามไป',
      });
    },
  });

  /**
   * ลิงก์เข้าระบบของร้าน — ร้านเข้าได้ทางลิงก์นี้เท่านั้น (รู้รหัสผ่านอย่างเดียวเข้าไม่ได้)
   * "สร้างลิงก์ใหม่" ใช้ตอนสงสัยว่าลิงก์หลุด: ลิงก์เดิมตายทันที และทุกคนของร้านถูกออกจากระบบ
   */
  const linkModal = async (row) => {
    const modal = infoModal({ title: `ลิงก์เข้าระบบของร้าน ${row.username}`, width: 560, content: el('div', { class: 'loading' }, 'กำลังโหลด…') });

    // ใช้ทั้งตอนเห็นลิงก์ และตอนอ่านลิงก์เดิมไม่ได้ (เซิร์ฟเวอร์บอกให้กด "สร้างลิงก์ใหม่" — ปุ่มต้องอยู่ให้กด)
    const rotateZone = () => el('div', { class: 'danger-zone mt-16' },
      el('div', {},
        el('strong', {}, 'ลิงก์หลุดไปถึงคนอื่น?'),
        el('div', { class: 'sub-line' }, 'สร้างลิงก์ใหม่แล้วลิงก์เดิมใช้ไม่ได้ทันที ผู้ใช้ทุกคนของร้านถูกออกจากระบบ ต้องส่งลิงก์ใหม่ให้ร้านอีกครั้ง')),
      el('button', {
        type: 'button',
        class: 'btn ghost danger sm',
        onclick: () => confirmAction(
          `สร้างลิงก์เข้าระบบใหม่ให้ร้าน ${row.username}?\n\n`
          + '• ลิงก์เดิมใช้ไม่ได้ทันที\n'
          + '• ผู้ใช้ทุกคนของร้าน (เจ้าของและผู้ช่วย) ถูกออกจากระบบทุกเครื่อง\n'
          + '• ต้องส่งลิงก์ใหม่ให้ร้านอีกครั้ง (ร้านเปิดลิงก์ใหม่ก่อนถึงจะเข้าได้)',
          async () => {
            const fresh = await elevated(
              (opts) => api.post(`/api/franchises/${row.id}/login-link/rotate`, {}, opts),
              `สร้างลิงก์เข้าระบบใหม่ของร้าน ${row.username} — ทุกคนของร้านจะถูกออกจากระบบ ต้องยืนยันว่าเป็นคุณจริง`,
            );
            paint(fresh);
            toast('สร้างลิงก์ใหม่แล้ว — ลิงก์เดิมใช้ไม่ได้ และทุกคนของร้านถูกออกจากระบบ · ส่งลิงก์ใหม่ให้ร้านได้เลย', 'success');
          },
        ),
      }, 'สร้างลิงก์ใหม่'));

    const paint = (link) => {
      const url = loginUrl(link.path);
      const urlInput = el('input', { type: 'text', readonly: true, value: url, 'aria-label': 'ลิงก์เข้าระบบของร้าน' });
      urlInput.addEventListener('focus', () => urlInput.select());
      modal.body.replaceChildren(
        el('p', { class: 'm-0' },
          'ส่งลิงก์นี้ให้เจ้าของร้าน — ใครไม่มีลิงก์นี้ เข้าระบบของร้านไม่ได้แม้รู้รหัสผ่าน · ผู้ช่วยของร้าน เจ้าของร้านส่งต่อให้เองจากหน้า "บัญชีของฉัน"'),
        el('div', { class: 'login-link-row mt-12' },
          urlInput,
          copyButton(url, '📋 คัดลอกลิงก์', { toastText: `คัดลอกลิงก์เข้าระบบของร้าน ${row.username} แล้ว` })),
        link.rotatedAt ? el('div', { class: 'sub-line mt-4' }, `สร้างลิงก์นี้เมื่อ ${dateTimeTh(link.rotatedAt)}`) : '',

        el('h3', { class: 'mt-16 mb-8' }, 'ข้อมูลเข้าระบบของเจ้าของร้าน'),
        // ยูสเซอร์เจ้าของร้าน = username ของร้าน (ตั้งพร้อมกันตอนสร้างร้าน)
        loginSetBox({ title: `ร้าน ${row.username}`, url, username: row.username }),
        el('button', {
          type: 'button',
          class: 'btn ghost sm mt-8',
          onclick: async () => {
            const users = await api.get(`/api/franchises/${row.id}/users`).then((r) => r.items).catch((err) => {
              toast(err.fullMessage ?? err.message, 'error');
              return null;
            });
            if (!users) return;
            const owner = users.find((u) => u.isOwner);
            if (!owner) { toast('ไม่พบบัญชีเจ้าของร้าน — เปิด "ยูสเซอร์" ของร้านนี้แทน', 'error'); return; }
            resetPasswordModal({
              username: owner.username,
              title: `ร้าน ${row.username}`,
              url,
              run: (body) => api.post(`/api/franchises/${row.id}/users/${owner.id}/reset-password`, body),
            });
          },
        }, '🔑 ตั้งรหัสใหม่ + คัดลอก (เจ้าของร้าน)'),

        rotateZone());
    };
    try {
      paint(await api.get(`/api/franchises/${row.id}/login-link`));
    } catch (err) {
      modal.body.replaceChildren(el('div', { class: 'error-box' }, err.fullMessage ?? err.message), rotateZone());
    }
  };

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
    // โหลดลิงก์ร้านมาก่อน — ปุ่มคัดลอกต้องคัดลอกได้ทันทีที่กด (Safari ไม่ยอมคัดลอกหลังรอ API)
    const [{ items: users }, link] = await Promise.all([
      api.get(`/api/franchises/${row.id}/users`),
      fetchLink(row.id),
    ]);
    const url = link ? loginUrl(link.path) : null;
    const modal = infoModal({ title: `ยูสเซอร์ของ ${row.username}`, width: 860, content: null });
    modal.body.append(
      el('div', { class: 'login-hint', style: 'margin-bottom:14px' },
        'ส่วนกลางสร้างให้ได้แค่บัญชีเจ้าของตอนเปิดร้านเท่านั้น — ผู้ช่วยคนถัดไปเจ้าของบัญชีเพิ่มเองจากหน้า "บัญชีของฉัน"',
        el('br'),
        'รหัสผ่านที่ตั้งไว้แล้วดูย้อนหลังไม่ได้ — "📋 คัดลอกข้อมูลเข้าระบบ" ได้ลิงก์กับชื่อผู้ใช้ · ต้องส่งรหัสด้วย ใช้ "🔑 ตั้งรหัสใหม่ + คัดลอก" (เข้าครั้งแรกระบบจะให้ตั้งรหัสของตัวเอง)'),
      url ? '' : el('div', { class: 'notice-box' }, 'โหลดลิงก์เข้าระบบของร้านไม่ได้ — ชุดที่คัดลอกจะไม่มีลิงก์ เปิด "🔗 ลิงก์เข้าระบบ" ของร้านเพื่อคัดลอกลิงก์แยก'),
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
              onclick: () => copyText(
                loginSetText({ title: `ร้าน ${row.username}`, url, username: u.username }),
                `คัดลอกข้อมูลเข้าระบบของ ${u.username} แล้ว (ไม่มีรหัสผ่าน — รหัสเดิมดูย้อนหลังไม่ได้)`,
              ),
            }, '📋 คัดลอกข้อมูลเข้าระบบ'),
            el('button', {
              class: 'btn ghost sm',
              onclick: () => resetPasswordModal({
                username: u.username,
                title: `ร้าน ${row.username}`,
                url,
                run: (body) => api.post(`/api/franchises/${row.id}/users/${u.id}/reset-password`, body),
              }),
            }, '🔑 ตั้งรหัสใหม่ + คัดลอก'),
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
        el('p', {}, 'username เดียวใช้ทั้งเข้าระบบและระบุร้านค้า · ร้านเข้าระบบผ่านลิงก์ของร้านเท่านั้น (ปุ่ม "🔗 ลิงก์เข้าระบบ") — ผู้ช่วยเพิ่มเติม เจ้าของบัญชีเป็นคนเพิ่มเอง')),
      el('div', { class: 'btn-row' },
        // user = ตั้งรหัสใหม่ให้ผู้ใช้ของร้าน (ทำจากหน้านี้) — ต้องเห็นในประวัติของหน้านี้ด้วย ไม่ใช่แค่ประวัติรวม
        activityButton(['franchise', 'user']),
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
          el('button', { class: 'btn ghost sm', onclick: () => linkModal(r) }, '🔗 ลิงก์เข้าระบบ'),
          el('button', { class: 'btn ghost sm', onclick: () => showUsers(r) }, 'ยูสเซอร์'),
          el('button', { class: 'btn ghost sm', onclick: () => editModal(r) }, 'แก้ไข')),
      },
    ], items, { search: 'ค้นหา username หรือผู้ติดต่อ…', empty: { icon: '🏪', title: 'ยังไม่มีร้านค้า', detail: 'สร้างร้านแล้วคัดลอกชุดข้อมูลเข้าระบบ (ลิงก์ + ชื่อผู้ใช้ + รหัสผ่าน) ส่งให้ร้านได้เลย', action: { label: '+ สร้างร้านแรก', onClick: createModal } } }), { tight: true }));
}
