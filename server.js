#!/usr/bin/env node
// Local "online course" experience for downloaded course folders.
// Zero external dependencies - just Node's built-in http/fs.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 4173;

// ---- Course discovery -------------------------------------------------
// Any folder directly under COURSES_ROOT that contains video files
// (anywhere inside it) is treated as a course. No manual registration
// needed - drop an extracted course folder in and it shows up.
const COURSES_ROOT = path.resolve(__dirname, '..');
const IGNORED_DIRS = new Set(['course-app', '.venv', '__MACOSX']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv']);

const DATA_DIR = path.join(__dirname, 'data');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');

// ---- Progress persistence --------------------------------------------

async function loadProgress() {
  try {
    const raw = await fsp.readFile(PROGRESS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveProgress(data) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = PROGRESS_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, PROGRESS_FILE);
}

// ---- Course content scanning -------------------------------------------

// Different course providers name lecture files differently. Recognize the
// shapes we've seen and fall back to "other" (bonus/unsorted) otherwise.
function classifyVideoFilename(filename) {
  const base = filename.replace(/\.(mp4|mov|m4v|avi|mkv)$/i, '');

  // "2.10- Tracking Cost and Usage 290K" (section.lecture- Title sizeK)
  let m = base.match(/^(\d+)\.(\d+)-\s*(.+?)\s+\d+K$/i);
  if (m) return { style: 'section-lecture', section: +m[1], lecture: +m[2], title: m[3].trim() };

  // "156. Demo Reviewing the Exam Guide and Sample Questions 633K" (N. Title sizeK)
  m = base.match(/^(\d+)\.\s+(.+?)\s+\d+K$/i);
  if (m) return { style: 'numbered', number: +m[1], title: m[2].replace(/_$/, '?').trim() };

  // "lesson23" - bare index, title has to come from a sibling outline .txt
  m = base.match(/^lesson(\d+)$/i);
  if (m) return { style: 'lesson', number: +m[1] };

  return { style: 'other', title: base.trim() };
}

async function findFilesRecursive(dir, matches, depth = 0, maxDepth = 8) {
  if (depth > maxDepth) return [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  let out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out = out.concat(await findFilesRecursive(full, matches, depth + 1, maxDepth));
    } else if (matches(e.name)) {
      out.push({ absPath: full, name: e.name, dir });
    }
  }
  return out;
}

function friendlyResourceName(filename) {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/^\d+\s*/, '')
    .replace(/\s*｜\s*Zero To Mastery.*$/i, '')
    .replace(/：/g, ':')
    .trim();
}

async function ensureSlidesExtracted(course, zipPath) {
  if (!zipPath) return [];
  const extractDir = path.join(DATA_DIR, 'slides', course.id);
  const marker = path.join(extractDir, '.extracted');
  try {
    await fsp.access(marker);
  } catch {
    await fsp.mkdir(extractDir, { recursive: true });
    await new Promise((resolve, reject) => {
      execFile('unzip', ['-o', '-q', zipPath, '-d', extractDir], (err) => {
        if (err) reject(err); else resolve();
      });
    }).catch(() => {});
    await fsp.writeFile(marker, new Date().toISOString()).catch(() => {});
  }
  // Slides may be nested one level deep (e.g. "Course Slides/Module 1.pdf")
  const found = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '__MACOSX') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.toLowerCase().endsWith('.pdf')) {
        found.push({ file: full, name: e.name });
      }
    }
  }
  await walk(extractDir);
  found.sort((a, b) => {
    const na = parseInt((a.name.match(/\d+/) || [0])[0], 10);
    const nb = parseInt((b.name.match(/\d+/) || [0])[0], 10);
    return na - nb;
  });
  return found.map((f, i) => ({
    id: `slide-${i}`,
    title: f.name.replace(/\.pdf$/i, ''),
    absPath: f.file,
  }));
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function discoverCourses() {
  let entries;
  try { entries = await fsp.readdir(COURSES_ROOT, { withFileTypes: true }); } catch { return []; }
  const courses = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
    const root = path.join(COURSES_ROOT, e.name);
    const videos = await findFilesRecursive(root, (n) => VIDEO_EXTS.has(path.extname(n).toLowerCase()));
    if (!videos.length) continue; // not a course
    courses.push({ id: slugify(e.name), title: e.name, root });
  }
  courses.sort((a, b) => a.title.localeCompare(b.title));
  return courses;
}

