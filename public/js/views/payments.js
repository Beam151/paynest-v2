import { api, qs, session } from '../api.js';
import {
  alertBanner, badge, card, confirmAction, copyButton, dateTh, el, flashRows, formModal, infoModal, int, money, slipBadge, stat, table, toast,
} from '../ui.js';
import { periodLabel, todayIso } from '../period.js';
import { render } from '../app.js';
import { viewState } from '../viewState.js';
import { activityButton } from './activity.js';
import { avatar } from '../charts.js';

const STATUS_KEY = 'franchise.paySubStatus';

/**
 * สลิปที่ถูกปฏิเสธและร้านยังต้องทำอะไรต่อ: บิลนั้นยังค้าง และยังไม่ได้แจ้งใหม่หลังโดนปฏิเสธ
 * ใช้ทั้งหน้าจ่ายเงินและหน้าภาพรวมของร้าน (หน้าแรกที่ร้านเห็น)
 */
export function rejectedToRedo(submissions, outstandingInvoices) {
  return submissions.filter((sub) => sub.status === 'REJECTED'
    && outstandingInvoices.some((inv) => inv.id === sub.invoiceId)
    && !submissions.some((other) => other.invoiceId === sub.invoiceId && other.id > sub.id));
}

/** เหลือไว้เป็นทางเข้าของร้านค้า — ฝั่งส่วนกลางย้ายไปรวมที่หน้าใบเรียกเก็บแล้ว */
export async function paymentsView() {
  return payCenterView();
}

/**
 * ฝั่งร้านค้า: บิลที่ต้องจ่าย + ฟอร์มแจ้งชำระ + ประวัติการแจ้งของตัวเอง
 *
 * embedded = ถูกเอาไปวางเป็นแท็บในหน้า "บิลของฉัน" จึงไม่ต้องมีหัวหน้าเป็นของตัวเอง
 * (ร้านมีเมนูเดียวคือ "บิลของฉัน" — เดิมแยกเป็นสองเมนูแล้วทั้งคู่ลิสต์บิลเหมือนกันจนงง)
 */
