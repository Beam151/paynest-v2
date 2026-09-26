/**
 * สร้าง public/icons.svg — ไอคอนชุดเดียวทั้งระบบ (Lucide · ISC)
 *
 * แทน emoji ที่แต่ละเครื่องวาดไม่เหมือนกัน (ธงบน Windows ขึ้นเป็นตัวอักษร TH/US)
 * และ screen reader อ่านออกเสียงทั้งที่เป็นแค่ของตกแต่ง
 *
 * รันเฉพาะตอนเพิ่มไอคอน: npm install --no-save lucide-static && node tools/build-icons.mjs
 * ไฟล์ที่ได้ commit ไว้เลย — เซิร์ฟเวอร์จริงไม่ต้องมีแพ็กเกจนี้
 */
import fs from 'node:fs';
import path from 'node:path';

const ICONS = [
  'layout-dashboard', 'target', 'package', 'store', 'handshake', 'receipt', 'wallet', 'tag', 'landmark',
  'notebook-text', 'trending-up', 'settings', 'log-out', 'menu', 'shopping-cart', 'hourglass', 'circle-check',
  'check', 'eye', 'file-pen-line', 'star', 'undo-2', 'alarm-clock', 'user', 'plus', 'clipboard-copy', 'download',
  'smartphone', 'search', 'send', 'credit-card', 'triangle-alert', 'key-round', 'lock', 'lock-open', 'banknote',
  'users', 'chevron-right', 'x', 'arrow-right', 'circle-alert', 'info', 'bell', 'moon', 'clock', 'shield-check',
  'house', 'megaphone', 'calendar', 'chart-column', 'pin', 'party-popper', 'inbox', 'book-open', 'circle-help', 'rocket', 'refresh-cw', 'hand', 'monitor',
];

const dir = path.resolve('node_modules/lucide-static/icons');
const symbols = ICONS.map((name) => {
  const svg = fs.readFileSync(path.join(dir, `${name}.svg`), 'utf8');
  const inner = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>')).trim();
  return `  <symbol id="i-${name}" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner.replace(/\s*\n\s*/g, '')}</g></symbol>`;
});

const out = `<!-- ไอคอน Lucide (ISC License · https://lucide.dev) — สร้างด้วย tools/build-icons.mjs อย่าแก้มือ -->
<svg xmlns="http://www.w3.org/2000/svg">
${symbols.join('\n')}
</svg>
`;
fs.writeFileSync('public/icons.svg', out);
console.log(`public/icons.svg: ${ICONS.length} ไอคอน, ${out.length} bytes`);
