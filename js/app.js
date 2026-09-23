import {
  db, auth, authReady, authReadyWithin, doc, getDoc, getDocs, setDoc, runTransaction,
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
// Name-field placeholder pool — mostly Astrid Lindgren characters, one
// per page load, picked at random purely for a bit of local flavor.
const PLACEHOLDER_NAMES = [
  "Pettson Findus", "Taket Karlsson", "Jum-Jum", "Bamse Skalman",
  "Emil Lönneberga", "Madicken", "Nils Pyssling", "Lotta Bacon",
  "Pippi Långstrump", "Ronja Rövardotter",
];
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

// Every value that ends up inside an innerHTML template and did not
// originate as a hardcoded string in this file — a student's own name, an
// observed student's name, a locked session's observer names, a course name
// someone added via "+ Add another course" — must go through this first.
// Course *codes* are already restricted to [A-Z0-9] at submission time, but
// they're escaped here too for defense in depth rather than relying on that.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------------- slug ---------------- */
const DIACRITIC_MAP = { å: "a", ä: "a", ö: "o", é: "e", è: "e", ü: "u", ï: "i", ø: "o", ñ: "n", ß: "ss" };
function slugify(name) {
  let s = name.trim().toLowerCase();
  s = s.replace(/[åäöéèüïøñß]/g, ch => DIACRITIC_MAP[ch] || ch);
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s;
}
// Records written before the slug field existed only have `name`/`uid`.
// Deriving it from the stored name here means an identity comparison can
// never silently fail against old data — no migration required, and any
// future field we forget to backfill fails the same safe way.
function occupantSlug(occupant) {
  return occupant.slug || slugify(occupant.name || "");
}
function keyOf(entry) { return `${entry.course}_${entry.date}_${entry.slot}`; }
function emptySession(key) {
  const [course, date, slot] = key.split("_");
  return { course, date, slot: Number(slot), weekStart: mondayOf(date), curious: null, interviewer: null, curiousObservers: [], interviewerObservers: [] };
}
// Used only to detect whether another window/device changed this student's own
// record between when this window last loaded it and when it's about to save —
// never for anything session-occupancy-related (that's always diffed against a
// fresh read inside the transaction, see approveSelections()).
function sameActive(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.course === b.course && a.date === b.date && a.slot === b.slot && a.role === b.role;
}
function sameObservations(a, b) {
  if (a.length !== b.length) return false;
  const keyer = o => `${o.course}_${o.date}_${o.slot}_${o.targetRole}`;
  const as = new Set(a.map(keyer));
  return b.every(o => as.has(keyer(o)));
}

/* ================================================================
   Unified student state
   ================================================================
   draftState is the ONE object holding everything about "this student,
   right now": both what eventually gets saved (active, observations)
   and pure session/UI position (selectedCourses, activeTab, weekByTab,
   the two tab role choices). origState mirrors only the persisted
   slice — the last state actually written to Firestore, i.e. what
   "Undo all" reverts to and what approveSelections() diffs against.

   Every mutation goes through applyToDraft() or setState() below, and
   both always end in renderApp() — so a screen update can never be
   forgotten, which is exactly the bug class this replaces.
   ================================================================ */
function makeEmptyDraftState() {
  return {
    active: null,               // {course, date, slot, role} | null
    observations: [],           // [{course, date, slot, targetRole, targetName}]
    selectedCourses: new Set(), // ticked course codes
    activeTab: 1,                // which of the 4 tabs is open
    weekByTab: { 1: FIRST_MONDAY, 2: FIRST_MONDAY, 3: FIRST_MONDAY, 4: FIRST_MONDAY },
    tab1Role: "curious",         // Active-role tab's radio
    tab4Role: "curious",         // Reserved-observer tab's radio
  };
}
// Building a draft from a loaded student record — the one place a
// Firestore student doc turns into the shape the rest of the app edits.
function loadDraftFromSaved(saved) {
  const state = makeEmptyDraftState();
  state.active = saved.active ? { ...saved.active } : null;
  state.observations = (saved.observations || []).map(o => ({ ...o }));
  state.selectedCourses = new Set([
    ...(state.active ? [state.active.course] : []),
    ...state.observations.map(o => o.course)
  ]);
  if (state.active) state.tab1Role = state.active.role;
  return state;
}
// The undo history only ever snapshots the "content" portion — active +
// observations — never navigation (tab, week, search). Undo is about
// reverting selections, not about where you were looking; course
// ticking was explicitly scoped out of undo too (see toggleCourse).
function contentSnapshot(state) {
  return { active: state.active ? { ...state.active } : null, observations: state.observations.map(o => ({ ...o })) };
}

let draftState = makeEmptyDraftState();
let origState = { active: null, observations: [], createdAt: null };
let historyStack = []; // stack of contentSnapshot()s, for Undo last/all

// The single screen-update entry point. Every render*() function reads
// only from draftState/origState/module data — nothing else calls them
// directly outside of this and the one-off async refreshers below.
function renderApp() {
  renderCourseLists();
  if (!nameConfirmed) return;
  renderTab(draftState.activeTab);
  renderSummary();
  updateUndoButtons();
}
// Navigation-only change: tab switch, week nav, course ticking, a tab
// role radio with nothing to swap. Re-renders, but isn't undoable.
function applyToDraft(mutator) {
  mutator(draftState);
  renderApp();
}
// A real content change: active-role pick, role swap, observation
// add/remove/erase. Snapshots the prior content first, so it's undoable.
function setState(mutator) {
  historyStack.push(contentSnapshot(draftState));
  if (historyStack.length > 20) historyStack.shift();
  applyToDraft(mutator);
}

/* ---------------- other global state ---------------- */
let STATIC_COURSES = [];
let STATIC_SCHEDULE = [];
let customCourses = new Map();  // code -> {code,name,addedBy}
let customSchedule = new Map(); // "code_date_slot" -> {course,date,slot,type}
let COURSES = [];
let scheduleByDateSlot = new Map(); // "date_slot" -> [{course,type}]

let myUid = null;
let currentName = "";
let currentSlug = "";
let nameConfirmed = false;

let activeLocked = false;
let activeLockObservers = [];

let weekSessionsByTab = { 1: new Map(), 2: new Map(), 3: new Map(), 4: new Map() };
let unsubByTab = { 1: null, 2: null, 3: null, 4: null };
let subscribedWeekByTab = { 1: null, 2: null, 3: null, 4: null };
let counters = { curiousCount: 0, interviewerCount: 0 };
// Counts scoped to the student's currently-ticked courses, refetched
// whenever the course selection or active tab changes — separate from
// the global `counters` above, which stay global for the tab-1 balance
// rule. Both are one-off fetches, not live (see refresh calls below).
let courseScopedCounts = { curious: 0, interviewer: 0 };

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
  renderApp();
}

