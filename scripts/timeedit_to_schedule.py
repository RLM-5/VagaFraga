#!/usr/bin/env python3
"""
Convert a TimeEdit .ics export (Uppsala University, Master Programme in
Physics) plus the MaFyCourses course catalog into this app's
data/courses.json and data/schedule.json.

Usage:
    python3 scripts/timeedit_to_schedule.py --ics /path/to/schedule.ics \
        --catalog "/path/to/MaFyCourses.catalog.json"

The catalog file is read at run time and never copied into the repo — it
holds full syllabus text that has no reason to be public, and only the
course code + short name derived from it end up in the committed output.

What this does, in order:
  1. Parses every VEVENT out of the ics (unfolding lines, un-escaping
     iCal's commas).
  2. Splits each SUMMARY into: cohort/group codes (discarded — they say
     which student groups attend, not what the course is), the course
     name (TimeEdit's own text, ending in "."), the activity type, and
     staff. TimeEdit doesn't put course codes in this export at all.
  3. Keeps only the activity types in KEEP_ACTIVITIES, and only sessions
     whose local Stockholm date falls within [FIRST_MONDAY, LAST_FRIDAY]
     on a weekday.
  4. Matches the parsed course name against the catalog's "Name" field to
     get the real code + ShortName. A miss is reported loudly rather than
     guessed at.
  5. Matches each session's local start/end time against the app's four
     fixed daily slots; a session that doesn't land on one exactly is
     reported and dropped rather than silently mis-slotted.
  6. Writes data/courses.json and data/schedule.json.
"""
import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

REPO_ROOT = Path(__file__).resolve().parent.parent
TZ = ZoneInfo("Europe/Stockholm")

# Only these TimeEdit activity types become calendar boxes; everything
# else (exams, seminars, group work, admin/social events, ...) is dropped.
KEEP_ACTIVITIES = {"Lecture", "Lesson", "Laboratory experiment", "Tutorials"}

# Must match FIRST_MONDAY / LAST_MONDAY in js/app.js.
FIRST_MONDAY = "2026-09-21"
LAST_FRIDAY = "2026-10-30"

CANON_SLOTS = [("08:15", "10:00"), ("10:15", "12:00"), ("13:15", "15:00"), ("15:15", "17:00")]
ESCAPED_COMMA = "\\,"
KNOWN_ACTIVITIES = {
    "Lecture", "Lesson", "Computer lab", "Seminar", "Group work", "Exam",
    "Tillfälle", "Exercise", "Workshop", "Laboratory experiment", "Tutorials",
    "Study visit", "Test", "Introduction", "Presentation", "Problem solving session",
} | KEEP_ACTIVITIES


def parse_ics_events(ics_path):
    raw = Path(ics_path).read_text(encoding="utf-8")
    lines = raw.replace("\r\n", "\n").split("\n")
    unfolded = []
    for line in lines:
        if line.startswith(" ") or line.startswith("\t"):
            if unfolded:
                unfolded[-1] += line[1:]
        else:
            unfolded.append(line)
    events, cur = [], {}
    for line in unfolded:
        if line == "BEGIN:VEVENT":
            cur = {}
        elif line == "END:VEVENT":
            events.append(cur)
        elif ":" in line:
            k, v = line.split(":", 1)
            cur[k.split(";")[0]] = v
    return events


def is_group_code(part):
    if re.search(r"[a-zåäö][A-ZÅÄÖ]", part):
        return True
    if not re.search(r"[a-zåäö]", part):
        return True
    if re.match(r"^[A-Z]\d", part):  # e.g. "F4.He", "F5.T.f"
        return True
    return False


def parse_summary(raw_summary):
    parts = [p.strip() for p in raw_summary.split(ESCAPED_COMMA)]
    idx = 0
    while idx < len(parts) and is_group_code(parts[idx]):
        idx += 1
    name_parts = []
    while idx < len(parts):
        part = parts[idx]
        name_parts.append(part)
        idx += 1
        if part.rstrip().endswith(".") or part in KNOWN_ACTIVITIES:
            break
    activity = None
    if name_parts and name_parts[-1] in KNOWN_ACTIVITIES:
        activity = name_parts.pop()
    course_name = re.sub(r"\.\s*$", "", ", ".join(name_parts)).strip()
    rest = parts[idx:]
    if activity is None:
        activity = rest[0] if rest else None
    return course_name, activity


def to_local(dtstr):
    dt = datetime.strptime(dtstr, "%Y%m%dT%H%M%SZ").replace(tzinfo=ZoneInfo("UTC"))
    return dt.astimezone(TZ)


def load_catalog(catalog_path):
    with open(catalog_path, encoding="utf-8") as f:
        courses = json.load(f)["courses"]
    return {c["Name"].strip().lower().rstrip("."): c for c in courses}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ics", required=True, help="Path to the TimeEdit .ics export")
    ap.add_argument("--catalog", required=True, help="Path to the MaFyCourses catalog JSON")
    ap.add_argument("--out-dir", default=str(REPO_ROOT / "data"))
    args = ap.parse_args()

    events = parse_ics_events(args.ics)
    catalog_by_name = load_catalog(args.catalog)

    unmatched_names = set()
    dropped_slot = []
    schedule_keys = {}   # (code, date, slot) -> {course,date,slot,type}
    used_courses = {}    # code -> name

    for e in events:
        if "DTSTART" not in e or "DTEND" not in e or "T" not in e["DTSTART"]:
            continue
        name, activity = parse_summary(e.get("SUMMARY", ""))
        if activity not in KEEP_ACTIVITIES:
            continue

        start = to_local(e["DTSTART"])
        end = to_local(e["DTEND"])
        date_str = start.strftime("%Y-%m-%d")
        if not (FIRST_MONDAY <= date_str <= LAST_FRIDAY):
            continue
        if start.weekday() >= 5:  # Sat/Sun
            continue

        pair = (start.strftime("%H:%M"), end.strftime("%H:%M"))
        if pair not in CANON_SLOTS:
            dropped_slot.append((date_str, pair, activity, name))
            continue
        slot = CANON_SLOTS.index(pair)

        cat = catalog_by_name.get(name.strip().lower().rstrip("."))
        if not cat:
            unmatched_names.add(name)
            continue
        code, short_name = cat["Code"], cat.get("ShortName") or cat["Name"]

        used_courses[code] = short_name
        key = (code, date_str, slot)
        schedule_keys[key] = {"course": code, "date": date_str, "slot": slot, "type": activity}

    courses_out = [{"code": c, "name": n} for c, n in sorted(used_courses.items())]
    schedule_out = sorted(schedule_keys.values(), key=lambda x: (x["date"], x["slot"], x["course"]))

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "courses.json").write_text(json.dumps(courses_out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out_dir / "schedule.json").write_text(json.dumps(schedule_out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Wrote {len(courses_out)} courses and {len(schedule_out)} sessions to {out_dir}")
    if unmatched_names:
        print(f"\n{len(unmatched_names)} course name(s) had NO catalog match — not included, check by hand:")
        for n in sorted(unmatched_names):
            print(f"  - {n!r}")
    if dropped_slot:
        print(f"\n{len(dropped_slot)} kept-type session(s) fell outside the 4 fixed daily slots — dropped:")
        for date_str, pair, activity, name in dropped_slot:
            print(f"  - {date_str} {pair[0]}-{pair[1]}  [{activity}]  {name}")
    if not unmatched_names and not dropped_slot:
        print("No unmatched courses, no dropped sessions.")


if __name__ == "__main__":
    main()
