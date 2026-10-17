// Neelkora shop: bag, account/profile/wishlist copies synced with the server, and the shared page chrome (menu, search, bag drawer, transitions).
(() => {
  // products and pricing come from catalog.js (shared with the server)
  const {products, occasions, get, STITCH, EXPRESS, unitPrice, totals, blouseLabel} = window.NK_CATALOG;
  const money = n => '₹' + Math.round(n).toLocaleString('en-IN');

  // ---------- talking to the server ----------
  // Every call is same-origin JSON; the session lives in an httpOnly cookie the page cannot read.
  const api = async (method, url, body) => {
    let r;
    try { r = await fetch(url, {method, credentials: 'same-origin', headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined}); }
    catch { throw Object.assign(new Error('You seem to be offline. Check your connection and try again.'), {code: 'offline'}); }
    const data = await r.json().catch(() => ({}));
    // no JSON back (e.g. on Netlify before the API server is connected): say so plainly
    if (!r.ok) throw Object.assign(new Error(data.message || (r.status >= 404 ? 'Our shop server is not reachable right now. Please try again in a little while.' : 'Something went wrong. Please try again.')), {code: data.error || 'unreachable', status: r.status});
    return data;
  };
  const store = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };

  // small notice for background save errors
  const toast = msg => {
    let t = document.querySelector('.nk-toast');
    if (!t) { t = document.createElement('div'); t.className = 'nk-toast'; t.setAttribute('role', 'status'); document.body.append(t); }
    t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4000);
  };
  // bag storage: browser storage can be blocked (private mode), so fall back to memory
  let mem = [];
  // items whose sari is no longer sold are dropped, so an old bag can never break the drawer or checkout
  const load = () => { try { return (JSON.parse(localStorage.getItem('nk-bag')) || []).filter(i => get(i.id)); } catch { return mem; } };
  const save = items => { mem = items; try { localStorage.setItem('nk-bag', JSON.stringify(items)); } catch {} render(); };
  const bag = {
    items: load,
    count: () => load().reduce((s, i) => s + i.qty, 0),
    add(id, blouse = 'unstitched', qty = 1) {
      const items = load(), key = id + '|' + blouse, hit = items.find(i => i.key === key);
      hit ? hit.qty = Math.min(hit.qty + qty, 5) : items.push({key, id, blouse, qty});
      save(items);
    },
    setQty(key, qty) { save(load().map(i => i.key === key ? {...i, qty: Math.max(1, Math.min(5, qty))} : i)); },
    remove(key) { save(load().filter(i => i.key !== key)); },
    clear() { save([]); },
  };
  // ---------- account, profile, wishlist, orders ----------
  // The database on the server is the truth. This browser keeps a copy (localStorage) so pages draw instantly,
  // and sync() refreshes that copy from GET /api/me on every page load.
  const EMPTY_PROFILE = {addresses: [], upi: [], cards: [], prefPay: 'UPI', phone: ''};
  const account = {
    get: () => read('nk-user'),
    // id is the email, or "+91XXXXXXXXXX" for phone accounts: the rest of the site keys things on it
    signOut: async () => { try { await api('POST', '/api/auth/logout', {}); } catch {} clearCache(); },
    rename: name => saveProfile({name}),
  };
  const applyMe = me => {
    if (!me || !me.user) return clearCache();
    store('nk-user', {name: me.user.name, email: me.user.id, phone: me.user.phone, since: me.user.since});
    store('nk-profile', {...EMPTY_PROFILE, ...me.profile, since: me.user.since});
    // anything hearted before signing in joins the saved wishlist
    const local = read('nk-wish') || [], merged = [...new Set([...(me.wishlist || []), ...local])];
    store('nk-wish', merged);
    if (merged.length !== (me.wishlist || []).length) api('PUT', '/api/wishlist', {ids: merged}).catch(() => {});
    store('nk-orders', me.orders || []);
    render(); dispatchEvent(new Event('nk:sync'));
  };
  function clearCache() { ['nk-user', 'nk-profile', 'nk-orders'].forEach(k => store(k, null)); render(); dispatchEvent(new Event('nk:sync')); }
  const sync = () => api('GET', '/api/me').then(applyMe).catch(() => {});   // offline: keep the cached copy

  // profile: every change is saved to the server; the copy updates at once so the page stays snappy
  let saving = Promise.resolve();
  const saveProfile = patch => {
    const next = {...profile.get(), ...patch};
    if (patch.name) { const u = account.get(); if (u) store('nk-user', {...u, name: patch.name}); }
    store('nk-profile', next); render();
    saving = saving.then(() => api('PUT', '/api/profile', patch.name ? {...next, name: patch.name} : next)
      .then(r => store('nk-profile', {...next, ...r.profile}))
      .catch(err => { toast(err.message || 'Could not save. Please try again.'); sync(); }));
    return next;
  };
  // Cards keep ONLY brand, last 4 digits, expiry and name: never a full number or CVV (the server enforces this too).
  const profile = {
    get: () => ({...EMPTY_PROFILE, ...(read('nk-profile') || {})}),
    save: saveProfile,
    // add or replace by id; the first entry of a list becomes the default
    upsert(list, item) {
      const arr = profile.get()[list];
      if (!item.id) item.id = Math.random().toString(36).slice(2, 9);
      const i = arr.findIndex(x => x.id === item.id);
      i >= 0 ? arr[i] = item : arr.push(item);
      if (item.isDefault) arr.forEach(x => x.isDefault = x.id === item.id);
      if (!arr.some(x => x.isDefault)) arr[0].isDefault = true;
      return saveProfile({[list]: arr}); },
    remove(list, id) { const out = profile.get()[list].filter(x => x.id !== id);
      if (out.length && !out.some(x => x.isDefault)) out[0].isDefault = true;
      return saveProfile({[list]: out}); },
    setDefault(list, id) { return saveProfile({[list]: profile.get()[list].map(x => ({...x, isDefault: x.id === id}))}); },
  };

  // wishlist: kept in this browser for guests, saved to the account when signed in
  const loadWish = () => read('nk-wish') || [];
  const wish = {
    ids: loadWish,
    has: id => loadWish().includes(id),
    toggle(id) { const w = loadWish(), on = !w.includes(id), next = on ? [...w, id] : w.filter(x => x !== id);
      store('nk-wish', next); render();
      if (account.get()) api('PUT', '/api/wishlist', {ids: next}).catch(err => toast(err.message));
      return on; },
  };

  // orders: the signed-in account's orders, as last sent by the server
  const orders = {
    all: () => read('nk-orders') || [],
    add(o) { store('nk-orders', [o, ...orders.all().filter(x => x.id !== o.id)]); },
    forEmail: id => orders.all().filter(o => [o.email, o.account].some(v => (v || '').toLowerCase() === (id || '').toLowerCase())),
  };
  // search: every word must appear somewhere in the sari's name, weave, colour, occasion or description
  const occLabel = k => ({bridal: 'Bridal', reception: 'Reception', mehendi: 'Mehendi and haldi', festive: 'Festive', everyday: 'Everyday'})[k];
  const search = q => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return products
      .map(p => { const hay = `${p.name} ${p.weave} ${p.colour} ${occLabel(p.occasion)} ${p.about}`.toLowerCase();
        if (!words.every(w => hay.includes(w))) return null;
        // name and weave matches rank above description matches
        return {p, score: words.reduce((s, w) => s + (p.name.toLowerCase().includes(w) ? 3 : 0) + (p.weave.toLowerCase().includes(w) ? 2 : 0) + 1, 0)}; })
      .filter(Boolean).sort((a, b) => b.score - a.score).map(r => r.p);
  };
  console.assert(search('pink chanderi').every(p => p.weave === 'Chanderi'), 'search: all words must match');
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
  const highlight = (text, q) => { let out = esc(text);
    q.split(/\s+/).filter(w => w.length > 1).forEach(w => out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>'));
    return out; };


  // ---------- drawer ----------
  const drawer = document.createElement('aside');
  drawer.className = 'bag'; drawer.setAttribute('aria-label', 'Shopping bag'); drawer.setAttribute('aria-hidden', 'true');
  drawer.innerHTML = `<div class="bag-scrim" data-bag-close></div>
    <div class="bag-panel" role="dialog" aria-modal="true" aria-labelledby="bag-title">
      <header><h2 id="bag-title">Your bag</h2><button class="x" data-bag-close aria-label="Close bag">Close</button></header>
      <div class="bag-lines"></div>
      <footer class="bag-foot"></footer>
    </div>`;
  document.addEventListener('DOMContentLoaded', () => { document.body.append(drawer); render(); });
  // heart buttons anywhere on the page
  document.addEventListener('click', e => {
    const h = e.target.closest('[data-wish]'); if (!h) return;
    e.preventDefault(); e.stopPropagation();
    const on = wish.toggle(h.dataset.wish);
    if (window.gsap && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      gsap.fromTo(h.querySelector('svg'), {scale: on ? .5 : 1.2}, {scale: 1, duration: .6, ease: 'back.out(3)'});
  });

  function render() {
    document.querySelectorAll('[data-bag-count]').forEach(e => { e.textContent = bag.count(); e.toggleAttribute('data-zero', !bag.count()); });
    document.querySelectorAll('[data-wish-count]').forEach(e => e.textContent = loadWish().length);
    document.querySelectorAll('[data-wish]').forEach(b => { const on = loadWish().includes(b.dataset.wish);
      b.setAttribute('aria-pressed', on); b.setAttribute('aria-label', (on ? 'Remove from' : 'Save to') + ' wishlist'); });
    const user = account.get();
    document.querySelectorAll('[data-account]').forEach(a => { a.textContent = user ? user.name.split(' ')[0] : 'Sign in'; a.href = user ? 'account.html' : 'login.html'; });
    // profile icon: an outline when signed out, the first initial when signed in; its dropdown follows suit
    // profile block at the top of the side menu
    document.querySelectorAll('.menu-profile').forEach(m => m.innerHTML = user ? `
      <a class="mp-head" href="account.html#overview"><span class="am-ini">${esc((user.name.trim()[0] || '?').toUpperCase())}</span>
        <span><b>${esc(user.name)}</b><small>${esc(user.email)}</small></span></a>
      <div class="mp-links"><a href="account.html#orders">Orders</a><a href="account.html#addresses">Addresses</a><a href="account.html#payments">Payments</a><a href="account.html#profile">Profile</a></div>
      <button type="button" class="mp-out" data-signout>Sign out</button>`
      : `<div class="mp-head"><span class="am-ini">${ICON.user}</span><span><b>Welcome</b><small>Sign in to see orders and saved details.</small></span></div>
      <div class="mp-cta"><a class="btn dark" href="login.html">Sign in</a><a class="btn" href="login.html?mode=up">Create account</a></div>`);
    const items = load(), lines = drawer.querySelector('.bag-lines'), foot = drawer.querySelector('.bag-foot');
    if (!lines) return;
    if (!items.length) {
      lines.innerHTML = `<div class="bag-empty"><p>Your bag is empty.</p><a class="btn dark" href="shop.html">Browse saris</a></div>`;
      foot.innerHTML = ''; return;
    }
    lines.innerHTML = items.map(i => { const p = get(i.id); return `
      <div class="bag-line">
        <a href="product.html?id=${p.id}"><img src="${p.img}" alt="${p.name} sari"></a>
        <div>
          <h3>${p.name}</h3><p>${p.weave}, ${p.colour}</p><p>${blouseLabel(i.blouse)}</p>
          <div class="qty" role="group" aria-label="Quantity of ${p.name}">
            <button data-q="${i.key}" data-d="-1" aria-label="One fewer">−</button><span>${i.qty}</span><button data-q="${i.key}" data-d="1" aria-label="One more">+</button>
          </div>
        </div>
        <div class="line-end"><b>${money(unitPrice(i) * i.qty)}</b><button class="link" data-rm="${i.key}">Remove</button></div>
      </div>`; }).join('');
    const t = totals(items);
    foot.innerHTML = `<div class="bag-row"><span>Subtotal</span><b>${money(t.subtotal)}</b></div>
      <p class="note">Prices include GST. Standard shipping in India is free.</p>
      <a class="btn dark wide" href="checkout.html">Checkout</a>`;
  }
  drawer.addEventListener('click', e => {
    const q = e.target.closest('[data-q]'), rm = e.target.closest('[data-rm]');
    if (q) { const it = load().find(i => i.key === q.dataset.q); bag.setQty(it.key, it.qty + +q.dataset.d); }
    if (rm) bag.remove(rm.dataset.rm);
    if (e.target.closest('[data-bag-close]')) closeBag();
  });
  let lastFocus;
  const openBag = () => { lastFocus = document.activeElement; drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); drawer.querySelector('.x').focus(); };
  const closeBag = () => { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); lastFocus?.focus(); };
  document.addEventListener('click', e => { if (e.target.closest('[data-bag-open]')) { e.preventDefault(); openBag(); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer.classList.contains('open')) closeBag(); });

  // a small copy of the photo flies into the bag link, then the drawer opens
  const flyToBag = (fromImg, done) => {
    const to = document.querySelector('[data-bag-open]');
    if (!fromImg || !to || !window.gsap || matchMedia('(prefers-reduced-motion: reduce)').matches) return done();
    const a = fromImg.getBoundingClientRect(), b = to.getBoundingClientRect(), c = fromImg.cloneNode();
    Object.assign(c.style, {position: 'fixed', left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px', objectFit: 'cover', zIndex: 200, pointerEvents: 'none'});
    document.body.append(c);
    gsap.timeline({onComplete: () => { c.remove(); done(); }})
      .to(c, {x: b.left + b.width / 2 - a.left - a.width / 2, y: b.top + b.height / 2 - a.top - a.height / 2, scale: .06, borderRadius: '50%', duration: .9, ease: 'power3.in'})
      .to(to, {scale: 1.25, duration: .15, yoyo: true, repeat: 1}, '>-.05');
  };

  // ---------- theme ----------
  const setTheme = t => { document.documentElement.dataset.theme = t; try { localStorage.setItem('nk-theme', t); } catch {}
    document.querySelectorAll('.theme-btn').forEach(b => b.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode')); };

  // ---------- search overlay ----------
  const searchEl = document.createElement('div');
  searchEl.className = 'search'; searchEl.setAttribute('aria-hidden', 'true');
  searchEl.innerHTML = `<div class="search-scrim" data-search-close></div>
    <div class="search-panel" role="dialog" aria-modal="true" aria-label="Search the shop">
      <form action="search.html" role="search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
        <input name="q" type="search" placeholder="Search saris, weaves, colours" aria-label="Search" autocomplete="off">
        <button type="button" class="x" data-search-close>Close</button>
      </form>
      <p class="hint">Press Enter to see every result.</p>
      <div class="chips"><a href="search.html?q=chanderi">Chanderi</a><a href="search.html?q=bridal">Bridal</a><a href="search.html?q=pink">Pink</a><a href="search.html?q=cotton">Cotton</a><a href="search.html?q=gold">Gold</a></div>
      <div class="sresults" aria-live="polite"></div>
    </div>`;
  const sInput = searchEl.querySelector('input'), sOut = searchEl.querySelector('.sresults');
  sInput.addEventListener('input', () => {
    const q = sInput.value.trim(), hits = search(q);
    sOut.innerHTML = !q ? '' : hits.length
      ? hits.slice(0, 5).map(p => `<a href="product.html?id=${p.id}"><img src="${p.img}" alt=""><b>${highlight(p.name, q)}</b>${highlight(p.weave + ', ' + p.colour, q)}<br>${money(p.price)}</a>`).join('')
        + (hits.length > 5 ? `<a class="all" href="search.html?q=${encodeURIComponent(q)}">See all ${hits.length} results</a>` : '')
      : `<p>No saris match “${esc(q)}”. Try a weave like Chanderi or a colour like pink.</p>`;
  });
  let searchFocus;
  const openSearch = () => { searchFocus = document.activeElement; searchEl.classList.add('open'); searchEl.setAttribute('aria-hidden', 'false'); setTimeout(() => sInput.focus(), 50); };
  const closeSearch = () => { searchEl.classList.remove('open'); searchEl.setAttribute('aria-hidden', 'true'); searchFocus?.focus(); };
  searchEl.addEventListener('click', e => { if (e.target.closest('[data-search-close]')) closeSearch(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && searchEl.classList.contains('open')) closeSearch();
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); openSearch(); }
  });

  // ---------- back to top, with a ring that fills as you scroll ----------
  const top = document.createElement('button');
  top.className = 'totop'; top.setAttribute('aria-label', 'Back to top');
  top.innerHTML = `<svg viewBox="0 0 52 52" aria-hidden="true"><circle class="track" cx="26" cy="26" r="24"/><circle class="ring" cx="26" cy="26" r="24" stroke-dasharray="150.8" stroke-dashoffset="150.8"/></svg>
    <svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`;
  top.onclick = () => window.lenis ? window.lenis.scrollTo(0, {duration: 1.6}) : scrollTo({top: 0, behavior: 'smooth'});
  addEventListener('scroll', () => {
    const max = document.documentElement.scrollHeight - innerHeight, p = max > 0 ? scrollY / max : 0;
    top.classList.toggle('show', scrollY > innerHeight * .8);
    top.querySelector('.ring').style.strokeDashoffset = 150.8 * (1 - p);
  }, {passive: true});

  // ---------- cookie notice: only essential storage is used, so the choice is simply remembered ----------
  const cookies = () => {
    try { if (localStorage.getItem('nk-consent')) return; } catch { return; }
    const c = document.createElement('section');
    c.className = 'cookies'; c.setAttribute('aria-label', 'Cookie notice');
    c.innerHTML = `<h2>A note on cookies</h2>
      <p>We keep your bag, wishlist and theme in this browser so they are here when you return. Nothing is shared with advertisers.</p>
      <div class="row"><button class="btn" data-consent="essential">Essential only</button><button class="btn dark" data-consent="all">Accept</button></div>`;
    document.body.append(c);
    c.addEventListener('click', e => { const b = e.target.closest('[data-consent]'); if (!b) return;
      try { localStorage.setItem('nk-consent', b.dataset.consent); } catch {}
      c.classList.remove('show'); setTimeout(() => c.remove(), 800); });
    // on the home page wait for the intro curtain to lift
    const wait = setInterval(() => { const l = document.querySelector('.loader');
      if (!l || getComputedStyle(l).display === 'none') { clearInterval(wait); setTimeout(() => c.classList.add('show'), 900); } }, 300);
  };

  // ---------- silk transition: a sari sweeps across the whole screen ----------
  // 'cover': silk slides in from the left until the page is hidden (then we navigate home).
  // 'reveal': the page starts covered and the silk is pulled away to the right.
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const silk = mode => new Promise(done => {
    if (reduceMotion()) return done();
    document.querySelector('.silk-veil')?.remove();
    const c = document.createElement('canvas'); c.className = 'silk-veil'; c.setAttribute('aria-hidden', 'true');
    document.body.append(c);
    const ctx = c.getContext('2d'), dpr = Math.min(devicePixelRatio || 1, 2), W = innerWidth, H = innerHeight;
    c.width = W * dpr; c.height = H * dpr; ctx.scale(dpr, dpr);
    const dur = mode === 'cover' ? 380 : 600, amp = Math.max(60, W * .08), t0 = performance.now();   // quick: about a second door to door
    const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const side = mode === 'cover' ? -1 : 1;   // which side of the wavy edge the cloth is on
    const frame = now => {
      const t = Math.min(1, (now - t0) / dur), time = now / 1000;
      const base = -amp * 2 + (W + amp * 4) * ease(t);
      const edge = y => base + Math.sin(y * .006 + time * 2.2) * amp * .6 + Math.sin(y * .017 - time * 3) * amp * .25;
      ctx.clearRect(0, 0, W, H);
      ctx.save(); ctx.beginPath();
      const far = side < 0 ? -20 : W + 20;
      ctx.moveTo(far, -20);
      for (let y = -20; y <= H + 20; y += 12) ctx.lineTo(edge(y), y);
      ctx.lineTo(far, H + 20); ctx.closePath(); ctx.clip();
      ctx.fillStyle = '#5A1622'; ctx.fillRect(0, 0, W, H);                  // indigo body
      for (let x = 0; x < W; x += 6) {                                       // soft vertical folds that drift
        const l = Math.sin(x * .011 + time * 1.4 + Math.sin(x * .003) * 2);
        ctx.fillStyle = `rgba(${l > 0 ? '255,255,255' : '25,0,6'},${Math.abs(l) * .09})`; ctx.fillRect(x, 0, 6, H);
      }
      ctx.fillStyle = 'rgba(233,196,106,.7)';                                // woven buttas
      for (let y = 34, r = 0; y < H; y += 54, r++) for (let x = (r % 2) * 27 + 18; x < W; x += 54) { ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 7); ctx.fill(); }
      ctx.restore();
      const line = (off, w, style) => { ctx.beginPath();
        for (let y = -20; y <= H + 20; y += 8) { const x = edge(y) + side * off; y === -20 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        ctx.lineWidth = w; ctx.strokeStyle = style; ctx.stroke(); };
      const gold = ctx.createLinearGradient(0, 0, 0, H);
      gold.addColorStop(0, '#a8761f'); gold.addColorStop(.5, '#f3d27a'); gold.addColorStop(1, '#a8761f');
      line(14, 26, gold); line(31, 3, '#5E1621'); line(2, 2, '#fff1c2');     // zari border on the edge
      if (t < 1) return requestAnimationFrame(frame);
      if (mode === 'reveal') c.remove();
      done();
    };
    frame(performance.now());
  });
  const isHome = /(^\/$|\/index\.html$)/.test(location.pathname);
  const goesHome = url => { try { const u = new URL(url, location.href); return u.origin === location.origin && /(^\/$|\/index\.html$)/.test(u.pathname); } catch { return false; } };
  // a link to another page of this site (not a #section of the page we are on)
  const isPageLink = url => { try { const u = new URL(url, location.href);
    return u.origin === location.origin && /(\.html|\/)$/.test(u.pathname) && !(u.pathname === location.pathname && u.search === location.search && u.hash); } catch { return false; } };
  // every page change inside the site: cover with silk, flag it, then go; the next page pulls the silk away
  const leave = go => silk('cover').then(() => { try { sessionStorage.setItem('nk-silk', '1'); } catch {} go(); });
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || a.target || a.hasAttribute('download') || a.hasAttribute('data-bag-open')) return;
    if (a.classList.contains('back')) {
      // back: the previous page on this site if there is one, otherwise home
      const prev = document.referrer && new URL(document.referrer).origin === location.origin && document.referrer !== location.href ? document.referrer : null;
      e.preventDefault(); closeMenu(true);
      return leave(() => prev ? history.back() : location.href = 'index.html');
    }
    if (a.getAttribute('href').startsWith('#') || !isPageLink(a.href)) return;
    if (buyFlow(a.href)) return openProduct(a, e);   // shopping steps: no silk, the photo carries you in
    e.preventDefault(); closeMenu(true); leave(() => location.href = a.href);
  });

  // ---------- opening a product: the tapped photo grows into the product page ----------
  // Uses the browser's cross-page View Transitions: the card photo and the product page's main photo share the name
  // "nk-product", so the browser morphs one into the other. Older browsers get a short zoom-and-fade instead.
  const buyFlow = url => { try { const u = new URL(url, location.href); return u.origin === location.origin && /\/(product|checkout)\.html$/.test(u.pathname); } catch { return false; } };
  const crossPageVT = 'onpagereveal' in window && CSS.supports('view-transition-name: a');
  const openProduct = (a, e) => {
    closeMenu(true);
    const photo = a.querySelector('.ph, img');
    document.querySelectorAll('[style*="view-transition-name"]').forEach(el => el.style.viewTransitionName = '');
    if (!photo || !/product\.html/.test(a.href)) return;   // checkout: the browser's quick cross-fade is enough
    try { sessionStorage.setItem('nk-open', '1'); } catch {}
    if (crossPageVT) {   // let the browser navigate and morph
      const current = document.querySelector('.gallery .fr:first-child');   // product to product: only one photo may carry the name
      if (current) current.style.viewTransitionName = 'none';
      photo.style.viewTransitionName = 'nk-product'; return;
    }
    if (reduceMotion()) return;
    // fallback: lift the photo towards the viewer while the page fades, then go
    e.preventDefault();
    const r = photo.getBoundingClientRect(), ghost = photo.cloneNode(true);
    Object.assign(ghost.style, {position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: 0, zIndex: 400,
      transition: 'transform .45s cubic-bezier(.22,1,.36,1), opacity .45s', transformOrigin: 'center', pointerEvents: 'none'});
    document.body.append(ghost);
    document.body.style.transition = 'opacity .3s'; document.querySelector('main').style.opacity = '0';
    requestAnimationFrame(() => { ghost.style.transform = 'scale(1.12)'; });
    setTimeout(() => location.href = a.href, 380);
  };
  // only shopping steps animate across pages; for everything else the silk does the work, so skip the browser's version
  addEventListener('pageswap', e => {
    if (!e.viewTransition) return;
    const to = e.activation && e.activation.entry && e.activation.entry.url;
    if (!to || !buyFlow(to) || reduceMotion()) e.viewTransition.skipTransition();
  });
  // arriving: if we came here through the silk, pull it away (home does this in its own intro code)
  const arrive = () => { let flagged = false;
    try { flagged = sessionStorage.getItem('nk-silk') === '1'; sessionStorage.removeItem('nk-silk'); } catch {}
    if (flagged && !isHome) silk('reveal');   // its first frame paints at once, fully covering the page
    document.documentElement.classList.remove('silk-in');   // the plain cover from <head> can go now
    return flagged; };
  // back/forward cache: the old page comes back still covered; drop that veil and play the reveal
  addEventListener('pageshow', e => {
    if (!e.persisted) return;
    // coming back from a product: no silk, and clear the shared photo name so the next product opens cleanly
    document.querySelectorAll('[style*="view-transition-name"]').forEach(el => el.style.viewTransitionName = '');
    const main = document.querySelector('main'); if (main) main.style.opacity = '';
    // only a page that left under the silk comes back covered; pull it away. Pages left by opening a product just reappear.
    const veil = document.querySelector('.silk-veil');
    if (veil) { veil.remove(); silk('reveal'); }
  });

  // ---------- one clean menu bar on every page ----------
  const ICON = {
    menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h11"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
    user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
    bag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1.2 12H6.2z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/></svg>',
    sun: '<svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>',
  };
  const h = hash => isHome ? hash : 'index.html' + hash;   // on home, section links scroll instead of reloading
  const menu = document.createElement('dialog');
  menu.className = 'menu'; menu.id = 'nk-menu'; menu.setAttribute('aria-label', 'Menu');
  menu.innerHTML = `
    <div class="menu-head"><span class="logo">Neelkora</span><button type="button" class="x" data-menu-close>Close</button></div>
    <section class="menu-profile" aria-label="Your profile" style="--i:0"></section>
    <nav class="menu-main" aria-label="Main">
      <a href="${isHome ? '#' : 'index.html'}" style="--i:0">Home</a>
      <a href="shop.html" style="--i:1">Shop all saris</a>
      <div class="menu-sub" style="--i:2"><a href="shop.html?occasion=bridal">Bridal</a><a href="shop.html?occasion=reception">Reception</a><a href="shop.html?occasion=mehendi">Mehendi and haldi</a><a href="shop.html?occasion=festive">Festive</a><a href="shop.html?occasion=everyday">Everyday</a></div>
      <a href="${h('#crafts')}" style="--i:3">The weaves</a>
      <a href="${h('#making')}" style="--i:4">How a sari is made</a>
      <a href="${h('#stores')}" style="--i:5">Stores</a>
    </nav>
    <div class="menu-minor" style="--i:6">
      <a href="wishlist.html">Wishlist <span data-wish-count>0</span></a>
      <button type="button" data-search-open>Search</button>
    </div>
    <div class="menu-foot" style="--i:7"><p>Handwoven in India</p></div>`;
  let menuOpener;
  const openMenu = () => { menuOpener = document.activeElement; menu.classList.remove('closing'); menu.showModal();
    document.querySelectorAll('[data-menu-open]').forEach(b => b.setAttribute('aria-expanded', 'true')); window.lenis?.stop(); };
  function closeMenu(instant) {
    if (!menu.open) return;
    const fin = () => { menu.close(); menu.classList.remove('closing'); window.lenis?.start();
      document.querySelectorAll('[data-menu-open]').forEach(b => b.setAttribute('aria-expanded', 'false')); menuOpener?.focus(); };
    if (instant === true || reduceMotion()) return fin();
    menu.classList.add('closing'); setTimeout(fin, 380);
  }
  menu.addEventListener('cancel', e => { e.preventDefault(); closeMenu(); });                 // Esc
  menu.addEventListener('click', e => {
    if (e.target === menu || e.target.closest('[data-menu-close]')) return closeMenu();      // backdrop or Close
    if (e.target.closest('[data-search-open]')) { closeMenu(true); return openSearch(); }
    const a = e.target.closest('a[href]'); if (!a) return;
    const href = a.getAttribute('href');
    if (href.startsWith('#')) { e.preventDefault(); closeMenu(true);                          // same-page section on home
      href.length > 1 ? (window.lenis ? window.lenis.scrollTo(href, {duration: 1.6}) : document.querySelector(href)?.scrollIntoView({behavior: 'smooth'})) : (window.lenis ? window.lenis.scrollTo(0) : scrollTo({top: 0, behavior: 'smooth'})); }
    else if (!goesHome(a.href)) closeMenu(true);
  });

  const buildNav = () => {
    const nav = document.querySelector('.snav, #nav'); if (!nav) return;
    nav.innerHTML = `
      <ul class="nav-l">
        <li><button type="button" class="icon-btn" data-menu-open aria-label="Open menu" aria-expanded="false" aria-controls="nk-menu">${ICON.menu}</button></li>
        ${isHome ? '' : `<li><a class="icon-btn back" href="index.html" aria-label="Go back">${ICON.back}</a></li>`}
      </ul>
      <a class="logo" href="${isHome ? '#' : 'index.html'}" aria-label="Neelkora home">Neelkora</a>
      <ul class="nav-r">
        <li><button type="button" class="icon-btn" data-search-open aria-label="Search">${ICON.search}</button></li>
        <li><button type="button" class="icon-btn theme-btn" aria-label="Switch to dark mode">${ICON.sun}${ICON.moon}</button></li>
        <li><a class="icon-btn bagbtn" href="#" data-bag-open aria-label="Bag">${ICON.bag}<span class="count" data-bag-count>0</span></a></li>
      </ul>`;
    nav.querySelector('[data-menu-open]').onclick = openMenu;
    nav.querySelector('[data-search-open]').onclick = openSearch;
    nav.querySelector('.theme-btn').onclick = e => {
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
      if (window.gsap && !reduceMotion()) gsap.fromTo(e.currentTarget.querySelectorAll('svg'), {rotate: -90, scale: .6}, {rotate: 0, scale: 1, duration: .5, ease: 'back.out(2)'});
    };
    if (isHome) nav.querySelector('.logo').onclick = e => { e.preventDefault(); window.lenis ? window.lenis.scrollTo(0) : scrollTo({top: 0, behavior: 'smooth'}); };
  };
  document.addEventListener('click', e => {
    if (!e.target.closest('[data-signout]')) return;
    const done = account.signOut();
    if (/account\.html$/.test(location.pathname)) { closeMenu(true); done.then(() => leave(() => location.href = 'login.html')); }
  });

  document.addEventListener('DOMContentLoaded', () => {
    document.body.append(searchEl, top, menu);
    buildNav();
    setTheme(document.documentElement.dataset.theme || 'light');
    render(); cookies(); arrive(); sync();
  });

  const heart = id => `<button type="button" class="heart" data-wish="${id}" aria-pressed="false" aria-label="Save to wishlist"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-9.2-8.6C1.2 8.2 3 4.8 6.4 4.5c2.1-.2 3.9.9 5.6 3 1.7-2.1 3.5-3.2 5.6-3 3.4.3 5.2 3.7 3.6 6.9C19 15.6 12 20 12 20z"/></svg></button>`;

  const states = ['Andhra Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala',
    'Madhya Pradesh', 'Maharashtra', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Tamil Nadu', 'Telangana', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];

  window.NK = {api, applyMe, sync, toast, silk, products, occasions, get, money, totals, unitPrice, bag, wish, account, profile, states, heart, render, orders, search, highlight, esc, openSearch, blouseLabel, openBag, flyToBag, STITCH, EXPRESS};
})();