async function buildCourse(course) {
  const rawVideos = await findFilesRecursive(course.root, (n) => VIDEO_EXTS.has(path.extname(n).toLowerCase()));
  const classified = rawVideos.map((f) => ({ ...classifyVideoFilename(f.name), file: f.name, absPath: f.absPath, dir: f.dir }));

  // "lesson123" style files carry no title - resolve it from a sibling
  // outline .txt (one line per lecture, in course order) living in the
  // same directory as the lesson files.
  const lessonGroups = new Map();
  for (const v of classified) {
    if (v.style !== 'lesson') continue;
    if (!lessonGroups.has(v.dir)) lessonGroups.set(v.dir, []);
    lessonGroups.get(v.dir).push(v);
  }
  for (const [dir, vids] of lessonGroups) {
    let txtFiles = [];
    try { txtFiles = (await fsp.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.txt')); } catch {}
    let lines = [];
    if (txtFiles.length) {
      try {
        const raw = await fsp.readFile(path.join(dir, txtFiles[0]), 'utf8');
        lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length);
      } catch {}
    }
    vids.sort((a, b) => a.number - b.number);
    vids.forEach((v, i) => { v.title = lines[i] || `Lesson ${v.number}`; });
  }

  const bonus = classified.filter((v) => v.style === 'other');
  const main = classified.filter((v) => v.style !== 'other');
  const hasSectionLecture = main.some((v) => v.style === 'section-lecture');

  const sections = [];
  if (hasSectionLecture) {
    const bySection = new Map();
    for (const v of main) {
      if (!bySection.has(v.section)) bySection.set(v.section, []);
      bySection.get(v.section).push(v);
    }
    const secNums = [...bySection.keys()].sort((a, b) => a - b);
    for (const sec of secNums) {
      const vids = bySection.get(sec).sort((a, b) => a.lecture - b.lecture);
      vids.forEach((v) => { v.badge = `${v.section}.${v.lecture}`; });
      sections.push({ title: `Section ${sec}`, videos: vids });
    }
  } else {
    main.sort((a, b) => a.number - b.number);
    main.forEach((v) => { v.badge = String(v.number); });
    // A section ends right after a lecture titled "Important Points to
    // Remember" - ZTM-style courses use that as the module wrap-up, giving
    // a reliable, filename-derived section boundary with no outline file.
    let current = { title: null, videos: [] };
    for (const v of main) {
      current.videos.push(v);
      const m = v.title.match(/^Important Points to Remember:?\s*(.*)$/i);
      if (m) {
        current.title = m[1] || `Section ${sections.length + 1}`;
        sections.push(current);
        current = { title: null, videos: [] };
      }
    }
    if (current.videos.length) {
      current.title = `Section ${sections.length + 1}`;
      sections.push(current);
    }
    if (sections.length && !sections[0].title) sections[0].title = 'Getting Started';
  }

  if (bonus.length) {
    bonus.sort((a, b) => a.title.localeCompare(b.title));
    bonus.forEach((v) => { v.badge = '★'; });
    sections.push({ title: 'Bonus Videos', videos: bonus, isBonus: true });
  }

  sections.forEach((s, i) => { s.id = `sec-${i}`; if (!s.title) s.title = `Section ${i + 1}`; });

  // Resources: any PDF anywhere in the course, deduped by filename (some
  // course exports ship the same resource pack in two places).
  const pdfFiles = await findFilesRecursive(course.root, (n) => n.toLowerCase().endsWith('.pdf'));
  const seenNames = new Set();
  const resources = [];
  for (const f of pdfFiles) {
    if (seenNames.has(f.name)) continue;
    seenNames.add(f.name);
    resources.push({ id: `res-${resources.length}`, title: friendlyResourceName(f.name), absPath: f.absPath });
  }
  resources.sort((a, b) => a.title.localeCompare(b.title));

  // Slides: first zip anywhere in the course whose name mentions "slide".
  const slideZips = await findFilesRecursive(course.root, (n) => /slide/i.test(n) && n.toLowerCase().endsWith('.zip'));
  const slides = await ensureSlidesExtracted(course, slideZips[0] && slideZips[0].absPath);

  return {
    id: course.id,
    title: course.title,
    sections,
    resources,
    slides,
    totalVideos: main.length + bonus.length,
  };
}

// Map of opaque doc/video ids -> absolute file path, built at scan time.
const fileRegistry = new Map();
function registerFile(absPath) {
  const id = Buffer.from(absPath).toString('base64url');
  fileRegistry.set(id, absPath);
  return id;
}

async function getCourseData(courseId) {
  const courses = await discoverCourses();
  const course = courses.find((c) => c.id === courseId);
  if (!course) return null;
  const data = await buildCourse(course);
  for (const s of data.sections) {
    for (const v of s.videos) v.mediaId = registerFile(v.absPath);
  }
  for (const r of data.resources) r.docId = registerFile(r.absPath);
  for (const sl of data.slides) sl.docId = registerFile(sl.absPath);
  return data;
}

// ---- HTTP plumbing -------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': MIME['.json'] });
}

