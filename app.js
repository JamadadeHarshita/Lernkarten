/* Wortschatz — German vocab flashcards with SM-2 spaced repetition
   ---------------------------------------------------------------
   Word shape:      { id, a, w, p, e, ex, exEn, t (topic), custom }
   Progress shape:  { interval (days), repetitions, ease, due (ms epoch) }

   SM-2 (the same scheduling algorithm Anki uses): each "Good" review
   roughly multiplies the gap until next review by the word's ease
   factor, "Easy" grows the gap faster, "Hard" grows it slower, and
   "Again" resets progress and brings the card back within the session.

   NOTE FOR FUTURE SYNC: everything below persists to localStorage only
   (per-device). To share the deck across friends, swap loadCustomWords/
   saveCustomWords and loadProgress/saveProgress for Supabase calls —
   the shapes above already match what you'd store in tables.
*/

const LS_PROGRESS = 'wortschatz_progress_v3';
const LS_CUSTOM = 'wortschatz_custom_words_v3';
const LS_THEME = 'wortschatz_theme';
const LS_TOPIC = 'wortschatz_topic';

const DAY_MS = 24 * 60 * 60 * 1000;
const MATURE_DAYS = 21; // Anki's convention for a "mastered" card

let ALL_WORDS = [];
let progress = {};
let sessionQueue = [];
let sessionIndex = 0;
let currentWord = null;
let isFlipped = false;
let germanVoice = null;
let activeTopic = 'Mixed';

function uid(prefix) { return prefix + '_' + Math.random().toString(36).slice(2, 10); }

function init() {
  const seeded = SEED_WORDS.map((n, i) => ({
    id: 'seed_' + i, a: n.a, w: n.w, p: n.p, e: n.e,
    ex: n.ex || '', exEn: n.exEn || '', t: n.t || 'Allgemein', custom: false
  }));
  ALL_WORDS = seeded.concat(loadCustomWords());
  progress = loadProgress();
  activeTopic = localStorage.getItem(LS_TOPIC) || 'Mixed';

  applyTheme(localStorage.getItem(LS_THEME) || 'dark');
  buildTopicChips();
  buildSessionQueue();
  renderStats();
  renderCarousel();
  renderCard();
  renderBrowseList();
  setupVoice();

  bindNav();
  bindTheme();
  bindFlip();
  bindAudio();
  bindRateButtons();
  bindAddForm();
  bindSearch();
}

/* ---------- storage ---------- */
function loadProgress() { try { return JSON.parse(localStorage.getItem(LS_PROGRESS)) || {}; } catch (e) { return {}; } }
function saveProgress() { localStorage.setItem(LS_PROGRESS, JSON.stringify(progress)); }
function loadCustomWords() { try { return JSON.parse(localStorage.getItem(LS_CUSTOM)) || []; } catch (e) { return []; } }
function saveCustomWords(list) { localStorage.setItem(LS_CUSTOM, JSON.stringify(list)); }

function getProgress(id) {
  return progress[id] || { interval: 0, repetitions: 0, ease: 2.5, due: 0 };
}

/* ---------- theme ---------- */
function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  document.getElementById('icon-sun').hidden = mode === 'dark';
  document.getElementById('icon-moon').hidden = mode !== 'dark';
  localStorage.setItem(LS_THEME, mode);
}
function bindTheme() {
  document.getElementById('btn-theme').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });
}

/* ---------- text to speech ---------- */
function setupVoice() {
  if (!('speechSynthesis' in window)) return;
  const pick = () => {
    const voices = speechSynthesis.getVoices();
    germanVoice = voices.find(v => v.lang === 'de-DE') || voices.find(v => v.lang && v.lang.startsWith('de')) || null;
  };
  pick();
  speechSynthesis.onvoiceschanged = pick;
}
function speakWord(word) {
  if (!('speechSynthesis' in window) || !word) return;
  speechSynthesis.cancel();
  const text = (word.a ? word.a + ' ' : '') + word.w;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'de-DE';
  if (germanVoice) utter.voice = germanVoice;
  utter.rate = 0.92;
  document.querySelectorAll('.audio-btn').forEach(b => b.classList.add('is-playing'));
  utter.onend = () => document.querySelectorAll('.audio-btn').forEach(b => b.classList.remove('is-playing'));
  speechSynthesis.speak(utter);
}
function bindAudio() {
  document.getElementById('btn-audio').addEventListener('click', (e) => {
    e.stopPropagation();
    speakWord(currentWord);
  });
  document.getElementById('btn-audio-back').addEventListener('click', (e) => {
    e.stopPropagation();
    speakWord(currentWord);
  });
}

