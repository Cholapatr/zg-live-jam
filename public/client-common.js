// Shared client-side helpers for ZG Live Jam

function getClientId() {
  let id = localStorage.getItem('zg_client_id');
  if (!id) {
    id = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('zg_client_id', id);
  }
  return id;
}

function getMyVotes() {
  try {
    return JSON.parse(localStorage.getItem('zg_my_votes') || '{}');
  } catch (e) {
    return {};
  }
}

function setMyVote(songId, voteType) {
  const votes = getMyVotes();
  if (voteType) votes[songId] = voteType;
  else delete votes[songId];
  localStorage.setItem('zg_my_votes', JSON.stringify(votes));
}

// A lightweight "who am I" identity for guests, so votes can show names.
function getGuestName() {
  return localStorage.getItem('zg_guest_name') || '';
}
function setGuestName(name) {
  if (name && name.trim()) localStorage.setItem('zg_guest_name', name.trim());
}
// Ask once (and remember) so votes can be attributed to a name. Cancel/blank
// still lets them vote — they'll just show up as "ไม่ระบุชื่อ". This is a
// fallback safety net for the rare case someone reaches a vote without ever
// going through confirmGuestNameForJoin() below (e.g. cleared localStorage
// mid-session) — normally the name is already set by then.
function ensureGuestName() {
  let n = getGuestName();
  if (!n) {
    const typed = prompt('ขอชื่อคุณหน่อยครับ (ให้รู้ว่าใครอยากฟัง/ร้องเพลงไหน)') || '';
    if (typed.trim()) { setGuestName(typed); n = getGuestName(); }
  }
  return n;
}

// Musician page's own display name — kept separate from the general guest
// name (via "เปลี่ยน" on that page) in case someone wants a different name
// specifically for the นักดนตรี role. confirmGuestNameForJoin() below
// re-syncs it to the guest name every time someone joins an event, though,
// so it doesn't go stale across events unless they've overridden it.
function getMyName() { return localStorage.getItem('zg_musician_name') || ''; }
function setMyName(n) { if (n && n.trim()) localStorage.setItem('zg_musician_name', n.trim()); }

// Musician roles (checkboxes on the Musician page) — also reset to a
// sensible default ("ช่วยร้อง") every time someone joins an event, same as
// the name, and just as editable afterward from that page.
function getMyRoles() {
  try { return JSON.parse(localStorage.getItem('zg_musician_roles') || '[]'); }
  catch (e) { return []; }
}
function setMyRoles(arr) { localStorage.setItem('zg_musician_roles', JSON.stringify(arr || [])); }

// Asks for (or re-confirms) a display name right when joining an event, so
// presence never has to fall back to a generic "ผู้ร่วมงาน" placeholder.
// Suggests the person's logged-in account name if they're signed in
// (still editable — they can type something else), otherwise whatever name
// this device already has saved. Cancelling just skips it — they can still
// join; ensureGuestName() above will ask again the first time they vote.
// Also syncs the musician-page name to match, so a fresh name entered when
// joining a new event shows up there too instead of a stale one.
async function confirmGuestNameForJoin() {
  let suggested = getGuestName();
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (data.loggedIn && data.user && data.user.name) suggested = data.user.name;
  } catch (e) { /* not logged in / offline — fall back to existing device name */ }
  const typed = prompt('ชื่อของคุณ (ให้คนอื่นใน event นี้รู้จักคุณ)', suggested || '');
  if (typed !== null && typed.trim()) setGuestName(typed);
  setMyName(getGuestName());
  setMyRoles(['🎶 ช่วยร้อง']);
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function chordUrl(title, artist) {
  const q = [title, artist].filter(Boolean).join(' ');
  return 'https://www.dochord.com/?s=' + encodeURIComponent(q);
}

