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
        if (!g || g.k !== k) out.push(g = { k, start: d.date, end: d.date, previews: [], events: [], photoCount: 0, videoCount: 0, dayCount: 0 });
        g.end = d.date;
        g.previews.push(...d.previews);
        g.events.push(...d.events);
        g.photoCount += d.photoCount; g.videoCount += d.videoCount; g.dayCount++;
      }
      return out;
    });
  }

  function stackHTML(g, l) {
    const Z = ZOOM_LEVELS[l];
    const top = g.previews.find((p) => p.kind === 'video') || g.previews[0]; // a video always goes on top
    const under = g.previews.filter((p) => p !== top).slice(0, 2);
    const pol = (p, cls, front) => `<div class="pol ${cls}">${front ? '<span class="pin"></span>' : ''}
      <div class="ph"><img src="/media/thumb/${p.id}" alt="" loading="lazy" draggable="false">${p.kind === 'video' ? `<span class="play">▶</span>${p.duration ? `<span class="dur">${fmtDur(p.duration)}</span>` : ''}` : ''}</div>
      ${front ? `<div class="cap">${esc(p.caption || '')}</div>` : ''}</div>`;
    const icons = g.events.slice(0, 4).map((e) => esc(e.emoji || '⭐')).join('') + (g.events.length > 4 ? `<small>+${g.events.length - 4}</small>` : '');
    const names = g.events.slice(0, 2).map((e) => `<a href="#/events/${e.id}">${esc(`${e.emoji || '⭐'} ${e.title}`)}</a>`).join('')
      + (g.events.length > 2 ? `<em>+${g.events.length - 2} more</em>` : '');
    const count = [g.photoCount && plural(g.photoCount, 'photo'), g.videoCount && plural(g.videoCount, 'video')].filter(Boolean).join(' · ');
    const stack = top
      ? `${under[1] ? pol(under[1], 'a') : ''}${under[0] ? pol(under[0], 'b') : ''}${pol(top, 'c', true)}<span class="tl-tag">${count}</span>`
      : `<div class="pol c" data-add><span class="pin"></span><div class="ph empty-ph">＋ Add the<br>first photos</div><div class="cap"></div></div>`;
    return `<div class="tl-label"><b>${esc(Z.label(g))}</b><span>${esc(Z.sub(g))}</span></div>
      ${g.events.length ? `<div class="tl-badge" aria-hidden="true">${icons}</div>` : '<span class="pin"></span>'}
      <div class="tl-events">${names}</div>
      <div class="tl-stack" role="button" tabindex="0" aria-label="${esc(`${Z.label(g)}: ${count || 'no photos yet'}`)}">${stack}</div>`;
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

    const layers = groups.map((gs, l) => {
      const el = document.createElement('div');
      el.className = 'layer';
      el.items = gs.map((g, i) => {
        const it = document.createElement('div');
        it.className = 'stop';
        it.dataset.l = l; it.dataset.i = i;
        it.style.display = 'none';
        it.innerHTML = stackHTML(g, l);
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
    const save = () => { state.tl = { L, tx, focusDate }; };

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
      for (const i of el.shown) if (i < i0 || i > i1) el.items[i].style.display = 'none';
      el.shown = [];
      for (let i = i0; i <= i1; i++) {
        const it = el.items[i];
        it.style.display = 'flex';
        it.style.transform = `translate3d(${t + s * xOf(i) - 105}px,0,0) scale(${cs})`;
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
      render();
    }

    const clampTx = (t) => Math.min(vw() / 2, Math.max(vw() / 2 - scaleOf(f) * xOf(groups[L].length - 1), t));
    function panBy(dx) { tx = clampTx(tx + dx); render(); }

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
    function animateZoom(targetZ, F = vw() / 2, ms) {
      const dist = targetZ - (L + f);
      if (Math.abs(dist) < 1e-4) return;
      let done = 0;
      tween(ms || Math.min(900, 300 + 260 * Math.abs(dist)), (e) => { zoomBy(dist * e - done, F); done = dist * e; });
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
    else {
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

    // Tap a stack: months/weeks/years dive in; a day opens its photos.
    stage.addEventListener('click', (e) => {
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
      } else openDay(g.start);
    });
    stage.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('tl-stack')) e.target.click(); });

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

    // Dragging / swiping with one finger or the mouse, with momentum.
    const pointers = new Set();
    let drag = null;
    let justDragged = false;
    stage.addEventListener('pointerdown', (e) => {
      pointers.add(e.pointerId);
      if (pointers.size > 1) { drag = null; return; }
      stopAnim();
      drag = { x: e.clientX, t: performance.now(), v: 0, moved: false, id: e.pointerId };
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id || pointers.size > 1) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 6) return;
      if (!drag.moved) { drag.moved = true; stage.classList.add('dragging'); stage.setPointerCapture(e.pointerId); }
      const now = performance.now();
      drag.v = 0.8 * (dx / Math.max(1, now - drag.t)) + 0.2 * drag.v;
      drag.x = e.clientX; drag.t = now;
      panBy(dx);
    });
    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moved) {
        justDragged = true; setTimeout(() => { justDragged = false; }, 0);
        if (performance.now() - drag.t < 80) glide(drag.v);
        // wandered to another stack? forget the remembered day
        const g = groups[L][nearestIdx(L, tx, scaleOf(f), vw() / 2)];
        if (focusDate && (focusDate < g.start || focusDate > g.end)) focusDate = null;
      }
      drag = null;
      stage.classList.remove('dragging');
    };
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);
    stage.addEventListener('click', (e) => { if (justDragged) { e.stopPropagation(); e.preventDefault(); } }, true);

    // Two-finger pinch zooms (and pans with the fingers' midpoint), like Photos.
    let pinch = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => localX((t[0].clientX + t[1].clientX) / 2);
    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      stopAnim(); drag = null;
      pinch = { d: dist(e.touches), m: mid(e.touches) };
    }, { passive: true });
    stage.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const d = dist(e.touches);
      const m = mid(e.touches);
      tx += m - pinch.m;
      zoomBy(Math.log(d / pinch.d) / Math.log(G), m);
      pinch.d = d; pinch.m = m;
    }, { passive: false });
    stage.addEventListener('touchend', (e) => { if (pinch && e.touches.length < 2) { pinch = null; settle(); } });
    stage.addEventListener('gesturestart', (e) => e.preventDefault()); // Safari: don't zoom the page

    // Keep things lined up if the window is resized or the phone rotated.
    const ro = new ResizeObserver(() => { if (stage.isConnected) { tx = clampTx(tx); render(); } else ro.disconnect(); });
    ro.observe(stage);
  }

  async function openDay(date) {
    let photos;
    try { photos = await api(`/api/photos?date=${date}`); } catch (e) { return oops(e); }
    const events = state.days.get(date)?.events || [];
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

  function photoGrid(photos, showEvent = false) {
    return `<div class="photo-grid">${photos.map((p, i) => `
      <button data-i="${i}" style="--r:${tilt(p.id)}" aria-label="Open ${p.kind === 'video' ? 'video' : 'photo'}${p.caption ? `: ${esc(p.caption)}` : ''}">
        <span class="ph">
          <img loading="lazy" src="/media/thumb/${p.id}" width="${p.width || 4}" height="${p.height || 3}" alt="${esc(p.caption || '')}">
          ${videoBadge(p)}
          ${p.likeCount || p.commentCount ? `<span class="social">${[p.likeCount && `♥ ${p.likeCount}`, p.commentCount && `💬 ${p.commentCount}`].filter(Boolean).join('  ')}</span>` : ''}
          ${p.restricted ? '<span class="lock" title="Private">🔒</span>' : ''}
          ${showEvent && p.eventTitle ? `<span class="tag">${esc(`${p.eventEmoji || '⭐'} ${p.eventTitle}`)}</span>` : ''}
        </span>
        <span class="cap">${esc(p.caption || '')}</span>
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
    let panelOpen = false; // comments panel stays open as you move between photos
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

    let touchX = null;
    lb.addEventListener('touchstart', (e) => { touchX = e.target.closest('.lb-panel') ? null : e.touches[0].clientX; }, { passive: true });
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
            ${ready ? `<a class="btn sm" href="/media/${isVideo ? 'video' : 'full'}/${p.id}?download=1">⬇ Download</a>` : ''}
            ${ev?.canEdit ? `<button class="btn sm" data-cover>${ev.coverId === p.id ? '★ Cover photo' : '☆ Make cover'}</button>` : ''}
            ${mine ? `<button class="btn sm" data-access>${p.restricted ? '🔒 Private' : '👨‍👩‍👧 Everyone'}</button><button class="btn sm" data-caption>✎ Caption</button><button class="btn sm danger" data-del>Delete</button>` : ''}
            <button class="btn icon" data-x aria-label="Close">✕</button>
          </div>
        </div>
        <div class="lb-stage">
          ${photos.length > 1 ? '<button class="lb-nav prev" aria-label="Previous">‹</button>' : ''}
          ${media}
          ${photos.length > 1 ? '<button class="lb-nav next" aria-label="Next">›</button>' : ''}
        </div>
        <div class="lb-bottom">
          <div>
            ${p.caption ? `<div class="lb-caption">${esc(p.caption)}</div>` : ''}
            <div class="lb-meta">${esc(meta)}</div>
          </div>
          <div class="row lb-social">
            <button class="btn sm heart${p.liked ? ' on' : ''}" data-like aria-pressed="${!!p.liked}" aria-label="${p.liked ? 'Unlike' : 'Like'}">${p.liked ? '♥' : '♡'} ${p.likeCount || ''}</button>
            <button class="btn sm" data-comments aria-expanded="${panelOpen}">💬 ${p.commentCount || ''}</button>
          </div>
        </div>
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
      $('[data-x]', lb).onclick = close;

      // ---- hearts & comments
      $('[data-like]', lb).onclick = async () => {
        try {
          const r = await api(`/api/photos/${p.id}/like`, { method: 'PUT', body: { liked: !p.liked } });
          p.liked = r.liked; p.likeCount = r.likeCount; changed = true;
          render();
        } catch (e) { oops(e); }
      };
      $('[data-comments]', lb).onclick = () => { panelOpen = !panelOpen; render(); };
      if (panelOpen) loadComments(p);
      const stage = $('.lb-stage', lb);
      stage.onclick = (e) => { if (e.target === stage && !lb.classList.contains('zoomed')) close(); };
      // Click the photo to see it at full size (scroll to pan); click again to fit it back on screen.
      lb.classList.remove('zoomed');
      const photo = isVideo ? null : $('img', stage);
      if (photo) photo.onclick = (e) => {
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
          p.commentCount = comments.length; changed = true;
          $('[data-comments]', lb).textContent = `💬 ${p.commentCount || ''}`;
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
          p.commentCount = comments.length; changed = true;
          input.value = ''; input.style.height = '';
          $('[data-comments]', lb).textContent = `💬 ${p.commentCount}`;
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
      <div class="board"><div class="cork">
        ${photos.length ? photoGrid(photos) : '<div class="empty"><div class="big">📷</div><h3>Nothing pinned yet</h3><p>Be the first to add photos or videos from this day.</p></div>'}
      </div></div>`;
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
