import { api } from '../api.js';
import { alertBanner, badge, card, confirmAction, copyButton, dateTh, el, formModal, infoModal, int, stat, table, toast } from '../ui.js';
import { elevated } from '../elevation.js';
import { render } from '../app.js';
import { activityButton } from './activity.js';

const digits = (value) => String(value ?? '').replace(/[\s-]/g, '');

/*
 * บัญชีรับเงิน USD = กระเป๋าคริปโต (ที่อยู่กระเป๋า + เครือข่าย + QR) ไม่ใช่บัญชีธนาคาร — เจ้าของระบบสั่ง 29 ก.ย. 69
 * เซิร์ฟเวอร์เก็บเครือข่ายไว้ที่ bankName ด้วย (ทุกที่ที่พิมพ์ "ธนาคาร" จะเห็นเครือข่ายแทน) และเลขบัญชี = ที่อยู่กระเป๋า
 * จึงอ่านจาก chain/isWallet ก่อน แล้วค่อยถอยไปใช้ bankName/currency — เซิร์ฟเวอร์รุ่นที่ยังไม่ส่งสองช่องนี้ก็ยังโชว์ถูก
 */
const isWallet = (r) => r?.isWallet ?? r?.currency === 'USD';
const chainOf = (r) => r?.chain ?? r?.bankName ?? '';

/** ที่อยู่กระเป๋ายาว 34–64+ ตัว — ในตาราง/ข้อความยืนยันย่อเหลือหัวท้าย (ของเต็มอยู่ในปุ่มคัดลอกและหน้าต่างแก้ไข) */
const shortAddress = (address) => {
  const s = String(address ?? '');
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
};

/** ชื่อบัญชีแบบสั้นสำหรับข้อความยืนยัน */
const nameOf = (r) => (isWallet(r) ? `กระเป๋า USD · ${chainOf(r)} · ${shortAddress(r.accountNumber)}` : `${r.bankName} ${r.accountNumber}`);

/*
 * กติกาเดียวกับเซิร์ฟเวอร์ (BankAccountService) — เช็กก่อนให้กดบันทึก จะได้ไม่อัปโหลด QR ทิ้งแล้วค่อยโดนตีกลับ
 * ที่อยู่กระเป๋าห้ามมีช่องว่าง: คัดลอกมาแล้วมีเว้นวรรคติดมา = ร้านคัดลอกต่อไปก็ผิดทั้งชุด
 */
const CHAIN_RE = /^[A-Za-z0-9][A-Za-z0-9 ()._-]{1,31}$/;
const WALLET_RE = /^[A-Za-z0-9:_.-]{10,128}$/;
const CHAIN_SUGGESTIONS = ['TRC20', 'ERC20', 'BEP20', 'Polygon', 'Solana', 'TON', 'Arbitrum'];
// ป้ายที่ใช้หาช่องใน DOM หลังโมดัลเปิด (formModal ไม่มี datalist/ฟอนต์รายช่องให้ตั้ง)
const CHAIN_PLACEHOLDER = 'เช่น TRC20';
const WALLET_PLACEHOLDER = 'วางที่อยู่กระเป๋าทั้งชุด';

/**
 * บัญชีสำหรับรับเงินจากร้านค้า — บัญชีธนาคารไทย (บาท) หรือกระเป๋าคริปโต (USD)
 *
 * มีได้หลายบัญชี แล้วเลือกตอนออกบิลว่าใบนั้นให้โอนเข้าอันไหน
 * "บัญชีหลัก" คือตัวที่ถูกเลือกให้อัตโนมัติ — มีได้ทีละใบเดียว
 */