// Turn a bare dochord song number (e.g. "22975") or a full dochord.com link
// into a canonical direct link, entirely client-side — no network call, no
// "verification" against dochord (it blocks automated requests, so we just
// trust what the person copied from the site themselves).
function buildDochordUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return `https://www.dochord.com/${s}/`;
  try {
    const u = new URL(s);
    if (/(^|\.)dochord\.com$/i.test(u.hostname)) {
      const m = u.pathname.match(/(\d+)/);
      return m ? `https://www.dochord.com/${m[1]}/` : s;
    }
  } catch (e) { /* not a valid URL */ }
  return null;
}

// Updates the shared top nav to show song counts, e.g. "Request List (12)".
function updateNavCounts(state) {
  const songCount = (state.songs || []).length;
  const showCount = (state.nextShow || []).length;
  document.querySelectorAll('nav.tabs a[href="index.html"]').forEach(a => {
    a.textContent = `🎶 Request List (${songCount})`;
  });
  document.querySelectorAll('nav.tabs a[href="nextshow.html"]').forEach(a => {
    a.textContent = `📋 Next Show List (${showCount})`;
  });
}

// ---- Event selection (Request List / Next Show List are scoped per event) ----
function getEventId() { return localStorage.getItem('zg_event_id') || ''; }
function getEventName() { return localStorage.getItem('zg_event_name') || ''; }
function setEvent(id, name) {
  localStorage.setItem('zg_event_id', id);
  localStorage.setItem('zg_event_name', name || '');
}
function clearEvent() {
  localStorage.removeItem('zg_event_id');
  localStorage.removeItem('zg_event_name');
}
// Call at the top of any page whose content is scoped to one event (Request
// List, Next Show List, นักดนตรี). Sends the person to events.html to pick
// one if they haven't yet. Returns '' (falsy) when redirecting, so callers
// can bail out early instead of trying to load data with no event selected.
function requireEvent() {
  const id = getEventId();
  if (!id) {
    location.href = 'events.html';
    return '';
  }
  return id;
}
// Shared header identity: the H1 (id="event-title") shows the current
// event's name — or "Select event to join.." before one is picked — instead
// of a fixed "ZG Live Jam" title. The old per-page title/tagline now lives
// in the smaller line below it. A "Leave Event" link (id="leave-event-link",
// optional — admin.html doesn't have one) clears the selection; the 4-item
// event nav (id="event-nav", optional) is hidden until an event is joined.
function renderEventHeader() {
  const titleEl = document.getElementById('event-title');
  const leaveEl = document.getElementById('leave-event-link');
  const navEl = document.getElementById('event-nav');
  const name = getEventName();
  if (titleEl) {
    titleEl.textContent = name || 'Select event to join..';
    // Before an event is joined, the title itself doubles as a link to the
    // event picker — no event means there's otherwise no way back to it.
    titleEl.classList.toggle('event-title-link', !name);
    if (!titleEl.dataset.wired) {
      titleEl.dataset.wired = '1';
      titleEl.addEventListener('click', () => {
        if (!getEventName()) location.href = 'events.html';
      });
    }
  }
  if (navEl) navEl.style.display = name ? '' : 'none';
  if (leaveEl) {
    leaveEl.style.display = name ? '' : 'none';
    if (!leaveEl.dataset.wired) {
      leaveEl.dataset.wired = '1';
      leaveEl.addEventListener('click', (e) => {
        e.preventDefault();
        if (confirm('ออกจาก Event นี้ และกลับไปหน้าเลือก Event ใช่หรือไม่?')) leaveEvent();
      });
    }
  }
}

// ---- Presence (who's live-connected to this event right now) ----
// Purely a live snapshot from the server (never stored anywhere) — a page
// just announces itself once connected, and re-announces automatically on
// every reconnect (the Socket.IO client does this on its own after a drop,
// e.g. WiFi hiccup) since the server-side socket id changes each time.
let _presenceSocket = null;
let _presenceList = [];
let _presenceStatus = localStorage.getItem('zg_presence_status') === 'online' ? 'online' : 'physical';

function getPresenceStatus() { return _presenceStatus; }

