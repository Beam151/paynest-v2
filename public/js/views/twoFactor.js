import { api, session } from '../api.js';
import { el, field, toast } from '../ui.js';

/*
 * ยืนยันตัวตนสองชั้น (Google Authenticator)
 * ใช้สองที่: หน้าตั้งค่าบังคับตอนล็อกอินครั้งแรกของส่วนกลาง และหน้า "บัญชีของฉัน" (ร้านเลือกเปิดเอง)
 */

const codeInput = () => el('input', {
  type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '123456',
});

/** รหัสสำรอง — โชว์ครั้งเดียว ต้องให้เก็บก่อนกดไปต่อ */
export function backupCodesBox(codes, { onDone, doneLabel = 'เก็บรหัสสำรองไว้แล้ว ไปต่อ' } = {}) {
  const saved = el('input', { type: 'checkbox' });
  const next = el('button', { class: 'btn', disabled: true, onclick: () => onDone?.() }, doneLabel);
  saved.addEventListener('change', () => { next.disabled = !saved.checked; });

  const copy = el('button', {
    class: 'btn ghost sm',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(codes.join('\n'));
        toast('คัดลอกแล้ว', 'success');
      } catch {
        toast('คัดลอกไม่ได้ — จดด้วยมือแทน', 'error');
      }
    },
  }, '📋 คัดลอกทั้งหมด');

  return el('div', {},
    el('div', { class: 'alert-box', style: 'margin-top:0' },
      el('strong', {}, 'เก็บรหัสสำรองนี้ไว้ที่ปลอดภัย — จะไม่แสดงอีก'),
      el('div', {}, 'ใช้ล็อกอินได้รหัสละครั้งตอนมือถือหาย · อย่าเก็บไว้ในมือถือเครื่องเดียวกับแอป')),
    el('div', { class: 'backup-codes' }, ...codes.map((c) => el('code', {}, c))),
    el('div', { class: 'btn-row', style: 'margin:10px 0 14px' }, copy),
    el('label', { class: 'check-item', style: 'margin-bottom:12px' }, saved, el('strong', {}, 'ฉันจดหรือพิมพ์รหัสสำรองเก็บไว้แล้ว')),
    next);
}

/**
 * ขั้นตอนเปิดใช้: สแกน QR → ใส่รหัสแรก → ได้รหัสสำรอง
 * onDone(res) ได้ token ใบใหม่ (session เก่าทุกอันหลุดตอนเปิดใช้) — คนเรียกต้องเก็บเอง
 */
export function enrollFlow({ onDone }) {
  const box = el('div', {}, el('div', { class: 'loading' }, 'กำลังเตรียม QR…'));

  api.post('/api/auth/2fa/setup').then((setup) => {
    const code = codeInput();
    const errorBox = el('div', { class: 'error-box', style: 'display:none' });
    const confirm = el('button', { class: 'btn block' }, 'ยืนยันและเปิดใช้');

    const submit = async (e) => {
      e?.preventDefault();
      confirm.disabled = true;
      errorBox.style.display = 'none';
      try {
        const res = await api.post('/api/auth/2fa/enable', { code: code.value.trim() });
        box.replaceChildren(backupCodesBox(res.backupCodes, { onDone: () => onDone(res) }));
      } catch (err) {
        errorBox.textContent = err.fullMessage ?? err.message;
        errorBox.style.display = '';
        code.value = '';
        code.focus();
      } finally {
        confirm.disabled = false;
      }
    };
    confirm.addEventListener('click', submit);
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(e); });

    box.replaceChildren(
      el('ol', { class: 'steps' },
        el('li', {}, 'ติดตั้งแอป ', el('strong', {}, 'Google Authenticator'), ' (หรือ Microsoft Authenticator / Authy) ในมือถือ'),
        el('li', {}, 'ในแอปกด + แล้วสแกน QR นี้'),
        el('li', {}, 'ใส่รหัส 6 หลักที่แอปแสดง')),
      el('div', { style: 'text-align:center' },
        el('img', { src: setup.qrDataUrl, alt: 'QR สำหรับ Google Authenticator', class: 'qr-full', style: 'max-width:220px' }),
        el('div', { class: 'sub-line mt-6' }, 'สแกนไม่ได้? พิมพ์รหัสนี้ในแอปแทน'),
        el('code', { class: 'totp-secret' }, setup.secret)),
      errorBox,
      el('div', { style: 'display:grid;gap:12px;margin-top:12px' },
        field('รหัส 6 หลักจากแอป', code),
        confirm));
    code.focus();
  }).catch((err) => {
    box.replaceChildren(el('div', { class: 'error-box' }, err.fullMessage ?? err.message));
  });

  return box;
}

