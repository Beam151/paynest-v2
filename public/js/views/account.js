import { api, session } from '../api.js';
import { dateTimeTh, badge, card, confirmAction, el, field, formModal, icon, infoModal, table, toast } from '../ui.js';
import { backupCodesBox, enrollFlow } from './twoFactor.js';
import { render } from '../app.js';

/*
 * ชุดสิทธิ์ของผู้ช่วย — ต้องตรงกับ app/Libraries/Permissions.php ฝั่งเซิร์ฟเวอร์
 * ฝั่งนี้ใช้แค่วาดหน้าจอ ของจริงบังคับที่เซิร์ฟเวอร์เสมอ
 */
const PERMISSIONS = [
  { value: 'bills', label: 'ดูบิลและยอดที่ต้องจ่าย', hint: 'เห็นใบเรียกเก็บ ยอดค้าง และประวัติการชำระ' },
  { value: 'pay', label: 'แจ้งชำระเงิน', hint: 'กดชำระเงิน แนบสลิป และยกเลิกรายการที่รอตรวจ (ได้สิทธิ์ดูบิลไปด้วย)' },
  { value: 'reports', label: 'ดูรายงานและยอดขาย', hint: 'เห็นภาพรวมและรายงานเปรียบเทียบ' },
  { value: 'products', label: 'ดูรายการสินค้า', hint: 'เห็นสินค้าที่ร้านขายและเปอร์เซ็นต์ส่วนต่าง' },
];

const DEFAULT_STAFF_PERMISSIONS = ['bills', 'reports', 'products'];

/** ป้ายสรุปว่าผู้ช่วยคนนี้ทำอะไรได้บ้าง */
function permissionSummary(permissions) {
  if (permissions === null || permissions === undefined) {
    return [el('span', { class: 'muted' }, 'ทุกอย่าง')];
  }
  if (!permissions.length) return [el('span', { class: 'badge red' }, 'ปิดทุกสิทธิ์')];

  return PERMISSIONS
    .filter((p) => permissions.includes(p.value))
    .map((p) => el('span', {
      class: `badge ${p.value === 'pay' ? 'amber' : 'gray'}`,
      style: 'margin:1px 3px 1px 0',
    }, p.value === 'pay' ? '💳 จ่ายเงิน' : p.label.replace('ดู', '')));
}

