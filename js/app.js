import {
  db, auth, authReady, doc, getDoc, setDoc, runTransaction,
  collection, query, where, onSnapshot, serverTimestamp
} from "./firebase-init.js";

/* ---------------- constants ---------------- */
const SLOT_TIMES = ["08:15–10:00", "10:15–12:00", "13:15–15:00", "15:15–17:00"];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const FIRST_MONDAY = "2026-09-21";
const LAST_MONDAY = "2026-10-26";
const BALANCE_THRESHOLD = 7;
const MIN_FOR_OBSERVATION = 3;
const MAX_OBSERVERS = 3;

/* ---------------- date helpers ---------------- */
function toDate(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function toStr(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function addDays(dateStr, n) { const d = toDate(dateStr); d.setDate(d.getDate() + n); return toStr(d); }
function mondayOf(dateStr) { const d = toDate(dateStr); const dow = (d.getDay() + 6) % 7; return addDays(dateStr, -dow); }
function isoWeek(dateStr) {
  const d = toDate(dateStr);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}
function fmtDay(dateStr) { const d = toDate(dateStr); return `${d.getDate()}/${d.getMonth() + 1}`; }

/* ---------------- slug ---------------- */
const DIACRITIC_MAP = { å: "a", ä: "a", ö: "o", é: "e", è: "e", ü: "u", ï: "i", ø: "o", ñ: "n", ß: "ss" };
function slugify(name) {
  let s = name.trim().toLowerCase();
  s = s.replace(/[åäöéèüïøñß]/g, ch => DIACRITIC_MAP[ch] || ch);
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s;
}
function keyOf(entry) { return `${entry.course}_${entry.date}_${entry.slot}`; }
function emptySession(key) {
  const [course, date, slot] = key.split("_");
  return { course, date, slot: Number(slot), weekStart: mondayOf(date), curious: null, interviewer: null, curiousObservers: [], interviewerObservers: [] };
}

/* ---------------- global state ---------------- */
let COURSES = [];
let SCHEDULE = [];
let scheduleByDateSlot = new Map(); // "date_slot" -> [{course,type}]
let selectedCourses = new Set();

let myUid = null;
let currentName = "";
let currentSlug = "";
let nameConfirmed = false;

let origState = { active: null, observations: [], createdAt: null };
let draftActive = null;
let draftObservations = [];
let activeLocked = false;
let activeLockObservers = [];

let activeTab = 1;
let weekState = { 1: FIRST_MONDAY, 2: FIRST_MONDAY, 3: FIRST_MONDAY, 4: FIRST_MONDAY };
let weekSessionsByTab = { 1: new Map(), 2: new Map(), 3: new Map(), 4: new Map() };
let unsubByTab = { 1: null, 2: null, 3: null, 4: null };
let counters = { curiousCount: 0, interviewerCount: 0 };

/* ---------------- boot ---------------- */
async function boot() {
  const [c, s] = await Promise.all([
    fetch("data/courses.json").then(r => r.json()),
    fetch("data/schedule.json").then(r => r.json())
  ]);
  COURSES = c.sort((a, b) => a.code.localeCompare(b.code));
  SCHEDULE = s;
  scheduleByDateSlot = new Map();
  for (const e of SCHEDULE) {
    const k = `${e.date}_${e.slot}`;
    if (!scheduleByDateSlot.has(k)) scheduleByDateSlot.set(k, []);
    scheduleByDateSlot.get(k).push(e);
  }

  renderCourseLists();
  wireHeader();
  wireTabs();
  wireApprove();

  authReady.then(u => { myUid = u.uid; });

  onSnapshot(doc(db, "meta", "counters"), snap => {
    counters = snap.exists() ? snap.data() : { curiousCount: 0, interviewerCount: 0 };
    if (activeTab === 1) renderTab(1);
  });
}
document.addEventListener("DOMContentLoaded", boot);

/* ---------------- course lists ---------------- */
function renderCourseLists() {
  const search = document.getElementById("courseSearch").value.trim().toLowerCase();
  const left = document.getElementById("courseListLeft");
  const right = document.getElementById("courseListRight");
  left.innerHTML = "";
  right.innerHTML = "";

  const filtered = COURSES.filter(c =>
    !search || c.code.toLowerCase().includes(search) || c.name.toLowerCase().includes(search)
  );

  for (const c of filtered) {
    left.appendChild(courseRow(c, () => toggleCourse(c.code)));
  }
  for (const code of [...selectedCourses].sort()) {
    const c = COURSES.find(x => x.code === code);
    if (c) right.appendChild(courseRow(c, () => toggleCourse(c.code)));
  }

  const allSelected = COURSES.length > 0 && COURSES.every(c => selectedCourses.has(c.code));
  document.getElementById("selectAllBtn").textContent = allSelected ? "Unselect all" : "Select all";
}
function courseRow(c, onToggle) {
  const li = document.createElement("li");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = selectedCourses.has(c.code);
  cb.addEventListener("change", onToggle);
  const label = document.createElement("span");
  label.innerHTML = `<span class="course-code">${c.code}</span> — ${c.name}`;
  li.appendChild(cb);
  li.appendChild(label);
  return li;
}
function toggleCourse(code) {
  if (selectedCourses.has(code)) selectedCourses.delete(code); else selectedCourses.add(code);
  renderCourseLists();
  if (nameConfirmed) renderTab(activeTab);
}
function wireCoursePicker() {
  document.getElementById("courseSearch").addEventListener("input", renderCourseLists);
  document.getElementById("selectAllBtn").addEventListener("click", () => {
    const allSelected = COURSES.length > 0 && COURSES.every(c => selectedCourses.has(c.code));
    selectedCourses = allSelected ? new Set() : new Set(COURSES.map(c => c.code));
    renderCourseLists();
    if (nameConfirmed) renderTab(activeTab);
  });
}
wireCoursePicker();

/* ---------------- header / name flow ---------------- */
function wireHeader() {
  const input = document.getElementById("nameInput");
  const privacyBtn = document.getElementById("privacyBtn");
  const privacyModal = document.getElementById("privacyModal");
  document.getElementById("privacyCloseBtn").addEventListener("click", () => privacyModal.classList.add("hidden"));
  privacyBtn.addEventListener("click", () => privacyModal.classList.remove("hidden"));

  let debounceTimer = null;
  input.addEventListener("input", () => {
    nameConfirmed = false;
    document.getElementById("mainApp").classList.add("hidden");
    hideBanners();
    clearTimeout(debounceTimer);
    const val = input.value;
    debounceTimer = setTimeout(() => handleNameStabilized(val), 700);
  });
}
function hideBanners() {
  document.getElementById("duplicateBanner").classList.add("hidden");
  document.getElementById("confirmBanner").classList.add("hidden");
}
async function handleNameStabilized(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  await authReady;
  const slug = slugify(trimmed);
  if (!slug) return;
  const snap = await getDoc(doc(db, "students", slug));
  currentName = trimmed;
  currentSlug = slug;
  if (snap.exists()) {
    showDuplicateBanner(snap.data());
  } else {
    hideBanners();
    confirmFreshStart();
  }
}
function roleSummaryText(data) {
  const parts = [];
  if (data.active) parts.push(`the ${data.active.role === "curious" ? "Curious Student" : "Interviewer"} role in course ${data.active.course}`);
  if (data.observations && data.observations.length) {
    const courses = [...new Set(data.observations.map(o => o.course))];
    parts.push(`observer in course${courses.length > 1 ? "s" : ""} ${courses.join(", ")}`);
  }
  return parts.length ? parts.join(", and as ") : "no roles recorded yet";
}
function showDuplicateBanner(existingData) {
  const banner = document.getElementById("duplicateBanner");
  banner.classList.remove("hidden");
  banner.innerHTML = `
    <p>The name "${existingData.name}" has already been used — registered for ${roleSummaryText(existingData)}.</p>
    <p>If you recognize this as you, please proceed. Otherwise, cancel and choose a different name.</p>
    <button id="dupProceedBtn" type="button">Proceed — this is me</button>
    <button id="dupCancelBtn" type="button">Cancel</button>
  `;
  document.getElementById("dupProceedBtn").addEventListener("click", () => showConfirmBanner(existingData));
  document.getElementById("dupCancelBtn").addEventListener("click", cancelToNameInput);
}
function showConfirmBanner(existingData) {
  document.getElementById("duplicateBanner").classList.add("hidden");
  const banner = document.getElementById("confirmBanner");
  banner.classList.remove("hidden");
  banner.innerHTML = `
    <p>Are you really sure this is you?</p>
    <button id="confYesBtn" type="button">Yes, this is me</button>
    <button id="confNoBtn" type="button">Cancel</button>
  `;
  document.getElementById("confYesBtn").addEventListener("click", () => confirmReturning(existingData));
  document.getElementById("confNoBtn").addEventListener("click", cancelToNameInput);
}
function cancelToNameInput() {
  hideBanners();
  nameConfirmed = false;
  const input = document.getElementById("nameInput");
  input.focus();
  input.select();
}
async function confirmFreshStart() {
  nameConfirmed = true;
  origState = { active: null, observations: [], createdAt: null };
  draftActive = null;
  draftObservations = [];
  document.getElementById("mainApp").classList.remove("hidden");
  document.getElementById("lockedNotice").classList.add("hidden");
  activeLocked = false;
  renderSummary();
  renderTab(activeTab);
}
async function confirmReturning(existingData) {
  hideBanners();
  nameConfirmed = true;
  currentName = existingData.name;
  origState = {
    active: existingData.active || null,
    observations: existingData.observations || [],
    createdAt: existingData.createdAt || null
  };
  draftActive = origState.active;
  draftObservations = [...origState.observations];
  selectedCourses = new Set([
    ...(origState.active ? [origState.active.course] : []),
    ...origState.observations.map(o => o.course)
  ]);
  renderCourseLists();
  await refreshActiveLock();
  document.getElementById("mainApp").classList.remove("hidden");
  renderSummary();
  renderTab(activeTab);
}
async function refreshActiveLock() {
  activeLocked = false;
  activeLockObservers = [];
  const notice = document.getElementById("lockedNotice");
  notice.classList.add("hidden");
  if (!origState.active) return;
  const snap = await getDoc(doc(db, "sessions", keyOf(origState.active)));
  if (!snap.exists()) return;
  const data = snap.data();
  const observers = origState.active.role === "curious" ? data.curiousObservers : data.interviewerObservers;
  if (observers && observers.length > 0) {
    activeLocked = true;
    activeLockObservers = observers.map(o => o.name);
    notice.classList.remove("hidden");
    notice.innerHTML = `You already have observers assigned to your current active-role session (${origState.active.course}): <strong>${activeLockObservers.join(", ")}</strong>. If you want to change your active role, you need to speak with them first so they can unselect — this cannot be changed here.`;
  }
}

/* ---------------- tabs ---------------- */
function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(Number(btn.dataset.tab)));
  });
  document.querySelectorAll('input[name="tab1role"]').forEach(r => r.addEventListener("change", () => renderTab(1)));
  document.querySelectorAll('input[name="tab4role"]').forEach(r => r.addEventListener("change", () => renderTab(4)));
}
function switchTab(n) {
  activeTab = n;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", Number(b.dataset.tab) === n));
  document.querySelectorAll(".tab-content").forEach(el => el.classList.toggle("hidden", el.id !== `tab${n}`));
  renderTab(n);
}

