import {
  db, auth, authReady, doc, getDoc, getDocs, setDoc, runTransaction,
  collection, query, where, onSnapshot, serverTimestamp
} from "./firebase-init.js";

/* ---------------- constants ---------------- */
const SLOT_TIMES = ["08:15–10:00", "10:15–12:00", "13:15–15:00", "15:15–17:00"];
const SLOT_START = ["08:15", "10:15", "13:15", "15:15"];
const SLOT_END = ["10:00", "12:00", "15:00", "17:00"];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const FIRST_MONDAY = "2026-09-21";
const LAST_MONDAY = "2026-10-26";
// Deadline call-outs shown under the week selector, keyed by ISO week number.
const WEEK_NOTES = {
  42: { cls: "week-deadline", text: "HW2 submission deadline: 14th October, 21:00." },
  43: { cls: "week-postdeadline", text: "Post-deadline. Extension is ok if no free options were left in prior weeks." },
  44: { cls: "week-postdeadline", text: "Post-deadline. Extension is ok if no free options were left in prior weeks." },
};
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
let STATIC_COURSES = [];
let STATIC_SCHEDULE = [];
let customCourses = new Map();  // code -> {code,name,addedBy}
let customSchedule = new Map(); // "code_date_slot" -> {course,date,slot,type}
let COURSES = [];
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
let subscribedWeekByTab = { 1: null, 2: null, 3: null, 4: null };
let counters = { curiousCount: 0, interviewerCount: 0 };
// Counts scoped to the student's currently-ticked courses, refetched
// whenever the course selection changes — separate from the global
// `counters` above, which stay global for the tab-1 balance rule.
let courseScopedCounts = { curious: 0, interviewer: 0 };
let historyStack = []; // stack of {draftActive, draftObservations} snapshots, for Undo

/* ---------------- boot ---------------- */
// Course/schedule data is the static JSON plus whatever students have
// added via "Add another course" (stored in Firestore, live for everyone).
// Both sources feed the same merged COURSES / scheduleByDateSlot that the
// rest of the app reads, so a newly added course behaves identically to
// a built-in one everywhere (picker, search, calendar, box packing).
function rebuildMergedData() {
  const merged = [...STATIC_COURSES, ...customCourses.values()];
  COURSES = merged.sort((a, b) => a.code.localeCompare(b.code));
  scheduleByDateSlot = new Map();
  for (const e of [...STATIC_SCHEDULE, ...customSchedule.values()]) {
    const k = `${e.date}_${e.slot}`;
    if (!scheduleByDateSlot.has(k)) scheduleByDateSlot.set(k, []);
    scheduleByDateSlot.get(k).push(e);
  }
  renderCourseLists();
  if (nameConfirmed) renderTab(activeTab);
}

