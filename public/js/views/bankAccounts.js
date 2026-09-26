import { api } from '../api.js';
import { alertBanner, badge, card, confirmAction, dateTh, el, formModal, infoModal, int, stat, table, toast } from '../ui.js';
import { elevated } from '../elevation.js';
import { render } from '../app.js';
import { activityButton } from './activity.js';

const digits = (value) => String(value ?? '').replace(/[\s-]/g, '');

/**
 * บัญชีธนาคารสำหรับรับเงินจากร้านค้า
 *
 * มีได้หลายบัญชี แล้วเลือกตอนออกบิลว่าใบนั้นให้โอนเข้าอันไหน
 * "บัญชีหลัก" คือตัวที่ถูกเลือกให้อัตโนมัติ — มีได้ทีละใบเดียว
 */
export async function bankAccountsView() {
  const [res, tg] = await Promise.all([
    api.get('/api/bank-accounts'),
    api.get('/api/settings/telegram').catch(() => null),
  ]);

  const routingChanged = (row, v) => Boolean(v.qrFile)
    || (v.bankName ?? '') !== row.bankName
    || (v.accountName ?? '') !== row.accountName
    || digits(v.accountNumber) !== row.accountNumber
    || (v.currency ?? 'THB') !== row.currency;

  const accountForm = (row = null) => formModal({
    title: row ? `แก้ไขบัญชี — ${row.bankName}` : 'เพิ่มบัญชีรับเงิน',
    submitLabel: row ? 'บันทึกการแก้ไข' : 'เพิ่มบัญชี',
    fields: [
      { name: 'bankName', label: 'ธนาคาร', required: true, value: row?.bankName ?? '', placeholder: 'เช่น กสิกรไทย' },
      { name: 'accountName', label: 'ชื่อบัญชี', required: true, value: row?.accountName ?? '', placeholder: 'ชื่อที่ปรากฏในสมุดบัญชี' },
      {
        name: 'accountNumber',
        label: 'เลขที่บัญชี',
        required: true,
        value: row?.accountNumber ?? '',
        placeholder: '1234567890',
        hint: 'ใส่ขีดหรือเว้นวรรคได้ ระบบจะตัดให้เอง',
      },
      { name: 'branch', label: 'สาขา', value: row?.branch ?? '' },
      /*
       * บัญชีหนึ่งใบรับได้สกุลเดียว — ธนาคารออกเลขคนละใบให้บัญชีบาทกับบัญชีเงินตราต่างประเทศ
       * ที่แก้ไม่ได้เมื่อผูกบิลแล้ว เพราะบิลเก่าตรึงบัญชีใบนี้ไว้ สกุลเปลี่ยนทีหลังจะย้อนไปทำให้บิลผิด
       */
      {
        name: 'currency',
        label: 'สกุลเงินที่รับ',
        type: 'select',
        value: row?.currency ?? 'THB',
        disabled: Boolean(row?.invoiceCount),
        options: [
          { value: 'THB', label: 'บาท (THB)' },
          { value: 'USD', label: 'ดอลลาร์ (USD)' },
        ],
        hint: row?.invoiceCount
          ? `ผูกกับบิลแล้ว ${int(row.invoiceCount)} ใบ เปลี่ยนสกุลไม่ได้ — ถ้าต้องการอีกสกุลให้เพิ่มบัญชีใหม่`
          : 'บิลสกุลไหนต้องโอนเข้าบัญชีที่รับสกุลนั้น',
      },
      { name: 'note', label: 'หมายเหตุ', value: row?.note ?? '', placeholder: 'เช่น ใช้กับร้านภาคเหนือ' },
      /*
       * QR ที่ธนาคารออกให้ — แนบเป็นไฟล์ ไม่ได้สร้างเองจากเลขบัญชี
       * payload พร้อมเพย์ที่ประกอบผิดแม้แต่หลักเดียว = เงินวิ่งไปบัญชีคนอื่น
       * เอารูปที่ธนาคารออกให้มาแนบปลอดภัยกว่า และได้ QR ของทุกธนาคารเหมือนกันหมด
       */
      {
        name: 'qrFile',
        label: row?.qrUrl ? 'เปลี่ยนรูป QR' : 'รูป QR สำหรับสแกนโอน',
        type: 'file',
        accept: 'image/*',
        hint: row?.qrUrl
          ? 'มี QR อยู่แล้ว — เลือกไฟล์ใหม่เพื่อแทนที่ หรือเว้นว่างไว้เพื่อใช้อันเดิม'
          : 'ไม่ใส่ก็ได้ — ใส่แล้วร้านจะสแกนจ่ายได้เลย ไม่ต้องพิมพ์เลขบัญชีเอง',
      },
    ],
    preview: (v) => el('div', { class: 'notice-box m-0' },
      `ร้านค้าจะเห็นบัญชีนี้บนบิลสกุล${v.currency === 'USD' ? 'ดอลลาร์' : 'บาท'}ที่ถูกออกให้ `,
      el('div', { class: 'sub-line mt-4' },
        `${v.bankName || 'ธนาคาร'} · ${v.accountNumber || 'เลขที่บัญชี'} (${v.accountName || 'ชื่อบัญชี'})`),
      el('div', { class: 'sub-line mt-4' },
        v.qrFile ? '📷 จะแนบ QR ใหม่ให้บัญชีนี้' : (row?.qrUrl ? '📷 ใช้ QR เดิม' : 'ยังไม่มี QR — ร้านต้องพิมพ์เลขบัญชีเอง'))),
    onSubmit: async (v) => {
      // อัปโหลดก่อนแล้วค่อยส่ง URL ไปกับข้อมูลบัญชี — เซิร์ฟเวอร์รับเฉพาะไฟล์ที่ผ่าน /api/uploads
      const { qrFile, ...body } = v;
      if (qrFile) body.qrUrl = (await api.upload(qrFile)).url;

      // แก้แค่สาขา/หมายเหตุไม่ต้องยืนยัน — ตรงกับกติกาฝั่งเซิร์ฟเวอร์
      if (row && !routingChanged(row, v)) await api.patch(`/api/bank-accounts/${row.id}`, body);
      else if (row) await elevated((opts) => api.patch(`/api/bank-accounts/${row.id}`, body, opts));
      else await elevated((opts) => api.post('/api/bank-accounts', body, opts));
      toast(row ? 'บันทึกแล้ว' : 'เพิ่มบัญชีแล้ว', 'success');
      render();
    },
  });

  /** ถอด QR ออกจากบัญชี — ส่ง null ให้เซิร์ฟเวอร์ล้างค่า */
  const removeQr = (row) => confirmAction(
    `เอารูป QR ออกจาก ${row.bankName} ${row.accountNumber}? ร้านจะต้องพิมพ์เลขบัญชีเองแทน`,
    async () => {
      await elevated((opts) => api.patch(`/api/bank-accounts/${row.id}`, { qrUrl: null }, opts));
      toast('เอา QR ออกแล้ว', 'success');
      render();
    },
  );

  /** เปิดดู QR เต็ม ๆ — ตัวในตารางเล็กเกินกว่าจะเช็กว่าแนบถูกใบ */
  const qrModal = (row) => {
    const modal = infoModal({ title: `QR — ${row.bankName} ${row.accountNumber}`, width: 420, content: null });
    modal.body.append(
      el('div', { style: 'text-align:center' },
        el('img', { src: row.qrUrl, alt: `QR ${row.bankName}`, class: 'qr-full' }),
        el('div', { class: 'sub-line mt-8' }, row.accountName)));
  };

  const setDefault = (row) => confirmAction(
    `ตั้ง ${row.bankName} ${row.accountNumber} เป็นบัญชีหลัก? บิลที่ออกใหม่จะใช้บัญชีนี้อัตโนมัติ`,
    async () => {
      await elevated((opts) => api.patch(`/api/bank-accounts/${row.id}`, { isDefault: true }, opts));
      toast('ตั้งเป็นบัญชีหลักแล้ว', 'success');
      render();
    },
  );

  const toggleStatus = (row) => {
    const turningOff = row.status === 'ACTIVE';
    return confirmAction(
      turningOff
        ? `ปิดใช้งาน ${row.bankName} ${row.accountNumber}? จะเลือกใช้กับบิลใหม่ไม่ได้ แต่บิลเก่ายังชี้บัญชีนี้เหมือนเดิม`
        : `เปิดใช้งาน ${row.bankName} ${row.accountNumber} อีกครั้ง?`,
      async () => {
        await elevated((opts) => api.patch(`/api/bank-accounts/${row.id}`, { status: turningOff ? 'INACTIVE' : 'ACTIVE' }, opts));
        toast(turningOff ? 'ปิดใช้งานแล้ว' : 'เปิดใช้งานแล้ว', 'success');
        render();
      },
    );
  };

  const remove = (row) => confirmAction(
    `ลบบัญชี ${row.bankName} ${row.accountNumber}?`,
    async () => {
      await elevated((opts) => api.del(`/api/bank-accounts/${row.id}`, {}, opts));
      toast('ลบแล้ว', 'success');
      render();
    },
  );

  const noDefault = res.summary.active > 0 && !res.summary.defaultId;

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'บัญชีรับเงิน'),
        el('p', {}, 'บัญชีธนาคารที่ให้ร้านค้าโอนเงินเข้า — มีได้หลายบัญชี แล้วเลือกตอนออกบิลว่าใบไหนโอนเข้าอันไหน')),
      el('div', { class: 'btn-row' },
        activityButton(['bank_account'], { title: 'ประวัติบัญชีรับเงิน' }),
        el('button', { class: 'btn', onclick: () => accountForm() }, '+ เพิ่มบัญชี'))),

    /*
     * ไม่มีบัญชีเลย = บิลที่ออกไปจะไม่มีเลขบัญชีให้ร้านโอน ต้องไปบอกกันนอกระบบ
     * เตือนตรงนี้ดีกว่าปล่อยให้ไปรู้ตัวตอนร้านโทรมาถาม
     */
    // ตั้งค่าแจ้งเตือนย้ายไปหน้า "ตั้งค่า" แล้ว — ที่นี่เตือนแค่ตอนยังไม่ได้เชื่อม
    tg && !tg.configured
      ? alertBanner({
        tone: 'warn',
        title: '📨 ยังไม่ได้เชื่อมแจ้งเตือน Telegram',
        detail: 'การแก้บัญชีรับเงินตอนนี้แจ้งแค่ในระบบ — เชื่อมแล้วเจ้าของกิจการได้รับข้อความทุกครั้ง',
        actionLabel: 'ไปตั้งค่า',
        onClick: () => { location.hash = '#/settings'; },
      })
      : '',

    res.items.length === 0
      ? el('div', { class: 'alert-box' },
        el('strong', {}, 'ยังไม่มีบัญชีรับเงิน'),
        el('div', {}, 'บิลที่ออกตอนนี้จะไม่มีเลขบัญชีให้ร้านโอน — กด "+ เพิ่มบัญชี" เพื่อเพิ่มบัญชีแรก'))
      : '',

    noDefault
      ? el('div', { class: 'notice-box' },
        'ยังไม่ได้ตั้งบัญชีหลัก — ตอนออกบิลจะต้องเลือกบัญชีเองทุกครั้ง กด "ตั้งเป็นบัญชีหลัก" ที่บัญชีที่ใช้บ่อยที่สุด')
      : '',

    el('div', { class: 'stat-grid' },
      stat('บัญชีที่ใช้ได้', int(res.summary.active), `จากทั้งหมด ${int(res.summary.count)} บัญชี`,
        { tone: res.summary.active ? 'income' : 'warn', icon: '🏦' }),
      stat('บัญชีหลัก',
        res.items.find((r) => r.isDefault)?.bankName ?? '—',
        res.items.find((r) => r.isDefault)?.accountNumber ?? 'ยังไม่ได้ตั้ง',
        { tone: res.summary.defaultId ? 'sales' : 'muted', icon: '⭐' }),
      stat('บิลที่ผูกบัญชีไว้', int(res.items.reduce((t, r) => t + r.invoiceCount, 0)),
        'ใบเรียกเก็บที่ระบุบัญชีปลายทางแล้ว', { tone: 'muted', icon: '🧾' })),

    card(null, table([
      {
        label: 'ธนาคาร / ชื่อบัญชี',
        sortValue: (r) => r.bankName,
        render: (r) => el('div', {},
          el('strong', {}, r.bankName),
          r.isDefault ? el('span', { class: 'badge green', style: 'margin-left:8px' }, '⭐ บัญชีหลัก') : '',
          el('div', { class: 'sub-line' }, r.accountName)),
      },
      {
        label: 'เลขที่บัญชี',
        sortValue: (r) => r.accountNumber,
        render: (r) => el('div', {},
          el('strong', { style: 'letter-spacing:.5px' }, r.accountNumber),
          r.branch ? el('div', { class: 'sub-line' }, `สาขา ${r.branch}`) : ''),
      },
      {
        label: 'QR',
        sortable: false,
        render: (r) => (r.qrUrl
          ? el('div', { class: 'btn-row' },
            el('img', {
              src: r.qrUrl, alt: `QR ${r.bankName}`, class: 'qr-thumb', title: 'กดเพื่อดูเต็มรูป',
              onclick: () => qrModal(r),
            }),
            el('button', { class: 'btn ghost sm danger', onclick: () => removeQr(r) }, 'เอาออก'))
          : el('span', { class: 'muted' }, '—')),
      },
      {
        label: 'สกุลที่รับ',
        sortValue: (r) => r.currency,
        render: (r) => el('span', { class: r.currency === 'USD' ? 'badge blue' : 'badge' },
          r.currency === 'USD' ? 'USD' : 'THB'),
      },
      { label: 'หมายเหตุ', render: (r) => r.note ?? el('span', { class: 'muted' }, '—') },
      {
        label: 'ใช้กับบิล',
        num: true,
        sortValue: (r) => r.invoiceCount,
        render: (r) => (r.invoiceCount ? `${int(r.invoiceCount)} ใบ` : el('span', { class: 'muted' }, '—')),
      },
      { label: 'สถานะ', sortValue: (r) => r.status, render: (r) => badge(r.status === 'ACTIVE' ? 'ACTIVE' : 'CLOSED') },
      {
        label: '',
        render: (r) => el('div', { class: 'btn-row' },
          el('button', { class: 'btn ghost sm', onclick: () => accountForm(r) }, 'แก้ไข'),
          !r.isDefault && r.status === 'ACTIVE'
            ? el('button', { class: 'btn ghost sm', onclick: () => setDefault(r) }, '⭐ ตั้งเป็นหลัก')
            : '',
          el('button', { class: 'btn ghost sm', onclick: () => toggleStatus(r) },
            r.status === 'ACTIVE' ? 'ปิดใช้งาน' : 'เปิดใช้งาน'),
          // ลบได้เฉพาะบัญชีที่ยังไม่เคยผูกกับบิล — บิลเก่าต้องชี้บัญชีเดิมได้ตลอด
          r.invoiceCount === 0
            ? el('button', { class: 'btn ghost sm danger', onclick: () => remove(r) }, 'ลบ')
            : '',
        ),
      },
    ], res.items, {
      search: 'ค้นหาธนาคารหรือเลขที่บัญชี…',
      empty: { icon: '🏦', title: 'ยังไม่มีบัญชีรับเงิน', detail: 'ร้านต้องเห็นเลขบัญชีบนบิลถึงจะโอนได้', action: { label: '+ เพิ่มบัญชีแรก', onClick: () => accountForm() } },
    }), { tight: true }));
}

