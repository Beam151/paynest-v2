import { api, session } from '../api.js';
import { captchaSiteKey, mountCaptcha } from '../turnstile.js';
import { el, field, icon, toast } from '../ui.js';

/*
 * กุญแจลิงก์เข้าระบบของร้าน (#/s/<key>) — ร้านต้องมีทั้งรหัสผ่านและลิงก์ของร้าน
 * รหัสผ่านหลุด/ถูกเดาได้อย่างเดียวยังเข้าไม่ได้ (เป็น "ของที่ต้องมี" ไม่ใช่ "สิ่งที่รู้")
 * จำไว้ในเครื่องเพื่อให้ออกจากระบบแล้วเข้าใหม่ได้โดยไม่ต้องเปิดลิงก์ซ้ำ
 * เก็บในตัวแปรด้วย: เบราว์เซอร์ที่ปิด localStorage (โหมดส่วนตัวบางตัว) ยังเข้าระบบได้ในแท็บนี้
 * ส่วนกลางและเซลไม่ต้องใช้ — ส่งไปเซิร์ฟเวอร์ก็เมินเฉย ๆ
 */
const SHOP_KEY_STORE = 'paynest.shopLoginKey';
let shopKeyMemory = null;

export function rememberShopLoginKey(key) {
  shopKeyMemory = key;
  try { localStorage.setItem(SHOP_KEY_STORE, key); } catch { /* ใช้ตัวแปรในแท็บนี้แทน */ }
}

export function shopLoginKey() {
  if (shopKeyMemory) return shopKeyMemory;
  try { return localStorage.getItem(SHOP_KEY_STORE) || null; } catch { return null; }
}

export function forgetShopLoginKey() {
  shopKeyMemory = null;
  try { localStorage.removeItem(SHOP_KEY_STORE); } catch { /* ไม่มีอะไรให้ลบ */ }
}

/**
 * ป้ายใต้ฟอร์ม: บอกว่าเครื่องนี้จำลิงก์ร้านไว้หรือยัง (ไม่โชว์ตัวกุญแจเด็ดขาด)
 * ร้านที่เข้าไม่ได้ส่วนใหญ่คือเปิดหน้าเว็บตรง ๆ ไม่ได้เปิดจากลิงก์ — บอกไว้ตรงนี้ ไม่ต้องไปถามแอดมิน
 */
function shopKeyNote() {
  const box = el('div', { class: 'login-key-note' });
  let failed = false;
  const paint = () => {
    if (shopLoginKey()) {
      box.replaceChildren(
        el('span', {}, '🔗 ลิงก์เข้าระบบของร้านถูกจำไว้ในเครื่องนี้แล้ว '),
        el('button', {
          type: 'button', // อยู่ในฟอร์ม — ไม่ใส่ type จะกลายเป็นปุ่มส่งฟอร์ม
          class: 'link-btn',
          onclick: () => {
            if (!window.confirm('ล้างลิงก์ร้านที่จำไว้ในเครื่องนี้?\nร้านค้าต้องเปิดลิงก์เข้าระบบที่ได้รับจากทางเราอีกครั้งก่อนเข้าระบบ')) return;
            forgetShopLoginKey();
            paint();
          },
        }, 'ล้าง'),
        // รหัสผิดกับลิงก์เก่า (ทางเราสร้างลิงก์ใหม่ให้ร้านแล้ว) เซิร์ฟเวอร์ตอบเหมือนกันโดยตั้งใจ — บอกทางออกทั้งสองแบบ
        failed ? el('div', { class: 'sub-line' }, 'ถ้าร้านเพิ่งได้ลิงก์ใหม่จากทางเรา ให้เปิดลิงก์ใหม่นั้นก่อน แล้วค่อยเข้าระบบ') : '');
    } else {
      box.replaceChildren(el('span', {}, 'ร้านค้า: เข้าระบบผ่านลิงก์ที่ทางเราส่งให้เท่านั้น'));
    }
  };
  paint();
  return { box, loginFailed: () => { failed = true; paint(); } };
}

