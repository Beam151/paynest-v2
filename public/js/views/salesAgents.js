import { api, qs, session } from '../api.js';
import { dateTimeTh, badge, card, commBadge, confirmAction, dateTh, el, formModal, infoModal, int, money, pct, stat, table, toast } from '../ui.js';
import { periodLabel, periodOf, periodOptions, todayIso } from '../period.js';
import { render } from '../app.js';
import { activityButton } from './activity.js';
import { viewState } from '../viewState.js';
import { avatar } from '../charts.js';

const TAB_KEY = 'franchise.agentTab';

export async function salesAgentsView() {
  const tab = viewState.getItem(TAB_KEY) ?? 'agents';
  const [{ items: agents }, { items: products }, { items: openLinks }, { items: allLinks }] = await Promise.all([
    api.get('/api/sales-agents'),
    api.get('/api/products?status=ACTIVE'),
    api.get(`/api/sales-agents/links${qs({ activeOn: todayIso() })}`),
    api.get('/api/sales-agents/links'),
  ]);

  const agentOptions = agents.filter((a) => a.status === 'ACTIVE')
    .map((a) => ({ value: String(a.id), label: `${a.username} — ${a.name}` }));

  /*
   * สินค้าที่เลือกผูกดีลได้ ต้องเข้าเงื่อนไขสองข้อ
   *   1. มีร้านถือสิทธิ์ขายอยู่ — ไม่งั้นไม่มียอดให้คิดคอม
   *   2. ยังไม่มีเซลคนอื่นถือดีลอยู่ — 1 สินค้ามีเจ้าของดีลได้คนเดียวต่อช่วงเวลา
   * กันไว้ตั้งแต่ตอนเลือก ดีกว่าปล่อยให้กดบันทึกแล้วค่อยเด้ง error กลับมา
   */
  const takenProductIds = new Set(openLinks.map((l) => l.productId));
  const productOptions = products
    .filter((p) => p.currentAssignment && !takenProductIds.has(p.id))
    .map((p) => ({ value: String(p.id), label: `${p.sku} — ${p.name} (${p.currentAssignment.franchiseUsername})` }));

  const tabs = el('div', { class: 'btn-row tabs' },
    ...[
      { id: 'agents', label: `รายชื่อเซล (${int(agents.length)} คน)` },
      { id: 'links', label: `ดีล สินค้า ↔ เซล (${int(allLinks.length)} ดีล)` },
      { id: 'commissions', label: 'ค่าคอมที่ต้องจ่าย' },
    ].map((t) => el('button', {
      class: `btn ${tab === t.id ? '' : 'ghost'}`,
      onclick: () => { viewState.setItem(TAB_KEY, t.id); render(); },
    }, t.label)));

  const createAgentModal = () => formModal({
    title: 'เพิ่มเซลใหม่',
    submitLabel: 'สร้างเซล',
    fields: [
      {
        name: 'username',
        label: 'Username',
        required: true,
        placeholder: 'sale03',
        hint: 'ใช้เข้าสู่ระบบและเป็นตัวระบุเซล · a-z 0-9 . _ - เท่านั้น',
      },
      { name: 'password', label: 'รหัสผ่าน', required: true, hint: 'อย่างน้อย 8 ตัวอักษร' },
      { name: 'name', label: 'ชื่อเซล', required: true, placeholder: 'สมชาย (เซลภาคกลาง)' },
      { name: 'phone', label: 'เบอร์โทร' },
      { name: 'email', label: 'อีเมล' },
    ],
    // ย้ำให้ชัดว่าสร้างเซลเฉย ๆ ยังไม่เกิดเงิน ต้องไปผูกดีลก่อน
    preview: () => el('div', { class: 'notice-box m-0' },
      'เซลได้ค่าคอมสองทาง: % จากสินค้าที่ผูกดีลไว้ และรายการคอมอื่น ๆ ที่พิมพ์เพิ่มเป็นจำนวนเงิน '
      + '— สร้างเสร็จแล้วกด "ผูกดีล" ต่อได้เลย'),
    onSubmit: async (v) => {
      await api.post('/api/sales-agents', v);
      toast(`สร้างเซล ${v.username} แล้ว`, 'success');
      render();
    },
  });

  /**
   * ผูกดีล — ใส่สินค้าได้หลายชิ้นในครั้งเดียว
   *
   * เงื่อนไขที่มักเหมือนกันทั้งชุด (เซล ฐานที่คิด ช่วงเวลา) อยู่เป็นช่องเดียวด้านบน
   * ส่วน % กับค่าคงที่แยกรายสินค้า เพราะของบางชิ้นตกลงกันคนละเรต
   *
   * เปิดจากแถวเซล (preset.salesAgentId) จะล็อกชื่อเซลไว้เลย ไม่ต้องเลือกซ้ำ
   */
  const linkModal = (preset = {}) => {
    const lockedAgent = preset.salesAgentId
      ? agentOptions.find((o) => o.value === String(preset.salesAgentId))
      : null;

    // สินค้าว่างหมดก็ยังเปิดฟอร์มได้ เพราะยังเพิ่ม "ค่าคอมอื่น ๆ" ให้เซลได้อยู่
    const rows = productOptions.length ? [{ productId: '', commissionPct: '', fixedAmount: '' }] : [];
    const rowBox = el('div', {});

    // ค่าคอมที่จ่ายเป็นก้อน ไม่ผูกกับสินค้า เช่นโบนัสปิดดีลใหญ่ ค่าเดินทาง
    const extras = [];

    const usedProducts = () => new Set(rows.map((r) => r.productId).filter(Boolean));

    function drawRows() {
      const taken = usedProducts();
      rowBox.replaceChildren(
        el('div', { class: 'adj-block' },
          el('div', { class: 'adj-block-head' },
            el('div', {},
              el('h3', {}, `📦 สินค้าที่ผูกดีล (${rows.length})`),
              el('div', { class: 'sub-line' }, 'ได้ส่วนต่างทุกครั้งที่ออกบิลที่มีสินค้านี้')),
            el('button', {
              class: 'btn sm',
              type: 'button',
              // เลือกครบทุกชิ้นที่ว่างแล้ว เพิ่มแถวไปก็ไม่มีอะไรให้เลือก
              disabled: rows.length >= productOptions.length,
              onclick: () => { rows.push({ productId: '', commissionPct: '', fixedAmount: '' }); drawRows(); },
            }, '+ เพิ่มสินค้า')),

        ...rows.map((row, i) => {
          // ซ่อนสินค้าที่แถวอื่นเลือกไปแล้ว กันผูกซ้ำตั้งแต่ตอนเลือก
          const choices = productOptions.filter((o) => !taken.has(o.value) || o.value === row.productId);

          const productSel = el('select', { style: 'flex:1 1 260px;min-width:220px' },
            el('option', { value: '', selected: !row.productId }, 'เลือกสินค้า…'),
            ...choices.map((o) => el('option', { value: o.value, selected: o.value === row.productId }, o.label)));
          productSel.addEventListener('change', () => { row.productId = productSel.value; drawRows(); });

          const pctBox = el('input', { type: 'number', step: '0.01', placeholder: '% ต่อรอบ', value: row.commissionPct, style: 'width:120px' });
          pctBox.addEventListener('input', () => { row.commissionPct = pctBox.value; });

          const fixedBox = el('input', { type: 'number', step: '0.01', placeholder: 'ค่าคงที่ ฿', value: row.fixedAmount, style: 'width:130px' });
          fixedBox.addEventListener('input', () => { row.fixedAmount = fixedBox.value; });

          return el('div', { class: 'adj-row' },
            productSel,
            pctBox,
            el('span', { class: 'muted', style: 'font-size:12px' }, 'และ/หรือ'),
            fixedBox,
            rows.length > 1
              ? el('button', {
                class: 'btn ghost sm danger',
                type: 'button',
                onclick: () => { rows.splice(i, 1); drawRows(); },
              }, 'ลบ')
              : '');
        }),

          rows.length
            ? el('div', { class: 'sub-line mt-6' },
              'แต่ละชิ้นต้องกรอกอย่างน้อยหนึ่งช่อง — % ต่อรอบ หรือค่าคงที่ต่อรอบ')
            : el('div', { class: 'sub-line' },
              productOptions.length
                ? 'ยังไม่ได้เลือกสินค้า — กด "+ เพิ่มสินค้า"'
                : 'สินค้าทุกชิ้นที่มีร้านถือสิทธิ์ขายอยู่ มีเซลถือดีลครบแล้ว — ถ้าจะเปลี่ยนมือ ให้ไปปิดดีลเดิมที่แท็บ "ดีล (เซล ↔ สินค้า)" ก่อน')),

        /*
         * ค่าคอมอื่น ๆ ที่ไม่ได้มาจากสินค้า — จ่ายเป็นก้อนตามรอบที่เลือก
         * อยู่ในหน้าต่างเดียวกับการผูกดีล เพราะตอนตั้งค่าให้เซลคนหนึ่ง
         * มักจะจัดการทั้งสองอย่างพร้อมกัน ไม่ต้องปิดแล้วไปหาอีกเมนู
         */
        el('div', { class: 'adj-block' },
          el('div', { class: 'adj-block-head' },
            el('div', {},
              el('h3', {}, `💰 ค่าคอมอื่น ๆ (${extras.length})`),
              el('div', { class: 'sub-line' }, 'จ่ายเป็นก้อน ไม่ผูกกับสินค้า เช่นโบนัสปิดดีล ค่าเดินทาง')),
            el('button', {
              class: 'btn sm',
              type: 'button',
              onclick: () => { extras.push({ periodCode: periodOf(), label: '', amount: '' }); drawRows(); },
            }, '+ เพิ่มรายการ')),

          ...extras.map((extra, i) => {
            const periodSel = el('select', { style: 'min-width:190px' },
              ...periodOptions().map((o) => el('option', { value: o.value, selected: o.value === extra.periodCode }, o.label)));
            periodSel.addEventListener('change', () => { extra.periodCode = periodSel.value; });

            const labelBox = el('input', { type: 'text', placeholder: 'ชื่อรายการ', value: extra.label, style: 'flex:1 1 180px;min-width:150px' });
            labelBox.addEventListener('input', () => { extra.label = labelBox.value; });

            const amountBox = el('input', { type: 'number', step: '0.01', placeholder: 'จำนวนเงิน ฿', value: extra.amount, style: 'width:140px' });
            amountBox.addEventListener('input', () => { extra.amount = amountBox.value; });

            return el('div', { class: 'adj-row' },
              periodSel,
              labelBox,
              amountBox,
              el('button', {
                class: 'btn ghost sm danger',
                type: 'button',
                onclick: () => { extras.splice(i, 1); drawRows(); },
              }, 'ลบ'));
          }),

          extras.length
            ? el('div', { class: 'sub-line mt-6' },
              'ใส่ติดลบได้ ถ้าเป็นการหักคืนค่าคอมที่คิดเกินไว้')
            : el('div', { class: 'sub-line' }, 'ยังไม่มี — กด "+ เพิ่มรายการ" ถ้าจะจ่ายค่าคอมก้อนพิเศษให้เซลคนนี้')));
    }
    drawRows();

    return formModal({
      title: lockedAgent ? `ตั้งค่าคอมให้ ${lockedAgent.label}` : 'ผูกดีล / เพิ่มค่าคอมให้เซล',
      submitLabel: 'บันทึก',
      fields: [
        // เปิดจากแถวเซลแล้วรู้อยู่แล้วว่าใคร ชื่ออยู่บนหัวโมดัล — ไม่ต้องมีช่องให้กดผิด
        lockedAgent ? null : { name: 'salesAgentId', label: 'เซล', type: 'select', required: true, options: agentOptions },
        {
          name: 'basis',
          label: 'ฐานที่ใช้คิด %',
          type: 'select',
          options: [
            { value: 'COMMISSION', label: 'ส่วนต่างที่ร้านค้าจ่าย (แนะนำ)' },
            { value: 'GROSS', label: 'ยอดขายเต็มของร้าน' },
          ],
        },
        { name: 'startDate', label: 'เริ่มรับคอมตั้งแต่', type: 'date', required: true, value: todayIso() },
        { name: 'endDate', label: 'ถึงวันที่', type: 'date', hint: 'เว้นว่าง = ได้ต่อเนื่องไม่มีกำหนด' },
        { name: 'note', label: 'หมายเหตุ' },
      ].filter(Boolean),
      preview: () => ({ node: rowBox, canSubmit: true }),
      onSubmit: async (v) => {
        const salesAgentId = Number(lockedAgent ? lockedAgent.value : v.salesAgentId);

        const items = rows
          .filter((r) => r.productId)
          .map((r) => ({
            productId: Number(r.productId),
            commissionPct: r.commissionPct === '' ? null : Number(r.commissionPct),
            fixedAmount: r.fixedAmount === '' ? null : Number(r.fixedAmount),
          }));

        // แถวที่กรอกครบพอจะคิดเงินได้เท่านั้น แถวเปล่าที่เผลอกดเพิ่มไว้ไม่ต้องส่ง
        const bonuses = extras.filter((e) => e.label.trim() && e.amount !== '');

        const incomplete = extras.find((e) => (e.label.trim() === '') !== (e.amount === ''));
        if (incomplete) {
          throw new Error(`ค่าคอมอื่น ๆ "${incomplete.label.trim() || '(ยังไม่ได้ตั้งชื่อ)'}" ยังกรอกไม่ครบ — ต้องมีทั้งชื่อรายการและจำนวนเงิน`);
        }
        if (!items.length && !bonuses.length) {
          throw new Error('ต้องใส่อย่างน้อยหนึ่งอย่าง — สินค้าที่ผูกดีล หรือค่าคอมอื่น ๆ');
        }

        /*
         * ผูกดีลก่อน เพราะเป็นส่วนที่ชนกันได้ (สินค้าชิ้นหนึ่งมีเซลได้คนเดียวต่อช่วงเวลา)
         * ถ้าชนแล้วโยน error ออกไปเลย จะได้ไม่บันทึกโบนัสค้างไว้โดยที่ดีลไม่เข้า
         */
        let linked = 0;
        if (items.length) {
          const res = await api.post('/api/sales-agents/links', { ...v, salesAgentId, items });
          linked = res.count;
        }

        for (const bonus of bonuses) {
          await api.post('/api/sales-agents/commissions/manual', {
            salesAgentId,
            periodCode: bonus.periodCode,
            label: bonus.label.trim(),
            amount: bonus.amount,
          });
        }

        toast([
          linked ? `ผูกดีล ${linked} สินค้า` : null,
          bonuses.length ? `เพิ่มค่าคอมอื่น ๆ ${bonuses.length} รายการ` : null,
        ].filter(Boolean).join(' · ') + ' แล้ว', 'success');
        render();
      },
    });
  };

  const body = tab === 'agents' ? agentsTab(agents, { createAgentModal, linkModal })
    : tab === 'links' ? await linksTab({ linkModal })
      : await commissionsTab(agentOptions);

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'เซล และค่าคอมจากการหาลูกค้า'),
        el('p', { style: 'max-width:62ch' },
          'ค่าคอมมาสองทาง: (1) ดีลที่ผูกกับสินค้า ระบบคิดให้อัตโนมัติทุกครั้งที่ออกบิลที่มีสินค้านั้น '
          + '(2) ค่าคอมอื่น ๆ ที่พิมพ์เป็นจำนวนเงินแล้วเลือกลงรอบเอง')),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn ghost', onclick: () => linkModal() }, '+ ผูกดีล / ค่าคอมอื่น'),
        activityButton(['agent', 'sales_link', 'sales_commission'], { title: 'ประวัติเซลและค่าคอม' }),
        el('button', { class: 'btn', onclick: createAgentModal }, '+ เพิ่มเซล'))),
    tabs,
    body);
}