function ensureWeekListener(tabNum) {
  if (unsubByTab[tabNum]) unsubByTab[tabNum]();
  const monday = weekState[tabNum];
  const q = query(collection(db, "sessions"), where("weekStart", "==", monday));
  unsubByTab[tabNum] = onSnapshot(q, snap => {
    const m = new Map();
    snap.forEach(d => m.set(d.id, d.data()));
    weekSessionsByTab[tabNum] = m;
    if (activeTab === tabNum) renderTab(tabNum);
  });
}

function getSession(tabNum, key) {
  return weekSessionsByTab[tabNum].get(key) || emptySession(key);
}

function renderTab(tabNum) {
  if (!nameConfirmed) return;
  ensureWeekListener(tabNum);
  if (tabNum === 1) renderTab1();
  else if (tabNum === 2) renderTab2or3(2, "curious");
  else if (tabNum === 3) renderTab2or3(3, "interviewer");
  else if (tabNum === 4) renderTab4();
  renderCalendarShell(tabNum);
}

/* ---------------- tab-specific notices ---------------- */
function renderTab1() {
  const notice = document.getElementById("tab1Balance");
  const curiousRadio = document.querySelector('input[name="tab1role"][value="curious"]');
  const interviewerRadio = document.querySelector('input[name="tab1role"][value="interviewer"]');
  curiousRadio.disabled = false;
  interviewerRadio.disabled = false;
  notice.classList.add("hidden");
  const diff = counters.curiousCount - counters.interviewerCount;
  if (diff > BALANCE_THRESHOLD) {
    curiousRadio.disabled = true;
    if (curiousRadio.checked) { curiousRadio.checked = false; interviewerRadio.checked = true; }
    notice.textContent = "There is currently a strong imbalance toward Curious Student in the class. You may only select Interviewer for now — or wait a little and check back once the balance improves.";
    notice.className = "notice info";
    notice.classList.remove("hidden");
  } else if (-diff > BALANCE_THRESHOLD) {
    interviewerRadio.disabled = true;
    if (interviewerRadio.checked) { interviewerRadio.checked = false; curiousRadio.checked = true; }
    notice.textContent = "There is currently a strong imbalance toward Interviewer in the class. You may only select Curious Student for now — or wait a little and check back once the balance improves.";
    notice.className = "notice info";
    notice.classList.remove("hidden");
  }
}
function renderTab2or3(tabNum, targetRole) {
  const notice = document.getElementById(`tab${tabNum}Notice`);
  const count = targetRole === "curious" ? counters.curiousCount : counters.interviewerCount;
  if (count < MIN_FOR_OBSERVATION) {
    notice.className = "notice error";
    notice.textContent = `There are not many ${targetRole === "curious" ? "curious students" : "interviewers"} registered yet — let a few more people sign up and check back later.`;
    notice.classList.remove("hidden");
  } else {
    notice.classList.add("hidden");
  }
}
function renderTab4() {
  const role = document.querySelector('input[name="tab4role"]:checked').value;
  renderTab2or3(4, role);
}