export async function accountView() {
  const [me, tfa, telegram, onboarding] = await Promise.all([
    api.get('/api/auth/me').then((r) => r.user),
    api.get('/api/auth/2fa'),
    api.get('/api/auth/telegram').catch(() => null),
    api.get('/api/auth/onboarding').catch(() => null),
  ]);
  // เจ้าของบัญชีร้านเท่านั้นที่จัดการผู้ช่วยได้
  const team = me.role === 'FRANCHISE' && me.isOwner
    ? await api.get(`/api/franchises/${me.franchiseId}/users`)
    : null;

  const current = el('input', { type: 'password', autocomplete: 'current-password' });
  const next = el('input', { type: 'password', autocomplete: 'new-password' });
  const confirm = el('input', { type: 'password', autocomplete: 'new-password' });
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const button = el('button', { class: 'btn' }, 'เปลี่ยนรหัสผ่าน');

  button.addEventListener('click', async () => {
    const fail = (msg) => { errorBox.textContent = msg; errorBox.style.display = ''; };
    errorBox.style.display = 'none';

    if (!current.value || !next.value) return fail('กรอกรหัสผ่านให้ครบ');
    if (next.value.length < 8) return fail('รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร');
    if (next.value !== confirm.value) return fail('รหัสผ่านใหม่และการยืนยันไม่ตรงกัน');

    button.disabled = true;
    try {
      const res = await api.post('/api/auth/change-password', { currentPassword: current.value, newPassword: next.value });
      // เครื่องอื่นที่ล็อกอินค้างไว้ถูกเตะออกหมด เครื่องนี้ใช้ token ใบใหม่ต่อ
      session.save(res.token, session.user);
      toast('เปลี่ยนรหัสผ่านแล้ว — เครื่องอื่นที่ล็อกอินค้างไว้ถูกออกจากระบบแล้ว', 'success');
      for (const box of [current, next, confirm]) box.value = '';
    } catch (err) {
      fail(err.fullMessage ?? err.message);
    } finally {
      button.disabled = false;
    }
    return undefined;
  });

  const roleLabel = me.role === 'SUPER_ADMIN' ? 'ผู้ดูแลระบบส่วนกลาง'
    : me.role === 'SALES' ? 'เซล'
      : (me.isOwner ? 'เจ้าของบัญชีร้าน' : 'ผู้ช่วย');

  const rows = [
    { k: 'ชื่อผู้ใช้', v: me.username },
    { k: 'ชื่อที่แสดง', v: me.displayName ?? '—' },
    { k: 'บทบาท', v: roleLabel },
    ...(me.role === 'FRANCHISE' ? [{ k: 'ร้านค้า', v: me.franchiseUsername ?? '—' }] : []),
    ...(me.role === 'SALES' ? [{ k: 'เซล', v: `${me.agentUsername ?? ''} — ${me.agentName ?? ''}` }] : []),
    { k: 'สถานะบัญชี', v: badge(me.status) },
    { k: 'เข้าสู่ระบบครั้งล่าสุด', v: dateTimeTh(me.lastLoginAt) },
  ];

  const addAssistant = () => formModal({
    title: 'เพิ่มผู้ช่วย',
    submitLabel: 'สร้างบัญชีผู้ช่วย',
    fields: [
      { name: 'username', label: 'ชื่อผู้ใช้', required: true, hint: 'ใช้ได้เฉพาะ a-z 0-9 . _ -' },
      { name: 'password', label: 'รหัสผ่าน', required: true, hint: 'อย่างน้อย 8 ตัวอักษร' },
      { name: 'displayName', label: 'ชื่อที่แสดง', placeholder: 'เช่น น้องเอ (ธุรการ)' },
      {
        // ตั้งต้นให้ดูได้แต่ยังแจ้งชำระไม่ได้ — เปิดสิทธิ์แตะเงินต้องเป็นการตัดสินใจ ไม่ใช่ค่าเริ่มต้น
        name: 'permissions',
        label: 'สิทธิ์การใช้งาน',
        type: 'checklist',
        value: DEFAULT_STAFF_PERMISSIONS,
        options: PERMISSIONS,
        hint: 'ติ๊กเฉพาะสิ่งที่ผู้ช่วยคนนี้ต้องทำ — แก้ทีหลังได้',
      },
    ],
    onSubmit: async (v) => {
      await api.post(`/api/franchises/${me.franchiseId}/users`, v);
      toast(`เพิ่มผู้ช่วย ${v.username} แล้ว`, 'success');
      render();
    },
  });

  const teamCard = team && card('ผู้ช่วย',
    table([
      { label: 'ชื่อผู้ใช้', render: (u) => el('strong', {}, u.username) },
      { label: 'ชื่อที่แสดง', render: (u) => u.displayName ?? '—' },
      {
        label: 'ประเภท',
        render: (u) => el('span', { class: `badge ${u.isOwner ? 'blue' : 'gray'}` }, u.isOwner ? 'เจ้าของบัญชี' : 'ผู้ช่วย'),
      },
      {
        label: 'สิทธิ์',
        render: (u) => (u.isOwner
          ? el('span', { class: 'muted' }, 'ทุกอย่าง')
          : el('div', {}, ...permissionSummary(u.permissions))),
      },
      { label: 'สถานะ', render: (u) => badge(u.status) },
      { label: 'เข้าล่าสุด', render: (u) => dateTimeTh(u.lastLoginAt) },
      {
        label: '',
        render: (u) => (u.isOwner
          ? el('span', { class: 'muted' }, 'บัญชีของคุณ')
          : el('div', { class: 'btn-row' },
            el('button', {
              class: 'btn ghost sm',
              onclick: () => formModal({
                title: `สิทธิ์ของ ${u.username}`,
                submitLabel: 'บันทึกสิทธิ์',
                fields: [{
                  name: 'permissions',
                  label: 'ทำอะไรได้บ้าง',
                  type: 'checklist',
                  // permissions เป็น null แปลว่าบัญชีเก่าที่ยังไม่เคยตั้ง = ทำได้ทุกอย่าง
                  value: u.permissions ?? PERMISSIONS.map((x) => x.value),
                  options: PERMISSIONS,
                }],
                onSubmit: async (v) => {
                  await api.patch(`/api/franchises/${me.franchiseId}/users/${u.id}/permissions`, v);
                  toast(`บันทึกสิทธิ์ของ ${u.username} แล้ว`, 'success');
                  render();
                },
              }),
            }, '🔑 สิทธิ์'),
            el('button', {
              class: 'btn ghost sm',
              onclick: () => formModal({
                title: `ตั้งรหัสผ่านใหม่ให้ ${u.username}`,
                fields: [{ name: 'newPassword', label: 'รหัสผ่านใหม่', required: true, hint: 'อย่างน้อย 8 ตัวอักษร' }],
                onSubmit: async (v) => {
                  await api.post(`/api/franchises/${me.franchiseId}/users/${u.id}/reset-password`, v);
                  toast('ตั้งรหัสผ่านใหม่แล้ว', 'success');
                },
              }),
            }, 'ตั้งรหัสใหม่'),
            el('button', {
              class: 'btn ghost sm',
              onclick: () => confirmAction(
                `${u.status === 'ACTIVE' ? 'ปิด' : 'เปิด'}การใช้งานบัญชี ${u.username}?`,
                async () => {
                  await api.patch(`/api/franchises/${me.franchiseId}/users/${u.id}/status`, {
                    status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
                  });
                  toast('อัปเดตแล้ว', 'success');
                  render();
                },
              ),
            }, u.status === 'ACTIVE' ? 'ปิดใช้งาน' : 'เปิดใช้งาน'))),
      },
    ], team.items, { empty: { icon: '🙋', title: 'ยังไม่มีผู้ช่วย', detail: 'ให้พนักงานช่วยดูบิลหรือแจ้งชำระ โดยเลือกสิทธิ์ได้เอง', action: { label: '+ เพิ่มผู้ช่วย', onClick: addAssistant } } }),
    {
      tight: true,
      actions: el('button', { class: 'btn', onclick: addAssistant }, '+ เพิ่มผู้ช่วย'),
    });

  return el('div', {},
    // ดูมุมมองร้านอยู่ — หน้านี้ยังเป็นบัญชีของแอดมินเอง บอกไว้ ไม่งั้นนึกว่าร้านไม่มีการ์ด Telegram/ผู้ช่วย
    session.viewAs
      ? el('div', { class: 'notice-box info-box', style: 'display:block' },
        `หน้านี้เป็นบัญชีของคุณเอง (${me.username}) ไม่ใช่ของร้าน ${session.viewAs.username} — `
        + 'บัญชีของร้านมีการ์ด "แจ้งเตือนทาง Telegram" และ "ผู้ช่วย" เพิ่มจากนี้ ดูตัวอย่างได้ในคู่มือของร้าน')
      : '',
    el('div', { class: 'page-head' },
      el('div', {}, el('h1', {}, 'บัญชีของฉัน'), el('p', {}, me.role === 'FRANCHISE' ? 'ข้อมูลผู้ใช้ การแจ้งเตือน Telegram และรหัสผ่าน' : 'ข้อมูลผู้ใช้และการเปลี่ยนรหัสผ่าน'))),

    card('ข้อมูลบัญชี',
      table([
        { label: 'รายการ', render: (r) => r.k },
        { label: 'ข้อมูล', render: (r) => r.v },
      ], rows), { tight: true }),

    teamCard || '',

    me.role === 'FRANCHISE' ? telegramCard(telegram) : '',

    onboarding && onboarding.dismissed && !onboarding.complete
      ? el('div', { class: 'notice-box info-box' },
        `ขั้นตอนเริ่มต้นใช้งานทำไปแล้ว ${onboarding.done}/${onboarding.total} ข้อ `,
        el('button', {
          class: 'btn ghost sm',
          onclick: async () => {
            await api.post('/api/auth/onboarding', { dismissed: false });
            location.hash = '#/dashboard';
          },
        }, 'แสดงที่หน้าแรกอีกครั้ง'))
      : '',

    twoFactorCard(tfa, me),

    card('เปลี่ยนรหัสผ่าน',
      el('div', {},
        errorBox,
        el('div', { class: 'form-grid' },
          field('รหัสผ่านปัจจุบัน', current),
          field('รหัสผ่านใหม่', next, 'อย่างน้อย 8 ตัวอักษร'),
          field('ยืนยันรหัสผ่านใหม่', confirm)),
        el('div', { class: 'btn-row mt-14' }, button))));
}

