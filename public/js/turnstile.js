/**
 * ช่อง captcha ของ Cloudflare Turnstile
 *
 * โหลดสคริปต์ของ Cloudflare ตอนต้องใช้จริงเท่านั้น — ล็อกอินปกติไม่แตะ Cloudflare เลย
 * (เซิร์ฟเวอร์บอกเองว่าต้องใช้เมื่อไร พร้อม site key: error CAPTCHA_* ที่มี details.siteKey)
 * token ใช้ได้ครั้งเดียวและหมดอายุใน 5 นาที — ส่งไปแล้วต้อง reset() เพื่อขอใบใหม่
 */
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading = null;

function load() {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => {
      loading = null; // ให้ลองโหลดใหม่ได้ครั้งหน้า
      script.remove();
      reject(new Error('โหลดช่องยืนยันว่าไม่ใช่บอทไม่ได้ — เช็กอินเทอร์เน็ตแล้วลองใหม่'));
    };
    document.head.append(script);
  });
  return loading;
}

/** เซิร์ฟเวอร์ขอให้ยืนยันว่าไม่ใช่บอท — คืน site key ที่ต้องใช้วาดช่อง (ไม่ใช่ = null) */
export const captchaSiteKey = (err) => (err?.code?.startsWith('CAPTCHA_') && err.details?.siteKey) || null;

/**
 * วาดช่อง captcha ลงใน container
 * onToken(token) — ได้ token (null = token เดิมหมดอายุ ต้องรอใบใหม่)
 * onError(code) — ช่องขึ้นไม่ได้ เช่น 110200 = โดเมนนี้ยังไม่อยู่ในรายชื่อของ widget
 * action ต้องตรงกับที่เซิร์ฟเวอร์ตรวจ: 'login' หน้าเข้าสู่ระบบ · 'setup' หน้าตั้งค่า
 */
export async function mountCaptcha(container, { siteKey, action, onToken, onError }) {
  const turnstile = await load();
  const id = turnstile.render(container, {
    sitekey: siteKey,
    action,
    theme: 'light',
    size: 'flexible',
    callback: (token) => onToken(token),
    'expired-callback': () => onToken(null),
    'error-callback': (code) => {
      onError?.(code);
      return true; // จัดการเองแล้ว ไม่ต้องโยน error ลง console
    },
  });
  // ช่องที่ถูกถอดออกจากหน้าไปแล้ว (ล็อกอินผ่าน / ปิดกล่อง) reset/remove แล้ว error ได้ — ไม่ต้องสนใจ
  const quietly = (fn) => { try { fn(); } catch { /* ช่องไม่อยู่แล้ว */ } };
  return {
    reset: () => { onToken(null); quietly(() => turnstile.reset(id)); },
    remove: () => quietly(() => turnstile.remove(id)),
  };
}