/* ---------------- box computation ---------------- */
function layoutDims(count) {
  if (count <= 0) return { rows: 0, cols: 1 };
  if (count <= 2) return { rows: 2, cols: 1 };
  return { rows: Math.ceil(count / 2), cols: 2 };
}
function computeBoxesForDate(tabNum, date, slot) {
  const entries = (scheduleByDateSlot.get(`${date}_${slot}`) || []).filter(e => selectedCourses.has(e.course));
  const boxes = [];
  for (const e of entries) {
    const key = `${e.course}_${date}_${slot}`;
    const session = getSession(tabNum, key);
    if (tabNum === 1) {
      const role = document.querySelector('input[name="tab1role"]:checked').value;
      const oppositeRole = role === "curious" ? "interviewer" : "curious";
      const mineOccupant = session[role] && session[role].uid === myUid;
      const occupiedBySame = session[role] && !mineOccupant;
      const occupiedByOpposite = !!session[oppositeRole];
      let tier, clickable;
      if (occupiedBySame) { tier = "tier-red"; clickable = false; }
      else if (occupiedByOpposite) { tier = "tier-green-orange"; clickable = true; }
      else { tier = "tier-green"; clickable = true; }
      boxes.push({
        course: e.course, type: e.type, tier, clickable,
        selected: !!(draftActive && keyOf(draftActive) === key && draftActive.role === role),
        badge: null,
        onClick: clickable ? () => onTab1Click(e.course, date, slot, role) : null
      });
    } else {
      const targetRole = tabNum === 2 ? "curious" : tabNum === 3 ? "interviewer" : document.querySelector('input[name="tab4role"]:checked').value;
      const occupant = session[targetRole];
      if (!occupant) continue;
      const observers = session[targetRole + "Observers"] || [];
      const count = observers.length;
      const alreadyMine = draftObservations.some(o => keyOf(o) === key && o.targetRole === targetRole);
      let tier, clickable;
      if (count >= MAX_OBSERVERS) { tier = "tier-red"; clickable = false; }
      else if (count === 2) { tier = "tier-orange-red"; clickable = true; }
      else if (count === 1) { tier = "tier-green-orange"; clickable = true; }
      else { tier = "tier-green"; clickable = true; }
      boxes.push({
        course: e.course, type: e.type, tier, clickable,
        selected: alreadyMine,
        badge: count >= MAX_OBSERVERS ? `≥${MAX_OBSERVERS}` : String(count),
        onClick: clickable ? () => onObserverClick(tabNum, e.course, date, slot, targetRole, occupant, count) : null
      });
    }
  }
  return boxes;
}
function renderBox(b, fsClass) {
  const div = document.createElement("div");
  div.className = `box ${b.tier} ${fsClass}` + (b.clickable ? " clickable" : "") + (b.selected ? " selected" : "");
  div.innerHTML = `<span class="code">${b.course}</span><span class="type">${b.type}</span>` + (b.badge != null ? `<span class="badge">${b.badge}</span>` : "");
  if (b.clickable && b.onClick) div.addEventListener("click", b.onClick);
  return div;
}