export async function payCenterView({ embedded = false } = {}) {
  // สิทธิ์รายข้อของผู้ช่วยร้าน — null/undefined = ไม่ถูกจำกัด (เจ้าของร้าน)
  const canPay = !Array.isArray(session.user?.permissions) || session.user.permissions.includes('pay');

  const center = await api.get('/api/payments/center');

  /*
   * ยอดที่ส่วนกลางติดค้างร้านจากรอบที่คืนของมากกว่าขาย
   * ร้านต้องเห็นว่าเงินก้อนนี้ยังอยู่ ไม่ได้หายไป — มันจะไปลดบิลรอบหน้าให้เอง
   * ไม่ล้มทั้งหน้าถ้าดึงไม่ได้ เพราะมันเป็นข้อมูลเสริม ไม่ใช่แกนของหน้านี้
   */
  // view-as เก็บรหัสร้านไว้ที่ viewAs.id (ดู api.js) ไม่ใช่ franchiseId
  const franchiseId = session.viewAs?.role === 'FRANCHISE' ? session.viewAs.id : session.user?.franchiseId;
  const credit = franchiseId
    ? await api.get(`/api/franchises/${franchiseId}/credits`).catch(() => null)
    : null;

  /**
   * ฟอร์มชำระเงินของร้าน — จ่ายทีละบิล จะจ่ายครบหรือทยอยจ่ายก็ได้
   * ต้องแนบสลิปและพิมพ์ยอดซ้ำอีกครั้ง เพราะตัวเลขนี้คือสิ่งที่ส่วนกลางจะเอาไปตัดยอดจริง
   */
  const submitModal = (invoice) => {
    /*
     * แจ้งได้ไม่เกิน "ยอดค้าง − ยอดที่แจ้งไว้แล้วแต่ยังรอตรวจ"
     * ไม่งั้นพอทยอยจ่ายหลายงวด ฟอร์มจะตั้งยอดเต็มไว้แล้วโดนเซิร์ฟเวอร์ปฏิเสธทีหลัง
     */
    const waiting = pendingOf(invoice.id).reduce((sum, x) => sum + x.amount, 0);
    const payable = Number((invoice.outstanding - waiting).toFixed(2));

    /*
     * เลขบัญชีปลายทางต้องอยู่ตรงหน้าตอนกำลังจะโอน ไม่ใช่ให้ย้อนไปเปิดบิลดูเอง
     * ใช้บัญชีที่ตรึงไว้กับบิลใบนี้ ไม่ใช่บัญชีหลักปัจจุบัน — บิลเก่าต้องโอนเข้าที่เดิมเสมอ
     */
    /*
     * บิลดอลลาร์: ร้านกรอกเป็นดอลลาร์ แต่ระบบบันทึกเป็นบาทเสมอ
     * แปลงด้วยอัตราที่ตรึงไว้กับบิลใบนี้ ไม่ใช่อัตราล่าสุด — ไม่งั้นยอดจะไม่ตรงกับที่ตกลงกันไว้
     */
    const toBillCcy = (baht) => (invoice.isUsd ? Number((baht / invoice.usdRate).toFixed(2)) : baht);
    const payableInBillCcy = invoice.isUsd ? toBillCcy(payable) : payable;

    /**
     * แปลงกลับเป็นบาทเพื่อบันทึก
     *
     * ปัดเศษไป-กลับแล้วไม่ลงตัว เช่น 1,500 ÷ 36.25 = $41.3793… ปัดเป็น $41.38
     * คูณกลับได้ 1,500.03 ซึ่งเกินยอดค้างจริงไป 3 สตางค์ แล้วโดนเซิร์ฟเวอร์ปฏิเสธ
     *
     * จ่ายเต็มจำนวนที่ค้าง = ตัดยอดบาทให้พอดีเป๊ะ ไม่ต้องไปคูณกลับ
     * ส่วนกรณีทยอยจ่ายก็กันไม่ให้ล้นยอดค้างด้วยเศษที่ปัดขึ้น
     */
    const toBaht = (amount) => {
      if (!invoice.isUsd) return amount;
      if (amount === payableInBillCcy) return payable;
      return Math.min(Number((amount * invoice.usdRate).toFixed(2)), payable);
    };

    /*
    * โชว์เฉพาะสกุลที่บิลใบนี้กำหนดให้จ่าย
    * บิลบาทไม่ต้องเห็นยอดดอลลาร์ให้รก และบิลดอลลาร์ก็ไม่ต้องเห็นบาทเป็นตัวหลัก
    * (super เป็นคนเลือกสกุลตั้งแต่ตอนออกบิลแล้ว ร้านแค่ทำตาม)
    */
    const bankBox = el('div', { style: 'margin-bottom:14px' },
      bankAccountBox(invoice.bankAccount),
      invoice.isUsd ? usdLine(invoice, { amountUsd: invoice.outstandingUsd }) : '',
      // ยอดที่ต้องพิมพ์ในแอปธนาคาร — ไอคอนคัดลอกติดข้างตัวเลข แบบเดียวกับเลขบัญชี
      payableInBillCcy > 0
        ? el('div', { class: 'pay-amount' },
          el('span', { class: 'sub-line' }, 'ยอดที่ต้องโอน'),
          el('span', { class: 'pay-amount-value' },
            el('strong', {}, payMoney(invoice, payableInBillCcy)),
            copyButton(payableInBillCcy.toFixed(2), 'คัดลอกยอดเงิน', { iconOnly: true })))
        : '');

    return formModal({
    title: `ชำระเงิน — ${invoice.invoiceNo}`,
    submitLabel: 'ยืนยันแจ้งชำระ',
    fields: [
      {
        // สลิปก่อน — หลังโอนเสร็จ สิ่งที่อยู่ในมือคือรูปสลิป ส่วนยอดเติมไว้ให้แล้ว
        // รับเฉพาะไฟล์ ไม่รับลิงก์ — ลิงก์ภายนอกพังเมื่อไหร่ก็ได้ แล้วหลักฐานการโอนหายตาม
        name: 'slipFile',
        label: 'รูปสลิปการโอน',
        type: 'file',
        accept: 'image/*,application/pdf',
        required: true,
        hint: 'แนบรูปสลิปหรือ PDF — รูปใหญ่ระบบย่อให้เอง ตัวหนังสือยังชัด',
      },
      {
        name: 'amount',
        label: `จำนวนเงินที่โอน (${invoice.isUsd ? 'ดอลลาร์ USD' : 'บาท'})`,
        type: 'number',
        step: '0.01',
        required: true,
        value: payableInBillCcy,
        hint: waiting > 0
          ? `ยอดค้าง ${payMoney(invoice, toBillCcy(invoice.outstanding))} แต่มีที่แจ้งไว้รอตรวจอีก ${payMoney(invoice, toBillCcy(waiting))} — แจ้งเพิ่มได้ไม่เกิน ${payMoney(invoice, payableInBillCcy)}`
          : `ยอดค้างของบิลนี้ ${payMoney(invoice, toBillCcy(invoice.outstanding))} — ทยอยจ่ายทีละงวดก็ได้`,
      },
      {
        /*
         * พิมพ์ยอดซ้ำเฉพาะตอนแก้ยอดเอง (ทยอยจ่าย) — กันพิมพ์ตัวเลขผิด
         * จ่ายเต็มยอดที่ระบบเติมให้ ไม่มีอะไรให้พิมพ์ผิด จึงไม่ต้องถาม
         */
        name: 'amountConfirm',
        label: 'พิมพ์ยอดอีกครั้งเพื่อยืนยัน',
        type: 'number',
        step: '0.01',
        required: true,
        hint: 'กันพิมพ์ตัวเลขผิด — ต้องใส่เฉพาะตอนจ่ายไม่เต็มยอด',
        showWhen: (v) => v.amount !== undefined && Number(v.amount) !== payableInBillCcy,
      },
      { name: 'paidAt', label: 'วันที่โอน', type: 'date', required: true, value: todayIso() },
      // ไม่เติมเวลาตอนนี้ให้ — เกือบทุกครั้งโอนก่อนมาแจ้ง เวลาที่เติมให้จึงผิด
      { name: 'paidTime', label: 'เวลาที่โอน (ตามสลิป)', type: 'time', hint: 'ไม่ใส่ก็ได้ — ใส่แล้วทางเราตรวจกับรายการเดินบัญชีได้เร็วขึ้น' },
      { name: 'method', label: 'ช่องทาง', placeholder: 'โอนธนาคาร / พร้อมเพย์ / เงินสด' },
      { name: 'note', label: 'หมายเหตุ' },
    ],

    preview: (v) => {
      if (v.amount === undefined) return bankBox;
      const amount = Number(v.amount);
      if (amount > payableInBillCcy) {
        return {
          canSubmit: false,
          node: el('div', {}, bankBox,
            el('div', { class: 'error-box m-0' },
              waiting > 0
                ? `แจ้งเพิ่มได้ไม่เกิน ${payMoney(invoice, payableInBillCcy)} (ยอดค้าง ${payMoney(invoice, toBillCcy(invoice.outstanding))} หักที่แจ้งรอตรวจอยู่ ${payMoney(invoice, toBillCcy(waiting))})`
                : `ยอดที่กรอกเกินยอดค้างของบิลนี้ (${payMoney(invoice, toBillCcy(invoice.outstanding))})`)),
        };
      }
      if (amount !== payableInBillCcy && v.amountConfirm !== undefined && Number(v.amountConfirm) !== amount) {
        return {
          canSubmit: false,
          node: el('div', {}, bankBox,
            el('div', { class: 'error-box m-0' }, 'ยอดยืนยันไม่ตรงกับยอดที่กรอกไว้ด้านบน')),
        };
      }
      const left = Number((payableInBillCcy - amount).toFixed(2));
      return el('div', {}, bankBox,
        el('div', { class: 'notice-box m-0' },
          left > 0
            ? el('span', {}, 'จ่ายบางส่วน — เมื่อยืนยันรับเงินแล้วจะเหลือค้างอีก ',
              el('strong', {}, payMoney(invoice, left)), ' แจ้งงวดถัดไปได้ทีหลัง')
            : el('span', {}, 'ครบยอดที่ค้างอยู่ — เมื่อยืนยันรับเงินครบทุกงวดแล้วบิลนี้จะปิดสมบูรณ์'),
          // บอกให้ชัดว่าระบบจะบันทึกเป็นบาทเท่าไร ร้านจะได้ไม่งงตอนเห็นประวัติเป็นบาท
          invoice.isUsd
            ? el('div', { class: 'sub-line mt-6' },
              `ระบบบันทึกเป็นเงินบาท ${money(toBaht(amount))} ฿ (อัตรา ${money(invoice.usdRate)} ฿/USD ที่ตรึงไว้กับบิลนี้)`)
            : ''));
    },

    onSubmit: async (v) => {
      if (Number(v.amount) !== payableInBillCcy && Number(v.amountConfirm) !== Number(v.amount)) {
        throw new Error('ยอดยืนยันไม่ตรงกับยอดที่กรอกไว้');
      }
      if (!v.slipFile) throw new Error('ต้องแนบไฟล์สลิปการโอน');

      /*
       * อัปโหลดไฟล์ก่อน แล้วค่อยส่งแบบฟอร์มพร้อม URL ที่ได้กลับมา
       * ถ้าอัปโหลดไม่ผ่านจะหยุดตรงนี้ ไม่บันทึกการแจ้งชำระที่ไม่มีสลิปแนบ
       */
      const { amountConfirm, slipFile, ...body } = v;
      body.slipUrl = (await api.upload(v.slipFile)).url;
      // แปลงเป็นบาทก่อนส่ง — ทั้งระบบคิดเงินเป็นบาทหน่วยเดียว
      await api.post('/api/payments', {
        ...body,
        amount: toBaht(Number(v.amount)),
        note: invoice.isUsd
          ? [`โอนเป็น $${money(v.amount)} (อัตรา ${money(invoice.usdRate)} ฿/USD)`, v.note].filter(Boolean).join(' · ')
          : v.note,
        invoiceId: invoice.id,
      });
      toast(`แจ้งชำระ ${payMoney(invoice, v.amount)} แล้ว รอตรวจสอบ`, 'success');
      render();
    },
    });
  };

  /**
   * ดูบิลเต็มใบ — ดึงจาก API ใหม่เพื่อให้ใช้ได้ทั้งจากตารางบิลที่ค้าง
   * และจากแถวประวัติการชำระ (ซึ่งมีแค่ invoiceId ไม่ได้ถือข้อมูลบิลไว้)
   */
  const billModal = async (invoiceId) => {
    const inv = await api.get(`/api/invoices/${invoiceId}`);
    const modal = infoModal({
      title: `${inv.invoiceNo} — รอบ ${periodLabel(inv.periodCode)}${inv.isUsd ? ' · สกุล USD' : ''}`,
      width: 680,
      content: null,
    });

    modal.body.append(
      el('div', { class: 'stat-grid' },
        // บิลดอลลาร์โชว์ดอลลาร์เป็นตัวหลัก แล้วต่อท้ายด้วยยอดบาทที่ระบบใช้คิดจริง
        stat('ยอดที่ต้องจ่าย', payMoney(inv, inv.payAmount),
          inv.isUsd ? `= ${money(inv.netTotal)} ฿ · ออก ${dateTh(inv.issuedAt)}` : `ออก ${dateTh(inv.issuedAt)}`,
          { tone: 'sales', icon: '🧾' }),
        stat('จ่ายไปแล้ว', money(inv.paid) + ' ฿', null, { tone: 'income', icon: '✓' }),
        stat('คงเหลือ', payMoney(inv, inv.payOutstanding),
          inv.isUsd ? `= ${money(inv.outstanding)} ฿ · ครบกำหนด ${dateTh(inv.dueDate)}` : `ครบกำหนด ${dateTh(inv.dueDate)}`,
          { tone: inv.outstanding > 0 ? 'due' : 'income', icon: inv.outstanding > 0 ? '⏳' : '✓' })),
      inv.isUsd ? usdLine(inv) : '',
      el('h3', { style: 'margin:6px 0 8px' }, 'รายการในบิล'),
      breakdownTable(inv),
      // รอบที่ติดลบ: ไม่มีอะไรต้องโอน และยอดที่ค้างจะไปโผล่เป็นส่วนลดในบิลรอบหน้า
      inv.creditCarried > 0
        ? el('div', { class: 'notice-box', style: 'margin:16px 0 0' },
          `รอบนี้ยอดติดลบ ${money(inv.creditCarried)} ฿ — ทางเราติดค้างร้านไว้`,
          el('div', { class: 'sub-line mt-4' },
            'ยกไปหักจากบิลรอบถัดไปให้อัตโนมัติ รอบนี้ไม่ต้องโอนอะไร'))
        : el('div', { class: 'mt-16' }, bankAccountBox(inv.bankAccount)));
  };

  /**
   * ดูสลิปที่แนบไว้ — โชว์รูปในหน้าต่างเลย ไม่ต้องเปิดแท็บใหม่แล้วกดกลับ
   * ถ้าลิงก์เสียหรือโหลดไม่ขึ้น ค่อยลดรูปเหลือปุ่มเปิดลิงก์ตรง ๆ แทน
   */
  const slipModal = (row) => {
    const modal = infoModal({ title: `สลิปที่แจ้งไว้ — ${row.invoiceNo}`, width: 560, content: null });

    const detail = (label, value) => el('div', { style: 'display:flex;justify-content:space-between;gap:12px;padding:6px 0' },
      el('span', { class: 'muted', style: 'font-size:13px' }, label),
      el('strong', {}, value));

    const box = el('div', { class: 'mt-12' });
    if (/\.pdf(\?|$)/i.test(row.slipUrl ?? '')) {
      // PDF ฝังเป็น <img> ไม่ได้ ให้เปิดในแท็บใหม่แทน
      box.append(el('div', { class: 'notice-box m-0' },
        '📄 สลิปเป็นไฟล์ PDF',
        el('div', { class: 'mt-8' },
          el('a', { href: row.slipUrl, target: '_blank', rel: 'noreferrer', class: 'btn ghost sm' }, 'เปิดดู PDF'))));
    } else if (row.slipUrl) {
      const img = el('img', {
        src: row.slipUrl,
        alt: `สลิปของ ${row.invoiceNo}`,
        style: 'width:100%;border-radius:10px;border:1px solid var(--border);display:block',
      });
      img.addEventListener('error', () => {
        box.replaceChildren(
          el('div', { class: 'notice-box m-0' }, 'เปิดรูปสลิปไม่ได้ — ลิงก์อาจหมดอายุหรือไม่ใช่ไฟล์รูป',
            el('div', { class: 'mt-8' },
              el('a', { href: row.slipUrl, target: '_blank', rel: 'noreferrer', class: 'btn ghost sm' }, 'เปิดลิงก์ในแท็บใหม่'))));
      });
      box.append(img);
    } else {
      box.append(el('div', { class: 'notice-box m-0' }, 'รายการนี้ไม่ได้แนบสลิปไว้'));
    }

    modal.body.append(
      el('div', { class: 'card', style: 'box-shadow:none;margin:0' },
        el('div', { class: 'card-body' },
          detail('จำนวนที่แจ้ง', money(row.amount) + ' ฿'),
          detail('วันเวลาที่โอน', `${dateTh(row.paidAt)}${row.paidTime ? ` ${row.paidTime} น.` : ''}`),
          detail('ช่องทาง', row.method ?? '—'),
          // รายการเก่าที่เคยกรอกไว้ยังดูได้ ส่วนรายการใหม่ไม่มีช่องนี้แล้วเลยไม่ต้องโชว์
          row.reference ? detail('เลขอ้างอิง', row.reference) : '',
          row.note ? detail('หมายเหตุ', row.note) : '',
          row.rejectReason ? detail('เหตุผลที่ถูกปฏิเสธ', row.rejectReason) : '')),
      box);
  };

  const pendingOf = (invId) => center.submissions.filter((s) => s.invoiceId === invId && s.status === 'PENDING');

  const overdue = center.outstandingInvoices.filter((r) => r.isOverdue);
  const overdueTotal = overdue.reduce((sum, r) => sum + r.outstanding, 0);

  /*
   * สลิปที่ถูกปฏิเสธและยังต้องทำอะไรต่อ = บิลนั้นยังค้าง และยังไม่ได้แจ้งใหม่หลังโดนปฏิเสธ
   * เดิมเหตุผลซ่อนเป็นบรรทัดเล็กท้ายหน้า ร้านไม่รู้ว่าโดนตีกลับจนบิลเลยกำหนด
   */
  const rejectedBanners = rejectedToRedo(center.submissions, center.outstandingInvoices).slice(0, 3).map((sub) => {
    const invoice = center.outstandingInvoices.find((inv) => inv.id === sub.invoiceId);
    const canRedo = canPay && !session.viewAs;
    return alertBanner({
      title: `✗ สลิป ${money(sub.amount)} บาท ของบิล ${sub.invoiceNo} ถูกปฏิเสธ`,
      detail: `เหตุผล: ${sub.rejectReason ?? 'ไม่ได้ระบุ'} — ${canRedo ? 'ตรวจสลิปแล้วแจ้งชำระใหม่ได้เลย' : 'แจ้งผู้มีสิทธิ์จ่ายเงินของร้าน'}`,
      actionLabel: canRedo ? 'แจ้งชำระใหม่' : 'ดูบิล',
      onClick: () => (canRedo ? submitModal(invoice) : billModal(invoice.id)),
    });
  });

  return el('div', {},
    embedded ? '' : el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'ชำระเงิน'),
        el('p', {}, 'โอนเงินแล้วกด "ชำระเงิน" ที่บิลนั้น แนบสลิปและยืนยันยอด — ยอดจะถูกตัดเมื่อตรวจสอบเรียบร้อยแล้ว'))),

    ...rejectedBanners,

    /*
     * กดแถบเตือนแล้วต้องไปถึงบิลนั้นเลย
     * ค้างใบเดียว → เปิดฟอร์มจ่ายให้ทันที (จ่ายได้ในคลิกเดียว)
     * ค้างหลายใบ → เลื่อนไปกะพริบแถวที่เลยกำหนด ให้ร้านเลือกเองว่าจะจ่ายใบไหนก่อน
     */
    overdue.length ? alertBanner({
      title: `⚠ มีบิลเลยกำหนดชำระ ${overdue.length} ใบ รวม ${money(overdueTotal)} บาท`,
      detail: `ใบที่ค้างนานที่สุดเลยกำหนดมาแล้ว ${int(Math.max(...overdue.map((r) => r.daysOverdue)))} วัน`,
      // ผู้ช่วยที่ไม่มีสิทธิ์จ่าย: ชี้ไปดูบิลแทน — เดิมเปิดฟอร์มให้กรอกจนจบแล้วค่อยโดนปฏิเสธตอนแนบสลิป
      actionLabel: overdue.length === 1 && !session.viewAs && canPay ? 'จ่ายบิลนี้เลย' : 'ดูบิลที่เลยกำหนด',
      onClick: () => {
        if (overdue.length === 1 && !session.viewAs && canPay) submitModal(overdue[0]);
        else flashRows('tr.row-overdue');
      },
    }) : '',

    el('div', { class: 'stat-grid' },
      stat('ยอดที่ต้องจ่ายทั้งหมด', money(center.totalOutstanding) + ' ฿', `${center.outstandingInvoices.length} ใบเรียกเก็บ`,
        { tone: center.totalOutstanding > 0 ? 'due' : 'income', icon: center.totalOutstanding > 0 ? '⏳' : '✓' }),
      stat('แจ้งแล้ว รอตรวจสอบ', money(center.summary.pendingAmount) + ' ฿', `${int(center.summary.pendingCount)} รายการ`,
        { tone: center.summary.pendingCount ? 'warn' : 'muted', icon: '👀' }),
      stat('ยืนยันรับเงินแล้ว', money(center.summary.approvedAmount) + ' ฿', null, { tone: 'income', icon: '✓' }),
      // โผล่เฉพาะตอนมีจริง — ร้านส่วนใหญ่ไม่เคยติดลบ ไม่ต้องมีการ์ด 0.00 ให้รก
      credit?.summary.open > 0
        ? stat('ทางเราติดค้างร้าน', money(credit.summary.open) + ' ฿',
          'จะถูกหักออกจากบิลรอบถัดไปให้อัตโนมัติ', { tone: 'income', icon: '↩' })
        : ''),

    card('บิลที่ต้องชำระ',
      table([
        {
          label: 'เลขที่',
          render: (r) => el('div', {}, el('strong', {}, r.invoiceNo), ' ', currencyTag(r),
            el('div', { class: 'sub-line' }, `รอบ ${periodLabel(r.periodCode)}`)),
        },
        { label: 'ส่วนต่าง', num: true, render: (r) => money(r.commissionTotal) },
        { label: 'ค่าใช้จ่ายอื่น', num: true, render: (r) => (r.chargeTotal ? `+${money(r.chargeTotal)}` : '—') },
        { label: 'ส่วนลด', num: true, render: (r) => (r.discountTotal ? `−${money(r.discountTotal)}` : '—') },
        { label: 'ยอดที่ต้องจ่าย', num: true, render: (r) => el('strong', {}, money(r.netTotal)) },
        { label: 'ชำระแล้ว', num: true, render: (r) => money(r.paid) },
        {
          // บิลดอลลาร์โชว์ยอดที่ต้องโอนจริงเป็นดอลลาร์ ตัวบาทอยู่บรรทัดรอง
          label: 'คงเหลือ',
          num: true,
          sortValue: (r) => r.outstanding,
          render: (r) => el('div', {}, el('strong', {}, payMoney(r, r.payOutstanding)),
            r.isUsd ? el('div', { class: 'sub-line' }, `= ${money(r.outstanding)} ฿`) : ''),
        },
        {
          label: 'ครบกำหนด',
          render: (r) => el('div', {}, dateTh(r.dueDate),
            r.isOverdue ? el('div', { class: 'overdue-tag' }, `เลยกำหนด ${int(r.daysOverdue)} วัน`) : ''),
        },
        { label: 'สถานะ', render: (r) => badge(r.status) },
        {
          label: '',
          render: (r) => el('div', { class: 'btn-row' },
            el('button', { class: 'btn ghost sm', onclick: () => billModal(r.id) }, 'ดูบิล'),
            pendingOf(r.id).length
              ? el('span', { class: 'badge amber' }, `รอตรวจ ${money(pendingOf(r.id).reduce((s, x) => s + x.amount, 0))} ฿`)
              : '',
            /*
             * โหมด "ดูมุมมองนี้" ของส่วนกลางเป็นแบบอ่านอย่างเดียว
             * โชว์ป้ายบอกเหตุผลแทนปุ่มจาง ๆ ที่ดูเหมือนกดได้แล้วกดไม่ติด
             * (ส่วนกลางจ่ายเงินแทนร้านไม่ได้อยู่แล้ว — เงินต้องมาจากร้านเท่านั้น)
             */
            session.viewAs
              ? el('span', { class: 'readonly-tag', title: 'ต้องเข้าด้วยบัญชีของร้านถึงจะแจ้งชำระได้' }, '👁 ดูอย่างเดียว')
              // ผู้ช่วยที่เจ้าของร้านไม่ได้เปิดสิทธิ์ "แจ้งชำระเงิน" ให้ ดูได้อย่างเดียว
              : !canPay
                ? el('span', { class: 'readonly-tag', title: 'บัญชีของคุณไม่มีสิทธิ์แจ้งชำระเงิน — ติดต่อเจ้าของบัญชีร้าน' }, '🔒 ไม่มีสิทธิ์จ่าย')
                : el('button', { class: 'btn sm', onclick: () => submitModal(r) }, '💳 ชำระเงิน')),
        },
      ], center.outstandingInvoices, {
        rowClass: (r) => (r.isOverdue ? 'row-overdue' : ''),
        empty: 'จ่ายครบทุกบิลแล้ว 🎉',
      }), { tight: true }),

    card('ประวัติการชำระเงินของคุณ',
      table([
        { label: 'วันที่แจ้ง', render: (r) => dateTh(r.createdAt) },
        { label: 'ใบเรียกเก็บ', render: (r) => el('div', {}, el('strong', {}, r.invoiceNo), el('div', { class: 'sub-line' }, periodLabel(r.periodCode))) },
        { label: 'จำนวน', num: true, render: (r) => money(r.amount) },
        { label: 'วันที่โอน', render: (r) => el('div', {}, dateTh(r.paidAt), r.paidTime ? el('div', { class: 'sub-line' }, `${r.paidTime} น.`) : '') },
        { label: 'ช่องทาง', render: (r) => r.method ?? el('span', { class: 'muted' }, '—') },
        {
          label: 'สถานะ',
          render: (r) => el('div', {},
            slipBadge(r.status),
            r.rejectReason ? el('div', { class: 'sub-line' }, `เหตุผล: ${r.rejectReason}`) : ''),
        },
        {
          // ย้อนดูได้ครบจากแถวเดียว: บิลที่จ่ายไป และสลิปที่แนบไปตอนนั้น
          label: '',
          render: (r) => el('div', { class: 'btn-row' },
            el('button', { class: 'btn ghost sm', onclick: () => billModal(r.invoiceId) }, 'ดูบิล'),
            el('button', {
              class: 'btn ghost sm',
              disabled: !r.slipUrl,
              title: r.slipUrl ? undefined : 'รายการนี้ไม่ได้แนบสลิปไว้',
              onclick: () => slipModal(r),
            }, '🧾 ดูสลิป'),
            r.status === 'PENDING' && !session.viewAs && canPay
              ? el('button', {
                class: 'btn ghost sm danger',
                onclick: () => confirmAction('ยกเลิกรายการแจ้งชำระนี้?', async () => {
                  await api.post(`/api/payments/${r.id}/cancel`);
                  toast('ยกเลิกแล้ว', 'success');
                  render();
                }),
              }, 'ยกเลิก')
              : ''),
        },
      ], center.submissions, {
        search: 'ค้นหาเลขที่บิลหรือรอบบิล…',
        empty: 'ยังไม่เคยแจ้งชำระเงิน',
      }), { tight: true }));
}

