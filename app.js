// حضور الفصول — Friday attendance: mass (قداس) + meeting (اجتماع), by class (فصل)

/* ================= config ================= */
const SUPABASE_URL = 'https://kcarkkmuludbmdlakkxd.supabase.co/rest/v1';
const SUPABASE_KEY = 'sb_publishable_LnDpH8NgNADbQ8dzLW4NlA_SkpPFoSC';
const DB_TABLE = 'app_data';
const APP_TAG = 'church-attendance';   // lets us refuse codes that belong to a different app
const PREFIX = 'ch_';                  // localStorage prefix (the other app on github.io uses its own)
const FONT_SCALES = { small: 0.9, medium: 1, large: 1.2 };
const DEFAULT_SETTINGS = { lang: 'ar', fontSize: 'medium', highContrast: false };
const STREAK_ALERT = 3;                // missed Fridays in a row that turn red in the report

/* ================= small helpers ================= */
const $ = (s, r) => (r || document).querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const load = (k, f) => { try { const v = localStorage.getItem(PREFIX + k); return v === null ? f : JSON.parse(v); } catch (e) { return f; } };
const save = (k, v) => { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch (e) { /* storage full / blocked */ } };

let state = {
  ready: false,
  members: [], attendance: {}, tests: [], config: { classes: [], teacherPassword: '' },
  settings: { ...DEFAULT_SETTINGS },
  teacherCode: null, pendingSync: false, syncStatus: '',
  authMode: 'create', joinCodeDraft: '', authError: '',
  screen: 'main', view: 'attend', selectedClass: 'all', selectedMemberId: null, selectedDate: null,
  search: '', sortDir: 'asc', adding: false, draft: { name: '', phone: '', parent: '', classId: null },
  welcomeMsg: '', importStatus: '', statusMsg: '', bulkFrom: '', bulkTo: '',
  selectedTestId: null, addingTest: false, testDraft: { name: '', date: '', max: '', classId: null }
};

const lang = () => (state.settings.lang === 'en' ? 'en' : 'ar');
function t(key, ...a) {
  let v = T[lang()][key];
  if (v === undefined) v = T.ar[key];
  return typeof v === 'function' ? v(...a) : v;
}

/* ================= dates (Fridays only) ================= */
const pad = n => String(n).padStart(2, '0');
const toISO = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayISO = () => toISO(new Date());
function addDays(s, n) { const d = parseISO(s); d.setDate(d.getDate() + n); return toISO(d); }
/* ---- service days: the mass day and the meeting day are settings (default: both on Friday) ----
   A "week" is identified by its mass date (the anchor). The meeting of that week is the occurrence of the meeting
   weekday closest to the mass date (up to 3 days before or after), so one week = one mass + one meeting. */
const massDay = () => (state.config.massDay != null ? +state.config.massDay : 5);
const meetingDay = () => (state.config.meetingDay != null ? +state.config.meetingDay : 5);
const meetingOffset = () => ((((meetingDay() - massDay() + 3) % 7) + 7) % 7) - 3;      // -3 … +3 days from the mass
const lastOn = (s, wd) => { const d = parseISO(s); d.setDate(d.getDate() - ((d.getDay() - wd + 7) % 7)); return toISO(d); };
const meetingDateOf = w => addDays(w, meetingOffset());
function weekOf(d) {                 // which week (anchor) a recorded date belongs to
  const wd = parseISO(d).getDay();
  if (wd === massDay()) return d;
  if (wd === meetingDay()) return addDays(d, -meetingOffset());
  return lastOn(d, massDay());       // a date recorded under older day settings
}
function latestAnchor() {            // newest week that has already started (its mass or meeting date has come)
  const now = todayISO();
  let a = addDays(lastOn(now, massDay()), 7);
  while (a > now && meetingDateOf(a) > now) a = addDays(a, -7);
  return a;
}
function firstWeekFrom(s) {          // first week that was not completely over when someone joined
  let a = addDays(lastOn(s, massDay()), -7);
  while (a < s && meetingDateOf(a) < s) a = addDays(a, 7);
  return a;
}
function normalizeSelected() { const cap = latestAnchor(), w = weekOf(state.selectedDate || cap); state.selectedDate = w > cap ? cap : w; }
const dayName = d => DAY_NAMES[lang()][parseISO(d).getDay()];
function fmtDay(s) { const d = parseISO(s); return dayName(s) + (lang() === 'ar' ? '، ' : ', ') + d.getDate() + ' ' + MONTH_NAMES[lang()][d.getMonth()] + ' ' + d.getFullYear(); }
function fmtWeek(w) { const m = meetingDateOf(w); return meetingOffset() === 0 ? fmtDay(w) : fmtDay(w) + ' / ' + dayName(m) + ' ' + fmtShort(m); }
function fmtShort(s) { const d = parseISO(s); return d.getDate() + ' ' + MONTH_NAMES[lang()][d.getMonth()]; }

/* ---- birthdays: stored as YYYY-MM-DD; a 🎂 shows beside the name during the member's birthday month ---- */
const toLatin = s => String(s).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
function validISO(y, m, d) {
  y = +y; m = +m; d = +d;
  const dt = new Date(y, m - 1, d);
  return y >= 1900 && dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? y + '-' + pad(m) + '-' + pad(d) : '';
}
function parseBirthday(v) {          // accepts a date input value, 15/11/2012, 2012-11-15, Arabic digits, or an Excel date number
  if (v == null || v === '') return '';
  if (v instanceof Date) return validISO(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === 'number') {
    if (v < 1 || v > 80000) return '';
    const d = new Date(Math.round((v - 25569) * 864e5));
    return validISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = toLatin(v).trim();
  if (/^\d{5}$/.test(s)) return parseBirthday(Number(s));      // an Excel date that arrived as text
  let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m) return validISO(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/);
  if (m) { let y = +m[3]; if (y < 100) y += y > 30 ? 1900 : 2000; return validISO(y, m[2], m[1]); }
  return '';
}
const birthdayThisMonth = m => !!m.birthday && /^\d{4}-\d{2}-\d{2}$/.test(m.birthday) && parseISO(m.birthday).getMonth() === new Date().getMonth();
const cake = m => birthdayThisMonth(m) ? ' <span class="cake" title="' + esc(t('birthdayMonth')) + '">&#127874;</span>' : '';

/* ================= classes, members, attendance ================= */
const classes = () => state.config.classes;
const classById = id => classes().find(c => c.id === id);
const className = id => (classById(id) ? classById(id).name : t('noClass'));
const hasClass = m => !!classById(m.classId);
function membersIn(sel) {
  return state.members.filter(m => sel === 'all' ? true : sel === 'none' ? !hasClass(m) : m.classId === sel);
}
const sortByName = list => list.slice().sort((a, b) => a.name.localeCompare(b.name, 'ar') * (state.sortDir === 'asc' ? 1 : -1));
// who attended each week, merged across every recorded date that belongs to that week
function buildWeeks() {
  const map = new Map();
  Object.keys(state.attendance).forEach(d => {
    const r = state.attendance[d], w = weekOf(d);
    let e = map.get(w);
    if (!e) { e = { mass: new Set(), meeting: new Set(), dates: [] }; map.set(w, e); }
    (r.mass || []).forEach(i => e.mass.add(i)); (r.meeting || []).forEach(i => e.meeting.add(i)); e.dates.push(d);
  });
  return map;
}
const EMPTY_WEEK = { mass: new Set(), meeting: new Set(), dates: [] };
const attendedW = (weeks, id, w, kind) => { const e = weeks.get(w); return !!(e && e[kind].has(id)); };