/* ---------------- calendar shell ---------------- */
function renderCalendarShell(tabNum) {
  const container = document.querySelector(`.calendar[data-tab="${tabNum}"]`);
  container.innerHTML = "";
  const monday = weekState[tabNum];

  const nav = document.createElement("div");
  nav.className = "week-nav";
  const prevBtn = document.createElement("button"); prevBtn.type = "button"; prevBtn.textContent = "← Previous week";
  const nextBtn = document.createElement("button"); nextBtn.type = "button"; nextBtn.textContent = "Next week →";
  const wn = document.createElement("span"); wn.className = "week-num"; wn.textContent = `Week ${isoWeek(monday)}`;
  prevBtn.disabled = monday <= FIRST_MONDAY;
  nextBtn.disabled = monday >= LAST_MONDAY;
  prevBtn.addEventListener("click", () => { weekState[tabNum] = addDays(weekState[tabNum], -7); ensureWeekListener(tabNum); renderCalendarShell(tabNum); });
  nextBtn.addEventListener("click", () => { weekState[tabNum] = addDays(weekState[tabNum], 7); ensureWeekListener(tabNum); renderCalendarShell(tabNum); });
  nav.append(prevBtn, wn, nextBtn);
  container.appendChild(nav);

  const grid = document.createElement("div");
  grid.className = "cal-grid";
  grid.appendChild(document.createElement("div"));
  for (let i = 0; i < 5; i++) {
    const dateStr = addDays(monday, i);
    const head = document.createElement("div");
    head.className = "cal-head";
    head.textContent = `${DAY_NAMES[i]} ${fmtDay(dateStr)}`;
    grid.appendChild(head);
  }
  for (let slot = 0; slot < 4; slot++) {
    const timeCell = document.createElement("div");
    timeCell.className = "cal-time";
    timeCell.textContent = SLOT_TIMES[slot];
    grid.appendChild(timeCell);
    for (let i = 0; i < 5; i++) {
      const dateStr = addDays(monday, i);
      const cell = document.createElement("div");
      cell.className = "cal-cell";
      const boxes = computeBoxesForDate(tabNum, dateStr, slot);
      const dims = layoutDims(boxes.length);
      cell.style.gridTemplateColumns = `repeat(${dims.cols || 1}, 1fr)`;
      cell.style.gridTemplateRows = `repeat(${dims.rows || 1}, 1fr)`;
      const fsClass = dims.rows >= 3 ? "fs-small" : "fs-normal";
      boxes.forEach(b => cell.appendChild(renderBox(b, fsClass)));
      grid.appendChild(cell);
    }
  }
  container.appendChild(grid);
}

