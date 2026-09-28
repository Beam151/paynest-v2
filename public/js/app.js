import { api, session } from './api.js';
import { beginRender, clear, el, icon, iconFor, toast } from './ui.js';
import { scopeStateTo } from './viewState.js';
import { versionButton } from './version.js';
import { loginView } from './views/login.js';
import { dashboardView } from './views/dashboard.js';
import { franchisesView } from './views/franchises.js';
import { productsView } from './views/products.js';
import { salesView } from './views/sales.js';
import { invoicesView } from './views/invoices.js';
import { reportsView } from './views/reports.js';
import { accountView } from './views/account.js';
import { salesAgentsView } from './views/salesAgents.js';
import { myCommissionsView, myDealsView } from './views/myCommissions.js';
import { chargeItemsView } from './views/chargeItems.js';
import { ledgerView } from './views/ledger.js';
import { bankAccountsView, bankChangeBanner } from './views/bankAccounts.js';
import { setupView } from './views/twoFactor.js';
import { settingsView } from './views/settings.js';
import { announcementsView } from './views/announcements.js';
import { manualView } from './views/manual.js';

const ALL = ['SUPER_ADMIN', 'FRANCHISE', 'SALES'];
const STAFF = ['SUPER_ADMIN', 'FRANCHISE'];
const SUPER = ['SUPER_ADMIN'];

const ROUTES = {
  '/dashboard': { label: 'ภาพรวม', icon: '📊', view: dashboardView, roles: STAFF },
  // เซลมีสองคำถามคนละเรื่อง: "รอบนี้ได้เท่าไร" กับ "เราถือสินค้าอะไรอยู่บ้าง"
  '/my-sales': { label: 'รายได้ของฉัน', icon: '🎯', view: myCommissionsView, roles: ['SALES'] },
  '/my-deals': { label: 'สินค้าที่ถือดีล', icon: '📦', view: myDealsView, roles: ['SALES'] },
  '/franchises': { label: 'ร้านค้า', icon: '🏪', view: franchisesView, roles: SUPER },
  '/sales-agents': { label: 'เซล', icon: '🤝', view: salesAgentsView, roles: SUPER },
  '/products': { label: 'สินค้า', icon: '📦', view: productsView, roles: STAFF },
  '/sales': { label: 'ยอดขายรายรอบ', icon: '🧾', view: salesView, roles: SUPER },
  '/invoices': {
    // ร้านเห็นทั้งบิลและการจ่ายในหน้าเดียว จึงใช้ชื่อกลาง ๆ ว่า "บิลของฉัน"
    // ส่วนกลาง: การตรวจสลิปก็อยู่หน้านี้ ชื่อเดิม "ใบเรียกเก็บ" ทำให้หาที่ตรวจสลิปไม่เจอ
    label: () => (session.role === 'SUPER_ADMIN' ? 'บิลและการชำระ' : 'บิลของฉัน'),
    icon: '💰',
    view: invoicesView,
    roles: STAFF,
  },

  '/charge-items': { label: 'ค่าใช้จ่าย/ส่วนลด', icon: '🏷️', view: chargeItemsView, roles: SUPER },
  // บัญชีที่ให้ร้านโอนเงินเข้า — อยู่กลุ่ม "จัดการ" เพราะเป็นข้อมูลตั้งต้นเหมือนสินค้า/ค่าใช้จ่าย
  '/bank-accounts': { label: 'บัญชีรับเงิน', icon: '🏦', view: bankAccountsView, roles: SUPER },
  // สมุดของส่วนกลางเอง อยู่กลุ่มรอบบิลเพราะดูเทียบกับยอดที่เก็บได้ในรอบเดียวกัน
  '/ledger': { label: 'รายรับ-รายจ่ายของเรา', icon: '📒', view: ledgerView, roles: SUPER },
  '/reports': { label: 'รายงานเปรียบเทียบ', icon: '📈', view: reportsView, roles: STAFF },
  // การแจ้งเตือนของส่วนกลาง (Telegram + เรื่องที่จะแจ้ง + เวลา)
  '/settings': { label: 'ตั้งค่าแจ้งเตือน', icon: '🔔', view: settingsView, roles: SUPER },
  // ประกาศถึงทุกร้าน — ร้านเห็นที่หน้าแรกของตัวเอง
  '/announcements': { label: 'ประกาศถึงร้าน', icon: '📣', view: announcementsView, roles: SUPER },
  '/account': { label: 'บัญชีของฉัน', icon: '⚙️', view: accountView, roles: ALL },
  // คู่มือของบทบาทตัวเอง — ลิงก์อยู่เหนือชื่อผู้ใช้ ไม่ได้อยู่ในกลุ่มเมนูงาน
  '/manual': { label: 'คู่มือการใช้งาน', icon: '📖', view: manualView, roles: ALL },
};