/* ── รายชื่อเซล ────────────────────────────────────────────── */
function agentsTab(agents, { createAgentModal, linkModal }) {
  const detailModal = async (row) => {
    const full = await api.get(`/api/sales-agents/${row.id}`);
    const modal = infoModal({ title: `${full.username} — ${full.name}`, width: 720, content: null });
    modal.body.append(
      el('div', { class: 'stat-grid' },
        stat('สินค้าที่ถือดีลอยู่', int(full.activeProductCount), null, { tone: 'sales', icon: '📦' }),
        stat('คอมค้างจ่าย', money(full.pendingCommission) + ' ฿', null, { tone: 'due', icon: '⏳' }),
        stat('จ่ายไปแล้วสะสม', money(full.paidCommission) + ' ฿', null, { tone: 'income', icon: '✓' })),
      el('h3', { style: 'margin:6px 0 8px' }, 'ดีลที่ถืออยู่'),
      table([
        { label: 'สินค้า', render: (l) => el('div', {}, el('strong', {}, l.sku), el('div', { class: 'sub-line' }, l.productName)) },
        { label: 'ร้านที่ขาย', render: (l) => l.franchiseUsername ?? el('span', { class: 'muted' }, '—') },
        { label: 'คิดจาก', render: (l) => l.basisLabel },
        { label: '%', num: true, render: (l) => pct(l.commissionPct) },
        { label: 'ค่าคงที่', num: true, render: (l) => (l.fixedAmount === null ? '—' : money(l.fixedAmount)) },
        { label: 'ช่วงเวลา', render: (l) => `${dateTh(l.startDate)} → ${l.endDate ? dateTh(l.endDate) : 'ไม่กำหนด'}` },
      ], full.links, { empty: 'ยังไม่ได้ผูกกับร้านใด' }),
      el('h3', { style: 'margin:18px 0 8px' }, 'ยูสเซอร์สำหรับเข้าระบบ'),
      table([
        { label: 'ชื่อผู้ใช้', render: (u) => el('strong', {}, u.username) },
        { label: 'สถานะ', render: (u) => badge(u.status) },
        { label: 'เข้าล่าสุด', render: (u) => dateTimeTh(u.lastLoginAt) },
      ], full.users, { empty: 'ยังไม่มียูสเซอร์' }));
  };

  const editModal = (row) => formModal({
    title: `แก้ไข ${row.username}`,
    fields: [
      { name: 'name', label: 'ชื่อเซล', required: true, value: row.name },
      { name: 'phone', label: 'เบอร์โทร', value: row.phone ?? '' },
      { name: 'email', label: 'อีเมล', value: row.email ?? '' },
      {
        name: 'status',
        label: 'สถานะ',
        type: 'select',
        value: row.status,
        options: [{ value: 'ACTIVE', label: 'ใช้งาน' }, { value: 'INACTIVE', label: 'หยุดใช้งาน' }],
      },
    ],
    onSubmit: async (v) => {
      await api.patch(`/api/sales-agents/${row.id}`, v);
      toast('บันทึกแล้ว', 'success');
      render();
    },
  });

  return el('div', {},
    el('div', { class: 'toolbar' },
      el('h2', { class: 'section-title' }, `เซลทั้งหมด ${int(agents.length)} คน`),
      el('div', { class: 'sub-line' }, 'หนึ่งแถว = เซลหนึ่งคน')),

    card(null, table([
    { label: 'Username / ชื่อเซล', render: (r) => avatar(r.username, { sub: r.name }), sortValue: (r) => r.username },
    { label: 'ติดต่อ', render: (r) => r.phone ?? r.email ?? '—' },
    { label: 'สินค้าที่ถือดีล', num: true, render: (r) => int(r.activeProductCount) },
    { label: 'คอมค้างจ่าย', num: true, render: (r) => money(r.pendingCommission) },
    { label: 'ยูสเซอร์', num: true, render: (r) => (r.userCount ? int(r.userCount) : el('span', { class: 'badge amber' }, 'ยังไม่มี')) },
    { label: 'สถานะ', render: (r) => badge(r.status) },
    {
      label: '',
      render: (r) => el('div', { class: 'btn-row' },
        el('button', {
          class: 'btn ghost sm',
          title: 'ดูว่าเซลรายนี้เห็นอะไรบ้าง',
          onclick: () => {
            session.setViewAs({ role: 'SALES', id: r.id, username: r.username });
            location.hash = '#/my-sales';
            render();
          },
        }, '👁 ดูมุมมองนี้'),
        el('button', { class: 'btn ghost sm', onclick: () => detailModal(r) }, 'รายละเอียด'),
        el('button', { class: 'btn ghost sm', onclick: () => linkModal({ salesAgentId: String(r.id) }) }, 'ตั้งค่าคอม'),
        el('button', { class: 'btn ghost sm', onclick: () => editModal(r) }, 'แก้ไข')),
    },
  ], agents, { search: 'ค้นหาเซล…', empty: { icon: '🤝', title: 'ยังไม่มีเซล', detail: 'เพิ่มเซลแล้วผูกกับร้าน/สินค้า ระบบคิดค่าคอมให้เองตอนออกบิล', action: { label: '+ เพิ่มเซลคนแรก', onClick: createAgentModal } } }), { tight: true }));
}