function setPresenceStatus(status) {
  _presenceStatus = status === 'online' ? 'online' : 'physical';
  localStorage.setItem('zg_presence_status', _presenceStatus);
  if (_presenceSocket && _presenceSocket.connected) {
    _presenceSocket.emit('presence-status', { status: _presenceStatus });
  }
}

// Cached once per page load — whether this browser is currently logged in,
// and to which account. Used to tell the server "I'm logged in" as part of
// presence-join, so "Share My Favourite" can tell whether a present friend
// is actually reachable (logged in) before trying to deliver to them.
let _myUserIdFetched = false;
let _myUserId = null;
async function getMyUserId() {
  if (_myUserIdFetched) return _myUserId;
  _myUserIdFetched = true;
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    _myUserId = (data.loggedIn && data.user) ? data.user.id : null;
  } catch (e) { _myUserId = null; }
  return _myUserId;
}

// Call once per page, right after `const socket = io();`, on any
// event-scoped page that has <div id="presence-widget"> in its header.
function initPresence(socket) {
  _presenceSocket = socket;
  const announce = async () => {
    const eventId = getEventId();
    if (!eventId) return;
    const userId = await getMyUserId();
    socket.emit('presence-join', {
      eventId,
      clientId: getClientId(),
      name: getGuestName() || 'ผู้ร่วมงาน',
      status: _presenceStatus,
      userId,
    });
  };
  socket.on('connect', announce);
  socket.on('presence-changed', (list) => {
    _presenceList = Array.isArray(list) ? list : [];
    renderPresenceWidget();
  });
  if (socket.connected) announce();
}

// Tells the server to drop this person from the list right away, instead of
// waiting for their socket to disconnect — used when explicitly leaving an
// event via the "Leave" link.
function presenceLeaveNow() {
  if (_presenceSocket && _presenceSocket.connected) _presenceSocket.emit('presence-leave');
  _presenceList = [];
  renderPresenceWidget();
}

function renderPresenceWidget() {
  const el = document.getElementById('presence-widget');
  if (!el) return;
  const list = _presenceList;
  const total = list.length;
  const onlineCount = list.filter((p) => p.status === 'online').length;
  const physicalCount = total - onlineCount;
  const expanded = el.dataset.expanded === '1';
  const myStatus = getPresenceStatus();
  el.innerHTML = `
    <button type="button" class="presence-badge" id="presence-toggle">
      <span class="presence-dot"></span>
      <span>${total} join · 📍${physicalCount} 🏠${onlineCount}</span>
      <span>${expanded ? '▲' : '▼'}</span>
    </button>
    ${expanded ? `
    <div class="presence-panel">
      <div class="small-note" style="margin:0 0 6px;">สถานะของคุณ</div>
      <div class="presence-status-row">
        <button type="button" data-mystatus="physical" class="${myStatus === 'physical' ? 'selected' : ''}">📍 อยู่ในงาน</button>
        <button type="button" data-mystatus="online" class="${myStatus === 'online' ? 'selected' : ''}">🏠 ออนไลน์</button>
      </div>
      ${total ? list.map((p) => `<div class="presence-person">${p.status === 'online' ? '🏠' : '📍'} ${escapeHtml(p.name)}</div>`).join('') : '<div class="empty">ยังไม่มีใคร join</div>'}
    </div>` : ''}
  `;
  document.getElementById('presence-toggle').addEventListener('click', () => {
    el.dataset.expanded = expanded ? '0' : '1';
    renderPresenceWidget();
  });
  if (expanded) {
    el.querySelectorAll('button[data-mystatus]').forEach((b) => {
      b.addEventListener('click', () => setPresenceStatus(b.dataset.mystatus));
    });
  }
  // If the page has <datalist id="presence-names-list">, keep it in sync too
  // — that's what powers "who to ask to sing" autocomplete inputs.
  populateNameDatalist('presence-names-list', list.map((p) => p.name));
}