/**
 * ยืนยันตัวตนสองชั้น — ส่วนกลางบังคับ (ปิดไม่ได้) · ร้านค้า/เซลเปิดเองได้
 * เปิด/ปิดแล้ว session เก่าทุกเครื่องหลุด จึงต้องเก็บ token ใบใหม่ที่ได้กลับมา
 */
function twoFactorCard(tfa, me) {
  const codeModal = ({ title, submitLabel, message, run }) => formModal({
    title,
    submitLabel,
    fields: [{ name: 'code', label: 'รหัส 6 หลักจากแอป', required: true, placeholder: '123456' }],
    preview: () => el('div', { class: 'notice-box m-0' }, message),
    onSubmit: (v) => run(v.code),
  });

  const enable = () => {
    const modal = infoModal({ title: 'เปิดใช้ Google Authenticator', width: 460, content: null });
    modal.body.append(enrollFlow({
      onDone: (res) => {
        session.save(res.token, res.user);
        modal.close();
        toast('เปิดใช้แล้ว — ครั้งหน้าล็อกอินต้องใส่รหัสจากแอปด้วย', 'success');
        render();
      },
    }));
  };

  const disable = () => codeModal({
    title: 'ปิด Google Authenticator',
    submitLabel: 'ปิดการใช้งาน',
    message: 'ปิดแล้วเข้าระบบด้วยรหัสผ่านอย่างเดียว — ถ้ารหัสผ่านหลุด คนอื่นเข้าบัญชีได้ทันที',
    run: async (code) => {
      const res = await api.post('/api/auth/2fa/disable', { code });
      session.save(res.token, res.user);
      toast('ปิดแล้ว', 'success');
      render();
    },
  });

  const regenerate = () => codeModal({
    title: 'สร้างรหัสสำรองชุดใหม่',
    submitLabel: 'สร้างชุดใหม่',
    message: 'รหัสสำรองชุดเดิมจะใช้ไม่ได้ทันที',
    run: async (code) => {
      const res = await api.post('/api/auth/2fa/backup-codes', { code });
      const modal = infoModal({ title: 'รหัสสำรองชุดใหม่', width: 460, content: null });
      modal.body.append(backupCodesBox(res.backupCodes, { onDone: () => { modal.close(); render(); }, doneLabel: 'เก็บแล้ว' }));
    },
  });

  // บอกแอดมินว่าตอนนี้ไม่บังคับเพราะเป็นโหมดทดสอบ — จะได้ไม่ตกใจตอนขึ้นเซิร์ฟเวอร์จริงแล้วโดนบังคับ
  const testNote = me.role !== 'SUPER_ADMIN' ? ''
    : tfa.testMode
      ? el('div', { class: 'notice-box' },
        'โหมดทดสอบ (CI_ENVIRONMENT = development) — ยังไม่บังคับ · เซิร์ฟเวอร์จริง (CI_ENVIRONMENT = production) จะบังคับบัญชีส่วนกลางทุกบัญชีตอนล็อกอิน')
      : tfa.enforceOff
        ? el('div', { class: 'notice-box' },
          'ปิดการบังคับไว้ในไฟล์ตั้งค่าเซิร์ฟเวอร์ (paynest.enforceAdmin2fa = false) — ใครได้รหัสผ่านแอดมินไปก็เข้าระบบได้ทันที แนะนำให้เปิดใช้')
        : '';

  if (!tfa.enabled) {
    return card('ยืนยันตัวตนสองชั้น (Google Authenticator)',
      el('div', {},
        testNote,
        el('p', { style: 'margin-top:0' },
          'เปิดแล้ว ล็อกอินต้องใส่รหัส 6 หลักจากมือถือด้วย — ต่อให้รหัสผ่านหลุด คนอื่นก็เข้าบัญชีไม่ได้'),
        el('button', { class: 'btn', onclick: enable }, '📱 เปิดใช้')));
  }

  return card('ยืนยันตัวตนสองชั้น (Google Authenticator)',
    el('div', {},
      el('p', { style: 'margin-top:0' },
        el('span', { class: 'badge green' }, '✓ เปิดใช้อยู่'),
        ' รหัสสำรองเหลือ ', el('strong', {}, String(tfa.backupCodesLeft)), ' ชุด'),
      tfa.backupCodesLeft <= 3
        ? el('div', { class: 'alert-box' }, 'รหัสสำรองใกล้หมด — สร้างชุดใหม่เก็บไว้ ก่อนมือถือหายแล้วเข้าไม่ได้')
        : '',
      tfa.required
        ? el('div', { class: 'sub-line', style: 'margin-bottom:10px' },
          'บัญชีส่วนกลางต้องใช้เสมอ · เปลี่ยนมือถือ/มือถือหาย: ให้แอดมินอีกคนปลดให้ หรือผู้ดูแลเซิร์ฟเวอร์ใช้คำสั่ง php spark 2fa:reset <ชื่อผู้ใช้>')
        : '',
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn ghost', onclick: regenerate }, 'สร้างรหัสสำรองชุดใหม่'),
        tfa.required ? '' : el('button', { class: 'btn ghost danger', onclick: disable }, 'ปิดการใช้งาน'))));
}