async function boot() {
  document.getElementById("nameInput").placeholder =
    `e.g. ${PLACEHOLDER_NAMES[Math.floor(Math.random() * PLACEHOLDER_NAMES.length)]}`;

  // Nothing below this point is wired up yet (no listener on the name
  // field, nothing), so a failure here has to be visible on its own —
  // it can't rely on any function boot() hasn't reached yet, and there's
  // no toast to fade past unnoticed: the page would otherwise just sit
  // there looking normal but doing nothing for every input.
  try {
    const [c, s] = await Promise.all([
      fetch("data/courses.json").then(r => r.json()),
      fetch("data/schedule.json").then(r => r.json())
    ]);
    STATIC_COURSES = c;
    STATIC_SCHEDULE = s;
  } catch (err) {
    console.error(err);
    const banner = document.getElementById("loadErrorBanner");
    banner.classList.remove("hidden");
    banner.innerHTML = `Couldn't load the course data — please check your connection. <button id="retryBootBtn" type="button">Retry</button>`;
    document.getElementById("retryBootBtn").addEventListener("click", () => location.reload());
    return;
  }
  rebuildMergedData();

  wireHeader();
  wireTabs();
  wireApprove();
  wireConnectivity();
  wireAddCourse();
  wireUndo();
  wireExplainButtons();
  wireCoursePicker();

  authReady.then(u => { myUid = u.uid; });

  onSnapshot(doc(db, "meta", "counters"), snap => {
    counters = snap.exists() ? snap.data() : { curiousCount: 0, interviewerCount: 0 };
    if (draftState.activeTab === 1) renderTab(1);
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
  for (const code of [...draftState.selectedCourses].sort()) {
    const c = COURSES.find(x => x.code === code);
    if (c) right.appendChild(courseRow(c, () => toggleCourse(c.code)));
  }

  const allSelected = COURSES.length > 0 && COURSES.every(c => draftState.selectedCourses.has(c.code));
  document.getElementById("selectAllBtn").textContent = allSelected ? "Unselect all" : "Select all";
}
function courseRow(c, onToggle) {
  const li = document.createElement("li");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.dataset.code = c.code;
  cb.checked = draftState.selectedCourses.has(c.code);
  cb.addEventListener("change", onToggle);
  const label = document.createElement("span");
  label.innerHTML = `<span class="course-code">${escapeHtml(c.code)}</span> — ${escapeHtml(c.name)}`;
  li.appendChild(cb);
  li.appendChild(label);
  return li;
}
// Ticking/unticking a course is navigation, not a content change — it's
// never itself an undo step. But it can cascade into dropping an active
// pick or observations tied to that course, and *that* is a real content
// change: undoable, lock-respecting, and always explained.
function toggleCourse(code) {
  applyToDraft(state => {
    if (state.selectedCourses.has(code)) state.selectedCourses.delete(code); else state.selectedCourses.add(code);
  });
  pruneToSelectedCourses();
  refreshCourseScopedCounts();
}
function wireCoursePicker() {
  document.getElementById("courseSearch").addEventListener("input", renderCourseLists);
  document.getElementById("selectAllBtn").addEventListener("click", () => {
    const allSelected = COURSES.length > 0 && COURSES.every(c => draftState.selectedCourses.has(c.code));
    applyToDraft(state => { state.selectedCourses = allSelected ? new Set() : new Set(COURSES.map(c => c.code)); });
    pruneToSelectedCourses();
    refreshCourseScopedCounts();
  });
}
// Unticking a course used to silently wipe any active-role pick or
// observations tied to it — no feedback, and no check of the same
// already-has-observers lock that blocks every other way of changing
// the active role. Now it respects the lock (re-ticking the course
// rather than dropping a locked pick) and always tells the student
// what happened.
function pruneToSelectedCourses() {
  const activeCourseGone = draftState.active && !draftState.selectedCourses.has(draftState.active.course);
  if (activeCourseGone && activeLocked) {
    applyToDraft(state => { state.selectedCourses.add(state.active.course); });
    showActiveLockedDialog();
    return;
  }
  const droppedObs = draftState.observations.filter(o => !draftState.selectedCourses.has(o.course));
  if (!activeCourseGone && !droppedObs.length) return;

  setState(state => {
    if (activeCourseGone) state.active = null;
    state.observations = state.observations.filter(o => state.selectedCourses.has(o.course));
  });
  const parts = [];
  if (activeCourseGone) parts.push("your active-role selection");
  if (droppedObs.length === 1) parts.push("an observation");
  else if (droppedObs.length > 1) parts.push(`${droppedObs.length} observations`);
  toast(`Removed ${parts.join(" and ")} — you unticked its course.`);
}

// Live counts of curious/interviewer registrations, scoped to only the
// courses the student has ticked — used for the tab 2/3/4 "not enough
// people registered yet" notice, which should reflect what's relevant
// to this student rather than the whole class (that's what the global
// `counters` / tab-1 balance rule are for).
async function refreshCourseScopedCounts() {
  if (draftState.selectedCourses.size === 0) {
    courseScopedCounts = { curious: 0, interviewer: 0 };
  } else {
    try {
      const courses = [...draftState.selectedCourses].slice(0, 30); // Firestore 'in' query cap
      const snap = await getDocs(query(collection(db, "sessions"), where("course", "in", courses)));
      let curious = 0, interviewer = 0;
      snap.forEach(d => { const data = d.data(); if (data.curious) curious++; if (data.interviewer) interviewer++; });
      courseScopedCounts = { curious, interviewer };
    } catch (err) {
      console.error(err);
    }
  }
  renderApp();
}

/* ---------------- add-course modal ---------------- */
// This modal composes a submission to the shared course catalog, not the
// student's own state — its scratch fields (which week it's browsing,
// which slots are pending) are deliberately local, not part of draftState.
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
        box.innerHTML = `<span class="code" style="font-size:11px">${escapeHtml(p.type)}</span><span class="type" style="font-size:10px">click to remove</span>`;
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

  const connected = await authReadyWithin(8000);
  if (!connected) { toast(connectivityFailMessage("connect")); return; }
  try {
    // setDoc overwrites rather than appends, so re-running this whole
    // sequence after a partial failure is harmless — safe to retry as one unit.
    await withRetry(async () => {
      if (!existing) {
        await setDoc(doc(db, "customCourses", code), { code, name: nameRaw, addedBy: currentName || "anonymous", createdAt: serverTimestamp() });
      }
      await Promise.all(pendingInstances.map(p =>
        setDoc(doc(db, "customSchedule", `${code}_${p.date}_${p.slot}`), { course: code, date: p.date, slot: p.slot, type: p.type })
      ));
    });
    connectivitySucceeded();
    applyToDraft(state => { state.selectedCourses.add(code); });
    refreshCourseScopedCounts();
    closeAddCourseModal();
    toast(existing
      ? "Session added — don't forget to go to the tabs below and select your own role for it."
      : "Course added — don't forget to go to the tabs below and select your own role for it.");
  } catch (err) {
    console.error(err);
    toast(connectivityFailMessage("add the course"));
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
  const connected = await authReadyWithin(8000);
  if (!connected) { toast(connectivityFailMessage("connect")); return; }
  const slug = slugify(trimmed);
  // A blank field staying blank needs no explanation, but text that's
  // visibly there and still resolves to nothing (only punctuation/symbols)
  // would otherwise look like the app just isn't responding.
  if (!slug) { toast("Please include at least one letter or number in your name."); return; }
  let snap;
  try {
    // Without this, a dropped connection right here left the student
    // staring at a name field that silently never did anything next.
    snap = await withRetry(() => getDoc(doc(db, "students", slug)));
    connectivitySucceeded();
  } catch (err) {
    console.error(err);
    toast(connectivityFailMessage("check that name"));
    return;
  }
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
  // Identity is by slug, not exact text — two visibly different names (extra
  // space, different capitalization, "å" vs "a", ...) can collide on the same
  // slug. When that's happened, say so explicitly and show both strings, so
  // it reads as "these two names count as the same" rather than a glitch
  // showing someone else's name back at the student.
  const sameText = existingData.name === currentName;
  const collisionNote = sameText ? "" : `<p>You typed "${escapeHtml(currentName)}" — this app treats it as the same identity as the name already on record below, since it simplifies to the same internal identifier (spacing, capitalization, and accents are ignored).</p>`;
  banner.innerHTML = `
    <p>The name "${escapeHtml(existingData.name)}" has already been used — registered for ${roleSummaryText(existingData)}.</p>
    ${collisionNote}
    <p>If you recognize this as you, please proceed. Otherwise, cancel and choose a name that's more clearly different.</p>
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
// --- Loader: the only two places a Firestore student doc becomes this
// app's in-memory state. ---
function confirmFreshStart() {
  nameConfirmed = true;
  origState = { active: null, observations: [], createdAt: null };
  draftState = makeEmptyDraftState();
  historyStack = [];
  document.getElementById("mainApp").classList.remove("hidden");
  document.getElementById("lockedNotice").classList.add("hidden");
  activeLocked = false;
  renderApp();
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
  draftState = loadDraftFromSaved(origState);
  historyStack = [];
  refreshCourseScopedCounts();
  await refreshActiveLock();
  document.getElementById("mainApp").classList.remove("hidden");
  renderApp();
}
async function refreshActiveLock() {
  activeLocked = false;
  activeLockObservers = [];
  const notice = document.getElementById("lockedNotice");
  notice.classList.add("hidden");
  if (!origState.active) return;
  let snap;
  try {
    snap = await withRetry(() => getDoc(doc(db, "sessions", keyOf(origState.active))));
    connectivitySucceeded();
  } catch (err) {
    // This check gates a login flow (confirmReturning awaits it before
    // ever unhiding mainApp) — a network hiccup here must not strand a
    // returning student on a blank page. Fall through as "not locked":
    // the lock is a courtesy against surprising someone's observers, not
    // a data-integrity boundary (approveSelections never trusts it
    // either), so under-protecting once during an outage is the far
    // smaller cost than the app refusing to open at all. Still worth
    // telling them, since silently under-protecting is easy to miss.
    console.error(err);
    toast(connectivityFailMessage("check your active-role status"));
    return;
  }
  if (!snap.exists()) return;
  const data = snap.data();
  const observers = origState.active.role === "curious" ? data.curiousObservers : data.interviewerObservers;
  if (observers && observers.length > 0) {
    activeLocked = true;
    activeLockObservers = observers.map(o => o.name);
    notice.classList.remove("hidden");
    notice.innerHTML = `You already have observers assigned to your current active-role session (${escapeHtml(origState.active.course)}): <strong>${activeLockObservers.map(escapeHtml).join(", ")}</strong>. If you want to change your active role, you need to speak with them first so they can unselect — this cannot be changed here.`;
  }
}

/* ---------------- tabs ---------------- */
function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(Number(btn.dataset.tab)));
  });
  document.querySelectorAll('input[name="tab1role"]').forEach(r => r.addEventListener("change", () => onTab1RoleChange(r)));
  document.querySelectorAll('input[name="tab4role"]').forEach(r => r.addEventListener("change", () => {
    applyToDraft(state => { state.tab4Role = r.value; });
  }));
}
function switchTab(n) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", Number(b.dataset.tab) === n));
  document.querySelectorAll(".tab-content").forEach(el => el.classList.toggle("hidden", el.id !== `tab${n}`));
  applyToDraft(state => { state.activeTab = n; });
  // One-off fetches, not live — refreshing on every tab switch (cheap:
  // one query, one doc read) keeps them from silently going stale if
  // another student approved something while you sat on a different tab.
  if ([2, 3, 4].includes(n)) refreshCourseScopedCounts();
  if (n === 1) refreshActiveLock();
}

// renderTab() calls this on every render, so it must be a no-op when the
// tab is already subscribed to the right week — otherwise the snapshot
// callback's own renderTab() call would tear down and recreate the
// listener on every update, looping forever against Firestore.
function ensureWeekListener(tabNum) {
  const monday = draftState.weekByTab[tabNum];
  if (subscribedWeekByTab[tabNum] === monday && unsubByTab[tabNum]) return;
  if (unsubByTab[tabNum]) unsubByTab[tabNum]();
  subscribedWeekByTab[tabNum] = monday;
  const q = query(collection(db, "sessions"), where("weekStart", "==", monday));
  unsubByTab[tabNum] = onSnapshot(q, snap => {
    const m = new Map();
    snap.forEach(d => m.set(d.id, d.data()));
    weekSessionsByTab[tabNum] = m;
    if (draftState.activeTab === tabNum) renderTab(tabNum);
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
  curiousRadio.checked = draftState.tab1Role === "curious";
  interviewerRadio.checked = draftState.tab1Role === "interviewer";
  curiousRadio.disabled = false;
  interviewerRadio.disabled = false;
  notice.classList.add("hidden");
  const diff = counters.curiousCount - counters.interviewerCount;
  const c = counters.curiousCount, i = counters.interviewerCount;
  if (diff > BALANCE_THRESHOLD) {
    curiousRadio.disabled = true;
    if (draftState.tab1Role === "curious") {
      draftState.tab1Role = "interviewer";
      curiousRadio.checked = false; interviewerRadio.checked = true;
    }
    notice.textContent = `Currently there is a strong imbalance toward Curious Student in the class (${c} Curious Students vs. ${i} Interviewers). You may only select Interviewer for now — or wait a little and check back once the balance improves.`;
    notice.className = "notice info";
    notice.classList.remove("hidden");
  } else if (-diff > BALANCE_THRESHOLD) {
    interviewerRadio.disabled = true;
    if (draftState.tab1Role === "interviewer") {
      draftState.tab1Role = "curious";
      interviewerRadio.checked = false; curiousRadio.checked = true;
    }
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
  const curiousRadio = document.querySelector('input[name="tab4role"][value="curious"]');
  const interviewerRadio = document.querySelector('input[name="tab4role"][value="interviewer"]');
  curiousRadio.checked = draftState.tab4Role === "curious";
  interviewerRadio.checked = draftState.tab4Role === "interviewer";
  renderTab2or3(4, draftState.tab4Role);
}

/* ---------------- box computation ---------------- */
function layoutDims(count) {
  if (count <= 0) return { rows: 0, cols: 1 };
  if (count <= 2) return { rows: 2, cols: 1 };
  return { rows: Math.ceil(count / 2), cols: 2 };
}
function computeBoxesForDate(tabNum, date, slot) {
  const entries = (scheduleByDateSlot.get(`${date}_${slot}`) || []).filter(e => draftState.selectedCourses.has(e.course));
  const boxes = [];
  for (const e of entries) {
    const key = `${e.course}_${date}_${slot}`;
    const session = getSession(tabNum, key);
    if (tabNum === 1) {
      const role = draftState.tab1Role;
      const oppositeRole = role === "curious" ? "interviewer" : "curious";
      const mineOccupant = session[role] && occupantSlug(session[role]) === currentSlug;
      const occupiedBySame = session[role] && !mineOccupant;
      const occupiedByOpposite = !!session[oppositeRole];
      let tier, clickable, explain = null;
      if (occupiedBySame) {
        tier = "tier-red"; clickable = false;
        explain = `This slot's ${role === "curious" ? "Curious Student" : "Interviewer"} position is already taken. Please pick a different slot or role.`;
      } else if (occupiedByOpposite) { tier = "tier-green-orange"; clickable = true; }
      else { tier = "tier-green"; clickable = true; }
      boxes.push({
        course: e.course, type: e.type, tier, clickable, explain, date, slot, role,
        selected: !!(draftState.active && keyOf(draftState.active) === key && draftState.active.role === role),
        badge: null,
        onClick: clickable ? () => onTab1Click(e.course, date, slot, role) : null
      });
    } else {
      const targetRole = tabNum === 2 ? "curious" : tabNum === 3 ? "interviewer" : draftState.tab4Role;
      const occupant = session[targetRole];
      if (!occupant) continue;
      const observers = session[targetRole + "Observers"] || [];
      const count = observers.length;
      const alreadyMine = draftState.observations.some(o => keyOf(o) === key && o.targetRole === targetRole);
      let tier, clickable, explain = null;
      if (count >= MAX_OBSERVERS) {
        tier = "tier-red";
        // Removing your own observation only ever brings the count down, so
        // it stays clickable even at the cap — otherwise a student who's
        // already one of the 3 observers here could never cancel through
        // this box once a 4th person's attempt (correctly) never got in.
        clickable = alreadyMine;
        if (!alreadyMine) explain = `This ${targetRole === "curious" ? "curious student" : "interviewer"} already has ${count} observers. Please pick a different session to observe.`;
      } else if (count === 2) { tier = "tier-orange-red"; clickable = true; }
      else if (count === 1) { tier = "tier-green-orange"; clickable = true; }
      else { tier = "tier-green"; clickable = true; }
      boxes.push({
        course: e.course, type: e.type, tier, clickable, explain, date, slot, role: targetRole,
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
  div.dataset.course = b.course;
  div.dataset.date = b.date;
  div.dataset.slot = b.slot;
  div.dataset.role = b.role;
  const fs = fontSizesFor(dims.rows || 1);
  div.innerHTML = `<span class="code" style="font-size:${fs.code}px">${escapeHtml(b.course)}</span><span class="type" style="font-size:${fs.type}px">${escapeHtml(b.type)}</span>` +
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
  const monday = draftState.weekByTab[tabNum];

  const weekNum = isoWeek(monday);
  const note = WEEK_NOTES[weekNum];

  const nav = document.createElement("div");
  nav.className = "week-nav";
  const prevBtn = document.createElement("button"); prevBtn.type = "button"; prevBtn.textContent = "← Previous week";
  const nextBtn = document.createElement("button"); nextBtn.type = "button"; nextBtn.textContent = "Next week →";
  const wn = document.createElement("span"); wn.className = "week-num" + (note ? ` ${note.cls}` : ""); wn.textContent = `Week ${weekNum}`;
  prevBtn.disabled = monday <= FIRST_MONDAY;
  nextBtn.disabled = monday >= LAST_MONDAY;
  prevBtn.addEventListener("click", () => applyToDraft(state => { state.weekByTab[tabNum] = addDays(state.weekByTab[tabNum], -7); }));
  nextBtn.addEventListener("click", () => applyToDraft(state => { state.weekByTab[tabNum] = addDays(state.weekByTab[tabNum], 7); }));
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
  if (draftState.active && keyOf(draftState.active) === key && draftState.active.role === role) return;
  setState(state => { state.active = { course, date, slot, role }; });
}
function showActiveLockedDialog() {
  showConfirmDialog({ text: document.getElementById("lockedNotice").innerHTML, buttons: [{ label: "OK", action: () => {} }] });
}
// Flipping the Curious/Interviewer radio while a session is already
// selected tries to swap that session to the new role: succeeds (box
// stays highlighted, summary updates) if that role's open there, or
// reverts the radio and explains why if not. With no session selected
// yet, flipping the radio is pure browsing — no lock, no swap, just
// changes which role's boxes you're looking at.
async function onTab1RoleChange(radioEl) {
  const newRole = radioEl.value;
  const prevRole = draftState.tab1Role;
  if (newRole === prevRole) return;
  const revert = () => { document.querySelector(`input[name="tab1role"][value="${prevRole}"]`).checked = true; };

  if (!draftState.active) {
    applyToDraft(state => { state.tab1Role = newRole; });
    return;
  }
  if (activeLocked) {
    revert();
    showActiveLockedDialog();
    return;
  }
  const key = keyOf(draftState.active);
  let session;
  try {
    const snap = await withRetry(() => getDoc(doc(db, "sessions", key)));
    session = snap.exists() ? snap.data() : emptySession(key);
    connectivitySucceeded();
  } catch (err) {
    console.error(err);
    revert();
    toast(connectivityFailMessage("check that slot"));
    return;
  }
  const occupant = session[newRole];
  if (occupant && occupantSlug(occupant) !== currentSlug) {
    revert();
    showConfirmDialog({
      text: `Can't switch to ${newRole === "curious" ? "Curious Student" : "Interviewer"} for your selected session (${draftState.active.course}) — that role there is already taken. Pick a different session for ${newRole === "curious" ? "Curious Student" : "Interviewer"} instead, or keep your current selection.`,
      buttons: [{ label: "OK", action: () => {} }]
    });
    return;
  }
  setState(state => { state.active = { ...state.active, role: newRole }; state.tab1Role = newRole; });
}
function onObserverClick(tabNum, course, date, slot, targetRole, occupant, count) {
  if (occupantSlug(occupant) === currentSlug) {
    showConfirmDialog({ text: "You cannot observe yourself.", buttons: [{ label: "OK", action: () => {} }] });
    return;
  }
  const key = `${course}_${date}_${slot}`;
  const idx = draftState.observations.findIndex(o => keyOf(o) === key && o.targetRole === targetRole);
  if (idx >= 0) {
    setState(state => { state.observations.splice(idx, 1); });
    return;
  }
  if (count === 2) {
    showConfirmDialog({
      text: `This ${targetRole === "curious" ? "curious student" : "interviewer"} already has two observers. We encourage you to observe someone else instead.`,
      buttons: [
        { label: "I understand", action: () => {} },
        { label: "I don't have other options — select anyway", action: () => {
          setState(state => { state.observations.push({ course, date, slot, targetRole, targetName: occupant.name }); });
        } }
      ]
    });
    return;
  }
  setState(state => { state.observations.push({ course, date, slot, targetRole, targetName: occupant.name }); });
}

/* ---------------- summary ---------------- */
function fmtEntry(course, date, slot) {
  const c = COURSES.find(x => x.code === course);
  const dow = DAY_NAMES[(toDate(date).getDay() + 6) % 7];
  return `${course} — ${c ? c.name : ""} · ${dow} ${fmtDay(date)} · ${SLOT_TIMES[slot]}`;
}
// roleLabel is passed in pre-escaped by every call site below (it's the one
// piece here that can carry another student's name, e.g. "Observing: ...").
function entryBlock(roleLabel, course, date, slot) {
  const c = COURSES.find(x => x.code === course);
  const dow = DAY_NAMES[(toDate(date).getDay() + 6) % 7];
  return `<div class="entry">
    <span class="line-role">${roleLabel}</span>
    <span class="line-course">${escapeHtml(course)} — ${c ? escapeHtml(c.name) : ""}</span>
    <span class="line-day">${dow} ${fmtDay(date)}</span>
    <span class="line-time">${SLOT_TIMES[slot]}</span>
  </div>`;
}
function renderSummary() {
  const activeEl = document.getElementById("summaryActive");
  const obsEl = document.getElementById("summaryObservations");
  activeEl.innerHTML = "<strong>Active role</strong><br>" + (draftState.active
    ? entryBlock(draftState.active.role === "curious" ? "Curious Student" : "Interviewer", draftState.active.course, draftState.active.date, draftState.active.slot)
    : `<div class="entry">No active-role session selected yet.</div>`);
  obsEl.innerHTML = "<strong>Observer roles</strong><br>"
    + `<p class="hint">You don't have to add these now — you can come back later and enter the same name to add them.</p>`
    + (draftState.observations.length
      ? draftState.observations.map(o => entryBlock(`Observing: ${escapeHtml(o.targetName)} (whose role is "${o.targetRole === "curious" ? "Curious Student" : "Interviewer"}")`, o.course, o.date, o.slot)).join("")
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
function updateUndoButtons() {
  const undoEnabled = nameConfirmed && historyStack.length > 0;
  document.getElementById("undoLastBtn").disabled = !undoEnabled;
  document.getElementById("undoAllBtn").disabled = !undoEnabled;
  const eraseEnabled = nameConfirmed && (!!draftState.active || draftState.observations.length > 0);
  document.getElementById("eraseAllBtn").disabled = !eraseEnabled;
}
// Undo last/all consume history themselves rather than creating a new
// entry, so they go through applyToDraft (render, no push) — pushing
// here would make "undo" itself undo-able into a loop.
function undoLast() {
  if (!historyStack.length) return;
  const prev = historyStack.pop();
  applyToDraft(state => { state.active = prev.active; state.observations = prev.observations; });
  flashSummary();
}
function undoAll() {
  if (!historyStack.length) return;
  historyStack = [];
  applyToDraft(state => {
    state.active = origState.active ? { ...origState.active } : null;
    state.observations = origState.observations.map(o => ({ ...o }));
    if (state.active) state.tab1Role = state.active.role;
  });
  flashSummary();
}
// Distinct from "Undo all": that restores the last-approved state (or
// blank, for a first-time student). This wipes the draft to nothing
// regardless of what's approved — for a returning student those aren't
// the same thing. Still just a draft change, so it's undoable like any
// other action; the locked active role (if any) is left alone, same as
// everywhere else that respects that lock.
function eraseAllSelections() {
  if (!nameConfirmed) return;
  if (!draftState.active && !draftState.observations.length) return;
  setState(state => {
    state.active = activeLocked ? state.active : null;
    state.observations = [];
  });
  flashSummary();
  if (activeLocked) toast("Your active role already has observers and can't be cleared here — everything else was erased.");
}
function wireUndo() {
  document.getElementById("undoLastBtn").addEventListener("click", undoLast);
  document.getElementById("undoAllBtn").addEventListener("click", undoAll);
  document.getElementById("eraseAllBtn").addEventListener("click", eraseAllSelections);
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

/* ---------------- connectivity: retry, then notify ---------------- */
// One attempt, then one retry after a short pause — catches a connection
// that blips and comes back on its own within a couple seconds, so a
// single dropped packet doesn't immediately alarm the student.
async function withRetry(fn, delayMs = 1500) {
  try {
    return await fn();
  } catch (err) {
    await new Promise(r => setTimeout(r, delayMs));
    return await fn();
  }
}
// Tracks failures across every connectivity-dependent action below, not
// per-action — a student who's had trouble checking their name and then
// trouble picking a slot is having one bad-connection experience, not two.
let connectivityFailStreak = 0;
function connectivitySucceeded() { connectivityFailStreak = 0; }
function connectivityFailMessage(action) {
  connectivityFailStreak++;
  return connectivityFailStreak >= 3
    ? `Still couldn't ${action} — if this keeps happening, try again later or contact your instructor.`
    : `Couldn't ${action} right now — please check your connection and try again.`;
}

/* ---------------- approve ---------------- */
function wireApprove() {
  document.getElementById("approveBtn").addEventListener("click", onApprove);
}
// navigator.onLine only catches the browser having no network at all (wifi
// off, airplane mode) — it says nothing about whether Firestore specifically
// is reachable, so approveSelections()'s own try/catch stays as the real
// safety net for subtler failures (DNS, a captive portal, Firestore itself
// being down). This is just the cheap, common case caught before a click
// instead of after.
function wireConnectivity() {
  const approveBtn = document.getElementById("approveBtn");
  const offlineNote = document.getElementById("offlineNote");
  const update = () => {
    const online = navigator.onLine;
    approveBtn.disabled = !online;
    offlineNote.classList.toggle("hidden", online);
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}
async function onApprove() {
  if (!nameConfirmed) { toast("Please enter and confirm your name first."); return; }
  if (!navigator.onLine) { toast("You appear to be offline — reconnect before approving."); return; }
  try {
    const { staleAtStart } = await approveSelections();
    connectivitySucceeded();
    showApprovalConfirmation(staleAtStart);
  } catch (err) {
    let text;
    // The two conflicts are real business outcomes, not connectivity
    // trouble — retrying won't change them, so they don't touch the
    // connectivity streak or its escalating message.
    if (err.message === "CONFLICT_ACTIVE") text = "Someone else just took that active-role slot while you were choosing. Nothing was saved — please review your selection and pick another slot.";
    else if (err.message === "CONFLICT_OBSERVER") text = "That session just reached its observer limit while you were choosing. Nothing was saved — please review your selection and pick another session to observe.";
    else { console.error(err); text = `${connectivityFailMessage("save your selections")} Nothing was saved.`; }
    showConfirmDialog({ text, buttons: [{ label: "OK", action: () => {} }] });
  }
}
// --- Saver: the only place this app's draftState becomes a Firestore
// write. Reads/writes exactly the persisted slice (active, observations)
// of the unified state — selectedCourses/activeTab/weekByTab/tab roles
// never leave the browser. ---
async function approveSelections() {
  const slug = currentSlug;
  const nameSnapshot = currentName;
  const newActive = draftState.active;
  const newObservations = draftState.observations;

  // The diff of "what to clear" is always built from a FRESH read of this
  // student's own doc inside the transaction, never from the client's
  // cached origState. If another window/tab/device under the same name
  // approved something in between, origState here can be stale — diffing
  // against it would only clear the session slots *this* client remembers,
  // leaving whatever the other window touched permanently orphaned as a
  // "ghost" occupant that blocks the slot for everyone else forever.
  // Reading fresh here makes the transaction self-correcting regardless of
  // how stale the client's view is.
  const { staleAtStart } = await runTransaction(db, async (tx) => {
    const studentRef = doc(db, "students", slug);
    const studentSnap = await tx.get(studentRef);
    const serverData = studentSnap.exists() ? studentSnap.data() : null;
    const serverActive = serverData ? (serverData.active || null) : null;
    const serverObservations = serverData ? (serverData.observations || []) : [];

    const touchedKeys = new Set();
    if (serverActive) touchedKeys.add(keyOf(serverActive));
    if (newActive) touchedKeys.add(keyOf(newActive));
    serverObservations.forEach(o => touchedKeys.add(keyOf(o)));
    newObservations.forEach(o => touchedKeys.add(keyOf(o)));

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

    if (serverActive) {
      const k = keyOf(serverActive);
      const s = sessionData[k];
      if (s[serverActive.role] && occupantSlug(s[serverActive.role]) === slug) s[serverActive.role] = null;
    }
    if (newActive) {
      const k = keyOf(newActive);
      const s = sessionData[k];
      if (s[newActive.role] && occupantSlug(s[newActive.role]) !== slug) throw new Error("CONFLICT_ACTIVE");
      s[newActive.role] = { name: nameSnapshot, uid: myUid, slug };
    }
    const serverRole = serverActive ? serverActive.role : null;
    const draftRole = newActive ? newActive.role : null;
    if (serverRole !== draftRole) {
      if (serverRole) cnt[serverRole + "Count"] = Math.max(0, (cnt[serverRole + "Count"] || 0) - 1);
      if (draftRole) cnt[draftRole + "Count"] = (cnt[draftRole + "Count"] || 0) + 1;
    }

    for (const o of serverObservations) {
      const stillThere = newObservations.some(d => keyOf(d) === keyOf(o) && d.targetRole === o.targetRole);
      if (!stillThere) {
        const k = keyOf(o); const s = sessionData[k];
        const arr = s[o.targetRole + "Observers"] || [];
        s[o.targetRole + "Observers"] = arr.filter(x => occupantSlug(x) !== slug);
      }
    }
    for (const o of newObservations) {
      const wasThere = serverObservations.some(x => keyOf(x) === keyOf(o) && x.targetRole === o.targetRole);
      if (!wasThere) {
        const k = keyOf(o); const s = sessionData[k];
        const arr = s[o.targetRole + "Observers"] || [];
        if (!arr.some(x => occupantSlug(x) === slug)) {
          if (arr.length >= MAX_OBSERVERS) throw new Error("CONFLICT_OBSERVER");
          s[o.targetRole + "Observers"] = [...arr, { name: nameSnapshot, uid: myUid, slug }];
        }
      }
    }

    for (const k of touchedKeys) tx.set(sessionRefs[k], sessionData[k]);
    tx.set(counterRef, cnt);
    tx.set(studentRef, {
      name: nameSnapshot, nameLower: nameSnapshot.toLowerCase(), ownerUid: myUid,
      active: newActive, observations: newObservations,
      createdAt: (serverData && serverData.createdAt) || origState.createdAt || serverTimestamp(), updatedAt: serverTimestamp()
    });

    // Only true when the server's state differs from what THIS window last
    // knew *before this save* — i.e. something else changed it in between.
    // A normal single-window approve always finds them equal, since this
    // window's own prior approve is what last set origState.
    return { staleAtStart: !sameActive(origState.active, serverActive) || !sameObservations(origState.observations, serverObservations) };
  });

  origState = { active: newActive, observations: [...newObservations], createdAt: origState.createdAt || new Date() };
  historyStack = [];
  updateUndoButtons();
  await refreshActiveLock();
  refreshCourseScopedCounts();
  return { staleAtStart };
}

/* ---------------- confirmation banner (copy / email / ics) ---------------- */
function buildSummaryText() {
  const lines = [`VågaFråga registration for ${currentName}`, ""];
  lines.push("Active role:");
  lines.push(draftState.active ? `  ${draftState.active.role === "curious" ? "Curious Student" : "Interviewer"} — ${fmtEntry(draftState.active.course, draftState.active.date, draftState.active.slot)}` : "  (none)");
  lines.push("");
  lines.push("Observer roles:");
  if (draftState.observations.length) draftState.observations.forEach(o => lines.push(`  Observing: ${o.targetName} (whose role is "${o.targetRole === "curious" ? "Curious Student" : "Interviewer"}") — ${fmtEntry(o.course, o.date, o.slot)}`));
  else lines.push("  (none)");
  return lines.join("\n");
}
function collectEvents() {
  const events = [];
  if (draftState.active) events.push(draftState.active);
  draftState.observations.forEach(o => events.push(o));
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
// Safari (macOS/iOS) specifically intercepts a plain <a> click whose href
// is a "data:text/calendar" URI and shows its native "Add Event" popover
// right there, handing off to Calendar.app directly — no navigation, no
// file saved. That trick only fires for that exact href form though; a
// blob: URL (even opened as a plain navigation) is just downloaded, which
// is what was happening before. Other browsers don't have an equivalent
// one-click hook, so they get a normal file — .download forces a save
// instead of an unpredictable "should I display this?" prompt, and the
// toast tells the user to open it themselves to hand it to whatever
// calendar app is installed.
function addToCalendar(events) {
  const ics = buildIcs(events);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  if (isSafari) {
    const a = document.createElement("a");
    a.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
    a.click();
  } else {
    const blob = new Blob([ics], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "vagafraga.ics"; a.click();
    URL.revokeObjectURL(url);
    toast("A calendar file was downloaded — open it to add these events to your calendar app.");
  }
}
function showApprovalConfirmation(staleAtStart) {
  const text = buildSummaryText();
  const events = collectEvents();
  const overlay = document.getElementById("dialogOverlay");
  const box = document.getElementById("dialogBox");
  const staleNotice = staleAtStart
    ? `<p style="background:#fff6e0; border:1px solid #e6c766; padding:8px 12px; border-radius:6px;">Note: your saved selections had already changed since this page loaded them — most likely you (or someone using your name) have this open in another window, tab, or device. What you just submitted was saved on top of that latest data. Please double-check the summary below is what you intended.</p>`
    : "";
  box.innerHTML = `
    <p>The information below was recorded about you. You may come back later and modify it if you use the same name. Please note the assignment details yourself — we do not collect email addresses here, so we are not able to send you reminders or notifications.</p>
    ${staleNotice}
    <div style="display:flex; gap:8px; margin:10px 0; flex-wrap:wrap;">
      <button id="copyBtn" type="button">Copy</button>
      <button id="emailBtn" type="button">E-mail</button>
      <button id="icsBtn" type="button">Add to calendar</button>
    </div>
    <pre style="white-space:pre-wrap; background:#f5f5f5; padding:10px; border-radius:6px; font-size:12px;">${escapeHtml(text)}</pre>
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
  document.getElementById("icsBtn").addEventListener("click", () => addToCalendar(events));
  document.getElementById("closeConfirmBtn").addEventListener("click", () => overlay.classList.add("hidden"));
}