/* ---------- SM-2 scheduling ---------- */
function previewIntervals(id) {
  const p = getProgress(id);
  return {
    again: '10m',
    hard: formatDays(computeNext(p, 1).interval),
    good: formatDays(computeNext(p, 2).interval),
    easy: formatDays(computeNext(p, 3).interval)
  };
}
function formatDays(days) {
  if (days < 1) return '<1d';
  if (days === 1) return '1d';
  if (days < 30) return days + 'd';
  if (days < 365) return Math.round(days / 30) + 'mo';
  return Math.round(days / 365) + 'y';
}
function computeNext(p, quality) {
  const next = { interval: p.interval, repetitions: p.repetitions, ease: p.ease };
  if (quality === 0) {
    next.repetitions = 0;
    next.interval = 0; // handled specially (session requeue)
    next.ease = Math.max(1.3, p.ease - 0.2);
  } else {
    next.repetitions = p.repetitions + 1;
    if (next.repetitions === 1) next.interval = 1;
    else if (next.repetitions === 2) next.interval = 6;
    else next.interval = Math.round(p.interval * p.ease);
    if (quality === 1) next.ease = Math.max(1.3, p.ease - 0.15);
    else if (quality === 3) next.ease = p.ease + 0.15;
  }
  return next;
}

/* ---------- topics ---------- */
function buildTopicChips() {
  const wrap = document.getElementById('topic-chips');
  const counts = {};
  ALL_WORDS.forEach(w => { counts[w.t] = (counts[w.t] || 0) + 1; });
  const topics = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

  wrap.innerHTML = '';
  const mixedChip = document.createElement('button');
  mixedChip.className = 'topic-chip' + (activeTopic === 'Mixed' ? ' is-active' : '');
  mixedChip.textContent = `Mixed · ${ALL_WORDS.length}`;
  mixedChip.onclick = () => selectTopic('Mixed');
  wrap.appendChild(mixedChip);

  topics.forEach(t => {
    const chip = document.createElement('button');
    chip.className = 'topic-chip' + (activeTopic === t ? ' is-active' : '');
    chip.textContent = `${t} · ${counts[t]}`;
    chip.onclick = () => selectTopic(t);
    wrap.appendChild(chip);
  });
}
function selectTopic(t) {
  activeTopic = t;
  localStorage.setItem(LS_TOPIC, t);
  document.querySelectorAll('.topic-chip').forEach(c => c.classList.remove('is-active'));
  buildTopicChips();
  buildSessionQueue();
  renderStats();
  renderCard();
}

/* ---------- session queue ---------- */
function wordsInScope() {
  return activeTopic === 'Mixed' ? ALL_WORDS : ALL_WORDS.filter(w => w.t === activeTopic);
}