/* ---------------- box click handlers ---------------- */
function onTab1Click(course, date, slot, role) {
  if (activeLocked) { showActiveLockedDialog(); return; }
  const key = `${course}_${date}_${slot}`;
  if (draftActive && keyOf(draftActive) === key && draftActive.role === role) return;
  draftActive = { course, date, slot, role };
  renderTab(1);
  renderSummary();
}
function showActiveLockedDialog() {
  showConfirmDialog({ text: document.getElementById("lockedNotice").innerHTML, buttons: [{ label: "OK", action: () => {} }] });
}
function onObserverClick(tabNum, course, date, slot, targetRole, occupant, count) {
  if (occupant.uid === myUid) { toast("You cannot observe yourself."); return; }
  const key = `${course}_${date}_${slot}`;
  const idx = draftObservations.findIndex(o => keyOf(o) === key && o.targetRole === targetRole);
  if (idx >= 0) {
    draftObservations.splice(idx, 1);
    renderTab(tabNum);
    renderSummary();
    return;
  }
  if (count === 2) {
    showConfirmDialog({
      text: `This ${targetRole === "curious" ? "curious student" : "interviewer"} already has two observers. We encourage you to observe someone else instead.`,
      buttons: [
        { label: "I understand", action: () => {} },
        { label: "I don't have other options — select anyway", action: () => {
          draftObservations.push({ course, date, slot, targetRole, targetName: occupant.name });
          renderTab(tabNum);
          renderSummary();
        } }
      ]
    });
    return;
  }
  draftObservations.push({ course, date, slot, targetRole, targetName: occupant.name });
  renderTab(tabNum);
  renderSummary();
}