/**
 * แจ้งเตือนเข้า Telegram ของร้าน — บิลออก ได้รับเงินแล้ว สลิปต้องแก้ ใกล้ครบกำหนด
 * เชื่อมด้วยลิงก์ครั้งเดียว (t.me/บอท?start=รหัส) ไม่ต้องพิมพ์รหัสหรือหา chat id เอง
 * ส่วนกลางยังไม่ได้ตั้งบอท = ไม่โชว์การ์ดเลย ดีกว่าโชว์ปุ่มที่กดแล้วใช้ไม่ได้
 */
function telegramCard(status) {
  /*
   * ทางเรายังไม่ได้เชื่อมบอท — เดิมซ่อนการ์ดทั้งใบ ร้านอ่านคู่มือแล้วหาปุ่มไม่เจอ
   * โชว์การ์ดไว้พร้อมบอกว่ายังเปิดไม่ได้เพราะอะไร
   */
  if (!status?.available) {
    return card('แจ้งเตือนทาง Telegram',
      el('div', { class: 'channel-row' },
        el('span', { class: 'channel-ico' }, icon('send')),
        el('div', { class: 'channel-text' },
          el('strong', {}, 'ยังเปิดใช้ไม่ได้'),
          el('span', { class: 'sub-line' }, 'ทางเรายังไม่ได้เปิดระบบแจ้งเตือน Telegram — เปิดเมื่อไร ปุ่ม "เชื่อม Telegram" จะขึ้นตรงนี้'))));
  }

  const connect = async () => {
    const { url } = await api.post('/api/auth/telegram/link', {});
    let timer = null;
    const waiting = el('div', { class: 'sub-line mt-8' }, 'รอการเชื่อมต่อ… กด Start ในแอป Telegram แล้วหน้านี้จะอัปเดตเอง');
    const modal = infoModal({
      title: 'เชื่อม Telegram',
      width: 460,
      content: el('div', { style: 'text-align:center' },
        el('p', {}, 'กดปุ่มด้านล่าง แอป Telegram จะเปิดขึ้นมา แล้วกด ', el('strong', {}, 'Start'), ' ครั้งเดียว'),
        // เป็นลิงก์ให้กดเอง — เปิดหน้าต่างใหม่หลังรอ API ถูก Safari บล็อกเป็น popup
        el('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, '📨 เปิด Telegram'),
        waiting,
        el('div', { class: 'sub-line mt-8' }, 'ลิงก์ใช้ได้ 15 นาที')),
      onClose: () => clearInterval(timer),
    });
    const started = Date.now();
    timer = setInterval(async () => {
      if (!modal.body.isConnected) { clearInterval(timer); return; } // ย้ายหน้าไปแล้ว โมดัลถูกลบทิ้ง
      if (Date.now() - started > 15 * 60 * 1000) { clearInterval(timer); waiting.textContent = 'ลิงก์หมดอายุแล้ว — ปิดแล้วกดเชื่อมใหม่'; return; }
      const now = await api.get('/api/auth/telegram').catch(() => null);
      if (now?.linked) {
        clearInterval(timer);
        modal.close();
        toast('เชื่อม Telegram แล้ว — ต่อไปจะได้รับแจ้งเตือนในแชต', 'success');
        render();
      }
    }, 3000);
  };

  const events = status.events ?? [];
  const on = events.filter((e) => e.enabled).length;

  /*
   * เลือกรับทีละเรื่อง — กดสวิตช์แล้วบันทึกทันที ไม่ต้องหาปุ่มบันทึก
   * ยังไม่เชื่อม: สวิตช์กดไม่ได้ แต่ยังเห็นว่าเชื่อมแล้วจะได้อะไรบ้าง
   */
  const eventRow = (e) => {
    const box = el('input', { type: 'checkbox', checked: e.enabled, disabled: !status.linked, 'aria-label': e.label });
    box.addEventListener('change', async () => {
      box.disabled = true;
      try {
        await api.put('/api/auth/telegram/prefs', { events: { [e.key]: box.checked } });
        e.enabled = box.checked;
        toast(box.checked ? `เปิดรับ "${e.label}" แล้ว` : `ปิด "${e.label}" แล้ว`, 'success');
      } catch (err) {
        box.checked = !box.checked; // บันทึกไม่ได้ ดึงสวิตช์กลับ ไม่ให้หน้าจอโกหก
        toast(err.message, 'error');
      } finally {
        box.disabled = false;
      }
    });
    return el('label', { class: 'notify-row', style: status.linked ? 'cursor:pointer' : 'opacity:.6' },
      el('span', { class: 'notify-label' }, el('strong', {}, e.label), el('span', { class: 'sub-line' }, e.hint)),
      el('span', { class: 'switch' }, box, el('span', { class: 'slider' })));
  };

  return card('แจ้งเตือนทาง Telegram',
    el('div', {},
      el('div', { class: 'channel-row' },
        el('span', { class: `channel-ico${status.linked ? ' on' : ''}` }, icon('send')),
        el('div', { class: 'channel-text' },
          el('strong', {}, status.linked ? `เชื่อมแล้ว · รับ ${on} จาก ${events.length} เรื่อง` : 'ยังไม่ได้เชื่อม'),
          el('span', { class: 'sub-line' }, status.linked
            ? 'เลือกได้ด้านล่างว่าอยากได้ข้อความเรื่องไหน — ตั้งของใครของมัน ไม่กระทบคนอื่นในร้าน'
            : 'เชื่อมครั้งเดียว แล้วเลือกได้ว่าอยากได้เรื่องไหน — ฟรี ไม่มีค่าใช้จ่าย')),
        status.linked
          ? el('button', {
            class: 'btn ghost sm',
            onclick: () => confirmAction('เลิกรับแจ้งเตือนทาง Telegram ทั้งหมด?', async () => {
              await api.del('/api/auth/telegram');
              toast('เลิกเชื่อม Telegram แล้ว', 'success');
              render();
            }),
          }, 'เลิกเชื่อม')
          : el('button', { class: 'btn sm', onclick: connect }, 'เชื่อม Telegram')),
      events.length ? el('div', { class: 'notify-group' }, ...events.map(eventRow)) : ''));
}