/* ── แจ้งเตือนแอดมินเมื่อบัญชีรับเงินถูกเปลี่ยน ─────────────────── */

const FIELD_LABEL = {
  bankName: 'ธนาคาร',
  accountName: 'ชื่อบัญชี',
  accountNumber: 'เลขที่บัญชี',
  qrUrl: 'รูป QR',
  currency: 'สกุลเงิน',
  status: 'สถานะ',
  isDefault: 'บัญชีหลัก',
};
const KIND_LABEL = { CREATE: 'เพิ่มบัญชีใหม่', UPDATE: 'แก้ไขบัญชี', DELETE: 'ลบบัญชี' };
const TG_LABEL = {
  SENT: '📨 แจ้งเข้า Telegram แล้ว',
  PENDING: '📨 กำลังส่งเข้า Telegram…',
  FAILED: '⚠ ส่งเข้า Telegram ไม่สำเร็จ',
};

const showValue = (field, value) => {
  if (value === null || value === undefined || value === '') return el('span', { class: 'muted' }, '—');
  // เทียบ QR ด้วยตา — ข้อความ URL บอกไม่ได้ว่าเป็น QR ของบัญชีใคร
  if (field === 'qrUrl') return el('img', { src: value, alt: 'QR', class: 'qr-thumb' });
  if (field === 'isDefault') return value ? 'ใช่' : 'ไม่ใช่';
  if (field === 'status') return value === 'ACTIVE' ? 'เปิดใช้งาน' : 'ปิดใช้งาน';
  return el('strong', {}, String(value));
};