async function boot() {
  const [c, s] = await Promise.all([
    fetch("data/courses.json").then(r => r.json()),
    fetch("data/schedule.json").then(r => r.json())
  ]);
  STATIC_COURSES = c;
  STATIC_SCHEDULE = s;
  rebuildMergedData();

  wireHeader();
  wireTabs();
  wireApprove();
  wireAddCourse();
  wireUndo();
  wireExplainButtons();

  authReady.then(u => { myUid = u.uid; });

  onSnapshot(doc(db, "meta", "counters"), snap => {
    counters = snap.exists() ? snap.data() : { curiousCount: 0, interviewerCount: 0 };
    if (activeTab === 1) renderTab(1);
  });

  onSnapshot(collection(db, "customCourses"), snap => {
    customCourses = new Map();
    snap.forEach(d => customCourses.set(d.id, d.data()));
    rebuildMergedData();
  });
  onSnapshot(collection(db, "customSchedule"), snap => {
    customSchedule = new Map();
    snap.forEach(d => customSchedule.set(d.id, d.data()));
    rebuildMergedData();
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
function pruneDraftToSelectedCourses() {
  if (draftActive && !selectedCourses.has(draftActive.course)) draftActive = null;
  draftObservations = draftObservations.filter(o => selectedCourses.has(o.course));
}
function toggleCourse(code) {
  if (selectedCourses.has(code)) selectedCourses.delete(code); else selectedCourses.add(code);
  pruneDraftToSelectedCourses();
  renderCourseLists();
  refreshCourseScopedCounts();
  if (nameConfirmed) { renderTab(activeTab); renderSummary(); }
}
function wireCoursePicker() {
  document.getElementById("courseSearch").addEventListener("input", renderCourseLists);
  document.getElementById("selectAllBtn").addEventListener("click", () => {
    const allSelected = COURSES.length > 0 && COURSES.every(c => selectedCourses.has(c.code));
    selectedCourses = allSelected ? new Set() : new Set(COURSES.map(c => c.code));
    pruneDraftToSelectedCourses();
    renderCourseLists();
    refreshCourseScopedCounts();
    if (nameConfirmed) { renderTab(activeTab); renderSummary(); }
  });
}

// Live counts of curious/interviewer registrations, scoped to only the
// courses the student has ticked — used for the tab 2/3/4 "not enough
// people registered yet" notice, which should reflect what's relevant
// to this student rather than the whole class (that's what the global
// `counters` / tab-1 balance rule are for).
async function refreshCourseScopedCounts() {
  if (selectedCourses.size === 0) {
    courseScopedCounts = { curious: 0, interviewer: 0 };
  } else {
    try {
      const courses = [...selectedCourses].slice(0, 30); // Firestore 'in' query cap
      const snap = await getDocs(query(collection(db, "sessions"), where("course", "in", courses)));
      let curious = 0, interviewer = 0;
      snap.forEach(d => { const data = d.data(); if (data.curious) curious++; if (data.interviewer) interviewer++; });
      courseScopedCounts = { curious, interviewer };
    } catch (err) {
      console.error(err);
    }
  }
  if (nameConfirmed && [2, 3, 4].includes(activeTab)) renderTab(activeTab);
}
wireCoursePicker();

/* ---------------- add-course modal ---------------- */
let addCourseWeek = FIRST_MONDAY;
let pendingInstances = []; // {date, slot, type}

function wireAddCourse() {
  document.getElementById("addCourseBtn").addEventListener("click", openAddCourseModal);
  document.getElementById("addCourseCancelBtn").addEventListener("click", closeAddCourseModal);
  document.getElementById("addCourseSubmitBtn").addEventListener("click", submitAddCourse);
  document.getElementById("newCourseCode").addEventListener("input", syncAddCourseNameField);
}
// Matching is always by CODE, never by name — if the typed code matches
// a course that already exists, this is really "add a missing session."
// The name field just gets the real name suggested in, still editable,
// so it's clear what's about to happen without the field looking broken;
// whatever ends up typed there is ignored at submit time regardless.
function syncAddCourseNameField() {
  const code = document.getElementById("newCourseCode").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const nameInput = document.getElementById("newCourseName");
  const hint = document.getElementById("addCourseCodeHint");
  const existing = COURSES.find(c => c.code.toUpperCase() === code);
  if (existing) {
    nameInput.value = existing.name;
    hint.textContent = `"${code}" already exists as "${existing.name}" — you're adding a session to it, matched by code, so the name above is just a suggestion.`;
    hint.classList.remove("hidden");
  } else {
    hint.classList.add("hidden");
  }
}
function openAddCourseModal() {
  document.getElementById("newCourseCode").value = "";
  document.getElementById("newCourseName").value = "";
  document.getElementById("addCourseCodeHint").classList.add("hidden");
  pendingInstances = [];
  addCourseWeek = FIRST_MONDAY;
  document.getElementById("addCourseModal").classList.remove("hidden");
  renderAddCourseCalendar();
}
function closeAddCourseModal() {
  document.getElementById("addCourseModal").classList.add("hidden");
}
function renderAddCourseCalendar() {
  const container = document.getElementById("addCourseCalendar");
  container.innerHTML = "";
  const monday = addCourseWeek;

  const nav = document.createElement("div");
  nav.className = "week-nav";
  const prevBtn = document.createElement("button"); prevBtn.type = "button"; prevBtn.textContent = "← Previous week";
  const nextBtn = document.createElement("button"); nextBtn.type = "button"; nextBtn.textContent = "Next week →";
  const wn = document.createElement("span"); wn.className = "week-num"; wn.textContent = `Week ${isoWeek(monday)}`;
  prevBtn.disabled = monday <= FIRST_MONDAY;
  nextBtn.disabled = monday >= LAST_MONDAY;
  prevBtn.addEventListener("click", () => { addCourseWeek = addDays(addCourseWeek, -7); renderAddCourseCalendar(); });
  nextBtn.addEventListener("click", () => { addCourseWeek = addDays(addCourseWeek, 7); renderAddCourseCalendar(); });
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
      cell.style.gridTemplateColumns = "1fr";
      cell.style.gridTemplateRows = "1fr";
      const idx = pendingInstances.findIndex(p => p.date === dateStr && p.slot === slot);
      const box = document.createElement("div");
      if (idx >= 0) {
        const p = pendingInstances[idx];
        box.className = "box tier-green clickable selected";
        box.innerHTML = `<span class="code" style="font-size:11px">${p.type}</span><span class="type" style="font-size:10px">click to remove</span>`;
        box.addEventListener("click", () => { pendingInstances.splice(idx, 1); renderAddCourseCalendar(); });
      } else {
        box.className = "box add-slot-placeholder clickable";
        box.innerHTML = `<span class="type" style="font-size:11px">+ add</span>`;
        box.addEventListener("click", () => {
          const type = document.getElementById("newInstanceType").value;
          pendingInstances.push({ date: dateStr, slot, type });
          renderAddCourseCalendar();
        });
      }
      cell.appendChild(box);
      grid.appendChild(cell);
    }
  }
  container.appendChild(grid);
}
async function submitAddCourse() {
  const codeRaw = document.getElementById("newCourseCode").value.trim();
  const nameRaw = document.getElementById("newCourseName").value.trim();
  if (!codeRaw) { toast("Please fill in the course code."); return; }
  if (!pendingInstances.length) { toast("Click at least one calendar slot to mark the session(s) you're adding."); return; }
  const code = codeRaw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) { toast("Please enter a valid course code."); return; }
  const existing = COURSES.find(c => c.code.toUpperCase() === code);
  if (!existing && !nameRaw) { toast("Please fill in the course name."); return; }

  await authReady;
  try {
    if (!existing) {
      await setDoc(doc(db, "customCourses", code), { code, name: nameRaw, addedBy: currentName || "anonymous", createdAt: serverTimestamp() });
    }
    await Promise.all(pendingInstances.map(p =>
      setDoc(doc(db, "customSchedule", `${code}_${p.date}_${p.slot}`), { course: code, date: p.date, slot: p.slot, type: p.type })
    ));
    selectedCourses.add(code);
    refreshCourseScopedCounts();
    closeAddCourseModal();
    toast(existing
      ? "Session added — don't forget to go to the tabs below and select your own role for it."
      : "Course added — don't forget to go to the tabs below and select your own role for it.");
  } catch (err) {
    console.error(err);
    toast("Could not add the course. Please try again.");
  }
}

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
  document.getElementById("identityModal").classList.add("hidden");
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
  document.getElementById("identityModal").classList.remove("hidden");
  document.getElementById("confirmBanner").classList.add("hidden");
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
  historyStack = [];
  document.getElementById("mainApp").classList.remove("hidden");
  document.getElementById("lockedNotice").classList.add("hidden");
  activeLocked = false;
  renderSummary();
  renderTab(activeTab);
  updateUndoButtons();
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
  historyStack = [];
  selectedCourses = new Set([
    ...(origState.active ? [origState.active.course] : []),
    ...origState.observations.map(o => o.course)
  ]);
  renderCourseLists();
  refreshCourseScopedCounts();
  await refreshActiveLock();
  document.getElementById("mainApp").classList.remove("hidden");
  renderSummary();
  renderTab(activeTab);
  updateUndoButtons();
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

