import { escapeHtml, highlight } from './highlight';

/** A simulated Raya player that follows the library's real queue rules (see src/player/Player.ts). */

type Source = 'spotify' | 'youtube' | 'soundcloud';
type LoopMode = 'off' | 'track' | 'queue';
type FilterName = 'nightcore' | 'vaporwave' | 'bassBoost' | 'eightD';

interface CatalogTrack {
  id: string;
  title: string;
  author: string;
  length: number;
  source: Source;
  hue: number;
}

interface DemoTrack extends CatalogTrack {
  uid: number;
  requester: string;
}

const CATALOG: CatalogTrack[] = [
  { id: 'nt1', title: 'Neon Tide', author: 'Lumen Coast', length: 192_000, source: 'spotify', hue: 12 },
  { id: 'gh2', title: 'Glass Harbor', author: 'Lumen Coast', length: 178_000, source: 'spotify', hue: 200 },
  { id: 'pm3', title: 'Paper Moons', author: 'Sora Vale', length: 221_000, source: 'youtube', hue: 260 },
  { id: 'kl4', title: 'Kilig', author: 'Tala Bloom', length: 167_000, source: 'spotify', hue: 330 },
  { id: 'mj5', title: 'Midnight Jeepney', author: 'Kalye Echo', length: 206_000, source: 'soundcloud', hue: 28 },
  { id: 'sh6', title: 'Satellite Hearts', author: 'Nova Parade', length: 245_000, source: 'youtube', hue: 280 },
  { id: 'sb7', title: 'Slow Burn Sunday', author: 'Amber & Ash', length: 213_000, source: 'spotify', hue: 38 },
  { id: 'rs8', title: 'Rooftop Static', author: 'Dusk Radio', length: 159_000, source: 'soundcloud', hue: 190 },
  { id: 'ca9', title: 'Coral Arcade', author: 'Pixel Reef', length: 185_000, source: 'youtube', hue: 350 },
  { id: 'aa10', title: 'Afterglow Avenue', author: 'Nova Parade', length: 228_000, source: 'youtube', hue: 300 },
  { id: 'ls11', title: 'Lantern Season', author: 'Tala Bloom', length: 197_000, source: 'spotify', hue: 45 },
  { id: 'lt12', title: 'Low Tide Letters', author: 'Sora Vale', length: 252_000, source: 'spotify', hue: 215 },
  { id: 'sb13', title: 'Static Bloom', author: 'Dusk Radio', length: 182_000, source: 'soundcloud', hue: 160 },
  { id: 'hr14', title: 'Harana 2AM', author: 'Kalye Echo', length: 235_000, source: 'spotify', hue: 250 },
  { id: 'vc15', title: 'Velvet Circuit', author: 'Pixel Reef', length: 171_000, source: 'youtube', hue: 320 },
  { id: 'ss16', title: 'Salt & Starlight', author: 'Amber & Ash', length: 209_000, source: 'spotify', hue: 20 },
];

const REQUESTERS = ['mika', 'sam', 'alex', 'jun'];
const DEMO_SPEED = 20;
const MAX_LOG = 90;