/* ── ฝั่งส่วนกลาง: ชิ้นส่วนที่หน้า "ใบเรียกเก็บ" เอาไปประกอบเป็นแท็บ ──
 *
 * เดิมเป็นหน้า "รายการชำระบิล" แยกต่างหาก แต่มันลิสต์บิลชุดเดียวกับหน้าใบเรียกเก็บ
 * ทำให้ต้องเด้งไปมาระหว่างสองเมนูเพื่อทำงานกับบิลใบเดียว
 * ตอนนี้รวมไว้ที่เดียว: ออกบิล / แก้บิล / ตรวจสลิป / ดูเงินเข้า อยู่ในหน้าเดียวกันหมด
 *
 * ย้ำอีกครั้ง: ส่วนกลางไม่มีสิทธิ์ "จ่ายเงินแทนร้าน"
 * เงินเข้าระบบได้ทางเดียวคือร้านแจ้งชำระเข้ามา แล้วส่วนกลางตรวจแล้วกดอนุมัติ
 * ทำแบบนี้เพื่อให้ทุกบาทที่ตัดยอดมีสลิปและคนรับผิดชอบกำกับอยู่เสมอ
 */

/**
 * ตัวเลขรวมสำหรับการ์ดสถิติและป้ายบนแท็บ
 *
 * ตัวเลขหลักผูกกับรอบที่เลือกอยู่ เพื่อให้ป้ายบนแท็บตรงกับสิ่งที่เห็นจริงเมื่อกดเข้าไป
 * แต่ pendingAllPeriods นับข้ามรอบเสมอ — สลิปที่ค้างอยู่ในรอบอื่นต้องไม่เงียบหายไป
 * เพราะดันเลือกดูรอบนี้อยู่
 */
