/**
 * Renders a NowPlayingFeed (Server-Sent Events): the bot card, optional server cards, and a
 * `raya:live` window event other components (like the hero) can listen to.
 * Feed data is only ever set as text or validated http(s) URLs.
 */

interface LiveTrack {
  title: string;
  author: string;
  uri: string | null;
  artworkUrl: string | null;
  source: string;
  duration: number;
  isStream: boolean;
}

interface LiveNowPlaying {
  track: LiveTrack;
  position: number;
  paused: boolean;
  speed: number;
}

interface LivePlayer extends LiveNowPlaying {
  id: string;
  server: { name: string; icon: string | null };
  loop: 'off' | 'track' | 'queue';
  queueSize: number;
}

export interface LiveSnapshot {
  bot: { name: string; avatar: string | null; url: string | null; uptime: number } | null;
  nowPlaying: LiveNowPlaying | null;
  players: LivePlayer[];
  totals: { playing: number } | null;
}

export interface LiveEventDetail {
  status: 'connecting' | 'live' | 'reconnecting' | 'offline';
  snapshot: LiveSnapshot | null;
  receivedAt: number;
}

const SOURCE_NAMES: Record<string, string> = {
  youtube: 'YouTube',
  youtubemusic: 'YouTube Music',
  spotify: 'Spotify',
  soundcloud: 'SoundCloud',
  applemusic: 'Apple Music',
  deezer: 'Deezer',
  bandcamp: 'Bandcamp',
  twitch: 'Twitch',
  tidal: 'Tidal',
  yandexmusic: 'Yandex Music',
  jiosaavn: 'JioSaavn',
  vkmusic: 'VK Music',
  qobuz: 'Qobuz',
  http: 'Web',
};

export const safeUrl = (value: unknown) => (typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null);
export const sourceKey = (source: string) => source.toLowerCase().replace(/[^a-z0-9]/g, '');
export const sourceName = (source: string) => SOURCE_NAMES[sourceKey(source)] ?? source;

export const fmt = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