/* ---------------- summary ---------------- */
function fmtEntry(course, date, slot) {
  const c = COURSES.find(x => x.code === course);
  const dow = DAY_NAMES[(toDate(date).getDay() + 6) % 7];
  return `${course} — ${c ? c.name : ""} · ${dow} ${fmtDay(date)} · ${SLOT_TIMES[slot]}`;
}
function renderSummary() {
  const activeEl = document.getElementById("summaryActive");
  const obsEl = document.getElementById("summaryObservations");
  activeEl.innerHTML = "<strong>Active role</strong><br>" + (draftActive
    ? `<div class="entry">${draftActive.role === "curious" ? "Curious Student" : "Interviewer"} — ${fmtEntry(draftActive.course, draftActive.date, draftActive.slot)}</div>`
    : `<div class="entry">No active-role session selected yet.</div>`);
  obsEl.innerHTML = "<strong>Observations</strong><br>" + (draftObservations.length
    ? draftObservations.map(o => `<div class="entry">Observing ${o.targetName} (${o.targetRole === "curious" ? "Curious Student" : "Interviewer"}) — ${fmtEntry(o.course, o.date, o.slot)}</div>`).join("")
    : `<div class="entry">No observations selected yet.</div>`);
}

/* ---------------- dialog / toast ---------------- */
function showConfirmDialog({ text, buttons }) {
  const overlay = document.getElementById("dialogOverlay");
  const box = document.getElementById("dialogBox");
  box.innerHTML = `<p>${text}</p>`;
  buttons.forEach(b => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = b.label;
    btn.addEventListener("click", () => { overlay.classList.add("hidden"); b.action(); });
    box.appendChild(btn);
  });
  overlay.classList.remove("hidden");
}
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