export async function paymentTotals(periodCode = '') {
  const [pending, received, pendingAll] = await Promise.all([
    api.get(`/api/payments${qs({ status: 'PENDING', periodCode })}`),
    api.get(`/api/payments/received${qs({ periodCode })}`),
    periodCode ? api.get(`/api/payments${qs({ status: 'PENDING' })}`) : Promise.resolve(null),
  ]);
  return {
    pendingCount: pending.summary.pendingCount,
    pendingAmount: pending.summary.pendingAmount,
    receivedTotal: received.summary.total,
    receivedCount: received.summary.count,
    pendingAllCount: pendingAll ? pendingAll.summary.pendingCount : pending.summary.pendingCount,
    pendingAllAmount: pendingAll ? pendingAll.summary.pendingAmount : pending.summary.pendingAmount,
  };
}

/** หน้าต่างตรวจสลิปหนึ่งใบ — ดูหลักฐาน เทียบยอด แล้วกดรับ/ปฏิเสธ */
/**
 * ตรวจสลิปทีละใบต่อเนื่อง — สลิปอยู่คู่กับยอดในหน้าเดียว ยืนยัน/ปฏิเสธจบในหน้าต่างนี้
 * แล้วเปิดใบถัดไปในคิวเอง (เดิม 5 คลิกต่อใบ: เปิด → แท็บใหม่ดูสลิป → กลับ → ยืนยัน → ยืนยันซ้ำ)
 *
 * queue = สลิปรอตรวจที่เห็นในตารางตอนนี้ ไล่ตามลำดับนั้น
 */
