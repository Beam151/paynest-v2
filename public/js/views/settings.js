import { api } from '../api.js';
import { card, confirmAction, copyButton, dateTh, el, field, icon, infoModal, int, toast } from '../ui.js';
import { elevated } from '../elevation.js';
import { render } from '../app.js';

/**
 * ตั้งค่าของส่วนกลาง — ช่องทางแจ้งเตือน + เรื่องที่จะแจ้ง + เวลา
 *
 * ทุกการแก้ต้องใส่รหัสยืนยันก่อน (elevated) และกลุ่ม Telegram ได้ข้อความทุกครั้งที่มีคนแก้
 * เรื่องความปลอดภัยล็อกไว้ "แจ้งทันทีเสมอ" — ปิดไม่ได้ (ดู app/Services/NotificationService.php)
 */
export async function settingsView() {
  const [settings, backup] = await Promise.all([
    api.get('/api/settings/notifications'),
    api.get('/api/settings/backup').catch(() => null),
  ]);
  const tg = settings.telegram;

  // ค่าที่กำลังแก้ — เทียบกับของเดิมเพื่อเปิด/ปิดปุ่มบันทึก
  const draft = {
    events: Object.fromEntries(settings.events.filter((e) => !e.locked).map((e) => [e.key, e.mode])),
    quietHours: { ...settings.quietHours },
    digestTime: settings.digestTime,
  };
  const original = JSON.stringify(draft);
  const save = el('button', { class: 'btn' }, 'บันทึกการตั้งค่า');
  const discard = el('button', { class: 'btn ghost', onclick: () => render() }, 'ยกเลิก');
  // แถบนี้โผล่เฉพาะตอนมีของให้บันทึก — ไม่ต้องมีการ์ดเปล่าค้างท้ายหน้าตลอดเวลา
  const saveBar = el('div', { class: 'save-bar', hidden: true },
    el('span', { class: 'save-bar-note' }, icon('circle-alert'), 'มีการเปลี่ยนแปลงที่ยังไม่บันทึก'),
    el('div', { class: 'btn-row' }, discard, save));
  const sync = () => {
    saveBar.hidden = JSON.stringify(draft) === original;
    save.disabled = false;
  };

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await elevated((opts) => api.put('/api/settings/notifications', draft, opts),
        'การตั้งค่าแจ้งเตือน — ปิดการแจ้งเตือนได้ จึงต้องยืนยันว่าเป็นคุณ');
      toast('บันทึกแล้ว — กลุ่ม Telegram ได้รับข้อความแจ้งการเปลี่ยนแปลง', 'success');
      render();
    } catch (err) {
      toast(err.fullMessage ?? err.message, 'error');
      sync();
    }
  });

  /** ปุ่มเลือก 3 ทาง: แจ้งทันที / สรุปรายวัน / ไม่แจ้ง */
  const OPTIONS = [
    { value: 'instant', label: 'แจ้งทันที' },
    { value: 'digest', label: 'สรุปรายวัน' },
    { value: 'off', label: 'ไม่แจ้ง' },
  ];
  const modePicker = (ev) => {
    const current = ev.locked ? 'instant' : draft.events[ev.key];
    const group = el('div', { class: `seg${ev.locked ? ' locked' : ''}`, role: 'radiogroup', 'aria-label': ev.label });
    for (const o of OPTIONS) {
      // ล็อก = เลือกไม่ได้ทั้งแถว · สรุปอย่างเดียว = "แจ้งทันที" ใช้ไม่ได้
      const disabled = ev.locked || (ev.digestOnly && o.value === 'instant');
      const input = el('input', {
        type: 'radio', name: `mode-${ev.key}`, value: o.value, checked: current === o.value, disabled,
      });
      input.addEventListener('change', () => { draft.events[ev.key] = o.value; sync(); });
      group.append(el('label', {
        title: ev.locked ? 'เรื่องความปลอดภัย — แจ้งทันทีเสมอ ปิดไม่ได้'
          : disabled ? 'เรื่องนี้เป็นสรุปเท่านั้น' : undefined,
      }, input, el('span', {}, o.label)));
    }
    return group;
  };

  const eventRows = Object.entries(settings.groups).map(([groupKey, groupLabel]) => {
    const events = settings.events.filter((e) => e.group === groupKey);
    return el('div', { class: 'notify-group' },
      el('h3', {}, groupLabel),
      ...events.map((ev) => el('div', { class: 'notify-row' },
        el('div', { class: 'notify-label' },
          el('span', {}, ev.label),
          ev.locked ? el('span', { class: 'lock-note' }, icon('lock'), 'ปิดไม่ได้ — กันคนที่ได้บัญชีไปแอบปิดก่อนลงมือ') : ''),
        modePicker(ev))));
  });

  // ── เวลา ──
  const quietOn = el('input', { type: 'checkbox', checked: draft.quietHours.enabled });
  const quietFrom = el('input', { type: 'time', value: draft.quietHours.from });
  const quietTo = el('input', { type: 'time', value: draft.quietHours.to });
  const digestAt = el('input', { type: 'time', value: draft.digestTime });
  const refreshQuiet = () => {
    quietFrom.disabled = !quietOn.checked;
    quietTo.disabled = !quietOn.checked;
  };
  quietOn.addEventListener('change', () => { draft.quietHours.enabled = quietOn.checked; refreshQuiet(); sync(); });
  quietFrom.addEventListener('change', () => { draft.quietHours.from = quietFrom.value; sync(); });
  quietTo.addEventListener('change', () => { draft.quietHours.to = quietTo.value; sync(); });
  digestAt.addEventListener('change', () => { draft.digestTime = digestAt.value; sync(); });
  refreshQuiet();

  return el('div', {},
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', {}, 'ตั้งค่า'),
        el('p', {}, 'การแจ้งเตือนของส่วนกลาง — เลือกว่าเรื่องไหนจะแจ้ง แจ้งเมื่อไร และส่งไปที่ไหน'))),

    card('ช่องทางแจ้งเตือน', telegramPanel(tg)),

    card('เรื่องที่จะแจ้ง', el('div', {},
      tg.configured ? '' : el('div', { class: 'notice-box' },
        'ยังไม่ได้เชื่อม Telegram — ตั้งค่าไว้ก่อนได้ แต่จะยังไม่มีข้อความส่งออกจนกว่าจะเชื่อม'),
      el('p', { class: 'sub-line mt-0' },
        '"สรุปรายวัน" = รวมเป็นข้อความเดียวส่งตามเวลาที่ตั้งด้านล่าง — เหมาะกับเรื่องที่ไม่ต้องรีบ จะได้ไม่เด้งทั้งวัน'),
      ...eventRows)),

    card('เวลา', el('div', { class: 'time-grid' },
      el('div', { class: 'time-panel' },
        el('div', { class: 'time-panel-head' },
          el('span', { class: 'time-ico' }, icon('moon')),
          el('div', { class: 'time-panel-title' },
            el('strong', {}, 'ช่วงห้ามรบกวน'),
            el('span', { class: 'sub-line' }, 'ข้อความ "แจ้งทันที" ที่เกิดช่วงนี้ ส่งตอนพ้นช่วง')),
          el('label', { class: 'switch', title: 'เปิด/ปิดช่วงห้ามรบกวน' }, quietOn, el('span', { class: 'slider' }))),
        el('div', { class: 'time-range' }, quietFrom, el('span', {}, 'ถึง'), quietTo, el('span', { class: 'sub-line' }, 'น.')),
        el('span', { class: 'hint' }, 'เรื่องความปลอดภัยยังแจ้งทันทีเสมอ')),
      el('div', { class: 'time-panel' },
        el('div', { class: 'time-panel-head' },
          el('span', { class: 'time-ico' }, icon('clock')),
          el('div', { class: 'time-panel-title' },
            el('strong', {}, 'สรุปรายวัน'),
            el('span', { class: 'sub-line' }, 'รวมเรื่องที่ตั้ง "สรุปรายวัน" เป็นข้อความเดียว'))),
        el('div', { class: 'time-range' }, el('span', {}, 'ส่งทุกวันเวลา'), digestAt, el('span', { class: 'sub-line' }, 'น.')),
        el('span', { class: 'hint' }, 'เวลาไทย · วันไหนไม่มีอะไรจะสรุป จะไม่ส่ง')))),

    uptimeCard(),
    backup ? backupCard(backup) : '',

    saveBar);
}