/* ---------------- approve ---------------- */
function wireApprove() {
  document.getElementById("approveBtn").addEventListener("click", onApprove);
}
async function onApprove() {
  if (!nameConfirmed) { toast("Please enter and confirm your name first."); return; }
  try {
    await approveSelections();
    showApprovalConfirmation();
  } catch (err) {
    if (err.message === "CONFLICT_ACTIVE") toast("Someone just took that active-role slot — please pick another.");
    else if (err.message === "CONFLICT_OBSERVER") toast("That session just reached its observer limit — please pick another.");
    else { console.error(err); toast("Something went wrong saving your selections. Please try again."); }
  }
}
async function approveSelections() {
  const slug = currentSlug;
  const nameSnapshot = currentName;
  await runTransaction(db, async (tx) => {
    const touchedKeys = new Set();
    if (origState.active) touchedKeys.add(keyOf(origState.active));
    if (draftActive) touchedKeys.add(keyOf(draftActive));
    origState.observations.forEach(o => touchedKeys.add(keyOf(o)));
    draftObservations.forEach(o => touchedKeys.add(keyOf(o)));

    const sessionRefs = {}; const sessionData = {};
    for (const k of touchedKeys) {
      const ref = doc(db, "sessions", k);
      sessionRefs[k] = ref;
      const snap = await tx.get(ref);
      sessionData[k] = snap.exists() ? snap.data() : emptySession(k);
    }
    const counterRef = doc(db, "meta", "counters");
    const counterSnap = await tx.get(counterRef);
    const cnt = counterSnap.exists() ? counterSnap.data() : { curiousCount: 0, interviewerCount: 0 };

    if (origState.active) {
      const k = keyOf(origState.active);
      const s = sessionData[k];
      if (s[origState.active.role] && s[origState.active.role].uid === myUid) s[origState.active.role] = null;
    }
    if (draftActive) {
      const k = keyOf(draftActive);
      const s = sessionData[k];
      if (s[draftActive.role] && s[draftActive.role].uid !== myUid) throw new Error("CONFLICT_ACTIVE");
      s[draftActive.role] = { name: nameSnapshot, uid: myUid };
    }
    const origRole = origState.active ? origState.active.role : null;
    const draftRole = draftActive ? draftActive.role : null;
    if (origRole !== draftRole) {
      if (origRole) cnt[origRole + "Count"] = Math.max(0, (cnt[origRole + "Count"] || 0) - 1);
      if (draftRole) cnt[draftRole + "Count"] = (cnt[draftRole + "Count"] || 0) + 1;
    }

    for (const o of origState.observations) {
      const stillThere = draftObservations.some(d => keyOf(d) === keyOf(o) && d.targetRole === o.targetRole);
      if (!stillThere) {
        const k = keyOf(o); const s = sessionData[k];
        const arr = s[o.targetRole + "Observers"] || [];
        s[o.targetRole + "Observers"] = arr.filter(x => x.uid !== myUid);
      }
    }
    for (const o of draftObservations) {
      const wasThere = origState.observations.some(x => keyOf(x) === keyOf(o) && x.targetRole === o.targetRole);
      if (!wasThere) {
        const k = keyOf(o); const s = sessionData[k];
        const arr = s[o.targetRole + "Observers"] || [];
        if (!arr.some(x => x.uid === myUid)) {
          if (arr.length >= MAX_OBSERVERS) throw new Error("CONFLICT_OBSERVER");
          s[o.targetRole + "Observers"] = [...arr, { name: nameSnapshot, uid: myUid }];
        }
      }
    }

    for (const k of touchedKeys) tx.set(sessionRefs[k], sessionData[k]);
    tx.set(counterRef, cnt);
    tx.set(doc(db, "students", slug), {
      name: nameSnapshot, nameLower: nameSnapshot.toLowerCase(), ownerUid: myUid,
      active: draftActive, observations: draftObservations,
      createdAt: origState.createdAt || serverTimestamp(), updatedAt: serverTimestamp()
    });
  });

  origState = { active: draftActive, observations: [...draftObservations], createdAt: origState.createdAt || new Date() };
  await refreshActiveLock();
}