function reviewModal(first, queue = [first]) {
  const pendingQueue = queue.filter((r) => r.status === 'PENDING');
  let index = Math.max(0, pendingQueue.findIndex((r) => r.id === first.id));
  let changed = false;
  let current = first;

  const modal = infoModal({
    title: 'ตรวจสอบการชำระ',
    width: 860,
    content: null,
    // ปิดหน้าต่างเมื่อไหร่ ตารางข้างหลังต้องอัปเดตตามที่ทำไป
    onClose: () => { if (changed) render(); },
  });
  const titleNode = modal.body.parentElement.querySelector('h2');

  const next = () => {
    const rest = pendingQueue.filter((r, i) => i > index && !r.done);
    if (!rest.length) {
      toast('ตรวจครบทุกใบในคิวแล้ว ✓', 'success');
      modal.close();
      return;
    }
    index = pendingQueue.indexOf(rest[0]);
    show(rest[0]);
  };

  async function show(row) {
    current = row;
    titleNode.textContent = `ตรวจสอบการชำระ — ${row.invoiceNo}`;
    modal.body.replaceChildren(el('div', { class: 'loading' }, 'กำลังโหลด…'));
    const inv = await api.get(`/api/invoices/${row.invoiceId}`);
    if (current !== row) return; // กดข้ามไปใบอื่นระหว่างโหลด

    const isPdf = /\.pdf(\?|$)/i.test(row.slipUrl ?? ''); // ลิงก์มีลายเซ็นต่อท้าย (?exp=…)
    const diff = Number((inv.outstanding - row.amount).toFixed(2));
    const match = row.status !== 'PENDING' ? ''
      : diff === 0
        ? el('div', { class: 'badge green' }, '✓ ตรงกับยอดค้างพอดี')
        : diff > 0
          ? el('div', { class: 'badge amber' }, `จ่ายบางส่วน — จะเหลือค้าง ${money(diff)} ฿`)
          : el('div', { class: 'badge red' }, `เกินยอดค้าง ${money(-diff)} ฿`);

    const slipPane = row.slipUrl
      ? (isPdf
        ? el('a', { href: row.slipUrl, target: '_blank', rel: 'noreferrer', class: 'btn ghost' }, '🧾 เปิดสลิป (PDF)')
        : el('a', { href: row.slipUrl, target: '_blank', rel: 'noreferrer', title: 'กดเพื่อดูขนาดเต็ม' },
          el('img', { src: row.slipUrl, alt: `สลิปของ ${row.franchiseUsername}`, class: 'slip-review-img' })))
      : el('div', { class: 'empty' }, 'ร้านไม่ได้แนบสลิป');

    const note = el('input', { type: 'text', placeholder: 'หมายเหตุ เช่น ตรงกับรายการเดินบัญชี 15 ก.ย. 14:32 (ไม่บังคับ)' });
    const reason = el('input', { type: 'text', placeholder: 'เหตุผล เช่น หาเงินเข้าไม่เจอ / สลิปไม่ชัด' });
    const errorBox = el('div', { class: 'error-box', hidden: true });
    const approve = el('button', { class: 'btn' }, `✓ ยืนยันรับเงิน ${money(row.amount)} ฿`);
    const reject = el('button', { class: 'btn ghost danger' }, '✕ ปฏิเสธ');
    const skip = el('button', { class: 'btn ghost' }, 'ข้าม →');

    const act = async (button, run) => {
      errorBox.hidden = true;
      button.disabled = true;
      try {
        await run();
        row.done = true;
        changed = true;
        next();
      } catch (err) {
        errorBox.textContent = err.fullMessage ?? err.message;
        errorBox.hidden = false;
        button.disabled = false;
      }
    };
    approve.addEventListener('click', () => act(approve, async () => {
      await api.post(`/api/payments/${row.id}/approve`, note.value.trim() ? { note: note.value.trim() } : {});
      toast(`รับเงิน ${row.franchiseUsername} ${money(row.amount)} ฿ แล้ว`, 'success');
    }));
    reject.addEventListener('click', () => {
      // ต้องมีเหตุผล — ร้านจะเห็นข้อความนี้บนแถบแดง
      if (!reason.value.trim()) {
        errorBox.textContent = 'ใส่เหตุผลที่ปฏิเสธก่อน — ร้านจะเห็นข้อความนี้';
        errorBox.hidden = false;
        reason.focus();
        return undefined;
      }
      return act(reject, async () => {
        await api.post(`/api/payments/${row.id}/reject`, { reason: reason.value.trim() });
        toast('ปฏิเสธแล้ว ร้านจะเห็นเหตุผล', 'success');
      });
    });
    skip.addEventListener('click', () => { row.done = true; next(); });

    const position = pendingQueue.length > 1 && row.status === 'PENDING'
      ? el('span', { class: 'sub-line' }, `ใบที่ ${index + 1} จาก ${pendingQueue.length} ในคิว`)
      : '';

    modal.body.replaceChildren(
      el('div', { class: 'slip-review' },
        el('div', { class: 'slip-review-pane' }, slipPane),
        el('div', {},
          el('div', { class: 'stat-grid', style: 'grid-template-columns:repeat(2,minmax(0,1fr))' },
            stat('ร้านแจ้งมา', money(row.amount) + ' ฿',
              `โอน ${dateTh(row.paidAt)}${row.paidTime ? ` ${row.paidTime} น.` : ''}`, { tone: 'sales', icon: '🏦' }),
            stat('ยอดค้างบิลนี้', money(inv.outstanding) + ' ฿', row.franchiseUsername, { tone: 'due', icon: '⏳' })),
          match,
          el('div', { class: 'sub-line mt-8' },
            `แจ้งโดย ${row.submittedBy ?? '—'} · ช่องทาง ${row.method ?? '—'}${row.reference ? ` · อ้างอิง ${row.reference}` : ''}`),
          row.note ? el('div', { class: 'sub-line' }, `หมายเหตุร้าน: ${row.note}`) : '',
          row.status === 'PENDING'
            ? el('div', { class: 'review-actions' },
              errorBox,
              note,
              el('div', { class: 'btn-row' }, approve, position),
              el('div', { class: 'review-reject' }, reason, reject),
              pendingQueue.length > 1 ? el('div', { class: 'btn-row', style: 'justify-content:flex-end' }, skip) : '')
            : el('div', { class: 'mt-12' }, slipBadge(row.status),
              row.rejectReason ? el('div', { class: 'sub-line' }, `เหตุผล: ${row.rejectReason}`) : '',
              row.reviewNote ? el('div', { class: 'sub-line' }, row.reviewNote) : ''))),
      el('details', { class: 'mt-14' },
        el('summary', {}, 'รายการในใบเรียกเก็บ'),
        breakdownTable(inv)));
    if (row.status === 'PENDING') note.focus();
  }

  show(first);
}