function buildSessionQueue() {
  const now = Date.now();
  const scope = wordsInScope();
  const due = scope.filter(w => getProgress(w.id).due <= now);
  sessionQueue = shuffle(due);
  sessionIndex = 0;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------- rendering: stats ---------- */
function renderStats() {
  const scope = wordsInScope();
  const mastered = scope.filter(w => getProgress(w.id).interval >= MATURE_DAYS).length;
  document.getElementById('stat-total').textContent = scope.length;
  document.getElementById('stat-mastered').textContent = mastered;
  const pct = scope.length ? Math.round((mastered / scope.length) * 100) : 0;
  document.getElementById('progress-bar-fill').style.width = pct + '%';
}

/* ---------- rendering: carousel ---------- */
function renderCarousel() {
  const wrap = document.getElementById('carousel');
  wrap.innerHTML = '';
  const items = sessionQueue.slice(0, 12);
  items.forEach((w, i) => {
    const el = document.createElement('div');
    el.className = 'carousel-item' + (i === (sessionIndex % Math.max(items.length, 1)) ? ' is-active' : '');
    el.innerHTML = `<span>${escapeHtml(w.w)}</span><span class="dot"></span>`;
    wrap.appendChild(el);
  });
}

/* ---------- rendering: card ---------- */
function renderCard() {
  const flashcard = document.getElementById('flashcard');
  const empty = document.getElementById('empty-state');
  const rateRow = document.getElementById('rate-row');

  if (!sessionQueue.length) {
    flashcard.style.display = 'none';
    rateRow.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  flashcard.style.display = '';
  flashcard.style.transform = '';
  flashcard.style.opacity = '';
  resetFlipInstant();
  ['again', 'good', 'easy', 'hard'].forEach(n => setStamp(n, 0));
  rateRow.hidden = true;

  currentWord = sessionQueue[sessionIndex % sessionQueue.length];

  const artClass = 'article-tag art-' + (currentWord.a || '');
  const artEl = document.getElementById('card-article');
  artEl.textContent = currentWord.a || '';
  artEl.className = artClass;
  artEl.style.display = currentWord.a ? '' : 'none';

  const badgeText = currentWord.a ? 'NOUN' : 'WORD';
  document.getElementById('card-badge').textContent = badgeText;
  document.getElementById('card-badge-back').textContent = badgeText;
  document.getElementById('card-word').textContent = currentWord.w;
  document.getElementById('card-translation').textContent = currentWord.e;
  document.getElementById('card-plural').textContent = currentWord.p ? 'Plural: ' + currentWord.p : '';

  const exBlock = document.getElementById('example-block');
  if (currentWord.ex) {
    exBlock.hidden = false;
    document.getElementById('card-example-de').textContent = currentWord.ex;
    document.getElementById('card-example-en').textContent = currentWord.exEn || '';
  } else {
    exBlock.hidden = true;
  }

  renderCarousel();
}

function flipCard() {
  const flashcard = document.getElementById('flashcard');
  isFlipped = !isFlipped;
  flashcard.classList.toggle('is-flipped', isFlipped);
  const rateRow = document.getElementById('rate-row');
  if (isFlipped) {
    rateRow.hidden = false;
    const pv = previewIntervals(currentWord.id);
    document.getElementById('sub-again').textContent = pv.again;
    document.getElementById('sub-hard').textContent = pv.hard;
    document.getElementById('sub-good').textContent = pv.good;
    document.getElementById('sub-easy').textContent = pv.easy;
  } else {
    rateRow.hidden = true;
  }
}

function resetFlipInstant() {
  const inner = document.getElementById('flashcard-inner');
  const flashcard = document.getElementById('flashcard');
  inner.style.transition = 'none';
  flashcard.classList.remove('is-flipped');
  isFlipped = false;
  // force reflow so the "no transition" snap actually applies before we restore it
  void inner.offsetHeight;
  inner.style.transition = '';
}

/* ---------- swipe (Tinder-style rating) ---------- */
const SWIPE_THRESHOLD = 110;
const MAX_TILT = 16;
let dragState = null;

function bindFlip() {
  const card = document.getElementById('flashcard');
  card.addEventListener('pointerdown', onDragStart);
  card.addEventListener('pointermove', onDragMove);
  card.addEventListener('pointerup', onDragEnd);
  card.addEventListener('pointercancel', onDragEnd);
  document.querySelectorAll('.audio-btn').forEach(btn => {
    btn.addEventListener('pointerdown', e => e.stopPropagation());
  });
}

function onDragStart(e) {
  if (!currentWord) return;
  const card = document.getElementById('flashcard');
  card.setPointerCapture(e.pointerId);
  card.style.transition = 'none';
  dragState = { startX: e.clientX, startY: e.clientY, dx: 0, dy: 0 };
}

function onDragMove(e) {
  if (!dragState) return;
  dragState.dx = e.clientX - dragState.startX;
  dragState.dy = e.clientY - dragState.startY;
  if (!isFlipped) return; // only show drag feedback once the answer is visible
  const card = document.getElementById('flashcard');
  const tilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, dragState.dx / 14));
  card.style.transform = `translate(${dragState.dx}px, ${dragState.dy}px) rotate(${tilt}deg)`;
  const absX = Math.abs(dragState.dx), absY = Math.abs(dragState.dy);
  const horizontal = absX > absY;
  setStamp('good', horizontal && dragState.dx > 0 ? clamp01(dragState.dx / SWIPE_THRESHOLD) : 0);
  setStamp('again', horizontal && dragState.dx < 0 ? clamp01(-dragState.dx / SWIPE_THRESHOLD) : 0);
  setStamp('easy', !horizontal && dragState.dy < 0 ? clamp01(-dragState.dy / SWIPE_THRESHOLD) : 0);
  setStamp('hard', !horizontal && dragState.dy > 0 ? clamp01(dragState.dy / SWIPE_THRESHOLD) : 0);
}