/*
 * สำรองข้อมูล — ระบบทำเองทุกคืน หน้านี้แค่บอกว่าทำอยู่จริง และกดสำรองทันทีได้ (ก่อนอัปเดตระบบ)
 * สำรองไม่สำเร็จ = แจ้ง Telegram เสมอ (ปิดไม่ได้)
 */
function backupCard(b) {
  const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
  const runNow = async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await api.post('/api/settings/backup', {});
      toast(`สำรองแล้ว · มีทั้งหมด ${int(r.count)} ชุด`, 'success');
      render();
    } catch (err) {
      toast(err.message, 'error');
      e.currentTarget.disabled = false;
    }
  };
  const lastAt = b.last?.at ? new Date(b.last.at) : null;
  const stale = !lastAt || Date.now() - lastAt.getTime() > 36 * 3600 * 1000; // เกินวันครึ่งยังไม่มีใหม่ = ผิดปกติ
  return card('สำรองข้อมูล', el('div', {},
    el('div', { class: 'channel-row' },
      el('span', { class: `channel-ico${stale || b.error ? '' : ' on'}` }, icon(stale || b.error ? 'triangle-alert' : 'circle-check')),
      el('div', { class: 'channel-text' },
        el('strong', {}, lastAt
          ? `ล่าสุด ${lastAt.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' })} น. · ${kb(b.last.size)}`
          : 'ยังไม่เคยสำรอง'),
        el('span', { class: 'sub-line' },
          `ทำเองทุกคืน ${b.runAt} น. · เก็บย้อนหลัง ${int(b.keepDays)} วัน (ตอนนี้มี ${int(b.count)} ชุด) · ฐานข้อมูล + กุญแจลับ + รูปสลิป`)),
      el('button', { class: 'btn ghost sm', onclick: runNow }, 'สำรองตอนนี้')),
    b.error ? el('div', { class: 'alert-box mt-8' }, `ครั้งล่าสุดไม่สำเร็จ: ${b.error}`) : '',
    el('p', { class: 'sub-line mt-8' },
      'เก็บอยู่ที่ ', el('code', {}, b.dir),
      ' — อยู่บนเครื่องเดียวกับระบบ ถ้าเครื่องพังจะหายไปด้วย ควรตั้งให้คัดลอกโฟลเดอร์นี้ไปที่อื่นอีกชั้น (ดูคู่มือ DEPLOY.md)')));
}

