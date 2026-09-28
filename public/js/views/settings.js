import { api } from '../api.js';
import { card, confirmAction, copyButton, dateTh, el, field, icon, infoModal, int, toast } from '../ui.js';
import { elevated } from '../elevation.js';
import { mountCaptcha } from '../turnstile.js';
import { versionDetails } from '../version.js';
import { render } from '../app.js';

/**
 * ตั้งค่าของส่วนกลาง — ช่องทางแจ้งเตือน + เรื่องที่จะแจ้ง + เวลา
 *
 * ทุกการแก้ต้องใส่รหัสยืนยันก่อน (elevated) และกลุ่ม Telegram ได้ข้อความทุกครั้งที่มีคนแก้
 * เรื่องความปลอดภัยล็อกไว้ "แจ้งทันทีเสมอ" — ปิดไม่ได้ (ดู app/Services/NotificationService.php)
 */
export async function settingsView() {
  const [settings, captcha, backup, version] = await Promise.all([
    api.get('/api/settings/notifications'),
    api.get('/api/settings/turnstile').catch(() => null),
    api.get('/api/settings/backup').catch(() => null),
    api.get('/api/system/version').catch(() => null),
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

    captcha ? captchaCard(captcha) : '',
    uptimeCard(),
    backup ? backupCard(backup) : '',
    // เนื้อหาเดียวกับที่กดดูจากท้ายเมนูซ้าย — ที่นี่เห็นคำเตือน "ยังไม่ได้รัน app:install" โดยไม่ต้องกด
    version ? card('เวอร์ชันระบบ', versionDetails(version)) : '',

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

/* ── captcha หน้าเข้าสู่ระบบ ─────────────────────────────── */

/*
 * captcha (Cloudflare Turnstile) — ถามเฉพาะบัญชีที่ถูกใส่รหัสผิดเกินกำหนด ไม่ล็อกบัญชี
 * กันคนร้ายที่มีหลาย IP ผลัดกันเดารหัส (ด่าน rate limit เดิมนับตาม IP จึงกันไม่ได้)
 */
function captchaCard(ts) {
  const turnOff = () => confirmAction('ปิด captcha? บัญชีที่ถูกเดารหัสจากหลาย IP จะไม่มีด่านนี้กันแล้ว (กลุ่ม Telegram จะได้รับแจ้ง)', async () => {
    await elevated((opts) => api.del('/api/settings/turnstile', {}, opts),
      'ปิด captcha — คนร้ายอาจปิดก่อนไล่เดารหัสร้าน ต้องยืนยันว่าเป็นคุณ');
    toast('ปิด captcha แล้ว', 'success');
    render();
  });
  return card('กันบอทเดารหัสผ่าน', el('div', {},
    el('div', { class: 'channel-row' },
      el('span', { class: `channel-ico${ts.configured ? ' on' : ''}` }, icon('shield-check')),
      el('div', { class: 'channel-text' },
        el('strong', {}, `Captcha หน้าเข้าสู่ระบบ — ${ts.configured ? 'เปิดอยู่' : 'ยังไม่ได้เปิด'}`),
        el('span', { class: 'sub-line' }, ts.configured
          ? `Cloudflare Turnstile · site key ${ts.siteKey.slice(0, 10)}… · ตั้งเมื่อ ${dateTh(ts.updatedAt)}`
          : 'ใช้ Cloudflare Turnstile (ฟรี) — ต้องมีบัญชี Cloudflare')),
      ts.configured
        ? el('div', { class: 'btn-row' },
          el('button', { class: 'btn ghost sm', onclick: () => captchaSetupModal(ts) }, 'เปลี่ยนคีย์'),
          el('button', { class: 'btn ghost sm danger', onclick: turnOff }, 'ปิด'))
        : el('button', { class: 'btn', onclick: () => captchaSetupModal(ts) }, 'เปิด captcha')),
    el('p', { class: 'sub-line mt-8' },
      `ถามเฉพาะบัญชีที่ถูกใส่รหัสผิดเกิน ${int(ts.threshold)} ครั้งใน 1 ชั่วโมง (นับรวมทุกเครื่อง) — คนใช้ปกติไม่เห็น`,
      ' · ไม่ล็อกบัญชี เจ้าของตัวจริงผ่านช่องยืนยันแล้วเข้าได้ตามปกติ')));
}

/**
 * ตั้งคีย์ — ต้องผ่านช่อง captcha ที่วาดด้วย site key ใหม่บนโดเมนนี้ เซิร์ฟเวอร์ถึงยอมบันทึก
 * คีย์ผิด / ยังไม่ได้ใส่โดเมนใน Cloudflare จะรู้ตรงนี้ ไม่ใช่ไปรู้ตอนร้านล็อกอินไม่ได้
 */
function captchaSetupModal(ts) {
  let widget = null;
  const modal = infoModal({ title: 'เปิด captcha หน้าเข้าสู่ระบบ', width: 560, content: null, onClose: () => widget?.remove() });
  const siteKey = el('input', { type: 'text', autocomplete: 'off', placeholder: '0x4AAAAAAA…', value: ts.siteKey ?? undefined });
  const secret = el('input', { type: 'password', autocomplete: 'off', placeholder: '0x4AAAAAAA…' });
  const errorBox = el('div', { class: 'error-box', hidden: true });
  const captchaBox = el('div', { class: 'captcha-box', hidden: true });
  const test = el('button', { class: 'btn' }, 'ทดสอบและบันทึก');
  const local = /^(localhost|127\.|0\.0\.0\.0)/.test(location.hostname);
  const fail = (message) => { errorBox.textContent = message; errorBox.hidden = false; };

  let mountedKey = null;
  let token = null;
  let pending = false; // กดปุ่มแล้วแต่ยังไม่ผ่านช่อง — ผ่านเมื่อไรบันทึกให้เอง (ครั้งเดียวต่อการกด)

  const save = async (captchaToken) => {
    test.disabled = true;
    try {
      await elevated((opts) => api.put('/api/settings/turnstile', {
        siteKey: siteKey.value.trim(), secret: secret.value.trim(), captchaToken,
      }, opts), 'ตั้งค่า captcha หน้าเข้าสู่ระบบ — ต้องยืนยันว่าเป็นคุณ');
      toast('เปิด captcha แล้ว — กลุ่ม Telegram ได้รับแจ้ง', 'success');
      modal.close();
      render();
    } catch (err) {
      fail(err.fullMessage ?? err.message);
      widget?.reset(); // token ใช้ไปแล้ว — ขอใบใหม่ไว้ กดทดสอบอีกครั้งได้เลย
    } finally {
      test.disabled = false;
    }
  };

  const onToken = (t) => {
    token = t;
    if (t && pending) {
      pending = false;
      token = null;
      save(t);
    }
  };

  test.addEventListener('click', async () => {
    errorBox.hidden = true;
    const key = siteKey.value.trim();
    if (!key || !secret.value.trim()) {
      fail('ใส่ทั้ง Site key และ Secret key');
      return;
    }
    if (key !== mountedKey) {
      // เปลี่ยน site key = วาดช่องใหม่ด้วยคีย์นั้น
      widget?.remove();
      widget = null;
      token = null;
      captchaBox.replaceChildren();
      captchaBox.hidden = false;
      mountedKey = key;
      try {
        widget = await mountCaptcha(captchaBox, {
          siteKey: key,
          action: 'setup',
          onToken,
          onError: (code) => fail(`ช่อง captcha ขึ้นไม่ได้ (รหัส ${code}) — ตรวจว่า site key ถูก และเพิ่มโดเมน ${location.hostname} ใน widget แล้ว`),
        });
      } catch (err) {
        mountedKey = null;
        captchaBox.hidden = true;
        fail(err.message);
        return;
      }
    }
    if (token) {
      const t = token;
      token = null;
      save(t);
    } else {
      pending = true;
    }
  });

  modal.body.append(
    el('ol', { class: 'steps' },
      el('li', {}, 'เข้า ', el('a', { href: 'https://dash.cloudflare.com', target: '_blank', rel: 'noopener' }, 'Cloudflare'),
        ' → Turnstile → Add widget · ใส่โดเมน ', el('strong', {}, location.hostname), ' · Widget mode เลือก Managed'),
      el('li', {}, 'คัดลอก Site key และ Secret key มาวางด้านล่าง'),
      el('li', {}, 'กด "ทดสอบและบันทึก" แล้วผ่านช่องที่ขึ้นมา — ระบบบันทึกให้เมื่อคีย์ใช้กับเว็บนี้ได้จริง')),
    // คีย์ทดสอบมีเลข 0 ยาวเหยียด คัดลอก/พิมพ์เองแล้วขาดไปตัวเดียว Cloudflare ก็ไม่รับ — กดปุ่มใส่ให้แทน
    local ? el('div', { class: 'notice-box channel-row' },
      el('span', { style: 'flex:1;min-width:220px' },
        'เครื่องทดสอบ (localhost): ใช้คีย์ทดสอบของ Cloudflare ได้ — ผ่านทุกครั้ง (เซิร์ฟเวอร์จริงไม่รับคีย์ชุดนี้)'),
      el('button', {
        class: 'btn ghost sm',
        onclick: () => {
          siteKey.value = '1x00000000000000000000AA';
          secret.value = '1x0000000000000000000000000000000AA';
          errorBox.hidden = true;
        },
      }, 'ใส่คีย์ทดสอบให้')) : '',
    el('div', { style: 'display:grid;gap:12px' },
      field('Site key', siteKey),
      field('Secret key', secret, ts.configured ? 'ต้องใส่ใหม่ทุกครั้ง — ระบบไม่ส่ง secret เดิมกลับมาที่หน้าเว็บ' : 'เก็บแบบเข้ารหัส ไม่แสดงอีก'),
      captchaBox,
      // ไว้ติดปุ่ม — ตาคนมองอยู่ที่ช่อง captcha กับปุ่มด้านล่าง ถ้าไว้บนสุดจะไม่เห็นว่าบันทึกไม่ผ่าน
      errorBox,
      el('div', { class: 'btn-row' }, test)));
}