// renderTab() calls this on every render, so it must be a no-op when the
// tab is already subscribed to the right week — otherwise the snapshot
// callback's own renderTab() call would tear down and recreate the
// listener on every update, looping forever against Firestore.
function ensureWeekListener(tabNum) {
  const monday = weekState[tabNum];
  if (subscribedWeekByTab[tabNum] === monday && unsubByTab[tabNum]) return;
  if (unsubByTab[tabNum]) unsubByTab[tabNum]();
  subscribedWeekByTab[tabNum] = monday;
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
  const c = counters.curiousCount, i = counters.interviewerCount;
  if (diff > BALANCE_THRESHOLD) {
    curiousRadio.disabled = true;
    if (curiousRadio.checked) { curiousRadio.checked = false; interviewerRadio.checked = true; }
    notice.textContent = `Currently there is a strong imbalance toward Curious Student in the class (${c} Curious Students vs. ${i} Interviewers). You may only select Interviewer for now — or wait a little and check back once the balance improves.`;
    notice.className = "notice info";
    notice.classList.remove("hidden");
  } else if (-diff > BALANCE_THRESHOLD) {
    interviewerRadio.disabled = true;
    if (interviewerRadio.checked) { interviewerRadio.checked = false; curiousRadio.checked = true; }
    notice.textContent = `Currently there is a strong imbalance toward Interviewer in the class (${i} Interviewers vs. ${c} Curious Students). You may only select Curious Student for now — or wait a little and check back once the balance improves.`;
    notice.className = "notice info";
    notice.classList.remove("hidden");
  }
}
function renderTab2or3(tabNum, targetRole) {
  const notice = document.getElementById(`tab${tabNum}Notice`);
  const count = targetRole === "curious" ? courseScopedCounts.curious : courseScopedCounts.interviewer;
  if (count < MIN_FOR_OBSERVATION) {
    notice.className = "notice error";
    notice.textContent = `There aren't many ${targetRole === "curious" ? "curious students" : "interviewers"} registered yet for the courses you're interested in (currently ${count}). You may want to wait for a few more people to sign up and check back later. You can approve just your active role for now, and come back later under the same name to add this.`;
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
      let tier, clickable, explain = null;
      if (occupiedBySame) {
        tier = "tier-red"; clickable = false;
        explain = `This slot's ${role === "curious" ? "Curious Student" : "Interviewer"} position is already taken. Please pick a different slot or role.`;
      } else if (occupiedByOpposite) { tier = "tier-green-orange"; clickable = true; }
      else { tier = "tier-green"; clickable = true; }
      boxes.push({
        course: e.course, type: e.type, tier, clickable, explain,
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
      let tier, clickable, explain = null;
      if (count >= MAX_OBSERVERS) {
        tier = "tier-red"; clickable = false;
        explain = `This ${targetRole === "curious" ? "curious student" : "interviewer"} already has ${count} observers. Please pick a different session to observe.`;
      } else if (count === 2) { tier = "tier-orange-red"; clickable = true; }
      else if (count === 1) { tier = "tier-green-orange"; clickable = true; }
      else { tier = "tier-green"; clickable = true; }
      boxes.push({
        course: e.course, type: e.type, tier, clickable, explain,
        selected: alreadyMine,
        badge: count >= MAX_OBSERVERS ? `≥${MAX_OBSERVERS}` : String(count),
        onClick: clickable ? () => onObserverClick(tabNum, e.course, date, slot, targetRole, occupant, count) : null
      });
    }
  }
  return boxes;
}
// Font size is derived from the same `rows` value that drives the grid
// layout, computed at the same render pass — so a repack (course
// selection changing box count) can never leave text out of sync with
// the box size that was just resized around it.
function fontSizesFor(rows) {
  const shrink = Math.max(0, rows - 2);
  return {
    code: Math.max(8, 13 - shrink * 1.8).toFixed(1),
    type: Math.max(7, 11 - shrink * 1.5).toFixed(1),
    badge: Math.max(8, 10 - shrink * 1.2).toFixed(1)
  };
}
function renderBox(b, dims) {
  const div = document.createElement("div");
  div.className = `box ${b.tier}` + (b.clickable ? " clickable" : "") + (b.selected ? " selected" : "") + (!b.clickable && b.explain ? " explainable" : "");
  const fs = fontSizesFor(dims.rows || 1);
  div.innerHTML = `<span class="code" style="font-size:${fs.code}px">${b.course}</span><span class="type" style="font-size:${fs.type}px">${b.type}</span>` +
    (b.badge != null ? `<span class="badge" style="font-size:${fs.badge}px">${b.badge}</span>` : "");
  if (b.clickable && b.onClick) {
    div.addEventListener("click", b.onClick);
  } else if (b.explain) {
    div.addEventListener("click", () => showConfirmDialog({ text: b.explain, buttons: [{ label: "OK", action: () => {} }] }));
  }
  return div;
}

/* ---------------- calendar shell ---------------- */
function renderCalendarShell(tabNum) {
  const container = document.querySelector(`.calendar[data-tab="${tabNum}"]`);
  container.innerHTML = "";
  const monday = weekState[tabNum];

  const weekNum = isoWeek(monday);
  const note = WEEK_NOTES[weekNum];

  const nav = document.createElement("div");
  nav.className = "week-nav";
  const prevBtn = document.createElement("button"); prevBtn.type = "button"; prevBtn.textContent = "← Previous week";
  const nextBtn = document.createElement("button"); nextBtn.type = "button"; nextBtn.textContent = "Next week →";
  const wn = document.createElement("span"); wn.className = "week-num" + (note ? ` ${note.cls}` : ""); wn.textContent = `Week ${weekNum}`;
  prevBtn.disabled = monday <= FIRST_MONDAY;
  nextBtn.disabled = monday >= LAST_MONDAY;
  prevBtn.addEventListener("click", () => { weekState[tabNum] = addDays(weekState[tabNum], -7); ensureWeekListener(tabNum); renderCalendarShell(tabNum); });
  nextBtn.addEventListener("click", () => { weekState[tabNum] = addDays(weekState[tabNum], 7); ensureWeekListener(tabNum); renderCalendarShell(tabNum); });
  nav.append(prevBtn, wn, nextBtn);
  container.appendChild(nav);
  if (note) {
    const noteEl = document.createElement("p");
    noteEl.className = `week-note ${note.cls}`;
    noteEl.textContent = note.text;
    container.appendChild(noteEl);
  }

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
      boxes.forEach(b => cell.appendChild(renderBox(b, dims)));
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
  pushHistory();
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
    pushHistory();
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
          pushHistory();
          draftObservations.push({ course, date, slot, targetRole, targetName: occupant.name });
          renderTab(tabNum);
          renderSummary();
        } }
      ]
    });
    return;
  }
  pushHistory();
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
function entryBlock(roleLabel, course, date, slot) {
  const c = COURSES.find(x => x.code === course);
  const dow = DAY_NAMES[(toDate(date).getDay() + 6) % 7];
  return `<div class="entry">
    <span class="line-role">${roleLabel}</span>
    <span class="line-course">${course} — ${c ? c.name : ""}</span>
    <span class="line-day">${dow} ${fmtDay(date)}</span>
    <span class="line-time">${SLOT_TIMES[slot]}</span>
  </div>`;
}
function renderSummary() {
  const activeEl = document.getElementById("summaryActive");
  const obsEl = document.getElementById("summaryObservations");
  activeEl.innerHTML = "<strong>Active role</strong><br>" + (draftActive
    ? entryBlock(draftActive.role === "curious" ? "Curious Student" : "Interviewer", draftActive.course, draftActive.date, draftActive.slot)
    : `<div class="entry">No active-role session selected yet.</div>`);
  obsEl.innerHTML = "<strong>Observer roles</strong><br>"
    + `<p class="hint">You don't have to add these now — you can come back later and enter the same name to add them.</p>`
    + (draftObservations.length
      ? draftObservations.map(o => entryBlock(`Observing: ${o.targetName} (whose role is "${o.targetRole === "curious" ? "Curious Student" : "Interviewer"}")`, o.course, o.date, o.slot)).join("")
      : `<div class="entry">No observer roles selected yet.</div>`);
}
function flashSummary() {
  [document.getElementById("summaryActive"), document.getElementById("summaryObservations")].forEach(el => {
    el.classList.remove("flash");
    void el.offsetWidth; // restart the animation even if it's already mid-flash
    el.classList.add("flash");
  });
}