/** แท็บ "สลิปรอตรวจ" — คิวงานของส่วนกลาง */
/** ช่องเลือกสถานะของสลิป — หน้าที่เรียกเอาไปวางรวมแถวเดียวกับตัวกรองรอบบิล */
export function slipStatusPicker() {
  const statusFilter = viewState.getItem(STATUS_KEY) ?? 'PENDING';
  return el('select', {
    onchange: (e) => { viewState.setItem(STATUS_KEY, e.target.value); render(); },
  }, ...[
    { value: 'PENDING', label: 'รอตรวจสอบ' },
    { value: 'APPROVED', label: 'ยืนยันแล้ว' },
    { value: 'REJECTED', label: 'ปฏิเสธ' },
    { value: 'CANCELLED', label: 'ร้านยกเลิก' },
    { value: '', label: 'ทั้งหมด' },
  ].map((o) => el('option', { value: o.value, selected: o.value === statusFilter }, o.label)));
}

export async function slipReviewTab(periodCode = '') {
  const statusFilter = viewState.getItem(STATUS_KEY) ?? 'PENDING';
  const res = await api.get(`/api/payments${qs({ status: statusFilter, periodCode })}`);
  const inPeriod = periodCode ? ` ในรอบ ${periodLabel(periodCode)}` : '';

  const pendingRows = res.items.filter((r) => r.status === 'PENDING');

  return el('div', {},
    pendingRows.length > 1
      ? el('div', { class: 'btn-row', style: 'margin-bottom:10px' },
        el('button', { class: 'btn', onclick: () => reviewModal(pendingRows[0], pendingRows) },
          `▶ ตรวจต่อเนื่อง ${int(pendingRows.length)} ใบ`))
      : '',
    card(null, table([
      { label: 'วันที่แจ้ง', render: (r) => dateTh(r.createdAt) },
      { label: 'ร้านค้า', render: (r) => avatar(r.franchiseUsername, { sub: '' }), sortValue: (r) => r.franchiseUsername },
      { label: 'ใบเรียกเก็บ', render: (r) => el('div', {}, r.invoiceNo, el('div', { class: 'sub-line' }, periodLabel(r.periodCode))) },
      { label: 'แจ้งมา', num: true, render: (r) => el('strong', {}, money(r.amount)) },
      { label: 'ยอดค้างบิลนี้', num: true, render: (r) => money(r.invoiceOutstanding) },
      { label: 'วันที่โอน', render: (r) => el('div', {}, dateTh(r.paidAt), r.paidTime ? el('div', { class: 'sub-line' }, `${r.paidTime} น.`) : '') },
      { label: 'ช่องทาง', render: (r) => r.method ?? el('span', { class: 'muted' }, '—') },
      { label: 'สลิป', render: (r) => (r.slipUrl ? el('a', { href: r.slipUrl, target: '_blank', rel: 'noreferrer' }, 'เปิดดู') : el('span', { class: 'muted' }, '—')) },
      {
        label: 'สถานะ',
        render: (r) => el('div', {},
          slipBadge(r.status),
          r.rejectReason ? el('div', { class: 'sub-line' }, r.rejectReason) : '',
          r.reviewNote ? el('div', { class: 'sub-line' }, r.reviewNote) : ''),
      },
      {
        label: '',
        render: (r) => el('button', {
          class: `btn sm ${r.status === 'PENDING' ? '' : 'ghost'}`,
          onclick: () => reviewModal(r, pendingRows),
        }, r.status === 'PENDING' ? 'ตรวจสอบ' : 'ดู'),
      },
    ], res.items, {
      // ติดคีย์เป็น invoiceId เพื่อให้กระโดดมาหาสลิปของบิลใบที่กดมาได้
      rowKey: (r) => `inv-${r.invoiceId}`,
      search: 'ค้นหาร้านหรือเลขที่บิล…',
      empty: statusFilter === 'PENDING' ? `ไม่มีสลิปรอตรวจสอบ${inPeriod} ✓` : `ไม่มีรายการ${inPeriod}`,
    }), { tight: true }));
}

