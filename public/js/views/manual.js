import { api, session } from '../api.js';
import { el, icon } from '../ui.js';
import { hashParam } from '../app.js';
import { viewState } from '../viewState.js';

/*
 * คู่มือการใช้งาน — เนื้อหามาจากเซิร์ฟเวอร์ตามบทบาทของคนที่ล็อกอิน (app/Manual/*.html)
 * ร้านได้แค่คู่มือร้าน เซลได้แค่คู่มือเซล — ขอของบทบาทอื่นเซิร์ฟเวอร์ก็ไม่ให้
 * ส่วนกลางระหว่าง "ดูมุมมองนี้" ได้คู่มือของบทบาทที่กำลังดูอยู่ จะได้รู้ว่าร้านอ่านอะไร
 *
 * หน้าแรกของคู่มือเป็นปุ่ม "อยากทำอะไร" → กดแล้วเห็นเรื่องเดียว ([data-guide] → section#id)
 * ลิงก์ตรงเรื่อง: #/manual?section=pay
 *
 * สอนแยก คอมพิวเตอร์ / มือถือ — เมนูอยู่คนละที่ (เมนูซ้าย vs แถบล่าง)
 * รูปจำลองหน้าจอในไฟล์คู่มือเขียนแค่เนื้อหา + บอกว่าอยู่หน้าไหน (data-nav) — กรอบ เมนู แถบล่าง วาดที่นี่ตามอุปกรณ์ที่เลือก
 */
const SECTION = { SUPER_ADMIN: 'admin', FRANCHISE: 'shop', SALES: 'sales' };
const GUIDE_KEY = 'franchise.manualGuide';
const DEVICE_KEY = 'franchise.manualDevice';

const readDevice = () => {
  try { return localStorage.getItem(DEVICE_KEY); } catch { return null; }
};
const saveDevice = (d) => {
  try { localStorage.setItem(DEVICE_KEY, d); } catch { /* ไม่เป็นไร */ }
};

export async function manualView() {
  const { html, nav } = await api.get(`/api/manual?role=${SECTION[session.role] ?? ''}`);
  const page = el('div', {});
  // เนื้อหาเป็นไฟล์ของเราเองบนเซิร์ฟเวอร์ ไม่ใช่ข้อมูลที่ผู้ใช้พิมพ์ — ใส่เป็น HTML ได้
  page.innerHTML = html;
  const manual = page.querySelector('.manual');
  const home = page.querySelector('.m-home');
  const guides = [...page.querySelectorAll('.m-guide')];
  const shots = [...page.querySelectorAll('.m-shot')];
  shots.forEach((s) => { s.dataset.src = s.innerHTML; });

  // ── เลือกอุปกรณ์ ── ค่าตั้งต้นตามจอที่เปิดอยู่ · จำไว้ในเครื่องนี้
  let device = readDevice() ?? (window.matchMedia('(max-width: 860px)').matches ? 'mobile' : 'desktop');
  const toggle = el('div', { class: 'm-device', role: 'radiogroup', 'aria-label': 'สอนสำหรับ' },
    ...[['desktop', 'monitor', 'คอมพิวเตอร์'], ['mobile', 'smartphone', 'มือถือ']].map(([key, ico, label]) => el('button', {
      type: 'button',
      role: 'radio',
      'data-device': key,
      onclick: () => { device = key; saveDevice(key); applyDevice(); },
    }, icon(ico), label)));
  manual.prepend(el('div', { class: 'm-device-bar' }, el('span', {}, 'ดูวิธีสำหรับ'), toggle));

  function applyDevice() {
    manual.dataset.device = device;
    toggle.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.device === device)));
    shots.forEach((s) => drawShot(s, nav, device));
  }

  const open = (id, { scroll = true } = {}) => {
    const target = guides.find((g) => g.id === id);
    if (home) home.hidden = Boolean(target);
    guides.forEach((g) => { g.hidden = g !== target; });
    viewState.setItem(GUIDE_KEY, target ? id : '');
    // เปลี่ยนแค่ที่อยู่บนแถบ URL (ไม่ให้ router วาดหน้าใหม่) — กดรีเฟรชหรือส่งลิงก์ต่อได้ตรงเรื่อง
    try { history.replaceState(null, '', target ? `#/manual?section=${id}` : '#/manual'); } catch { /* ไม่เป็นไร */ }
    if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  page.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-guide]');
    if (pick) { open(pick.dataset.guide); return; }
    if (e.target.closest('[data-home]')) open('');
  });

  applyDevice();
  open(hashParam('section') ?? viewState.getItem(GUIDE_KEY) ?? '', { scroll: false });
  return page;
}