/*
 * เรียงตามความถี่ของงาน: งานประจำทุกรอบอยู่บน ข้อมูลตั้งต้นที่แก้นาน ๆ ครั้งอยู่ล่าง
 * (เดิมกลุ่ม "จัดการ" 5 เมนูอยู่เหนืองานประจำ ต้องเลื่อนผ่านทุกวัน)
 */
const NAV_GROUPS = [
  { title: null, paths: ['/dashboard', '/my-sales', '/my-deals'] },
  { title: 'งานประจำรอบ', paths: ['/sales', '/invoices'] },
  { title: 'รายงาน', paths: ['/reports', '/ledger'] },
  { title: 'ข้อมูลหลัก', paths: ['/franchises', '/products', '/sales-agents', '/charge-items', '/bank-accounts'] },
  { title: 'ระบบ', paths: ['/announcements', '/settings'] },
];

/*
 * แถบล่างบนมือถือ — 4 ปุ่มของงานที่ทำบ่อยที่สุด กดได้ด้วยนิ้วโป้ง ไม่ต้องเปิดลิ้นชักทุกครั้ง
 * ปุ่มที่ผู้ใช้ไม่มีสิทธิ์เข้าจะไม่ขึ้น (ผู้ช่วยที่ดูบิลไม่ได้ก็ไม่เห็นปุ่มบิล)
 */
const BOTTOM_NAV = {
  SUPER_ADMIN: [['/dashboard', 'หน้าแรก', '🏠'], ['/invoices', 'บิล', '🧾'], ['/sales', 'ยอดขาย', '🛒'], ['/account', 'บัญชี', '⚙']],
  FRANCHISE: [['/dashboard', 'หน้าแรก', '🏠'], ['/invoices', 'บิล', '🧾'], ['/reports', 'ยอดขาย', '📈'], ['/account', 'บัญชี', '⚙']],
  SALES: [['/my-sales', 'หน้าแรก', '🏠'], ['/my-deals', 'ดีล', '📦'], ['/account', 'บัญชี', '⚙']],
};

function bottomNav(activePath) {
  const items = (BOTTOM_NAV[session.role] ?? []).filter(([path]) => allowed(path));
  if (items.length < 2) return '';
  return el('nav', { class: 'bottom-nav', 'aria-label': 'เมนูหลัก' },
    ...items.map(([path, label, emoji]) => el('a', {
      class: path === activePath ? 'active' : '',
      href: `#${path}`,
      'data-path': path,
      'aria-current': path === activePath ? 'page' : undefined,
    }, iconFor(emoji), el('span', {}, label))));
}

/**
 * โครงหน้าเทา ๆ ระหว่างโหลด — เห็นรูปร่างหน้าก่อนข้อมูลมา รู้สึกเร็วกว่าคำว่า "กำลังโหลด…"
 * (ขึ้นเฉพาะตอนโหลดช้ากว่า 250ms เท่านั้น)
 */
function skeleton() {
  const bar = (w, h = 14) => el('span', { class: 'sk', style: `width:${w};height:${h}px` });
  return el('div', { class: 'skeleton', role: 'status', 'aria-label': 'กำลังโหลด' },
    el('div', { class: 'sk-head' }, bar('220px', 26), bar('160px')),
    el('div', { class: 'stat-grid' }, ...[1, 2, 3, 4].map(() => el('div', { class: 'stat' }, bar('60%'), bar('80%', 24)))),
    el('div', { class: 'card sk-card' }, ...[90, 75, 82, 60, 70].map((w) => bar(`${w}%`))));
}

/** label ของเมนูเป็นข้อความหรือฟังก์ชันก็ได้ (บางหน้าชื่อต่างกันตามบทบาท) */
const labelOf = (path) => {
  const label = ROUTES[path]?.label;
  return typeof label === 'function' ? label() : label;
};

const root = document.getElementById('root');

/*
 * เมนูที่ต้องมีสิทธิ์รายข้อ (ใช้กับผู้ช่วยร้านค้าเท่านั้น)
 * ซ่อนเมนูเป็นแค่ความสุภาพ — ของจริงกันที่เซิร์ฟเวอร์ทุกเส้นทางอยู่แล้ว
 */