/*
 * ตรวจว่าเว็บล่ม — ระบบที่ล่มไปแล้วแจ้งเตือนเองไม่ได้ ต้องให้คนนอกคอยเคาะประตู
 * UptimeRobot (ฟรี) เรียก /health ทุก 5 นาที เข้าไม่ได้ = ส่ง Telegram ทันที
 * ตรงนี้แค่บอกลิงก์กับขั้นตอน — สมัครบัญชี UptimeRobot ต้องทำเอง
 */
function uptimeCard() {
  const url = `${location.origin}/health`;
  const local = /^(localhost|127\.|0\.0\.0\.0)/.test(location.hostname);
  return card('ตรวจว่าเว็บล่ม', el('div', {},
    el('div', { class: 'channel-row' },
      el('span', { class: 'channel-ico on' }, icon('shield-check')),
      el('div', { class: 'channel-text' },
        el('strong', {}, 'ลิงก์ตรวจสถานะ'),
        el('span', { class: 'bank-number', style: 'justify-content:flex-start;margin:0' },
          el('code', {}, url), copyButton(url, 'คัดลอกลิงก์ตรวจสถานะ', { iconOnly: true })))),
    local ? el('div', { class: 'notice-box mt-8' },
      'ตอนนี้เปิดจากเครื่องตัวเอง (localhost) — ตัวตรวจภายนอกเข้าไม่ถึง ใช้ลิงก์นี้หลังขึ้นเซิร์ฟเวอร์จริงแล้ว') : '',
    el('ol', { class: 'uptime-steps' },
      el('li', {}, 'สมัคร ', el('a', { href: 'https://uptimerobot.com', target: '_blank', rel: 'noopener' }, 'UptimeRobot'), ' (ฟรี)'),
      el('li', {}, 'Add New Monitor → เลือก HTTP(s) → วางลิงก์ด้านบน → ตรวจทุก 5 นาที'),
      el('li', {}, 'Alert Contacts → เพิ่ม Telegram → เลือกกลุ่มเดียวกับที่รับแจ้งเตือนของระบบ')),
    el('p', { class: 'sub-line mt-8' },
      'ลิงก์นี้ตรวจทั้งฐานข้อมูลและงานตั้งเวลา (cron) — cron หยุดเกิน 10 นาทีก็นับว่าล่ม เพราะจะไม่มีการสำรองข้อมูลและเตือนร้าน'),
    el('p', { class: 'sub-line mt-8' },
      'ส่วนที่ระบบแจ้งเองได้ (ระบบเพิ่งเริ่มทำงานใหม่ · ขัดข้อง · ดิสก์ใกล้เต็ม) เลือกได้ในกลุ่ม "ระบบ / เซิร์ฟเวอร์" ด้านบน')));
}