export async function bankAccountsView() {
  const [res, tg] = await Promise.all([
    api.get('/api/bank-accounts'),
    api.get('/api/settings/telegram').catch(() => null),
  ]);

  /** แก้ครั้งนี้เปลี่ยนปลายทางเงินไหม (ต้องใส่รหัส 6 หลัก) — เทียบตามชนิดบัญชีของค่าที่จะบันทึก */
  const routingChanged = (row, v) => {
    const currency = v.currency ?? 'THB';
    if (v.qrFile || currency !== row.currency) return true;
    if (currency === 'USD') {
      return (v.chain ?? '') !== chainOf(row) || (v.walletAddress ?? '') !== row.accountNumber;
    }
    return (v.bankName ?? '') !== row.bankName
      || (v.accountName ?? '') !== row.accountName
      || digits(v.accountNumber) !== row.accountNumber;
  };

  const accountForm = (row = null) => {
    // เติมค่าเดิมเฉพาะช่องของชนิดเดียวกัน — กระเป๋าเดิมถูกสลับเป็นบาท ช่อง "ธนาคาร" ต้องว่าง ไม่ใช่ขึ้นชื่อเครือข่าย
    const thb = row && !isWallet(row) ? row : null;
    const wallet = row && isWallet(row) ? row : null;
    const isUsd = (v) => v.currency === 'USD';
    const isThb = (v) => v.currency !== 'USD';

    /*
     * QR ที่อัปโหลดแล้ว — กดบันทึกแล้วเซิร์ฟเวอร์ตีกลับ (เช่นเลขซ้ำ) แก้แล้วกดใหม่ ไม่ต้องอัปโหลดซ้ำ
     * (โควตาอัปโหลดต่อชั่วโมงไม่คืนเมื่อบันทึกไม่สำเร็จ)
     */
    let uploaded = null;

    const form = formModal({
      title: row ? `แก้ไขบัญชี — ${isWallet(row) ? `กระเป๋า USD · ${chainOf(row)}` : row.bankName}` : 'เพิ่มบัญชีรับเงิน',
      submitLabel: row ? 'บันทึกการแก้ไข' : 'เพิ่มบัญชี',
      fields: [
        /*
         * เลือกสกุลก่อน เพราะสองสกุลกรอกคนละอย่าง: บาท = บัญชีธนาคารไทย · USD = กระเป๋าคริปโต (ไม่มีธนาคาร/ชื่อบัญชี/สาขา)
         * บัญชีหนึ่งใบรับได้สกุลเดียว และแก้ไม่ได้เมื่อผูกบิลแล้ว — บิลเก่าตรึงบัญชีใบนี้ไว้ สกุลเปลี่ยนทีหลังจะย้อนไปทำให้บิลผิด
         */
        {
          name: 'currency',
          label: 'สกุลเงินที่รับ',
          type: 'select',
          value: row?.currency ?? 'THB',
          disabled: Boolean(row?.invoiceCount),
          options: [
            { value: 'THB', label: 'บาท (บัญชีธนาคารไทย)' },
            { value: 'USD', label: 'ดอลลาร์ USD (กระเป๋าคริปโต)' },
          ],
          hint: row?.invoiceCount
            ? `ผูกกับบิลแล้ว ${int(row.invoiceCount)} ใบ เปลี่ยนสกุลไม่ได้ — ถ้าต้องการอีกสกุลให้เพิ่มบัญชีใหม่`
            : 'บิลสกุลไหนต้องโอนเข้าบัญชีที่รับสกุลนั้น',
        },
        // ── บัญชีธนาคารไทย ──
        { name: 'bankName', label: 'ธนาคาร', required: true, value: thb?.bankName ?? '', placeholder: 'เช่น กสิกรไทย', showWhen: isThb },
        { name: 'accountName', label: 'ชื่อบัญชี', required: true, value: thb?.accountName ?? '', placeholder: 'ชื่อที่ปรากฏในสมุดบัญชี', showWhen: isThb },
        {
          name: 'accountNumber',
          label: 'เลขที่บัญชี',
          required: true,
          value: thb?.accountNumber ?? '',
          placeholder: '1234567890',
          hint: 'ใส่ขีดหรือเว้นวรรคได้ ระบบจะตัดให้เอง',
          showWhen: isThb,
        },
        { name: 'branch', label: 'สาขา', value: thb?.branch ?? '', showWhen: isThb },
        // ── กระเป๋า USD — กรอกแค่เครือข่าย + ที่อยู่ (+ QR ด้านล่าง) ──
        {
          name: 'chain',
          label: 'เครือข่าย (chain)',
          required: true,
          value: wallet ? chainOf(wallet) : '',
          placeholder: CHAIN_PLACEHOLDER,
          hint: 'ต้องตรงกับเครือข่ายของกระเป๋าจริง — เลือกจากรายการหรือพิมพ์เอง',
          showWhen: isUsd,
        },
        {
          name: 'walletAddress',
          label: 'ที่อยู่กระเป๋า (Wallet address)',
          required: true,
          value: wallet?.accountNumber ?? '',
          placeholder: WALLET_PLACEHOLDER,
          hint: 'คัดลอกจากแอปกระเป๋ามาวางทั้งชุด ห้ามพิมพ์เอง · ห้ามมีช่องว่าง',
          showWhen: isUsd,
        },
        /*
         * QR ที่ธนาคาร/แอปกระเป๋าออกให้ — แนบเป็นไฟล์ ไม่ได้สร้างเองจากเลขบัญชี
         * payload ที่ประกอบผิดแม้แต่ตัวเดียว = เงินวิ่งไปบัญชีคนอื่น เอารูปที่ต้นทางออกให้มาแนบปลอดภัยกว่า
         */
        {
          name: 'qrFile',
          label: (v) => (row?.qrUrl ? 'เปลี่ยนรูป QR' : (isUsd(v) ? 'รูป QR ของกระเป๋า' : 'รูป QR สำหรับสแกนโอน')),
          type: 'file',
          accept: 'image/*',
          hint: row?.qrUrl
            ? 'มี QR อยู่แล้ว — เลือกไฟล์ใหม่เพื่อแทนที่ หรือเว้นว่างไว้เพื่อใช้อันเดิม'
            : 'ไม่ใส่ก็ได้ — ใส่แล้วร้านจะสแกนจ่ายได้เลย ไม่ต้องพิมพ์เลขเอง',
        },
        { name: 'note', label: 'หมายเหตุ', value: row?.note ?? '', placeholder: 'เช่น ใช้กับร้านภาคเหนือ' },
        // บัญชีหลักของบัญชีที่มีอยู่แล้วใช้ปุ่ม "⭐ ตั้งเป็นหลัก" ที่แถว (ต้องใส่รหัสแยกเป็นเรื่องของมัน)
        row ? null : {
          name: 'makeDefault',
          label: 'บัญชีหลัก',
          type: 'checklist',
          options: [{ value: 'yes', label: 'ตั้งเป็นบัญชีหลัก', hint: 'บิลที่ออกใหม่สกุลนี้จะเลือกบัญชีนี้ให้อัตโนมัติ — มีบัญชีหลักได้ทีละบัญชี' }],
        },
      ].filter(Boolean),

      preview: (v) => {
        const qrLine = el('div', { class: 'sub-line mt-4' },
          v.qrFile ? '📷 จะแนบ QR ใหม่ให้บัญชีนี้'
            : (row?.qrUrl ? '📷 ใช้ QR เดิม' : `ยังไม่มี QR — ร้านต้อง${isUsd(v) ? 'คัดลอกที่อยู่กระเป๋า' : 'พิมพ์เลขบัญชี'}เอง`));
        /*
         * ระบบไม่ส่งเลขบัญชีใหม่ให้ร้านเอง (ตั้งใจ) — ร้านจะเห็นบนเว็บว่าไม่ตรงกับ Telegram แล้วไม่โอน
         * จนกว่าส่วนกลางตรวจแล้วกดส่งเอง บอกไว้ตั้งแต่ก่อนบันทึก จะได้ไม่งงว่าทำไมร้านไม่โอน
         */
        const openBillsLine = row?.openInvoiceCount > 0 && routingChanged(row, v)
          ? el('div', { class: 'sub-line mt-4', style: 'font-weight:700' },
            `⚠ มีบิลค้าง ${int(row.openInvoiceCount)} ใบชี้บัญชีนี้ — ร้านจะเห็นว่าบัญชีไม่ตรงกับ Telegram และจะไม่โอน `
            + 'จนกว่าคุณจะกด "📨 ส่งเลขบัญชีให้ร้านที่มีบิลค้าง"')
          : '';

        if (!isUsd(v)) {
          return el('div', { class: 'notice-box m-0' },
            'ร้านค้าจะเห็นบัญชีนี้บนบิลสกุลบาทที่ถูกออกให้ ',
            el('div', { class: 'sub-line mt-4' },
              `${v.bankName || 'ธนาคาร'} · ${v.accountNumber || 'เลขที่บัญชี'} (${v.accountName || 'ชื่อบัญชี'})`),
            qrLine,
            openBillsLine);
        }

        const node = el('div', { class: 'notice-box m-0' },
          'ร้านค้าจะเห็นกระเป๋านี้บนบิลสกุลดอลลาร์ที่ถูกออกให้',
          el('div', { class: 'sub-line mt-4' }, 'เครือข่าย (Chain): ', el('strong', {}, v.chain || '—')),
          el('div', { class: 'sub-line mt-4' }, 'ที่อยู่กระเป๋า: ',
            el('span', { class: 'wallet-address', style: 'overflow-wrap:anywhere' }, v.walletAddress || '—')),
          // เงินคริปโตโอนผิดเครือข่ายแล้วตามคืนไม่ได้ ต่างจากโอนผิดธนาคาร — เตือนคนกรอกตั้งแต่ตรงนี้
          el('div', { class: 'sub-line mt-4', style: 'font-weight:700' },
            '⚠ โอนผิดเครือข่าย (chain) เงินจะสูญหายและกู้คืนไม่ได้ — ตรวจเครือข่ายและที่อยู่ให้ตรงกับกระเป๋าจริงทุกตัวอักษรก่อนบันทึก'),
          qrLine,
          openBillsLine);
        const problems = [
          v.chain && !CHAIN_RE.test(v.chain)
            ? 'เครือข่าย (chain) ใช้ได้แค่ตัวอักษรอังกฤษ ตัวเลข เว้นวรรค ( ) . _ - ยาว 2–32 ตัว เช่น TRC20' : '',
          v.walletAddress && !WALLET_RE.test(v.walletAddress)
            ? 'ที่อยู่กระเป๋า (wallet address) ไม่ถูกต้อง — คัดลอกมาทั้งชุด ห้ามมีช่องว่าง (ยาว 10–128 ตัว)' : '',
        ].filter(Boolean);
        return problems.length
          ? { canSubmit: false, node: el('div', {}, node, el('div', { class: 'error-box m-0 mt-8' }, ...problems.map((p) => el('div', {}, p)))) }
          : node;
      },

      onSubmit: async (v) => {
        const usd = isUsd(v);
        /*
         * ส่งเฉพาะช่องของชนิดบัญชีนั้น — ช่องของอีกชนิดถูกซ่อนอยู่ (formModal ตัดทิ้งให้แล้ว)
         * กระเป๋า: ที่อยู่ส่งไปในช่อง accountNumber · ธนาคาร/ชื่อบัญชี/สาขา เซิร์ฟเวอร์ตั้งเองจากเครือข่าย
         */
        const body = { currency: v.currency ?? 'THB' };
        if (usd) {
          body.chain = v.chain;
          body.accountNumber = v.walletAddress;
        } else {
          body.bankName = v.bankName;
          body.accountName = v.accountName;
          body.accountNumber = v.accountNumber;
          if (v.branch !== undefined) body.branch = v.branch;
        }
        if (v.note !== undefined) body.note = v.note;
        if (!row && v.makeDefault?.length) body.isDefault = true;
        // อัปโหลดก่อนแล้วค่อยส่ง URL ไปกับข้อมูลบัญชี — เซิร์ฟเวอร์รับเฉพาะไฟล์ที่ผ่าน /api/uploads
        if (v.qrFile) {
          if (uploaded?.file !== v.qrFile) uploaded = { file: v.qrFile, url: (await api.upload(v.qrFile)).url };
          body.qrUrl = uploaded.url;
        }

        // แก้แค่สาขา/หมายเหตุไม่ต้องยืนยัน — ตรงกับกติกาฝั่งเซิร์ฟเวอร์
        const routing = !row || routingChanged(row, v);
        if (row && !routing) await api.patch(`/api/bank-accounts/${row.id}`, body);
        else if (row) await elevated((opts) => api.patch(`/api/bank-accounts/${row.id}`, body, opts));
        else await elevated((opts) => api.post('/api/bank-accounts', body, opts));
        toast(row && routing && row.openInvoiceCount > 0
          ? `บันทึกแล้ว — ร้านที่มีบิลค้าง ${int(row.openInvoiceCount)} ใบยังไม่ได้รับ${usd ? 'ที่อยู่กระเป๋า' : 'เลข'}ใหม่ ตรวจแล้วกด "📨 ส่งเลขบัญชีให้ร้านที่มีบิลค้าง"`
          : (row ? 'บันทึกแล้ว' : 'เพิ่มบัญชีแล้ว'), 'success');
        render();
      },
    });

    /*
     * formModal ไม่มีช่องแบบมีรายการแนะนำหรือฟอนต์รายช่อง — ตกแต่งหลังโมดัลขึ้นจอ (โมดัลล่าสุดคืออันนี้เสมอ)
     * ช่องที่อยู่ใช้ฟอนต์ความกว้างเท่ากัน และปิดแก้คำอัตโนมัติ/ตัวพิมพ์ใหญ่อัตโนมัติของมือถือ
     * (คีย์บอร์ดมือถือแก้ตัวอักษรในที่อยู่ให้เงียบ ๆ = ที่อยู่ผิดทั้งชุด)
     */
    const modal = [...document.querySelectorAll('.modal-backdrop')].pop();
    const chainInput = modal?.querySelector(`input[placeholder="${CHAIN_PLACEHOLDER}"]`);
    const walletInput = modal?.querySelector(`input[placeholder="${WALLET_PLACEHOLDER}"]`);
    if (chainInput) {
      const list = el('datalist', { id: `chain-options-${Date.now()}` },
        ...CHAIN_SUGGESTIONS.map((c) => el('option', { value: c })));
      chainInput.setAttribute('list', list.id);
      chainInput.setAttribute('autocomplete', 'off');
      chainInput.after(list);
    }
    if (walletInput) {
      walletInput.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
      for (const [key, value] of [['autocomplete', 'off'], ['autocapitalize', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false']]) {
        walletInput.setAttribute(key, value);
      }
    }
    return form;
  };

  /**
   * ส่งเลขบัญชีนี้ให้ทุกร้านที่มีบิลค้างชี้บัญชีนี้อยู่ ทาง Telegram
   *
   * ตั้งใจให้เป็นปุ่มที่คนกดเอง ไม่ส่งอัตโนมัติตอนแก้บัญชี — ข้อความ Telegram คือหลักฐานที่ร้านใช้เทียบก่อนโอน
   * ถ้าระบบส่งเองทันทีที่บัญชีเปลี่ยน คนที่แอบเข้ามาแก้บัญชีได้ก็จะให้ระบบบอกร้านให้โอนเข้าบัญชีตัวเองได้ด้วย
   * จึงต้องใส่รหัส 6 หลัก และส่วนกลางต้องตรวจเลขบัญชี/QR ให้แน่ใจก่อนกด
   */
  const notifyShops = (row) => confirmAction(
    // ข้อความยืนยันโชว์ที่อยู่กระเป๋าเต็ม ๆ — นี่คือจังหวะสุดท้ายที่ตาคนตรวจได้ก่อนร้านโอนตาม
    (isWallet(row)
      ? `ส่งกระเป๋า USD ให้ร้านที่มีบิลค้าง ${int(row.openInvoiceCount)} ใบ ทาง Telegram?\n\nเครือข่าย (chain): ${chainOf(row)}\nที่อยู่กระเป๋า: ${row.accountNumber}\n\n`
        + 'ร้านจะใช้ข้อความนี้เทียบก่อนโอนทุกครั้ง — ตรวจเครือข่าย ที่อยู่กระเป๋าทุกตัวอักษร และรูป QR ให้ถูกต้องก่อนกดตกลง (โอนผิดเครือข่ายเงินหายถาวร)'
      : `ส่งเลขบัญชี ${row.bankName} · ${row.accountNumber} (${row.accountName}) ให้ร้านที่มีบิลค้าง ${int(row.openInvoiceCount)} ใบ ทาง Telegram?\n\n`
        + 'ร้านจะใช้ข้อความนี้เทียบก่อนโอนทุกครั้ง — ตรวจเลขบัญชี ชื่อบัญชี และรูป QR ให้ถูกต้องก่อนกดตกลง'),
    async () => {
      const res = await elevated(
        (opts) => api.post(`/api/bank-accounts/${row.id}/notify-shops`, {}, opts),
        'ส่งเลขบัญชีให้ร้านทาง Telegram — ร้านจะโอนเงินตามข้อความนี้ ต้องยืนยันว่าเป็นคุณจริง',
      );
      /*
       * นับเฉพาะบิลที่มีคนในร้านได้ข้อความจริง (notified) — ร้านที่ยังไม่เชื่อม Telegram ไม่ได้อะไรเลย
       * และยังเห็น "ไม่ตรงกับ Telegram" จนกว่าจะรู้บัญชีใหม่ทางอื่น ต้องบอกชื่อบิลให้ส่วนกลางไปแจ้งเอง
       * ไม่งั้นส่วนกลางเข้าใจว่าแจ้งครบทุกร้านแล้ว บิลพวกนั้นค้างไม่มีใครโอน
       */
      const missed = (res.items ?? []).filter((i) => i.sent === 0);
      if (res.sent > 0) {
        toast(`ส่งเลขบัญชีให้ร้านแล้ว — ${int(res.notified)} จาก ${int(res.invoices)} บิล (${int(res.sent)} ข้อความ)`, 'success');
        if (missed.length) {
          toast(`ไม่ได้ส่ง ${int(missed.length)} บิล (ร้านยังไม่เชื่อม Telegram): ${missed.map((i) => i.invoiceNo).join(', ')} — โปรดแจ้งเลขบัญชีกับร้านเอง`, 'error');
        }
      } else {
        toast('ยังไม่มีร้านไหนที่เชื่อม Telegram ไว้ — ไม่ได้ส่งออกไป โปรดแจ้งเลขบัญชีให้ร้านเอง', 'error');
      }
      render();
    },
  );

  /** ถอด QR ออกจากบัญชี — ส่ง null ให้เซิร์ฟเวอร์ล้างค่า */
  const removeQr = (row) => confirmAction(
    `เอารูป QR ออกจาก ${nameOf(row)}? ร้านจะต้อง${isWallet(row) ? 'คัดลอกที่อยู่กระเป๋า' : 'พิมพ์เลขบัญชี'}เองแทน`,
    async () => {
      await elevated((opts) => api.patch(`/api/bank-accounts/${row.id}`, { qrUrl: null }, opts));
      toast('เอา QR ออกแล้ว', 'success');
      render();
    },
  );

  /** เปิดดู QR เต็ม ๆ — ตัวในตารางเล็กเกินกว่าจะเช็กว่าแนบถูกใบ */
  const qrModal = (row) => {
    const modal = infoModal({ title: `QR — ${nameOf(row)}`, width: 420, content: null });
    modal.body.append(
      el('div', { style: 'text-align:center' },
        el('img', { src: row.qrUrl, alt: `QR ${chainOf(row)}`, class: 'qr-full' }),
        // กระเป๋าไม่มีชื่อบัญชี — โชว์ที่อยู่เต็มไว้เทียบกับที่ QR พาไป
        isWallet(row)
          ? el('div', { class: 'sub-line mt-8 wallet-address', style: 'overflow-wrap:anywhere' }, row.accountNumber)
          : el('div', { class: 'sub-line mt-8' }, row.accountName)));
  };

  const setDefault = (row) => confirmAction(
    `ตั้ง ${nameOf(row)} เป็นบัญชีหลัก? บิลที่ออกใหม่จะใช้บัญชีนี้อัตโนมัติ`,
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
        ? `ปิดใช้งาน ${nameOf(row)}? จะเลือกใช้กับบิลใหม่ไม่ได้ แต่บิลเก่ายังชี้บัญชีนี้เหมือนเดิม`
        : `เปิดใช้งาน ${nameOf(row)} อีกครั้ง?`,
      async () => {
        await elevated((opts) => api.patch(`/api/bank-accounts/${row.id}`, { status: turningOff ? 'INACTIVE' : 'ACTIVE' }, opts));
        toast(turningOff ? 'ปิดใช้งานแล้ว' : 'เปิดใช้งานแล้ว', 'success');
        render();
      },
    );
  };

  const remove = (row) => confirmAction(
    `ลบบัญชี ${nameOf(row)}?`,
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
        el('p', {}, 'บัญชีที่ให้ร้านค้าโอนเงินเข้า — บัญชีธนาคารไทยสำหรับบิลบาท · กระเป๋าคริปโตสำหรับบิล USD · มีได้หลายบัญชี แล้วเลือกตอนออกบิลว่าใบไหนโอนเข้าอันไหน')),
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
      (() => {
        const main = res.items.find((r) => r.isDefault);
        if (!main) return stat('บัญชีหลัก', '—', 'ยังไม่ได้ตั้ง', { tone: 'muted', icon: '⭐' });
        return isWallet(main)
          ? stat('บัญชีหลัก', `USD · ${chainOf(main)}`, shortAddress(main.accountNumber), { tone: 'sales', icon: '⭐' })
          : stat('บัญชีหลัก', main.bankName, main.accountNumber, { tone: 'sales', icon: '⭐' });
      })(),
      stat('บิลที่ผูกบัญชีไว้', int(res.items.reduce((t, r) => t + r.invoiceCount, 0)),
        'ใบเรียกเก็บที่ระบุบัญชีปลายทางแล้ว', { tone: 'muted', icon: '🧾' })),

    card(null, table([
      {
        // กระเป๋า USD ไม่มีธนาคาร/ชื่อบัญชี — ช่องนี้บอกเครือข่ายแทน (โอนผิดเครือข่าย = เงินหาย)
        label: 'ธนาคาร / เครือข่าย',
        sortValue: (r) => (isWallet(r) ? `USD ${chainOf(r)}` : r.bankName),
        render: (r) => el('div', {},
          el('strong', {}, isWallet(r) ? `💵 ${chainOf(r)}` : r.bankName),
          r.isDefault ? el('span', { class: 'badge green', style: 'margin-left:8px' }, '⭐ บัญชีหลัก') : '',
          el('div', { class: 'sub-line' }, isWallet(r) ? 'กระเป๋าคริปโต (USD)' : r.accountName)),
      },
      {
        label: 'เลขที่บัญชี / ที่อยู่กระเป๋า',
        // ค้นหา/เรียงด้วยที่อยู่เต็ม — ในตารางโชว์แบบย่อ แต่พิมพ์ค้นส่วนไหนของที่อยู่ก็เจอ
        sortValue: (r) => r.accountNumber,
        render: (r) => (isWallet(r)
          ? el('div', { class: 'bank-number', style: 'justify-content:flex-start;margin:0' },
            el('strong', { class: 'wallet-address', title: r.accountNumber }, shortAddress(r.accountNumber)),
            copyButton(r.accountNumber, 'คัดลอกที่อยู่กระเป๋า', { iconOnly: true }))
          : el('div', {},
            el('strong', { style: 'letter-spacing:.5px' }, r.accountNumber),
            r.branch ? el('div', { class: 'sub-line' }, `สาขา ${r.branch}`) : '')),
      },
      {
        label: 'QR',
        sortable: false,
        render: (r) => (r.qrUrl
          ? el('div', { class: 'btn-row' },
            el('img', {
              src: r.qrUrl, alt: `QR ${chainOf(r)}`, class: 'qr-thumb', title: 'กดเพื่อดูเต็มรูป',
              onclick: () => qrModal(r),
            }),
            el('button', { class: 'btn ghost sm danger', onclick: () => removeQr(r) }, 'เอาออก'))
          : el('span', { class: 'muted' }, '—')),
      },
      {
        label: 'สกุลที่รับ',
        sortValue: (r) => r.currency,
        render: (r) => el('span', { class: r.currency === 'USD' ? 'badge blue' : 'badge' },
          r.currency === 'USD' ? 'USD · กระเป๋า' : 'THB'),
      },
      { label: 'หมายเหตุ', render: (r) => r.note ?? el('span', { class: 'muted' }, '—') },
      {
        label: 'ใช้กับบิล',
        num: true,
        sortValue: (r) => r.invoiceCount,
        render: (r) => (r.invoiceCount
          ? el('div', {}, `${int(r.invoiceCount)} ใบ`,
            r.openInvoiceCount > 0 ? el('div', { class: 'sub-line' }, `ค้างจ่าย ${int(r.openInvoiceCount)} ใบ`) : '')
          : el('span', { class: 'muted' }, '—')),
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
          // โผล่เฉพาะบัญชีที่มีบิลค้างชี้อยู่ — ไม่มีบิลค้างก็ไม่มีร้านไหนต้องรู้เลข
          r.openInvoiceCount > 0
            ? el('button', { class: 'btn ghost sm', onclick: () => notifyShops(r) }, '📨 ส่งเลขบัญชีให้ร้านที่มีบิลค้าง')
            : '',
          // ลบได้เฉพาะบัญชีที่ยังไม่เคยผูกกับบิล — บิลเก่าต้องชี้บัญชีเดิมได้ตลอด
          r.invoiceCount === 0
            ? el('button', { class: 'btn ghost sm danger', onclick: () => remove(r) }, 'ลบ')
            : '',
        ),
      },
    ], res.items, {
      search: 'ค้นหาธนาคาร เครือข่าย เลขบัญชี หรือที่อยู่กระเป๋า…',
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
  // เปลี่ยนว่าบิลใบหนึ่งให้โอนเข้าบัญชีไหน (ไม่ได้แก้ตัวบัญชี) — ค่าเดิม/ใหม่เป็นป้ายบัญชี "ธนาคาร · เลข (ชื่อ)"
  invoiceAccount: 'บัญชีของบิล',
  chain: 'เครือข่าย (chain)',
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
  // ที่อยู่กระเป๋า (และป้ายบัญชีที่มีที่อยู่) เป็นสตริงยาวไม่มีช่องว่าง — ต้องตัดบรรทัดได้ ไม่งั้นตารางล้นจอมือถือ
  return el('strong', { style: 'overflow-wrap:anywhere' }, String(value));
};

function changeCard(c, onAck) {
  const who = c.actor ? (c.actor.displayName || c.actor.username) : 'ระบบ';
  return el('div', { class: 'bank-change' },
    el('div', { class: 'bank-change-head' },
      el('div', {},
        el('strong', { style: 'overflow-wrap:anywhere' }, `${KIND_LABEL[c.kind]} — ${c.accountLabel}`),
        el('div', { class: 'sub-line' }, `โดย ${who} · ${dateTh(c.createdAt)}`),
        el('div', { class: 'sub-line' },
          c.telegram
            ? `${TG_LABEL[c.telegram.status]}${c.telegram.status !== 'SENT' && c.telegram.error ? ` (${c.telegram.error})` : ''}`
            : 'ไม่ได้แจ้งออกนอกระบบ (ยังไม่ได้ตั้งค่า Telegram)')),
      el('button', { class: 'btn sm', onclick: onAck }, 'ตรวจแล้ว ถูกต้อง')),
    c.changes.length
      ? table([
        // ป้ายจากเซิร์ฟเวอร์ก่อน (รู้ว่าบัญชีเป็นกระเป๋าหรือไม่) — ของในไฟล์นี้ไว้สำรองตอนเซิร์ฟเวอร์ไม่ส่งมา
        { label: 'ช่อง', render: (x) => x.fieldLabel || FIELD_LABEL[x.field] || x.field },
        { label: 'เดิม', render: (x) => showValue(x.field, x.from) },
        { label: 'ใหม่', render: (x) => showValue(x.field, x.to) },
      ], c.changes)
      : '',
    /*
     * ระบบไม่ส่งเลขบัญชีใหม่ให้ร้านเอง — ร้านเห็นบนเว็บว่าไม่ตรงกับ Telegram แล้วจะไม่โอน
     * บอกแอดมินว่าต้องทำอะไรต่อ: ตรวจว่าถูกต้องแล้วค่อยกดส่งเอง (หรือแก้กลับถ้าไม่ได้เป็นคนแก้)
     */
    c.changes.some((x) => x.field === 'invoiceAccount')
      ? el('div', { class: 'sub-line', style: 'margin-top:6px;font-weight:700' },
        '⚠ ร้านยังไม่ได้รับเลขบัญชีใหม่ทาง Telegram — ตรวจว่าถูกต้องแล้วกด "📨 ส่งเลขบัญชีให้ร้าน" ที่บิลนั้น '
        + '(ระหว่างนี้ร้านจะเห็นว่าบัญชีไม่ตรงกับ Telegram และจะไม่โอน)')
      : c.openInvoices > 0
        ? el('div', { class: 'sub-line', style: 'margin-top:6px;font-weight:700' },
          `⚠ มีบิลค้างจ่าย ${int(c.openInvoices)} ใบที่ชี้บัญชีนี้อยู่ตอนแก้ — ร้านเห็นข้อมูลใหม่บนเว็บแล้ว แต่ยังไม่ได้รับทาง Telegram `
          + '(ร้านจะเห็นว่าไม่ตรงและจะไม่โอน) ตรวจว่าถูกต้องแล้วกด "📨 ส่งเลขบัญชีให้ร้านที่มีบิลค้าง" ที่หน้าบัญชีรับเงิน')
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
        + '2) แก้บัญชีกลับ  3) แจ้งร้านที่มีบิลค้างว่าอย่าโอนเข้าบัญชีใหม่ — และอย่ากด "📨 ส่งเลขบัญชีให้ร้าน" จนกว่าจะแก้กลับเรียบร้อย')),
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