function toggleAtt(id, kind) {
  const w = state.selectedDate, e = buildWeeks().get(w);
  if (e && e[kind].has(id)) {                       // un-tick: remove it from every date of this week
    e.dates.forEach(d => {
      const r = state.attendance[d]; r[kind] = (r[kind] || []).filter(i => i !== id);
      if (!(r.mass || []).length && !(r.meeting || []).length) delete state.attendance[d];
    });
  } else {
    const d = kind === 'mass' ? w : meetingDateOf(w);
    if (d > todayISO()) return;                      // something that has not happened yet cannot be recorded
    const r = state.attendance[d] || { mass: [], meeting: [] };
    r.mass = r.mass || []; r.meeting = r.meeting || [];
    r[kind].push(id); state.attendance[d] = r;
  }
  persist(); render();
}
// weeks (anchors, oldest first) in which at least one of these members was recorded
function datesFor(ids, weeks) {
  const set = new Set(ids), out = [];
  weeks.forEach((e, w) => { if ([...e.mass].some(i => set.has(i)) || [...e.meeting].some(i => set.has(i))) out.push(w); });
  return out.sort();
}
function statsFor(m, dates, weeks) {
  // a member only counts the weeks from when they joined (or any week they actually attended)
  const since = m.addedAt ? firstWeekFrom(m.addedAt) : '0000-00-00';
  const a = (w, k) => attendedW(weeks, m.id, w, k);
  const mine = dates.filter(w => w >= since || a(w, 'mass') || a(w, 'meeting'));
  let mass = 0, meeting = 0, streak = 0;
  mine.forEach(w => { if (a(w, 'mass')) mass++; if (a(w, 'meeting')) meeting++; });
  for (let i = mine.length - 1; i >= 0; i--) {
    if (a(mine[i], 'mass') || a(mine[i], 'meeting')) break;
    streak++;
  }
  const total = mine.length;
  return { mass, meeting, total, streak, pct: total ? Math.round(100 * (mass + meeting) / (2 * total)) : 0, dates: mine };
}
function reportRows(sel) {
  const weeks = buildWeeks(), ms = sortByName(membersIn(sel));
  const dates = datesFor(ms.map(m => m.id), weeks);
  return { dates, weeks, rows: ms.map(m => ({ m, ...statsFor(m, dates, weeks) })) };
}

/* ================= storage + cloud sync ================= */
const dbHeaders = extra => Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, extra || {});
function newCode() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }
async function fetchByCode(code) {
  const res = await fetch(SUPABASE_URL + '/' + DB_TABLE + '?id=eq.' + encodeURIComponent(code) + '&select=payload', { headers: dbHeaders() });
  if (!res.ok) throw new Error('fetch ' + res.status);
  const rows = await res.json();
  return (rows && rows[0] && rows[0].payload) || null;
}
async function pushByCode(code, payload) {
  const res = await fetch(SUPABASE_URL + '/' + DB_TABLE, {
    method: 'POST',
    headers: dbHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ id: code, payload })
  });
  if (!res.ok) throw new Error('push ' + res.status);
}
const buildPayload = () => ({ app: APP_TAG, members: state.members, attendance: state.attendance, tests: state.tests, config: state.config });
function persistLocal() { save('members', state.members); save('attendance', state.attendance); save('tests', state.tests); save('config', state.config); }
function applyRemote(r) {
  state.members = Array.isArray(r.members) ? r.members : [];
  state.attendance = r.attendance || {};
  state.tests = (Array.isArray(r.tests) ? r.tests : []).map(x => ({ ...x, scores: x.scores || {} }));
  state.config = { classes: [], teacherPassword: '', ...(r.config || {}) };
  if (!['all', 'none'].includes(state.selectedClass) && !classById(state.selectedClass)) state.selectedClass = 'all';
  normalizeSelected();
}
function markPending(p) { state.pendingSync = p; save('pendingSync', p); refreshSyncUI(); }
function refreshSyncUI() {
  const b = $('#syncBanner');
  if (b) b.innerHTML = state.pendingSync ? '<div class="alert alert-danger py-2 small">' + esc(t('pendingSyncBanner')) + '</div>' : '';
  const s = $('#syncStatusLine');
  if (s) s.textContent = state.syncStatus || '';
}
// pushes are serialised so an older snapshot can never overwrite a newer one in the cloud
let pushing = false, pushAgain = false;
async function pushNow() {
  if (!state.teacherCode) return;
  if (pushing) { pushAgain = true; return; }
  pushing = true;
  try {
    do { pushAgain = false; await pushByCode(state.teacherCode, buildPayload()); } while (pushAgain);
    state.syncStatus = t('syncSuccess'); markPending(false);
  } catch (e) {
    state.syncStatus = t('offlineSaved'); markPending(true);
  }
  pushing = false; refreshSyncUI();
}
function persist() { persistLocal(); if (state.teacherCode) pushNow(); }

let pulling = false;
async function syncDown() {           // pick up changes made on other devices (only when nothing is waiting to upload)
  if (!state.teacherCode || state.pendingSync || pushing || pulling) return;
  pulling = true;
  try {
    const remote = await fetchByCode(state.teacherCode);
    if (remote && !state.pendingSync && !pushing && JSON.stringify([remote.members, remote.attendance, remote.config, remote.tests || []]) !== JSON.stringify([state.members, state.attendance, state.config, state.tests])) {
      applyRemote(remote); persistLocal();
      const ae = document.activeElement;
      if (!(ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) render();   // never wipe something being typed
    }
  } catch (e) { /* offline — try again later */ }
  pulling = false;
}
function trySync() { if (state.pendingSync) pushNow(); else syncDown(); }

/* ================= start-up ================= */
function applyPrefs() {
  const s = state.settings, rtl = s.lang !== 'en', de = document.documentElement;
  de.lang = rtl ? 'ar' : 'en'; de.dir = rtl ? 'rtl' : 'ltr';
  de.style.setProperty('--scale', FONT_SCALES[s.fontSize] || 1);
  de.classList.toggle('hc', !!s.highContrast);
  // both Bootstrap files are loaded; switch the matching one on via `media` (re-enabling a disabled link is unreliable in Chrome)
  const r = $('#bs-rtl'), l = $('#bs-ltr');
  if (r) r.media = rtl ? 'all' : 'not all';
  if (l) l.media = rtl ? 'not all' : 'all';
  document.title = t('appTitle');
}
async function init() {
  state.settings = { ...DEFAULT_SETTINGS, ...load('settings', {}) };
  applyPrefs();
  state.teacherCode = load('teacherCode', null);
  state.pendingSync = load('pendingSync', false);
  state.members = load('members', []);
  state.attendance = load('attendance', {});
  state.tests = load('tests', []);
  state.config = { classes: [], teacherPassword: '', ...load('config', {}) };
  state.selectedDate = latestAnchor();
  state.ready = true; render();
  if (state.teacherCode) {
    if (state.pendingSync) { await pushNow(); }
    else { await syncDown(); }
  }
  window.addEventListener('online', trySync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) trySync(); });
}

/* ================= sign-in ================= */
async function createCode(pw, confirmPw) {
  pw = (pw || '').trim();
  if (!pw) return fail(t('needPassword'));
  if (pw !== confirmPw) return fail(t('passwordMismatch'));
  const code = newCode(), cfg = { classes: [], teacherPassword: pw, massDay: 5, meetingDay: 5 };
  try { await pushByCode(code, { app: APP_TAG, members: [], attendance: {}, tests: [], config: cfg }); }
  catch (e) { return fail(t('createFail')); }
  Object.assign(state, { teacherCode: code, members: [], attendance: {}, tests: [], config: cfg, authError: '', pendingSync: false, selectedClass: 'all', screen: 'main', welcomeMsg: t('codeCreated', code) });
  save('teacherCode', code); save('pendingSync', false); persistLocal();
  render();
}
async function joinCode(codeRaw, pw) {
  const code = (codeRaw || '').trim().toUpperCase();
  if (!code) return fail(t('needCode'));
  let remote;
  try { remote = await fetchByCode(code); } catch (e) { return fail(t('joinFail')); }
  if (!remote) return fail(t('codeNotFound'));
  if (remote.app !== APP_TAG) return fail(t('wrongApp'));
  const stored = (remote.config && remote.config.teacherPassword) || '';
  if (stored && (pw || '').trim() !== stored) return fail(t('wrongPassword'));
  Object.assign(state, { teacherCode: code, authError: '', pendingSync: false, selectedClass: 'all', screen: 'main', joinCodeDraft: '' });
  applyRemote(remote);
  save('teacherCode', code); save('pendingSync', false); persistLocal();
  render();
}
function fail(msg) { state.authError = msg; render(); }
function logout() {
  if (!confirm(state.pendingSync ? t('logoutPendingConfirm') : t('logoutConfirm'))) return;
  ['teacherCode', 'role', 'pendingSync', 'members', 'attendance', 'tests', 'config'].forEach(k => localStorage.removeItem(PREFIX + k));
  Object.assign(state, { teacherCode: null, pendingSync: false, members: [], attendance: {}, tests: [], config: { classes: [], teacherPassword: '' }, screen: 'main', view: 'attend', selectedClass: 'all', adding: false, welcomeMsg: '', syncStatus: '' });
  render();
}