// Current live list of names in this event (for "ขอให้ใครร้อง" pickers).
function getPresenceNames() { return _presenceList.map((p) => p.name); }

// Fills a <datalist> with one <option> per name (deduped) so a text input
// with list="<id>" offers autocomplete suggestions while still accepting
// free text for anyone not in the list.
function populateNameDatalist(datalistId, names) {
  const dl = document.getElementById(datalistId);
  if (!dl) return;
  const unique = [...new Set((names || []).filter(Boolean))];
  dl.innerHTML = unique.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
}

// ---- Inbox (per-person notifications for "ขอให้คนอื่นร้อง") ----
// Persisted server-side (unlike presence) and delivered live via a private
// Socket.IO room the server puts this clientId's socket(s) into as part of
// presence-join — so this only works on pages that also call initPresence().
let _inboxSocket = null;
let _inboxItems = [];
let _inboxEventId = '';
let _inboxClientId = '';

async function loadInbox() {
  _inboxEventId = getEventId();
  _inboxClientId = getClientId();
  if (!_inboxEventId || !_inboxClientId) return;
  try {
    const res = await fetch(`/api/inbox?eventId=${encodeURIComponent(_inboxEventId)}&clientId=${encodeURIComponent(_inboxClientId)}`);
    if (!res.ok) return;
    const data = await res.json();
    _inboxItems = data.items || [];
    renderInboxWidget();
  } catch (e) { /* offline or server hiccup — badge just stays as-is */ }
}

// Call once per page, right after initPresence(socket), on any page that has
// <div id="inbox-widget"> in its header.
function initInbox(socket) {
  _inboxSocket = socket;
  loadInbox();
  socket.on('connect', loadInbox);
  socket.on('inbox-new', (item) => {
    if (item.eventId !== getEventId() || item.toClientId !== getClientId()) return;
    if (!_inboxItems.some((i) => i.id === item.id)) _inboxItems.unshift(item);
    renderInboxWidget();
    let msg;
    if (item.kind === 'request') msg = `📥 ${item.fromName || 'มีคน'} ขอให้คุณร้อง "${item.songTitle}"`;
    else if (item.kind === 'favshare') msg = `📥 ${item.fromName || 'มีคน'} แชร์เพลงโปรดให้คุณ (${(item.favorites || []).length} เพลง)`;
    else msg = `📥 ${item.fromName || 'มีคน'} ตอบกลับคำขอเพลง "${item.songTitle}"`;
    showToast(msg);
  });
  socket.on('inbox-updated', (item) => {
    if (item.eventId !== getEventId()) return;
    const idx = _inboxItems.findIndex((i) => i.id === item.id);
    if (idx >= 0) _inboxItems[idx] = item; else _inboxItems.unshift(item);
    renderInboxWidget();
  });
  // Admin cleared this event's songs (Clear all Request List / Reset the
  // stage) — old inbox items would just be pointing at songs that no
  // longer exist, so drop them here too instead of waiting for a reload.
  socket.on('inbox-cleared', (data) => {
    if (!data || data.eventId !== getEventId()) return;
    _inboxItems = [];
    renderInboxWidget();
  });
}

const INBOX_STATUS_LABEL = {
  'yes-solo': '✅ ร้องได้',
  'yes-together': '🤝 ร้องด้วยกันนะ',
  no: '🙏 ขอบคุณที่ชวน แต่ไม่พร้อม',
};