function changeCard(c, onAck) {
  const who = c.actor ? (c.actor.displayName || c.actor.username) : 'ระบบ';
  return el('div', { class: 'bank-change' },
    el('div', { class: 'bank-change-head' },
      el('div', {},
        el('strong', {}, `${KIND_LABEL[c.kind]} — ${c.accountLabel}`),
        el('div', { class: 'sub-line' }, `โดย ${who} · ${dateTh(c.createdAt)}`),
        el('div', { class: 'sub-line' },
          c.telegram
            ? `${TG_LABEL[c.telegram.status]}${c.telegram.status !== 'SENT' && c.telegram.error ? ` (${c.telegram.error})` : ''}`
            : 'ไม่ได้แจ้งออกนอกระบบ (ยังไม่ได้ตั้งค่า Telegram)')),
      el('button', { class: 'btn sm', onclick: onAck }, 'ตรวจแล้ว ถูกต้อง')),
    c.changes.length
      ? table([
        { label: 'ช่อง', render: (x) => FIELD_LABEL[x.field] ?? x.field },
        { label: 'เดิม', render: (x) => showValue(x.field, x.from) },
        { label: 'ใหม่', render: (x) => showValue(x.field, x.to) },
      ], c.changes)
      : '',
    c.openInvoices > 0
      ? el('div', { class: 'sub-line', style: 'margin-top:6px;font-weight:700' },
        `⚠ มีบิลค้างจ่าย ${int(c.openInvoices)} ใบที่ชี้บัญชีนี้อยู่ตอนแก้ — ร้านจะเห็นข้อมูลใหม่บนบิลเหล่านั้นทันที`)
      : '');
}

