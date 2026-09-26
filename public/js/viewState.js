/**
 * ที่เก็บสถานะชั่วคราวของหน้า เช่น แท็บที่เปิดอยู่ ตัวกรอง หรือรอบบิลที่กำลังดู
 *
 * หน้าตาใช้งานเหมือน sessionStorage แต่ "ล้างทิ้งทุกครั้งที่ย้ายไปหน้าอื่น"
 * — ออกจากหน้าแล้วกลับเข้ามาใหม่จึงได้ค่าตั้งต้นของหน้านั้นเสมอ ไม่ค้างแท็บเก่าไว้
 *
 * ส่วนการกดปุ่มในหน้าเดิม (เปลี่ยนแท็บ/เปลี่ยนตัวกรอง) เรียก render() ซ้ำโดย path ไม่เปลี่ยน
 * ค่าจึงยังอยู่ครบตามที่ผู้ใช้เพิ่งเลือก
 */
let currentPath = null;
let store = new Map();

/**
 * app.js เรียกทุกรอบที่วาดหน้า — ถ้าคนละหน้ากับรอบก่อน ให้ล้างของเก่าทิ้ง
 * คืน true เมื่อเพิ่งย้ายหน้าจริง ๆ (ไม่ใช่การวาดซ้ำหน้าเดิม)
 */
export function scopeStateTo(path) {
  if (path === currentPath) return false;
  currentPath = path;
  store = new Map();
  return true;
}

export const viewState = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
};
