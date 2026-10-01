import { noteBuild } from './freshness.js';

const TOKEN_KEY = 'franchise.token';
const USER_KEY = 'franchise.user';

const VIEW_AS_KEY = 'franchise.viewAs';

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  get user() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null'); } catch { return null; }
  },

  /**
   * โหมด "ดูมุมมองนี้" — super admin สวมมุมของร้านค้า/เซลเพื่อดูว่าเขาเห็นอะไร
   * { role: 'FRANCHISE' | 'SALES', id, username }  · ดูได้อย่างเดียว กดทำอะไรไม่ได้
   */
  get viewAs() {
    try { return JSON.parse(sessionStorage.getItem(VIEW_AS_KEY) ?? 'null'); } catch { return null; }
  },
  setViewAs(target) {
    if (target) sessionStorage.setItem(VIEW_AS_KEY, JSON.stringify(target));
    else sessionStorage.removeItem(VIEW_AS_KEY);
  },

  /** บทบาทที่ใช้ตัดสินเมนู/หน้า — ระหว่าง view-as จะเป็นบทบาทของคนที่กำลังดูอยู่ */
  get role() { return this.viewAs?.role ?? this.user?.role; },
  get isSuper() { return this.role === 'SUPER_ADMIN'; },

  save(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    sessionStorage.removeItem(VIEW_AS_KEY);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(VIEW_AS_KEY);
  },
};

/** ระหว่าง view-as ใส่ขอบเขตของคนที่กำลังดูลงไปในทุก request ให้อัตโนมัติ */
function applyViewAsScope(path) {
  const target = session.viewAs;
  if (!target) return path;

  const url = new URL(path, location.origin);
  const key = target.role === 'SALES' ? 'salesAgentId' : 'franchiseId';
  if (!url.searchParams.has(key)) url.searchParams.set(key, target.id);
  return url.pathname + url.search;
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `เกิดข้อผิดพลาด (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
  /** รวมข้อความหลักกับรายละเอียดฟิลด์ที่ผิด ให้แสดงผลได้ในบรรทัดเดียว */
  get fullMessage() {
    if (Array.isArray(this.details) && this.details.length) {
      const extra = this.details
        .map((d) => {
          if (d.field) return `${d.field}: ${d.message}`;
          // รายละเอียดของ conflict มักเป็น object ชี้ว่าใคร/อะไรชนอยู่ — หยิบเฉพาะที่คนอ่านรู้เรื่อง
          const who = d.agentUsername ?? d.franchiseUsername ?? d.sku ?? d.invoiceNo;
          const when = d.startDate ? ` ตั้งแต่ ${d.startDate}${d.endDate ? ` ถึง ${d.endDate}` : ''}` : '';
          return who ? `${who}${when}` : null;
        })
        .filter(Boolean)
        .join(', ');
      return `${this.message} (${extra})`;
    }
    return this.message;
  }
}

/*
 * เซิร์ฟเวอร์ให้ทำสิ่งนี้ก่อนถึงจะใช้งานอย่างอื่นได้ (เปลี่ยนรหัสเริ่มต้น / ตั้ง Google Authenticator)
 * พาไปหน้าตั้งค่าเอง ไม่ปล่อยให้ผู้ใช้เห็น error แดงเต็มจอโดยไม่รู้ต้องทำอะไร
 */
const SETUP_CODES = new Set(['MFA_ENROLL_REQUIRED', 'PASSWORD_CHANGE_REQUIRED']);

async function request(method, path, body, { headers = {} } = {}) {
  const res = await fetch(method === 'GET' ? applyViewAsScope(path) : path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  noteBuild(res); // เซิร์ฟเวอร์อัปเดตไปแล้วระหว่างที่หน้านี้เปิดค้างอยู่ไหม

  const payload = res.status === 204 ? null : await res.json().catch(() => null);

  if (res.status === 401 && session.token) {
    session.clear();
    location.hash = '#/login';
    location.reload();
  }
  if (res.status === 403 && SETUP_CODES.has(payload?.error?.code) && location.hash !== '#/setup') {
    location.hash = '#/setup';
  }
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

/**
 * อัปโหลดไฟล์ — ส่ง File เป็น raw body ตรง ๆ ไม่ใช้ multipart
 * เซิร์ฟเวอร์ตรวจชนิดไฟล์จาก magic bytes เองอยู่แล้ว จึงไม่ต้องพึ่ง content-type ที่ส่งไป
 */
/*
 * ย่อรูปก่อนส่ง — รูปสลิปจากมือถือ 3–5 MB ย่อเหลือราว 200–400 KB ตัวหนังสือในสลิปยังอ่านชัด
 *   · ขอบยาวสุด 2000px · JPEG คุณภาพ 82% · พื้นโปร่งใสเติมขาว (สลิปบางธนาคารเป็น PNG)
 *   · เข้ารหัสใหม่ = ข้อมูลแฝงในรูป (ตำแหน่ง GPS ฯลฯ) หายไปด้วย
 *   · รูป HEIC ของ iPhone: Safari อ่านได้ → ได้ JPEG ที่เซิร์ฟเวอร์รับ
 * ไม่ย่อ: PDF · GIF · รูปเล็กอยู่แล้ว · ย่อแล้วใหญ่กว่าเดิม · เบราว์เซอร์อ่านรูปไม่ได้ (ส่งไฟล์เดิม ให้เซิร์ฟเวอร์ตัดสิน)
 */
const SHRINK_OVER_BYTES = 700 * 1024;
const SHRINK_MAX_EDGE = 2000;

export async function shrinkImage(file) {
  const heic = /image\/hei[cf]/i.test(file?.type ?? '') || /\.hei[cf]$/i.test(file?.name ?? '');
  if (!file?.type?.startsWith('image/') && !heic) return file;
  if (file.type === 'image/gif' || (!heic && file.size <= SHRINK_OVER_BYTES)) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, SHRINK_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return blob && (heic || blob.size < file.size) ? blob : file;
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function upload(original) {
  const file = await shrinkImage(original);
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
    },
    body: file,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body, opts) => request('POST', path, body ?? {}, opts),
  patch: (path, body, opts) => request('PATCH', path, body, opts),
  put: (path, body, opts) => request('PUT', path, body, opts),
  del: (path, body, opts) => request('DELETE', path, body, opts),
  upload,
};

/** ต่อ query string โดยตัดค่าว่างทิ้ง */
export function qs(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') usp.set(key, value);
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}