/* ── ดีล ───────────────────────────────────────────────────── */
async function linksTab({ linkModal }) {
  const { items } = await api.get('/api/sales-agents/links');

  const endModal = (row) => formModal({
    title: `ปิดดีล ${row.agentUsername} ↔ ${row.sku}`,
    submitLabel: 'ปิดดีล',
    fields: [{
      name: 'endDate', label: 'ปิดดีลวันที่', type: 'date', required: true, value: todayIso(),
      hint: 'บิลที่ออกหลังวันนี้จะไม่คิดคอมให้เซลรายนี้แล้ว',
    }],
    onSubmit: async (v) => {
      await api.post(`/api/sales-agents/links/${row.id}/end`, v);
      toast('ปิดดีลแล้ว', 'success');
      render();
    },
  });

  const editModal = (row) => formModal({
    title: `แก้เงื่อนไขดีล ${row.agentUsername} ↔ ${row.sku}`,
    fields: [
      {
        name: 'basis',
        label: 'ฐานที่ใช้คิด %',
        type: 'select',
        value: row.basis,
        options: [
          { value: 'COMMISSION', label: 'ส่วนต่างที่ร้านค้าจ่าย' },
          { value: 'GROSS', label: 'ยอดขายเต็ม' },
        ],
      },
      { name: 'commissionPct', label: '% ต่อรอบบิล', type: 'number', step: '0.01', value: row.commissionPct ?? '' },
      { name: 'fixedAmount', label: 'ค่าคงที่ต่อรอบ', type: 'number', step: '0.01', value: row.fixedAmount ?? '' },
      { name: 'startDate', label: 'เริ่มวันที่', type: 'date', value: row.startDate },
      { name: 'note', label: 'หมายเหตุ', value: row.note ?? '' },
    ],
    onSubmit: async (v) => {
      await api.patch(`/api/sales-agents/links/${row.id}`, v);
      toast('บันทึกแล้ว', 'success');
      render();
    },
  });

  /*
   * นำด้วย "สินค้า" ไม่ใช่ "เซล" — แท็บนี้ 1 แถว = 1 ดีล ไม่ใช่ 1 คน
   * เดิมคอลัมน์แรกเป็นวงกลมชื่อเซลเหมือนแท็บ "รายชื่อเซล" เป๊ะ
   * ตาเลยอ่านว่าเป็นรายชื่อคนทั้งคู่ ทั้งที่เซลคนหนึ่งโผล่ได้หลายแถว
   */
  const active = items.filter((r) => r.isActive).length;

  return el('div', {},
    el('div', { class: 'toolbar' },
      el('h2', { class: 'section-title' }, `ดีลทั้งหมด ${int(items.length)} ดีล`),
      el('div', { class: 'sub-line' },
        `หนึ่งแถว = สินค้าหนึ่งชิ้นที่มีเซลถืออยู่ · ใช้งานอยู่ ${int(active)} ดีล — เซลคนเดียวถือได้หลายชิ้น`)),

    card(null, table([
    {
      label: 'สินค้า',
      sortValue: (r) => r.sku,
      render: (r) => el('div', {}, el('strong', {}, r.sku), el('div', { class: 'sub-line' }, r.productName)),
    },
    {
      label: 'ร้านที่ขาย',
      sortValue: (r) => r.franchiseUsername ?? '',
      render: (r) => (r.franchiseUsername ? avatar(r.franchiseUsername, { sub: '' }) : el('span', { class: 'muted' }, '—')),
    },
    {
      label: 'เซลที่ถือดีล',
      sortValue: (r) => r.agentUsername,
      render: (r) => avatar(r.agentUsername, { sub: r.agentName }),
    },
    { label: 'คิดจาก', render: (r) => r.basisLabel },
    { label: '%', num: true, render: (r) => pct(r.commissionPct) },
    { label: 'ค่าคงที่/รอบ', num: true, render: (r) => (r.fixedAmount === null ? '—' : money(r.fixedAmount)) },
    { label: 'ช่วงเวลา', render: (r) => `${dateTh(r.startDate)} → ${r.endDate ? dateTh(r.endDate) : 'ไม่กำหนด'}` },
    { label: 'สถานะ', render: (r) => badge(r.isActive ? 'ACTIVE' : 'CLOSED') },
    {
      label: '',
      render: (r) => el('div', { class: 'btn-row' },
        el('button', { class: 'btn ghost sm', onclick: () => editModal(r) }, 'แก้ไข'),
        r.isActive ? el('button', { class: 'btn ghost sm', onclick: () => endModal(r) }, 'ปิดดีล') : ''),
    },
  ], items, {
    search: 'ค้นหาสินค้า ร้าน หรือเซล…',
    empty: 'ยังไม่มีดีล — ผูกเซลกับสินค้าที่เขาผลักดัน แล้วระบบจะคิดคอมให้อัตโนมัติทุกครั้งที่ออกบิล',
  }), { tight: true }));
}