/** แท็บ "เงินเข้าแล้ว" — เงินที่ตัดยอดไปแล้วจริง */
export async function receivedMoneyTab(periodCode = '') {
  const received = await api.get(`/api/payments/received${qs({ periodCode })}`);

  return card(null, table([
    { label: 'วันที่ได้รับ', render: (r) => dateTh(r.paidAt), sortValue: (r) => r.paidAt },
    { label: 'ร้านค้า', render: (r) => avatar(r.franchiseUsername, { sub: '' }), sortValue: (r) => r.franchiseUsername },
    { label: 'ใบเรียกเก็บ', render: (r) => el('div', {}, r.invoiceNo, el('div', { class: 'sub-line' }, periodLabel(r.periodCode))) },
    { label: 'จำนวนที่ได้รับ', num: true, render: (r) => el('strong', { class: 'text-success' }, money(r.amount)) },
    { label: 'ช่องทาง', render: (r) => r.method ?? '—' },
    { label: 'บันทึกโดย', render: (r) => el('span', { class: 'muted' }, r.recordedBy ?? '—') },
  ], received.items, {
    search: 'ค้นหาร้านหรือเลขที่บิล…',
    empty: periodCode ? `ยังไม่มีเงินเข้าในรอบ ${periodLabel(periodCode)}` : 'ยังไม่มีเงินเข้า',
    footer: received.items.length ? ['', '', 'รวมที่ได้รับ', money(received.summary.total), '', ''] : undefined,
  }), { tight: true });
}

/**
 * บรรทัดยอดที่แปลงเป็นดอลลาร์ — โชว์เฉพาะบิลที่ตรึงอัตราไว้ตอนออก
 * ยอดจริงที่ระบบใช้คิดยังเป็นบาทเสมอ บรรทัดนี้มีไว้ให้ร้านต่างชาติเทียบเท่านั้น
 */
/** จัดรูปยอดตามสกุลของบิล — ใช้ทุกที่ที่ต้องโชว์ "ต้องจ่ายเท่าไร" */
export const payMoney = (inv, amount) => (inv?.isUsd ? `$${money(amount)}` : `${money(amount)} ฿`);

/**
 * ป้ายบอกสกุลของบิล — โผล่เฉพาะบิลดอลลาร์
 * บิลบาทไม่ต้องติดป้าย เพราะเป็นค่าปกติของระบบอยู่แล้ว
 */
export function currencyTag(inv) {
  if (!inv?.isUsd) return '';
  return el('span', { class: 'badge blue', title: `อัตรา ${money(inv.usdRate)} บาท/ดอลลาร์ ณ วันที่ออกบิล` }, 'USD');
}

export function usdLine(inv, { amountUsd = inv?.netTotalUsd } = {}) {
  if (!inv?.usdRate || amountUsd === null || amountUsd === undefined) return '';
  return el('div', { class: 'usd-line' },
    el('strong', {}, `≈ $${money(amountUsd)}`),
    el('span', { class: 'sub-line' }, ` · อัตรา ${money(inv.usdRate)} ฿/USD ณ วันที่ออกบิล`));
}