/* ================= members & classes ================= */
function addMember() {
  const d = state.draft, name = d.name.trim();
  if (!name) return;
  state.members.push({ id: uid('m_'), name, classId: classById(d.classId) ? d.classId : null, phone: d.phone.trim(), parentPhone: d.parent.trim(), addedAt: todayISO() });
  state.draft = { name: '', phone: '', parent: '', classId: d.classId };
  state.adding = false; persist(); render();
}
function deleteMember(id) {
  const m = state.members.find(x => x.id === id);
  if (!m || !confirm(t('deleteMemberConfirm', m.name))) return;
  state.members = state.members.filter(x => x.id !== id);
  state.tests.forEach(tt => { delete tt.scores[id]; });
  Object.keys(state.attendance).forEach(d => {
    const r = state.attendance[d];
    r.mass = (r.mass || []).filter(i => i !== id); r.meeting = (r.meeting || []).filter(i => i !== id);
    if (!r.mass.length && !r.meeting.length) delete state.attendance[d];
  });
  state.screen = 'main'; state.selectedMemberId = null; persist(); render();
}
function addClass(name) {
  name = (name || '').trim();
  if (!name || classes().some(c => c.name === name)) return null;
  const c = { id: uid('c_'), name };
  state.config.classes = [...classes(), c];
  persist(); return c;
}
function renameClass(id, name) {
  name = (name || '').trim();
  if (!name || classes().some(c => c.id !== id && c.name === name)) { render(); return; }
  state.config.classes = classes().map(c => c.id === id ? { ...c, name } : c);
  persist(); render();
}
function deleteClass(id) {
  const c = classById(id); if (!c) return;
  const n = state.members.filter(m => m.classId === id).length;
  if (!confirm(t('deleteClassConfirm', c.name, n))) return;
  state.config.classes = classes().filter(x => x.id !== id);
  state.members.forEach(m => { if (m.classId === id) m.classId = null; });
  state.tests.forEach(tt => { if (tt.classId === id) tt.classId = null; });
  if (state.selectedClass === id) state.selectedClass = 'all';
  persist(); render();
}
function bulkMove(from, to) {
  if (!from || !to || from === to) return;
  const moved = state.members.filter(m => (from === 'none' ? !hasClass(m) : m.classId === from));
  moved.forEach(m => { m.classId = to === 'none' ? null : to; });
  state.statusMsg = t('bulkDone', moved.length); persist(); render();
}
function deleteAll() {
  if (!confirm(t('deleteAllConfirm'))) return;
  state.members = []; state.attendance = {}; state.tests = []; persist(); render();
}

