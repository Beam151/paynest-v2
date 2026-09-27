import { api } from './api.js';
import { dateTimeTh, el, icon, infoModal } from './ui.js';

/*
 * รุ่นของระบบ + เวลาอัปเดต — ปุ่มท้ายเมนูซ้าย (กดแล้วเปิดรายละเอียด) และการ์ดในหน้าตั้งค่าของส่วนกลาง
 * รายละเอียด (commit, รุ่นก่อนหน้า, ยังไม่ได้รัน app:install) เซิร์ฟเวอร์ส่งให้ส่วนกลางเท่านั้น — ร้าน/เซลได้แค่รุ่นกับวันที่
 */

const label = (r) => `${r.version}${r.commit ? ` (${r.commit})` : ''}`;

/**
 * เนื้อหารายละเอียดรุ่น — เวลาอัปเดตคือตอนที่รัน app:install บนเซิร์ฟเวอร์ (ไม่ใช่ตอน git pull)
 * git pull แล้วลืม app:install = ฐานข้อมูลอาจยังเป็นโครงสร้างเก่า หน้าที่ใช้ของใหม่จะพัง จึงเตือนไว้
 * ช่วงนั้นเวลาอัปเดตเป็นของรุ่นที่ติดตั้งไว้ก่อน ไม่ใช่ของโค้ดที่รันอยู่ — บอกให้ชัดว่าเป็นของรุ่นไหน
 */
export function versionDetails(v) {
  const detail = v.installPending
    ? (v.installed ? `ติดตั้งล่าสุดคือรุ่น ${label(v.installed)} เมื่อ ${dateTimeTh(v.updatedAt)}` : 'ยังไม่มีบันทึกการติดตั้ง')
    : v.updatedAt ? `อัปเดตล่าสุด ${dateTimeTh(v.updatedAt)}${v.previous ? ` · ก่อนหน้านี้รุ่น ${label(v.previous)}` : ''}`
      : 'ยังไม่มีบันทึกเวลาอัปเดต';
  return el('div', {},
    el('div', { class: 'channel-row' },
      el('span', { class: `channel-ico${v.installPending ? '' : ' on'}` }, icon(v.installPending ? 'triangle-alert' : 'package')),
      el('div', { class: 'channel-text' },
        el('strong', {}, `รุ่น ${label(v)}`),
        el('span', { class: 'sub-line' }, detail))),
    v.installPending ? el('div', { class: 'alert-box mt-8' },
      'โค้ดรุ่นนี้ยังไม่ได้รัน ', el('code', {}, 'php spark app:install'),
      ' บนเซิร์ฟเวอร์ — โครงสร้างฐานข้อมูลอาจยังเป็นของรุ่นก่อน รันคำสั่งนี้ให้เรียบร้อย (ดูคู่มือ DEPLOY.md ข้อ 7)') : '');
}

/** ขอใหม่ทุกครั้งที่กด — เพิ่งรัน app:install ไปก็เห็นผลทันทีโดยไม่ต้องโหลดหน้าใหม่ */
async function openVersionModal() {
  const modal = infoModal({ title: 'เวอร์ชันระบบ', width: 480, content: el('div', { class: 'loading' }, 'กำลังโหลด…') });
  try {
    modal.body.replaceChildren(versionDetails(await api.get('/api/system/version')));
  } catch (err) {
    modal.body.replaceChildren(el('div', { class: 'error-box' }, err.fullMessage ?? err.message));
  }
}

/*
 * ท้ายเมนูซ้าย — ตอบคำถาม "อัปเดตแล้วหรือยัง" ได้โดยไม่ต้องถามคนดูแลเซิร์ฟเวอร์
 * ขอครั้งเดียวต่อการเปิดหน้าเว็บ: รุ่นเปลี่ยนก็ต่อเมื่อโหลดหน้าใหม่ (ไฟล์ JS ที่เปิดอยู่ยังเป็นรุ่นเดิม)
 * ดึงไม่ได้ก็แค่ไม่มีปุ่ม (ปุ่มว่าง = ซ่อน ด้วย :empty ใน styles.css)
 */
let sidebarRequest = null;
export function versionButton() {
  const button = el('button', { class: 'sidebar-version', type: 'button', title: 'ดูรายละเอียดเวอร์ชันระบบ', onclick: openVersionModal });
  sidebarRequest ??= api.get('/api/system/version').catch(() => { sidebarRequest = null; return null; });
  sidebarRequest.then((v) => {
    if (!v) return;
    button.replaceChildren(
      el('span', { class: 'ico' }, icon('info')),
      el('span', { class: 'lines' },
        el('span', {}, `รุ่น ${v.version}`),
        v.updatedAt ? el('span', {}, `อัปเดต ${dateTimeTh(v.updatedAt)}`) : ''));
  });
  return button;
}
