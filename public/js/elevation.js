import { api } from './api.js';
import { el, formModal } from './ui.js';

/**
 * ยืนยันตัวตนด้วยรหัส 6 หลักก่อนทำเรื่องอันตราย (แก้บัญชีรับเงิน ตั้งค่า Telegram ปลด 2FA คนอื่น)
 *
 * ใส่รหัสครั้งเดียวแล้วทำต่อได้ 5 นาที (แบบ sudo mode ของ GitHub) — แก้หลายอย่างติดกันไม่ต้องใส่ซ้ำ
 * token เก็บในตัวแปรนี้เท่านั้น ไม่ลง localStorage: ปิดแท็บ/รีเฟรช = ต้องใส่ใหม่
 * และคนที่ขโมย session token ไปก็ไม่ได้ตัวนี้ไปด้วย
 */
let elevation = null; // { token, expiresAt }

const valid = () => elevation && elevation.expiresAt - Date.now() > 10_000;

async function promptCode(reason) {
  // โหมดทดสอบที่ยังไม่ได้ตั้ง Google Authenticator ยืนยันด้วยรหัสผ่านแทน (เซิร์ฟเวอร์เป็นคนตัดสิน)
  const { confirmWith } = await api.get('/api/auth/2fa');
  const byPassword = confirmWith === 'password';
  return new Promise((resolve, reject) => {
    let done = false;
    formModal({
      title: 'ยืนยันตัวตน',
      submitLabel: 'ยืนยัน',
      fields: [byPassword
        ? { name: 'secret', label: 'รหัสผ่านของคุณ', type: 'password', required: true, hint: 'โหมดทดสอบ — เซิร์ฟเวอร์จริงจะถามรหัส 6 หลักจากแอปแทน' }
        : {
          name: 'secret',
          label: 'รหัส 6 หลักจากแอป Google Authenticator',
          required: true,
          placeholder: '123456',
          hint: 'ยืนยันแล้วทำรายการที่ต้องยืนยันต่อได้อีก 5 นาทีโดยไม่ต้องใส่ซ้ำ',
        }],
      preview: () => el('div', { class: 'notice-box', style: 'margin:0' }, reason),
      onSubmit: async (v) => {
        const res = await api.post('/api/auth/elevate', byPassword ? { password: v.secret } : { code: v.secret });
        elevation = { token: res.elevationToken, expiresAt: Date.now() + res.expiresIn * 1000 };
        done = true;
        resolve();
      },
      // ปิดกล่องโดยไม่ใส่รหัส = ยกเลิก — ไม่ให้ปุ่มของฟอร์มที่เรียกเราค้างรออยู่ตลอดไป
      onClose: () => { if (!done) reject(new Error('ยกเลิกการยืนยันตัวตน')); },
    });
  });
}

/**
 * ทำ run(headers) หลังยืนยันตัวตนแล้ว — ส่ง headers ต่อให้ api.* เอง
 * ถ้าเซิร์ฟเวอร์บอกว่าหมดเวลา (เช่นเปลี่ยนรหัสผ่านจากเครื่องอื่น) ขอรหัสใหม่แล้วลองอีกครั้ง
 */
export async function elevated(run, reason = 'รายการนี้เปลี่ยนปลายทางเงินของร้าน ต้องยืนยันว่าเป็นคุณจริง') {
  if (!valid()) await promptCode(reason);
  const headers = () => ({ headers: { 'x-elevation': elevation.token } });
  try {
    return await run(headers());
  } catch (err) {
    if (err.code !== 'ELEVATION_REQUIRED') throw err;
    elevation = null;
    await promptCode(reason);
    return run(headers());
  }
}