const fmt = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const initials = (title: string) =>
  title
    .split(/\s+/)
    .filter((w) => /\w/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

export function mountPlayerDemo(root: HTMLElement): void {
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let uid = 0;
  const make = (track: CatalogTrack, requester = REQUESTERS[uid % REQUESTERS.length]!): DemoTrack => ({
    ...track,
    uid: ++uid,
    requester,
  });

  let current: DemoTrack | null = null;
  let queue: DemoTrack[] = [];
  let history: DemoTrack[] = [];
  let paused = false;
  let loop: LoopMode = 'off';
  let autoplay = false;
  let volume = 100;
  let position = 0;
  const filters = new Set<FilterName>();
  let started = performance.now();
  let visible = false;

  // ---------- Console ----------
  const consoleEl = $('[data-console]');
  function log(kind: 'call' | 'event' | 'http' | 'note', main: string, detail = '') {
    const time = ((performance.now() - started) / 1000).toFixed(2).padStart(6, ' ');
    const line = document.createElement('div');
    line.className = `line ${kind}`;
    let body = '';
    if (kind === 'call') body = `<span class="prompt">›</span><code>${highlight(main)}</code>`;
    if (kind === 'event') body = `<span class="badge">${escapeHtml(main)}</span><span class="detail">${escapeHtml(detail)}</span>`;
    if (kind === 'http') body = `<span class="badge http">PATCH</span><code class="json">${highlight(main)}</code>`;
    if (kind === 'note') body = `<span class="note">${escapeHtml(main)}</span>`;
    line.innerHTML = `<span class="time">+${time}s</span>${body}`;
    consoleEl.appendChild(line);
    while (consoleEl.children.length > MAX_LOG) consoleEl.firstElementChild!.remove();
    consoleEl.scrollTo({ top: consoleEl.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  const speedMultiplier = () => (filters.has('nightcore') ? 1.1 * 1.05 : filters.has('vaporwave') ? 0.85 : 1);

  function filterPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    if (filters.has('bassBoost')) {
      payload.equalizer = [1, 0.85, 0.65, 0.4, 0.15].map((f, band) => ({ band, gain: Math.round(0.35 * f * 10000) / 10000 }));
    }
    if (filters.has('nightcore')) payload.timescale = { speed: 1.1, pitch: 1.125, rate: 1.05 };
    if (filters.has('vaporwave')) payload.timescale = { speed: 0.85, pitch: 0.8, rate: 1 };
    if (filters.has('eightD')) payload.rotation = { rotationHz: 0.2 };
    return payload;
  }

  // ---------- Raya-like behaviour ----------
  function start(track: DemoTrack, { history: pushHistory = true } = {}) {
    const previous = current;
    if (previous && pushHistory && previous !== track) pushToHistory(previous);
    if (previous) log('event', 'trackEnd', `${previous.title} · replaced`);
    current = track;
    position = 0;
    paused = false;
    log('http', `{ "track": { "encoded": "QAAA…" }, "paused": false }`);
    log('event', 'trackStart', `${track.title} · ${track.author} (requested by ${track.requester})`);
    render();
  }

  function pushToHistory(track: DemoTrack) {
    history.push(track);
    if (history.length > 50) history.shift();
  }

  function pickRelated(ended: DemoTrack): DemoTrack | null {
    const recent = new Set([ended.id, ...history.slice(-8).map((t) => t.id), ...queue.map((t) => t.id)]);
    const sameArtist = CATALOG.filter((t) => t.author === ended.author && !recent.has(t.id));
    const any = CATALOG.filter((t) => !recent.has(t.id));
    const prefix = ended.source === 'spotify' ? 'spsearch' : ended.source === 'soundcloud' ? 'scsearch' : 'ytsearch';
    if (ended.source === 'youtube') log('note', `autoplay "youtube mix of ${ended.title}"`);
    else if (ended.source === 'spotify') log('note', `autoplay "sprec:mix:track:${ended.id}" → error (no Extended quota)`);
    const pick = sameArtist[0] ?? any[Math.floor(Math.random() * any.length)] ?? null;
    if (pick) log('note', `autoplay "${prefix}:${ended.author}" → picked "${pick.title}"`);
    return pick ? make(pick, ended.requester) : null;
  }

  function advance(ended: DemoTrack | null, reason: 'finished' | 'skip') {
    if (ended && reason === 'finished' && loop === 'track') {
      current = null;
      start(ended, { history: false });
      return;
    }
    if (ended) {
      pushToHistory(ended);
      if (loop === 'queue') {
        queue.push(make(ended, ended.requester));
        log('event', 'queueUpdate', `loop queue: ${ended.title} moved to the end`);
      }
    }
    const next = queue.shift();
    if (next) {
      if (reason === 'finished') current = null;
      start(next, { history: false });
      return;
    }
    if (autoplay && ended) {
      const related = pickRelated(ended);
      if (related) {
        if (reason === 'finished') current = null;
        start(related, { history: false });
        return;
      }
    }
    if (reason === 'skip' && ended) {
      log('http', `{ "track": { "encoded": null } }`);
      log('event', 'trackEnd', `${ended.title} · stopped`);
    }
    current = null;
    position = 0;
    log('event', 'queueEnd', ended ? `last track: ${ended.title}` : '');
    render();
  }

  function finish() {
    if (!current) return;
    const ended = current;
    log('event', 'trackEnd', `${ended.title} · finished`);
    advance(ended, 'finished');
  }

  // ---------- Actions ----------
  const actions: Record<string, () => void> = {
    toggle() {
      if (!current) {
        const next = queue.shift();
        if (!next) return log('note', 'Queue is empty. Add a track from the search box.');
        log('call', 'await player.play()');
        start(next, { history: false });
        return;
      }
      paused = !paused;
      log('call', paused ? 'await player.pause()' : 'await player.resume()');
      log('http', `{ "paused": ${paused} }`);
      render();
    },
    skip() {
      log('call', 'await player.skip()');
      if (!current && queue.length === 0) return log('note', 'skip() → null (nothing to skip)');
      advance(current, 'skip');
    },
    previous() {
      log('call', 'await player.previous()');
      const prev = history.pop();
      if (!prev) return log('note', 'previous() → null (history is empty)');
      if (current) queue.unshift(current);
      start(prev, { history: false });
    },
    loop() {
      loop = loop === 'off' ? 'queue' : loop === 'queue' ? 'track' : 'off';
      log('call', `player.setLoop('${loop}')`);
      log('note', 'Local setting: no request needed');
      render();
    },
    shuffle() {
      if (queue.length < 2) return log('note', 'Add at least two tracks to shuffle');
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j]!, queue[i]!];
      }
      log('call', 'player.queue.shuffle()');
      log('event', 'queueUpdate', `${queue.length} tracks shuffled`);
      render();
    },
    autoplay() {
      autoplay = !autoplay;
      log('call', `player.setAutoplay(${autoplay})`);
      render();
    },
  };

  root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) =>
    button.addEventListener('click', () => actions[button.dataset.action!]?.()),
  );

  root.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((button) =>
    button.addEventListener('click', () => {
      const name = button.dataset.filter as FilterName;
      const on = !filters.has(name);
      if (on && name === 'nightcore') filters.delete('vaporwave');
      if (on && name === 'vaporwave') filters.delete('nightcore');
      on ? filters.add(name) : filters.delete(name);
      const call =
        name === 'bassBoost'
          ? `await player.filters.bassBoost('${on ? 'high' : 'off'}')`
          : `await player.filters.${name}(${on ? '' : 'false'})`;
      log('call', call);
      log('http', JSON.stringify({ filters: filterPayload() }));
      render();
    }),
  );

  const volumeInput = $<HTMLInputElement>('[data-volume]');
  volumeInput.addEventListener('input', () => {
    volume = Number(volumeInput.value);
    $('[data-volume-out]').textContent = String(volume);
  });
  volumeInput.addEventListener('change', () => {
    log('call', `await player.setVolume(${volume})`);
    log('http', `{ "volume": ${volume} }`);
  });

  const progress = $('[data-progress]');
  const seekTo = (clientX: number) => {
    if (!current) return;
    const rect = progress.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    position = Math.floor(current.length * ratio);
    log('call', `await player.seek(${position})`);
    log('http', `{ "position": ${position} }`);
    renderProgress();
  };
  progress.addEventListener('click', (event) => seekTo(event.clientX));
  progress.addEventListener('keydown', (event) => {
    if (!current || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
    event.preventDefault();
    const target = Math.min(current.length, Math.max(0, position + (event.key === 'ArrowRight' ? 10_000 : -10_000)));
    const rect = progress.getBoundingClientRect();
    seekTo(rect.left + (target / current.length) * rect.width);
  });

  $('[data-clear]').addEventListener('click', () => {
    consoleEl.innerHTML = '';
    started = performance.now();
  });

  // ---------- Search ----------
  const searchInput = $<HTMLInputElement>('[data-search]');
  const results = $('[data-results]');
  function renderResults() {
    const term = searchInput.value.trim().toLowerCase();
    const matches = (term
      ? CATALOG.filter((t) => `${t.title} ${t.author} ${t.source}`.toLowerCase().includes(term))
      : CATALOG.slice(4, 9)
    ).slice(0, 5);
    results.innerHTML = matches.length
      ? matches
          .map(
            (t) => `
        <li>
          <button type="button" data-add="${t.id}" aria-label="Add ${escapeHtml(t.title)} to the queue">
            <span class="thumb" style="--h:${t.hue}">${escapeHtml(initials(t.title))}</span>
            <span class="r-meta"><strong>${escapeHtml(t.title)}</strong><span>${escapeHtml(t.author)} · ${fmt(t.length)}</span></span>
            <span class="src src-${t.source}">${t.source}</span>
            <span class="plus" aria-hidden="true">+</span>
          </button>
        </li>`,
          )
          .join('')
      : `<li class="no-results">No tracks match "${escapeHtml(term)}"</li>`;
  }
  searchInput.addEventListener('input', renderResults);
  results.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-add]');
    if (!button) return;
    const found = CATALOG.find((t) => t.id === button.dataset.add)!;
    const track = make(found);
    const query = searchInput.value.trim() || found.title;
    log('call', `const result = await player.search('${query.replace(/'/g, "\\'")}', { requester })`);
    log('call', 'await player.enqueue(result)');
    button.classList.add('added');
    setTimeout(() => button.classList.remove('added'), 700);
    if (!current) {
      log('event', 'queueUpdate', `added ${track.title}`);
      start(track, { history: false });
    } else {
      queue.push(track);
      log('event', 'queueUpdate', `added ${track.title} at position ${queue.length}`);
      render(track.uid);
    }
  });

  // ---------- Queue list with drag to reorder ----------
  const queueEl = $<HTMLOListElement>('[data-queue]');

  queueEl.addEventListener('click', (event) => {
    const remove = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]');
    if (!remove) return;
    const index = Number(remove.closest<HTMLElement>('li')!.dataset.index);
    const [removed] = queue.splice(index, 1);
    log('call', `player.queue.remove(${index})`);
    log('event', 'queueUpdate', `removed ${removed!.title}`);
    render();
  });

  queueEl.addEventListener('keydown', (event) => {
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-handle]');
    if (!handle || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const from = Number(handle.closest<HTMLElement>('li')!.dataset.index);
    const to = event.key === 'ArrowUp' ? from - 1 : from + 1;
    if (to < 0 || to >= queue.length) return;
    moveTrack(from, to);
    queueEl.querySelector<HTMLElement>(`li[data-index="${to}"] [data-handle]`)?.focus();
  });

  function moveTrack(from: number, to: number) {
    if (from === to) return;
    const [track] = queue.splice(from, 1);
    queue.splice(to, 0, track!);
    log('call', `player.queue.move(${from}, ${to})`);
    log('event', 'queueUpdate', `${track!.title} moved`);
    render();
  }

  queueEl.addEventListener('pointerdown', (event) => {
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-handle]');
    if (!handle || event.button !== 0) return;
    event.preventDefault();
    const item = handle.closest<HTMLLIElement>('li')!;
    const items = [...queueEl.querySelectorAll<HTMLLIElement>('li')];
    const from = items.indexOf(item);
    const rects = items.map((el) => el.getBoundingClientRect());
    const step = rects.length > 1 ? rects[1]!.top - rects[0]!.top : rects[0]!.height;
    const startY = event.clientY;
    let to = from;
    handle.setPointerCapture(event.pointerId);
    item.classList.add('dragging');

    const onMove = (e: PointerEvent) => {
      const dy = e.clientY - startY;
      item.style.transform = `translateY(${dy}px) scale(1.02)`;
      to = Math.min(items.length - 1, Math.max(0, from + Math.round(dy / step)));
      items.forEach((el, i) => {
        if (el === item) return;
        let shift = 0;
        if (from < to && i > from && i <= to) shift = -step;
        if (from > to && i >= to && i < from) shift = step;
        el.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      item.classList.remove('dragging');
      items.forEach((el) => (el.style.transform = ''));
      if (to !== from) moveTrack(from, to);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });

  // ---------- Rendering ----------
  const artEl = $('[data-art]');
  const loopBtn = $<HTMLButtonElement>('[data-action="loop"]');
  const toggleBtn = $<HTMLButtonElement>('[data-action="toggle"]');
  const autoplayBtn = $<HTMLButtonElement>('[data-action="autoplay"]');

  function renderProgress() {
    const pct = current ? (position / current.length) * 100 : 0;
    $('[data-fill]').style.width = `${pct}%`;
    progress.setAttribute('aria-valuenow', String(Math.round(pct)));
    $('[data-pos]').textContent = fmt(position);
  }

  function render(highlightUid?: number) {
    root.classList.toggle('is-playing', Boolean(current) && !paused);
    root.classList.toggle('is-idle', !current);
    $('[data-title]').textContent = current?.title ?? 'Nothing playing';
    $('[data-author]').textContent = current ? current.author : 'Add a track from the search box';
    $('[data-np-label]').textContent = current ? (paused ? 'Paused' : 'Now playing') : 'Idle';
    $('[data-len]').textContent = current ? fmt(current.length) : '0:00';
    $('[data-source]').textContent = current?.source ?? '';
    $('[data-source]').className = `src src-${current?.source ?? 'none'}`;
    $('[data-requester]').textContent = current ? `@${current.requester}` : '';
    artEl.style.setProperty('--h', String(current?.hue ?? 230));
    $('[data-art-initials]').textContent = current ? initials(current.title) : '♪';
    toggleBtn.setAttribute('aria-label', current && !paused ? 'Pause' : 'Play');
    loopBtn.dataset.loop = loop;
    loopBtn.setAttribute('aria-label', `Loop: ${loop}`);
    autoplayBtn.setAttribute('aria-pressed', String(autoplay));
    root.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b) =>
      b.setAttribute('aria-pressed', String(filters.has(b.dataset.filter as FilterName))),
    );
    root.style.setProperty('--speed', String(speedMultiplier()));
    root.classList.toggle('eight-d', filters.has('eightD'));
    root.classList.toggle('vapor', filters.has('vaporwave'));

    // FLIP animate queue changes
    const before = new Map<string, DOMRect>();
    queueEl.querySelectorAll<HTMLElement>('li').forEach((li) => before.set(li.dataset.uid!, li.getBoundingClientRect()));
    queueEl.innerHTML = queue
      .map(
        (t, i) => `
      <li data-index="${i}" data-uid="${t.uid}" class="${t.uid === highlightUid ? 'fresh' : ''}">
        <button type="button" class="handle" data-handle aria-label="Reorder ${escapeHtml(t.title)} (drag or use arrow keys)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
        </button>
        <span class="thumb" style="--h:${t.hue}">${escapeHtml(initials(t.title))}</span>
        <span class="q-meta"><strong>${escapeHtml(t.title)}</strong><span>${escapeHtml(t.author)} · @${escapeHtml(t.requester)}</span></span>
        <span class="q-len">${fmt(t.length)}</span>
        <button type="button" class="remove" data-remove aria-label="Remove ${escapeHtml(t.title)}">✕</button>
      </li>`,
      )
      .join('');
    if (!reduceMotion) {
      queueEl.querySelectorAll<HTMLElement>('li').forEach((li) => {
        const prev = before.get(li.dataset.uid!);
        if (!prev) return;
        const now = li.getBoundingClientRect();
        const dy = prev.top - now.top;
        if (dy) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 350, easing: 'cubic-bezier(.2,.8,.2,1)' });
      });
    }
    const total = queue.reduce((sum, t) => sum + t.length, 0);
    $('[data-queue-count]').textContent = `${queue.length} ${queue.length === 1 ? 'track' : 'tracks'} · ${fmt(total)}`;
    $('[data-queue-empty]').hidden = queue.length > 0;
    renderProgress();
  }

  // ---------- Mini visualizer + clock ----------
  const canvas = $<HTMLCanvasElement>('[data-viz]');
  const ctx = canvas.getContext('2d')!;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const levels = new Array(32).fill(0.1);
  const resize = () => {
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  new ResizeObserver(resize).observe(canvas);

  let last = performance.now();
  let running = false;
  function frame(now: number) {
    if (!visible) {
      running = false;
      return;
    }
    const dt = Math.min(100, now - last);
    last = now;
    if (current && !paused) {
      position += dt * DEMO_SPEED * speedMultiplier();
      if (position >= current.length) {
        position = current.length;
        finish();
      }
      renderProgress();
    }
    drawViz(now);
    requestAnimationFrame(frame);
  }

  function drawViz(now: number) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const playing = Boolean(current) && !paused;
    const t = (now / 1000) * speedMultiplier();
    const n = levels.length;
    const gap = 3;
    const bw = (w - gap * (n - 1)) / n;
    const hue = current?.hue ?? 230;
    const vapor = filters.has('vaporwave');
    const pan = filters.has('eightD') ? Math.sin(now / 900) : 0;
    for (let i = 0; i < n; i++) {
      let target = 0.06;
      if (playing) {
        const bassBoost = filters.has('bassBoost') ? Math.max(0, 1 - i / 7) * 0.45 : 0;
        target =
          0.25 +
          0.3 * (0.5 + 0.5 * Math.sin(i * 0.45 + t * 5.2)) * (0.5 + 0.5 * Math.sin(t * 1.7 + i)) +
          0.25 * Math.random() * (1 - i / n) +
          bassBoost;
        target *= 0.4 + (volume / 200) * 0.9;
        if (pan) target *= 0.55 + 0.45 * (1 + pan * ((i / n) * 2 - 1));
      }
      levels[i] += (Math.min(1, target) - levels[i]) * (reduceMotion ? 1 : 0.25);
      const bh = Math.max(2, levels[i] * h);
      const hh = vapor ? 280 + (i / n) * 60 : hue + (i / n) * 50;
      ctx.fillStyle = `hsl(${hh} 90% ${vapor ? 70 : 62}%)`;
      ctx.beginPath();
      ctx.roundRect(i * (bw + gap), h - bh, bw, bh, [bw / 2, bw / 2, 1, 1]);
      ctx.fill();
    }
  }

  new IntersectionObserver(([entry]) => {
    visible = entry!.isIntersecting;
    // Exactly one animation loop; the simulated clock pauses while the demo is off screen.
    if (visible && !running) {
      running = true;
      last = performance.now();
      requestAnimationFrame(frame);
    }
  }).observe(root);

  // ---------- Initial state ----------
  renderResults();
  log('call', 'const player = await raya.join({ guildId, voiceChannelId })');
  log('event', 'playerCreate', 'guild 1234 on node main');
  queue = [make(CATALOG[1]!), make(CATALOG[2]!), make(CATALOG[3]!)];
  log('call', 'await player.enqueue(result)');
  start(make(CATALOG[0]!, 'mika'), { history: false });
  log('note', 'Try skip, loop, autoplay, filters, or drag the queue.');
}