const ROUTE_PERMISSION = {
  '/dashboard': 'reports',
  '/reports': 'reports',
  '/invoices': 'bills',
  '/products': 'products',
};

export const hasPermission = (key) => {
  const list = session.user?.permissions;
  // null/undefined = บัญชีที่ไม่ถูกจำกัดสิทธิ์ (เจ้าของร้าน, super, เซล)
  return !Array.isArray(list) || list.includes(key);
};

// ใช้ session.role (บทบาทที่กำลังสวมอยู่) ไม่ใช่บทบาทจริง เพื่อให้โหมด "ดูมุมมองนี้" ทำงาน
const allowed = (path) => {
  if (path === '/account') return true; // บัญชีของตัวเอง เข้าได้เสมอ แม้กำลังสวมมุมคนอื่นอยู่
  if (!ROUTES[path]?.roles.includes(session.role)) return false;

  const needed = ROUTE_PERMISSION[path];
  return !needed || hasPermission(needed);
};

function homePath() {
  if (session.role === 'SALES') return '/my-sales';
  // ผู้ช่วยที่ไม่มีสิทธิ์ดูรายงาน เปิดมาที่หน้าบิลแทน ไม่ใช่เด้งไปหน้าที่เข้าไม่ได้
  if (!hasPermission('reports')) return hasPermission('bills') ? '/invoices' : '/account';
  return '/dashboard';
}

/*
 * ลิงก์พาไปถึงแท็บ/ตัวกรองได้เลย เช่น #/invoices?tab=slips
 * (viewState ล้างทุกครั้งที่ย้ายหน้า จึงส่งผ่านมาทาง URL แทน)
 */
export const hashParam = (name) => new URLSearchParams(location.hash.split('?')[1] ?? '').get(name);

