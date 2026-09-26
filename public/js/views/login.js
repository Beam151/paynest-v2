import { api, session } from '../api.js';
import { el, field, icon, toast } from '../ui.js';

export function loginView(onSuccess) {
  const username = el('input', { type: 'text', placeholder: 'ชื่อผู้ใช้ของคุณ', autocomplete: 'username' });
  const password = el('input', { type: 'password', placeholder: '••••••••', autocomplete: 'current-password' });
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const button = el('button', { class: 'btn block mt-6' }, 'เข้าสู่ระบบ');

  const submit = async (event) => {
    event?.preventDefault();
    if (!username.value.trim() || !password.value) {
      errorBox.textContent = 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน';
      errorBox.style.display = '';
      return;
    }
    button.disabled = true;
    button.textContent = 'กำลังเข้าสู่ระบบ…';
    errorBox.style.display = 'none';
    try {
      const res = await api.post('/api/auth/login', { username: username.value.trim(), password: password.value });
      if (res.mfaRequired) {
        form.replaceWith(mfaStep(res.mfaToken, finish));
        return;
      }
      finish(res);
    } catch (err) {
      errorBox.textContent = err.fullMessage ?? err.message;
      errorBox.style.display = '';
      password.value = '';
      password.focus();
    } finally {
      button.disabled = false;
      button.textContent = 'เข้าสู่ระบบ';
    }
  };

  /** ล็อกอินผ่านแล้ว — ถ้ายังต้องเปลี่ยนรหัสเริ่มต้น/ตั้ง 2FA ให้ไปหน้าตั้งค่าก่อน */
  const finish = (res) => {
    session.save(res.token, res.user);
    if (res.usedBackupCode) toast(`ใช้รหัสสำรองแล้ว — เหลืออีก ${res.backupCodesLeft} ชุด`, 'info');
    if (res.mustChangePassword || res.enrollRequired) {
      location.hash = '#/setup';
      return;
    }
    onSuccess();
  };

  const form = el('form', { class: 'login-card', onsubmit: submit },
    el('h1', {}, 'เข้าสู่ระบบ'),
    el('p', { class: 'sub' }, 'ส่วนกลางและร้านค้าใช้หน้าเดียวกัน — ระบบจัดเมนูตามบทบาทให้เอง'),
    errorBox,
    el('div', { style: 'display:grid;gap:14px' },
      field('ชื่อผู้ใช้', username),
      field('รหัสผ่าน', password),
      button),
    // คู่มืออยู่ในระบบ (แยกตามบทบาท) — ก่อนล็อกอินบอกแค่ทางออกเรื่องรหัสผ่าน
    el('p', { class: 'sub-line', style: 'margin:18px 0 0;text-align:center' },
      'ลืมรหัสผ่าน? ติดต่อผู้ดูแลระบบ'));

  setTimeout(() => username.focus(), 50);
  return el('div', { class: 'login-split' }, brandPanel(), el('div', { class: 'login-side' }, form));
}

/*
 * แผงแบรนด์ด้านซ้าย — ความประทับใจแรกของระบบ บอกสั้น ๆ ว่าระบบนี้ช่วยอะไร
 * จอแคบเหลือแค่หัวแบรนด์ ไม่ดันฟอร์มลงไปใต้จอ
 */
function brandPanel() {
  const point = (name, title, detail) => el('li', {},
    el('span', { class: 'login-point-ico' }, icon(name)),
    el('span', {}, el('strong', {}, title), el('span', {}, detail)));
  return el('aside', { class: 'login-brand' },
    el('div', { class: 'login-brand-head' },
      el('span', { class: 'login-mark' }, icon('store')),
      el('span', {}, 'ระบบจัดการร้าน')),
    el('div', { class: 'login-brand-body' },
      el('h2', {}, 'เรียกเก็บส่วนแบ่งจากทุกร้าน', el('br'), 'จบในที่เดียว'),
      el('ul', { class: 'login-points' },
        point('receipt', 'ออกบิลทุกร้านในคลิกเดียว', 'ปิดรอบครึ่งเดือนแล้วออกบิลพร้อมกันทุกร้าน'),
        point('smartphone', 'ร้านจ่ายจากมือถือ', 'สแกน QR โอนแล้วแนบสลิป ทางเราตรวจรับได้ทันที'),
        point('lock', 'ปลอดภัยทุกขั้น', 'ยืนยันตัวตนสองชั้น และแจ้งเตือนทุกการแก้บัญชีรับเงิน'))));
}

/** ขั้นที่สอง: รหัส 6 หลักจากแอป หรือรหัสสำรอง */
function mfaStep(mfaToken, finish) {
  const code = el('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456',
  });
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const button = el('button', { class: 'btn block mt-6' }, 'ยืนยัน');

  const submit = async (event) => {
    event?.preventDefault();
    if (!code.value.trim()) return;
    button.disabled = true;
    errorBox.style.display = 'none';
    try {
      finish(await api.post('/api/auth/login/mfa', { mfaToken, code: code.value.trim() }));
    } catch (err) {
      errorBox.textContent = err.fullMessage ?? err.message;
      errorBox.style.display = '';
      code.value = '';
      code.focus();
      // หมดเวลา 5 นาทีแล้ว — ต้องเริ่มใหม่จากรหัสผ่าน
      if (err.status === 401) setTimeout(() => location.reload(), 1500);
    } finally {
      button.disabled = false;
    }
  };

  setTimeout(() => code.focus(), 50);
  return el('form', { class: 'login-card', onsubmit: submit },
    el('div', { class: 'login-step-ico' }, icon('smartphone')),
    el('h1', {}, 'ใส่รหัสจากแอป'),
    el('p', { class: 'sub' }, 'เปิด Google Authenticator แล้วใส่รหัส 6 หลักของระบบนี้'),
    errorBox,
    el('div', { style: 'display:grid;gap:14px' },
      field('รหัส 6 หลัก', code, 'มือถือหาย? ใส่รหัสสำรองที่จดไว้แทนได้'),
      button));
}
