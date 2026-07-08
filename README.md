# Course App

A local, offline "online course" viewer for downloaded video courses. No
accounts, no cloud — everything (course files and watch progress) stays on
this machine.

## Running it

```
./start.sh
```

Then open http://localhost:4173.

## Adding a new course

Just extract the course into its own folder directly under `Courses/`
(the parent of this `course-app` folder), next to the existing course
folders, e.g.:

```
Courses/
  AWS Certified Cloud Practitioner/
  AWS Certified Solutions Architect Zero to Mastery/
  Claude Code/
  My New Course/          <- drop it here
  course-app/
```

Reload the page (or restart the server) and it shows up automatically in
the course picker at the top — there's no config file to edit. The app
scans every folder under `Courses/` at request time and treats any folder
containing video files anywhere inside it as a course.

### What it detects automatically

- **Videos** — any `.mp4`, `.mov`, `.m4v`, `.avi`, `.mkv` file, at any depth
  inside the course folder.
- **Resources** — any `.pdf` file anywhere inside the course folder (shown
  in the "Resources" tab). Duplicate filenames found in more than one place
  are only listed once.
- **Slides** — the first `.zip` file whose name contains "slide" (case
  insensitive) is auto-extracted once (into `data/slides/<course-id>/`,
  outside your course folder) and every PDF inside it is listed under the
  "Slides" tab.

### How lectures get ordered and grouped into sections

Lecture filenames are matched against three known naming patterns, in this
order:

1. **`N.M- Title 123K.mp4`** (section.lecture, e.g. `2.10- Tracking Cost and
   Usage 290K.mp4`) — grouped directly into sections by the leading section
   number `N`.
2. **`N. Title 123K.mp4`** (flat index, e.g. `156. Demo Reviewing the Exam
   Guide 633K.mp4`) — sorted by `N`, then grouped into sections whenever a
   lecture title starts with "Important Points to Remember" (this is how
   Zero To Mastery courses mark the end of a module). If nothing matches
   that marker, everything lands in one section.
3. **`lessonN.mp4`** (bare index, no title in the filename) — the title is
   pulled from line `N` of a sibling `.txt` file in the same folder (one
   lecture title per line, in course order). If no `.txt` file is found,
   lectures are labeled `Lesson N`.

Anything that doesn't match any of these patterns is still watchable — it's
collected into a trailing **"Bonus Videos"** section, sorted alphabetically,
so nothing gets silently dropped even if a course uses a naming scheme
that isn't recognized yet.

If a new course's sections all show up as generic "Section 1, 2, 3..." (no
real names), that just means pattern 2 or 3 was used and no "Important
Points to Remember"-style marker was found — the lecture order and titles
are still correct, only the section grouping labels are generic.

### Notes

- Only add zipped courses once you've checked available disk space
  (`df -h`) — extracting a multi-GB zip needs roughly its extracted size
  free, temporarily on top of the zip itself.
- Progress is stored in `data/progress.json`, keyed by course and by each
  video's file path. Moving or renaming a course folder after you've
  started tracking progress on it will make that course's saved progress
  unreachable (the path changed), so watched/resume state effectively
  resets.
