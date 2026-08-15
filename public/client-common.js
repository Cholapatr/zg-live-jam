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
// still lets them vote — they'll just show up as "ไม่ระบุชื่อ".
function ensureGuestName() {
  let n = getGuestName();
  if (!n) {
    const typed = prompt('ขอชื่อคุณหน่อยครับ (ให้รู้ว่าใครอยากฟัง/ร้องเพลงไหน)') || '';
    if (typed.trim()) { setGuestName(typed); n = getGuestName(); }
  }
  return n;
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

// Clears the joined event. Pages that require one (Request List, Next Show
// List, นักดนตรี, Admin) send the person back to events.html; pages that
// don't (Favourite, Event list itself) just re-render in place.
function leaveEvent() {
  clearEvent();
  const requiresEvent = ['index.html', 'nextshow.html', 'musician.html', 'admin.html'].some((p) => location.pathname.endsWith(p));
  if (requiresEvent) {
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
        `<a href="/auth/logout?from=${encodeURIComponent(location.pathname)}">ออกจากระบบ</a>`;
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
  const needsEvent = ['index.html', 'nextshow.html', 'musician.html', 'admin.html'].some((p) => location.pathname.endsWith(p));
  if (needsEvent && !getEventId()) location.reload();
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