function changesModal(items) {
  const modal = infoModal({ title: 'การเปลี่ยนแปลงบัญชีรับเงินที่ยังไม่ได้ตรวจ', width: 760, content: null });
  const list = el('div', {});
  const ack = async (c, node) => {
    await api.post(`/api/bank-accounts/changes/${c.id}/ack`);
    node.remove();
    if (!list.children.length) { modal.close(); render(); }
  };
  for (const c of items) {
    const node = changeCard(c, () => ack(c, node).catch((err) => toast(err.fullMessage ?? err.message, 'error')));
    list.append(node);
  }
  modal.body.append(
    el('div', { class: 'alert-box', style: 'margin-top:0' },
      el('strong', {}, 'ถ้าคุณหรือทีมไม่ได้เป็นคนแก้'),
      el('div', {}, '1) เปลี่ยนรหัสผ่านทันที (เครื่องอื่นที่ล็อกอินค้างอยู่จะหลุดหมด)  '
        + '2) แก้บัญชีกลับ  3) แจ้งร้านที่มีบิลค้างว่าอย่าโอนเข้าบัญชีใหม่')),
    list);
}

/**
 * แถบบนสุดของทุกหน้า (เฉพาะแอดมิน) — อยู่จนกว่าแอดมินคนนี้จะกดตรวจครบทุกรายการ
 * ไม่ได้ปิดทิ้งได้ เพราะการแก้บัญชีรับเงินคือจุดที่โกงแล้วเสียหายที่สุด
 */
export function bankChangeBanner(unread) {
  if (!unread?.count) return '';
  return alertBanner({
    title: `⚠ บัญชีรับเงินถูกเปลี่ยน ${int(unread.count)} รายการที่คุณยังไม่ได้ตรวจ`,
    detail: 'ตรวจว่าเลขบัญชีและ QR ถูกต้อง — ถ้าไม่ได้เป็นคนแก้ ให้เปลี่ยนรหัสผ่านทันที',
    actionLabel: 'ตรวจเลย',
    onClick: () => changesModal(unread.items),
  });
}