/**
 * กล่องบอกบัญชีปลายทางของบิลใบหนึ่ง
 *
 * ใช้ร่วมกันทั้งในใบเรียกเก็บและในฟอร์มแจ้งชำระ จะได้ไม่มีที่ไหนแสดงเลขบัญชีคนละแบบ
 * ข้อมูลมาจากบัญชีที่ตรึงไว้กับบิล ไม่ใช่บัญชีหลักปัจจุบัน — บิลเก่าต้องโอนเข้าที่เดิมเสมอ
 */
export function bankAccountBox(bankAccount, { compact = false } = {}) {
  if (!bankAccount) {
    return el('div', { class: 'alert-box m-0' },
      'บิลใบนี้ยังไม่ได้ระบุบัญชีปลายทาง — สอบถามเลขบัญชีก่อนโอน');
  }
  return el('div', { class: 'notice-box bank-box m-0' },
    `🏦 โอนเข้าบัญชี ${bankAccount.bankName}`,
    // ปุ่มคัดลอกเป็นไอคอนติดเลขบัญชี — กดตรงที่ตาดูอยู่ ไม่ต้องหาปุ่มใหญ่อีกบรรทัด
    el('div', { class: 'bank-number', style: compact ? '' : 'font-size:19px' },
      el('strong', {}, bankAccount.accountNumber),
      copyButton(bankAccount.accountNumber, 'คัดลอกเลขบัญชี', { iconOnly: true })),
    el('div', { class: 'sub-line' },
      `${bankAccount.accountName}${bankAccount.branch ? ` · สาขา ${bankAccount.branch}` : ''}`),
    // บอกสกุลที่บัญชีนี้รับ ร้านจะได้รู้ว่าโอนเข้าถูกใบ (บัญชีบาทกับบัญชีดอลลาร์เป็นคนละเลข)
    el('div', { class: 'sub-line' },
      `รับเป็น${bankAccount.currency === 'USD' ? 'ดอลลาร์ (USD)' : 'เงินบาท (THB)'}`),
    /*
     * มี QR ก็โชว์ให้สแกนเลย — ร้านโอนจากมือถือเป็นหลัก
     * สแกนไม่มีทางพิมพ์เลขผิด ซึ่งผิดทีเงินไปเข้าบัญชีคนอื่นแล้วตามคืนยาก
     * ในโหมด compact (อยู่ในตาราง/การ์ดเล็ก) ไม่ใส่ เพราะกินที่จนอ่านเลขบัญชีไม่ออก
     */
    compact
      ? ''
      : (bankAccount.qrUrl
        ? el('div', {},
          el('a', { href: bankAccount.qrUrl, target: '_blank', rel: 'noopener', class: 'qr-link' },
            el('img', { src: bankAccount.qrUrl, alt: 'QR สำหรับสแกนโอน', class: 'qr-pay' })),
          /*
           * โอนจากมือถือเครื่องเดียวกัน สแกนจอตัวเองไม่ได้ — ต้องบันทึกรูปแล้วเปิดในแอปธนาคาร
           * (ทุกแอปธนาคารมีปุ่ม "สแกนจากรูปภาพ")
           */
          el('div', { class: 'btn-row', style: 'justify-content:center;margin-top:6px' },
            el('a', {
              class: 'btn ghost sm',
              href: bankAccount.qrUrl,
              download: `QR-${bankAccount.bankName}-${bankAccount.accountNumber}`,
            }, '💾 บันทึกรูป QR')),
          el('div', { class: 'sub-line' }, 'โอนจากมือถือเครื่องนี้: บันทึกรูปแล้วเลือก "สแกนจากรูปภาพ" ในแอปธนาคาร'))
        // บอกไว้ด้วยว่าไม่มี ไม่ใช่หายไปเฉย ๆ — ส่วนกลางจะได้รู้ว่าควรไปแนบ และร้านจะได้ไม่รอ QR ที่ไม่มีวันมา
        : el('div', { class: 'sub-line mt-8' },
          'บัญชีนี้ยังไม่ได้แนบ QR — ต้องพิมพ์เลขบัญชีเอง')),
    // บิลเก่าที่ออกก่อนบัญชีมีสกุล อาจชี้บัญชีคนละสกุลกับบิล — บอกไว้ดีกว่าให้ร้านโอนแล้วเด้ง
    bankAccount.currencyMatches === false
      ? el('div', { class: 'sub-line', style: 'margin-top:6px;font-weight:700' },
        '⚠ บัญชีนี้คนละสกุลกับบิล — สอบถามทางเราก่อนโอน')
      : '');
}

/** ตารางแจกแจงยอดในบิล: ส่วนต่าง + ค่าใช้จ่าย − ส่วนลด = ยอดที่ต้องจ่าย */
export function breakdownTable(inv) {
  const rows = [
    { label: 'ส่วนต่างจากยอดเต็ม', detail: `จากยอดขายเต็ม ${money(inv.grossTotal)} ฿`, amount: inv.commissionTotal },
    ...inv.adjustments.map((a) => ({
      label: a.label,
      detail: a.pct !== null ? `${a.kindLabel} ${a.pct}% ของส่วนต่าง` : a.kindLabel,
      amount: a.signedAmount,
    })),
    /*
     * ยอดที่เราเคยติดค้างร้านจากรอบก่อน (ร้านคืนของมากกว่าขาย) ถูกหักออกจากใบนี้
     * ต้องโชว์เป็นบรรทัดของมันเอง ไม่ใช่ปล่อยให้ยอดท้ายบิลลดลงเฉย ๆ
     * ไม่งั้นร้านบวกเลขตามไม่ได้แล้วคิดว่าคิดเงินผิด
     */
    ...(inv.creditApplied > 0
      ? [{
        label: 'หักยอดยกมาจากรอบก่อน',
        detail: 'ยอดที่ทางเราติดค้างร้านไว้ จากรอบที่ร้านคืนของมากกว่าขาย',
        amount: -inv.creditApplied,
      }]
      : []),
  ];

  return el('div', {},
    table([
      { label: 'รายการ', render: (r) => el('div', {}, r.label, el('div', { class: 'sub-line' }, r.detail)) },
      { label: 'จำนวน', num: true, render: (r) => (r.amount < 0 ? `−${money(Math.abs(r.amount))}` : money(r.amount)) },
    ], rows, {
      footer: ['ยอดที่ต้องจ่าย', money(inv.netTotal)],
    }),
    el('div', { class: 'sub-line', style: 'padding:10px 14px' },
      `ชำระแล้ว ${money(inv.paid)} ฿ · คงเหลือ ${money(inv.outstanding)} ฿`));
}