/* ---------------- confirmation banner (copy / email / ics) ---------------- */
function buildSummaryText() {
  const lines = [`VågaFråga registration for ${currentName}`, ""];
  lines.push("Active role:");
  lines.push(draftActive ? `  ${draftActive.role === "curious" ? "Curious Student" : "Interviewer"} — ${fmtEntry(draftActive.course, draftActive.date, draftActive.slot)}` : "  (none)");
  lines.push("");
  lines.push("Observations:");
  if (draftObservations.length) draftObservations.forEach(o => lines.push(`  Observing ${o.targetName} (${o.targetRole === "curious" ? "Curious Student" : "Interviewer"}) — ${fmtEntry(o.course, o.date, o.slot)}`));
  else lines.push("  (none)");
  return lines.join("\n");
}
function buildIcs() {
  const events = [];
  if (draftActive) events.push(draftActive);
  draftObservations.forEach(o => events.push(o));
  const pad = n => String(n).padStart(2, "0");
  const SLOT_START = ["08:15", "10:15", "13:15", "15:15"];
  const SLOT_END = ["10:00", "12:00", "15:00", "17:00"];
  const toIcsDate = (dateStr, timeStr) => {
    const [y, m, d] = dateStr.split("-");
    const [h, mi] = timeStr.split(":");
    return `${y}${m}${d}T${pad(h)}${pad(mi)}00`;
  };
  let ics = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//VagaFraga//EN\n";
  events.forEach((e, i) => {
    ics += "BEGIN:VEVENT\n";
    ics += `UID:vagafraga-${slugify(currentName)}-${i}@vagafraga\n`;
    ics += `DTSTART:${toIcsDate(e.date, SLOT_START[e.slot])}\n`;
    ics += `DTEND:${toIcsDate(e.date, SLOT_END[e.slot])}\n`;
    ics += `SUMMARY:${e.course} (${e.role ? (e.role === "curious" ? "Curious Student" : "Interviewer") : "Observing " + e.targetName})\n`;
    ics += "END:VEVENT\n";
  });
  ics += "END:VCALENDAR\n";
  return ics;
}
function showApprovalConfirmation() {
  const text = buildSummaryText();
  const overlay = document.getElementById("dialogOverlay");
  const box = document.getElementById("dialogBox");
  box.innerHTML = `
    <p>The information below was recorded about you. You may come back later and modify it if you use the same name. Please note the assignment details yourself — we do not collect email addresses here, so we are not able to send you reminders or notifications.</p>
    <div style="display:flex; gap:8px; margin:10px 0;">
      <button id="copyBtn" type="button">Copy</button>
      <button id="emailBtn" type="button">E-mail</button>
      <button id="icsBtn" type="button">Add to calendar</button>
    </div>
    <pre style="white-space:pre-wrap; background:#f5f5f5; padding:10px; border-radius:6px; font-size:12px;">${text}</pre>
    <button id="closeConfirmBtn" type="button">Close</button>
  `;
  overlay.classList.remove("hidden");
  document.getElementById("copyBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(text).then(() => toast("Copied to clipboard."));
  });
  document.getElementById("emailBtn").addEventListener("click", () => {
    window.location.href = `mailto:?subject=${encodeURIComponent("My VågaFråga registration")}&body=${encodeURIComponent(text)}`;
  });
  document.getElementById("icsBtn").addEventListener("click", () => {
    const blob = new Blob([buildIcs()], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "vagafraga.ics"; a.click();
    URL.revokeObjectURL(url);
  });
  document.getElementById("closeConfirmBtn").addEventListener("click", () => overlay.classList.add("hidden"));
}