/**
 * หน้าตั้งค่าบังคับ (#/setup) — เปลี่ยนรหัสเริ่มต้น แล้วตั้ง Google Authenticator
 * เซิร์ฟเวอร์กันทุกเส้นทางอื่นไว้จนกว่าจะเสร็จ (requireAuth) หน้านี้แค่พาทำให้ครบ
 */
export async function setupView(onFinished) {
  const card = el('div', { class: 'login-card', style: 'max-width:440px' });
  const wrap = el('div', { class: 'login-wrap' }, card);

  const logout = el('button', {
    class: 'btn ghost sm',
    style: 'margin-top:14px',
    onclick: () => { session.clear(); location.hash = '#/login'; location.reload(); },
  }, 'ออกจากระบบ');

  const step = async () => {
    const me = (await api.get('/api/auth/me')).user;

    if (me.mustChangePassword) {
      const current = el('input', { type: 'password', autocomplete: 'current-password' });
      const next = el('input', { type: 'password', autocomplete: 'new-password' });
      const again = el('input', { type: 'password', autocomplete: 'new-password' });
      const errorBox = el('div', { class: 'error-box', style: 'display:none' });
      const save = el('button', { class: 'btn block' }, 'ตั้งรหัสผ่านใหม่');
      save.addEventListener('click', async () => {
        errorBox.style.display = 'none';
        if (next.value.length < 12) { errorBox.textContent = 'รหัสผ่านบัญชีส่วนกลางควรยาวอย่างน้อย 12 ตัวอักษร'; errorBox.style.display = ''; return; }
        if (next.value !== again.value) { errorBox.textContent = 'รหัสผ่านใหม่และการยืนยันไม่ตรงกัน'; errorBox.style.display = ''; return; }
        save.disabled = true;
        try {
          const res = await api.post('/api/auth/change-password', { currentPassword: current.value, newPassword: next.value });
          session.save(res.token, { ...session.user, mustChangePassword: false });
          step();
        } catch (err) {
          errorBox.textContent = err.fullMessage ?? err.message;
          errorBox.style.display = '';
        } finally {
          save.disabled = false;
        }
      });
      card.replaceChildren(
        el('div', { class: 'logo' }, '🔑'),
        el('h1', {}, 'ตั้งรหัสผ่านของคุณ'),
        el('p', { class: 'sub' }, 'รหัสเริ่มต้นมาจากไฟล์บนเซิร์ฟเวอร์ ต้องเปลี่ยนเป็นของคุณเองก่อนใช้งาน'),
        errorBox,
        el('div', { style: 'display:grid;gap:12px' },
          field('รหัสผ่านเริ่มต้น (จากไฟล์)', current),
          field('รหัสผ่านใหม่', next, 'อย่างน้อย 12 ตัวอักษร'),
          field('ยืนยันรหัสผ่านใหม่', again),
          save),
        logout);
      current.focus();
      return;
    }

    if (me.role === 'SUPER_ADMIN' && !me.twoFactorEnabled) {
      card.replaceChildren(
        el('div', { class: 'logo' }, '📱'),
        el('h1', {}, 'ตั้ง Google Authenticator'),
        el('p', { class: 'sub' }, 'บัญชีส่วนกลางต้องใช้รหัสจากมือถือทุกครั้งที่เข้าระบบ — รหัสผ่านหลุดอย่างเดียวคนอื่นก็เข้าไม่ได้'),
        enrollFlow({
          onDone: (res) => {
            session.save(res.token, res.user);
            toast('เปิดใช้ Google Authenticator แล้ว', 'success');
            onFinished();
          },
        }),
        logout);
      return;
    }

    onFinished();
  };

  step().catch((err) => {
    card.replaceChildren(el('div', { class: 'error-box' }, err.fullMessage ?? err.message), logout);
  });
  return wrap;
}