/* ---------------- undo ---------------- */
function snapshotDraft() {
  return { draftActive: draftActive ? { ...draftActive } : null, draftObservations: draftObservations.map(o => ({ ...o })) };
}
function pushHistory() {
  historyStack.push(snapshotDraft());
  if (historyStack.length > 20) historyStack.shift();
  updateUndoButtons();
}
function updateUndoButtons() {
  const enabled = nameConfirmed && historyStack.length > 0;
  document.getElementById("undoLastBtn").disabled = !enabled;
  document.getElementById("undoAllBtn").disabled = !enabled;
}
function undoLast() {
  if (!historyStack.length) return;
  const prev = historyStack.pop();
  draftActive = prev.draftActive;
  draftObservations = prev.draftObservations;
  renderTab(activeTab);
  renderSummary();
  flashSummary();
  updateUndoButtons();
}
function undoAll() {
  if (!historyStack.length) return;
  draftActive = origState.active ? { ...origState.active } : null;
  draftObservations = origState.observations.map(o => ({ ...o }));
  historyStack = [];
  renderTab(activeTab);
  renderSummary();
  flashSummary();
  updateUndoButtons();
}
function wireUndo() {
  document.getElementById("undoLastBtn").addEventListener("click", undoLast);
  document.getElementById("undoAllBtn").addEventListener("click", undoAll);
  updateUndoButtons();
}