function onDragEnd(e) {
  if (!dragState) return;
  const { dx, dy } = dragState;
  dragState = null;
  const card = document.getElementById('flashcard');
  card.style.transition = '';

  const absX = Math.abs(dx), absY = Math.abs(dy);
  const moved = Math.max(absX, absY);

  if (!isFlipped) {
    if (moved < 10) flipCard();
    resetCardTransform();
    return;
  }
  if (moved < 10) {
    flipCard();
    resetCardTransform();
    return;
  }

  const horizontal = absX > absY;
  if (horizontal && dx > SWIPE_THRESHOLD) { swipeOut('right'); return; }
  if (horizontal && dx < -SWIPE_THRESHOLD) { swipeOut('left'); return; }
  if (!horizontal && dy < -SWIPE_THRESHOLD) { swipeOut('up'); return; }
  if (!horizontal && dy > SWIPE_THRESHOLD) { swipeOut('down'); return; }
  resetCardTransform();
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function setStamp(name, val) {
  const el = document.getElementById('stamp-' + name);
  if (el) el.style.opacity = val;
}
function resetCardTransform() {
  const card = document.getElementById('flashcard');
  card.style.transform = '';
  ['again', 'good', 'easy', 'hard'].forEach(n => setStamp(n, 0));
}

const SWIPE_QUALITY = { left: 0, down: 1, right: 2, up: 3 };
const SWIPE_FLY = {
  left: 'translate(-650px, 40px) rotate(-28deg)',
  right: 'translate(650px, 40px) rotate(28deg)',
  up: 'translate(0, -750px) rotate(0deg)',
  down: 'translate(0, 750px) rotate(0deg)'
};
function swipeOut(direction) {
  const card = document.getElementById('flashcard');
  card.style.transition = 'transform 0.38s cubic-bezier(.2,.8,.2,1), opacity 0.38s ease';
  card.style.transform = SWIPE_FLY[direction];
  card.style.opacity = '0';
  const quality = SWIPE_QUALITY[direction];
  setTimeout(() => {
    card.style.transition = 'none';
    card.style.transform = '';
    card.style.opacity = '';
    rate(quality);
    ['again', 'good', 'easy', 'hard'].forEach(n => setStamp(n, 0));
  }, 320);
}

/* ---------- rating ---------- */
function bindRateButtons() {
  const dirByQuality = { 0: 'left', 1: 'down', 2: 'right', 3: 'up' };
  document.querySelectorAll('.rate-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const q = parseInt(btn.dataset.q, 10);
      swipeOut(dirByQuality[q]);
    });
  });
}
function rate(quality) {
  if (!currentWord) return;
  const p = getProgress(currentWord.id);
  const next = computeNext(p, quality);
  const now = Date.now();

  if (quality === 0) {
    next.due = now + 10 * 60 * 1000; // 10 minutes — practically "later this session"
    progress[currentWord.id] = next;
    saveProgress();
    // requeue a few cards ahead in this session so it comes back soon
    const wordCopy = currentWord;
    sessionQueue.splice(sessionIndex + 1, 0, wordCopy);
    sessionQueue = sessionQueue.filter((w, idx) => !(w.id === wordCopy.id && idx > sessionIndex + 1));
  } else {
    next.due = now + next.interval * DAY_MS;
    progress[currentWord.id] = next;
    saveProgress();
    sessionQueue.splice(sessionIndex % sessionQueue.length, 1);
  }

  renderStats();
  if (!sessionQueue.length) buildSessionQueue();
  renderCard();
}

