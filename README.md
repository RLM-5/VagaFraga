# VågaFråga

A small class-coordination app: students sign up for an "active" role
(Curious Student / Interviewer) in a course session, and for observer
roles watching other students' sessions.

## Stack
- Static front end (`index.html`, `css/`, `js/`) — hosted on GitHub Pages.
- Firebase (Firestore + anonymous auth) as the shared data store — a
  visitor's browser talks to Firestore directly using the public web
  config in `js/firebase-config.js`; write access is governed by
  `firestore.rules`, not by keeping that config secret.

## Data
- `data/courses.json` — course code + name list.
- `data/schedule.json` — session instances (course, date, slot 0-3, type).
  This is currently a hand-written test schedule for 1FA352 and 1FA353;
  it will eventually be generated from a real TimeEdit calendar link by
  a small Python script.

## Firestore collections
- `students/{slug}` — one record per registered name.
- `sessions/{course}_{date}_{slot}` — who's doing what in a given
  course/date/timeslot; this is what the calendar boxes are colored from.
- `meta/counters` — running totals used for the active-role balance rule.

## Local preview
Any static file server works, e.g. from this folder:

    npx serve .

## Deployment
Pushed to GitHub, served via GitHub Pages from the repo root.