/* ---------------- explain the role ---------------- */
const ROLE_EXPLANATIONS = {
  active: {
    title: "Active role — Curious Student or Interviewer",
    html: `
      <p><strong>Curious Student:</strong> pick a lecture from one of your courses. Your job is to make sure the lecture is understandable to everyone — even an imaginary "dummy student." Ask questions whenever you don't understand, and even when you do understand but feel the material lacks clarity. You're free to ask any basic question, or simply say "I don't understand" — no one else knows whether you genuinely don't know or are doing this on purpose. Ask at least one question every 25–30 minutes, so at least 4 in total; more is fine. Stuck for what to ask? Try "Can you please repeat that definition?" or "I'm not sure I followed that derivation — could you summarize it?" The same technique also works to slow a lecturer down when the pace is too fast.</p>
      <p><strong>Interviewer:</strong> approach the lecturer after class — immediately after, or up to a week later — and ask at least two questions clarifying the lecture's content, plus at least one question placing the material in a broader context (of the course, or of science more generally) or connecting it to another subject. Make sure you understand the answers; if something's unclear, ask more. A good approach: catch the lecturer during the break for one or two questions, then again after class for one or two more — otherwise it can get time-cramped and you may need to schedule a separate meeting.</p>
      <p>One lecture may have several curious students and interviewers, but where possible, try to spread out and cover more lectures and lecturers.</p>
    `
  },
  observer: {
    title: "Observer role",
    html: `
      <p>Each student should observe one interviewer and one curious student. We expect that, in turn, every student will be observed by two peers — please try to spread out as observers — but this won't be enforced.</p>
      <p>As an observer, you attend the session your peer chose for their active role, watch how it goes, give them feedback afterward, and reflect on what you saw. Use the "Observe curious student" and "Observe interviewer" tabs for this; "Reserved observer" is for when logistics make it impossible for you to observe one of each — in that case, it's fine to observe two curious students or two interviewers instead.</p>
    `
  }
};
function showInfoDialog(html) {
  const overlay = document.getElementById("dialogOverlay");
  const box = document.getElementById("dialogBox");
  box.innerHTML = html;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Got it";
  btn.addEventListener("click", () => overlay.classList.add("hidden"));
  box.appendChild(btn);
  overlay.classList.remove("hidden");
}
function wireExplainButtons() {
  document.querySelectorAll(".explain-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tabNum = Number(btn.dataset.tab);
      const content = tabNum === 1 ? ROLE_EXPLANATIONS.active : ROLE_EXPLANATIONS.observer;
      showInfoDialog(`<h3 style="margin-top:0">${content.title}</h3>${content.html}`);
    });
  });
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
  historyStack = [];
  updateUndoButtons();
  await refreshActiveLock();
}