export function loginView(onSuccess) {
  const username = el('input', { type: 'text', placeholder: 'ชื่อผู้ใช้ของคุณ', autocomplete: 'username' });
  const password = el('input', { type: 'password', placeholder: '••••••••', autocomplete: 'current-password' });
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const button = el('button', { class: 'btn block mt-6' }, 'เข้าสู่ระบบ');

  /*
   * ช่อง captcha — โผล่เฉพาะเมื่อเซิร์ฟเวอร์บอกว่าบัญชีนี้ถูกใส่รหัสผิดหลายครั้ง (คนใช้ปกติไม่เห็น)
   * โผล่แล้วอยู่ต่อจนออกจากหน้านี้ ทุกครั้งที่กดเข้าสู่ระบบต้องมี token ใบใหม่
   */
  const captchaBox = el('div', { class: 'captcha-box', hidden: true });
  const keyNote = shopKeyNote();
  let captcha = null; // { widget, token }
  let resubmit = false; // เซิร์ฟเวอร์เพิ่งขอ captcha — ผ่านช่องแล้วส่งให้เองไม่ต้องกดซ้ำ

  const showError = (message) => {
    errorBox.textContent = message;
    errorBox.style.display = '';
  };

  const showCaptcha = async (siteKey) => {
    if (captcha) return;
    captcha = { widget: null, token: null };
    captchaBox.hidden = false;
    try {
      captcha.widget = await mountCaptcha(captchaBox, {
        siteKey,
        action: 'login',
        onToken: (token) => {
          captcha.token = token;
          if (token && resubmit) {
            resubmit = false;
            submit();
          }
        },
        onError: (code) => showError(`ช่องยืนยันว่าไม่ใช่บอทขัดข้อง (รหัส ${code}) — รีเฟรชหน้าแล้วลองใหม่`),
      });
    } catch (err) {
      // โหลดสคริปต์ไม่ได้ — กดเข้าสู่ระบบอีกครั้ง เซิร์ฟเวอร์จะขอ captcha แล้วลองโหลดใหม่
      captcha = null;
      captchaBox.hidden = true;
      showError(err.message);
    }
  };

  const submit = async (event) => {
    event?.preventDefault();
    if (!username.value.trim() || !password.value) {
      showError('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');
      return;
    }
    if (captcha && !captcha.token) {
      resubmit = true;
      showError('ติ๊กช่องยืนยันว่าไม่ใช่บอทด้านล่างก่อน');
      return;
    }
    const captchaToken = captcha?.token;
    button.disabled = true;
    button.textContent = 'กำลังเข้าสู่ระบบ…';
    errorBox.style.display = 'none';
    try {
      const loginKey = shopLoginKey();
      const res = await api.post('/api/auth/login', {
        username: username.value.trim(),
        password: password.value,
        ...(loginKey ? { loginKey } : {}),
        ...(captchaToken ? { captchaToken } : {}),
      });
      if (res.mfaRequired) {
        form.replaceWith(mfaStep(res.mfaToken, finish));
        return;
      }
      finish(res);
    } catch (err) {
      showError(err.fullMessage ?? err.message);
      if (err.status === 401) keyNote.loginFailed();
      const siteKey = captchaSiteKey(err);
      if (siteKey) {
        // เซิร์ฟเวอร์ยังไม่ได้ตรวจรหัสผ่าน — เก็บไว้ · ส่งให้เองเฉพาะครั้งแรกที่ถูกขอ
        // (token ไม่ผ่าน / Cloudflare ขัดข้อง แล้วส่งเองซ้ำ ๆ จะวนไม่จบ)
        if (err.code === 'CAPTCHA_REQUIRED') resubmit = true;
        await showCaptcha(siteKey);
      } else {
        password.value = '';
        password.focus();
      }
    } finally {
      // token ใช้ได้ครั้งเดียว — ส่งไปแล้วขอใบใหม่ไว้สำหรับครั้งหน้า
      if (captchaToken) captcha?.widget?.reset();
      button.disabled = false;
      button.textContent = 'เข้าสู่ระบบ';
    }
  };

  /**
   * ล็อกอินผ่านแล้ว — ส่งผลให้ app.js ตัดสินว่าไปหน้าไหน
   * (ต้องเปลี่ยนรหัสเริ่มต้น/ตั้ง 2FA ก่อน → หน้าตั้งค่า · ไม่งั้นหน้าแรกของบทบาท)
   */
  const finish = (res) => {
    // บัญชีที่ถูกบังคับเปลี่ยนรหัส: จดไว้ใน session ด้วย รีเฟรชหน้าแล้วยังพากลับไปหน้าตั้งรหัสได้
    session.save(res.token, { ...res.user, mustChangePassword: Boolean(res.mustChangePassword || res.user?.mustChangePassword) });
    if (res.usedBackupCode) toast(`ใช้รหัสสำรองแล้ว — เหลืออีก ${res.backupCodesLeft} ชุด`, 'info');
    onSuccess(res);
  };

  const form = el('form', { class: 'login-card', onsubmit: submit },
    el('h1', {}, 'เข้าสู่ระบบ'),
    el('p', { class: 'sub' }, 'ส่วนกลางและร้านค้าใช้หน้าเดียวกัน — ระบบจัดเมนูตามบทบาทให้เอง'),
    errorBox,
    el('div', { style: 'display:grid;gap:14px' },
      field('ชื่อผู้ใช้', username),
      field('รหัสผ่าน', password),
      captchaBox,
      button),
    keyNote.box,
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

/**
 * ตั้งรหัสผ่านของตัวเองตอนเข้าครั้งแรก (#/setup ของร้านค้า/เซล)
 * รหัสที่ได้มาผ่านมือคนอื่นแล้ว (แอดมินกด "ตั้งรหัสใหม่ + คัดลอก" แล้วส่งทางแชต) จึงต้องเปลี่ยนก่อนใช้งาน
 * แยกจากหน้าตั้งค่าของส่วนกลาง (setupView) ที่พูดถึง "รหัสจากไฟล์บนเซิร์ฟเวอร์" และบังคับ 12 ตัว
 * — ร้านอ่านแล้วงงว่าไฟล์อะไร · เซิร์ฟเวอร์กันทุกเส้นทางอื่นไว้จนกว่าจะตั้งเสร็จ หน้านี้แค่พาทำให้จบ
 */
export function passwordSetupView(onDone) {
  const card = el('div', { class: 'login-card', style: 'max-width:420px' }, el('div', { class: 'loading' }, 'กำลังโหลด…'));
  const wrap = el('div', { class: 'login-wrap' }, card);

  const logout = el('button', {
    type: 'button',
    class: 'btn ghost sm',
    style: 'margin-top:14px',
    onclick: () => { session.clear(); location.hash = '#/login'; location.reload(); },
  }, 'ออกจากระบบ');

  const current = el('input', { type: 'password', autocomplete: 'current-password' });
  const next = el('input', { type: 'password', autocomplete: 'new-password' });
  const again = el('input', { type: 'password', autocomplete: 'new-password' });
  const errorBox = el('div', { class: 'error-box', style: 'display:none' });
  const save = el('button', { class: 'btn block' }, 'ตั้งรหัสผ่านใหม่ แล้วเริ่มใช้งาน');

  const fail = (message) => { errorBox.textContent = message; errorBox.style.display = ''; };
  const submit = async (event) => {
    event?.preventDefault();
    errorBox.style.display = 'none';
    if (!current.value || !next.value || !again.value) return fail('กรอกรหัสผ่านให้ครบทั้งสามช่อง');
    if (next.value.length < 8) return fail('รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร');
    if (next.value === current.value) return fail('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสที่ได้รับมา — ตั้งรหัสที่รู้คนเดียว');
    if (next.value !== again.value) return fail('รหัสผ่านใหม่และการยืนยันไม่ตรงกัน — พิมพ์ใหม่อีกครั้ง');
    save.disabled = true;
    try {
      const res = await api.post('/api/auth/change-password', { currentPassword: current.value, newPassword: next.value });
      // เครื่องอื่นที่ใช้รหัสชั่วคราวเข้าไว้ถูกเตะออกหมด เครื่องนี้ใช้ token ใบใหม่ต่อ
      session.save(res.token, { ...session.user, mustChangePassword: false });
      toast('ตั้งรหัสผ่านใหม่แล้ว — ครั้งหน้าใช้รหัสนี้เข้าระบบ', 'success');
      onDone();
    } catch (err) {
      fail(err.fullMessage ?? err.message);
    } finally {
      save.disabled = false;
    }
    return undefined;
  };

  api.get('/api/auth/me').then(({ user }) => {
    // เปลี่ยนไปแล้ว (เช่นจากอีกแท็บ) — ไม่ต้องถามซ้ำ
    if (!user.mustChangePassword) {
      session.save(session.token, { ...session.user, mustChangePassword: false });
      onDone();
      return;
    }
    card.replaceChildren(
      el('div', { class: 'logo' }, '🔑'),
      el('h1', {}, 'ตั้งรหัสผ่านของคุณเอง'),
      el('p', { class: 'sub' }, `บัญชี ${user.username} — รหัสที่ได้รับมาเป็นรหัสชั่วคราวที่คนอื่นเห็นแล้ว ตั้งรหัสใหม่ที่รู้คนเดียวก่อนเริ่มใช้งาน`),
      errorBox,
      el('form', { style: 'display:grid;gap:12px', onsubmit: submit },
        field('รหัสผ่านที่ได้รับมา', current),
        field('รหัสผ่านใหม่', next, 'อย่างน้อย 8 ตัวอักษร · อย่าใช้รหัสเดียวกับที่ใช้ที่อื่น'),
        field('ยืนยันรหัสผ่านใหม่', again),
        save),
      logout);
    current.focus();
  }).catch((err) => {
    card.replaceChildren(el('div', { class: 'error-box' }, err.fullMessage ?? err.message), logout);
  });

  return wrap;
}