const fmtUptime = (ms: number) => {
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${Math.max(1, minutes)}m`;
};

export const livePosition = (entry: LiveNowPlaying, receivedAt: number, now = performance.now()) => {
  const elapsed = entry.paused ? 0 : (now - receivedAt) * (entry.speed || 1);
  return entry.track.isStream ? entry.position + elapsed : Math.min(entry.track.duration, entry.position + elapsed);
};

const hue = (text: string) => [...text].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 360, 7);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Replace an image inside `container`, falling back to nothing if it fails to load. */
function setImage(container: HTMLElement, url: string | null, className: string) {
  const existing = container.querySelector<HTMLImageElement>(`img.${className}`);
  if (existing?.dataset.src === (url ?? '')) return;
  existing?.remove();
  if (!url) return;
  const img = el('img', className);
  img.alt = '';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.dataset.src = url;
  img.addEventListener('error', () => img.remove());
  img.src = url;
  container.prepend(img);
}

export function mountLiveFeed(root: HTMLElement): void {
  const url = root.dataset.url!.replace(/\/+$/, '');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;

  const card = $('[data-bot]');
  const grid = $('[data-grid]');

  let snapshot: LiveSnapshot | null = null;
  let receivedAt = performance.now();
  let status: LiveEventDetail['status'] = 'connecting';
  let trackKey = '';
  let shownSecond = -1;
  let offlineTimer: number | undefined;
  let visible = false;
  let running = false;

  const broadcast = () =>
    window.dispatchEvent(new CustomEvent<LiveEventDetail>('raya:live', { detail: { status, snapshot, receivedAt } }));

  // ---------- Bot card ----------

  function renderBot() {
    const bot = snapshot?.bot ?? null;
    const now = snapshot?.nowPlaying ?? null;
    card.dataset.state = status === 'live' ? (now ? (now.paused ? 'paused' : 'playing') : 'idle') : status;

    if (snapshot) {
      card.classList.remove('is-loading');
      const name = bot?.name ?? 'Live feed';
      $('[data-bot-name]').textContent = name;
      const avatar = $('[data-avatar]');
      avatar.style.setProperty('--h', String(hue(name)));
      avatar.dataset.initial = name.charAt(0).toUpperCase();
      setImage(avatar, safeUrl(bot?.avatar), 'avatar-img');
      const invite = $<HTMLAnchorElement>('[data-invite]');
      const inviteUrl = safeUrl(bot?.url);
      invite.hidden = !inviteUrl;
      if (inviteUrl) invite.href = inviteUrl;
    }
    updateStatusText();

    $('[data-offline]').hidden = !(status === 'offline' && !snapshot);
    $('[data-idle]').hidden = !(snapshot && !now && status !== 'offline');
    $('[data-track]').hidden = !now;
    if (!now) {
      trackKey = '';
      return;
    }

    const key = `${now.track.title}${now.track.uri}`;
    if (key !== trackKey) {
      const changed = trackKey !== '';
      trackKey = key;
      const title = $<HTMLAnchorElement>('[data-title]');
      title.textContent = now.track.title;
      const href = safeUrl(now.track.uri);
      if (href) title.href = href;
      else title.removeAttribute('href');
      $('[data-author]').textContent = now.track.author;
      const source = $('[data-source]');
      source.textContent = sourceName(now.track.source);
      source.className = `badge source src-${sourceKey(now.track.source)}`;

      const cover = $('[data-cover]');
      cover.style.setProperty('--h', String(hue(now.track.title)));
      $('[data-cover-fallback]').textContent = now.track.title.trim().charAt(0).toUpperCase() || '♪';
      const artwork = safeUrl(now.track.artworkUrl);
      setImage(cover, artwork, 'cover-img');
      setImage($('[data-backdrop]'), artwork, 'backdrop-img');

      if (changed && !reduceMotion) {
        card.classList.remove('swap');
        void card.offsetWidth;
        card.classList.add('swap');
      }
    }
    $('[data-label]').textContent = now.paused ? 'Paused' : 'Now playing';
    shownSecond = -1;
    tick();
  }

  function updateStatusText() {
    const text = $('[data-bot-status]');
    if (status === 'live' && snapshot) {
      const uptime = snapshot.bot ? ` · up ${fmtUptime(snapshot.bot.uptime + (performance.now() - receivedAt))}` : '';
      text.textContent = `Online${uptime}`;
    } else if (status === 'offline') {
      text.textContent = 'Offline';
    } else if (status === 'reconnecting') {
      text.textContent = 'Reconnecting…';
    } else {
      text.textContent = 'Connecting…';
    }
  }

  // ---------- Optional server cards ----------

  const cards = new Map<string, { el: HTMLElement; data: LivePlayer; key: string; second: number }>();

  function buildServerCard(player: LivePlayer) {
    const node = el('article', 'live-card');
    const art = el('div', 'art');
    art.append(el('span', 'art-fallback'));
    const body = el('div', 'body');
    const title = el('a', 'title');
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    const server = el('div', 'server');
    server.append(el('span', 'icon'), el('span', 'server-name'));
    const progress = el('div', 'progress');
    progress.append(el('i', 'fill'));
    const meta = el('div', 'meta');
    meta.append(el('span', 'time'), el('span', 'badges'));
    body.append(title, el('span', 'author'), server, progress, meta);
    node.append(art, body);
    return { el: node, data: player, key: '', second: -1 };
  }

  function updateServerCard(entry: ReturnType<typeof buildServerCard>, player: LivePlayer) {
    const node = entry.el;
    entry.data = player;
    entry.second = -1;
    node.classList.toggle('is-paused', player.paused);
    const key = `${player.track.title}${player.track.uri}`;
    if (key !== entry.key) {
      entry.key = key;
      const title = node.querySelector<HTMLAnchorElement>('.title')!;
      title.textContent = player.track.title;
      const href = safeUrl(player.track.uri);
      if (href) title.href = href;
      else title.removeAttribute('href');
      node.querySelector('.author')!.textContent = player.track.author;
      const art = node.querySelector<HTMLElement>('.art')!;
      art.style.setProperty('--h', String(hue(player.track.title)));
      art.querySelector('.art-fallback')!.textContent = player.track.title.charAt(0).toUpperCase() || '♪';
      setImage(art, safeUrl(player.track.artworkUrl), 'art-img');
    }
    const icon = node.querySelector<HTMLElement>('.icon')!;
    icon.style.setProperty('--h', String(hue(player.server.name)));
    icon.textContent = player.server.icon ? '' : player.server.name.charAt(0).toUpperCase();
    setImage(icon, safeUrl(player.server.icon), 'icon-img');
    node.querySelector('.server-name')!.textContent = player.server.name;
    const badges = node.querySelector<HTMLElement>('.badges')!;
    badges.replaceChildren(el('span', `badge source src-${sourceKey(player.track.source)}`, sourceName(player.track.source)));
    if (player.paused) badges.append(el('span', 'badge paused', 'Paused'));
    if (player.queueSize > 0) badges.append(el('span', 'badge', `+${player.queueSize} queued`));
  }

  function renderServers() {
    const players = snapshot?.players ?? [];
    const seen = new Set<string>();
    players.forEach((player, index) => {
      seen.add(player.id);
      let entry = cards.get(player.id);
      if (!entry) {
        entry = buildServerCard(player);
        cards.set(player.id, entry);
        if (!reduceMotion) entry.el.classList.add('enter');
      }
      updateServerCard(entry, player);
      if (grid.children[index] !== entry.el) grid.insertBefore(entry.el, grid.children[index] ?? null);
    });
    for (const [id, entry] of cards) {
      if (seen.has(id)) continue;
      cards.delete(id);
      entry.el.remove();
    }
    grid.hidden = players.length === 0;
  }

  // ---------- Clock ----------

  function tick() {
    const now = performance.now();
    const current = snapshot?.nowPlaying;
    if (current) {
      const position = livePosition(current, receivedAt, now);
      const second = Math.floor(position / 1000);
      if (second !== shownSecond) {
        shownSecond = second;
        $('[data-fill]').style.width = current.track.isStream ? '100%' : `${Math.min(100, (position / (current.track.duration || 1)) * 100)}%`;
        $('[data-time]').textContent = current.track.isStream ? `LIVE · ${fmt(position)}` : `${fmt(position)} / ${fmt(current.track.duration)}`;
        if (second % 30 === 0) updateStatusText();
      }
    }
    for (const entry of cards.values()) {
      const position = livePosition(entry.data, receivedAt, now);
      const second = Math.floor(position / 1000);
      if (second === entry.second) continue;
      entry.second = second;
      const { track } = entry.data;
      entry.el.querySelector<HTMLElement>('.fill')!.style.width = track.isStream ? '100%' : `${Math.min(100, (position / (track.duration || 1)) * 100)}%`;
      entry.el.querySelector('.time')!.textContent = track.isStream ? `LIVE · ${fmt(position)}` : `${fmt(position)} / ${fmt(track.duration)}`;
    }
  }

  function loop() {
    if (!visible) {
      running = false;
      return;
    }
    tick();
    requestAnimationFrame(loop);
  }

  new IntersectionObserver(([entry]) => {
    visible = entry!.isIntersecting;
    if (visible && !running) {
      running = true;
      requestAnimationFrame(loop);
    }
  }).observe(root);

  const setStatus = (next: LiveEventDetail['status']) => {
    status = next;
    renderBot();
    broadcast();
  };

  // ---------- Connection ----------

  if (!('EventSource' in window)) {
    setStatus('offline');
    return;
  }

  const source = new EventSource(`${url}/stream`);
  source.addEventListener('snapshot', (event) => {
    try {
      snapshot = JSON.parse((event as MessageEvent<string>).data) as LiveSnapshot;
    } catch {
      return;
    }
    receivedAt = performance.now();
    clearTimeout(offlineTimer);
    offlineTimer = undefined;
    status = 'live';
    renderServers();
    renderBot();
    broadcast();
  });
  source.addEventListener('error', () => {
    setStatus(snapshot ? 'reconnecting' : 'connecting');
    if (offlineTimer === undefined) {
      offlineTimer = window.setTimeout(() => {
        offlineTimer = undefined;
        if (source.readyState !== EventSource.OPEN) setStatus('offline');
      }, 8000);
    }
  });
  broadcast();
}
