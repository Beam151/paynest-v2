import { api, qs, session } from '../api.js';
import { clear, el, infoModal } from '../ui.js';

const PAGE_SIZE = 25;

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** เวลาใน DB เป็น UTC รูปแบบ 'YYYY-MM-DD HH:MM:SS' — ต้องบอก JS ให้ชัด ไม่งั้นเพี้ยนไป 7 ชม. */
const toDate = (iso) => new Date(`${iso.replace(' ', 'T')}Z`);

/*
 * ประวัติโชว์เป็นเวลาไทยเสมอ ไม่ใช่เวลาเครื่องผู้ใช้
 * คนในทีมที่เปิดจากคนละประเทศต้องเห็นเวลาเดียวกับที่ออฟฟิศไทยเห็น
 * ไม่งั้นคุยกันว่า "รายการตอนบ่ายสอง" แล้วหากันไม่เจอ
 */
const THAI_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false,
});
const THAI_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' });
const thaiDay = (d) => THAI_DAY.format(d);

function timeAgo(iso) {
  const mins = Math.floor((Date.now() - toDate(iso).getTime()) / 60000);
  if (Number.isNaN(mins)) return '';
  if (mins < 1) return 'เมื่อครู่';
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ชั่วโมงที่แล้ว`;
  const days = Math.floor(hrs / 24);
  return days < 30 ? `${days} วันที่แล้ว` : '';
}

/** หัวข้อคั่นวัน — "วันนี้ / เมื่อวาน / 18 ก.ย. 2026" */
function dayLabel(iso) {
  const day = thaiDay(toDate(iso));
  const now = new Date();
  if (day === thaiDay(now)) return 'วันนี้';
  if (day === thaiDay(new Date(now.getTime() - 86400000))) return 'เมื่อวาน';
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${THAI_MONTHS[m - 1]} ${String((y + 543) % 100).padStart(2, '0')}`; // ปี พ.ศ. เหมือนทั้งระบบ
}

const clockOf = (iso) => THAI_CLOCK.format(toDate(iso));

/** สีจุดนำหน้าให้เดาได้ว่าเป็นการเพิ่ม/แก้/ลบ โดยไม่ต้องอ่านข้อความ */
function toneOf(action) {
  if (/\.(delete|void|remove|reject|cancel|end)$/.test(action)) return 'danger';
  if (/\.(create|add|submit|approve|pay|payment|add_lines)$/.test(action)) return 'success';
  return 'muted';
}

function renderInto(list, items) {
  let lastDay = list.dataset.lastDay ?? '';
  for (const a of items) {
    const day = dayLabel(a.at);
    if (day !== lastDay) {
      list.append(el('li', { class: 'day' }, day));
      lastDay = day;
    }
    list.append(el('li', { class: `tone-${toneOf(a.action)}` },
      el('span', { class: 'dot' }),
      el('span', { class: 'what' }, a.what, a.target ? el('strong', {}, ` ${a.target}`) : ''),
      el('span', { class: 'who' }, a.actor),
      el('span', { class: 'when', title: a.at }, clockOf(a.at), el('small', {}, timeAgo(a.at)))));
  }
  list.dataset.lastDay = lastDay;
}

/**
 * โมดัลประวัติรายการของหน้านั้น ๆ — โหลดทีละ 25 แถว กด "โหลดเพิ่ม" ได้จนครบ
 * แยกเป็นโมดัลเพราะประวัติเป็นข้อมูลที่ "ดูเมื่ออยากดู" ไม่ใช่ของที่ต้องเห็นตลอดเวลา
 */
async function openActivity(actions, title) {
  const modal = infoModal({ title, width: 720, content: null });

  const list = el('ul', { class: 'activity' });
  const status = el('div', { class: 'sub-line' });
  const moreBtn = el('button', { class: 'btn ghost sm', style: 'display:none' }, 'โหลดเพิ่ม');
  const footer = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-top:12px' },
    status, moreBtn);

  modal.body.append(el('div', { class: 'loading' }, 'กำลังโหลด…'));

  let offset = 0;
  let loading = false;

  async function load() {
    if (loading) return;
    loading = true;
    moreBtn.disabled = true;
    try {
      const res = await api.get(`/api/activity${qs({ actions: actions?.join(','), limit: PAGE_SIZE, offset })}`);

      if (offset === 0) {
        clear(modal.body);
        if (!res.items.length) {
          modal.body.append(el('div', { class: 'empty' }, 'ยังไม่มีความเคลื่อนไหวในหน้านี้'));
          return;
        }
        modal.body.append(list, footer);
      }

      renderInto(list, res.items);
      offset += res.items.length;
      status.textContent = `แสดง ${offset} จาก ${res.total} รายการ`;
      moreBtn.style.display = res.hasMore ? '' : 'none';
    } catch (err) {
      clear(modal.body).append(el('div', { class: 'error-box' }, err.fullMessage ?? err.message));
    } finally {
      loading = false;
      moreBtn.disabled = false;
    }
  }

  moreBtn.addEventListener('click', load);
  await load();
}

/**
 * ปุ่ม "ประวัติ" สำหรับวางในหัวข้อของแต่ละหน้า
 * @param actions อาเรย์ prefix ของ action ที่หน้านั้นสนใจ เช่น ['invoice']
 *
 * เฉพาะส่วนกลาง — ประวัติรวมทุกร้าน ถ้าให้ร้านค้าเห็นจะรั่วข้อมูลร้านอื่น
 */
export function activityButton(actions, { title = 'ประวัติรายการ' } = {}) {
  if (!session.isSuper) return '';
  return el('button', {
    class: 'btn ghost',
    title: 'ดูความเคลื่อนไหวล่าสุดของหน้านี้',
    onclick: () => openActivity(actions, title),
  }, '🕘 ประวัติ');
}