function currentPath() {
  const path = location.hash.replace(/^#/, '').split('?')[0] || homePath();
  return allowed(path) ? path : homePath();
}

const ROLE_LABEL = {
  SUPER_ADMIN: 'ผู้ดูแลระบบส่วนกลาง',
  FRANCHISE: 'ผู้ใช้ของร้าน',
  SALES: 'เซล',
};

function sidebar(activePath) {
  const user = session.user;
  const items = [];

  for (const group of NAV_GROUPS) {
    const visible = group.paths.filter(allowed);
    if (!visible.length) continue;
    if (group.title) items.push(el('div', { class: 'nav-group' }, group.title));
    for (const path of visible) {
      const route = ROUTES[path];
      items.push(el('a', { class: `nav-item${path === activePath ? ' active' : ''}`, href: `#${path}`, 'data-path': path },
        el('span', { class: 'ico' }, iconFor(route.icon)), labelOf(path)));
    }
  }

  const viewAs = session.viewAs;

  const subtitle = viewAs ? `กำลังดูมุมของ ${viewAs.username}`
    : user?.role === 'SUPER_ADMIN' ? 'หลังบ้านส่วนกลาง'
      : user?.role === 'SALES' ? (user.agentUsername ?? 'เซล')
        : (user?.franchiseUsername ?? 'ร้านค้า');

  const detail = user?.role === 'SUPER_ADMIN' ? ROLE_LABEL.SUPER_ADMIN
    : user?.role === 'SALES' ? (user.agentName ?? ROLE_LABEL.SALES)
      : (user?.isOwner ? 'เจ้าของบัญชีร้าน' : ROLE_LABEL.FRANCHISE);

  return el('aside', { class: 'sidebar' },
    el('div', { class: 'brand' },
      el('span', { class: 'mark' }, icon('store')),
      el('span', {}, 'ระบบจัดการร้าน', el('small', {}, subtitle))),
    ...items,
    el('div', { class: 'spacer' }),

    // คู่มือของบทบาทที่กำลังใช้อยู่ (ระหว่างดูมุมร้าน = คู่มือของร้าน)
    el('a', { class: `nav-item${activePath === '/manual' ? ' active' : ''}`, href: '#/manual', 'data-path': '/manual' },
      el('span', { class: 'ico' }, icon('book-open')), 'คู่มือการใช้งาน'),

    // บัญชีของฉัน = ก้อนเดียวกับชื่อผู้ใช้ กดเข้าหน้าบัญชีได้เลย
    // ระหว่าง view-as ยังเป็นบัญชีของ super เองอยู่ จึงแสดงชื่อจริงเสมอ
    el('a', {
      class: `sidebar-user${activePath === '/account' ? ' active' : ''}`,
      href: '#/account',
      title: 'บัญชีของฉัน',
    },
    el('span', { class: 'ico' }, icon('settings')),
    el('span', { class: 'who' },
      el('span', { class: 'name' }, user?.username),
      el('span', { class: 'role' }, detail))),

    el('button', {
      class: 'nav-item',
      onclick: () => { session.clear(); location.hash = '#/login'; render(); },
    }, el('span', { class: 'ico' }, icon('log-out')), 'ออกจากระบบ'),

    // รุ่นของระบบ + เวลาอัปเดต — กดแล้วเปิดรายละเอียด
    versionButton());
}

/**
 * ตัวเลขงานค้างข้างเมนู — โหลดแยกทีหลัง ไม่ถ่วงการวาดหน้า
 * ดึงไม่ได้ (เช่นผู้ช่วยที่ไม่มีสิทธิ์ดูบิล) ก็แค่ไม่มีตัวเลข
 */
function loadNavCounts(shell) {
  // ระหว่างดูมุมร้าน ตัวเลขที่ได้จะเป็นของส่วนกลาง ไม่ใช่ของร้านนั้น — ไม่โชว์ดีกว่าโชว์ผิด
  if (session.viewAs || session.role === 'SALES' || !hasPermission('bills')) return;
  api.get('/api/payments/nav-counts').then((counts) => {
    shell.querySelectorAll('.nav-count').forEach((n) => n.remove());
    for (const [key, info] of Object.entries(counts)) {
      if (!info.count) continue;
      // ทั้งเมนูข้างและแถบล่างบนมือถือ
      shell.querySelectorAll(`.nav-item[data-path="/${key}"], .bottom-nav a[data-path="/${key}"]`).forEach((link) => {
        link.append(el('span', { class: `nav-count${info.urgent ? ' urgent' : ''}`, title: info.title }, String(info.count)));
      });
    }
  }).catch(() => {});
}

/** แถบเตือนตอนสวมมุมคนอื่นอยู่ พร้อมปุ่มออกจากโหมด */
function viewAsBanner() {
  const target = session.viewAs;
  if (!target) return '';
  const what = target.role === 'SALES' ? 'เซล' : 'ร้านค้า';
  return el('div', { class: 'viewas-bar' },
    el('span', {}, `👁 กำลังดูระบบในมุมของ${what} `, el('strong', {}, target.username), ' — ดูได้อย่างเดียว กดทำรายการไม่ได้'),
    el('button', {
      class: 'btn sm',
      onclick: () => { session.setViewAs(null); location.hash = '#/dashboard'; render(); },
    }, 'กลับเป็นผู้ดูแลระบบ'));
}

// หน้าที่แสดงอยู่ตอนนี้ — วาดหน้าเดิมซ้ำจะใช้เมนู/กรอบเดิม ไม่สร้างใหม่ทั้งหมด
let mounted = null;
let renderToken = 0;

export async function render() {
  if (!session.token) {
    scopeStateTo(null); // ออกจากระบบแล้วล้างตัวกรองที่ค้างอยู่ทิ้ง
    clear(root).append(loginView(() => { location.hash = `#${homePath()}`; render(); }));
    return;
  }

  // ต้องเปลี่ยนรหัสเริ่มต้น/ตั้ง 2FA ก่อน — เต็มจอแบบหน้าล็อกอิน ไม่มีเมนูให้กดไปที่อื่น
  if (location.hash === '#/setup') {
    clear(root).append(await setupView(() => { location.hash = `#${homePath()}`; }));
    return;
  }

  const path = currentPath();
  const route = ROUTES[path];
  // ย้ายหน้า = เริ่มใหม่ที่แท็บ/ตัวกรองตั้งต้นของหน้านั้นเสมอ
  // และปิดโมดัลที่ยังค้างอยู่ด้วย (โมดัลเกาะอยู่กับ body จึงไม่หายไปเองตอนเปลี่ยนหน้า)
  const movedPage = scopeStateTo(path);
  if (movedPage) {
    document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove());
  }
  // กดเร็ว ๆ หลายครั้ง — ผลของรอบเก่าที่มาถึงทีหลังต้องไม่ไปทับรอบใหม่
  const token = ++renderToken;
  beginRender();

  /*
   * วาดหน้าเดิมซ้ำ (บันทึก เปลี่ยนตัวกรอง สลับแท็บ): คงเมนูและเนื้อหาเดิมไว้ แค่จางลงระหว่างโหลด
   * เดิมล้างทั้งหน้าเป็น "กำลังโหลด…" ทุกครั้ง หน้ากะพริบ scroll เด้ง แล้วค่อยกระโดดกลับ
   */
  const reuse = !movedPage && mounted && root.contains(mounted.shell) && mounted.path === path
    && mounted.role === session.role; // เข้า/ออกโหมดดูมุมร้านบนหน้าเดิม ต้องวาดเมนูใหม่ตามบทบาท
  const keepScroll = movedPage ? 0 : window.scrollY;

  let main;
  if (reuse) {
    ({ main } = mounted);
    main.classList.add('busy');
  } else {
    main = el('main', { class: 'main' });
    // ขึ้นข้อความโหลดเฉพาะเมื่อช้าจริง — หน้าที่โหลดเร็วจะไม่เห็นอะไรกะพริบ
    const slow = setTimeout(() => {
      if (!main.childElementCount) main.append(skeleton());
    }, 250);
    main.addEventListener('rendered', () => clearTimeout(slow), { once: true });

    // super admin ใช้เมนูคนละสีกับร้าน/เซล ดูปราดเดียวรู้ว่าอยู่หลังบ้านส่วนกลาง
    // ใช้ session.role — ระหว่างดูมุมร้านจึงเห็นสีเดียวกับที่ร้านเห็นจริง
    // จอมือถือ: เมนูซ่อนเป็นลิ้นชัก เปิดด้วยปุ่ม ☰ บนแถบบน
    const shell = el('div', { class: `shell${session.role === 'SUPER_ADMIN' ? ' is-super' : ''}` });
    const closeDrawer = () => shell.classList.remove('drawer-open');
    shell.append(
      el('header', { class: 'mobile-bar' },
        el('button', {
          class: 'icon-btn',
          'aria-label': 'เปิดเมนู',
          onclick: () => shell.classList.toggle('drawer-open'),
        }, icon('menu')),
        el('span', { class: 'mobile-title' }, labelOf(path)),
        el('a', { class: 'icon-btn', href: '#/account', 'aria-label': 'บัญชีของฉัน' }, icon('settings'))),
      sidebar(path),
      el('div', { class: 'drawer-backdrop', onclick: closeDrawer }),
      main,
      bottomNav(path),
    );
    // แตะเมนูแล้วปิดลิ้นชักเอง
    shell.querySelectorAll('.sidebar a').forEach((a) => a.addEventListener('click', closeDrawer));
    clear(root).append(shell);
    mounted = { shell, main, path, role: session.role };
  }
  loadNavCounts(mounted.shell);

  /*
   * แอดมินต้องเห็นทุกหน้าว่าบัญชีรับเงินถูกแก้ — ไม่ใช่แค่ตอนบังเอิญเข้าหน้าบัญชี
   * ระหว่างดูมุมร้าน (view-as) ไม่โชว์ เพื่อให้เห็นหน้าจอเหมือนที่ร้านเห็นจริง
   * ดึงไม่ได้ก็แค่ไม่โชว์ ไม่ให้หน้าหลักพังตาม
   */
  const unreadChanges = session.user?.role === 'SUPER_ADMIN' && !session.viewAs
    ? api.get('/api/bank-accounts/changes/unread').catch(() => null)
    : null;

  const banner = viewAsBanner();
  let parts;
  try {
    const content = await route.view();
    parts = [banner, bankChangeBanner(await unreadChanges), content];
  } catch (err) {
    parts = [
      banner,
      el('div', { class: 'page-head' }, el('h1', {}, labelOf(path))),
      el('div', { class: 'error-box' }, err.fullMessage ?? err.message),
      el('button', { class: 'btn ghost', onclick: render }, 'ลองอีกครั้ง'),
    ];
    toast(err.fullMessage ?? err.message, 'error');
  }
  if (token !== renderToken) return;

  clear(main).append(...parts);
  main.classList.remove('busy');
  main.dispatchEvent(new Event('rendered'));
  // รอให้เบราว์เซอร์จัดวางเสร็จก่อน ไม่งั้นหน้ายังสูงไม่พอให้เลื่อนกลับไปจุดเดิม
  if (keepScroll) requestAnimationFrame(() => window.scrollTo(0, keepScroll));
}

window.addEventListener('hashchange', render);
render();
