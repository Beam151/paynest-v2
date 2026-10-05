import { api } from '../api.js';
import { el, formModal, money, toast } from '../ui.js';
import { render } from '../app.js';

/**
 * ปุ่มตั้งอัตราแลกเปลี่ยนของรอบบิล — เกาะอยู่ในแถบเลือกรอบ
 *
 * อัตราเป็นสมบัติของ "รอบ" ไม่ใช่ของหน้าใดหน้าหนึ่ง จึงต้องอยู่ติดกับตัวเลือกรอบ
 * ทุกหน้าที่มีรอบ (ยอดขายรายรอบ / ใบเรียกเก็บ) จะได้หาเจอที่เดียวกัน
 *
 * ยอดในระบบยังเป็นบาททุกที่ — อัตราเป็นแค่ตัวแปลงให้ร้านต่างชาติเทียบ
 * บิลที่ออกไปแล้วตรึงอัตราของตัวเองไว้ ตั้งใหม่ทีหลังไม่กระทบใบเก่า
 * บรรทัด "≈ $…" ในการ์ดสรุปของทุกหน้าก็ใช้อัตรานี้ (รอบที่ไม่ได้ตั้ง = อัตราล่าสุด · ดู usdNote ใน ui.js)
 *
 * @param period    ข้อมูลรอบจาก /api/periods/:code (ต้องมี code, usdRate)
 * @param baseAmount ยอดบาทที่ใช้โชว์ตัวอย่างการแปลง (เว้นไว้ = ไม่โชว์ตัวอย่าง)
 */
export function usdRateChip(period, { baseAmount = null, baseLabel = 'ยอดที่ต้องเรียกเก็บรอบนี้' } = {}) {
  if (!period) return '';

  const rateModal = () => formModal({
    title: `อัตราแลกเปลี่ยนรอบ ${period.code}`,
    submitLabel: 'บันทึกอัตรา',
    fields: [{
      name: 'usdRate',
      label: 'บาท ต่อ 1 ดอลลาร์ (USD)',
      type: 'number',
      step: '0.01',
      value: period.usdRate ?? '',
      placeholder: '36.25',
      hint: 'เว้นว่างแล้วกดบันทึก = ล้างอัตราของรอบนี้ (บิลจะไม่โชว์ยอดดอลลาร์)',
    }],
    preview: (v) => {
      const rate = Number(v.usdRate);
      if (!v.usdRate || !Number.isFinite(rate) || rate <= 0) {
        return el('div', { class: 'notice-box m-0' },
          'ไม่ได้ตั้งอัตรา — บิลของรอบนี้จะโชว์เฉพาะยอดบาท');
      }
      return el('div', { class: 'notice-box m-0' },
        baseAmount === null
          ? `1 ดอลลาร์ = ${money(rate)} บาท`
          : `${baseLabel} ${money(baseAmount)} ฿`,
        baseAmount === null ? '' : el('div', { class: 'mt-4' }, el('strong', {}, `≈ $${money(baseAmount / rate)}`)),
        el('div', { class: 'sub-line mt-4' },
          'มีผลกับบิลที่ออกหลังจากนี้ — บิลที่ออกไปแล้วยังใช้อัตราเดิมของใบนั้น'));
    },
    onSubmit: async (v) => {
      await api.post(`/api/periods/${period.code}/usd-rate`, {
        usdRate: v.usdRate === undefined || v.usdRate === '' ? null : v.usdRate,
      });
      toast(v.usdRate ? `ตั้งอัตรา ${v.usdRate} บาท/ดอลลาร์ แล้ว` : 'ล้างอัตราแลกเปลี่ยนแล้ว', 'success');
      render();
    },
  });

  return el('button', {
    type: 'button',
    // ไม่มีอัตรา = ขึ้นสีเตือน เพราะบิลที่ออกในรอบนี้จะไม่มียอดดอลลาร์ให้ร้านต่างชาติดู
    class: `rate-chip${period.usdRate ? '' : ' unset'}`,
    onclick: rateModal,
    title: period.usdRate
      ? `1 ดอลลาร์ = ${money(period.usdRate)} บาท — กดเพื่อแก้`
      // ยอด ≈ $ ในการ์ดสรุปยังขึ้นได้ทั้งที่รอบนี้ไม่มีอัตรา — บอกว่ามันมาจากอัตราไหน ไม่งั้นดูเหมือนตัวเลขลอยมา
      : `ยังไม่ได้ตั้งอัตราแลกเปลี่ยนของรอบนี้ — กดเพื่อตั้ง${period.fxRate
        ? ` (ยอด ≈ $ ของรอบนี้เทียบด้วยอัตราล่าสุดที่ตั้งไว้ ${money(period.fxRate)} ฿/USD ไปก่อน)` : ''}`,
  }, period.usdRate ? `💵 ${money(period.usdRate)} ฿/USD` : '💵 ตั้งอัตรา USD');
}
