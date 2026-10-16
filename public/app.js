'use strict';

(() => {
  const root = document.getElementById('app');
  const state = { user: null, site: null, days: new Map(), tlScroll: null };

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

  async function api(url, { method = 'GET', body } = {}) {
    const isForm = body instanceof FormData;
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body && !isForm ? { 'Content-Type': 'application/json' } : {},
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
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('sb_theme', theme); } catch { /* private mode */ }
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

  function modal(inner, { cls = '', z } = {}) {
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
    function close() { back.remove(); document.removeEventListener('keydown', onKey); }
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
    $$('.modal-back, .lb').forEach((el) => el.remove());
    if (s.user) applyTheme(s.user.theme);
    if (s.setupNeeded) return renderSetup();
    if (!s.pinOk) return renderPin();
    if (!s.user) return renderAuth();
    renderShell();
    route();
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
    $$('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
    $('#fab').classList.toggle('hidden', tab === 'settings');
    main.className = '';
    try {
      if (tab === 'events' && id) await viewEvent(main, Number(id));
      else if (tab === 'events') await viewEvents(main);
      else if (tab === 'settings') await viewSettings(main);
      else await viewTimeline(main, opts);
    } catch (e) {
      if (!e.handled) main.innerHTML = `<div class="empty"><div class="big">😕</div><h3>Couldn’t load this page</h3><p>${esc(e.message)}</p></div>`;
    }
  }
  window.addEventListener('hashchange', () => { if (state.user) { window.scrollTo(0, 0); route(); } });

  const loading = (main, msg = 'Loading memories…') => { main.innerHTML = `<div class="loading" style="min-height:40vh">${msg}</div>`; };

  // ---------------------------------------------------------------- timeline

  async function viewTimeline(main, { focusDate } = {}) {
    if (!main.querySelector('.tl-scroller')) loading(main);
    const data = await api('/api/timeline');
    state.site = data.site;
    state.days = new Map(data.days.map((d) => [d.date, d]));
    main.className = 'full';

    if (!data.days.length) {
      main.innerHTML = `
        <div class="empty">
          <div class="big">📸</div>
          <h3>The first page is blank</h3>
          <p>Add some photos or mark a special day, and the timeline will start to grow.</p>
          <div class="row" style="justify-content:center"><button class="btn primary" data-act="upload">＋ Add photos</button><button class="btn" data-act="event">Mark an event</button></div>
        </div>`;
      $('[data-act=upload]', main).onclick = () => openUpload();
      $('[data-act=event]', main).onclick = () => openEventForm();
      return;
    }

    let track = '';
    let lastMonth = '';
    for (const d of data.days) {
      const month = d.date.slice(0, 7);
      if (month !== lastMonth) {
        track += `<div class="tl-month" aria-hidden="true"><span>${esc(fmt(`${month}-01`, { month: 'short', year: 'numeric' }))}</span></div>`;
        lastMonth = month;
      }
      track += dayHTML(d);
    }
    const photoTotal = data.days.reduce((n, d) => n + d.count, 0);
    // Only leave as much room above the line as the busiest day's event labels need (max 3 + "more").
    const maxPills = Math.max(0, ...data.days.map((d) => Math.min(d.events.length, 4)));
    const eventsHeight = 24 + maxPills * 40;
    main.innerHTML = `
      <div class="tl-head page-head">
        <div><h2>Timeline</h2><p>${plural(photoTotal, 'photo')} across ${plural(data.days.length, 'day')}. Scroll sideways to travel through time.</p></div>
        <div class="tl-tools">
          <label class="tl-jump"><span class="lbl">Jump to</span><input type="date" id="jump" aria-label="Jump to date"></label>
          <button class="btn sm" id="toStart" aria-label="Beginning">⏮<span class="lbl"> Beginning</span></button>
          <button class="btn sm" id="toEnd" aria-label="Latest"><span class="lbl">Latest </span>⏭</button>
          <button class="btn sm primary" id="newEvent">＋ <span class="lbl">New </span>Event</button>
        </div>
      </div>
      <div class="tl-wrap" style="--events-h:${eventsHeight}px">
        <button class="btn icon tl-arrow left" aria-label="Scroll back">‹</button>
        <div class="tl-scroller" id="tl"><div class="tl-track">${track}</div></div>
        <button class="btn icon tl-arrow right" aria-label="Scroll forward">›</button>
      </div>`;

    const sc = $('#tl', main);
    sc.style.scrollBehavior = 'auto';
    sc.scrollLeft = state.tlScroll ?? sc.scrollWidth;
    sc.style.scrollBehavior = '';
    sc.addEventListener('scroll', () => { state.tlScroll = sc.scrollLeft; }, { passive: true });
    // A normal mouse wheel scrolls the timeline sideways.
    sc.addEventListener('wheel', (e) => {
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      sc.scrollBy({ left: e.deltaY * 1.4, behavior: 'instant' });
    }, { passive: false });

    $('.tl-arrow.left', main).onclick = () => sc.scrollBy({ left: -sc.clientWidth * 0.8, behavior: 'smooth' });
    $('.tl-arrow.right', main).onclick = () => sc.scrollBy({ left: sc.clientWidth * 0.8, behavior: 'smooth' });
    $('#toStart', main).onclick = () => sc.scrollTo({ left: 0, behavior: 'smooth' });
    $('#toEnd', main).onclick = () => sc.scrollTo({ left: sc.scrollWidth, behavior: 'smooth' });
    $('#newEvent', main).onclick = () => openEventForm();
    $('#jump', main).onchange = (e) => e.target.value && jumpTo(sc, e.target.value);

    $('.tl-track', main).addEventListener('click', (e) => {
      const stack = e.target.closest('[data-day]');
      if (stack) return openDay(stack.dataset.day);
      const add = e.target.closest('[data-add]');
      if (add) openUpload({ date: add.dataset.add, eventId: Number(add.dataset.event) || undefined });
    });

    if (focusDate) jumpTo(sc, focusDate);
  }

  function dayHTML(d) {
    const shown = d.events.slice(0, 3);
    const more = d.events.length - shown.length;
    const events = shown.map((e) => `
      <a class="tl-event" href="#/events/${e.id}" title="${esc(e.title)}"><span>${esc(e.emoji || '⭐')}</span><span>${esc(e.title)}</span></a>`).join('')
      + (more > 0 ? `<button class="tl-event" data-day="${d.date}"><span>+${more} more</span></button>` : '')
      + (d.events.length ? '<i class="stem"></i>' : '');
    const label = fmt(d.date, { month: 'short', day: 'numeric' });
    const stack = d.count
      ? `<button class="tl-stack" data-day="${d.date}" aria-label="See ${plural(d.count, 'photo')} from ${esc(fmtLong(d.date))}">
           ${d.photos.slice().reverse().map((id) => `<div class="pol"><img loading="lazy" src="/media/thumb/${id}" alt=""></div>`).join('')}
           <span class="tl-count">${plural(d.count, 'photo')}</span>
         </button>`
      : `<button class="tl-empty-stack" data-add="${d.date}" data-event="${d.events[0]?.id || ''}">＋ Add the first photos</button>`;
    return `
      <div class="tl-day${d.events.length ? ' has-event' : ''}" data-date="${d.date}">
        <div class="tl-events">${events}</div>
        <div class="tl-dot"></div>
        <div class="tl-date"><strong>${esc(label)}</strong><small>${esc(age(d.date) || fmt(d.date, { weekday: 'long' }))}</small></div>
        ${stack}
      </div>`;
  }

  function jumpTo(sc, date) {
    const days = $$('.tl-day', sc);
    if (!days.length) return;
    const el = days.find((d) => d.dataset.date >= date) || days[days.length - 1];
    sc.scrollTo({ left: el.offsetLeft - sc.clientWidth / 2 + el.offsetWidth / 2, behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
  }

  async function openDay(date) {
    let photos;
    try { photos = await api(`/api/photos?date=${date}`); } catch (e) { return oops(e); }
    const events = state.days.get(date)?.events || [];
    const sub = [age(date), plural(photos.length, 'photo')].filter(Boolean).join(' · ');
    const m = modal(`
      ${head(esc(fmtLong(date)), esc(sub))}
      ${events.length ? `<div class="row" style="margin-bottom:16px">${events.map((e) => `<a class="tl-event" href="#/events/${e.id}"><span>${esc(e.emoji || '⭐')}</span><span>${esc(e.title)}</span></a>`).join('')}</div>` : ''}
      ${photos.length ? photoGrid(photos, true) : '<p class="muted">No photos on this day yet.</p>'}
      <div class="row end" style="margin-top:8px"><button class="btn primary" data-add>＋ Add photos to this day</button></div>`, { cls: 'wide' });
    $$('.tl-event', m.el).forEach((a) => a.addEventListener('click', m.close));
    $('[data-add]', m.el).onclick = () => { m.close(); openUpload({ date }); };
    bindGrid(m.el, photos, { onChange: () => { m.close(); route(); } });
  }

  // ---------------------------------------------------------------- photo grid & viewer

  function photoGrid(photos, showEvent = false) {
    return `<div class="photo-grid">${photos.map((p, i) => `
      <button data-i="${i}" aria-label="Open photo${p.caption ? `: ${esc(p.caption)}` : ''}">
        <img loading="lazy" src="/media/thumb/${p.id}" width="${p.width || 4}" height="${p.height || 3}" alt="${esc(p.caption || '')}">
        ${p.restricted ? '<span class="lock" title="Private">🔒</span>' : ''}
        ${showEvent && p.eventTitle ?`<span class="tag">${esc(`${p.eventEmoji || '⭐'} ${p.eventTitle}`)}</span>` : ''}
      </button>`).join('')}</div>`;
  }
  function bindGrid(el, photos, ctx) {
    $$('.photo-grid button', el).forEach((b) => { b.onclick = () => openViewer(photos, Number(b.dataset.i), ctx); });
  }

  function openViewer(photos, start, ctx = {}) {
    let i = start;
    let changed = false;
    const lb = document.createElement('div');
    lb.className = 'lb';
    lb.setAttribute('role', 'dialog');
    document.body.appendChild(lb);

    const close = () => {
      lb.remove();
      document.removeEventListener('keydown', onKey);
      if (changed) ctx.onChange?.();
    };
    const go = (n) => { if (photos.length > 1) { i = (i + n + photos.length) % photos.length; render(); } };
    const onKey = (e) => {
      if ($$('.modal-back').some((b) => b.style.zIndex)) return; // a dialog on top of the viewer is open
      if (e.key === 'Escape' && lb.classList.contains('zoomed')) lb.classList.remove('zoomed');
      else if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    document.addEventListener('keydown', onKey);

    let touchX = null;
    lb.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', (e) => {
      if (touchX == null || lb.classList.contains('zoomed')) return;
      const dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) > 50) go(dx > 0 ? -1 : 1);
    });

    function render() {
      const p = photos[i];
      const mine = state.user.isAdmin || p.uploadedBy === state.user.id;
      const ev = ctx.event;
      const meta = [p.restricted && '🔒 Private', fmtLong(p.date), p.eventTitle && `${p.eventEmoji || '⭐'} ${p.eventTitle}`, `added by ${p.uploaderName || 'a former member'}`].filter(Boolean).join(' · ');
      lb.innerHTML = `
        <div class="lb-top">
          <span class="count">${i + 1} / ${photos.length}</span>
          <div class="row">
            <a class="btn sm" href="/media/full/${p.id}?download=1">⬇ Download</a>
            ${ev?.canEdit ? `<button class="btn sm" data-cover>${ev.coverId === p.id ? '★ Cover photo' : '☆ Make cover'}</button>` : ''}
            ${mine ? `<button class="btn sm" data-access>${p.restricted ? '🔒 Private' : '👨‍👩‍👧 Everyone'}</button><button class="btn sm" data-caption>✎ Caption</button><button class="btn sm danger" data-del>Delete</button>` : ''}
            <button class="btn icon" data-x aria-label="Close">✕</button>
          </div>
        </div>
        <div class="lb-stage">
          ${photos.length > 1 ? '<button class="lb-nav prev" aria-label="Previous">‹</button>' : ''}
          <img src="/media/full/${p.id}" alt="${esc(p.caption || '')}">
          ${photos.length > 1 ? '<button class="lb-nav next" aria-label="Next">›</button>' : ''}
        </div>
        <div class="lb-bottom"><div>
          ${p.caption ? `<div class="lb-caption">${esc(p.caption)}</div>` : ''}
          <div class="lb-meta">${esc(meta)}</div>
        </div></div>`;
      $('[data-x]', lb).onclick = close;
      const stage = $('.lb-stage', lb);
      stage.onclick = (e) => { if (e.target === stage && !lb.classList.contains('zoomed')) close(); };
      // Click the photo to see it at full size (scroll to pan); click again to fit it back on screen.
      lb.classList.remove('zoomed');
      const photo = $('img', stage);
      photo.onclick = (e) => {
        const fx = e.offsetX / photo.clientWidth; // where on the photo was clicked, measured before zooming
        const fy = e.offsetY / photo.clientHeight;
        if (lb.classList.toggle('zoomed')) {
          stage.scrollLeft = fx * photo.naturalWidth - stage.clientWidth / 2;
          stage.scrollTop = fy * photo.naturalHeight - stage.clientHeight / 2;
        }
      };
      if (photos.length > 1) {
        $('.prev', lb).onclick = () => go(-1);
        $('.next', lb).onclick = () => go(1);
        [1, -1].forEach((n) => { new Image().src = `/media/full/${photos[(i + n + photos.length) % photos.length].id}`; });
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
    render();
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
      ${head('Add photos', 'Choose a day, and who gets to see them.')}
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
          <input type="file" accept="image/*" multiple hidden>
          <div class="big">📷</div>
          <div>Tap to choose photos, or drag them here</div>
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

    const showFiles = () => {
      previews.querySelectorAll('img').forEach((img) => URL.revokeObjectURL(img.src));
      previews.innerHTML = files.map((f, i) => `<div><img src="${URL.createObjectURL(f)}" alt=""><button type="button" data-rm="${i}" aria-label="Remove">✕</button></div>`).join('');
      submit.textContent = files.length ? `Upload ${plural(files.length, 'photo')}` : 'Upload';
    };
    const addFiles = (list) => { files = files.concat([...list].filter((f) => f.type.startsWith('image/'))); showFiles(); };
    fileIn.onchange = () => { addFiles(fileIn.files); fileIn.value = ''; };
    previews.onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { files.splice(Number(b.dataset.rm), 1); showFiles(); } };
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

    onSubmit(form, async () => {
      if (!files.length) throw new Error('Choose at least one photo.');
      const access = readAccess();
      const bar = $('.progress', form);
      bar.classList.remove('hidden');
      const total = files.reduce((n, f) => n + f.size, 0) || 1;
      let done = 0;
      let saved = 0;
      const failed = [];
      // Send a few at a time so big batches from a phone don't time out.
      for (let i = 0; i < files.length; i += 4) {
        const batch = files.slice(i, i + 4);
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
      toast(`${plural(saved, 'photo')} added 🎉`);
      if (failed.length) toast(`Couldn’t read: ${failed.join(', ')}`, true);
      const [tab] = currentRoute();
      route(tab === 'timeline' ? { focusDate: dateIn.value } : {});
    });
  }

  function sendWithProgress(fd, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', '/api/photos');
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
        <div class="field">Icon<div class="emoji-pick">${EMOJI.map((e) => `<button type="button" data-e="${e}" class="${e === emoji ? 'on' : ''}">${e}</button>`).join('')}</div></div>
        <label class="field">Description <span class="hint">Optional</span><textarea name="description" maxlength="1000">${esc(existing?.description || '')}</textarea></label>
        <p class="error"></p>
        <div class="row end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">${existing ? 'Save' : 'Create event'}</button></div>
      </form>`);
    $('.emoji-pick', m.el).onclick = (e) => {
      const b = e.target.closest('[data-e]');
      if (!b) return;
      emoji = b.classList.contains('on') ? '' : b.dataset.e;
      $$('.emoji-pick button', m.el).forEach((x) => x.classList.toggle('on', x.dataset.e === emoji));
    };
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
      ${events.length ? `<div class="ev-grid">${events.map((e) => `
        <a class="ev-card" href="#/events/${e.id}">
          <div class="ev-thumb">${e.coverId ? `<img loading="lazy" src="/media/thumb/${e.coverId}" alt="">` : esc(e.emoji || '⭐')}</div>
          <div class="ev-title">${e.emoji ? `<span>${esc(e.emoji)}</span>` : ''}<span>${esc(e.title)}</span></div>
        </a>`).join('')}</div>`
        : '<div class="empty"><div class="big">🎈</div><h3>No events yet</h3><p>Mark birthdays, firsts and visits so they stand out on the timeline.</p></div>'}`;
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
    const sub = [fmtLong(ev.date), age(ev.date), plural(photos.length, 'photo')].filter(Boolean).join(' · ');
    main.innerHTML = `
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
          ${ev.canEdit ? '<button class="btn sm" data-act="edit">✎ Edit</button><button class="btn sm danger" data-act="del">Delete</button>' : ''}
        </div>
      </div>
      ${photos.length ? photoGrid(photos) : '<div class="empty"><div class="big">📷</div><h3>No photos yet</h3><p>Be the first to add some from this day.</p></div>'}`;
    $('[data-act=add]', main).onclick = () => openUpload({ eventId: ev.id });
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

  async function viewSettings(main) {
    const u = state.user;
    const site = state.site;
    main.innerHTML = `
      <div class="page-head"><div><h2>Settings</h2><p>Signed in as <strong>${esc(u.username)}</strong>${u.isAdmin ? ' <span class="pill">Admin</span>' : ''}</p></div>
        <button class="btn" id="logout">Log out</button></div>
      <div class="settings">
        <section class="card">
          <h3>Theme</h3><p>Pick the look you like. It follows your account to any device.</p>
          <div class="themes">${THEMES.map((t) => `
            <button class="theme-swatch${t.id === u.theme ? ' on' : ''}" data-theme-id="${t.id}" style="--sw-bg:${t.bg};--sw-text:${t.text}">
              <span class="dots">${t.dots.map((c) => `<i style="background:${c}"></i>`).join('')}</span>${t.name}
            </button>`).join('')}</div>
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
          <h3>Family members <span class="pill">Admin</span></h3><p>People join by entering the PIN and creating an account. Remove anyone who shouldn’t have access.</p>
          <div id="members" class="muted">Loading…</div>
        </section>` : ''}
      </div>`;

    $('#logout', main).onclick = async () => {
      try { await api('/api/logout', { method: 'POST' }); } catch { /* already gone */ }
      state.tlScroll = null;
      boot();
    };

    $$('.theme-swatch', main).forEach((b) => {
      b.onclick = async () => {
        const theme = b.dataset.themeId;
        applyTheme(theme);
        $$('.theme-swatch', main).forEach((x) => x.classList.toggle('on', x === b));
        try { state.user = await api('/api/me', { method: 'PATCH', body: { theme } }); } catch (e) { oops(e); }
      };
    });

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
