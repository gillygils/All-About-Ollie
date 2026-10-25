'use strict';

(() => {
  const root = document.getElementById('app');
  // state.live: hooks the open timeline and photo viewer register, so live updates can reach them
  const state = { user: null, site: null, days: new Map(), tlScroll: null, live: {} };

  const THEMES = [
    { id: 'cream', name: 'Cream', bg: '#faf5ec', text: '#3b2f28', dots: ['#d9774b', '#6f8f72', '#e6d9c6'] },
    { id: 'blush', name: 'Blush', bg: '#fbf1f1', text: '#3e2a2e', dots: ['#c9617a', '#6e8aa6', '#ecd5d8'] },
    { id: 'ocean', name: 'Ocean', bg: '#eef4f8', text: '#22323f', dots: ['#3f7fae', '#c47a54', '#d2e0ea'] },
    { id: 'sage', name: 'Sage', bg: '#f1f4ec', text: '#2d3427', dots: ['#5f8a55', '#b9774b', '#d9e0cf'] },
    { id: 'midnight', name: 'Midnight', bg: '#15171c', text: '#ece7df', dots: ['#f0a46f', '#9cc3a1', '#343a46'] },
  ];
  const EMOJI = ['⭐', '👶', '🎂', '🦷', '👣', '🍼', '🛁', '😴', '🧸', '🎉', '🎄', '🎃', '🏖️', '👵', '👴', '🏥', '❤️', '📸'];

  // ---------------------------------------------------------------- utilities

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const possessive = (name) => (/s$/i.test(name) ? `${name}’` : `${name}’s`);

  // A random id for this open page. Changes we make carry it, so live updates skip redrawing
  // only in this page — your phone and other tabs (same account) still update.
  const TAB_ID = Math.random().toString(36).slice(2, 12);

  async function api(url, { method = 'GET', body } = {}) {
    const isForm = body instanceof FormData;
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'X-Tab': TAB_ID, ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: body && !isForm ? JSON.stringify(body) : body,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data?.message || 'Something went wrong.');
      err.status = res.status;
      if (res.status === 401 && (data?.error === 'pin' || data?.error === 'login')) {
        err.handled = true; // the lock screen takes over
        boot();
      }
      throw err;
    }
    return data;
  }
  const oops = (e) => { if (!e.handled) toast(e.message, true); };

  function toast(msg, isError = false) {
    const t = document.createElement('div');
    t.className = `toast${isError ? ' err' : ''}`;
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), isError ? 5000 : 3000);
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    const custom = String(theme || '').startsWith('custom:') ? state.user?.customThemes?.find((t) => `custom:${t.id}` === theme) : null;
    const vars = custom ? themeVars(custom.colors) : null;
    paintThemeVars(vars);
    root.dataset.theme = custom ? 'custom' : THEMES.some((t) => t.id === theme) ? theme : 'cream';
    // remembered on this device so the next visit starts in the right colours (see index.html)
    try {
      localStorage.setItem('sb_theme', root.dataset.theme);
      localStorage.setItem('sb_theme_vars', vars ? JSON.stringify(vars) : '');
    } catch { /* private mode */ }
  }

  // ---- your own themes: six colours picked by a person; everything else is worked out from them,
  // so text, borders and polaroid writing always stay easy to read.
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const rgbHex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
  const mixHex = (a, b, t) => { const x = hexRgb(a), y = hexRgb(b); return rgbHex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lum = (h) => {
    const [r, g, b] = hexRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  // whichever of white or near-black text reads better on this colour
  const inkOn = (bg) => ((1.05 / (lum(bg) + 0.05)) >= ((lum(bg) + 0.05) / 0.057) ? '#ffffff' : '#1b1309');
  const autoPolaroidInk = (frame) => (inkOn(frame) === '#ffffff' ? '#ffffff' : '#3b2f28');
  function themeVars(c) {
    const dark = lum(c.bg) < 0.18;
    const text = dark ? mixHex(c.bg, '#ffffff', 0.9) : mixHex(c.bg, '#000000', 0.8);
    const shade = dark ? '0, 0, 0' : hexRgb(mixHex(c.accent, '#000000', 0.6)).join(', ');
    return {
      '--bg': c.bg, '--bg-2': mixHex(c.bg, text, 0.05),
      '--surface': dark ? mixHex(c.bg, '#ffffff', 0.07) : mixHex(c.bg, '#ffffff', 0.7), '--surface-2': mixHex(c.bg, text, dark ? 0.1 : 0.045),
      '--text': text, '--muted': mixHex(c.bg, text, 0.55), '--line': mixHex(c.bg, text, 0.14),
      '--accent': c.accent, '--accent-ink': inkOn(c.accent), '--accent-soft': mixHex(c.bg, c.accent, dark ? 0.25 : 0.2),
      '--event': c.event, '--event-soft': mixHex(c.bg, c.event, dark ? 0.2 : 0.17), '--danger': dark ? '#ef7b6c' : '#c0493b',
      '--shadow': dark ? '0 1px 2px rgba(0, 0, 0, .3), 0 10px 28px rgba(0, 0, 0, .35)' : `0 1px 2px rgba(${shade}, .08), 0 8px 24px rgba(${shade}, .08)`,
      '--paper': dark ? '#f5f1ea' : '#ffffff',
      // the cork photo is grey and multiplied by --cork, which darkens it (≈ 0.843), so lighten to match the pick
      '--cork': rgbHex(hexRgb(c.cork).map((v) => v / 0.843)), '--wood': c.frame || mixHex(c.cork, '#000000', 0.6), '--wood-2': c.frame ? mixHex(c.frame, '#ffffff', 0.2) : mixHex(c.cork, '#000000', 0.45),
      '--pin': c.accent, '--twine': c.twine,
      '--polaroid': c.polaroid, '--polaroid-ink': c.polaroidInk || autoPolaroidInk(c.polaroid),
      '--date-bg': c.date || '#fffdf6', '--date-ink': c.dateInk || '#3b2f28', '--date-muted': mixHex(c.date || '#fffdf6', c.dateInk || '#3b2f28', 0.62),
      'color-scheme': dark ? 'dark' : 'light',
    };
  }
  const THEME_VAR_NAMES = Object.keys(themeVars({ bg: '#ffffff', accent: '#000000', event: '#000000', cork: '#888888', frame: '#444444', polaroid: '#ffffff', polaroidInk: '#000000', twine: '#ffffff', date: '#ffffff', dateInk: '#000000' }));
  function paintThemeVars(vars) {
    const root = document.documentElement;
    THEME_VAR_NAMES.forEach((k) => root.style.removeProperty(k));
    if (vars) Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
  }
  const isDarkTheme = () => getComputedStyle(document.documentElement).colorScheme.includes('dark');

  // A random palette that hangs together: one base hue, the event colour from a related or opposite
  // hue, soft backgrounds — and now and then a dark theme.
  function hslHex(h, sat, l) {
    h = ((h % 360) + 360) % 360; sat /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = sat * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return rgbHex([f(0), f(8), f(4)].map((v) => v * 255));
  }
  function randomPalette() {
    const r = (a, b) => a + Math.random() * (b - a);
    const h = r(0, 360);
    const eh = h + [r(150, 210), 120, -120, r(30, 50)][Math.floor(r(0, 4))]; // opposite, triadic or neighbouring
    if (Math.random() < 0.2) {
      return { bg: hslHex(h, r(12, 22), r(8, 12)), accent: hslHex(h, r(60, 80), r(62, 70)), event: hslHex(eh, r(35, 55), r(62, 72)),
        cork: hslHex(h + r(-15, 15), r(12, 25), r(26, 34)), frame: hslHex(h + r(-15, 15), r(8, 18), r(10, 15)), polaroid: hslHex(h, r(5, 10), r(22, 27)), polaroidInk: hslHex(h, r(10, 25), r(90, 95)), twine: hslHex(h, r(8, 15), r(58, 66)),
        date: hslHex(h, r(8, 14), r(17, 21)), dateInk: hslHex(h, r(20, 35), r(88, 93)) };
    }
    return { bg: hslHex(h, r(30, 50), r(95, 97)), accent: hslHex(h, r(50, 70), r(45, 55)), event: hslHex(eh, r(30, 50), r(45, 55)),
      cork: hslHex(h + r(-20, 20), r(35, 60), r(68, 80)), frame: hslHex(h + r(-20, 20), r(25, 45), r(28, 40)), polaroid: hslHex(h, r(35, 60), r(90, 94)), polaroidInk: hslHex(h, r(25, 45), r(16, 24)), twine: hslHex(h, r(25, 40), r(93, 96)),
      date: hslHex(h, r(40, 70), r(97, 99)), dateInk: hslHex(h, r(25, 45), r(16, 24)) };
  }

  // Dates are plain "YYYY-MM-DD" strings; build them in local time so nothing shifts a day.
  const pad = (n) => String(n).padStart(2, '0');
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmt = (s, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => toDate(s).toLocaleDateString(undefined, opts);
  const fmtLong = (s) => fmt(s, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  function age(dateStr) {
    const b = state.site?.birthDate;
    if (!b) return '';
    const d = toDate(dateStr);
    const bd = toDate(b);
    const days = Math.round((d - bd) / 86400000);
    if (days === 0) return 'Birth day';
    if (days < 0) {
      const w = Math.round(-days / 7);
      return w >= 2 ? `${w} weeks before birth` : `${plural(-days, 'day')} before birth`;
    }
    if (days < 14) return `${plural(days, 'day')} old`;
    let months = (d.getFullYear() - bd.getFullYear()) * 12 + d.getMonth() - bd.getMonth();
    if (d.getDate() < bd.getDate()) months--;
    if (months < 2) return `${Math.floor(days / 7)} weeks old`;
    if (months < 24) return `${months} months old`;
    const y = Math.floor(months / 12);
    const m = months % 12;
    return m ? `${y} yrs ${m} mo old` : `${y} years old`;
  }

  // Wire a form: disables the button while working and shows errors in its .error line.
  function onSubmit(form, handler) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = $('[type=submit]', form);
      const errEl = $('.error', form);
      if (errEl) errEl.textContent = '';
      if (btn) btn.disabled = true;
      try {
        await handler(Object.fromEntries(new FormData(form)));
      } catch (e) {
        if (!e.handled) { if (errEl) errEl.textContent = e.message; else toast(e.message, true); }
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  // Swipe right to go back, like iPhone apps (touch screens only — touch events never fire for a mouse).
  // Only a clearly sideways swipe counts, so scrolling up and down is untouched. In Safari itself (not
  // the home-screen app), swipes starting at the very left edge are left to Safari's own back gesture.
  const STANDALONE = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  function swipeBack(el, onBack) {
    let s = null;
    el.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      s = null;
      if (e.touches.length !== 1 || (!STANDALONE && t.clientX < 24)) return;
      if (e.target.closest('input, textarea, select, video')) return;
      s = { x: t.clientX, y: t.clientY, t: performance.now(), on: false, dx: 0 };
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!s) return;
      const t = e.touches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (!s.on) {
        if (dx > 14 && Math.abs(dy) < dx * 0.55) { s.on = true; el.style.transition = 'none'; } // sideways: it's a swipe
        else if (Math.abs(dy) > 10 || dx < -10) { s = null; return; }                       // scrolling: leave it
        else return;
      }
      e.preventDefault();
      s.dx = Math.max(0, dx);
      el.style.transform = `translateX(${s.dx}px)`;
      el.style.opacity = String(1 - Math.min(0.5, s.dx / (el.offsetWidth * 2)));
    }, { passive: false });
    const end = () => {
      if (!s?.on) { s = null; return; }
      const fast = s.dx / Math.max(1, performance.now() - s.t) > 0.5 && s.dx > 40;
      el.style.transition = 'transform .22s ease, opacity .22s ease';
      if (s.dx > el.offsetWidth * 0.3 || fast) {
        el.style.transform = `translateX(${el.offsetWidth}px)`;
        el.style.opacity = '0';
        setTimeout(onBack, 200);
      } else {
        el.style.transform = '';
        el.style.opacity = '';
      }
      s = null;
    };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
  }

  // Back to the page you came from (timeline or the Events list), or `fallback` if you landed here directly.
  let inAppSteps = 0;
  window.addEventListener('hashchange', () => { inAppSteps++; });
  const goBack = (fallback) => { if (inAppSteps > 0) history.back(); else location.hash = fallback; };

  function modal(inner, { cls = '', z, onClose } = {}) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    if (z) back.style.zIndex = z;
    back.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true">${inner}</div>`;
    document.body.appendChild(back);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const backs = $$('.modal-back');
      if (backs[backs.length - 1] !== back) return; // only the top-most closes
      if ($('.lb') && !z) return; // let the photo viewer handle it
      close();
    };
    function close() { back.remove(); document.removeEventListener('keydown', onKey); onClose?.(); }
    document.addEventListener('keydown', onKey);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    $$('[data-close]', back).forEach((b) => { b.onclick = close; });
    setTimeout(() => $('input:not([type=hidden]):not([type=file]), select, textarea', back)?.focus(), 30);
    return { el: $('.modal', back), close };
  }

  const head = (title, sub = '') => `
    <div class="modal-head">
      <div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>
      <button class="btn icon ghost" type="button" data-close aria-label="Close">✕</button>
    </div>`;

  // ---------------------------------------------------------------- boot & lock screens

  async function boot() {
    let s;
    try { s = await api('/api/status'); } catch {
      root.innerHTML = '<div class="loading">Can’t reach the scrapbook right now. Try refreshing.</div>';
      return;
    }
    state.user = s.user;
    state.site = s.site;
    stopLive();
    $$('.modal-back, .lb').forEach((el) => el.remove());
    if (s.user) applyTheme(s.user.theme);
    if (s.setupNeeded) return renderSetup();
    if (!s.pinOk) return renderPin();
    if (!s.user) return renderAuth();
    renderShell();
    route();
    startLive();
    showInstallBar();
    setTimeout(() => showNews(), 900); // after the page has settled
  }

  // ---------------------------------------------------------------- what's new
  // A short note shown once to each person after an update, newest first. To announce something,
  // add an entry at the top with a new id (any short text, e.g. the date). `admin: true` items are
  // only shown to admins.
  const NEWS = [
    {
      id: '2026-10-26',
      title: 'What’s new in the scrapbook',
      items: [
        { icon: '🎨', text: '<b>Make your own colours.</b> Settings → Theme → <b>＋</b>. Pick your colours or roll the dice for a random palette.' },
        { icon: '🖼️', text: '<b>Photos open as polaroids</b>, and show who posted them.' },
        { icon: '🔔', text: '<b>Notifications</b> when new photos are added or someone comments on yours. Turn them on in Settings → Notifications.' },
        { icon: '📱', text: '<b>Add it to your phone</b> like an app: Settings → App shows how.' },
        { icon: '😀', text: '<b>Every emoji for events</b>, with search: tap <b>＋ More</b> when making an event.' },
        { icon: '📌', text: '<b>Add earlier photos to an event</b>: “From this day” on the event, or 📌 Event on a photo.' },
        { icon: '🧭', text: '<b>Smoother timeline</b>: swiping is easier and it reopens where you left off.' },
        { icon: '✋', text: '<b>Move loose photos</b>: press and hold one on the Days view, then drag it.', admin: true },
      ],
    },
  ];
  function showNews(force = false) {
    const note = NEWS[0];
    if (!note || !state.user) return;
    if (!force && (state.user.newsSeen === note.id || $('.modal-back') || $('.lb'))) return;
    const items = note.items.filter((it) => !it.admin || state.user.isAdmin);
    const m = modal(`
      <div class="news">
        <span class="pin" aria-hidden="true"></span>
        <div class="news-head"><span class="news-spark" aria-hidden="true">✨</span><h2>${esc(note.title)}</h2></div>
        <ul>${items.map((it) => `<li><span class="news-icon" aria-hidden="true">${it.icon}</span><span>${it.text}</span></li>`).join('')}</ul>
        <div class="row end"><button type="button" class="btn primary" data-close>Got it</button></div>
      </div>`, {
      cls: 'news-modal',
      onClose: () => {
        if (state.user.newsSeen === note.id) return;
        state.user.newsSeen = note.id;
        api('/api/me', { method: 'PATCH', body: { newsSeen: note.id } }).catch(() => { /* shown again next time */ });
      },
    });
    return m;
  }

  const gate = (inner, wide = false) => {
    root.innerHTML = `<div class="gate"><div class="gate-card${wide ? ' wide' : ''}">${inner}</div></div>`;
  };

  function renderSetup() {
    gate(`
      <div class="gate-badge">🧸</div>
      <h1>Let’s set up the scrapbook</h1>
      <p>You’ll be the admin. Family will need the PIN you choose here, plus their own account.</p>
      <form class="form" autocomplete="off">
        <label class="field">Setup code <span class="hint">Shown in the window where the server is running.</span>
          <input type="text" name="setupCode" inputmode="numeric" required></label>
        <h3>The little one</h3>
        <div class="grid-2">
          <label class="field">Baby’s name<input type="text" name="babyName" maxlength="60" required></label>
          <label class="field">Birth date <span class="hint">Optional — adds ages to the timeline</span><input type="date" name="birthDate"></label>
        </div>
        <h3>Your admin account</h3>
        <div class="grid-2">
          <label class="field">Your name<input type="text" name="displayName" maxlength="60" placeholder="Dad" required></label>
          <label class="field">Email <span class="hint">Optional</span><input type="email" name="email" maxlength="200"></label>
          <label class="field">Username<input type="text" name="username" autocomplete="username" maxlength="32" required></label>
          <label class="field">Password <span class="hint">8+ characters</span><input type="password" name="password" autocomplete="new-password" required></label>
        </div>
        <h3>Family PIN</h3>
        <div class="grid-2">
          <label class="field">PIN <span class="hint">4–12 digits (6+ is safer)</span><input type="password" name="pin" inputmode="numeric" pattern="\\d{4,12}" required></label>
          <label class="field">Confirm PIN<input type="password" name="pin2" inputmode="numeric" required></label>
        </div>
        <p class="error"></p>
        <button class="btn primary" type="submit">Create the scrapbook</button>
      </form>`, true);
    onSubmit($('form', root), async (f) => {
      if (f.pin !== f.pin2) throw new Error('The two PINs don’t match.');
      await api('/api/setup', { method: 'POST', body: f });
      state.tlScroll = null;
      boot();
    });
  }

  function renderPin() {
    gate(`
      <div class="gate-badge">🔒</div>
      <h1>Family only</h1>
      <p>Enter the family PIN to open the scrapbook.</p>
      <form class="form" autocomplete="off">
        <input class="pin-input" type="password" name="pin" inputmode="numeric" autocomplete="off" maxlength="12" aria-label="Family PIN" required>
        <p class="error"></p>
        <button class="btn primary" type="submit">Unlock</button>
      </form>`);
    $('input', root).focus();
    onSubmit($('form', root), async (f) => {
      await api('/api/pin', { method: 'POST', body: f });
      boot();
    });
  }

  function renderAuth(mode = 'login') {
    const name = state.site?.babyName || 'Baby';
    gate(`
      <div class="gate-badge">🧸</div>
      <h1>${esc(possessive(name))} Scrapbook</h1>
      <p>${mode === 'login' ? 'Welcome back! Log in to see and share photos.' : 'Make your own account so everyone knows who shared what.'}</p>
      <div class="tabs"><button data-mode="login" class="${mode === 'login' ? 'on' : ''}">Log in</button><button data-mode="register" class="${mode === 'register' ? 'on' : ''}">Create account</button></div>
      <form class="form">
        ${mode === 'register' ? `
          <label class="field">Your name <span class="hint">What the family calls you — “Grandma Sue”</span><input type="text" name="displayName" maxlength="60" required></label>
          <label class="field">Email <span class="hint">Optional</span><input type="email" name="email" maxlength="200"></label>` : ''}
        <label class="field">Username<input type="text" name="username" autocomplete="username" maxlength="32" required></label>
        <label class="field">Password${mode === 'register' ? ' <span class="hint">8+ characters</span>' : ''}<input type="password" name="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required></label>
        <p class="error"></p>
        <button class="btn primary" type="submit">${mode === 'login' ? 'Log in' : 'Create account'}</button>
        ${mode === 'login' ? '<p class="muted small" style="margin:0">Forgot your password? Ask the admin to reset it.</p>' : ''}
      </form>`);
    $$('.tabs button', root).forEach((b) => { b.onclick = () => renderAuth(b.dataset.mode); });
    onSubmit($('form', root), async (f) => {
      await api(mode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body: f });
      state.tlScroll = null;
      boot();
    });
  }

  // ---------------------------------------------------------------- shell & routing

  function renderShell() {
    root.innerHTML = `
      <header class="topbar">
        <a class="brand" href="#/timeline"><span class="brand-mark">🧸</span><h1>${esc(possessive(state.site.babyName))} Scrapbook</h1></a>
        <nav class="nav">
          <a href="#/timeline" data-tab="timeline"><span class="ico">🗓️</span><span>Timeline</span></a>
          <a href="#/events" data-tab="events"><span class="ico">🎈</span><span>Events</span></a>
          <a href="#/settings" data-tab="settings"><span class="ico">⚙️</span><span>Settings</span></a>
        </nav>
      </header>
      <main id="main"></main>
      <button class="btn primary fab" id="fab" aria-label="Add photos">＋<span class="fab-label"> Add photos</span></button>`;
    $('#fab').onclick = () => {
      const [tab, id] = currentRoute();
      openUpload(tab === 'events' && id ? { eventId: Number(id) } : {});
    };
  }

  const currentRoute = () => (location.hash.replace(/^#\/?/, '') || 'timeline').split('/');

  async function route(opts = {}) {
    const main = $('#main');
    if (!main) return;
    const [tab, id] = currentRoute();
    const adminPage = tab === 'manage' || tab === 'trace'; // pages reached from Settings
    $$('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (adminPage ? 'settings' : tab)));
    $('#fab').classList.toggle('hidden', tab === 'settings' || adminPage);
    if (!quietRefresh) main.className = '';
    try {
      if (tab === 'events' && id) await viewEvent(main, Number(id));
      else if (tab === 'events') await viewEvents(main);
      else if (tab === 'settings') await viewSettings(main);
      else if (tab === 'manage') await viewManage(main);
      else if (tab === 'trace') await viewTrace(main);
      else if (tab === 'timeline' && /^\d{4}-\d\d-\d\d$/.test(id || '')) {
        history.replaceState(null, '', '#/timeline'); // (from a notification) open the board at that day
        await viewTimeline(main, { ...opts, focusDate: id });
      } else await viewTimeline(main, opts);
    } catch (e) {
      if (!e.handled) main.innerHTML = `<div class="empty"><div class="big">😕</div><h3>Couldn’t load this page</h3><p>${esc(e.message)}</p></div>`;
    }
  }
  window.addEventListener('hashchange', () => { if (state.user) { window.scrollTo(0, 0); route(); } });

  const loading = (main, msg = 'Loading memories…') => {
    if (quietRefresh) return; // a live update redraws in place, without flashing "Loading…"
    main.innerHTML = `<div class="loading" style="min-height:40vh">${msg}</div>`;
  };

  // ---------------------------------------------------------------- live updates
  // The server sends a short notice whenever something changes. We then redraw the current page
  // in place — but never while someone is swiping, zooming, or has a photo or dialog open.
  let liveSource = null;
  let livePending = false;
  let liveTimer = 0;
  let quietRefresh = false;

  function startLive() {
    stopLive();
    liveSource = new EventSource('/api/live');
    liveSource.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      onLive(msg);
    };
    // Phones drop the connection when locked or in the background, and notices sent meanwhile are
    // missed. When it reconnects, refresh once to catch up.
    let connectedBefore = false;
    liveSource.onopen = () => {
      if (connectedBefore) { livePending = true; applyLive(); }
      connectedBefore = true;
    };
  }
  function stopLive() {
    liveSource?.close();
    liveSource = null;
    clearTimeout(liveTimer);
    livePending = false;
  }

  // The version of the site this page is running (stamped in by the server). Every time the live
  // connection opens, the server says which version is current; if we're behind — the site was
  // updated, or a home-screen shortcut woke up with old code — reload once it's safe.
  const PAGE_BUILD = document.querySelector('meta[name=build]')?.content || null;
  function reloadWhenSafe(build) {
    // once per new version: if a reload didn't pick it up (a cached page), don't keep reloading
    try {
      if (sessionStorage.getItem('sb_reloaded_for') === build) return;
    } catch { /* private mode */ }
    const busy = document.hidden || $('.lb') || $('.modal-back') || state.live.timelineBusy?.();
    if (busy) { setTimeout(() => reloadWhenSafe(build), 2000); return; } // not mid-upload, mid-comment or mid-swipe
    try { sessionStorage.setItem('sb_reloaded_for', build); } catch { /* private mode */ }
    location.reload();
  }

  function onLive(msg) {
    if (msg.type === 'hello') {
      if (PAGE_BUILD && msg.build && msg.build !== PAGE_BUILD) reloadWhenSafe(msg.build);
      return;
    }
    const thisPage = msg.tab && msg.tab === TAB_ID; // made right here — already on screen
    if (msg.type === 'photos' && !thisPage) {
      const n = msg.count === 1 ? 'a new memory' : `${msg.count} new memories`;
      toast(msg.from === state.user?.id ? `📸 ${n[0].toUpperCase()}${n.slice(1)} from your other device` : `📸 ${msg.by} added ${n}`);
    }
    // an open photo updates itself straight away (comments, hearts, a video finishing)
    if (msg.type === 'social' && !thisPage) state.live.onSocial?.(msg.id);
    if (msg.type === 'photo') state.live.onPhoto?.(msg.id, msg.removed);
    if (thisPage && msg.type !== 'photo') return;
    livePending = true;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(applyLive, 600); // a burst of notices → one redraw
  }

  async function applyLive() {
    if (!livePending || !state.user) return;
    // Settings has nothing live; Manage photos would lose your selection if it redrew
    if (['settings', 'manage', 'trace'].includes(currentRoute()[0])) { livePending = false; return; }
    const busy = document.hidden || $('.lb') || $('.modal-back') || state.live.timelineBusy?.();
    if (busy) { liveTimer = setTimeout(applyLive, 1000); return; } // try again once they're done
    livePending = false;
    quietRefresh = true;
    try { await route(); } finally { quietRefresh = false; }
  }
  // Back on the page after a while away (another tab, phone locked)? Refresh once in case anything was missed.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 20000) livePending = true;
    applyLive();
  });

  // ---------------------------------------------------------------- timeline

  // The timeline is a cork board you zoom through like Apple Photos: Years → Months → Weeks → Days.
  // Each level is a row of polaroid stacks. Zooming scales the current row around your fingers;
  // between two levels both rows are drawn, cross-fading, with the stack you're on lined up with
  // the one that holds it — so nothing slides. Letting go settles on the nearest level.
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const mondayOf = (s) => { const d = toDate(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoOf(d); };
  const fmtDur = (sec) => { sec = Math.round(sec || 0); return `${Math.floor(sec / 60)}:${pad(sec % 60)}`; };
  const ZOOM_LEVELS = [
    { name: 'Years', key: (d) => d.slice(0, 4), label: (g) => g.start.slice(0, 4), sub: (g) => `${plural(g.dayCount, 'day')} of memories` },
    { name: 'Months', key: (d) => d.slice(0, 7), label: (g) => fmt(g.start, { month: 'long', year: 'numeric' }), sub: (g) => age(g.start) },
    {
      name: 'Weeks', key: mondayOf, sub: (g) => age(g.start),
      label: (g) => {
        const m = toDate(g.k);
        const e = new Date(m); e.setDate(e.getDate() + 6);
        return `${m.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString(undefined, m.getMonth() === e.getMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}`;
      },
    },
    {
      name: 'Days', key: (d) => d, sub: (g) => age(g.start) || fmt(g.start, { weekday: 'long' }),
      label: (g) => fmt(g.start, { month: 'short', day: 'numeric', ...(g.start.slice(0, 4) === todayISO().slice(0, 4) ? {} : { year: 'numeric' }) }),
    },
  ];
  const MAXL = ZOOM_LEVELS.length - 1;
  const W = 250;          // spacing between stacks at full size
  const G = 1.9;          // how much a row grows before it has become the next level
  const F_MIN = -0.3;     // a little extra zoom out past Years …
  const F_MAX = 0.35;     // … and in past Days (both spring back)

  function buildGroups(days) {
    return ZOOM_LEVELS.map((Z) => {
      const out = [];
      for (const d of days) {
        const k = Z.key(d.date);
        let g = out[out.length - 1];
        if (!g || g.k !== k) {
          out.push(g = { k, start: d.date, end: d.date, previews: [], eventPreviews: [], loose: [], looseCount: 0, byEvent: [], events: [], photoCount: 0, videoCount: 0, dayCount: 0 });
        }
        g.end = d.date;
        g.previews.push(...d.previews);
        g.eventPreviews.push(...d.eventPreviews);
        g.loose.push(...d.loose);
        g.looseCount += d.looseCount;
        g.byEvent.push(...(d.byEvent || []));
        g.events.push(...d.events);
        g.photoCount += d.photoCount; g.videoCount += d.videoCount; g.dayCount++;
      }
      return out;
    });
  }

  // Where a loose photo lands around its day: scattered anywhere around the date on a jittered spiral,
  // seeded by the photo's id so it lands in the same spot every visit. An event day's loose photos go
  // on the other side of the twine from its event stack; a day without one uses both sides.
  // `block` says where the neighbouring days' event stacks are ({ l, r }: 'A' above the twine, 'B'
  // below, or nothing); photos on that half keep their distance so they never land on a stack.
  // x is from the day's centre; y is the photo's top, from the scatter's anchor 60px below the twine.
  let boardTwine = 200;
  function scatterSpot(id, k, ring, flip = false, block = {}) {
    let s = (id * 7919) % 233280;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const rot = (rnd() - 0.5) * 26;
    const own = flip ? 'A' : ring ? 'B' : null;          // which half the day's own event stack is on
    const half = own === 'A' ? 'B' : own === 'B' ? 'A' : (k % 2 ? 'A' : 'B');
    const j = own ? k : Math.floor(k / 2);               // its place among the photos on that half
    const [top, bottom] = half === 'A' ? [-(boardTwine + 50), -154] : [-70, 108]; // photos are ~124px tall
    const reachL = block.l === half ? 70 : 150;
    const reachR = block.r === half ? 70 : 150;
    const a = j * 2.39996 + rnd() * 0.9;                 // golden-angle spiral out from the date
    const r = 0.25 + 0.75 * Math.sqrt((j + rnd() * 0.6) / 7);
    let x = Math.max(-reachL, Math.min(reachR, Math.cos(a) * r * 150));
    let y = Math.max(top, Math.min(bottom, (top + bottom) / 2 + Math.sin(a) * r * (bottom - top) / 2 + (rnd() - 0.5) * 20));
    // Keep clear of the date card and the badge on the twine (they'd sit on top of the photo):
    // nudge the photo past whichever edge of them is closest — left, right, or away from the twine.
    const card = flip ? [-83, 36] : [-158, -36];         // their top and bottom, by the same measure as y
    if ((half === 'B') === flip && Math.abs(x) < 122 && y < card[1] && y + 130 > card[0]) {
      const moves = [{ x, y: half === 'A' ? card[0] - 130 : card[1] + 4 }];
      if (reachR >= 124) moves.push({ x: 124, y });
      if (reachL >= 124) moves.push({ x: -124, y });
      ({ x, y } = moves.reduce((m, c) => (Math.hypot(c.x - x, c.y - y) < Math.hypot(m.x - x, m.y - y) ? c : m)));
    }
    return { x, y, rot };
  }

  // Every day's loose photos on the Days view, laid out left to right so they can look at what's
  // already placed. Each photo starts at its usual spot (scatterSpot) and, if that would land on a
  // stack, a date card or event names (its own day's or a neighbour's) or leave less than 60% of any
  // photo already placed showing (counting everything on top of it), spirals out from its date —
  // above or below the twine, further to the sides — until it finds a spot that doesn't. On a day
  // too crowded for that, its photos are pinned up a little smaller (`scale`) so they still fit.
  // None is ever left off.
  // `days[i]` is { g, stack } with stack 'A' (above the twine), 'B' (below) or null.
  // ---- the rules every loose photo follows, placed automatically or moved by an admin.
  // Coordinates are a day's own: x from its centre line, y as scatterSpot's (a photo's top).
  const DAY_W = 250;   // days are this far apart; each day's area reaches halfway to the next
  // What a loose photo may never cover around one day: its date card (and badge), its event
  // names and its event stack. `d` is { g, stack } with stack 'A' (above the twine), 'B' or null.
  function looseBlockers(d) {
    if (!d) return [];
    const tw = boardTwine;
    const wide = d.g.byEvent.length > 1 ? 142 : 110;  // fanned-out stacks reach further
    if (d.stack === 'A') return [[-62, 62, -80, 33], [-102, 102, -103, -78], [-wide, wide, -(tw + 62), -119]];
    if (d.stack === 'B') return [[-62, 62, -155, -37], [-102, 102, -37, 12], [-wide, wide, 11, 240]];
    return [[-62, 62, -155, -52]];
  }
  // ...for a day and both its neighbours, in that day's coordinates
  const looseWalls = (days, i) => [...looseBlockers(days[i]),
    ...looseBlockers(days[i - 1]).map((r) => [r[0] - DAY_W, r[1] - DAY_W, r[2], r[3]]),
    ...looseBlockers(days[i + 1]).map((r) => [r[0] + DAY_W, r[1] + DAY_W, r[2], r[3]])];
  // A photo is a box around (x, y + 62), 120 × 132 at full size (a little more than the polaroid,
  // to allow for its tilt), shrunk by its scale.
  const photoBox = (o) => [o.x - 60 * o.scale, o.x + 60 * o.scale, o.y + 62 - 66 * o.scale, o.y + 62 + 66 * o.scale];
  const boxHits = (b, r) => b[1] > r[0] + 4 && b[0] < r[1] - 4 && b[3] > r[2] + 4 && b[2] < r[3] - 4;
  // A photo may hang out of its own day's area by up to ¾ of its width — a quarter always stays in.
  const inDayArea = (o) => Math.abs(o.x) <= DAY_W / 2 + 28 * o.scale; // 112px polaroid: half is 56, a quarter 28
  const onBoard = (o) => { const b = photoBox(o); return b[2] >= -(boardTwine + 54) && b[3] <= 240; };
  // Everything at once: can this photo go here?
  const looseSpotOK = (o, walls) => inDayArea(o) && onBoard(o) && !walls.some((r) => boxHits(photoBox(o), r));

  function planLoose(days) {
    const W = DAY_W;
    const box = photoBox;
    // a photo's 6 × 6 sample points, for measuring how much of it still shows
    const pts = (o) => {
      const [x0, x1, y0, y1] = box(o);
      const a = [];
      for (let u = 0; u < 6; u++) for (let v = 0; v < 6; v++) a.push([x0 + (x1 - x0) * (u + 0.5) / 6, y0 + (y1 - y0) * (v + 0.5) / 6]);
      return a;
    };
    const covers = (o, [px, py]) => { const b = box(o); return px > b[0] && px < b[1] && py > b[2] && py < b[3]; };
    let prev = [];                                         // the previous day's photos, in its own coordinates
    return days.map((d, i) => {
      if (!d.g.loose?.length) { prev = []; return []; }
      const ring = d.stack === 'B', flip = d.stack === 'A';
      const block = { l: days[i - 1]?.stack, r: days[i + 1]?.stack };
      const walls = looseWalls(days, i);
      const placed = prev.map((o) => ({ ...o, x: o.x - W })); // everything already down, bottom first
      const own = [];
      // photos an admin moved stay exactly where they were put, and the rest keep clear of them
      // (a saved spot that's now against the rules — say an event was added nearby — is placed automatically)
      const fixed = new Map(d.g.loose.filter((p) => p.posX != null)
        .map((p) => [p.id, { x: p.posX, y: p.posY, rot: ((p.id * 37) % 21) - 10, scale: 1, clear: 1 }])
        .filter(([, o]) => looseSpotOK(o, walls)));
      placed.push(...fixed.values());
      own.push(...fixed.values());
      const dateY = flip ? -40 : -110;                     // where its date card sits (photo-top terms)
      const spots = d.g.loose.map((p, k) => {
        if (fixed.has(p.id)) return fixed.get(p.id);
        // the still-visible sample points of each photo already down
        const shown = placed.map((o, n) => pts(o).filter((q) => !placed.slice(n + 1).some((u) => covers(u, q))));
        let best = null;
        for (const scale of [1, 0.85, 0.72]) {
          let s = (p.id * 7919 + 17) % 233280;
          const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
          for (let t = 0; t < 160; t++) {
            let c;
            if (t === 0) c = { ...scatterSpot(p.id, k, ring, flip, block), scale };
            else {
              const a = rnd() * 2 * Math.PI, r = 60 + t * 1.6;  // ever wider around the date
              c = { x: Math.cos(a) * r * 1.2, y: dateY + Math.sin(a) * r, rot: (rnd() - 0.5) * 26, scale };
            }
            if (!looseSpotOK(c, walls)) continue;
            // the new photo goes on top: how much of the least visible photo underneath would still show?
            const clear = shown.reduce((m, left) => Math.min(m, left.filter((q) => !covers(c, q)).length / 36), 1);
            if (!best || clear > best.clear + 0.05) best = { ...c, clear }; // a smaller size has to be clearly better
            if (clear >= 0.6) break;
          }
          if (best && best.clear >= 0.6) break;
        }
        if (!best) { // nowhere free at all: its usual spot, kept in its day's area
          const c = scatterSpot(p.id, k, ring, flip, block);
          best = { ...c, x: Math.max(-153, Math.min(153, c.x)), scale: 1, clear: 0 };
        }
        placed.push(best);
        own.push(best);
        return best;
      });
      prev = own;
      return spots;
    });
  }

  // Which event's stack is in front, for days with several events — each person's own choice,
  // remembered on this device (date → event id). Loaded per user when the timeline opens.
  let frontMap = {};
  const frontKey = () => `sb_front_${state.user?.id}`;
  function loadFront() { try { frontMap = JSON.parse(localStorage.getItem(frontKey()) || '{}'); } catch { frontMap = {}; } }
  function saveFront() { try { localStorage.setItem(frontKey(), JSON.stringify(frontMap)); } catch { /* private mode */ } }
  // The day's events with photos, front one first.
  function eventOrder(g) {
    const ids = g.byEvent.map((b) => b.eventId);
    const i = Math.max(0, ids.indexOf(frontMap[g.start]));
    return [...ids.slice(i), ...ids.slice(0, i)];
  }

  function stackHTML(g, l, flip = false, spots = []) {
    const Z = ZOOM_LEVELS[l];
    // On the Days view, photos without an event are scattered loose around the day; event photos stay stacked.
    const scatter = l === MAXL && g.looseCount > 0;
    const multi = l === MAXL && g.byEvent.length > 1; // several events that day: one stack each, piled up
    const order = multi ? eventOrder(g) : [];
    const stackOf = scatter ? g.eventPreviews : g.previews;
    const pol = (p, cls, front) => `<div class="pol ${cls}">${front ? '<span class="pin"></span>' : ''}
      <div class="ph"><img src="/media/thumb/${p.id}" alt="" loading="lazy" draggable="false">${p.kind === 'video' ? `<span class="play">▶</span>${p.duration ? `<span class="dur">${fmtDur(p.duration)}</span>` : ''}` : ''}</div>
      ${front ? `<div class="cap">${esc(p.caption || '')}</div>` : ''}</div>`;
    const countOf = (o) => [o.photoCount && plural(o.photoCount, 'photo'), o.videoCount && plural(o.videoCount, 'video')].filter(Boolean).join(' · ');
    const pile = (previews, tag) => {
      const top = previews.find((p) => p.kind === 'video') || previews[0]; // a video always goes on top
      const under = previews.filter((p) => p !== top).slice(0, 2);
      return `${under[1] ? pol(under[1], 'a') : ''}${under[0] ? pol(under[0], 'b') : ''}${pol(top, 'c', true)}<span class="tl-tag">${tag}</span>`;
    };
    const count = countOf(g);
    const top = stackOf[0];
    const isFront = (id) => multi && order[0] === id;

    const icons = g.events.slice(0, 4).map((e) => `<span data-ev="${e.id}"${isFront(e.id) ? ' class="active"' : ''}>${esc(e.emoji || '⭐')}</span>`).join('')
      + (g.events.length > 4 ? `<small>+${g.events.length - 4}</small>` : '');
    const shownNames = multi ? 3 : 2;
    const names = g.events.slice(0, shownNames).map((e) => `<a href="#/events/${e.id}" data-ev="${e.id}"${isFront(e.id) ? ' class="active"' : ''}>${esc(`${e.emoji || '⭐'} ${e.title}`)}</a>`).join('')
      + (g.events.length > shownNames ? `<em>+${g.events.length - shownNames} more</em>` : '');

    let stack;
    if (multi) {
      stack = order.map((evId, depth) => {
        const be = g.byEvent.find((b) => b.eventId === evId);
        return `<div class="ev-layer${depth ? '' : ' front'}" data-ev="${evId}" data-d="${Math.min(depth, 3)}">${pile(be.previews, countOf(be))}</div>`;
      }).join('') + `<button class="ev-cycle" type="button" aria-label="Show the next event’s photos">${g.byEvent.findIndex((b) => b.eventId === order[0]) + 1} of ${order.length} ↻</button>`;
    } else if (top) {
      stack = pile(stackOf, count);
    } else {
      stack = `<div class="pol c" data-add><span class="pin"></span><div class="ph empty-ph">＋ Add the<br>first photos</div><div class="cap"></div></div>`;
    }

    const loose = scatter ? `<div class="tl-scatter">${g.loose.map((p, k) => {
      const s = spots[k];
      return `<div class="spol" data-photo="${p.id}" role="button" tabindex="0" aria-label="Open ${p.kind === 'video' ? 'video' : 'photo'}"
          style="left:${(s.x - 56).toFixed(1)}px;top:${s.y.toFixed(1)}px;--r:${s.rot.toFixed(1)}deg;--s:${s.scale ?? 1};z-index:${k + 1}">
        <span class="pin"></span>
        <div class="ph"><img src="/media/thumb/${p.id}" alt="" loading="lazy" draggable="false">${p.kind === 'video' ? `<span class="play">▶</span>${p.duration ? `<span class="dur">${fmtDur(p.duration)}</span>` : ''}` : ''}</div>
        <div class="cap">${esc(p.caption || '')}</div>
      </div>`;
    }).join('')}${top ? '' : `<button class="tl-tag scatter-tag" data-day>${count}</button>`}</div>` : '';

    const label = `<div class="tl-label"><b>${esc(Z.label(g))}</b><span>${esc(Z.sub(g))}</span></div>`;
    const marker = g.events.length ? `<div class="tl-badge" aria-hidden="true">${icons}</div>` : '<span class="pin"></span>';
    const eventsBlock = `<div class="tl-events">${names}</div>`;
    const stackBlock = scatter && !top ? '' : `<div class="tl-stack${multi ? ' multi' : ''}" role="button" tabindex="0" aria-label="${esc(`${Z.label(g)}: ${count || 'no photos yet'}`)}">${stack}</div>`;
    // Flipped (every other event day): stack and event name above the twine, badge on it, date below.
    // .flip-top is exactly as tall as the space above the twine and stacks its contents at the bottom,
    // so the badge lands on the line however long the event names are.
    if (flip) {
      // The space above the twine holds the stack and one line of event names; with more names, the
      // stack is pinned up a little smaller (--fit) so everything still fits on the board.
      const lines = Math.min(g.events.length, shownNames) + (g.events.length > shownNames ? 1 : 0);
      const room = boardTwine - 17 - 30 - (21 * Math.max(1, lines) - 2); // above the badge, less the gaps and names
      const fit = Math.min(1, room / 214).toFixed(3);
      return `<div class="flip-top" style="--fit:${fit}">${stackBlock}${eventsBlock}</div>${marker}${label}${loose}`;
    }
    return `${label}${marker}${eventsBlock}${stackBlock}${loose}`;
  }

  // Tapping a scattered polaroid opens that photo, and you can swipe through the rest of the day.
  async function openPhotoOnBoard(date, photoId) {
    try {
      const photos = await api(`/api/photos?date=${date}`);
      const i = photos.findIndex((p) => p.id === photoId);
      if (i < 0) return openDay(date);
      openViewer(photos, i, { onChange: () => route() });
    } catch (e) { oops(e); }
  }

  async function viewTimeline(main, { focusDate: jumpDate } = {}) {
    if (!main.querySelector('.stage')) loading(main);
    const data = await api('/api/timeline');
    state.site = data.site;
    state.days = new Map(data.days.map((d) => [d.date, d]));
    main.className = 'full';

    if (!data.days.length) {
      main.innerHTML = `
        <div class="tl-board board"><div class="cork"><div class="empty">
          <div class="big">📸</div>
          <h3>The first page is blank</h3>
          <p>Add some photos or mark a special day, and the timeline will start to grow.</p>
          <div class="row" style="justify-content:center"><button class="btn primary" data-act="upload">＋ Add photos</button><button class="btn" data-act="event">Mark an event</button></div>
        </div></div></div>`;
      $('[data-act=upload]', main).onclick = () => openUpload();
      $('[data-act=event]', main).onclick = () => openEventForm();
      return;
    }

    const total = data.days.reduce((n, d) => n + d.count, 0);
    main.innerHTML = `
      <div class="tl-head page-head">
        <div><h2>Timeline</h2><p>${total} ${total === 1 ? 'memory' : 'memories'} so far. Pinch or use − / + to zoom through time.</p></div>
        <div class="tl-tools">
          <label class="tl-jump"><span class="lbl">Jump to</span><input type="date" id="jump" aria-label="Jump to date"></label>
          <button class="btn sm" id="toStart" aria-label="Beginning">⏮<span class="lbl"> Beginning</span></button>
          <button class="btn sm" id="toEnd" aria-label="Latest"><span class="lbl">Latest </span>⏭</button>
          <button class="btn sm primary" id="newEvent">＋ <span class="lbl">New </span>Event</button>
        </div>
      </div>
      <div class="tl-board board"><div class="cork">
        <div class="stage" id="stage"></div>
        <div class="tl-zoom">
          <button id="zout" aria-label="Zoom out">−</button>
          <div class="lvl" id="lvl">${ZOOM_LEVELS.map((Z, i) => `<span data-l="${i}">${Z.name}</span>`).join('')}</div>
          <button id="zin" aria-label="Zoom in">+</button>
        </div>
      </div></div>`;

    const groups = buildGroups(data.days);
    const stage = $('#stage', main);
    boardTwine = parseFloat(getComputedStyle(stage).getPropertyValue('--tw')) || 200; // set in CSS
    loadFront();
    const vw = () => stage.clientWidth;
    const xOf = (i) => i * W;
    const scaleOf = (ff) => Math.pow(G, ff);
    const containing = (l, date) => {
      const gs = groups[l];
      let best = 0;
      for (let i = 0; i < gs.length; i++) {
        if (gs[i].start <= date && date <= gs[i].end) return i;
        if (Math.abs(toDate(gs[i].start) - toDate(date)) < Math.abs(toDate(gs[best].start) - toDate(date))) best = i;
      }
      return best;
    };

    let boardDays = []; // the Days view's days ({ g, stack }), for the loose-photo rules
    const layers = groups.map((gs, l) => {
      const el = document.createElement('div');
      el.className = 'layer';
      // Loose photos live on their own board underneath every day, so no day's loose photos
      // can ever cover an event stack — not even a neighbouring day's.
      const looseBoard = document.createElement('div');
      looseBoard.className = 'loose-board';
      el.appendChild(looseBoard);
      // Days view: event days take turns — every other one has its photo stack above the twine and
      // its date below, so neighbouring events sit on opposite sides.
      // (a day whose photos are all loose has no stack to move, so it doesn't take a turn)
      let eventDays = 0;
      const stackAt = gs.map((g) => {
        const hasStack = !(g.looseCount > 0 && g.eventPreviews.length === 0);
        if (l !== MAXL || !g.events.length || !hasStack) return null;
        return eventDays++ % 2 === 1 ? 'A' : 'B';       // where the day's event stack sits
      });
      if (l === MAXL) boardDays = gs.map((g, i) => ({ g, stack: stackAt[i] }));
      const looseAt = l === MAXL ? planLoose(boardDays) : [];
      el.items = gs.map((g, i) => {
        const it = document.createElement('div');
        it.className = 'stop';
        const flip = stackAt[i] === 'A';
        if (flip) it.classList.add('flip');
        if (stackAt[i]) it.classList.add('event-stack'); // drawn above neighbouring days' loose photos
        it.dataset.l = l; it.dataset.i = i;
        it.style.display = 'none';
        it.innerHTML = stackHTML(g, l, flip, looseAt[i]);
        // Each loose photo gets its own holder on the loose board, moved with its day, so a tapped
        // or hovered one can be raised above the event stacks on its own.
        const scatter = it.querySelector('.tl-scatter');
        it.twins = [];
        if (scatter) {
          for (const piece of [...scatter.children]) {
            const twin = document.createElement('div');
            twin.className = 'stop loose';
            twin.dataset.l = l; twin.dataset.i = i;
            twin.style.display = 'none';
            const box = document.createElement('div');
            box.className = 'tl-scatter';
            box.appendChild(piece);
            twin.appendChild(box);
            looseBoard.appendChild(twin);
            it.twins.push(twin);
          }
          scatter.remove();
        }
        el.appendChild(it);
        return it;
      });
      el.shown = [];
      stage.appendChild(el);
      return el;
    });

    // ---- state: L = level, f = progress toward the next finer level, tx = where row L starts on screen
    let L, f = 0, tx;
    let pair = null;       // { a: stack at level L, c: matching stack at level L+1 } while blending
    let focusX = vw() / 2; // screen x the current zoom is centred on
    let focusDate = null;  // the day you were on, so zooming out and back in returns there
    const nearestIdx = (l, t, s, x) => Math.max(0, Math.min(groups[l].length - 1, Math.round((x - t) / (s * W))));
    // Where you are: kept in memory for this visit, and the level and day you're looking at are
    // also remembered on this device, so the app reopens there.
    const viewKey = `sb_view_${state.user.id}`;
    let viewTimer = 0;
    const save = () => {
      state.tl = { L, tx, focusDate };
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => {
        const lv = Math.min(MAXL, Math.max(0, Math.round(L + f)));
        if (lv !== L) return; // mid-zoom: wait until it settles
        const g = groups[L][nearestIdx(L, tx, scaleOf(f), vw() / 2)];
        try { localStorage.setItem(viewKey, JSON.stringify({ L, date: g.start })); } catch { /* private mode */ }
      }, 400);
    };
    const remembered = () => { try { return JSON.parse(localStorage.getItem(viewKey) || 'null'); } catch { return null; } };

    function makePair() {
      const a = nearestIdx(L, tx, scaleOf(f), focusX);
      const g = groups[L][a];
      const d = focusDate && focusDate >= g.start && focusDate <= g.end ? focusDate : g.start;
      return { a, c: containing(L + 1, d) };
    }

    function drawLayer(l, t, s, alpha) {
      const el = layers[l];
      el.style.opacity = alpha;
      const n = el.items.length;
      const cs = Math.sqrt(s); // stacks grow a bit slower than the spacing between them
      let i0 = 0, i1 = -1;
      if (alpha > 0.001) {
        i0 = Math.max(0, Math.floor((-320 - t) / (s * W)));
        i1 = Math.min(n - 1, Math.ceil((vw() + 320 - t) / (s * W)));
      }
      for (const i of el.shown) if (i < i0 || i > i1) {
        el.items[i].style.display = 'none';
        for (const tw of el.items[i].twins) tw.style.display = 'none';
      }
      el.shown = [];
      for (let i = i0; i <= i1; i++) {
        const it = el.items[i];
        it.style.display = 'flex';
        it.style.transform = `translate3d(${t + s * xOf(i) - 105}px,0,0) scale(${cs})`;
        for (const tw of it.twins) { tw.style.display = 'flex'; tw.style.transform = it.style.transform; }
        el.shown.push(i);
      }
      el.style.pointerEvents = alpha > 0.5 ? '' : 'none';
    }

    const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
    function render() {
      const sL = scaleOf(f);
      const blending = L < MAXL && f > 0;
      if (blending && (!pair || f < 0.22)) pair = makePair(); // re-pick only while the finer row is invisible
      const fade = blending ? smooth((f - 0.22) / 0.56) : 0;
      layers.forEach((el, l) => { if (l !== L && !(blending && l === L + 1)) drawLayer(l, 0, 1, 0); });
      drawLayer(L, tx, sL, 1 - fade);
      if (blending) drawLayer(L + 1, tx + sL * xOf(pair.a) - (sL / G) * xOf(pair.c), sL / G, fade);
      const shownLevel = Math.min(MAXL, Math.max(0, Math.round(L + f)));
      $$('#lvl span', main).forEach((sp) => sp.classList.toggle('on', +sp.dataset.l === shownLevel));
      $('#zout', main).disabled = L === 0 && f <= 0;
      $('#zin', main).disabled = L === MAXL;
      save();
    }

    // Zoom by dz levels around screen x F, crossing level boundaries seamlessly.
    function zoomBy(dz, F) {
      focusX = F;
      let guard = 20;
      while (Math.abs(dz) > 1e-9 && guard--) {
        if (dz > 0) {
          const step = Math.min(dz, (L < MAXL ? 1 : F_MAX) - f);
          if (step > 0) { tx = F - (F - tx) * scaleOf(step); f += step; dz -= step; }
          if (dz > 1e-9 && L < MAXL && f >= 1 - 1e-9) {          // the finer row takes over
            if (!pair) pair = makePair();
            tx = tx + G * xOf(pair.a) - xOf(pair.c);
            L++; f = 0; pair = null;
          } else if (step <= 0) break;
        } else {
          const step = Math.min(-dz, f - (L > 0 ? 0 : F_MIN));
          if (step > 0) { tx = F - (F - tx) * scaleOf(-step); f -= step; dz += step; }
          if (dz < -1e-9 && L > 0 && f <= 1e-9) {                // the coarser row takes over
            const c = nearestIdx(L, tx, 1, F);
            if (L === MAXL) focusDate = groups[L][c].start;      // remember the day you zoomed out from
            const a = containing(L - 1, groups[L][c].start);
            tx = tx + xOf(c) - G * xOf(a);
            L--; f = 1; pair = { a, c };
          } else if (step <= 0) break;
        }
      }
      // Landed exactly on the finer row (a button or a settle stops right at the boundary): make it the
      // current row. Left as "the coarser row, fully zoomed in", panning stopped at the coarser row's
      // ends, so the board seemed stuck until you pinched a little further.
      if (L < MAXL && f >= 1 - 1e-9) {
        if (!pair) pair = makePair();
        tx = tx + G * xOf(pair.a) - xOf(pair.c);
        L++; f = 0; pair = null;
      }
      render();
    }

    // How far the row can move: the first and last stacks can come to the middle, plus enough extra
    // that everything around them — on the Days view, loose photos and fanned-out stacks reach about
    // 205px either side — can be brought fully onto a narrow (phone) screen.
    const edgeRoom = () => Math.max(0, (L + f > MAXL - 0.5 ? 205 : 110) * Math.sqrt(scaleOf(f)) - vw() / 2 + 14);
    const txMax = () => vw() / 2 + edgeRoom();
    const txMin = () => vw() / 2 - scaleOf(f) * xOf(groups[L].length - 1) - edgeRoom();
    const clampTx = (t) => Math.min(txMax(), Math.max(txMin(), t));
    function panBy(dx) { tx = clampTx(tx + dx); render(); }
    // A finger or mouse drag past either end stretches like a rubber band, so you can feel you've
    // reached the end; it springs back when you let go.
    function dragBy(dx) {
      const over = tx > txMax() ? tx - txMax() : tx < txMin() ? txMin() - tx : 0;
      const outward = (tx + dx > txMax() && dx > 0) || (tx + dx < txMin() && dx < 0);
      tx += outward ? dx * Math.max(0.08, 0.45 * (1 - over / 140)) : dx;
      render();
    }

    // ---- animations
    let anim = 0;
    const stopAnim = () => { cancelAnimationFrame(anim); anim = 0; };
    function tween(ms, frame, done) {
      stopAnim();
      const t0 = performance.now();
      const step = (now) => {
        if (!stage.isConnected) return;
        const p = Math.min(1, (now - t0) / ms);
        frame(1 - Math.pow(1 - p, 3));
        if (p < 1) anim = requestAnimationFrame(step); else { anim = 0; done?.(); }
      };
      anim = requestAnimationFrame(step);
    }
    // Zooming keeps your place but doesn't keep the row on the board — zoom out near an end and the
    // stacks can end up off to the side. Once a zoom finishes, glide them back into view.
    const keepOnBoard = () => { const c = clampTx(tx); if (Math.abs(c - tx) > 1) panTo(c); };
    function animateZoom(targetZ, F = vw() / 2, ms) {
      const dist = targetZ - (L + f);
      if (Math.abs(dist) < 1e-4) { keepOnBoard(); return; }
      let done = 0;
      tween(ms || Math.min(900, 300 + 260 * Math.abs(dist)), (e) => { zoomBy(dist * e - done, F); done = dist * e; }, keepOnBoard);
    }
    const settle = (F = focusX) => animateZoom(Math.max(0, Math.min(MAXL, Math.round(L + f))), F, 260);
    function panTo(target) {
      const from = tx;
      target = clampTx(target);
      tween(450, (e) => { tx = from + (target - from) * e; render(); });
    }
    function glide(v) {                                   // momentum after a flick
      stopAnim();
      let last = performance.now();
      const step = (now) => {
        if (!stage.isConnected) return;
        const dt = Math.min(32, now - last); last = now;
        panBy(v * dt);
        v *= Math.pow(0.94, dt / 16);
        if (Math.abs(v) > 0.02) anim = requestAnimationFrame(step); else anim = 0;
      };
      anim = requestAnimationFrame(step);
    }
    // Show a date at Days level, centred.
    function goToDate(date) {
      stopAnim();
      L = MAXL; f = 0; pair = null;
      const i = containing(MAXL, date);
      focusDate = groups[MAXL][i].start;
      tx = vw() / 2 - xOf(i);
      render();
    }

    // ---- where to start: where you left off, a requested date, or the latest memories
    const span = (toDate(data.days[data.days.length - 1].date) - toDate(data.days[0].date)) / 864e5;
    if (jumpDate) goToDate(jumpDate);
    else if (state.tl && state.tl.L <= MAXL) { L = state.tl.L; tx = state.tl.tx; focusDate = state.tl.focusDate; tx = clampTx(tx); render(); }
    else if (remembered()?.L >= 0 && remembered().L <= MAXL && remembered().date) {
      const v = remembered();
      L = v.L;
      tx = clampTx(vw() / 2 - xOf(containing(L, v.date)));
      render();
    } else {
      L = span < 45 ? 3 : span < 200 ? 2 : 1;
      tx = Math.min(vw() / 2, vw() - 150 - xOf(groups[L].length - 1));
      render();
    }

    // ---- controls
    $('#zin', main).onclick = () => animateZoom(Math.min(MAXL, Math.round(L + f) + 1));
    $('#zout', main).onclick = () => animateZoom(Math.max(0, Math.round(L + f) - 1));
    $$('#lvl span', main).forEach((sp) => { sp.onclick = () => animateZoom(+sp.dataset.l); });
    $('#toStart', main).onclick = () => panTo(vw() / 2);
    $('#toEnd', main).onclick = () => panTo(-Infinity);
    $('#newEvent', main).onclick = () => openEventForm();
    $('#jump', main).onchange = (e) => e.target.value && goToDate(e.target.value);

    // A scattered photo lifted by a tap (phones); its day is raised too so it can sit above the neighbours.
    let lastPointer = 'mouse';
    function liftPhoto(spol) {
      $$('.spol.front', stage).forEach((s) => { s.classList.remove('front'); s.closest('.stop')?.classList.remove('has-front'); });
      if (!spol) return;
      spol.classList.add('front');
      spol.closest('.stop').classList.add('has-front');
    }

    // Several events on one day: bring one event's stack to the front (remembered per person).
    function bringToFront(stopEl, evId) {
      const g = groups[MAXL][+stopEl.dataset.i];
      const ids = g.byEvent.map((b) => b.eventId);
      if (!ids.includes(evId)) return;
      frontMap[g.start] = evId;
      saveFront();
      const order = eventOrder(g);
      $$('.ev-layer', stopEl).forEach((layer) => {
        const d = order.indexOf(+layer.dataset.ev);
        layer.dataset.d = Math.min(d, 3);
        layer.classList.toggle('front', d === 0);
      });
      $$('.tl-badge [data-ev], .tl-events [data-ev]', stopEl).forEach((x) => x.classList.toggle('active', +x.dataset.ev === evId));
      const chip = $('.ev-cycle', stopEl);
      if (chip) chip.textContent = `${ids.indexOf(evId) + 1} of ${ids.length} ↻`;
    }
    const cycleStack = (stopEl) => bringToFront(stopEl, eventOrder(groups[MAXL][+stopEl.dataset.i])[1]);

    // Tap a stack: months/weeks/years dive in; a day opens its photos.
    stage.addEventListener('click', (e) => {
      const cycleBtn = e.target.closest('.ev-cycle');
      if (cycleBtn) { cycleStack(cycleBtn.closest('.stop')); return; }
      const nameLink = e.target.closest('.tl-events a[data-ev]');
      if (nameLink) {
        const stopEl = nameLink.closest('.stop');
        const g = +stopEl.dataset.l === MAXL ? groups[MAXL][+stopEl.dataset.i] : null;
        const evId = +nameLink.dataset.ev;
        if (g && g.byEvent.length > 1 && g.byEvent.some((b) => b.eventId === evId) && !nameLink.classList.contains('active')) {
          e.preventDefault();
          bringToFront(stopEl, evId);
        }
        return; // otherwise the link opens the event as usual
      }
      const spol = e.target.closest('.spol');
      const dayTag = e.target.closest('.scatter-tag');
      // On a phone there's no hover: the first tap lifts a scattered photo to the front, the second opens it.
      if (spol && lastPointer === 'touch' && !spol.classList.contains('front')) { liftPhoto(spol); return; }
      liftPhoto(null);
      if (spol || dayTag) {
        const g = groups[MAXL][+(spol || dayTag).closest('.stop').dataset.i];
        return spol ? openPhotoOnBoard(g.start, +spol.dataset.photo) : openDay(g.start);
      }
      const stack = e.target.closest('.tl-stack');
      const it = stack?.closest('.stop');
      if (!it || +it.dataset.l !== L) return;
      const i = +it.dataset.i;
      const g = groups[L][i];
      if (L < MAXL) {
        focusDate = g.start;
        animateZoom(L + 1, tx + scaleOf(f) * xOf(i));
      } else if (e.target.closest('[data-add]')) {
        openUpload({ date: g.start, eventId: g.events[0]?.id });
      } else openDay(g.start, g.byEvent.length > 1 ? eventOrder(g)[0] : null); // the event in front comes first
    });
    stage.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.tl-stack, .spol')) e.target.click(); });

    const localX = (clientX) => clientX - stage.getBoundingClientRect().left;

    // Mouse wheel / trackpad: scroll moves, ctrl + scroll or a trackpad pinch zooms.
    let wheelTimer = 0;
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      stopAnim();
      if (e.ctrlKey) {
        zoomBy(-e.deltaY * 0.012, localX(e.clientX));
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => settle(), 160);
      } else {
        panBy(-(Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY));
      }
    }, { passive: false });

    // Dragging with the mouse (or a pen), with momentum. Fingers are handled further down with touch events.
    const pointers = new Set();
    let drag = null;
    let justDragged = false;
    // A drag or swipe just ended: let it glide, swallow the click it would cause, and forget the
    // remembered day if it wandered to another stack.
    function endPan(v, lastMove) {
      justDragged = true; setTimeout(() => { justDragged = false; }, 0);
      if (Math.abs(clampTx(tx) - tx) > 0.5) panTo(tx);       // stretched past an end: spring back
      else if (performance.now() - lastMove < 80) glide(v);
      const g = groups[L][nearestIdx(L, tx, scaleOf(f), vw() / 2)];
      if (focusDate && (focusDate < g.start || focusDate > g.end)) focusDate = null;
      stage.classList.remove('dragging');
    }
    // Admins: press and hold a loose photo until it lifts, then drag it to a new spot on the board;
    // letting go saves the spot for everyone. A quick swipe still moves the board as usual.
    let moving = null;
    let hold = null;
    const canMove = () => state.user.isAdmin && L === MAXL && f === 0;
    function armHold(spol, x, y) {
      disarmHold();
      if (!spol || !canMove()) return;
      hold = { spol, x, y, timer: setTimeout(() => startMove(spol, x, y), 400) };
    }
    function disarmHold() { if (hold) clearTimeout(hold.timer); hold = null; }
    const holdWandered = (x, y) => hold && Math.hypot(x - hold.x, y - hold.y) > 8;
    function startMove(spol, x, y) {
      hold = null;
      swipe = null; drag = null;
      stage.classList.remove('dragging');
      liftPhoto(null);
      const twin = spol.closest('.stop');
      const scale = new DOMMatrix(getComputedStyle(twin).transform).a || 1;
      moving = { el: spol, x0: x, y0: y, left0: parseFloat(spol.style.left), top0: parseFloat(spol.style.top), scale, moved: false,
        walls: looseWalls(boardDays, +twin.dataset.i), blocked: false };
      spol.classList.add('moving');
      twin.classList.add('has-front'); // above the event stacks while it's being moved
      navigator.vibrate?.(12);
    }
    function moveTo(x, y) {
      const m = moving;
      m.moved = true;
      // a quarter of it stays in its own day's area, and all of it on the board
      const px = Math.max(-153, Math.min(153, m.left0 + 56 + (x - m.x0) / m.scale));
      const py = Math.max(-(boardTwine + 50), Math.min(112, m.top0 + (y - m.y0) / m.scale));
      m.el.style.left = `${(px - 56).toFixed(1)}px`;
      m.el.style.top = `${py.toFixed(1)}px`;
      // over an event's stack, a date or event names: shown in red, and it won't stay there
      m.blocked = !looseSpotOK({ x: px, y: py, scale: 1 }, m.walls);
      m.el.classList.toggle('blocked', m.blocked);
    }
    async function endMove() {
      const m = moving;
      moving = null;
      m.el.classList.remove('moving', 'blocked');
      m.el.closest('.stop')?.classList.remove('has-front');
      justDragged = true; setTimeout(() => { justDragged = false; }, 0); // no click (which would open it)
      if (!m.moved) return;
      if (m.blocked) {
        m.el.style.left = `${m.left0}px`;
        m.el.style.top = `${m.top0}px`;
        toast('Loose photos can’t go over an event’s photos, a date or event names');
        return;
      }
      const x = parseFloat(m.el.style.left) + 56;
      const y = parseFloat(m.el.style.top);
      try {
        await api(`/api/photos/${m.el.dataset.photo}/spot`, { method: 'PUT', body: { x, y } });
        toast('Photo moved');
      } catch (e) {
        oops(e);
        m.el.style.left = `${m.left0}px`;
        m.el.style.top = `${m.top0}px`;
      }
    }
    // a long press shouldn't bring up the phone's "save image" menu
    stage.addEventListener('contextmenu', (e) => { if (lastPointer === 'touch' || moving) e.preventDefault(); });

    stage.addEventListener('pointerdown', (e) => {
      lastPointer = e.pointerType; // 'touch' on phones, 'mouse' on computers
      if (e.pointerType === 'touch') return;
      if (e.button === 0) armHold(e.target.closest('.spol'), e.clientX, e.clientY);
      if (e.isPrimary) pointers.clear();
      pointers.add(e.pointerId);
      if (pointers.size > 1) { drag = null; return; }
      stopAnim();
      drag = { x: e.clientX, t: performance.now(), v: 0, moved: false, id: e.pointerId };
    });
    stage.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch') {
        if (moving) { moveTo(e.clientX, e.clientY); return; }
        if (holdWandered(e.clientX, e.clientY)) disarmHold();
      }
      if (!drag || e.pointerId !== drag.id || pointers.size > 1) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 6) return;
      if (!drag.moved) { drag.moved = true; stage.classList.add('dragging'); stage.setPointerCapture(e.pointerId); liftPhoto(null); }
      const now = performance.now();
      drag.v = 0.8 * (dx / Math.max(1, now - drag.t)) + 0.2 * drag.v;
      drag.x = e.clientX; drag.t = now;
      dragBy(dx);
    });
    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerType !== 'touch') {
        disarmHold();
        if (moving) { endMove(); drag = null; return; }
      }
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moved) endPan(drag.v, drag.t);
      drag = null;
    };
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);
    stage.addEventListener('click', (e) => { if (justDragged) { e.stopPropagation(); e.preventDefault(); } }, true);

    // Fingers: one swipes (with momentum), two pinch to zoom and pan with their midpoint, like Photos.
    // Everything goes by the browser's own list of fingers on the board (e.touches), so nothing can
    // get out of step after a pinch. (Keeping our own count of fingers is what left the board stuck
    // after pinching on an iPhone until you pinched again.)
    let pinch = null;
    let swipe = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => localX((t[0].clientX + t[1].clientX) / 2);
    let fingersDown = 0;
    let lastTouched = -Infinity;
    const touched = (e) => { fingersDown = e.touches ? e.touches.length : fingersDown; lastTouched = performance.now(); };
    ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'wheel'].forEach((t) => stage.addEventListener(t, touched, { passive: true }));
    stage.addEventListener('touchstart', (e) => {
      lastPointer = 'touch';
      stopAnim();
      const n = e.touches.length;
      if (n === 1) {
        const t = e.touches[0];
        pinch = null;
        armHold(e.target.closest?.('.spol'), t.clientX, t.clientY);
        swipe = { id: t.identifier, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, t: performance.now(), v: 0, moved: false, scroll: false };
      } else {
        disarmHold();
        if (swipe?.moved) stage.classList.remove('dragging');
        swipe = null;
        pinch = n === 2 ? { d: dist(e.touches), m: mid(e.touches) } : null;
      }
    }, { passive: true });
    stage.addEventListener('touchmove', (e) => {
      if (moving) {
        e.preventDefault();
        if (e.touches[0]) moveTo(e.touches[0].clientX, e.touches[0].clientY);
        return;
      }
      if (e.touches[0] && holdWandered(e.touches[0].clientX, e.touches[0].clientY)) disarmHold(); // a swipe after all
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const d = dist(e.touches);
        const m = mid(e.touches);
        tx += m - pinch.m;
        zoomBy(Math.log(d / pinch.d) / Math.log(G), m);
        pinch.d = d; pinch.m = m;
        return;
      }
      if (!swipe || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.identifier !== swipe.id) return;
      // Decide once per swipe. Only a clearly up-and-down swipe (steeper than about 60°) scrolls the
      // page; anything else — including the slightly diagonal swipes thumbs make — moves the board.
      // (The board handles both itself: left to the browser, a diagonal swipe became a page scroll,
      // and on a page that barely scrolls the board just looked stuck.)
      if (!swipe.moved && !swipe.scroll) {
        const dx = t.clientX - swipe.x0, dy = t.clientY - swipe.y0;
        if (Math.hypot(dx, dy) < 6) return;
        if (Math.abs(dy) > Math.abs(dx) * 1.7) {
          if (e.target.closest?.('.tl-stack.multi')) { swipe = null; return; } // that's cycling a day's events
          swipe.scroll = true;
        } else { swipe.moved = true; stage.classList.add('dragging'); liftPhoto(null); }
      }
      e.preventDefault();
      if (swipe.scroll) { window.scrollBy(0, swipe.y - t.clientY); swipe.y = t.clientY; return; }
      const now = performance.now();
      const dx = t.clientX - swipe.x;
      swipe.v = 0.8 * (dx / Math.max(1, now - swipe.t)) + 0.2 * swipe.v;
      swipe.x = t.clientX; swipe.t = now;
      dragBy(dx);
    }, { passive: false });
    const touchDone = (e) => {
      disarmHold();
      if (moving) { if (!e.touches.length) endMove(); return; }
      if (pinch && e.touches.length < 2) { pinch = null; settle(); }
      if (swipe && ![...e.touches].some((t) => t.identifier === swipe.id)) {
        if (swipe.moved) {
          if (e.type === 'touchend') endPan(swipe.v, swipe.t);
          else { stage.classList.remove('dragging'); keepOnBoard(); }
        }
        swipe = null;
      }
    };
    stage.addEventListener('touchend', touchDone);
    stage.addEventListener('touchcancel', touchDone);
    stage.addEventListener('gesturestart', (e) => e.preventDefault()); // Safari: don't zoom the page

    // Swipe up or down on a stack holding several events: the front event goes to the back.
    let stackSwipe = null;
    stage.addEventListener('touchstart', (e) => {
      const st = e.touches.length === 1 && e.target.closest('.tl-stack.multi');
      stackSwipe = st ? { x: e.touches[0].clientX, y: e.touches[0].clientY, stop: st.closest('.stop'), done: false } : null;
    }, { passive: true });
    stage.addEventListener('touchmove', (e) => {
      if (!stackSwipe || stackSwipe.done) return;
      const dx = e.touches[0].clientX - stackSwipe.x;
      const dy = e.touches[0].clientY - stackSwipe.y;
      if (Math.abs(dy) > 36 && Math.abs(dy) > Math.abs(dx) * 1.2) { stackSwipe.done = true; cycleStack(stackSwipe.stop); }
    }, { passive: true });
    stage.addEventListener('touchend', () => { stackSwipe = null; });

    // Live updates wait while you're swiping, pinching or mid-animation.
    // A refresh rebuilds the board, which would leave a finger that's resting on it (or about to
    // swipe again) on a board that's gone. So wait while a finger is down, and 1.5 s after any touch.
    state.live.timelineBusy = () => stage.isConnected
      && (fingersDown > 0 || performance.now() - lastTouched < 1500 || !!moving || !!hold || !!drag?.moved || !!swipe?.moved || !!pinch || anim !== 0);

    // Keep things lined up if the window is resized or the phone rotated.
    const ro = new ResizeObserver(() => { if (stage.isConnected) { tx = clampTx(tx); render(); } else ro.disconnect(); });
    ro.observe(stage);
  }

  // `firstEvent`: list this event first (the one in front on the board, for a day with several).
  async function openDay(date, firstEvent = null) {
    let photos;
    try { photos = await api(`/api/photos?date=${date}`); } catch (e) { return oops(e); }
    const events = [...(state.days.get(date)?.events || [])].sort((a, b) => (b.id === firstEvent) - (a.id === firstEvent));
    const sub = [age(date), plural(events.length, 'event'), mediaCount(photos)].filter((s) => s && !s.startsWith('0 ')).join(' · ');
    // One section per event (with its own photos), then whatever else happened that day.
    const sections = events.map((e) => ({ event: e, photos: photos.filter((p) => p.eventId === e.id) }));
    const loose = photos.filter((p) => !events.some((e) => e.id === p.eventId));
    if (loose.length || !events.length) sections.push({ event: null, photos: loose });
    const m = modal(`
      ${head(esc(fmtLong(date)), esc(sub))}
      ${sections.map((s, i) => `
        <section class="day-section" data-s="${i}">
          <div class="day-section-head">
            ${s.event
              ? `<h3><span>${esc(s.event.emoji || '⭐')}</span> ${esc(s.event.title)}</h3>
                 <div class="row"><a class="btn sm ghost" href="#/events/${s.event.id}">Open event →</a><button class="btn sm" data-add-event="${s.event.id}">＋ Photos</button></div>`
              : `<h3>${events.length ? 'More from this day' : 'Photos'}</h3>`}
          </div>
          ${s.photos.length ? photoGrid(s.photos) : `<p class="muted small">No photos ${s.event ? 'in this event' : 'on this day'} yet.</p>`}
        </section>`).join('')}
      <div class="row end" style="margin-top:8px"><button class="btn primary" data-add>＋ Add photos to this day</button></div>`, { cls: 'wide' });
    $$('a[href^="#/events/"]', m.el).forEach((a) => a.addEventListener('click', m.close));
    $('[data-add]', m.el).onclick = () => { m.close(); openUpload({ date }); };
    $$('[data-add-event]', m.el).forEach((b) => { b.onclick = () => { m.close(); openUpload({ eventId: Number(b.dataset.addEvent) }); }; });
    $$('.day-section', m.el).forEach((el) => bindGrid(el, sections[el.dataset.s].photos, { onChange: () => { m.close(); route(); } }));
    swipeBack(m.el, m.close); // swipe right to close, back to the timeline
  }

  // ---------------------------------------------------------------- photo grid & viewer

  // A small, stable tilt per item so polaroids look hand-pinned (same tilt every time you visit).
  const tilt = (id) => `${((id * 37) % 7) - 3}deg`;
  const mediaCount = (items) => {
    const v = items.filter((p) => p.kind === 'video').length;
    return [items.length - v && plural(items.length - v, 'photo'), v && plural(v, 'video')].filter(Boolean).join(' · ') || '0 photos';
  };
  const videoBadge = (p) => (p.kind !== 'video' ? ''
    : p.status === 'processing' ? '<span class="play">▶</span><span class="processing">Converting…</span>'
    : `<span class="play">▶</span>${p.duration ? `<span class="dur">${fmtDur(p.duration)}</span>` : ''}`);

  // ---- hearts, shared by the grid and the viewer
  const likeLabel = (p) => `${p.liked ? '♥' : '♡'}${p.likeCount ? ` ${p.likeCount}` : ''}`;
  const commentLabel = (p) => `💬${p.commentCount ? ` ${p.commentCount}` : ''}`;
  async function toggleLike(p, force) {
    const want = force ?? !p.liked;
    if (want === !!p.liked) return;
    const r = await api(`/api/photos/${p.id}/like`, { method: 'PUT', body: { liked: want } });
    Object.assign(p, { liked: r.liked, likeCount: r.likeCount, firstLiker: r.firstLiker });
  }
  // "Liked by Grandma Sue and 2 others", like Instagram
  function likedLine(p) {
    if (!p.likeCount) return '';
    const who = p.firstLiker || 'someone';
    const others = p.likeCount - 1;
    return `Liked by <b>${esc(who)}</b>${others ? ` and <b>${plural(others, 'other')}</b>` : ''}`;
  }
  const pop = (el) => { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); };

  // Polaroids in a grid, each with Instagram's ♡ 💬 row right under the photo.
  function photoGrid(photos, showEvent = false) {
    return `<div class="photo-grid">${photos.map((p, i) => `
      <div class="pg-item" data-i="${i}" style="--r:${tilt(p.id)}">
        <button class="pg-open" aria-label="Open ${p.kind === 'video' ? 'video' : 'photo'}${p.caption ? `: ${esc(p.caption)}` : ''}">
          <span class="ph">
            <img loading="lazy" src="/media/thumb/${p.id}" width="${p.width || 4}" height="${p.height || 3}" alt="${esc(p.caption || '')}">
            ${videoBadge(p)}
            ${p.restricted ? '<span class="lock" title="Private">🔒</span>' : ''}
            ${showEvent && p.eventTitle ? `<span class="tag">${esc(`${p.eventEmoji || '⭐'} ${p.eventTitle}`)}</span>` : ''}
          </span>
        </button>
        <div class="pg-actions">
          <button class="pg-like${p.liked ? ' on' : ''}" data-like aria-pressed="${!!p.liked}" aria-label="Like">${likeLabel(p)}</button>
          <button class="pg-comment" data-comment aria-label="Comments">${commentLabel(p)}</button>
        </div>
        ${p.caption ? `<span class="cap">${esc(p.caption)}</span>` : ''}
      </div>`).join('')}</div>`;
  }
  function bindGrid(el, photos, ctx = {}) {
    // after the viewer closes, refresh the ♡/💬 counts in place (no reload needed)
    const sync = () => $$('.pg-item', el).forEach((item) => {
      const p = photos[Number(item.dataset.i)];
      if (!p) return;
      const like = $('[data-like]', item);
      like.textContent = likeLabel(p);
      like.classList.toggle('on', !!p.liked);
      like.setAttribute('aria-pressed', !!p.liked);
      $('[data-comment]', item).textContent = commentLabel(p);
    });
    const opts = { ...ctx, onSocial: sync };
    $$('.pg-item', el).forEach((item) => {
      const i = Number(item.dataset.i);
      $('.pg-open', item).onclick = () => openViewer(photos, i, opts);
      $('[data-comment]', item).onclick = () => openViewer(photos, i, { ...opts, comments: true });
      const like = $('[data-like]', item);
      like.onclick = async () => {
        try { await toggleLike(photos[i]); sync(); if (photos[i].liked) pop(like); } catch (e) { oops(e); }
      };
    });
  }

  function openViewer(photos, start, ctx = {}) {
    let i = start;
    let changed = false;   // something that needs the page reloaded (delete, caption, privacy …)
    let social = false;    // hearts or comments changed — just refresh the counts
    const lb = document.createElement('div');
    lb.className = 'lb';
    lb.setAttribute('role', 'dialog');
    document.body.appendChild(lb);

    const onResize = () => fit();
    window.addEventListener('resize', onResize);
    const close = () => {
      lb.remove();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      if (state.live.onSocial === onLiveSocial) { state.live.onSocial = null; state.live.onPhoto = null; }
      if (changed) ctx.onChange?.();
      else if (social) ctx.onSocial?.();
    };

    // ---- live updates for the photo you're looking at
    const paintSocial = (p) => {
      const heart = $('[data-like]', lb);
      if (!heart) return;
      heart.textContent = p.liked ? '♥' : '♡';
      heart.classList.toggle('on', !!p.liked);
      heart.setAttribute('aria-pressed', !!p.liked);
      $('.lb-liked', lb).innerHTML = likedLine(p);
      $('.lb-viewall', lb).textContent = p.commentCount
        ? `View ${p.commentCount === 1 ? 'the comment' : `all ${p.commentCount} comments`}` : 'Add a comment…';
    };
    async function onLiveSocial(photoId) {
      const p = photos[i];
      if (!p || p.id !== photoId) return;
      try {
        const r = await api(`/api/photos/${p.id}/comments`);
        if (photos[i] !== p) return;
        Object.assign(p, { commentCount: r.comments.length, likeCount: r.likedBy.length, liked: r.liked, firstLiker: r.likedBy[0] || null });
        social = true;
        paintSocial(p);
        if (panelOpen) loadComments(p); // new comments appear in the open panel (what you're typing is kept)
      } catch { /* the next notice will try again */ }
    }
    async function onLivePhoto(photoId, removed) {
      const p = photos[i];
      if (!p || p.id !== photoId || removed) return;
      try {
        const fresh = (await api(`/api/photos?date=${p.date}`)).find((x) => x.id === p.id);
        if (fresh && photos[i] === p && fresh.status !== p.status) { Object.assign(p, fresh); render(); } // video now playable
      } catch { /* ignore */ }
    }
    state.live.onSocial = onLiveSocial;
    state.live.onPhoto = onLivePhoto;
    const go = (n) => { if (photos.length > 1) { i = (i + n + photos.length) % photos.length; render(); } };
    let panelOpen = !!ctx.comments; // comments panel stays open as you move between photos
    const onKey = (e) => {
      if ($$('.modal-back').some((b) => b.style.zIndex)) return; // a dialog on top of the viewer is open
      const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
      if (e.key === 'Escape' && lb.classList.contains('zoomed')) lb.classList.remove('zoomed');
      else if (e.key === 'Escape' && panelOpen) { panelOpen = false; render(); }
      else if (typing) return;
      else if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    document.addEventListener('keydown', onKey);

    // Touch: swipe left/right for the next photo; pull down to close (like the Photos app) — the
    // photo follows your finger and the background fades; let go far enough and it closes.
    let touch = null;
    const chrome = () => [$('.lb-top', lb), $('.lb-bottom', lb)].filter(Boolean);
    lb.addEventListener('touchstart', (e) => {
      touch = null;
      if (e.touches.length !== 1 || lb.classList.contains('zoomed') || e.target.closest('.lb-panel, .lb-top')) return;
      const t = e.touches[0];
      touch = { x: t.clientX, y: t.clientY, t: performance.now(), axis: null, dy: 0 };
    }, { passive: true });
    lb.addEventListener('touchmove', (e) => {
      if (!touch) return;
      const t = e.touches[0];
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      if (!touch.axis) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        touch.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x'; // decide once, then stick with it
      }
      if (touch.axis !== 'y') return;
      e.preventDefault();
      touch.dy = Math.max(0, dy);
      const stage = $('.lb-stage', lb);
      stage.style.transition = 'none';
      stage.style.transform = `translateY(${touch.dy}px) scale(${1 - Math.min(0.25, touch.dy / 1600)})`;
      lb.style.backgroundColor = `rgba(10, 8, 6, ${0.94 * (1 - Math.min(1, touch.dy / 450))})`;
      chrome().forEach((c) => { c.style.opacity = String(1 - Math.min(1, touch.dy / 150)); });
    }, { passive: false });
    const touchDone = (e) => {
      const t = touch;
      touch = null;
      if (!t) return;
      if (t.axis === 'x') {
        const dx = e.changedTouches[0].clientX - t.x;
        if (Math.abs(dx) > 50) go(dx > 0 ? -1 : 1);
        return;
      }
      if (t.axis !== 'y') return;
      const stage = $('.lb-stage', lb);
      const fast = t.dy / Math.max(1, performance.now() - t.t) > 0.6 && t.dy > 40;
      stage.style.transition = 'transform .22s ease';
      lb.style.transition = 'background-color .22s ease';
      if (t.dy > 120 || fast) {
        stage.style.transform = `translateY(${innerHeight}px) scale(.8)`;
        lb.style.backgroundColor = 'rgba(10, 8, 6, 0)';
        setTimeout(close, 200);
      } else {
        stage.style.transform = '';
        lb.style.backgroundColor = '';
        chrome().forEach((c) => { c.style.opacity = ''; });
      }
    };
    lb.addEventListener('touchend', touchDone);
    lb.addEventListener('touchcancel', touchDone);

    // Size the polaroid so it (frame and handwritten strip included) and the ♡ 💬 row under it fit
    // on screen together. Twice, because the strip's height depends on how wide the photo ends up.
    function fit() {
      const fig = $('.lb-figure', lb);
      const stage = $('.lb-stage', lb);
      if (!fig || lb.classList.contains('zoomed')) return;
      const p = photos[i];
      const pol = getComputedStyle($('.lb-pol', fig));
      const padX = parseFloat(pol.paddingLeft) + parseFloat(pol.paddingRight);
      const side = window.innerWidth <= 640 ? 16 : 128;
      const w = p.width || 4, h = p.height || 3;
      for (let pass = 0; pass < 2; pass++) {
        const below = $('.lb-under', fig).offsetHeight + $('.lb-strip', fig).offsetHeight + parseFloat(pol.paddingTop);
        const s = Math.min((stage.clientWidth - side - padX) / w, (stage.clientHeight - below - 24) / h, 1);
        // never narrower than 260px, so the ♡ 💬 row has room under a tall, thin photo
        fig.style.width = `${Math.max(260, Math.floor(w * s) + padX)}px`;
        $('.lb-media', fig).style.height = `${Math.floor(h * s)}px`;
      }
    }

    function render() {
      const p = photos[i];
      const mine = state.user.isAdmin || p.uploadedBy === state.user.id;
      const ev = ctx.event;
      const meta = [p.restricted && '🔒 Private', fmtLong(p.date), p.eventTitle && `${p.eventEmoji || '⭐'} ${p.eventTitle}`].filter(Boolean).join(' · ');
      const poster = p.uploaderName || 'a former member';
      const longCaption = (p.caption || '').length > 90; // more than the polaroid's strip can show
      const isVideo = p.kind === 'video';
      const ready = !isVideo || p.status === 'ready';
      const media = !isVideo
        ? `<img src="/media/full/${p.id}" alt="${esc(p.caption || '')}">`
        : ready
          ? `<video src="/media/video/${p.id}" poster="/media/full/${p.id}" controls autoplay playsinline></video>`
          : `<img src="/media/full/${p.id}" alt=""><div class="lb-note">${p.status === 'failed'
              ? 'This video couldn’t be converted. Try uploading it again.'
              : 'This video is still being converted so it plays everywhere — check back in a minute.'}</div>`;
      lb.innerHTML = `
        <div class="lb-top">
          <span class="count">${i + 1} / ${photos.length}</span>
          <div class="row">
            ${ready ? `<a class="btn sm" data-download href="/media/${isVideo ? 'video' : 'full'}/${p.id}?download=1">⬇ Download</a>` : ''}
            ${ev?.canEdit ? `<button class="btn sm" data-cover>${ev.coverId === p.id ? '★ Cover photo' : '☆ Make cover'}</button>` : ''}
            ${mine ? `<button class="btn sm" data-access>${p.restricted ? '🔒 Private' : '👨‍👩‍👧 Everyone'}</button>${state.user.isAdmin && p.posX != null && !p.eventId ? '<button class="btn sm" data-spot>↺ Reset spot</button>' : ''}<button class="btn sm" data-event>📌 Event</button><button class="btn sm" data-caption>✎ Caption</button><button class="btn sm danger" data-del>Delete</button>` : ''}
            <button class="btn icon" data-x aria-label="Close">✕</button>
          </div>
        </div>
        <div class="lb-stage">
          ${photos.length > 1 ? '<button class="lb-nav prev" aria-label="Previous">‹</button>' : ''}
          <figure class="lb-figure">
            <div class="lb-pol">
              <span class="pin" aria-hidden="true"></span>
              <div class="lb-media">${media}<span class="heart-pop" aria-hidden="true">♥</span></div>
              <div class="lb-strip"><span class="lb-hand${p.caption ? '' : ' date'}">${esc(p.caption || fmt(p.date))}</span></div>
            </div>
            <figcaption class="lb-under">
              <div class="lb-actions">
                <button class="lb-act heart${p.liked ? ' on' : ''}" data-like aria-pressed="${!!p.liked}" aria-label="${p.liked ? 'Unlike' : 'Like'}">${p.liked ? '♥' : '♡'}</button>
                <button class="lb-act" data-comments aria-expanded="${panelOpen}" aria-label="Comments">💬</button>
              </div>
              <div class="lb-by">Posted by <b>${esc(poster)}</b> · ${esc(fmt(p.date))}</div>
              <div class="lb-liked">${likedLine(p)}</div>
              ${longCaption ? `<div class="lb-caption"><b>${esc(poster)}</b> ${esc(p.caption)}</div>` : ''}
              <button class="lb-viewall" data-comments>${p.commentCount ? `View ${p.commentCount === 1 ? 'the comment' : `all ${p.commentCount} comments`}` : 'Add a comment…'}</button>
            </figcaption>
          </figure>
          ${photos.length > 1 ? '<button class="lb-nav next" aria-label="Next">›</button>' : ''}
        </div>
        <div class="lb-bottom"><div class="lb-meta">${esc(meta)}</div></div>
        ${panelOpen ? `
        <aside class="lb-panel" aria-label="Comments">
          <div class="lb-panel-head"><h3>Comments</h3><button class="btn icon" data-close-panel aria-label="Close comments">✕</button></div>
          <div class="liked-by"></div>
          <div class="comments"><p class="muted small">Loading…</p></div>
          <form class="comment-form">
            <textarea name="body" rows="1" maxlength="1000" placeholder="Add a comment…" aria-label="Add a comment"></textarea>
            <button class="btn sm primary" type="submit">Post</button>
          </form>
        </aside>` : ''}`;
      lb.classList.toggle('with-panel', panelOpen);
      lb.classList.remove('zoomed');
      $('[data-x]', lb).onclick = close;
      requestAnimationFrame(fit);

      // ---- hearts & comments
      const heartBtn = $('[data-like]', lb);
      const like = async (force) => {
        try {
          await toggleLike(p, force);
          social = true;
          paintSocial(p);
          if (p.liked) pop(heartBtn);
          if (panelOpen) loadComments(p); // refresh the "♥ who liked it" line
        } catch (e) { oops(e); }
      };
      heartBtn.onclick = () => like();
      $$('[data-comments]', lb).forEach((b) => { b.onclick = () => { panelOpen = !panelOpen; render(); }; });
      if (panelOpen) loadComments(p);

      const stage = $('.lb-stage', lb);
      stage.onclick = (e) => { if (e.target === stage && !lb.classList.contains('zoomed')) close(); };

      // Tap the photo to see it at full size (scroll to pan); tap again to fit it back.
      // Double-tap likes it, with a heart that pops up — like Instagram.
      const mediaBox = $('.lb-media', lb);
      const photo = isVideo ? null : $('img', mediaBox);
      let lastTap = 0;
      let tapTimer = 0;
      mediaBox.addEventListener('click', (e) => {
        if (isVideo && e.target.tagName === 'VIDEO') return; // let the video controls work
        const now = Date.now();
        if (now - lastTap < 300) {
          clearTimeout(tapTimer); lastTap = 0;
          if (!lb.classList.contains('zoomed')) { pop($('.heart-pop', mediaBox)); like(true); }
          return;
        }
        lastTap = now;
        if (!photo) return;
        const fx = e.offsetX / photo.clientWidth; // where on the photo was tapped, measured before zooming
        const fy = e.offsetY / photo.clientHeight;
        tapTimer = setTimeout(() => {
          if (lb.classList.toggle('zoomed')) {
            stage.scrollLeft = fx * photo.naturalWidth - stage.clientWidth / 2;
            stage.scrollTop = fy * photo.naturalHeight - stage.clientHeight / 2;
          } else fit();
        }, 300);
      });

      if (photos.length > 1) {
        $('.prev', lb).onclick = () => go(-1);
        $('.next', lb).onclick = () => go(1);
        [1, -1].forEach((n) => { new Image().src = `/media/full/${photos[(i + n + photos.length) % photos.length].id}`; }); // preload neighbours (posters for videos)
      }
      const cover = $('[data-cover]', lb);
      if (cover) cover.onclick = async () => {
        try {
          await api(`/api/events/${ev.id}`, { method: 'PATCH', body: { coverId: p.id } });
          ev.coverId = p.id;
          changed = true;
          toast('Cover photo set');
          render();
        } catch (e) { oops(e); }
      };
      const access = $('[data-access]', lb);
      if (access) access.onclick = () => editAccess(p, () => { changed = true; render(); });
      // On a phone, following the download link leaves the app (and coming back can restart it).
      // Instead, hand the photo to the share sheet, which has "Save Image". It's fetched ahead, so
      // the sheet can open straight from the tap (iPhones insist on that).
      const dl = $('[data-download]', lb);
      if (dl && !isVideo && matchMedia('(pointer: coarse)').matches && navigator.canShare) {
        const file = fetch(`/media/full/${p.id}`).then((r) => r.blob())
          .then((b) => new File([b], `photo-${p.id}.jpg`, { type: b.type || 'image/jpeg' })).catch(() => null);
        dl.onclick = async (e) => {
          const f = await Promise.race([file, new Promise((r) => setTimeout(() => r(null), 50))]);
          if (!f || !navigator.canShare({ files: [f] })) return; // not ready or not supported: the link downloads as before
          e.preventDefault();
          try { await navigator.share({ files: [f] }); } catch { /* closed the sheet */ }
        };
      }
      const spotBtn = $('[data-spot]', lb);
      if (spotBtn) spotBtn.onclick = async () => {
        try {
          await api(`/api/photos/${p.id}/spot`, { method: 'PUT', body: { reset: true } });
          p.posX = null; p.posY = null;
          changed = true;
          toast('Back to its automatic spot');
          render();
        } catch (e) { oops(e); }
      };
      const evBtn = $('[data-event]', lb);
      if (evBtn) evBtn.onclick = () => editEvent(p, () => { changed = true; render(); });
      const cap = $('[data-caption]', lb);
      if (cap) cap.onclick = () => editCaption(p, () => { changed = true; render(); });
      const del = $('[data-del]', lb);
      if (del) del.onclick = async () => {
        if (!confirm('Delete this photo for everyone? This can’t be undone.')) return;
        try {
          await api(`/api/photos/${p.id}`, { method: 'DELETE' });
          photos.splice(i, 1);
          changed = true;
          toast('Photo deleted');
          if (!photos.length) return close();
          i = Math.min(i, photos.length - 1);
          render();
        } catch (e) { oops(e); }
      };
    }

    async function loadComments(p) {
      const panel = $('.lb-panel', lb);
      const list = $('.comments', panel);
      const form = $('.comment-form', panel);
      const input = form.elements.body;
      $('[data-close-panel]', panel).onclick = () => { panelOpen = false; render(); };
      // grow the box as you type; Enter posts, Shift+Enter makes a new line
      input.oninput = () => { input.style.height = 'auto'; input.style.height = `${Math.min(120, input.scrollHeight)}px`; };
      input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } };

      const showOne = (c) => `
        <div class="comment" data-id="${c.id}">
          <div><strong>${esc(c.userName || 'A former member')}</strong> <span class="when">${esc(timeAgo(c.createdAt))}</span></div>
          <p>${esc(c.body)}</p>
          ${c.canDelete ? '<button class="link danger" data-del-comment>Delete</button>' : ''}
        </div>`;
      const draw = (comments, likedBy) => {
        if (photos[i] !== p || !list.isConnected) return; // moved on to another photo meanwhile
        $('.liked-by', panel).textContent = likedBy.length ? `♥ ${likedBy.join(', ')}` : '';
        list.innerHTML = comments.length ? comments.map(showOne).join('') : '<p class="muted small">No comments yet. Be the first!</p>';
        list.scrollTop = list.scrollHeight;
      };

      let comments = [];
      let likers = [];
      try {
        ({ comments, likedBy: likers } = await api(`/api/photos/${p.id}/comments`));
        draw(comments, likers);
      } catch (e) { return oops(e); }

      list.onclick = async (e) => {
        const b = e.target.closest('[data-del-comment]');
        if (!b || !confirm('Delete this comment?')) return;
        const cid = Number(b.closest('.comment').dataset.id);
        try {
          await api(`/api/comments/${cid}`, { method: 'DELETE' });
          comments = comments.filter((c) => c.id !== cid);
          p.commentCount = comments.length; social = true;
          paintSocial(p);
          draw(comments, likers);
        } catch (err) { oops(err); }
      };
      form.onsubmit = async (e) => {
        e.preventDefault();
        const body = input.value.trim();
        if (!body) return;
        const btn = $('[type=submit]', form);
        btn.disabled = true;
        try {
          const c = await api(`/api/photos/${p.id}/comments`, { method: 'POST', body: { body } });
          comments.push(c);
          p.commentCount = comments.length; social = true;
          input.value = ''; input.style.height = '';
          paintSocial(p);
          list.querySelector('p.muted')?.remove();
          list.insertAdjacentHTML('beforeend', showOne(c));
          list.scrollTop = list.scrollHeight;
        } catch (err) { oops(err); } finally { btn.disabled = false; }
      };
    }

    render();
  }

  // "just now", "5m", "3h", "2d", then a date. SQLite gives UTC as "YYYY-MM-DD HH:MM:SS".
  function timeAgo(s) {
    const t = new Date(`${s.replace(' ', 'T')}Z`);
    const sec = (Date.now() - t) / 1000;
    if (sec < 60) return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
    if (sec < 7 * 86400) return `${Math.floor(sec / 86400)}d`;
    return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: t.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  const canChange = (p) => state.user.isAdmin || p.uploadedBy === state.user.id;

  // Tick photos from the event's day that aren't in an event yet, and pin them into it.
  function addFromDay(ev, loose, done) {
    const picked = new Set();
    const m = modal(`
      ${head(`Add to ${esc(ev.emoji || '⭐')} ${esc(ev.title)}`, esc(`Photos and videos from ${fmtLong(ev.date)} that aren’t in an event yet. Tap the ones that belong.`))}
      <div class="mg-grid pick-grid">${loose.map((p) => `
        <button class="mg-item" type="button" data-id="${p.id}" aria-pressed="false">
          <img loading="lazy" src="/media/thumb/${p.id}" alt="${esc(p.caption || '')}">
          <span class="mg-check" aria-hidden="true">✓</span>
          ${p.kind === 'video' ? '<span class="mg-badge">▶</span>' : ''}
        </button>`).join('')}</div>
      <p class="error"></p>
      <div class="row end"><button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="button" class="btn sm ghost" data-all>Select all</button>
        <button type="button" class="btn primary" data-go disabled>Add to event</button></div>`, { cls: 'wide' });
    const go = $('[data-go]', m.el);
    const update = () => {
      go.disabled = !picked.size;
      go.textContent = picked.size ? `Add ${mediaCount(loose.filter((p) => picked.has(p.id)))} to event` : 'Add to event';
    };
    const set = (tile, on) => {
      const pid = Number(tile.dataset.id);
      if (on) picked.add(pid); else picked.delete(pid);
      tile.classList.toggle('on', on);
      tile.setAttribute('aria-pressed', on);
    };
    $$('.mg-item', m.el).forEach((t) => { t.onclick = () => { set(t, !t.classList.contains('on')); update(); }; });
    $('[data-all]', m.el).onclick = () => { $$('.mg-item', m.el).forEach((t) => set(t, true)); update(); };
    go.onclick = async () => {
      go.disabled = true;
      try {
        const r = await api(`/api/events/${ev.id}/photos`, { method: 'POST', body: { photoIds: [...picked] } });
        m.close();
        toast(`Added ${mediaCount(loose.filter((p) => picked.has(p.id)))} to ${ev.title}`);
        done();
      } catch (e) { $('.error', m.el).textContent = e.message; go.disabled = false; }
    };
  }

  // Put one photo in an event (or take it out). It moves to that event's day.
  async function editEvent(photo, done) {
    let events;
    try { events = await api('/api/events'); } catch (e) { return oops(e); }
    events.sort((x, y) => (x.date === y.date ? y.id - x.id : y.date.localeCompare(x.date))); // newest first
    const m = modal(`
      ${head('Which event?', 'Putting it in an event on another day moves it to that day.')}
      <form class="form">
        <div class="event-pick">
          <label><input type="radio" name="eventId" value=""${photo.eventId ? '' : ' checked'}> <span>No event</span><em>${esc(fmt(photo.date))}</em></label>
          ${events.map((e) => `<label><input type="radio" name="eventId" value="${e.id}"${e.id === photo.eventId ? ' checked' : ''}>
            <span>${esc(e.emoji || '⭐')} ${esc(e.title)}</span><em>${esc(fmt(e.date))}${e.date !== photo.date ? ' · moves it' : ''}</em></label>`).join('')}
        </div>
        <p class="error"></p>
        <div class="row end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
      </form>`, { z: 70 });
    onSubmit($('form', m.el), async (f) => {
      const updated = await api(`/api/photos/${photo.id}`, { method: 'PATCH', body: { eventId: f.eventId ? Number(f.eventId) : null } });
      Object.assign(photo, updated);
      m.close();
      done();
    });
  }

  function editCaption(photo, done) {
    const m = modal(`
      ${head('Caption')}
      <form class="form">
        <textarea name="caption" maxlength="500" placeholder="What’s happening here?">${esc(photo.caption || '')}</textarea>
        <p class="error"></p>
        <div class="row end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
      </form>`, { z: 70 });
    onSubmit($('form', m.el), async (f) => {
      const updated = await api(`/api/photos/${photo.id}`, { method: 'PATCH', body: { caption: f.caption } });
      photo.caption = updated.caption;
      m.close();
      done();
    });
  }

  // ---------------------------------------------------------------- privacy

  // "Who can see these?" — everyone, or only the people ticked. The uploader always can.
  function accessPicker(members, { restricted = false, userIds = [], ownerId = state.user.id } = {}) {
    const others = members.filter((m) => m.id !== ownerId);
    return `
      <div class="field access">Who can see ${ownerId === state.user.id ? 'these' : 'this'}?
        <div class="access-modes">
          <label><input type="radio" name="restricted" value="0"${restricted ? '' : ' checked'}> 👨‍👩‍👧 Everyone in the family</label>
          <label><input type="radio" name="restricted" value="1"${restricted ? ' checked' : ''}> 🔒 Only people I choose</label>
        </div>
        <div class="access-people${restricted ? '' : ' hidden'}">
          ${others.length ? others.map((m) => `
            <label><input type="checkbox" name="allowed" value="${m.id}"${userIds.includes(m.id) ? ' checked' : ''}> ${esc(m.displayName)}</label>`).join('')
            : '<span class="muted small">No one else has an account yet.</span>'}
          <span class="hint">${ownerId === state.user.id ? 'You' : 'The person who added it'} can always see it. No one else can — not even admins.</span>
        </div>
      </div>`;
  }
  function bindAccessPicker(el) {
    const people = $('.access-people', el);
    $$('input[name=restricted]', el).forEach((r) => {
      r.onchange = () => people.classList.toggle('hidden', $('input[name=restricted]:checked', el).value !== '1');
    });
    return () => ({
      restricted: $('input[name=restricted]:checked', el).value === '1',
      allowed: $$('input[name=allowed]:checked', el).map((c) => Number(c.value)),
    });
  }

  function editAccess(photo, done) {
    Promise.all([api('/api/members'), api(`/api/photos/${photo.id}/access`)]).then(([members, access]) => {
      const m = modal(`
        ${head('Who can see this photo?')}
        <form class="form">
          ${accessPicker(members, { restricted: access.restricted, userIds: access.userIds, ownerId: access.uploadedBy })}
          <p class="error"></p>
          <div class="row end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
        </form>`, { z: 70 });
      const read = bindAccessPicker(m.el);
      onSubmit($('form', m.el), async () => {
        const { restricted, allowed } = read();
        const updated = await api(`/api/photos/${photo.id}`, { method: 'PATCH', body: { restricted, allowedUserIds: allowed } });
        photo.restricted = updated.restricted;
        m.close();
        toast(restricted ? 'Photo is now private 🔒' : 'Everyone can see this photo now');
        done();
      });
    }).catch(oops);
  }

  // ---------------------------------------------------------------- upload

  async function openUpload({ date, eventId } = {}) {
    let events;
    let members;
    try { [events, members] = await Promise.all([api('/api/events'), api('/api/members')]); } catch (e) { return oops(e); }
    const m = modal(`
      ${head('Add photos & videos', 'Choose a day, and who gets to see them.')}
      <form class="form">
        <div class="grid-2">
          <label class="field">Which day?<input type="date" name="date" required></label>
          <label class="field">Part of an event?
            <select name="eventId">
              <option value="">No event — just a day</option>
              ${events.map((e) => `<option value="${e.id}" data-date="${e.date}">${esc(`${e.emoji ? `${e.emoji} ` : ''}${e.title}`)} · ${esc(fmt(e.date))}</option>`).join('')}
            </select>
          </label>
        </div>
        <label class="drop">
          <input type="file" accept="image/*,video/*" multiple hidden>
          <div class="big">📷</div>
          <div>Tap to choose photos or videos, or drag them here</div>
        </label>
        <div class="previews"></div>
        <label class="field">Note <span class="hint">Optional — added to every photo in this batch</span>
          <input type="text" name="caption" maxlength="500" placeholder="First cuddle with Grandma"></label>
        ${accessPicker(members)}
        <div class="progress hidden"><div></div></div>
        <p class="error"></p>
        <div class="row end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Upload</button></div>
      </form>`);
    const form = $('form', m.el);
    const dateIn = form.elements.date;
    const eventSel = form.elements.eventId;
    const drop = $('.drop', form);
    const fileIn = $('input[type=file]', form);
    const previews = $('.previews', form);
    const submit = $('[type=submit]', form);
    const readAccess = bindAccessPicker(form);
    let files = [];

    dateIn.value = date || todayISO();
    const syncEvent = () => {
      const opt = eventSel.selectedOptions[0];
      if (opt?.dataset.date) dateIn.value = opt.dataset.date;
      dateIn.disabled = !!eventSel.value;
    };
    if (eventId) eventSel.value = String(eventId);
    syncEvent();
    eventSel.onchange = syncEvent;

    const isVid = (f) => f.type.startsWith('video/');
    const showFiles = () => {
      previews.querySelectorAll('img, video').forEach((el) => URL.revokeObjectURL(el.src));
      previews.innerHTML = files.map((f, i) => `<div>${isVid(f)
        ? `<video src="${URL.createObjectURL(f)}#t=0.5" muted playsinline preload="metadata"></video><span class="play" style="width:26px;height:26px;margin:-13px 0 0 -13px;font-size:11px">▶</span>`
        : `<img src="${URL.createObjectURL(f)}" alt="">`}<button type="button" data-rm="${i}" aria-label="Remove">✕</button></div>`).join('');
      const v = files.filter(isVid).length;
      const p = files.length - v;
      submit.textContent = files.length ? `Upload ${[p && plural(p, 'photo'), v && plural(v, 'video')].filter(Boolean).join(' and ')}` : 'Upload';
    };
    const addFiles = (list) => { files = files.concat([...list].filter((f) => /^(image|video)\//.test(f.type))); showFiles(); };
    fileIn.onchange = () => { addFiles(fileIn.files); fileIn.value = ''; };
    previews.onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { files.splice(Number(b.dataset.rm), 1); showFiles(); } };
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

    onSubmit(form, async () => {
      if (!files.length) throw new Error('Choose at least one photo or video.');
      const access = readAccess();
      const bar = $('.progress', form);
      bar.classList.remove('hidden');
      const total = files.reduce((n, f) => n + f.size, 0) || 1;
      let done = 0;
      let saved = 0;
      const failed = [];
      // Send photos a few at a time and each video on its own, so big batches from a phone don't time out.
      const photosOnly = files.filter((f) => !isVid(f));
      const batches = [...files.filter(isVid).map((v) => [v])];
      for (let i = 0; i < photosOnly.length; i += 4) batches.unshift(photosOnly.slice(i, i + 4));
      for (const batch of batches) {
        const fd = new FormData();
        fd.append('date', dateIn.value);
        if (eventSel.value) fd.append('eventId', eventSel.value);
        fd.append('caption', form.elements.caption.value);
        if (access.restricted) {
          fd.append('restricted', '1');
          fd.append('allowed', access.allowed.join(','));
        }
        batch.forEach((f) => fd.append('photos', f));
        const res = await sendWithProgress(fd, (loaded) => {
          $('div', bar).style.width = `${Math.min(100, ((done + loaded) / total) * 100)}%`;
        });
        done += batch.reduce((n, f) => n + f.size, 0);
        saved += res.saved.length;
        failed.push(...res.failed);
      }
      m.close();
      toast(`${saved} ${saved === 1 ? 'memory' : 'memories'} added 🎉${files.some(isVid) ? ' Videos will be ready to play in a minute or two.' : ''}`);
      if (failed.length) toast(`Couldn’t read: ${failed.join(', ')}`, true);
      const [tab] = currentRoute();
      route(tab === 'timeline' ? { focusDate: dateIn.value } : {});
    });
  }

  function sendWithProgress(fd, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', '/api/photos');
      x.setRequestHeader('X-Tab', TAB_ID);
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
      x.onload = () => {
        let data = null;
        try { data = JSON.parse(x.responseText); } catch { /* not json */ }
        if (x.status >= 200 && x.status < 300) return resolve(data);
        const err = new Error(data?.message || 'Upload failed.');
        if (x.status === 401) { err.handled = true; boot(); }
        reject(err);
      };
      x.onerror = () => reject(new Error('Network problem — check your connection and try again.'));
      x.send(fd);
    });
  }

  // ---------------------------------------------------------------- events

  function openEventForm(existing) {
    let emoji = existing ? existing.emoji || '' : '⭐';
    const m = modal(`
      ${head(existing ? 'Edit event' : 'New event', existing ? '' : 'A birthday, a first, a visit — anything worth remembering.')}
      <form class="form">
        <label class="field">Title<input type="text" name="title" maxlength="80" placeholder="First tooth" required value="${esc(existing?.title || '')}"></label>
        <label class="field">Date<input type="date" name="date" required value="${esc(existing?.date || todayISO())}"></label>
        <div class="field">Icon
          <div class="emoji-pick"></div>
          <div class="emoji-full hidden"></div>
        </div>
        <label class="field">Description <span class="hint">Optional</span><textarea name="description" maxlength="1000">${esc(existing?.description || '')}</textarea></label>
        <p class="error"></p>
        <div class="row end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">${existing ? 'Save' : 'Create event'}</button></div>
      </form>`);
    // The usual picks (plus the chosen one, if it's from the full set), then "More" for every emoji.
    const quick = $('.emoji-pick', m.el);
    const paintQuick = () => {
      const list = emoji && !EMOJI.includes(emoji) ? [emoji, ...EMOJI] : EMOJI;
      quick.innerHTML = list.map((e) => `<button type="button" data-e="${esc(e)}" class="${e === emoji ? 'on' : ''}" aria-label="${esc(e)}">${esc(e)}</button>`).join('')
        + '<button type="button" class="emoji-more" aria-expanded="false">＋ More</button>';
    };
    paintQuick();
    quick.onclick = (e) => {
      if (e.target.closest('.emoji-more')) return toggleFull();
      const b = e.target.closest('[data-e]');
      if (!b) return;
      emoji = b.classList.contains('on') ? '' : b.dataset.e;
      paintQuick();
    };
    const full = $('.emoji-full', m.el);
    async function toggleFull() {
      const open = full.classList.toggle('hidden') === false;
      $('.emoji-more', quick)?.setAttribute('aria-expanded', open);
      if (!open || full.firstChild) return;
      full.innerHTML = '<p class="muted small">Loading every emoji…</p>';
      try {
        await import('/vendor/emoji-picker/index.js'); // the picker, loaded the first time it's needed
      } catch {
        full.innerHTML = '<p class="error">Couldn’t load the emoji picker. Try again in a moment.</p>';
        return;
      }
      const picker = document.createElement('emoji-picker');
      picker.dataSource = '/vendor/emoji-data.json';
      picker.classList.add(isDarkTheme() ? 'dark' : 'light');
      picker.addEventListener('emoji-click', (ev) => {
        emoji = ev.detail.unicode;
        paintQuick();
        full.classList.add('hidden');
        toast(`${emoji} chosen`);
      });
      full.replaceChildren(picker);
    }
    onSubmit($('form', m.el), async (f) => {
      const body = { ...f, emoji };
      if (existing) {
        await api(`/api/events/${existing.id}`, { method: 'PATCH', body });
        m.close();
        toast('Event saved');
        route();
      } else {
        const { id } = await api('/api/events', { method: 'POST', body });
        m.close();
        toast('Event created');
        location.hash = `#/events/${id}`;
      }
    });
  }

  async function viewEvents(main) {
    loading(main);
    const events = await api('/api/events');
    main.innerHTML = `
      <div class="page-head">
        <div><h2>Events</h2><p>The big moments and the little firsts.</p></div>
        <button class="btn primary" id="newEvent">＋ New event</button>
      </div>
      <div class="board"><div class="cork">
      ${events.length ? `<div class="ev-grid">${events.map((e) => `
        <a class="ev-card" href="#/events/${e.id}" style="--r:${tilt(e.id)}">
          <span class="pin"></span>
          <div class="ev-thumb">${e.coverId ? `<img loading="lazy" src="/media/thumb/${e.coverId}" alt="">` : esc(e.emoji || '⭐')}</div>
          <div class="ev-title">${esc(`${e.emoji ? `${e.emoji} ` : ''}${e.title}`)}</div>
        </a>`).join('')}</div>`
        : '<div class="empty"><div class="big">🎈</div><h3>No events yet</h3><p>Mark birthdays, firsts and visits so they stand out on the timeline.</p></div>'}
      </div></div>`;
    $('#newEvent', main).onclick = () => openEventForm();
  }

  async function viewEvent(main, id) {
    loading(main);
    let data;
    try { data = await api(`/api/events/${id}`); } catch (e) {
      if (e.status !== 404) throw e;
      main.innerHTML = '<a class="back" href="#/events">← All events</a><div class="empty"><div class="big">🎈</div><h3>That event is gone</h3><p>It may have been deleted.</p></div>';
      return;
    }
    const { event: ev, photos } = data;
    const sub = [fmtLong(ev.date), age(ev.date), mediaCount(photos)].filter(Boolean).join(' · ');
    main.innerHTML = `
      <div class="swipe-page">
      <a class="back" href="#/events">← All events</a>
      <div class="ev-hero">
        <div class="ev-emoji">${esc(ev.emoji || '⭐')}</div>
        <div>
          <h2>${esc(ev.title)}</h2>
          <div class="meta">${esc(sub)}</div>
          ${ev.description ? `<p class="desc">${esc(ev.description)}</p>` : ''}
        </div>
        <div class="actions row">
          <button class="btn sm primary" data-act="add">＋ Add photos</button>
          <button class="btn sm hidden" data-act="from-day">📌 From this day</button>
          ${ev.canEdit ? '<button class="btn sm" data-act="edit">✎ Edit</button><button class="btn sm danger" data-act="del">Delete</button>' : ''}
        </div>
      </div>
      <div class="board"><div class="cork">
        ${photos.length ? photoGrid(photos) : '<div class="empty"><div class="big">📷</div><h3>Nothing pinned yet</h3><p>Be the first to add photos or videos from this day.</p></div>'}
      </div></div>
      </div>`;
    swipeBack($('.swipe-page', main), () => goBack('#/events')); // swipe right → back to the timeline or Events
    $('[data-act=add]', main).onclick = () => openUpload({ eventId: ev.id });
    // photos already added to this day without an event (the event may have been made afterwards)
    api(`/api/photos?date=${ev.date}`).then((dayPhotos) => {
      const loose = dayPhotos.filter((p) => !p.eventId && canChange(p));
      const btn = $('[data-act=from-day]', main);
      if (!loose.length || !btn) return;
      btn.classList.remove('hidden');
      btn.onclick = () => addFromDay(ev, loose, () => route());
    }).catch(() => { /* the button just stays hidden */ });
    $('[data-act=edit]', main)?.addEventListener('click', () => openEventForm(ev));
    $('[data-act=del]', main)?.addEventListener('click', async () => {
      if (!confirm(`Delete “${ev.title}”? Its photos will stay on the timeline, just without this event.`)) return;
      try {
        await api(`/api/events/${ev.id}`, { method: 'DELETE' });
        toast('Event deleted');
        location.hash = '#/events';
      } catch (e) { oops(e); }
    });
    bindGrid(main, photos, { event: ev, onChange: () => route() });
  }

  // ---------------------------------------------------------------- settings

  // ---------------------------------------------------------------- push notifications
  // Each device signs up on its own (Settings → Notifications). On iPhone that only works in the
  // Home Screen app, not in Safari itself. A small background worker (sw.js) shows them.
  const canPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const inHomeScreenApp = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* not available (e.g. plain http) */ });
    // a notification tapped while the scrapbook is open: go where it points
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'open') location.hash = new URL(e.data.url).hash || '#/timeline';
    });
  }
  const b64ToBytes = (b64) => {
    const raw = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  async function pushSubscription() {
    if (!canPush()) return null;
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg ? reg.pushManager.getSubscription() : null;
  }
  async function pushOn() {
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications weren’t allowed. You can allow them in this browser’s or phone’s settings.');
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('/api/push/key');
    const sub = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  }
  async function pushOff() {
    try {
      const sub = await pushSubscription();
      if (!sub) return;
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    } catch { /* nothing to turn off */ }
  }
  // What this device can do, and a button to turn it on or off.
  async function showPushDevice(el) {
    if (!canPush()) {
      el.innerHTML = isIOS() && !inHomeScreenApp()
        ? 'On iPhone: tap <b>Share</b> → <b>Add to Home Screen</b>, then open the scrapbook from your Home Screen and turn notifications on there.'
        : 'This browser can’t show notifications.';
      return;
    }
    if (Notification.permission === 'denied') {
      el.textContent = 'Notifications are blocked for this site. Allow them in this browser’s or phone’s settings, then come back here.';
      return;
    }
    const on = !!(await pushSubscription());
    el.innerHTML = `<div class="row"><span>${on ? '🔔 On for this device' : '🔕 Off for this device'}</span>
      ${on ? '<button class="btn sm ghost" id="push-test" type="button">Send a test</button><button class="btn sm" id="push-off" type="button">Turn off</button>'
        : '<button class="btn sm primary" id="push-on" type="button">Turn on for this device</button>'}</div>`;
    const wire = (id, fn) => { const b = $(`#${id}`, el); if (b) b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { oops(e); } showPushDevice(el); }; };
    wire('push-on', async () => { await pushOn(); toast('Notifications on for this device'); });
    wire('push-off', async () => { await pushOff(); toast('Notifications off for this device'); });
    wire('push-test', async () => { await api('/api/push/test', { method: 'POST' }); toast('Test sent — it should arrive in a few seconds'); });
  }

  // ---------------------------------------------------------------- installing the app
  // Chrome (on Android especially) can install the scrapbook like an app. It tells the page when
  // that's possible; we hold on to it and offer our own Install button instead of Chrome's small hint.
  // (iPhones don't allow this: there it's Share → Add to Home Screen.)
  let installOffer = null;
  const INSTALL_HIDDEN = 'sb_install_hidden';
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installOffer = e;
    showInstallBar();
    refreshAppCard();
  });
  window.addEventListener('appinstalled', () => {
    installOffer = null;
    $('#install-bar')?.remove();
    refreshAppCard();
    toast('Installed — the scrapbook is on your Home screen now');
  });
  async function installApp() {
    const offer = installOffer;
    if (!offer) return;
    installOffer = null;
    $('#install-bar')?.remove();
    offer.prompt();
    try { await offer.userChoice; } catch { /* closed */ }
    refreshAppCard();
  }
  // A small "Get the app" bar for Android phones, until it's installed or waved away.
  function showInstallBar() {
    if (!installOffer || !state.user || $('#install-bar') || !/Android/i.test(navigator.userAgent)) return;
    try { if (localStorage.getItem(INSTALL_HIDDEN)) return; } catch { /* private mode */ }
    const bar = document.createElement('div');
    bar.id = 'install-bar';
    bar.className = 'install-bar';
    bar.innerHTML = `<img src="/icon-192.png" alt="">
      <div><b>Get the app</b><span>Add the scrapbook to your Home screen</span></div>
      <button class="btn sm primary" type="button" data-install>Install</button>
      <button class="btn icon ghost" type="button" data-hide aria-label="Not now">✕</button>`;
    document.body.appendChild(bar);
    $('[data-install]', bar).onclick = installApp;
    $('[data-hide]', bar).onclick = () => {
      bar.remove();
      try { localStorage.setItem(INSTALL_HIDDEN, '1'); } catch { /* private mode */ }
      toast('You can install it any time from Settings');
    };
  }
  // Settings → App: install, or how to, for whichever phone or browser this is.
  function refreshAppCard() {
    const el = $('#app-install');
    if (!el) return;
    if (inHomeScreenApp()) el.innerHTML = '<p class="muted small">✓ You’re using the scrapbook app.</p>';
    else if (installOffer) {
      el.innerHTML = '<div class="row end"><button class="btn primary" type="button" id="app-install-btn">Install the app</button></div>';
      $('#app-install-btn', el).onclick = installApp;
    } else if (isIOS()) el.innerHTML = '<p class="muted small">In Safari, tap <b>Share</b> → <b>Add to Home Screen</b>.</p>';
    else if (/Android/i.test(navigator.userAgent)) el.innerHTML = '<p class="muted small">In Chrome, tap <b>⋮</b> → <b>Install app</b> (or <b>Add to Home screen</b>).</p>';
    else el.innerHTML = '<p class="muted small">On a phone, open the scrapbook in Chrome (Android) or Safari (iPhone) to add it to your Home screen.</p>';
  }

  // ---------------------------------------------------------------- make your own theme
  const THEME_PICKS = [
    ['bg', 'Background', 'Behind everything'],
    ['accent', 'Highlight', 'Buttons, links and pins'],
    ['event', 'Events', 'Event badges and names'],
    ['cork', 'Cork board', 'Where the photos are pinned'],
    ['frame', 'Board frame', 'The wooden edge around the board'],
    ['polaroid', 'Polaroid frames', 'Around every photo'],
    ['polaroidInk', 'Polaroid writing', 'Captions and photo counts'],
    ['twine', 'Twine', 'The line the days hang on'],
    ['date', 'Date cards', 'The cards with each day’s date'],
    ['dateInk', 'Date writing', 'The date and age on those cards'],
  ];
  const cssHex = (v) => { v = v.trim(); return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : /^#[0-9a-f]{3}$/i.test(v) ? `#${[...v.slice(1)].map((ch) => ch + ch).join('')}`.toLowerCase() : '#888888'; };
  function currentPalette() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cssHex(cs.getPropertyValue(n));
    return { bg: g('--bg'), accent: g('--accent'), event: g('--event'), cork: rgbHex(hexRgb(g('--cork')).map((v) => v * 0.843)), polaroid: g('--polaroid'), twine: g('--twine'),
      date: g('--date-bg'), dateInk: g('--date-ink'), polaroidInk: g('--polaroid-ink'), frame: g('--wood') };
  }
  // Edit (or make) a theme. The whole site shows it live while you pick; Cancel puts yours back.
  function openThemeEditor(existing) {
    let saved = false;
    let picks = existing
      ? { date: '#fffdf6', dateInk: '#3b2f28', polaroidInk: autoPolaroidInk(existing.colors.polaroid), frame: mixHex(existing.colors.cork, '#000000', 0.6), ...existing.colors }
      : currentPalette();
    const m = modal(`
      ${head(existing ? 'Edit theme' : 'Make your own theme', 'Pick a few colours, or roll the dice. Everything else is worked out so it all stays easy to read.')}
      <form class="form theme-editor">
        <label class="field">Name<input type="text" name="name" maxlength="30" required value="${esc(existing?.name || 'My theme')}"></label>
        <div class="te-preview" aria-hidden="true">
          <div class="te-board"><span class="te-twine"></span>
            <div class="te-pol"><span class="pin"></span><i></i><b>tiny hands</b></div>
            <div class="te-date"><b>Oct 15</b><span>Birth day</span></div>
            <div class="te-pol two"><span class="pin"></span><i></i><b>first nap</b></div>
          </div>
          <div class="te-ui"><span class="te-badge">🎂 Birthday</span><span class="te-btn">＋ Add photos</span><span class="te-text">Text looks like this</span></div>
        </div>
        <div class="te-picks">${THEME_PICKS.map(([k, label, hint]) => `
          <label class="te-pick"><input type="color" data-k="${k}" value="${picks[k]}"><span><b>${label}</b><small>${hint}</small></span></label>`).join('')}</div>
        <button type="button" class="btn te-random" data-random>🎲 Random palette</button>
        <p class="error"></p>
        <div class="row end">${existing ? '<button type="button" class="btn danger te-delete" data-delete>Delete</button>' : ''}
          <button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save theme</button></div>
      </form>`, { cls: 'wide', onClose: () => { if (!saved) applyTheme(state.user.theme); } });
    const show = () => {
      paintThemeVars(themeVars(picks));
      document.documentElement.dataset.theme = 'custom';
      $$('input[type=color]', m.el).forEach((inp) => { inp.value = picks[inp.dataset.k]; });
    };
    $$('input[type=color]', m.el).forEach((inp) => { inp.addEventListener('input', () => { picks[inp.dataset.k] = inp.value; show(); }); });
    $('[data-random]', m.el).onclick = () => { picks = randomPalette(); show(); };
    show();
    const store = async (themes, use) => {
      state.user = await api('/api/me/themes', { method: 'PUT', body: { themes } });
      if (use) state.user = await api('/api/me', { method: 'PATCH', body: { theme: use } });
      saved = true;
      m.close();
      applyTheme(state.user.theme);
      route();
    };
    onSubmit($('form', m.el), async (f) => {
      const id = existing?.id || Math.random().toString(36).slice(2, 10);
      const mine = { id, name: f.name, colors: picks };
      const list = (state.user.customThemes || []).filter((t) => t.id !== id);
      await store(existing ? (state.user.customThemes || []).map((t) => (t.id === id ? mine : t)) : [...list, mine], `custom:${id}`);
      toast(existing ? 'Theme saved' : 'Theme saved and switched on');
    });
    $('[data-delete]', m.el)?.addEventListener('click', async () => {
      if (!confirm(`Delete “${existing.name}”?`)) return;
      try {
        await store((state.user.customThemes || []).filter((t) => t.id !== existing.id), null);
        toast('Theme deleted');
      } catch (e) { oops(e); }
    });
  }

  async function viewSettings(main) {
    const u = state.user;
    const site = state.site;
    main.innerHTML = `
      <div class="page-head"><div><h2>Settings</h2><p>Signed in as <strong>${esc(u.username)}</strong>${u.isAdmin ? ' <span class="pill">Admin</span>' : ''}</p></div>
        <div class="row"><button class="btn" id="whats-new" type="button">✨ What’s new</button><button class="btn" id="logout">Log out</button></div></div>
      <div class="settings">
        <section class="card">
          <h3>Theme</h3><p>Pick the look you like. It follows your account to any device.</p>
          <div class="themes">${THEMES.map((t) => `
            <button class="theme-swatch${t.id === u.theme ? ' on' : ''}" data-theme-id="${t.id}" style="--sw-bg:${t.bg};--sw-text:${t.text}">
              <span class="dots">${t.dots.map((c) => `<i style="background:${c}"></i>`).join('')}</span>${t.name}
            </button>`).join('')}${(u.customThemes || []).map((t) => { const v = themeVars(t.colors); return `
            <div class="theme-swatch custom${`custom:${t.id}` === u.theme ? ' on' : ''}" data-theme-id="custom:${t.id}" role="button" tabindex="0" style="--sw-bg:${v['--bg']};--sw-text:${v['--text']}">
              <span class="dots">${[t.colors.accent, t.colors.event, t.colors.polaroid].map((c) => `<i style="background:${c}"></i>`).join('')}</span>${esc(t.name)}
              <button type="button" class="theme-edit-btn" data-edit="${t.id}" aria-label="Edit ${esc(t.name)}">✎</button>
            </div>`; }).join('')}
            ${(u.customThemes || []).length < 8 ? '<button type="button" class="theme-swatch theme-new" data-new>＋<span>Make your own</span></button>' : ''}</div>
        </section>

        <section class="card">
          <h3>Profile</h3><p>This name shows next to the photos you add.</p>
          <form class="form" id="profile">
            <div class="grid-2">
              <label class="field">Your name<input type="text" name="displayName" maxlength="60" required value="${esc(u.displayName)}"></label>
              <label class="field">Email<input type="email" name="email" maxlength="200" value="${esc(u.email || '')}"></label>
            </div>
            <p class="error"></p>
            <div class="row end"><button class="btn primary" type="submit">Save profile</button></div>
          </form>
        </section>

        <section class="card">
          <h3>Password</h3><p>Changing it signs you out everywhere else.</p>
          <form class="form" id="password">
            <label class="field">Current password<input type="password" name="current" autocomplete="current-password" required></label>
            <div class="grid-2">
              <label class="field">New password<input type="password" name="next" autocomplete="new-password" minlength="8" required></label>
              <label class="field">Confirm new password<input type="password" name="next2" autocomplete="new-password" required></label>
            </div>
            <p class="error"></p>
            <div class="row end"><button class="btn primary" type="submit">Change password</button></div>
          </form>
        </section>

        <section class="card">
          <h3>App</h3><p>Put the scrapbook on your phone’s Home screen, with its own icon, like any other app.</p>
          <div id="app-install"></div>
        </section>

        <section class="card">
          <h3>Notifications</h3><p>Get a notification on your phone or computer when something new is added.</p>
          <div id="push-device" class="push-device muted small">Checking this device…</div>
          <div class="push-prefs">
            <label class="check"><input type="checkbox" id="np" ${u.notifyPhotos ? 'checked' : ''}> New photos and videos</label>
            <label class="check"><input type="checkbox" id="nc" ${u.notifyComments ? 'checked' : ''}> Comments on photos I posted</label>
          </div>
        </section>

        ${u.isAdmin ? `
        <section class="card admin">
          <h3>Scrapbook <span class="pill">Admin</span></h3><p>The birth date is used to show ages along the timeline.</p>
          <form class="form" id="site">
            <div class="grid-2">
              <label class="field">Baby’s name<input type="text" name="babyName" maxlength="60" required value="${esc(site.babyName)}"></label>
              <label class="field">Birth date<input type="date" name="birthDate" value="${esc(site.birthDate || '')}"></label>
            </div>
            <p class="error"></p>
            <div class="row end"><button class="btn primary" type="submit">Save</button></div>
          </form>
        </section>

        <section class="card admin">
          <h3>Family PIN <span class="pill">Admin</span></h3><p>Everyone (except you, on this device) will have to enter the new PIN next time they visit.</p>
          <form class="form" id="pin" autocomplete="off">
            <div class="grid-2">
              <label class="field">New PIN <span class="hint">4–12 digits</span><input type="password" name="pin" inputmode="numeric" pattern="\\d{4,12}" required></label>
              <label class="field">Confirm new PIN<input type="password" name="pin2" inputmode="numeric" required></label>
            </div>
            <label class="field">Your password<input type="password" name="password" autocomplete="current-password" required></label>
            <p class="error"></p>
            <div class="row end"><button class="btn primary" type="submit">Change PIN</button></div>
          </form>
        </section>

        <section class="card admin">
          <h3>Photos &amp; videos <span class="pill">Admin</span></h3><p>Scroll through everything that’s been added and delete photos or videos in bulk, without opening each one.</p>
          <div class="row end"><a class="btn primary" href="#/manage">Manage photos</a></div>
        </section>

        <section class="card admin">
          <h3>Who shared this? <span class="pill">Admin</span></h3><p>Everyone’s copy of a photo carries an invisible mark of their own. Found one of ours somewhere else? Add it here to see whose copy it was, and who has looked at that photo.</p>
          <div class="row end"><a class="btn primary" href="#/trace">Check a photo</a></div>
        </section>

        <section class="card admin">
          <h3>Family members <span class="pill">Admin</span></h3><p>People join by entering the PIN and creating an account. Remove anyone who shouldn’t have access.</p>
          <div id="members" class="muted">Loading…</div>
        </section>` : ''}
      </div>`;

    $('#whats-new', main).onclick = () => showNews(true);
    $('#logout', main).onclick = async () => {
      await pushOff(); // this device stops getting this account's notifications
      try { await api('/api/logout', { method: 'POST' }); } catch { /* already gone */ }
      state.tlScroll = null;
      boot();
    };

    $('[data-new]', main)?.addEventListener('click', () => openThemeEditor(null));
    $$('[data-edit]', main).forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      openThemeEditor(state.user.customThemes.find((t) => t.id === b.dataset.edit));
    }));
    $$('.theme-swatch[data-theme-id]', main).forEach((b) => {
      b.onclick = async () => {
        const theme = b.dataset.themeId;
        applyTheme(theme);
        $$('.theme-swatch', main).forEach((x) => x.classList.toggle('on', x === b));
        try { state.user = await api('/api/me', { method: 'PATCH', body: { theme } }); } catch (e) { oops(e); }
      };
    });

    showPushDevice($('#push-device', main));
    refreshAppCard();
    const savePref = (key) => async (e) => {
      try { state.user = await api('/api/me', { method: 'PATCH', body: { [key]: e.target.checked } }); toast('Saved'); } catch (err) { oops(err); }
    };
    $('#np', main).onchange = savePref('notifyPhotos');
    $('#nc', main).onchange = savePref('notifyComments');

    onSubmit($('#profile', main), async (f) => {
      state.user = await api('/api/me', { method: 'PATCH', body: f });
      toast('Profile saved');
    });

    onSubmit($('#password', main), async (f) => {
      if (f.next !== f.next2) throw new Error('The new passwords don’t match.');
      await api('/api/me/password', { method: 'POST', body: f });
      $('#password', main).reset();
      toast('Password changed');
    });

    if (!u.isAdmin) return;

    onSubmit($('#site', main), async (f) => {
      state.site = await api('/api/admin/site', { method: 'PATCH', body: f });
      $('.brand h1').textContent = `${possessive(state.site.babyName)} Scrapbook`;
      toast('Saved');
    });

    onSubmit($('#pin', main), async (f) => {
      if (f.pin !== f.pin2) throw new Error('The two PINs don’t match.');
      await api('/api/admin/pin', { method: 'POST', body: f });
      $('#pin', main).reset();
      toast('PIN changed — share the new one with family');
    });

    loadMembers($('#members', main));
  }

  // ---------------------------------------------------------------- who shared this? (admins)
  // Add a copy of one of our photos found somewhere else (saved, or a screenshot). The server works
  // out which photo it is and whose fingerprinted copy it came from, and lists who has opened it.
  async function viewTrace(main) {
    if (!state.user.isAdmin) { location.hash = '#/settings'; return; }
    main.innerHTML = `
      <a class="back" href="#/settings">← Settings</a>
      <div class="page-head"><div><h2>Who shared this?</h2>
        <p>Found one of our photos somewhere it shouldn’t be? Save it or take a screenshot, then add it here. Everyone’s copy of a photo carries an invisible mark of their own, and this checks whose copy it is.</p></div></div>
      <section class="card tr-card">
        <label class="btn primary tr-pick">Choose the picture<input type="file" accept="image/*" id="tr-file" hidden></label>
        <div id="tr-stage" class="hidden">
          <p class="muted small">If it’s a screenshot, drag a box around just the photo. Otherwise the whole picture is checked.</p>
          <div class="tr-frame" id="tr-frame"><img id="tr-img" alt="The picture you found"><div class="tr-box hidden" id="tr-box"></div></div>
          <p class="error" id="tr-error"></p>
          <div class="row end"><button class="btn sm ghost hidden" id="tr-whole" type="button">Use the whole picture</button><button class="btn primary" id="tr-go" type="button">Check</button></div>
        </div>
      </section>
      <div id="tr-result"></div>`;
    const frame = $('#tr-frame', main);
    const img = $('#tr-img', main);
    const boxEl = $('#tr-box', main);
    const err = $('#tr-error', main);
    let file = null;
    let box = null; // fractions of the picture

    const showBox = () => {
      boxEl.classList.toggle('hidden', !box);
      $('#tr-whole', main).classList.toggle('hidden', !box);
      if (box) Object.assign(boxEl.style, { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` });
    };
    $('#tr-file', main).onchange = (e) => {
      file = e.target.files[0];
      if (!file) return;
      img.src = URL.createObjectURL(file);
      box = null; showBox();
      err.textContent = '';
      $('#tr-result', main).innerHTML = '';
      $('#tr-stage', main).classList.remove('hidden');
    };
    $('#tr-whole', main).onclick = () => { box = null; showBox(); };

    // drag out a box on the picture
    let start = null;
    const at = (e) => {
      const r = img.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
    };
    frame.addEventListener('pointerdown', (e) => { start = at(e); frame.setPointerCapture(e.pointerId); e.preventDefault(); });
    frame.addEventListener('pointermove', (e) => {
      if (!start) return;
      const p = at(e);
      box = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      showBox();
    });
    const endDrag = () => { if (box && (box.w < 0.05 || box.h < 0.05)) box = null; start = null; showBox(); };
    frame.addEventListener('pointerup', endDrag);
    frame.addEventListener('pointercancel', endDrag);

    $('#tr-go', main).onclick = async () => {
      if (!file) return;
      const go = $('#tr-go', main);
      go.disabled = true; go.textContent = 'Checking…';
      err.textContent = '';
      try {
        const fd = new FormData();
        fd.append('image', file);
        if (box) fd.append('crop', JSON.stringify(box));
        showResult(await api('/api/admin/trace', { method: 'POST', body: fd }));
      } catch (e) {
        err.textContent = e.message;
      } finally {
        go.disabled = false; go.textContent = 'Check';
      }
    };

    const when = (s) => fmtLong(String(s).slice(0, 10));
    function showResult(r) {
      const out = $('#tr-result', main);
      if (!r.found) {
        out.innerHTML = `<section class="card"><h3>Couldn’t find this photo</h3>
          <p>It doesn’t match any photo on the site. If it’s a screenshot, try drawing the box more tightly around just the photo.</p></section>`;
        return;
      }
      const [top, next] = r.people;
      const gap = top && next ? top.score - next.score : top?.score || 0;
      let verdict;
      let cls;
      if (top && top.score >= 6 && gap >= 3) {
        cls = 'match';
        verdict = `This is ${esc(possessive(top.name))} copy.`;
      } else if (top && top.score >= 4) {
        cls = 'maybe';
        verdict = `Probably ${esc(possessive(top.name))} copy, but the mark is faint.`;
      } else {
        cls = 'none';
        verdict = 'No one’s mark could be found in it.';
      }
      const why = cls === 'none'
        ? 'It may have been edited heavily, cropped down to a small part, or saved before fingerprints were added to the site. Check who has opened it below.'
        : cls === 'maybe'
          ? 'The mark shows up, but not strongly — the copy may have been edited or cropped. Check who has opened it below too.'
          : 'Their fingerprint shows up far more strongly than anyone else’s could by chance. It tells you whose copy was shared — they may have passed it on to someone else.';
      const strengthWord = (s) => (s >= 6 ? 'Strong match' : s >= 4 ? 'Faint' : 'No sign');
      const people = r.people.slice(0, 8).map((p) => `
        <div class="tr-person${p === top && cls !== 'none' ? ' top' : ''}">
          <span class="tr-name">${esc(p.name)}${p.canSee ? '' : ' <em>(can’t see this photo)</em>'}</span>
          <span class="tr-bar"><i style="width:${Math.max(2, Math.min(100, (p.score / 12) * 100))}%"></i></span>
          <span class="tr-word">${strengthWord(p.score)}</span>
        </div>`).join('');
      const kinds = { full: 'opened it', thumb: 'saw it on the board', video: 'played it' };
      const views = r.views.length
        ? r.views.map((v) => `<li><b>${esc(v.name)}</b> ${kinds[v.kind] || v.kind}${v.times > 1 ? ` (${v.times} times)` : ''} · last ${esc(when(v.lastAt))}</li>`).join('')
        : '<li class="muted">No one has opened it since this list started.</li>';
      out.innerHTML = `
        <section class="card tr-card">
          <div class="tr-photo">
            <img src="/media/thumb/${r.photo.id}" alt="">
            <div><b>${esc(fmtLong(r.photo.date))}</b>${r.photo.caption ? `<span>${esc(r.photo.caption)}</span>` : ''}
              <span class="muted small">Added by ${esc(r.photo.uploadedBy || 'a former member')}</span></div>
          </div>
          <h3 class="tr-verdict ${cls}">${verdict}</h3>
          <p class="muted small">${why}</p>
          <div class="tr-people">${people}</div>
          <h4>Who has looked at this photo</h4>
          <ul class="tr-views">${views}</ul>
        </section>`;
    }
  }

  // ---------------------------------------------------------------- manage photos (admins)
  // A scrolling grid of every photo and video you can see, newest first. Tap to select
  // (shift-click selects a range on a computer), then delete them all at once.
  async function viewManage(main) {
    if (!state.user.isAdmin) { location.hash = '#/settings'; return; }
    const selected = new Set();
    let total = 0;
    let next = null;
    let loadingMore = false;
    let lastClicked = -1;
    main.innerHTML = `
      <a class="back" href="#/settings">← Settings</a>
      <div class="page-head">
        <div><h2>Manage photos</h2><p id="mg-sub">Loading…</p></div>
        <div class="row"><button class="btn sm" id="mg-all">Select all loaded</button><button class="btn sm" id="mg-none">Clear</button></div>
      </div>
      <div class="mg-grid" id="mg-grid"></div>
      <div class="mg-more muted small" id="mg-more"></div>
      <div class="mg-bar hidden" id="mg-bar">
        <span id="mg-count"></span>
        <button class="btn sm ghost" id="mg-cancel">Clear</button>
        <button class="btn sm danger-solid" id="mg-del">Delete</button>
      </div>`;
    const grid = $('#mg-grid', main);
    const more = $('#mg-more', main);
    const tiles = () => $$('.mg-item', grid);

    const setSub = () => { $('#mg-sub', main).textContent = `${total} ${total === 1 ? 'photo or video' : 'photos and videos'}. Tap to select, then delete.`; };
    const updateBar = () => {
      $('#mg-bar', main).classList.toggle('hidden', !selected.size);
      $('#mg-count', main).textContent = `${selected.size} selected`;
    };
    const select = (tile, on) => {
      const pid = Number(tile.dataset.id);
      if (on) selected.add(pid); else selected.delete(pid);
      tile.classList.toggle('on', on);
      tile.setAttribute('aria-pressed', on);
    };

    const tileHTML = (p) => `
      <button class="mg-item" data-id="${p.id}" aria-pressed="false" title="${esc(`${fmtLong(p.date)} · added by ${p.uploaderName || 'a former member'}${p.caption ? ` · ${p.caption}` : ''}`)}">
        <img loading="lazy" src="/media/thumb/${p.id}" alt="${esc(p.caption || '')}">
        <span class="mg-check" aria-hidden="true">✓</span>
        ${p.kind === 'video' ? `<span class="mg-badge">▶${p.duration ? ` ${fmtDur(p.duration)}` : ''}</span>` : ''}
        ${p.restricted ? '<span class="mg-badge lock">🔒</span>' : ''}
        <span class="mg-meta">${esc(fmt(p.date))} · ${esc(p.uploaderName || 'former member')}</span>
      </button>`;

    async function loadMore() {
      if (loadingMore || next === undefined) return;
      loadingMore = true;
      more.textContent = 'Loading…';
      try {
        const r = await api(`/api/admin/photos${next ? `?after=${encodeURIComponent(next)}` : ''}`);
        total = r.total;
        setSub();
        grid.insertAdjacentHTML('beforeend', r.photos.map(tileHTML).join(''));
        next = r.next || undefined; // undefined = nothing more to load
        more.textContent = next ? '' : (total ? 'That’s everything.' : 'No photos yet.');
      } catch (e) { oops(e); more.textContent = ''; } finally { loadingMore = false; }
    }

    // load the next 60 when you scroll near the bottom
    const io = new IntersectionObserver((entries) => {
      if (!more.isConnected) return io.disconnect();
      if (entries.some((en) => en.isIntersecting)) loadMore();
    }, { rootMargin: '600px' });
    io.observe(more);

    grid.addEventListener('click', (e) => {
      const tile = e.target.closest('.mg-item');
      if (!tile) return;
      const all = tiles();
      const idx = all.indexOf(tile);
      const on = !tile.classList.contains('on');
      if (e.shiftKey && lastClicked >= 0) {
        const [a, b] = [Math.min(lastClicked, idx), Math.max(lastClicked, idx)];
        all.slice(a, b + 1).forEach((t) => select(t, on));
      } else select(tile, on);
      lastClicked = idx;
      updateBar();
    });
    $('#mg-all', main).onclick = () => { tiles().forEach((t) => select(t, true)); updateBar(); };
    const clear = () => { tiles().forEach((t) => select(t, false)); updateBar(); };
    $('#mg-none', main).onclick = clear;
    $('#mg-cancel', main).onclick = clear;

    $('#mg-del', main).onclick = async () => {
      const n = selected.size;
      if (!n || !confirm(`Delete ${n === 1 ? 'this photo' : `these ${n} photos and videos`} for everyone? Their comments and hearts go too. This can’t be undone.`)) return;
      const btn = $('#mg-del', main);
      btn.disabled = true;
      try {
        const ids = [...selected];
        const { deleted } = await api('/api/admin/photos/delete', { method: 'POST', body: { ids } });
        ids.forEach((pid) => grid.querySelector(`.mg-item[data-id="${pid}"]`)?.remove());
        selected.clear();
        total -= deleted;
        setSub();
        updateBar();
        lastClicked = -1;
        toast(`${deleted} deleted`);
      } catch (e) { oops(e); } finally { btn.disabled = false; }
    };

    await loadMore();
  }

  async function loadMembers(box) {
    let users;
    try { users = await api('/api/admin/users'); } catch (e) { box.textContent = e.message; return; }
    box.classList.remove('muted');
    box.innerHTML = `<table class="members"><tbody>${users.map((m) => `
      <tr>
        <td class="who"><strong>${esc(m.displayName)} ${m.isAdmin ? '<span class="pill">Admin</span>' : ''}</strong>
          <span class="muted small">@${esc(m.username)}${m.email ? ` · ${esc(m.email)}` : ''} · ${plural(m.photoCount, 'photo')}</span></td>
        <td>${m.id === state.user.id ? '<span class="muted small">That’s you</span>' : `
          <div class="row" style="justify-content:flex-end">
            <button class="btn sm" data-act="reset" data-id="${m.id}">Reset password</button>
            <button class="btn sm" data-act="admin" data-id="${m.id}">${m.isAdmin ? 'Remove admin' : 'Make admin'}</button>
            <button class="btn sm danger" data-act="remove" data-id="${m.id}">Remove</button>
          </div>`}</td>
      </tr>`).join('')}</tbody></table>`;

    box.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const m = users.find((x) => x.id === Number(b.dataset.id));
      try {
        if (b.dataset.act === 'reset') {
          if (!confirm(`Reset ${m.displayName}’s password? They’ll be signed out.`)) return;
          const { tempPassword } = await api(`/api/admin/users/${m.id}/reset-password`, { method: 'POST' });
          modal(`${head('Temporary password')}
            <p>Give this to <strong>${esc(m.displayName)}</strong>. They can log in with it and then set a new one in Settings.</p>
            <p style="font-size:1.6rem;font-family:monospace;text-align:center;background:var(--surface-2);padding:12px;border-radius:12px;user-select:all">${esc(tempPassword)}</p>
            <div class="row end"><button class="btn primary" data-close>Done</button></div>`);
        } else if (b.dataset.act === 'admin') {
          await api(`/api/admin/users/${m.id}`, { method: 'PATCH', body: { isAdmin: !m.isAdmin } });
          loadMembers(box);
        } else if (b.dataset.act === 'remove') {
          if (!confirm(`Remove ${m.displayName}? They won’t be able to log in. Photos they added will stay.`)) return;
          await api(`/api/admin/users/${m.id}`, { method: 'DELETE' });
          toast(`${m.displayName} removed`);
          loadMembers(box);
        }
      } catch (err) { oops(err); }
    };
  }

  boot();
})();