/* ── วาดกรอบรูปจำลอง ─────────────────────────────────────────── */

const tap = () => el('span', { class: 's-tap' }, icon('hand'));

/**
 * data-nav      หน้าที่ภาพนี้อยู่ (ไฮไลต์เมนูนั้น)
 * data-tap-nav  ขั้นนี้คือ "ไปที่เมนู" — วงกลมเมนูให้เห็นว่าต้องกดตรงไหน
 * data-modal    หน้าต่างที่เด้งขึ้นมา (คอม = กล่องกลางจอ · มือถือ = เต็มจอ)
 * data-app      แอปอื่น (Telegram) — วาดเหมือนกันทั้งสองแบบ
 */
function drawShot(shot, nav, device) {
  const { title = '', extra, modal, app } = shot.dataset;
  const key = shot.dataset.nav ?? '';
  const tapNav = 'tapNav' in shot.dataset;
  const body = el('div', { class: app ? '' : 's-body' });
  body.innerHTML = shot.dataset.src;
  const content = app ? [...body.childNodes] : [body];
  // แอป Telegram วาดเป็นจอมือถือเสมอ (บนคอมก็คือแชตหน้าตาเดียวกัน)
  shot.className = app ? 'm-shot is-mobile is-app' : `m-shot is-${device}`;

  if (app) {
    shot.replaceChildren(el('div', { class: 's-top s-tgtop' }, title), ...content);
    return;
  }
  const head = [title, extra ? el('span', { class: 's-chip' }, extra) : ''];

  if (device === 'mobile') {
    const inBottom = nav.mobile.some(([k]) => k === key);
    const burger = el('span', { class: `s-burger${tapNav && !inBottom && key && key !== 'account' ? ' s-hl' : ''}` }, '☰',
      tapNav && !inBottom && key && key !== 'account' ? tap() : '');
    if (modal) {
      shot.replaceChildren(el('div', { class: 's-top' }, el('span', {}, ...head), el('span', {}, '✕')), ...content);
      return;
    }
    const bottom = el('div', { class: 's-nav' }, ...nav.mobile.map(([k, label, ico]) => {
      const on = k === key;
      return el('span', { class: `${on ? 'on' : ''}${on && tapNav ? ' s-hl' : ''}` }, icon(ico), label, on && tapNav ? tap() : '');
    }));
    shot.replaceChildren(el('div', { class: 's-top' }, el('span', { class: 's-top-l' }, burger, el('span', {}, ...head))), ...content, bottom);
    return;
  }

  // คอมพิวเตอร์: หน้าต่างเบราว์เซอร์ + เมนูซ้าย + ชื่อผู้ใช้มุมซ้ายล่าง
  const side = el('aside', { class: 's-side' },
    el('div', { class: 's-brand' }, icon('store'), 'ระบบจัดการร้าน'),
    ...nav.desktop.map(([k, label, ico]) => {
      const on = k === key;
      return el('span', { class: `s-item${on ? ' on' : ''}${on && tapNav ? ' s-hl' : ''}` }, icon(ico), label, on && tapNav ? tap() : '');
    }),
    el('span', { class: 's-spacer' }),
    el('span', { class: `s-user${key === 'account' ? ' on' : ''}${key === 'account' && tapNav ? ' s-hl' : ''}` },
      icon('settings'), el('span', {}, el('b', {}, nav.user.name), el('small', {}, nav.user.role)),
      key === 'account' && tapNav ? tap() : ''));
  const main = modal
    ? el('div', { class: 's-main is-dim' },
      el('div', { class: 's-page' }, el('div', { class: 's-line', style: 'width:40%;height:9px' }), el('div', { class: 's-line', style: 'width:70%' }), el('div', { class: 's-line', style: 'width:55%' })),
      el('div', { class: 's-modal' }, el('div', { class: 's-modal-head' }, el('span', {}, ...head), el('span', {}, '✕')), ...content))
    : el('div', { class: 's-main' }, el('div', { class: 's-page-title' }, ...head), ...content);
  shot.replaceChildren(
    el('div', { class: 's-chrome' }, el('i'), el('i'), el('i'), el('span', {}, 'ระบบจัดการร้าน')),
    el('div', { class: 's-desk' }, side, main));
}