/* ── Telegram ─────────────────────────────────────────────── */

function telegramPanel(tg) {
  if (!tg.configured) {
    return el('div', { class: 'channel-row' },
      el('span', { class: 'channel-ico' }, icon('send')),
      el('div', { class: 'channel-text' },
        el('strong', {}, 'Telegram — ยังไม่ได้เชื่อม'),
        el('span', { class: 'sub-line' }, 'ส่งแจ้งเตือนเข้ากลุ่มที่มีเจ้าของกิจการและแอดมิน — คนร้ายที่ได้บัญชีไปลบข้อความในกลุ่มไม่ได้')),
      el('button', { class: 'btn', onclick: () => telegramSetupModal(tg) }, 'เชื่อม Telegram'));
  }

  const test = async (btn) => {
    btn.disabled = true;
    try {
      const r = await api.post('/api/settings/telegram/test');
      toast(r.ok ? 'ส่งข้อความทดสอบแล้ว — เช็คในกลุ่ม Telegram' : `ส่งไม่ได้: ${r.error}`, r.ok ? 'success' : 'error');
    } finally {
      btn.disabled = false;
    }
  };
  const turnOff = () => confirmAction('ปิดการแจ้งเตือน Telegram? กลุ่มจะได้รับข้อความแจ้งว่าถูกปิด', async () => {
    await elevated((opts) => api.del('/api/settings/telegram', {}, opts),
      'ปิดการแจ้งเตือน — คนร้ายมักปิดแจ้งเตือนก่อนลงมือ ต้องยืนยันว่าเป็นคุณ');
    toast('ปิดการแจ้งเตือนแล้ว', 'success');
    render();
  });
  const trouble = tg.failed > 0 || (tg.pending > 0 && tg.lastError);

  return el('div', {},
    el('div', { class: 'channel-row' },
      el('span', { class: 'channel-ico on' }, icon('send')),
      el('div', { class: 'channel-text' },
        el('strong', {}, `Telegram — ${tg.chatTitle ?? `กลุ่ม ${tg.chatHint}`}`),
        el('span', { class: 'sub-line' },
          `${tg.botUsername ? `บอท @${tg.botUsername} · ` : ''}${tg.lastSentAt ? `ส่งล่าสุด ${dateTh(tg.lastSentAt)}` : 'ยังไม่เคยส่ง'}`)),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn ghost sm', onclick: (e) => test(e.currentTarget) }, 'ส่งข้อความทดสอบ'),
        el('button', { class: 'btn ghost sm', onclick: () => telegramSetupModal(tg) }, 'เปลี่ยนกลุ่ม'),
        el('button', { class: 'btn ghost sm danger', onclick: turnOff }, 'ปิด'))),
    trouble
      ? el('div', { class: 'alert-box mt-12' },
        `ส่งไม่สำเร็จ ${int(tg.failed)} · กำลังลองใหม่ ${int(tg.pending)} — ${tg.lastError ?? ''}`)
      : '');
}

/**
 * เชื่อม/เปลี่ยนกลุ่ม Telegram — ทุกขั้นต้องใส่รหัสยืนยันก่อน (elevated)
 * ย้ายหรือปิดเมื่อไหร่ กลุ่มเดิมได้ข้อความทันที (ทำฝั่งเซิร์ฟเวอร์)
 */