// Small inline dropdown right under the bell — sized to its content (like
// the presence panel), not a full-screen modal, so a handful of messages
// doesn't take over the whole page.
function renderInboxWidget() {
  const el = document.getElementById('inbox-widget');
  if (!el) return;
  const unread = _inboxItems.filter((i) => !i.read).length;
  const expanded = el.dataset.expanded === '1';
  el.innerHTML = `
    <button type="button" class="inbox-bell" id="inbox-bell-btn">📥${unread ? `<span class="inbox-badge">${unread}</span>` : ''}</button>
    ${expanded ? `
    <div class="inbox-panel">
      ${_inboxItems.length ? _inboxItems.map(inboxItemHtml).join('') : '<div class="empty" style="padding:16px 4px;">ยังไม่มีข้อความ</div>'}
    </div>` : ''}
  `;
  document.getElementById('inbox-bell-btn').addEventListener('click', () => {
    const willExpand = el.dataset.expanded !== '1';
    el.dataset.expanded = willExpand ? '1' : '0';
    renderInboxWidget();
    if (willExpand) markInboxRead();
  });
  if (expanded) {
    el.querySelectorAll('button[data-respond]').forEach((btn) => {
      btn.addEventListener('click', () => respondInbox(btn.dataset.respond, btn.dataset.answer));
    });
    el.querySelectorAll('button[data-favshare-view]').forEach((btn) => {
      btn.addEventListener('click', () => openFavShareModal(btn.dataset.favshareView));
    });
  }
}

