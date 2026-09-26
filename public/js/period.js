/** ตัวช่วยเรื่องรอบบิลครึ่งเดือนฝั่งเบราว์เซอร์ (ตรรกะเดียวกับ app/Libraries/Period.php) */
const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const pad = (n) => String(n).padStart(2, '0');

export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/*
 * วันและเวลา "ตอนนี้" ตามเวลาไทยเสมอ ไม่ใช่ UTC และไม่ใช่เวลาเครื่องผู้ใช้
 *
 * ต้องตรงกับ today() ของเซิร์ฟเวอร์ ไม่งั้นค่าตั้งต้นในฟอร์มจะเป็นวันที่เซิร์ฟเวอร์ปฏิเสธ
 * (เช่นเปิดฟอร์มแจ้งชำระตอนตีหนึ่ง แล้วโดนตีกลับว่า "วันที่โอนเป็นอนาคต")
 * ไทยเป็น UTC+7 ตลอดปี ไม่มี DST จึงตรึง Asia/Bangkok ไว้ได้เลย
 */
const THAI_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' });
const THAI_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false,
});

export const todayIso = () => THAI_DATE.format(new Date());

/** เวลาปัจจุบันแบบ HH:MM ตามเวลาไทย (ใช้เป็นค่าตั้งต้นของช่องเวลา) */
export const nowHHMM = () => THAI_TIME.format(new Date());

export function periodOf(iso = todayIso()) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${y}-${pad(m)}-H${d <= 15 ? 1 : 2}`;
}

const toIndex = (code) => {
  const [y, m, h] = [Number(code.slice(0, 4)), Number(code.slice(5, 7)), Number(code.slice(9))];
  return (y * 12 + (m - 1)) * 2 + (h - 1);
};

const fromIndex = (index) => {
  const half = (index % 2) + 1;
  const months = Math.floor(index / 2);
  return `${Math.floor(months / 12)}-${pad((months % 12) + 1)}-H${half}`;
};

export const shiftPeriod = (code, steps) => fromIndex(toIndex(code) + steps);

/*
 * รอบที่กำลังทำงาน — ใช้ค่าเดียวกันทุกหน้า และจำไว้ตลอดแท็บนี้
 * เดิมแต่ละหน้าจำเอง แล้วล้างทิ้งทุกครั้งที่ย้ายหน้า เลือก H1 ที่หน้ายอดขาย ไปหน้าบิลกลายเป็น H2
 */
const WORK_KEY = 'franchise.workingPeriod';

/**
 * ค่าตั้งต้น: 5 วันแรกหลังปิดรอบ (วันที่ 16–20 และ 1–5) = รอบที่เพิ่งปิด
 * ช่วงนั้นคือช่วงกรอกยอด ออกบิล ตามเก็บเงินของรอบก่อน — รอบใหม่ยังว่างเปล่า
 */
export function defaultWorkingPeriod() {
  const now = periodOf();
  const day = Number(todayIso().slice(8, 10));
  const dayInPeriod = day <= 15 ? day : day - 15;
  return dayInPeriod <= 5 ? shiftPeriod(now, -1) : now;
}

/** รอบที่ผู้ใช้เลือกไว้ในแท็บนี้ (null = ยังไม่เคยเลือก) */
export function storedWorkingPeriod() {
  try { return sessionStorage.getItem(WORK_KEY) || null; } catch { return null; }
}

export const workingPeriod = () => storedWorkingPeriod() ?? defaultWorkingPeriod();

export function setWorkingPeriod(code) {
  if (!code) return; // "ทุกรอบ" เป็นตัวกรองของหน้าบิลเท่านั้น ไม่ใช่รอบที่ทำงาน
  try { sessionStorage.setItem(WORK_KEY, code); } catch { /* โหมดส่วนตัวบางแบบเขียนไม่ได้ — ใช้ค่าตั้งต้นต่อ */ }
}

/** ช่วงวันที่ของรอบบิล */
export function periodRange(code) {
  const y = Number(code.slice(0, 4));
  const m = Number(code.slice(5, 7));
  const half = Number(code.slice(9));
  return half === 1
    ? { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-15` }
    : { start: `${y}-${pad(m)}-16`, end: `${y}-${pad(m)}-${pad(daysInMonth(y, m))}` };
}

/*
 * ปีแสดงเป็น พ.ศ. สองหลักทั้งระบบ (69 = 2569) — แบบที่เอกสารธุรกิจไทยใช้
 * เดิมปนกันระหว่าง ค.ศ. กับ พ.ศ. (ช่องวันที่ของเครื่องที่ตั้งภาษาไทยเป็น พ.ศ. แต่ในตารางเป็น ค.ศ.)
 */
export const beShort = (year) => String((Number(year) + 543) % 100).padStart(2, '0');

/** ชื่อรอบที่คนอ่าน: "1–15 ก.ย. 69" — ไม่ให้ผู้ใช้เห็นรหัสดิบ "2026-09-H1" */
export function periodLabel(code) {
  if (!code) return '—';
  const y = Number(code.slice(0, 4));
  const m = Number(code.slice(5, 7));
  const half = Number(code.slice(9));
  const days = half === 1 ? '1–15' : `16–${daysInMonth(y, m)}`;
  return `${days} ${THAI_MONTHS[m - 1]} ${beShort(y)}`;
}

/** ชื่อรอบแบบสั้นสำหรับแกนกราฟ: "ต้น ก.ย." / "ปลาย ก.ย." */
export function periodShort(code) {
  const m = Number(code.slice(5, 7));
  return `${code.endsWith('H1') ? 'ต้น' : 'ปลาย'} ${THAI_MONTHS[m - 1]}`;
}

/** ตัวเลือกรอบบิล: ย้อนหลัง back รอบ ถึงล่วงหน้า forward รอบ (ใหม่สุดอยู่บน) */
export function periodOptions({ back = 17, forward = 1, from = periodOf() } = {}) {
  const base = toIndex(from);
  const out = [];
  for (let i = base + forward; i >= base - back; i -= 1) {
    const code = fromIndex(i);
    out.push({ value: code, label: periodLabel(code) });
  }
  return out;
}

export function monthOptions({ back = 17, forward = 0 } = {}) {
  const now = new Date();
  const base = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const out = [];
  for (let i = base + forward; i >= base - back; i -= 1) {
    const y = Math.floor(i / 12);
    const m = (i % 12) + 1;
    out.push({ value: `${y}-${pad(m)}`, label: `${THAI_MONTHS[m - 1]} ${y}` });
  }
  return out;
}

export const shiftMonth = (key, steps) => {
  const total = Number(key.slice(0, 4)) * 12 + (Number(key.slice(5, 7)) - 1) + steps;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
};