/* ── ค่าคอมที่ต้องจ่าย ─────────────────────────────────────── */

/**
 * รวบเป็นรอบบิลก่อน แล้วค่อยกางดูรายการย่อย
 *
 * เดิมเทรายการทั้งหมดลงตารางเดียว พอมีหลายรอบ × หลายร้าน × หลายเซล
 * ก็กลายเป็นรายการยาวเหยียดที่หาอะไรไม่เจอ — ตอนจ่ายจริงคนมองเป็น "รอบ" อยู่แล้ว
 */
async function commissionsTab(agentOptions) {
  const statusFilter = viewState.getItem('franchise.commStatus') ?? 'PENDING';
  const agentFilter = viewState.getItem('franchise.commAgent') ?? '';
  const openKey = viewState.getItem('franchise.commOpen') ?? '';
  const res = await api.get(`/api/sales-agents/commissions${qs({ status: statusFilter, salesAgentId: agentFilter })}`);

  const payModal = (row) => formModal({
    title: `บันทึกจ่ายคอม ${row.agentUsername}`,
    submitLabel: 'บันทึกว่าจ่ายแล้ว',
    fields: [
      { name: 'paidAt', label: 'วันที่จ่าย', type: 'date', value: todayIso() },
      { name: 'note', label: 'หมายเหตุ', placeholder: 'เช่น โอนพร้อมเงินเดือน' },
    ],
    onSubmit: async (v) => {
      await api.post(`/api/sales-agents/commissions/${row.id}/pay`, v);
      toast(`บันทึกจ่ายคอม ${money(row.totalAmount)} ฿ แล้ว`, 'success');
      render();
    },
  });

  /** ค่าคอมที่ไม่ได้มาจากดีล — พิมพ์ชื่อรายการกับจำนวนเงินเอง แล้วเลือกว่าลงรอบไหน */
  const manualModal = (row = null) => formModal({
    title: row ? `แก้ไขค่าคอมอื่น — ${row.label}` : 'เพิ่มค่าคอมอื่น ๆ',
    submitLabel: row ? 'บันทึกการแก้ไข' : 'บันทึกรายการ',
    fields: [
      row
        ? null
        : { name: 'salesAgentId', label: 'จ่ายให้เซล', type: 'select', required: true, options: agentOptions },
      {
        name: 'periodCode',
        label: 'ลงในรอบบิล',
        type: 'select',
        required: true,
        value: row?.periodCode ?? periodOf(),
        options: periodOptions(),
      },
      {
        name: 'label',
        label: 'ชื่อรายการ',
        required: true,
        value: row?.label ?? '',
        placeholder: 'เช่น โบนัสปิดร้านใหม่ / ค่าเดินทางไปเปิดร้าน',
      },
      {
        name: 'amount',
        label: 'จำนวนเงิน (บาท)',
        type: 'number',
        step: '0.01',
        required: true,
        value: row?.totalAmount ?? '',
        hint: 'ใส่ติดลบได้ ถ้าเป็นการหักคืนค่าคอมที่คิดเกินไว้',
      },
      { name: 'note', label: 'หมายเหตุ', value: row?.note ?? '' },
    ].filter(Boolean),
    onSubmit: async (v) => {
      if (row) await api.patch(`/api/sales-agents/commissions/manual/${row.id}`, v);
      else await api.post('/api/sales-agents/commissions/manual', { ...v, salesAgentId: Number(v.salesAgentId) });
      toast(row ? 'แก้ไขแล้ว' : 'บันทึกค่าคอมแล้ว', 'success');
      render();
    },
  });

  const filters = el('div', { class: 'filters', style: 'margin-bottom:16px' },
    el('div', { class: 'field' },
      el('label', {}, 'สถานะ'),
      el('select', { onchange: (e) => { viewState.setItem('franchise.commStatus', e.target.value); render(); } },
        ...[
          { value: 'PENDING', label: 'ยังไม่จ่าย' },
          { value: 'PAID', label: 'จ่ายแล้ว' },
          { value: 'VOID', label: 'ยกเลิก' },
          { value: '', label: 'ทั้งหมด' },
        ].map((o) => el('option', { value: o.value, selected: o.value === statusFilter }, o.label)))),
    el('div', { class: 'field' },
      el('label', {}, 'เซล'),
      el('select', { onchange: (e) => { viewState.setItem('franchise.commAgent', e.target.value); render(); } },
        el('option', { value: '', selected: agentFilter === '' }, 'ทุกคน'),
        ...agentOptions.map((o) => el('option', { value: o.value, selected: o.value === agentFilter }, o.label)))));

  // จัดกลุ่มเป็น (รอบบิล × เซล) — นี่คือหน่วยที่จ่ายเงินจริง โอนทีเดียวต่อคนต่อรอบ
  const groups = new Map();
  for (const item of res.items) {
    const key = `${item.periodCode}|${item.salesAgentId}`;
    const g = groups.get(key) ?? {
      key,
      periodCode: item.periodCode,
      agentUsername: item.agentUsername,
      agentName: item.agentName,
      items: [],
      total: 0,
      pending: 0,
    };
    g.items.push(item);
    g.total += item.totalAmount;
    if (item.status === 'PENDING') g.pending += item.totalAmount;
    groups.set(key, g);
  }
  const grouped = [...groups.values()]
    .sort((a, b) => (b.periodCode.localeCompare(a.periodCode) || a.agentUsername.localeCompare(b.agentUsername)));

  const payAll = res.items.filter((r) => r.status === 'PENDING');

  /** ตารางรายการย่อยของกลุ่มหนึ่ง — โผล่เฉพาะตอนกางออกมา */
  const detailTable = (group) => table([
    {
      label: 'รายการ',
      render: (r) => el('div', {},
        el('strong', {}, r.title),
        el('div', { class: 'sub-line' },
          r.isManual ? (r.note || 'พิมพ์เพิ่มเอง') : (r.invoiceNo ?? '—'))),
    },
    {
      label: 'ฐานที่คิด',
      num: true,
      render: (r) => (r.isManual
        ? el('span', { class: 'muted' }, '—')
        : el('div', {}, money(r.baseAmount), el('div', { class: 'sub-line' }, r.basisLabel))),
    },
    { label: 'จาก %', num: true, render: (r) => (r.commissionPct === null ? el('span', { class: 'muted' }, '—') : `${money(r.pctAmount)} (${pct(r.commissionPct)})`) },
    { label: 'จำนวนเงิน', num: true, render: (r) => (r.fixedAmount ? money(r.fixedAmount) : el('span', { class: 'muted' }, '—')) },
    { label: 'รวม', num: true, render: (r) => el('strong', {}, money(r.totalAmount)) },
    { label: 'สถานะ', render: (r) => commBadge(r.status) },
    {
      label: '',
      render: (r) => el('div', { class: 'btn-row' },
        r.status === 'PENDING'
          ? el('button', { class: 'btn sm', onclick: () => payModal(r) }, 'จ่ายแล้ว')
          : el('span', { class: 'muted' }, r.paidAt ? dateTh(r.paidAt) : '—'),
        // แก้/ลบได้เฉพาะรายการที่คนพิมพ์เอง — ของที่ระบบคิดจากดีลต้องไปแก้ที่ดีลหรือบิล
        r.isManual && r.status === 'PENDING'
          ? el('button', { class: 'btn ghost sm', onclick: () => manualModal(r) }, 'แก้ไข')
          : '',
        r.isManual && r.status === 'PENDING'
          ? el('button', {
            class: 'btn ghost sm danger',
            onclick: () => confirmAction(`ลบรายการ "${r.label}"?`, async () => {
              await api.del(`/api/sales-agents/commissions/manual/${r.id}`);
              toast('ลบแล้ว', 'success');
              render();
            }),
          }, 'ลบ')
          : ''),
    },
  ], group.items, { sortable: false });

  return el('div', {},
    filters,
    el('div', { class: 'stat-grid' },
      stat('รอบบิล × เซล', int(grouped.length), `${int(res.summary.count)} รายการย่อย`, { tone: 'muted', icon: '📋' }),
      stat('ค้างจ่าย', money(res.summary.pending) + ' ฿', null,
        { tone: res.summary.pending > 0 ? 'due' : 'muted', icon: '⏳' }),
      stat('จ่ายแล้ว', money(res.summary.paid) + ' ฿', null, { tone: 'income', icon: '✓' })),

    el('div', { class: 'btn-row', style: 'margin-bottom:12px' },
      el('button', { class: 'btn', onclick: () => manualModal() }, '+ เพิ่มค่าคอมอื่น ๆ'),
      payAll.length > 1
        ? el('button', {
          class: 'btn ghost',
          onclick: () => confirmAction(`บันทึกจ่ายคอมทั้งหมด ${payAll.length} รายการ รวม ${money(res.summary.pending)} บาท?`, async () => {
            for (const r of payAll) await api.post(`/api/sales-agents/commissions/${r.id}/pay`, { paidAt: todayIso() });
            toast(`บันทึกจ่ายคอม ${payAll.length} รายการแล้ว`, 'success');
            render();
          }),
        }, `จ่ายทั้งหมด (${payAll.length})`)
        : ''),

    card(null, table([
      {
        label: 'รอบบิล',
        render: (g) => el('strong', {}, periodLabel(g.periodCode)),
        sortValue: (g) => g.periodCode,
      },
      { label: 'เซล', render: (g) => avatar(g.agentUsername, { sub: g.agentName }), sortValue: (g) => g.agentUsername },
      { label: 'รายการย่อย', num: true, render: (g) => int(g.items.length) },
      {
        label: 'ค้างจ่าย',
        num: true,
        sortValue: (g) => g.pending,
        render: (g) => (g.pending
          ? el('strong', { class: 'text-warn' }, money(g.pending))
          : el('span', { class: 'muted' }, '—')),
      },
      { label: 'รวมทั้งรอบ', num: true, sortValue: (g) => g.total, render: (g) => el('strong', {}, money(g.total)) },
      {
        label: '',
        sortable: false,
        render: (g) => el('div', { class: 'btn-row' },
          el('button', {
            class: `btn ghost sm${openKey === g.key ? ' active' : ''}`,
            // เปิดได้ทีละกลุ่ม — กางหมดพร้อมกันก็กลับไปเป็นรายการยาวเหยียดเหมือนเดิม
            onclick: () => {
              viewState.setItem('franchise.commOpen', openKey === g.key ? '' : g.key);
              render();
            },
          }, openKey === g.key ? '▲ ปิดรายการย่อย' : `▼ ดูรายการย่อย (${g.items.length})`),
          g.pending > 0
            ? el('button', {
              class: 'btn sm',
              onclick: () => confirmAction(
                `จ่ายคอมรอบ ${periodLabel(g.periodCode)} ให้ ${g.agentUsername} รวม ${money(g.pending)} บาท?`,
                async () => {
                  for (const r of g.items.filter((x) => x.status === 'PENDING')) {
                    await api.post(`/api/sales-agents/commissions/${r.id}/pay`, { paidAt: todayIso() });
                  }
                  toast('บันทึกจ่ายคอมทั้งรอบแล้ว', 'success');
                  render();
                },
              ),
            }, 'จ่ายทั้งรอบ')
            : ''),
      },
    ], grouped, {
      search: 'ค้นหารอบบิลหรือเซล…',
      empty: 'ยังไม่มีค่าคอม — เกิดอัตโนมัติเมื่อออกบิลที่มีสินค้าของเซล หรือกด "+ เพิ่มค่าคอมอื่น ๆ"',
      // กางใต้แถวของกลุ่มนั้นเลย ไม่ต้องเลื่อนลงไปหาแล้วลืมว่ากางของใครอยู่
      expand: (g) => (openKey === g.key ? detailTable(g) : null),
      footer: grouped.length
        ? ['', 'รวมทุกรอบที่แสดง', int(res.summary.count), money(res.summary.pending), money(res.summary.pending + res.summary.paid), '']
        : undefined,
    }), { tight: true }));
}