function telegramSetupModal(tg) {
  const modal = infoModal({ title: 'เชื่อมแจ้งเตือน Telegram', width: 560, content: null });
  const token = el('input', {
    type: 'password', autocomplete: 'off',
    placeholder: tg.configured ? 'เว้นว่าง = ใช้บอทเดิม' : '123456789:AAH…',
  });
  const manual = el('input', { type: 'text', placeholder: '-1001234567890' });
  const errorBox = el('div', { class: 'error-box', hidden: true });
  const chatList = el('div', {});
  const save = el('button', { class: 'btn', disabled: true }, 'บันทึก');
  let chosen = null;

  const fail = (err) => { errorBox.textContent = err.fullMessage ?? err.message; errorBox.hidden = false; };
  const pick = (chat) => { chosen = chat; save.disabled = !chosen; };
  manual.addEventListener('input', () => pick(manual.value.trim() ? { id: manual.value.trim(), title: null } : null));

  const discover = el('button', {
    class: 'btn ghost',
    onclick: async () => {
      errorBox.hidden = true;
      discover.disabled = true;
      try {
        const res = await elevated(
          (opts) => api.post('/api/settings/telegram/discover', token.value.trim() ? { botToken: token.value.trim() } : {}, opts),
          'ตั้งค่าปลายทางแจ้งเตือน — ต้องยืนยันว่าเป็นคุณ ไม่งั้นคนที่ได้ session ไปจะย้ายแจ้งเตือนไปกลุ่มตัวเองได้',
        );
        chatList.replaceChildren(res.chats.length
          ? el('div', { class: 'checklist' }, ...res.chats.map((c) => {
            const radio = el('input', { type: 'radio', name: 'tg-chat', onchange: () => pick(c) });
            return el('label', { class: 'check-item' }, radio,
              el('div', {}, el('strong', {}, c.title), el('div', { class: 'sub-line' }, `${c.type} · ${c.id}`)));
          }))
          : el('div', { class: 'notice-box m-0' },
            `ยังไม่เห็นกลุ่มไหน — เพิ่ม @${res.botUsername} เข้ากลุ่ม แล้วพิมพ์อะไรก็ได้ในกลุ่ม 1 ข้อความ จากนั้นกดค้นหาอีกครั้ง`));
      } catch (err) {
        fail(err);
      } finally {
        discover.disabled = false;
      }
    },
  }, icon('search'), 'ค้นหากลุ่ม');

  save.addEventListener('click', async () => {
    errorBox.hidden = true;
    save.disabled = true;
    try {
      await elevated((opts) => api.put('/api/settings/telegram', {
        ...(token.value.trim() ? { botToken: token.value.trim() } : {}),
        chatId: chosen.id,
        ...(chosen.title ? { chatTitle: chosen.title } : {}),
      }, opts));
      toast('เชื่อมต่อแล้ว — เช็คข้อความในกลุ่ม Telegram', 'success');
      modal.close();
      render();
    } catch (err) {
      fail(err);
      save.disabled = false;
    }
  });

  modal.body.append(
    el('ol', { class: 'steps' },
      el('li', {}, 'ใน Telegram คุยกับ ', el('strong', {}, '@BotFather'), ' พิมพ์ /newbot ตั้งชื่อบอท แล้วคัดลอก token มาวางด้านล่าง'),
      el('li', {}, 'สร้างกลุ่ม ใส่', el('strong', {}, 'เจ้าของกิจการ'), ' แอดมินทุกคน และบอทตัวนั้น แล้วพิมพ์อะไรก็ได้ในกลุ่ม 1 ข้อความ'),
      el('li', {}, 'กด "ค้นหากลุ่ม" เลือกกลุ่ม แล้วกดบันทึก — ระบบจะส่งข้อความทดสอบเข้ากลุ่มก่อนบันทึก')),
    errorBox,
    el('div', { style: 'display:grid;gap:12px' },
      field('Bot token', token, tg.configured ? `ตอนนี้ใช้ @${tg.botUsername ?? 'บอทเดิม'}` : 'ได้จาก @BotFather'),
      el('div', { class: 'btn-row' }, discover),
      chatList,
      field('หรือใส่ chat id เอง', manual, 'กลุ่มขึ้นต้นด้วยเครื่องหมายลบ'),
      el('div', { class: 'btn-row' }, save)));
}