function inboxItemHtml(item) {
  const time = new Date(item.createdAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  if (item.kind === 'request') {
    return `
    <div class="inbox-item ${item.read ? '' : 'unread'}">
      <div class="inbox-item-head">
        <b>${escapeHtml(item.fromName || 'ไม่ระบุชื่อ')}</b> ขอให้คุณร้อง <b>${escapeHtml(item.songTitle)}</b>
        <span class="inbox-time">${time}</span>
      </div>
      ${item.status === 'pending' ? `
      <div class="btn-row" style="margin-top:8px;">
        <button data-respond="${item.id}" data-answer="yes-solo">✅ ร้องได้</button>
        <button data-respond="${item.id}" data-answer="yes-together">🤝 ร้องด้วยกันนะ</button>
        <button data-respond="${item.id}" data-answer="no">🙏 ไม่พร้อม</button>
      </div>` : `<div class="small-note" style="margin-top:6px;">คุณตอบไปแล้ว: ${INBOX_STATUS_LABEL[item.status] || ''}</div>`}
    </div>`;
  }
  if (item.kind === 'favshare') {
    const expired = Date.now() > item.expiresAt;
    const favs = item.favorites || [];
    return `
    <div class="inbox-item ${item.read ? '' : 'unread'}">
      <div class="inbox-item-head">
        <b>${escapeHtml(item.fromName || 'ไม่ระบุชื่อ')}</b> แชร์เพลงโปรดให้คุณ (${favs.length} เพลง)
        <span class="inbox-time">${time}</span>
      </div>
      ${expired ? `<div class="small-note" style="margin-top:6px;">⌛ หมดอายุแล้ว (แชร์ไว้เกิน 3 วัน)</div>` : `
      <div class="btn-row" style="margin-top:8px;">
        <button data-favshare-view="${item.id}">👀 ดูรายชื่อเพลง</button>
      </div>`}
    </div>`;
  }
  return `
  <div class="inbox-item ${item.read ? '' : 'unread'}">
    <div class="inbox-item-head">
      <b>${escapeHtml(item.fromName || 'ไม่ระบุชื่อ')}</b> ตอบกลับคำขอเพลง <b>${escapeHtml(item.songTitle)}</b>
      <span class="inbox-time">${time}</span>
    </div>
    <div class="small-note" style="margin-top:6px;">${INBOX_STATUS_LABEL[item.status] || ''}</div>
  </div>`;
}

// ---- "Favourite ของ <ชื่อคนแชร์>" modal ----
// Opened from a favshare inbox item's "ดูรายชื่อเพลง" button. Built and
// injected into the DOM on first use (rather than living as static markup
// in every page) since the inbox widget itself is shared across four
// different pages (index/nextshow/musician/admin) via this one file.
// Copies one song at a time so the recipient can pick and choose, instead of
// an all-or-nothing bulk import.
function ensureFavShareModal() {
  if (document.getElementById('favshare-modal-bg')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="modal-bg" id="favshare-modal-bg" style="display:none;">
      <div class="modal">
        <button class="close-x" id="favshare-modal-close">✕</button>
        <h2 id="favshare-modal-title">⭐ Favourite</h2>
        <div id="favshare-modal-list"></div>
        <button id="favshare-modal-done" style="width:100%; margin-top:14px;">ปิดหน้าต่างนี้</button>
      </div>
    </div>`;
  document.body.appendChild(div.firstElementChild);
  document.getElementById('favshare-modal-close').addEventListener('click', closeFavShareModal);
  document.getElementById('favshare-modal-done').addEventListener('click', closeFavShareModal);
  document.getElementById('favshare-modal-bg').addEventListener('click', (e) => {
    if (e.target.id === 'favshare-modal-bg') closeFavShareModal();
  });
}
function closeFavShareModal() {
  const el = document.getElementById('favshare-modal-bg');
  if (el) el.style.display = 'none';
}

async function openFavShareModal(itemId) {
  const item = _inboxItems.find((i) => i.id === itemId);
  if (!item) return;
  ensureFavShareModal();

  // Check which of the shared songs the recipient already has, so those
  // rows can show as already-added instead of an active copy button.
  let myKeys = new Set();
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (data.loggedIn) {
      myKeys = new Set((data.favorites || []).map((f) => (f.title + '|' + (f.artist || '')).toLowerCase()));
    }
  } catch (e) { /* best-effort — worst case a row's button just tries and no-ops */ }

  document.getElementById('favshare-modal-title').textContent = `⭐ Favourite ของ ${item.fromName || 'ไม่ระบุชื่อ'}`;
  renderFavShareModalList(item, myKeys);
  document.getElementById('favshare-modal-bg').style.display = 'flex';
}

function renderFavShareModalList(item, myKeys) {
  const el = document.getElementById('favshare-modal-list');
  const favs = item.favorites || [];
  if (!favs.length) { el.innerHTML = '<div class="empty">ไม่มีเพลงโปรดในรายการนี้</div>'; return; }
  el.innerHTML = favs.map((f, idx) => {
    const key = (f.title + '|' + (f.artist || '')).toLowerCase();
    const already = myKeys.has(key);
    const chordLink = f.chordUrl ? `<a href="${f.chordUrl}" target="_blank" rel="noopener" class="link-out" style="margin-top:0;">↗ ดูคอร์ด</a>` : '';
    return `
    <div class="card fav-card">
      <div class="fav-row">
        <div class="fav-info">
          <div class="fav-title">${escapeHtml(f.title)}</div>
          <div class="fav-sub">${escapeHtml(f.artist || 'ไม่ระบุศิลปิน')}${chordLink ? ' · ' + chordLink : ''}</div>
        </div>
        <div class="fav-actions">
          ${already
            ? `<button class="btn-favshare-added" style="pointer-events:none;">✓ มีอยู่แล้ว</button>`
            : `<button class="btn-favshare-add" data-favshare-copy-one="${idx}">+ Add to My Favorite</button>`}
        </div>
      </div>
    </div>`;
  }).join('');
  el.querySelectorAll('button[data-favshare-copy-one]').forEach((btn) => {
    btn.addEventListener('click', () => copyOneFavShareSong(item.id, parseInt(btn.dataset.favshareCopyOne, 10), btn));
  });
}

async function copyOneFavShareSong(itemId, index, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(`/api/inbox/${itemId}/copy-favorites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'เกิดข้อผิดพลาด'); btn.disabled = false; return; }
    btn.disabled = false;
    btn.classList.remove('btn-favshare-add');
    btn.classList.add('btn-favshare-added');
    btn.style.pointerEvents = 'none';
    btn.textContent = '✓ มีอยู่แล้ว';
    showToast(data.imported > 0 ? 'คัดลอกเข้ารายการโปรดแล้ว ⭐' : 'เพลงนี้อยู่ในรายการโปรดของคุณอยู่แล้ว');
  } catch (e) {
    showToast('เกิดข้อผิดพลาด');
    btn.disabled = false;
  }
}