/* ================= export / import ================= */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob(['\uFEFF' + text], { type: type || 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
const csvCell = v => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCSV = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n');
function exportSummary() {
  const rows = [[t('colName'), t('colClass'), t('phoneLabel'), t('parentLabel'), t('addressLabel'), t('confessorLabel'), t('birthdayLabel'), t('colMass'), t('colMeeting'), t('colWeeks'), t('colPct'), t('colStreak')]];
  const { dates, weeks } = reportRows('all');
  sortByName(state.members).forEach(m => {
    const s = statsFor(m, dates, weeks);
    rows.push([m.name, className(m.classId), m.phone || '', m.parentPhone || '', m.address || '', m.confessor || '', m.birthday || '', s.mass, s.meeting, s.total, s.pct + '%', s.streak]);
  });
  download('attendance_summary_' + todayISO() + '.csv', toCSV(rows));
}
function exportMatrix() {
  const weeks = buildWeeks(), dates = datesFor(state.members.map(m => m.id), weeks);
  const rows = [[t('colName'), t('colClass'), ...dates]];
  sortByName(state.members).forEach(m => {
    rows.push([m.name, className(m.classId), ...dates.map(d => {
      const a = attendedW(weeks, m.id, d, 'mass'), b = attendedW(weeks, m.id, d, 'meeting');
      return a && b ? t('both') : a ? t('mass') : b ? t('meeting') : '-';
    })]);
  });
  download('attendance_by_week_' + todayISO() + '.csv', toCSV(rows));
}
function printReport() {
  let html = '<h1>' + esc(t('appTitle')) + '</h1><p>' + esc(fmtWeek(latestAnchor())) + '</p>';
  const groups = classes().map(c => ({ name: c.name, sel: c.id }));
  if (state.members.some(m => !hasClass(m))) groups.push({ name: t('noClass'), sel: 'none' });
  groups.forEach(g => {
    const { dates, rows } = reportRows(g.sel);
    if (!rows.length) return;
    html += '<h2>' + esc(g.name) + ' — ' + esc(t('weeksCount', dates.length)) + '</h2><table><tr><th>' + esc(t('colName')) + '</th><th>' + esc(t('colMass')) + '</th><th>' + esc(t('colMeeting')) + '</th><th>' + esc(t('colPct')) + '</th><th>' + esc(t('colStreak')) + '</th></tr>';
    rows.forEach(r => { html += '<tr><td>' + esc(r.m.name) + '</td><td>' + r.mass + '/' + r.total + '</td><td>' + r.meeting + '/' + r.total + '</td><td>' + r.pct + '%</td><td>' + r.streak + '</td></tr>'; });
    html += '</table>';
  });
  const el = $('#printReport'); el.innerHTML = html; el.dir = lang() === 'en' ? 'ltr' : 'rtl';
  window.print();
}
function ensureXLSX() {
  return new Promise((res, rej) => {
    if (window.XLSX) return res();
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => res(); s.onerror = () => rej(new Error('xlsx'));
    document.head.appendChild(s);
  });
}
const pick = (row, keys) => { for (const k of keys) if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim(); return ''; };
const pickRaw = (row, keys) => { for (const k of keys) if (row[k] != null && String(row[k]).trim() !== '') return row[k]; return ''; };
function templateCSV() {
  download('import_template.csv', toCSV([[t('colName'), t('colClass'), t('phoneLabel'), t('parentLabel'), t('addressLabel'), t('confessorLabel'), t('birthdayLabel')], [t('exampleName'), t('exampleClass'), '', '', '', '', t('exampleBirthday')]]));
}
async function importFile(input) {
  const file = input.files && input.files[0]; if (!file) return;
  state.importStatus = t('importing'); render();
  try {
    await ensureXLSX();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    let added = 0, skipped = 0;
    json.forEach(row => {
      const name = pick(row, ['الاسم', 'Name']); if (!name) return;
      const cname = pick(row, ['الفصل', 'Class']);
      let c = cname ? classes().find(x => x.name === cname) || addClass(cname) : null;
      const classId = c ? c.id : null;
      if (state.members.some(m => m.name === name && m.classId === classId)) { skipped++; return; }
      state.members.push({ id: uid('m_'), name, classId, phone: pick(row, ['رقم الهاتف', 'Phone number', 'Phone']), parentPhone: pick(row, ['رقم هاتف ولي الأمر', 'Parent phone number', 'Parent phone']),
        address: pick(row, ['العنوان', 'Address']), confessor: pick(row, ['أب الاعتراف', 'اب الاعتراف', 'Confession father', 'Confessor']),
        birthday: parseBirthday(pickRaw(row, ['عيد الميلاد', 'تاريخ الميلاد', 'Birthday', 'Birth date'])), addedAt: todayISO() });
      added++;
    });
    persist(); state.importStatus = t('importDone', added, skipped);
  } catch (e) { state.importStatus = t('importFail'); }
  input.value = ''; render();
}

/* ================= views ================= */
const btnPill = (on, act, attrs, label) => '<button class="btn btn-sm rounded-pill ' + (on ? 'btn-dark active' : 'btn-outline-dark') + '" data-act="' + act + '" ' + attrs + '>' + label + '</button>';
const langBtns = () => ['ar', 'en'].map(l => btnPill(lang() === l, 'lang', 'data-lang="' + l + '"', l === 'ar' ? 'العربية' : 'English')).join('');
const countLabel = n => (n === 0 ? t('noMembers') : t('memberCount', n));

function viewAuth() {
  const create = state.authMode !== 'join';
  const form = create
    ? '<p class="small text-secondary mb-3">' + esc(t('newCodeHint')) + '</p>' +
      '<div class="mb-3"><label class="form-label small text-secondary">' + esc(t('password')) + '</label><input id="newPw" class="form-control form-control-sm" type="password" autocomplete="new-password"></div>' +
      '<div class="mb-3"><label class="form-label small text-secondary">' + esc(t('confirmPassword')) + '</label><input id="newPw2" class="form-control form-control-sm" type="password" autocomplete="new-password" data-enter="create-code"></div>' +
      '<button class="btn btn-dark w-100" data-act="create-code">' + esc(t('createCodeBtn')) + '</button>'
    : '<p class="small text-secondary mb-2">' + esc(t('joinHint')) + '</p>' +
      '<div class="mb-3"><input id="joinCode" class="form-control form-control-sm code-input" type="text" maxlength="6" placeholder="ABC123" autocapitalize="characters" value="' + esc(state.joinCodeDraft) + '" data-draft="code" data-enter="join-code"></div>' +
      '<div class="mb-3"><label class="form-label small text-secondary">' + esc(t('password')) + '</label><input id="joinPw" class="form-control form-control-sm" type="password" autocomplete="current-password" data-enter="join-code"></div>' +
      '<button class="btn btn-dark w-100" data-act="join-code">' + esc(t('joinBtn')) + '</button>';
  return '<div class="mx-auto my-4 auth-wrap"><div class="d-flex justify-content-center gap-2 mb-3">' + langBtns() + '</div>' +
    '<div class="card card-body p-4"><h1 class="h4 text-center fw-bold mb-1">' + esc(t('appTitle')) + '</h1><p class="text-center small text-secondary mb-3">' + esc(t('appSub')) + '</p>' +
    (state.authError ? '<div class="alert alert-danger py-2 small">' + esc(state.authError) + '</div>' : '') +
    '<div class="d-flex justify-content-center gap-2 mb-3">' + btnPill(create, 'auth-mode', 'data-mode="create"', esc(t('newCodeTab'))) + btnPill(!create, 'auth-mode', 'data-mode="join"', esc(t('joinCodeTab'))) + '</div>' +
    form + '</div></div>';
}

function viewMain() {
  let h = '<div class="d-flex justify-content-between align-items-end gap-2 mb-3 pb-3 app-header"><div><h1 class="h4 fw-bold mb-0">' + esc(t('appTitle')) + '</h1><div class="small text-secondary">' + esc(countLabel(state.members.length)) + '</div></div>' +
    '<div class="d-flex gap-1"><button class="btn btn-sm btn-dark" data-act="settings" aria-label="' + esc(t('settings')) + '">&#9881;</button><button class="btn btn-sm btn-dark" data-act="add-toggle">' + esc(t('add')) + '</button></div></div>';
  h += '<div id="syncBanner"></div>';
  if (state.welcomeMsg) h += '<div class="alert alert-success alert-dismissible py-2 small">' + esc(state.welcomeMsg) + '<button class="btn-close" data-act="dismiss-welcome"></button></div>';
  if (!classes().length) return h + viewNoClasses();
  if (state.adding) h += viewAddForm();
  h += '<ul class="nav nav-tabs nav-fill mb-3"><li class="nav-item"><button class="nav-link ' + (state.view === 'attend' ? 'active' : '') + '" data-act="view" data-view="attend">' + esc(t('tabAttend')) + '</button></li>' +
    '<li class="nav-item"><button class="nav-link ' + (state.view === 'report' ? 'active' : '') + '" data-act="view" data-view="report">' + esc(t('tabReport')) + '</button></li>' +
    '<li class="nav-item"><button class="nav-link ' + (state.view === 'tests' ? 'active' : '') + '" data-act="view" data-view="tests">' + esc(t('tabTests')) + '</button></li></ul>';
  h += viewClassTabs();
  return h + (state.view === 'attend' ? viewAttend() : state.view === 'report' ? viewReport() : viewTests());
}
function viewNoClasses() {
  return '<div class="card card-body text-center py-4"><h2 class="h6 fw-semibold">' + esc(t('noClassesTitle')) + '</h2>' +
    '<p class="small text-secondary">' + esc(t('noClassesHint')) + '</p><div class="d-flex gap-2"><input id="firstClass" class="form-control form-control-sm" placeholder="' + esc(t('classNamePh')) + '" data-enter="add-class-first"><button class="btn btn-sm btn-dark text-nowrap" data-act="add-class-first">' + esc(t('addClass')) + '</button></div></div>';
}
function viewAddForm() {
  const d = state.draft;
  return '<div class="card card-body mb-3 d-flex flex-column gap-2">' +
    '<input id="dName" class="form-control form-control-sm" placeholder="' + esc(t('namePh')) + '" value="' + esc(d.name) + '" data-draft="name" data-enter="add-submit">' +
    '<div class="d-flex gap-2"><input class="form-control form-control-sm" type="tel" placeholder="' + esc(t('phoneLabel')) + '" value="' + esc(d.phone) + '" data-draft="phone"><input class="form-control form-control-sm" type="tel" placeholder="' + esc(t('parentLabel')) + '" value="' + esc(d.parent) + '" data-draft="parent" data-enter="add-submit"></div>' +
    '<div class="d-flex flex-wrap gap-2">' + classes().map(c => btnPill(d.classId === c.id, 'draft-class', 'data-id="' + esc(c.id) + '"', esc(c.name))).join('') + '</div>' +
    '<div class="d-flex gap-2"><button class="btn btn-sm btn-dark flex-grow-1" data-act="add-submit">' + esc(t('addMember')) + '</button><button class="btn btn-sm btn-outline-dark" data-act="add-toggle">' + esc(t('cancel')) + '</button></div></div>';
}
function viewClassTabs() {
  const tab = (sel, label) => '<button class="btn btn-sm rounded-pill flex-shrink-0 ' + (state.selectedClass === sel ? 'btn-dark active' : 'btn-outline-dark') + '" data-act="class" data-sel="' + esc(sel) + '">' + esc(label) + ' <span class="opacity-75">' + membersIn(sel).length + '</span></button>';
  let h = '<div class="class-tabs d-flex gap-2 mb-3">' + tab('all', t('all'));
  classes().forEach(c => { h += tab(c.id, c.name); });
  if (state.members.some(m => !hasClass(m))) h += tab('none', t('noClass'));
  return h + '</div>';
}
function viewAttend() {
  const d = state.selectedDate, cap = latestAnchor(), rtl = lang() !== 'en';
  const nav = (act, sym, off) => '<button class="btn btn-sm btn-outline-dark" data-act="' + act + '"' + (off ? ' disabled' : '') + '>' + sym + '</button>';
  let h = '<div class="d-flex align-items-center justify-content-center gap-2 mb-2">' +
    nav('date-prev', rtl ? '&#8594;' : '&#8592;', false) + '<span class="fw-bold text-center date-label">' + (meetingOffset() === 0 ? '<span class="d-block">' + esc(fmtDay(d)) + '</span>' : '<span class="d-block small">' + esc(t('mass')) + ': ' + esc(fmtDay(d)) + '</span><span class="d-block small">' + esc(t('meeting')) + ': ' + esc(fmtDay(meetingDateOf(d))) + '</span>') + '</span>' + nav('date-next', rtl ? '&#8592;' : '&#8594;', d >= cap) +
    '<span class="position-relative"><button class="btn btn-sm btn-dark cal-btn" tabindex="-1" type="button">&#128197;</button><input class="cal-input" type="date" value="' + d + '" max="' + todayISO() + '" data-change="date-pick" aria-label="' + esc(t('pickDate')) + '"></span></div>';
  h += '<div class="small text-secondary text-center mb-2">' + esc(t('daysNote', DAY_NAMES[lang()][massDay()], DAY_NAMES[lang()][meetingDay()])) + (d === cap ? '' : ' · <a href="#" data-act="date-today">' + esc(t('goLatest')) + '</a>') + '</div>';
  h += '<div class="d-flex gap-2 mb-2"><div class="input-group input-group-sm"><span class="input-group-text">&#128269;</span><input id="searchBox" class="form-control" placeholder="' + esc(t('searchPh')) + '" value="' + esc(state.search) + '" data-input="search"></div>' +
    '<button class="btn btn-sm btn-outline-dark text-nowrap" data-act="sort">' + esc(state.sortDir === 'asc' ? t('sortAsc') : t('sortDesc')) + '</button></div>';
  return h + '<div id="listArea">' + viewList() + '</div>';
}
function viewList() {
  const all = membersIn(state.selectedClass), q = state.search.trim().toLowerCase();
  const list = sortByName(all).filter(m => !q || m.name.toLowerCase().includes(q));
  const weeks = buildWeeks(), e = weeks.get(state.selectedDate) || EMPTY_WEEK;
  const mc = all.filter(m => e.mass.has(m.id)).length, sc = all.filter(m => e.meeting.has(m.id)).length;
  let h = '<div class="d-flex gap-2 mb-2"><span class="badge rounded-pill text-bg-light border fw-normal">' + esc(t('mass')) + ' ' + mc + '/' + all.length + '</span><span class="badge rounded-pill text-bg-light border fw-normal">' + esc(t('meeting')) + ' ' + sc + '/' + all.length + '</span></div>';
  if (!list.length) return h + '<div class="text-center text-secondary small py-4">' + esc(t('emptyList')) + '</div>';
  h += '<ul class="list-group list-group-flush border-top">';
  list.forEach((m, i) => {
    const tg = (kind, on) => {
      const future = (kind === 'mass' ? state.selectedDate : meetingDateOf(state.selectedDate)) > todayISO() && !on;   // not happened yet
      return '<button class="btn btn-sm rounded-pill att-toggle ' + (on ? 'btn-dark active' : 'btn-outline-dark') + '" data-act="toggle" data-kind="' + kind + '" data-id="' + esc(m.id) + '" aria-pressed="' + on + '"' + (future ? ' disabled title="' + esc(t('notYet')) + '"' : '') + '>' + (on ? '&#10003; ' : '') + esc(t(kind)) + '</button>';
    };
    h += '<li class="list-group-item d-flex align-items-center gap-2 px-1"><span class="seq">' + (i + 1) + '</span>' +
      '<button class="btn btn-link text-decoration-none text-body text-start p-0 flex-grow-1 fw-medium d-flex align-items-center gap-1 min-w-0" data-act="open" data-id="' + esc(m.id) + '"><span class="text-truncate">&#128100; ' + esc(m.name) + '</span>' + cake(m) + '</button>' +
      tg('mass', e.mass.has(m.id)) + tg('meeting', e.meeting.has(m.id)) + '</li>';
  });
  return h + '</ul>';
}
function viewReport() {
  const { dates, rows } = reportRows(state.selectedClass);
  if (!rows.length) return '<div class="text-center text-secondary small py-4">' + esc(t('emptyList')) + '</div>';
  if (!dates.length) return '<div class="text-center text-secondary small py-4">' + esc(t('noRecorded')) + '</div>';
  let h = '<div class="small text-secondary mb-2">' + esc(t('weeksCount', dates.length)) + '</div><div class="table-responsive"><table class="table table-sm align-middle mb-2"><thead><tr><th>' + esc(t('colName')) + '</th><th class="text-center">' + esc(t('colMass')) + '</th><th class="text-center">' + esc(t('colMeeting')) + '</th><th class="text-center">' + esc(t('colPct')) + '</th><th class="text-center">' + esc(t('colStreak')) + '</th></tr></thead><tbody>';
  rows.forEach(r => {
    h += '<tr><td><button class="btn btn-link text-decoration-none text-body text-start p-0 fw-medium" data-act="open" data-id="' + esc(r.m.id) + '">' + esc(r.m.name) + cake(r.m) + '</button></td><td class="text-center">' + r.mass + '/' + r.total + '</td><td class="text-center">' + r.meeting + '/' + r.total + '</td><td class="text-center">' + r.pct + '%</td><td class="text-center">' +
      (r.streak >= STREAK_ALERT ? '<span class="badge rounded-pill flag-red">' + r.streak + '</span>' : r.streak) + '</td></tr>';
  });
  return h + '</tbody></table></div><p class="small text-secondary">' + esc(t('streakHint', STREAK_ALERT)) + '</p>';
}

/* ================= tests (quizzes / exams with a score per member) ================= */
const testById = id => state.tests.find(x => x.id === id);
const testScope = tt => (classById(tt.classId) ? membersIn(tt.classId) : state.members);   // a test with no class is for everyone
const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
const testsFor = sel => state.tests.filter(tt => sel === 'all' ? true : sel === 'none' ? !classById(tt.classId) : (!classById(tt.classId) || tt.classId === sel)).sort(byDateDesc);
const fmtNum = n => String(Math.round(n * 100) / 100);
function parseScore(v) {            // '' -> null, a bad value -> NaN, otherwise a number (Arabic digits and ٫ / , are fine)
  const s = toLatin(v == null ? '' : v).replace(/[٫,]/g, '.').trim();
  if (s === '') return null;
  const n = Number(s);
  return isFinite(n) && n >= 0 ? n : NaN;
}
function testStats(tt) {
  const vals = testScope(tt).map(m => tt.scores[m.id]).filter(v => typeof v === 'number');
  if (!vals.length) return { n: 0 };
  return { n: vals.length, avg: vals.reduce((a, b) => a + b, 0) / vals.length, hi: Math.max(...vals), lo: Math.min(...vals) };
}
function addTest() {
  const d = state.testDraft, name = d.name.trim();
  if (!name) return;
  const max = parseScore(d.max);
  const tt = { id: uid('t_'), name, date: d.date || todayISO(), max: max && max > 0 ? max : null, classId: classById(d.classId) ? d.classId : null, scores: {} };
  state.tests.push(tt);
  state.testDraft = { name: '', date: todayISO(), max: '', classId: d.classId };
  state.addingTest = false; state.selectedTestId = tt.id; state.screen = 'test';   // go straight to entering scores
  persist(); render();
}
function setScore(tid, mid, el) {
  const tt = testById(tid); if (!tt) return;
  let n = parseScore(el.value);
  if (n !== null && (Number.isNaN(n) || (tt.max && n > tt.max))) { alert(Number.isNaN(n) ? t('scoreInvalid') : t('scoreOverMax', fmtNum(tt.max))); render(); return; }
  if (n === null) delete tt.scores[mid]; else { n = Math.round(n * 100) / 100; tt.scores[mid] = n; }
  el.value = n === null ? '' : fmtNum(n);
  persist(); refreshTestSummary();      // no full re-render, so the keyboard stays open for the next member
}
function deleteTest(id) {
  const tt = testById(id);
  if (!tt || !confirm(t('deleteTestConfirm', tt.name))) return;
  state.tests = state.tests.filter(x => x.id !== id);
  state.screen = 'main'; state.selectedTestId = null; persist(); render();
}
function exportTests() {
  const ts = state.tests.slice().sort((a, b) => -byDateDesc(a, b));
  const rows = [[t('colName'), t('colClass'), ...ts.map(tt => tt.name + ' (' + tt.date + ')' + (tt.max ? ' /' + fmtNum(tt.max) : ''))]];
  sortByName(state.members).forEach(m => rows.push([m.name, className(m.classId), ...ts.map(tt => typeof tt.scores[m.id] === 'number' ? tt.scores[m.id] : '')]));
  download('tests_' + todayISO() + '.csv', toCSV(rows));
}
function testSummaryHTML(tt) {
  const s = testStats(tt), total = testScope(tt).length, mx = tt.max ? '/' + fmtNum(tt.max) : '';
  if (!s.n) return '<p class="small text-secondary">' + esc(t('noScoresYet')) + '</p>';
  return '<div class="d-flex flex-wrap gap-2 mb-3">' + [t('scoredCount', s.n, total), t('avg') + ' ' + fmtNum(s.avg) + mx, t('highest') + ' ' + fmtNum(s.hi) + mx, t('lowest') + ' ' + fmtNum(s.lo) + mx]
    .map(x => '<span class="badge rounded-pill text-bg-light border fw-normal">' + esc(x) + '</span>').join('') + '</div>';
}
function refreshTestSummary() { const el = $('#testSummary'), tt = testById(state.selectedTestId); if (el && tt) el.innerHTML = testSummaryHTML(tt); }

function viewTests() {
  const list = testsFor(state.selectedClass);
  let h = '<button class="btn btn-sm btn-dark mb-3" data-act="add-test-toggle">' + esc(t('addTest')) + '</button>';
  if (state.addingTest) h += viewAddTest();
  if (!list.length) return h + '<div class="text-center text-secondary small py-4">' + esc(t('noTests')) + '</div>';
  h += '<ul class="list-group list-group-flush border-top">';
  list.forEach(tt => {
    const s = testStats(tt), total = testScope(tt).length;
    h += '<li class="list-group-item"><button class="btn btn-link text-decoration-none text-body text-start w-100 d-flex align-items-center gap-2 px-0 py-1" data-act="open-test" data-id="' + esc(tt.id) + '">' +
      '<span class="flex-grow-1 min-w-0"><span class="d-block fw-semibold text-truncate">' + esc(tt.name) + '</span>' +
      '<span class="d-flex flex-wrap gap-2 small text-secondary"><span>' + esc(fmtDay(tt.date)) + '</span>' + (classById(tt.classId) ? '<span>' + esc(className(tt.classId)) + '</span>' : '') + '</span></span>' +
      '<span class="d-flex flex-column align-items-end gap-1 flex-shrink-0">' +
        (s.n ? '<span class="badge rounded-pill flag-ok">' + esc(t('avg')) + ' ' + fmtNum(s.avg) + (tt.max ? '/' + fmtNum(tt.max) : '') + '</span>' : '<span class="badge rounded-pill text-bg-light border fw-normal">' + esc(t('noScoresShort')) + '</span>') +
        '<span class="small text-secondary">' + esc(t('scoredCount', s.n || 0, total)) + '</span></span></button></li>';
  });
  return h + '</ul>';
}
function viewAddTest() {
  const d = state.testDraft;
  return '<div class="card card-body mb-3 d-flex flex-column gap-2">' +
    '<input id="tName" class="form-control form-control-sm" placeholder="' + esc(t('testNamePh')) + '" value="' + esc(d.name) + '" data-draft="tname" data-enter="add-test-submit">' +
    '<div class="d-flex gap-2"><div class="flex-fill"><label class="form-label small text-secondary">' + esc(t('testDateLabel')) + '</label><input class="form-control form-control-sm" type="date" value="' + esc(d.date || todayISO()) + '" data-draft="tdate"></div>' +
    '<div class="flex-fill"><label class="form-label small text-secondary">' + esc(t('testMaxLabel')) + '</label><input class="form-control form-control-sm" type="text" inputmode="decimal" placeholder="20" value="' + esc(d.max) + '" data-draft="tmax" data-enter="add-test-submit"></div></div>' +
    '<div class="d-flex flex-wrap gap-2">' + btnPill(!classById(d.classId), 'tdraft-class', 'data-id=""', esc(t('allClasses'))) + classes().map(c => btnPill(d.classId === c.id, 'tdraft-class', 'data-id="' + esc(c.id) + '"', esc(c.name))).join('') + '</div>' +
    '<div class="d-flex gap-2"><button class="btn btn-sm btn-dark flex-grow-1" data-act="add-test-submit">' + esc(t('createTest')) + '</button><button class="btn btn-sm btn-outline-dark" data-act="add-test-toggle">' + esc(t('cancel')) + '</button></div></div>';
}
function viewTest() {
  const tt = testById(state.selectedTestId);
  if (!tt) { state.screen = 'main'; return viewMain(); }
  const ms = sortByName(testScope(tt)), id = esc(tt.id);
  const field = (label, field, type, val, ph, extra) => '<div class="mb-2"><label class="form-label small text-secondary">' + esc(label) + '</label><input class="form-control form-control-sm" type="' + type + '" ' + (extra || '') + ' value="' + esc(val) + '" placeholder="' + esc(ph || '') + '" data-change="test-field" data-field="' + field + '" data-id="' + id + '"></div>';
  let h = '<button class="btn btn-sm btn-outline-dark mb-3" data-act="back">' + esc(t('back')) + '</button><div id="syncBanner"></div>' +
    '<h2 class="h4 fw-bold mb-3">' + esc(tt.name) + '</h2>' +
    '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">' + esc(t('testDetails')) + '</h3>' +
      field(t('testNamePh'), 'name', 'text', tt.name) + field(t('testDateLabel'), 'date', 'date', tt.date) +
      field(t('testMaxLabel'), 'max', 'text', tt.max == null ? '' : fmtNum(tt.max), '20', 'inputmode="decimal"') +
      '<div class="d-flex flex-wrap gap-2">' + btnPill(!classById(tt.classId), 'set-test-class', 'data-id="' + id + '" data-class=""', esc(t('allClasses'))) +
        classes().map(c => btnPill(tt.classId === c.id, 'set-test-class', 'data-id="' + id + '" data-class="' + esc(c.id) + '"', esc(c.name))).join('') + '</div></div>' +
    '<h3 class="h6 fw-semibold">' + esc(t('scoresSection')) + '</h3><div id="testSummary">' + testSummaryHTML(tt) + '</div>';
  if (!ms.length) h += '<div class="text-center text-secondary small py-4">' + esc(t('emptyList')) + '</div>';
  else {
    h += '<ul class="list-group list-group-flush border-top mb-3">';
    ms.forEach((m, i) => {
      const v = tt.scores[m.id];
      h += '<li class="list-group-item d-flex align-items-center gap-2"><span class="seq">' + (i + 1) + '</span><span class="flex-grow-1 text-truncate">&#128100; ' + esc(m.name) + cake(m) + '</span>' +
        '<input class="form-control form-control-sm score-input" type="text" inputmode="decimal" placeholder="—" value="' + (typeof v === 'number' ? esc(fmtNum(v)) : '') + '" aria-label="' + esc(t('scoreLabel') + ': ' + m.name) + '" data-change="score" data-test="' + id + '" data-id="' + esc(m.id) + '">' +
        (tt.max ? '<span class="small text-secondary text-nowrap">/ ' + esc(fmtNum(tt.max)) + '</span>' : '') + '</li>';
    });
    h += '</ul>';
  }
  return h + '<button class="btn btn-sm btn-outline-danger" data-act="delete-test" data-id="' + id + '">' + esc(t('deleteTest')) + '</button>';
}
function viewMemberTests(m) {       // the tests section on a member's page
  const mine = state.tests.filter(tt => !classById(tt.classId) || tt.classId === m.classId).sort(byDateDesc);
  return '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">' + esc(t('testsSection')) + '</h3>' +
    (mine.length ? '<ul class="list-group list-group-flush border-top">' + mine.map(tt => {
      const v = tt.scores[m.id];
      return '<li class="list-group-item d-flex align-items-center gap-2 small"><span class="flex-grow-1 min-w-0"><span class="d-block fw-semibold text-truncate">' + esc(tt.name) + '</span><span class="d-block text-secondary">' + esc(fmtDay(tt.date)) + '</span></span>' +
        (typeof v === 'number' ? '<span class="badge rounded-pill flag-ok">' + esc(fmtNum(v) + (tt.max ? '/' + fmtNum(tt.max) : '')) + '</span>' : '<span class="badge rounded-pill text-bg-light border fw-normal">—</span>') + '</li>';
    }).join('') + '</ul>' : '<p class="small text-secondary mb-0">' + esc(t('noTests')) + '</p>') + '</div>';
}

function viewDetail() {
  const m = state.members.find(x => x.id === state.selectedMemberId);
  if (!m) { state.screen = 'main'; return viewMain(); }
  const weeks = buildWeeks(), dates = datesFor(membersIn(hasClass(m) ? m.classId : 'none').map(x => x.id), weeks);
  const s = statsFor(m, dates, weeks), rows = s.dates.slice().reverse();
  const flag = (on, label) => '<span class="badge rounded-pill ' + (on ? 'flag-ok' : 'flag-bad') + '">' + (on ? '&#10003; ' : '&#10007; ') + esc(label) + '</span>';
  const phone = (field, label) => '<p class="small text-secondary mb-1">' + esc(label) + '</p><div class="d-flex gap-2 align-items-center mb-2"><input class="form-control form-control-sm" type="tel" value="' + esc(m[field] || '') + '" placeholder="' + esc(t('noNumber')) + '" data-change="contact" data-field="' + field + '" data-id="' + esc(m.id) + '">' +
    (m[field] ? '<a class="btn btn-sm btn-outline-dark text-nowrap" href="tel:' + esc(m[field]) + '">' + esc(t('call')) + '</a>' : '') + '</div>';
  const info = (field, label, type, ph) => '<p class="small text-secondary mb-1">' + esc(label) + '</p><input class="form-control form-control-sm mb-2" type="' + type + '" value="' + esc(m[field] || '') + '" placeholder="' + esc(ph || '') + '" data-change="contact" data-field="' + field + '" data-id="' + esc(m.id) + '">';
  return '<button class="btn btn-sm btn-outline-dark mb-3" data-act="back">' + esc(t('back')) + '</button><div id="syncBanner"></div>' +
    '<h2 class="h4 fw-bold mb-3">' + esc(m.name) + cake(m) + '</h2>' +
    '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">' + esc(t('classSection')) + '</h3><div class="d-flex flex-wrap gap-2">' +
      btnPill(!hasClass(m), 'move-class', 'data-id="' + esc(m.id) + '" data-class=""', esc(t('noClass'))) + classes().map(c => btnPill(m.classId === c.id, 'move-class', 'data-id="' + esc(m.id) + '" data-class="' + esc(c.id) + '"', esc(c.name))).join('') + '</div></div>' +
    '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">' + esc(t('contactSection')) + '</h3>' + phone('phone', t('phoneLabel')) + phone('parentPhone', t('parentLabel')) + '</div>' +
    '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">' + esc(t('infoSection')) + '</h3>' +
      info('address', t('addressLabel'), 'text', t('addressLabel')) + info('confessor', t('confessorLabel'), 'text', t('confessorPh')) +
      '<p class="small text-secondary mb-1">' + esc(t('birthdayLabel')) + '</p><input class="form-control form-control-sm" type="date" value="' + esc(m.birthday || '') + '" max="' + todayISO() + '" data-change="contact" data-field="birthday" data-id="' + esc(m.id) + '">' +
      (m.birthday && parseBirthday(m.birthday) ? '<p class="small text-secondary mt-1 mb-0">' + esc(t('birthdayOn', fmtShort(m.birthday))) + (birthdayThisMonth(m) ? ' &#127874; ' + esc(t('birthdayMonth')) : '') + '</p>' : '') + '</div>' +
    '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">' + esc(t('historySection')) + '</h3>' +
      (s.total ? '<div class="d-flex flex-wrap gap-2 mb-2"><span class="badge rounded-pill text-bg-light border fw-normal">' + esc(t('mass')) + ' ' + s.mass + '/' + s.total + '</span><span class="badge rounded-pill text-bg-light border fw-normal">' + esc(t('meeting')) + ' ' + s.meeting + '/' + s.total + '</span><span class="badge rounded-pill text-bg-light border fw-normal">' + s.pct + '%</span></div>' +
        '<ul class="list-group list-group-flush border-top">' + rows.map(d => '<li class="list-group-item d-flex align-items-center gap-2 px-1 small"><span class="flex-grow-1">' + esc(fmtWeek(d)) + '</span>' + flag(attendedW(weeks, m.id, d, 'mass'), t('mass')) + flag(attendedW(weeks, m.id, d, 'meeting'), t('meeting')) + '</li>').join('') + '</ul>'
        : '<p class="small text-secondary mb-0">' + esc(t('noRecorded')) + '</p>') + '</div>' +
    viewMemberTests(m) +
    '<button class="btn btn-sm btn-outline-danger" data-act="delete-member" data-id="' + esc(m.id) + '">' + esc(t('deleteMember')) + '</button>';
}

function viewSettings() {
  const sec = (title, body, last) => '<div class="' + (last ? 'mb-3' : 'mb-3 pb-3 border-bottom') + '"><h3 class="h6 fw-semibold">' + esc(title) + '</h3>' + body + '</div>';
  const classOpts = (withNone, sel) => '<option value="">—</option>' + classes().map(c => '<option value="' + esc(c.id) + '"' + (sel === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') + (withNone ? '<option value="none"' + (sel === 'none' ? ' selected' : '') + '>' + esc(t('noClass')) + '</option>' : '');
  let h = '<button class="btn btn-sm btn-outline-dark mb-3" data-act="back">' + esc(t('back')) + '</button><div id="syncBanner"></div><h2 class="h4 fw-bold mb-3">' + esc(t('settings')) + '</h2>';
  h += sec(t('accountTitle'), '<p class="small text-secondary mb-1">' + esc(t('codeLabel')) + '</p><div class="d-flex flex-wrap align-items-center gap-2"><span class="badge border fw-normal code-badge">' + esc(state.teacherCode || '') + '</span>' + '<button class="btn btn-sm btn-outline-dark" data-act="copy-code">' + esc(t('copyCode')) + '</button></div>' +
    '<p id="syncStatusLine" class="small text-secondary mt-1 mb-0"></p><div class="d-flex flex-wrap gap-2 mt-2"><button class="btn btn-sm btn-outline-dark" data-act="sync-now">' + esc(t('syncNow')) + '</button><button class="btn btn-sm btn-outline-dark" data-act="logout">' + esc(t('logout')) + '</button></div>');
  h += sec(t('passwordTitle'), '<p class="small text-secondary">' + esc(t('passwordHint')) + '</p><div class="d-flex gap-2"><input id="newTeacherPw" class="form-control form-control-sm" type="password" placeholder="' + esc(t('password')) + '" data-enter="save-password"><button class="btn btn-sm btn-outline-dark text-nowrap" data-act="save-password">' + esc(t('save')) + '</button></div>');
  const dayOpts = cur => DAY_NAMES[lang()].map((n, i) => '<option value="' + i + '"' + (cur === i ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
  h += sec(t('daysTitle'), '<p class="small text-secondary">' + esc(t('daysHint')) + '</p><div class="d-flex gap-2"><div class="flex-fill"><label class="form-label small text-secondary">' + esc(t('massDayLabel')) + '</label><select class="form-select form-select-sm" data-change="set-day" data-which="mass">' + dayOpts(massDay()) + '</select></div><div class="flex-fill"><label class="form-label small text-secondary">' + esc(t('meetingDayLabel')) + '</label><select class="form-select form-select-sm" data-change="set-day" data-which="meeting">' + dayOpts(meetingDay()) + '</select></div></div>');
  h += sec(t('languageTitle'), '<div class="d-flex flex-wrap gap-2">' + langBtns() + '</div>');
  h += sec(t('fontTitle'), '<div class="d-flex flex-wrap gap-2">' + ['small', 'medium', 'large'].map(k => btnPill(state.settings.fontSize === k, 'font', 'data-size="' + k + '"', esc(t(k)))).join('') + '</div><label class="d-flex align-items-center gap-2 small mt-2"><input class="form-check-input mt-0" type="checkbox" ' + (state.settings.highContrast ? 'checked' : '') + ' data-change="contrast"> ' + esc(t('highContrast')) + '</label>');
  {
    h += sec(t('classesTitle'), '<p class="small text-secondary">' + esc(t('classesHint')) + '</p>' +
      (classes().length ? '<ul class="list-group list-group-flush mb-2">' + classes().map(c => '<li class="list-group-item d-flex gap-2 px-0"><input class="form-control form-control-sm" value="' + esc(c.name) + '" data-change="rename-class" data-id="' + esc(c.id) + '"><button class="btn btn-sm btn-outline-danger" data-act="delete-class" data-id="' + esc(c.id) + '" aria-label="' + esc(t('delete')) + '">&times;</button></li>').join('') + '</ul>' : '') +
      '<div class="d-flex gap-2"><input id="newClass" class="form-control form-control-sm" placeholder="' + esc(t('classNamePh')) + '" data-enter="add-class"><button class="btn btn-sm btn-dark text-nowrap" data-act="add-class">' + esc(t('addClass')) + '</button></div>');
    h += sec(t('bulkTitle'), '<p class="small text-secondary">' + esc(t('bulkHint')) + '</p><div class="d-flex gap-2 align-items-center"><select id="bulkFrom" class="form-select form-select-sm">' + classOpts(true, state.bulkFrom) + '</select><span>&#8594;</span><select id="bulkTo" class="form-select form-select-sm">' + classOpts(true, state.bulkTo) + '</select><button class="btn btn-sm btn-outline-dark text-nowrap" data-act="bulk-move">' + esc(t('bulkBtn')) + '</button></div>' + (state.statusMsg ? '<p class="small text-secondary mt-1 mb-0">' + esc(state.statusMsg) + '</p>' : ''));
  }
  h += sec(t('importTitle'), '<p class="small text-secondary">' + esc(t('importHint')) + '</p><input id="importFile" type="file" accept=".xlsx,.xls,.csv" class="d-none" data-change="import"><div class="d-flex flex-wrap gap-2"><button class="btn btn-sm btn-outline-dark" data-act="import-pick">' + esc(t('importBtn')) + '</button><button class="btn btn-sm btn-outline-dark" data-act="template">' + esc(t('templateBtn')) + '</button></div>' + (state.importStatus ? '<p class="small text-secondary mt-1 mb-0">' + esc(state.importStatus) + '</p>' : ''));
  h += sec(t('exportTitle'), '<div class="d-flex flex-wrap gap-2"><button class="btn btn-sm btn-outline-dark" data-act="export-summary">' + esc(t('exportSummary')) + '</button><button class="btn btn-sm btn-outline-dark" data-act="export-matrix">' + esc(t('exportMatrix')) + '</button><button class="btn btn-sm btn-outline-dark" data-act="export-tests">' + esc(t('exportTests')) + '</button><button class="btn btn-sm btn-outline-dark" data-act="print">' + esc(t('printBtn')) + '</button></div>');
  h += sec(t('deleteAllTitle'), '<p class="small text-secondary">' + esc(t('deleteAllHint')) + '</p><button class="btn btn-sm btn-outline-danger" data-act="delete-all">' + esc(t('deleteAllBtn')) + '</button>', true);
  return h;
}

function render() {
  const app = $('#app'), y = window.scrollY;
  if (!state.ready) { app.innerHTML = '<div class="text-center text-secondary py-5">' + esc(t('loading')) + '</div>'; return; }
  app.innerHTML = !state.teacherCode ? viewAuth() : state.screen === 'settings' ? viewSettings() : state.screen === 'detail' ? viewDetail() : state.screen === 'test' ? viewTest() : viewMain();
  refreshSyncUI(); window.scrollTo(0, y);
}
function renderList() { const el = $('#listArea'); if (el) el.innerHTML = viewList(); }

/* ================= events (one delegated listener per kind) ================= */
function setPrefs(patch) { state.settings = { ...state.settings, ...patch }; save('settings', state.settings); applyPrefs(); render(); }
const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
function act(name, el) {
  const d = el.dataset;
  switch (name) {
    case 'lang': return setPrefs({ lang: d.lang });
    case 'auth-mode': state.authMode = d.mode; state.authError = ''; return render();
    case 'create-code': return createCode(val('newPw'), val('newPw2'));
    case 'join-code': return joinCode(val('joinCode'), val('joinPw'));
    case 'logout': return logout();
    case 'settings': state.screen = 'settings'; state.statusMsg = ''; return render();
    case 'back': state.screen = 'main'; return render();
    case 'dismiss-welcome': state.welcomeMsg = ''; return render();
    case 'add-toggle':
      state.adding = !state.adding;
      if (state.adding && !classById(state.draft.classId)) state.draft.classId = classById(state.selectedClass) ? state.selectedClass : (classes()[0] || {}).id || null;
      if (state.adding && classById(state.selectedClass)) state.draft.classId = state.selectedClass;
      return render();
    case 'draft-class': state.draft.classId = d.id; return render();
    case 'add-submit': return addMember();
    case 'add-class-first': { const c = addClass(val('firstClass')); if (c) { state.selectedClass = 'all'; } return render(); }
    case 'add-class': addClass(val('newClass')); return render();
    case 'delete-class': return deleteClass(d.id);
    case 'bulk-move': state.bulkFrom = val('bulkFrom'); state.bulkTo = val('bulkTo'); return bulkMove(state.bulkFrom, state.bulkTo);
    case 'view': state.view = d.view; return render();
    case 'class': state.selectedClass = d.sel; return render();
    case 'sort': state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'; return render();
    case 'date-prev': state.selectedDate = addDays(state.selectedDate, -7); return render();
    case 'date-next': if (state.selectedDate < latestAnchor()) state.selectedDate = addDays(state.selectedDate, 7); return render();
    case 'date-today': state.selectedDate = latestAnchor(); return render();
    case 'toggle': return toggleAtt(d.id, d.kind);
    case 'open': state.selectedMemberId = d.id; state.screen = 'detail'; return render();
    case 'move-class': { const m = state.members.find(x => x.id === d.id); if (m) { m.classId = d.class || null; persist(); render(); } return; }
    case 'delete-member': return deleteMember(d.id);
    case 'font': return setPrefs({ fontSize: d.size });
    case 'copy-code': if (navigator.clipboard) navigator.clipboard.writeText(state.teacherCode).then(() => { state.syncStatus = t('codeCopied'); refreshSyncUI(); }); return;
    case 'sync-now': state.syncStatus = t('syncing'); refreshSyncUI(); return pushNow();
    case 'save-password': { const p = val('newTeacherPw').trim(); if (!p) return; state.config.teacherPassword = p; persist(); state.syncStatus = t('passwordSaved'); render(); return; }
    case 'import-pick': return $('#importFile').click();
    case 'template': return templateCSV();
    case 'export-summary': return exportSummary();
    case 'export-matrix': return exportMatrix();
    case 'print': return printReport();
    case 'add-test-toggle':
      state.addingTest = !state.addingTest;
      if (state.addingTest) { state.testDraft.date = todayISO(); state.testDraft.classId = classById(state.selectedClass) ? state.selectedClass : null; }
      return render();
    case 'tdraft-class': state.testDraft.classId = d.id || null; return render();
    case 'add-test-submit': return addTest();
    case 'open-test': state.selectedTestId = d.id; state.screen = 'test'; return render();
    case 'set-test-class': { const tt = testById(d.id); if (tt) { tt.classId = d.class || null; persist(); render(); } return; }
    case 'delete-test': return deleteTest(d.id);
    case 'export-tests': return exportTests();
    case 'delete-all': return deleteAll();
  }
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (el.tagName === 'A') e.preventDefault();
  act(el.dataset.act, el);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const el = e.target.closest('[data-enter]'); if (el) { e.preventDefault(); act(el.dataset.enter, el); }
});
document.addEventListener('input', e => {
  const el = e.target, d = el.dataset;
  if (d.input === 'search') { state.search = el.value; renderList(); }
  else if (d.draft === 'code') state.joinCodeDraft = el.value;
  else if (d.draft === 'name') state.draft.name = el.value;
  else if (d.draft === 'phone') state.draft.phone = el.value;
  else if (d.draft === 'parent') state.draft.parent = el.value;
  else if (d.draft === 'tname') state.testDraft.name = el.value;
  else if (d.draft === 'tdate') state.testDraft.date = el.value;
  else if (d.draft === 'tmax') state.testDraft.max = el.value;
});
document.addEventListener('change', e => {
  const el = e.target, d = el.dataset;
  switch (d.change) {
    case 'date-pick': if (el.value) { state.selectedDate = weekOf(el.value); normalizeSelected(); render(); } break;
    case 'set-day': state.config[d.which === 'mass' ? 'massDay' : 'meetingDay'] = +el.value; normalizeSelected(); persist(); render(); break;
    case 'contact': { const m = state.members.find(x => x.id === d.id); if (m) { m[d.field] = d.field === 'birthday' ? parseBirthday(el.value) : el.value.trim(); persist(); render(); } break; }
    case 'rename-class': renameClass(d.id, el.value); break;
    case 'contrast': setPrefs({ highContrast: el.checked }); break;
    case 'score': setScore(d.test, d.id, el); break;
    case 'test-field': {
      const tt = testById(d.id); if (!tt) break;
      if (d.field === 'name') { const v = el.value.trim(); if (v) tt.name = v; }
      else if (d.field === 'date') { if (el.value) tt.date = el.value; }
      else if (d.field === 'max') { const n = parseScore(el.value); if (n === null) tt.max = null; else if (n > 0) tt.max = n; }
      persist(); render(); break;
    }
    case 'import': importFile(el); break;
  }
});

init();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