/* ---------- browse ---------- */
function renderBrowseList(filter) {
  const list = document.getElementById('word-list');
  list.innerHTML = '';
  let words = ALL_WORDS.slice().sort((a, b) => a.w.localeCompare(b.w, 'de'));
  if (filter) {
    const f = filter.toLowerCase();
    words = words.filter(w => w.w.toLowerCase().includes(f) || w.e.toLowerCase().includes(f));
  }
  const frag = document.createDocumentFragment();
  words.forEach(w => {
    const p = getProgress(w.id);
    const status = p.interval >= MATURE_DAYS ? 'is-mature' : p.repetitions > 0 ? 'is-learning' : '';
    const row = document.createElement('div');
    row.className = 'word-row';
    row.innerHTML = `
      <span class="mini-tag art-${w.a || ''}">${w.a || '—'}</span>
      <div class="wr-main">
        <div class="wr-word">${escapeHtml(w.w)}${w.p ? ', ' + escapeHtml(w.p) : ''}</div>
        <div class="wr-english">${escapeHtml(w.e)}</div>
      </div>
      <span class="wr-status ${status}"></span>
    `;
    frag.appendChild(row);
  });
  list.appendChild(frag);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- nav ---------- */
function bindNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));
  document.getElementById('btn-add-from-empty').addEventListener('click', () => showView('add'));
}
function showView(name) {
  ['study', 'browse', 'add'].forEach(v => { document.getElementById('view-' + v).hidden = (v !== name); });
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('is-active', btn.dataset.view === name));
  if (name === 'browse') renderBrowseList(document.getElementById('search-input').value);
  if (name === 'study') { renderStats(); renderCard(); }
}

/* ---------- add word ---------- */
function bindAddForm() {
  const articleButtons = document.querySelectorAll('.article-choice');
  let selectedArticle = 'der';
  articleButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      articleButtons.forEach(b => b.classList.remove('is-selected'));
      btn.classList.add('is-selected');
      selectedArticle = btn.dataset.art;
    });
  });

  document.getElementById('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const word = document.getElementById('input-word').value.trim();
    const plural = document.getElementById('input-plural').value.trim();
    const english = document.getElementById('input-english').value.trim();
    const example = document.getElementById('input-example').value.trim();
    const exampleEn = document.getElementById('input-example-en').value.trim();
    const addedBy = document.getElementById('input-addedby').value.trim();
    if (!word || !english) return;

    const newWord = {
      id: uid('custom'), a: selectedArticle, w: word, p: plural,
      e: english, ex: example, exEn: exampleEn, t: 'Meine Wörter', addedBy, custom: true
    };
    const custom = loadCustomWords();
    custom.push(newWord);
    saveCustomWords(custom);
    ALL_WORDS.push(newWord);

    document.getElementById('add-form').reset();
    articleButtons.forEach(b => b.classList.remove('is-selected'));
    document.querySelector('.article-choice[data-art="der"]').classList.add('is-selected');
    selectedArticle = 'der';

    const note = document.getElementById('form-note');
    note.textContent = `"${word}" added to your deck.`;
    setTimeout(() => { note.textContent = ''; }, 2500);

    buildTopicChips();
    buildSessionQueue();
    renderStats();
  });
}

/* ---------- search ---------- */
function bindSearch() {
  document.getElementById('search-input').addEventListener('input', (e) => renderBrowseList(e.target.value));
}

init();