async function respondInbox(id, answer) {
  try {
    const res = await fetch(`/api/inbox/${id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: getClientId(), response: answer }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'เกิดข้อผิดพลาด'); return; }
    const idx = _inboxItems.findIndex((i) => i.id === id);
    if (idx >= 0) _inboxItems[idx] = data.item;
    renderInboxWidget();
    showToast('ส่งคำตอบแล้ว ✓');
  } catch (e) {
    showToast('เกิดข้อผิดพลาด');
  }
}
async function markInboxRead() {
  if (!_inboxItems.some((i) => !i.read)) return;
  _inboxItems.forEach((i) => { i.read = true; });
  renderInboxWidget();
  try {
    await fetch('/api/inbox/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: _inboxEventId, clientId: _inboxClientId }),
    });
  } catch (e) { /* best-effort — badge already cleared locally */ }
}

// True on any page that only makes sense within a joined event (Request
// List, Next Show List, นักดนตรี, Admin). The server serves index.html for
// both "/index.html" AND the bare "/" root (e.g. the QR code links to just
// "/"), but the browser keeps location.pathname as "/" in that case — so a
// plain .endsWith('index.html') check silently misses it. Handle "/"
// explicitly instead of relying on the filename showing up in the path.
function pageRequiresEvent() {
  const p = location.pathname;
  if (p === '/') return true;
  return ['index.html', 'nextshow.html', 'musician.html', 'admin.html'].some((name) => p.endsWith(name));
}

// Clears the joined event. Pages that require one (Request List, Next Show
// List, นักดนตรี, Admin) send the person back to events.html; pages that
// don't (Favourite, Event list itself) just re-render in place.
function leaveEvent() {
  presenceLeaveNow();
  clearEvent();
  if (pageRequiresEvent()) {
    location.href = 'events.html';
    return;
  }
  renderEventHeader();
  if (typeof window.onLeaveEvent === 'function') window.onLeaveEvent();
}

// Same per-provider icon used on login.html's provider buttons, reused here
// so the little icon in front of a logged-in person's name hints at which
// account they signed in with (Google vs Microsoft vs LINE) at a glance.
const AUTH_PROVIDER_ICON = {
  microsoft: '🟦',
  google: '🟢',
  line: '💬',
};

// Shared login-status bar. Expects an element with id="auth-bar" in the
// page header. Fetches /api/me and shows either a login prompt or the
// signed-in user's name + logout — either way also links to ⭐ Favourite,
// which lives here (top-right) rather than as its own nav tab.
async function renderAuthBar() {
  const el = document.getElementById('auth-bar');
  if (!el) return;
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (data.loggedIn) {
      const favCount = (data.favorites || []).length;
      const icon = AUTH_PROVIDER_ICON[data.user.provider] || '👤';
      el.innerHTML = `<span>${icon} ${escapeHtml(data.user.name || 'ผู้ใช้')}</span> · ` +
        `<a href="favorites.html">⭐ Favourite (${favCount})</a> · ` +
        `<a href="/auth/logout?from=${encodeURIComponent(location.pathname)}">Sign out</a>`;
    } else {
      el.innerHTML = `<span>ยังไม่ได้เข้าสู่ระบบ</span> · ` +
        `<a href="favorites.html">⭐ Favourite</a> · ` +
        `<a href="login.html?from=${encodeURIComponent(location.pathname)}">เข้าสู่ระบบ</a>`;
    }
  } catch (e) {
    el.innerHTML = '';
  }
}

// Guards against stale content from the browser's back/forward cache. Pages
// that require an event (Request List, Next Show List, Musician, Admin)
// normally redirect to events.html the moment they load with no event
// joined — but a bfcache restore (e.g. pressing the browser Back button)
// skips that check entirely and shows the frozen old page as-is, which can
// look like leftover song data hanging around on what should be the event
// picker. Forcing a reload on a persisted pageshow re-runs that check fresh.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  if (pageRequiresEvent() && !getEventId()) location.reload();
});

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}