/* ---------------- confirmation banner (copy / email / ics) ---------------- */
function buildSummaryText() {
  const lines = [`VågaFråga registration for ${currentName}`, ""];
  lines.push("Active role:");
  lines.push(draftActive ? `  ${draftActive.role === "curious" ? "Curious Student" : "Interviewer"} — ${fmtEntry(draftActive.course, draftActive.date, draftActive.slot)}` : "  (none)");
  lines.push("");
  lines.push("Observer roles:");
  if (draftObservations.length) draftObservations.forEach(o => lines.push(`  Observing: ${o.targetName} (whose role is "${o.targetRole === "curious" ? "Curious Student" : "Interviewer"}") — ${fmtEntry(o.course, o.date, o.slot)}`));
  else lines.push("  (none)");
  return lines.join("\n");
}
function collectEvents() {
  const events = [];
  if (draftActive) events.push(draftActive);
  draftObservations.forEach(o => events.push(o));
  return events;
}
function eventTitle(e) {
  return `${e.course} (${e.role ? (e.role === "curious" ? "Curious Student" : "Interviewer") : "Observing " + e.targetName})`;
}
function toIcsDate(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-");
  const [h, mi] = timeStr.split(":");
  return `${y}${m}${d}T${h.padStart(2, "0")}${mi.padStart(2, "0")}00`;
}
function buildIcs(events) {
  let ics = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//VagaFraga//EN\n";
  events.forEach((e, i) => {
    ics += "BEGIN:VEVENT\n";
    ics += `UID:vagafraga-${slugify(currentName)}-${i}@vagafraga\n`;
    ics += `DTSTART:${toIcsDate(e.date, SLOT_START[e.slot])}\n`;
    ics += `DTEND:${toIcsDate(e.date, SLOT_END[e.slot])}\n`;
    ics += `SUMMARY:${eventTitle(e)}\n`;
    ics += "END:VEVENT\n";
  });
  ics += "END:VCALENDAR\n";
  return ics;
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast("Copied to clipboard."),
      () => fallbackCopy(text)
    );
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
  document.body.removeChild(ta);
  toast(ok ? "Copied to clipboard." : "Couldn't copy automatically — please select and copy the text below.");
}
function showApprovalConfirmation() {
  const text = buildSummaryText();
  const events = collectEvents();
  const overlay = document.getElementById("dialogOverlay");
  const box = document.getElementById("dialogBox");
  box.innerHTML = `
    <p>The information below was recorded about you. You may come back later and modify it if you use the same name. Please note the assignment details yourself — we do not collect email addresses here, so we are not able to send you reminders or notifications.</p>
    <div style="display:flex; gap:8px; margin:10px 0; flex-wrap:wrap;">
      <button id="copyBtn" type="button">Copy</button>
      <button id="emailBtn" type="button">E-mail</button>
      <button id="icsBtn" type="button">Add to calendar</button>
    </div>
    <pre style="white-space:pre-wrap; background:#f5f5f5; padding:10px; border-radius:6px; font-size:12px;">${text}</pre>
    <button id="closeConfirmBtn" type="button">Close</button>
  `;
  overlay.classList.remove("hidden");
  document.getElementById("copyBtn").addEventListener("click", () => copyText(text));
  document.getElementById("emailBtn").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = `mailto:?subject=${encodeURIComponent("My VågaFråga registration")}&body=${encodeURIComponent(text)}`;
    a.click();
    toast("Opening your email client — if nothing opens, your browser may not have one set as default. Try Copy instead.");
  });
  document.getElementById("icsBtn").addEventListener("click", () => {
    // No .download attribute on purpose: that forces a save-as-file in
    // every browser. Left as a plain navigation, browsers that know what
    // to do with a calendar file (Safari, for one) hand it straight to
    // whatever calendar app is registered on the device instead of
    // downloading it — there's no third-party calendar service involved
    // either way, just the file and the OS's own handling of it.
    const blob = new Blob([buildIcs(events)], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  document.getElementById("closeConfirmBtn").addEventListener("click", () => overlay.classList.add("hidden"));
}
