(function () {
  const state = {
    courses: [],
    courseId: null,
    course: null,
    progress: {},
    currentVideo: null,
    flatVideos: [], // flattened, in-order, for prev/next
    saveTimer: null,
  };

  const el = {
    courseSelect: document.getElementById('course-select'),
    overallFill: document.getElementById('overall-fill'),
    overallLabel: document.getElementById('overall-label'),
    panelCurriculum: document.getElementById('panel-curriculum'),
    panelResources: document.getElementById('panel-resources'),
    panelSlides: document.getElementById('panel-slides'),
    player: document.getElementById('player'),
    lectureTitle: document.getElementById('lecture-title'),
    lectureSection: document.getElementById('lecture-section'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    completeBtn: document.getElementById('complete-btn'),
    docModal: document.getElementById('doc-modal'),
    docModalTitle: document.getElementById('doc-modal-title'),
    docModalFrame: document.getElementById('doc-modal-frame'),
    docModalOpen: document.getElementById('doc-modal-open'),
    docModalClose: document.getElementById('doc-modal-close'),
  };

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function courseProgress() {
    if (!state.progress[state.courseId]) state.progress[state.courseId] = { videos: {} };
    return state.progress[state.courseId];
  }

  function isWatched(mediaId) {
    const v = courseProgress().videos[mediaId];
    return !!(v && v.watched);
  }

  function savedPosition(mediaId) {
    const v = courseProgress().videos[mediaId];
    return v && v.position ? v.position : 0;
  }

  async function patchProgress(mediaId, entry) {
    const cp = courseProgress();
    cp.videos[mediaId] = { ...(cp.videos[mediaId] || {}), ...entry };
    renderProgressBars();
    try {
      await api('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courseId: state.courseId, mediaId, entry }),
      });
    } catch (e) { console.error('save failed', e); }
  }

  // ---- Course loading -----------------------------------------------

  async function loadCourseList() {
    state.courses = await api('/api/courses');
    el.courseSelect.innerHTML = '';
    for (const c of state.courses) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.title;
      el.courseSelect.appendChild(opt);
    }
  }

  async function loadCourse(courseId) {
    state.courseId = courseId;
    state.course = await api(`/api/course/${courseId}`);
    state.progress = await api('/api/progress');
    el.courseSelect.value = courseId;

    state.flatVideos = [];
    for (const s of state.course.sections) {
      for (const v of s.videos) state.flatVideos.push({ ...v, sectionTitle: s.title });
    }

    renderCurriculum();
    renderResources();
    renderSlides();
    renderProgressBars();

    // Resume where you left off: first unwatched video, or the first video.
    const resume = state.flatVideos.find((v) => !isWatched(v.mediaId)) || state.flatVideos[0];
    if (resume) selectVideo(resume.mediaId, { autoplay: false });
  }

  // ---- Curriculum sidebar --------------------------------------------

  function renderCurriculum() {
    el.panelCurriculum.innerHTML = '';
    for (const section of state.course.sections) {
      const secEl = document.createElement('div');
      secEl.className = 'section';

      const header = document.createElement('div');
      header.className = 'section-header';
      header.innerHTML = `
        <div class="section-header-top">
          <span>${escapeHtml(section.title)}</span>
          <span class="section-count" data-role="count"></span>
        </div>
        <div class="section-progress-track"><div class="section-progress-fill" data-role="fill"></div></div>
      `;
      const videosWrap = document.createElement('div');
      videosWrap.className = 'section-videos';

      header.addEventListener('click', () => videosWrap.classList.toggle('collapsed'));

      for (const v of section.videos) {
        const row = document.createElement('div');
        row.className = 'video-row';
        row.dataset.mediaId = v.mediaId;
        row.innerHTML = `
          <span class="video-check">✓</span>
          <span class="video-row-num">${escapeHtml(v.badge)}</span>
          <span class="video-row-title">${escapeHtml(v.title)}</span>
        `;
        row.addEventListener('click', () => selectVideo(v.mediaId, { autoplay: true }));
        videosWrap.appendChild(row);
      }

      secEl.appendChild(header);
      secEl.appendChild(videosWrap);
      el.panelCurriculum.appendChild(secEl);
    }
  }

  function renderProgressBars() {
    let totalDone = 0;
    let total = 0;
    const sectionEls = el.panelCurriculum.querySelectorAll('.section');
    state.course.sections.forEach((section, i) => {
      const done = section.videos.filter((v) => isWatched(v.mediaId)).length;
      total += section.videos.length;
      totalDone += done;
      const secEl = sectionEls[i];
      if (secEl) {
        secEl.querySelector('[data-role="count"]').textContent = `${done}/${section.videos.length}`;
        secEl.querySelector('[data-role="fill"]').style.width = `${section.videos.length ? (done / section.videos.length) * 100 : 0}%`;
      }
    });
    document.querySelectorAll('.video-row').forEach((row) => {
      const done = isWatched(row.dataset.mediaId);
      row.querySelector('.video-check').classList.toggle('done', done);
    });
    const pct = total ? Math.round((totalDone / total) * 100) : 0;
    el.overallFill.style.width = `${pct}%`;
    el.overallLabel.textContent = `${pct}%`;
  }

  // ---- Resources / Slides ---------------------------------------------

  function renderDocList(panel, docs, emptyMsg) {
    panel.innerHTML = '';
    if (!docs.length) {
      panel.innerHTML = `<div class="doc-row" style="cursor:default;">${escapeHtml(emptyMsg)}</div>`;
      return;
    }
    const list = document.createElement('div');
    list.className = 'doc-list';
    for (const d of docs) {
      const row = document.createElement('div');
      row.className = 'doc-row';
      row.textContent = d.title;
      row.addEventListener('click', () => openDoc(d));
      list.appendChild(row);
    }
    panel.appendChild(list);
  }

  function renderResources() {
    renderDocList(el.panelResources, state.course.resources, 'No resource PDFs found for this course.');
  }

  function renderSlides() {
    renderDocList(el.panelSlides, state.course.slides, 'No slide deck found for this course.');
  }

  function openDoc(doc) {
    el.docModalTitle.textContent = doc.title;
    el.docModalFrame.src = `/doc/${doc.docId}`;
    el.docModalOpen.href = `/doc/${doc.docId}`;
    el.docModal.classList.remove('hidden');
  }

  el.docModalClose.addEventListener('click', () => {
    el.docModal.classList.add('hidden');
    el.docModalFrame.src = '';
  });

  // ---- Player ----------------------------------------------------------

  function selectVideo(mediaId, { autoplay }) {
    const v = state.flatVideos.find((x) => x.mediaId === mediaId);
    if (!v) return;
    state.currentVideo = v;

    document.querySelectorAll('.video-row').forEach((row) => {
      row.classList.toggle('active', row.dataset.mediaId === mediaId);
    });
    const activeRow = el.panelCurriculum.querySelector(`.video-row[data-media-id="${cssEscape(mediaId)}"]`);
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });

    el.lectureTitle.textContent = v.title;
    el.lectureSection.textContent = v.sectionTitle;
    el.completeBtn.classList.toggle('done', isWatched(mediaId));
    el.completeBtn.textContent = isWatched(mediaId) ? '✓ Completed' : 'Mark complete';

    el.player.src = `/media/${mediaId}`;
    const pos = savedPosition(mediaId);
    const onLoaded = () => {
      if (pos > 1 && pos < el.player.duration - 3) el.player.currentTime = pos;
      if (autoplay) el.player.play().catch(() => {});
      el.player.removeEventListener('loadedmetadata', onLoaded);
    };
    el.player.addEventListener('loadedmetadata', onLoaded);
  }

  function currentIndex() {
    return state.flatVideos.findIndex((v) => v.mediaId === state.currentVideo?.mediaId);
  }

  el.prevBtn.addEventListener('click', () => {
    const i = currentIndex();
    if (i > 0) selectVideo(state.flatVideos[i - 1].mediaId, { autoplay: true });
  });

  el.nextBtn.addEventListener('click', () => {
    const i = currentIndex();
    if (i >= 0 && i < state.flatVideos.length - 1) selectVideo(state.flatVideos[i + 1].mediaId, { autoplay: true });
  });

  el.completeBtn.addEventListener('click', () => {
    if (!state.currentVideo) return;
    const nowDone = !isWatched(state.currentVideo.mediaId);
    patchProgress(state.currentVideo.mediaId, { watched: nowDone, position: nowDone ? 0 : savedPosition(state.currentVideo.mediaId) });
    el.completeBtn.classList.toggle('done', nowDone);
    el.completeBtn.textContent = nowDone ? '✓ Completed' : 'Mark complete';
  });

  let lastSaved = 0;
  el.player.addEventListener('timeupdate', () => {
    if (!state.currentVideo) return;
    const now = Date.now();
    if (now - lastSaved < 4000) return;
    lastSaved = now;
    patchProgress(state.currentVideo.mediaId, { position: el.player.currentTime });
  });

  el.player.addEventListener('pause', () => {
    if (!state.currentVideo) return;
    patchProgress(state.currentVideo.mediaId, { position: el.player.currentTime });
  });

  el.player.addEventListener('ended', () => {
    if (!state.currentVideo) return;
    patchProgress(state.currentVideo.mediaId, { watched: true, position: 0 });
    el.completeBtn.classList.add('done');
    el.completeBtn.textContent = '✓ Completed';
    const i = currentIndex();
    if (i >= 0 && i < state.flatVideos.length - 1) {
      selectVideo(state.flatVideos[i + 1].mediaId, { autoplay: true });
    }
  });

  // ---- Tabs --------------------------------------------------------

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      document.getElementById(`panel-${btn.dataset.tab}`).classList.remove('hidden');
    });
  });

  el.courseSelect.addEventListener('change', () => loadCourse(el.courseSelect.value));

  // ---- Utils --------------------------------------------------------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  // ---- Boot --------------------------------------------------------

  (async function init() {
    await loadCourseList();
    if (state.courses.length) await loadCourse(state.courses[0].id);
  })();
})();
