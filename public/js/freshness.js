/*
 * หน้าที่เปิดค้างไว้ข้ามการอัปเดตระบบ — โค้ดหน้าเว็บอยู่ในหน่วยความจำของแท็บ เปลี่ยนเมนูไปมาก็ยังเป็นรุ่นเก่า
 * (เจ้าของเห็นปุ่ม "แก้ไข" สินค้าแบบเดิม ทั้งที่เซิร์ฟเวอร์อัปเดตแล้ว)
 *
 * ทุก response ของเซิร์ฟเวอร์ติด X-Paynest-Build (ป้ายรุ่นของไฟล์หน้าเว็บชุดปัจจุบัน — app/Libraries/AssetVersion.php)
 * ไม่ตรงกับป้ายที่หน้านี้โหลดมา (meta paynest-build) = มีรุ่นใหม่แล้ว:
 *   · ขึ้นแถบให้กดโหลดหน้าใหม่ (ไม่โหลดเองทันที — อาจกำลังกรอกฟอร์มค้างอยู่)
 *   · เปลี่ยนเมนูครั้งถัดไปโหลดหน้าใหม่ทั้งหน้าเอง (ไม่มีอะไรค้างให้หาย) — app.js เช็ก isStale()
 * ไม่ import อะไรเลย — api.js เรียกตัวนี้ และ ui.js ก็ import api.js
 */
const loadedBuild = document.querySelector('meta[name="paynest-build"]')?.content ?? '';
let stale = false;

export const isStale = () => stale;

/** ส่ง Response ของ fetch มาให้ดูป้ายรุ่น */
export function noteBuild(res) {
  const current = res?.headers?.get?.('x-paynest-build');
  if (stale || !loadedBuild || !current || current === loadedBuild) return;
  stale = true;
  showBar();
}

function showBar() {
  const text = document.createElement('span');
  text.textContent = 'ระบบอัปเดตเป็นรุ่นใหม่แล้ว — กดโหลดหน้าใหม่เพื่อใช้รุ่นล่าสุด (ถ้ากรอกอะไรค้างอยู่ บันทึกก่อนแล้วค่อยกด)';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'btn sm';
  reload.textContent = 'โหลดหน้าใหม่';
  reload.addEventListener('click', () => location.reload());
  const bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.setAttribute('role', 'status');
  bar.append(text, reload);
  document.body.append(bar);
}

/*
 * แท็บที่ทิ้งไว้แล้วกลับมาเปิดดู — ถามเซิร์ฟเวอร์ทันที ไม่ต้องรอให้กดอะไรก่อน (ไม่เกินนาทีละครั้ง)
 * /health ไม่ต้องเข้าสู่ระบบและเล็กที่สุด
 */
let lastCheck = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || stale || Date.now() - lastCheck < 60_000) return;
  lastCheck = Date.now();
  fetch('/health', { cache: 'no-store' }).then(noteBuild).catch(() => {});
});