async function serveStatic(req, res, pathname) {
  const publicDir = path.join(__dirname, 'public');
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(publicDir, rel);
  if (!filePath.startsWith(publicDir)) return send(res, 403, 'Forbidden');
  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath);
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'Not found');
  }
}

async function serveFileWithRange(req, res, absPath, mime) {
  let stat;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    return send(res, 404, 'Not found');
  }
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(absPath).pipe(res);
    return;
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
  if (isNaN(start)) start = 0;
  if (isNaN(end) || end >= stat.size) end = stat.size - 1;
  if (start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  res.writeHead(206, {
    'Content-Type': mime,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(absPath, { start, end }).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { req.destroy(); reject(new Error('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api/courses' && req.method === 'GET') {
      const courses = await discoverCourses();
      return sendJson(res, 200, courses.map((c) => ({ id: c.id, title: c.title })));
    }

    if (pathname.startsWith('/api/course/') && req.method === 'GET') {
      const courseId = pathname.split('/')[3];
      const data = await getCourseData(courseId);
      if (!data) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/progress' && req.method === 'GET') {
      return sendJson(res, 200, await loadProgress());
    }

    if (pathname === '/api/progress' && req.method === 'POST') {
      const body = await readBody(req);
      let patch;
      try { patch = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      const current = await loadProgress();
      const courseId = patch.courseId;
      if (!courseId) return sendJson(res, 400, { error: 'courseId required' });
      current[courseId] = current[courseId] || { videos: {} };
      if (patch.mediaId) {
        current[courseId].videos[patch.mediaId] = {
          ...(current[courseId].videos[patch.mediaId] || {}),
          ...patch.entry,
          updatedAt: new Date().toISOString(),
        };
      }
      await saveProgress(current);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname.startsWith('/media/') && req.method === 'GET') {
      const id = pathname.slice('/media/'.length);
      const absPath = fileRegistry.get(id);
      if (!absPath) return send(res, 404, 'Not found');
      const mime = MIME[path.extname(absPath).toLowerCase()] || 'video/mp4';
      return serveFileWithRange(req, res, absPath, mime);
    }

    if (pathname.startsWith('/doc/') && req.method === 'GET') {
      const id = pathname.slice('/doc/'.length);
      const absPath = fileRegistry.get(id);
      if (!absPath) return send(res, 404, 'Not found');
      return serveFileWithRange(req, res, absPath, MIME['.pdf']);
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    send(res, 500, 'Internal error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Course app running at http://localhost:${PORT}`);
});
