# VågaFråga — intended functionality

This documents the selection logic as actually implemented in `js/app.js`,
written after the architectural refactor to unified `draftState`. It is the
reference to check the app's behavior against; if the app ever disagrees
with this document, one of them is wrong and should be reconciled.

## Identity

- A student is identified purely by the **name they type**, normalized to a
  `slug` (lowercased, diacritics stripped, non-alphanumerics collapsed to
  hyphens). This slug is the Firestore document ID under `students/{slug}`
  and the true identity key everywhere in the app.
- Firebase Anonymous Auth gives each browser a `uid`, but this is **only**
  used for write-provenance (`ownerUid`, `uid` fields) — never for "is this
  me" comparisons. A student can return on a different device/browser,
  type the same name, and it's recognized as them.
- 700ms after the name field stops changing, the app looks up
  `students/{slug}`:
  - **New name** → fresh start: blank draft, `mainApp` unhidden.
  - **Existing name** → duplicate-name flow: shows what that name is
    already registered for, asks "is this you?" with two confirmation
    steps ("Proceed — this is me" → "Are you really sure?") before loading
    their saved selections as the starting draft.

## Course picker

- Two-column layout: left = searchable full course list with checkboxes,
  right = only the currently-selected courses, for a compact overview.
- "Select all" / "Unselect all" toggles all courses at once.
- Search filters the **left** list only; the right list (ticked courses) is
  always shown in full regardless of the search box.
- Unticking a course that has an active-role pick or observations tied to
  it cascades:
  - If the active-role pick is **locked** (see below), the course is
    silently re-ticked and the lock explanation is shown instead — a locked
    active role can never be dropped this way.
  - Otherwise, the active pick and/or any observations in that course are
    removed, and a toast names exactly what was removed ("Removed your
    active-role selection and 2 observations — you unticked its course.").
  - This cascade is a real content change and is undoable; the course tick
    itself is not (undo only ever touches calendar selections, never course
    search/ticking).
- "+ Add another course or missing event" opens a modal to submit a new
  course code+name, or (if the code matches an existing course) just a
  missing session, to the shared `customCourses`/`customSchedule`
  collections (visible to everyone live, append-only from the client).
  Submitting it auto-ticks the course in the picker but does **not**
  register any role for it — the student still has to go pick a slot.

## Four tabs, one shared calendar design

Each tab shows the same 5-day × 4-slot grid for the current week, restricted
to sessions of currently-ticked courses. Boxes are color-tiered and sized
dynamically to fit however many sessions land in one cell (1–2 stacked, or a
2-wide grid beyond that), font size shrinking with row count so text never
overflows a resized box.

### Tab 1 — Active role

- A Curious Student / Interviewer radio picks which role's availability is
  shown. Boxes are:
  - **green**: open for the selected role, no one has the opposite role
    there.
  - **green-orange**: open for the selected role, but the *opposite* role
    is already taken there (still pickable).
  - **red, not clickable**: the selected role is already taken there by
    someone else — clicking explains why.
- Clicking an open box sets that as the student's one active-role pick,
  replacing any previous pick.
- **Balance rule**: if the class-wide count of one role exceeds the other
  by more than 7, the overrepresented role's radio is disabled and, if it
  was selected, forcibly flips to the other role, with a notice explaining
  the imbalance and giving the actual numbers.
- **Lock**: once a student's active-role pick has at least one observer
  registered against it, it becomes locked — every path that would change
  or drop it (box click, role radio swap, unticking its course) is blocked
  and shows who's observing them, telling them to coordinate with those
  observers first since it can't be changed here.
- Swapping the role radio while a session is already picked tries to swap
  that pick to the new role in place: succeeds if that role is open there
  (box stays highlighted, summary updates), or reverts the radio with an
  explanation if not. With no pick yet, the radio just changes which
  role's boxes are shown — pure navigation, nothing to swap.

### Tabs 2 & 3 — Observe curious student / Observe interviewer

- Show boxes only where someone has taken the relevant role. Box color
  reflects how many observers that person already has: green (0),
  green-orange (1), orange-red (2), red/not clickable (3, the max).
- Clicking toggles that observation on/off in the draft. At exactly 2
  existing observers, clicking pops a "please consider someone else"
  confirmation the student can override ("I don't have other options —
  select anyway").
- A student can never observe themselves — clicking a session where they
  are the occupant is blocked with an explanation, checked by resolved
  identity (slug), not raw name text, so it also catches old records
  written before the slug field existed.
- A notice appears if fewer than 3 people of the target role are
  registered yet across the student's *currently ticked* courses,
  suggesting they wait and come back later; approving just the active role
  in the meantime is fine.

### Tab 4 — Reserved observer

- Same box/click logic as tabs 2/3, but with its own Curious/Interviewer
  radio, for when a student can't find a suitable session in tabs 2 and 3
  and needs to observe two of the same role instead of one of each.

## Undo / Erase

- Every calendar-affecting action (active pick, role swap, add/remove an
  observation, the course-untick cascade) pushes a snapshot of just
  `{active, observations}` onto a history stack before applying.
- **Undo last** (↶): pops one snapshot and restores it.
- **Undo all** (⏮): clears the whole history stack and restores
  `{active, observations}` to whatever was last actually saved to
  Firestore (blank, for a first-time student).
- **Erase all** (✖, red): wipes the current draft to nothing regardless of
  what's saved — distinct from Undo all for a returning student. Respects
  the active-role lock (leaves a locked pick in place, tells the student
  why) and is itself a content change, so it's undoable.
- None of the three touch course search text or which courses are ticked —
  by design, undo/erase is scoped to calendar selections only.

## Approve

- Writes the draft's `active`/`observations` to `students/{slug}`, updates
  every touched `sessions/{course_date_slot}` doc's occupant/observer
  lists, and adjusts the global curious/interviewer counters — all inside
  one Firestore transaction, so a same-slot race with another student
  either fully applies or fully fails.
- On a conflict (someone else grabbed the active slot, or an observed
  session hit its observer cap while the student was choosing), the
  transaction throws and **nothing is saved**; a dialog says exactly that
  and which kind of conflict occurred, asking the student to review and
  re-pick.
- On success, a confirmation dialog shows the saved selections as text,
  with Copy / E-mail / Add-to-calendar actions (the calendar one uses
  Safari's native `data:text/calendar` handoff on Safari, a downloaded
  `.ics` file elsewhere — never a third-party calendar service).
- After approving, the draft's saved slice becomes the new `origState`,
  history is cleared, and the active-role lock status is refreshed.

## Deadline weeks

Week 42 (containing 14 Oct) is flagged as the HW2 submission deadline
(14 Oct, 21:00); weeks 43–44 are flagged post-deadline, extension possible
only if justified by no free options being left in prior weeks. Both are
just visual notices in the calendar header — they don't block anything.
