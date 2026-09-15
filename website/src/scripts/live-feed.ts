/** Renders a NowPlayingFeed (Server-Sent Events) as live cards. Feed data is only ever set as text. */

interface LivePlayer {
  id: string;
  server: { name: string; icon: string | null };
  track: { title: string; author: string; uri: string | null; artworkUrl: string | null; source: string; duration: number; isStream: boolean };
  position: number;
  paused: boolean;
  speed: number;
  loop: 'off' | 'track' | 'queue';
  queueSize: number;
}

interface LiveSnapshot {
  players: LivePlayer[];
  totals: { playing: number } | null;
}

interface Card {
  el: HTMLElement;
  data: LivePlayer;
  trackKey: string;
  shownSecond: number;
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

const safeUrl = (value: unknown) => (typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null);

const fmt = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

const hue = (text: string) => [...text].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 360, 7);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountLiveFeed(root: HTMLElement): void {
  const url = root.dataset.url!.replace(/\/+$/, '');
  const grid = root.querySelector<HTMLElement>('[data-grid]')!;
  const empty = root.querySelector<HTMLElement>('[data-empty]')!;
  const offline = root.querySelector<HTMLElement>('[data-offline]')!;
  const status = root.querySelector<HTMLElement>('[data-status]')!;
  const statusText = root.querySelector<HTMLElement>('[data-status-text]')!;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const cards = new Map<string, Card>();
  let receivedAt = performance.now();
  let hasData = false;
  let offlineTimer: number | undefined;
  let visible = false;
  let running = false;

  const setState = (state: 'connecting' | 'live' | 'reconnecting' | 'offline', text: string) => {
    status.dataset.state = state;
    statusText.textContent = text;
  };

  function buildCard(player: LivePlayer): Card {
    const card = el('article', 'live-card');
    card.dataset.id = player.id;

    const art = el('div', 'art');
    const fallback = el('span', 'art-fallback');
    art.append(fallback);
    const bars = el('span', 'bars');
    bars.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 4; i++) bars.append(el('i'));
    art.append(bars);

    const body = el('div', 'body');
    const title = el('a', 'title');
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    const author = el('span', 'author');
    const server = el('div', 'server');
    const icon = el('span', 'icon');
    const serverName = el('span', 'server-name');
    server.append(icon, serverName);
    const progress = el('div', 'progress');
    progress.append(el('i', 'fill'));
    const meta = el('div', 'meta');
    const time = el('span', 'time');
    const badges = el('span', 'badges');
    meta.append(time, badges);
    body.append(title, author, server, progress, meta);
    card.append(art, body);

    const entry: Card = { el: card, data: player, trackKey: '', shownSecond: -1 };
    updateCard(entry, player, true);
    return entry;
  }

  function updateCard(card: Card, player: LivePlayer, initial = false) {
    const root = card.el;
    const trackKey = `${player.track.title}${player.track.uri}`;
    const trackChanged = trackKey !== card.trackKey;
    card.data = player;
    card.shownSecond = -1;
    root.classList.toggle('is-paused', player.paused);

    if (trackChanged) {
      card.trackKey = trackKey;
      const title = root.querySelector<HTMLAnchorElement>('.title')!;
      title.textContent = player.track.title;
      const href = safeUrl(player.track.uri);
      if (href) title.href = href;
      else title.removeAttribute('href');
      root.querySelector('.author')!.textContent = player.track.author;

      const art = root.querySelector<HTMLElement>('.art')!;
      art.style.setProperty('--h', String(hue(player.track.title)));
      art.querySelector('img')?.remove();
      const fallback = art.querySelector<HTMLElement>('.art-fallback')!;
      fallback.textContent = player.track.title.trim().charAt(0).toUpperCase() || '♪';
      const artwork = safeUrl(player.track.artworkUrl);
      if (artwork) {
        const img = el('img');
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => img.remove());
        img.src = artwork;
        art.prepend(img);
      }
      if (!initial && !reduceMotion) {
        root.classList.remove('swap');
        void root.offsetWidth;
        root.classList.add('swap');
      }
    }

    const icon = root.querySelector<HTMLElement>('.icon')!;
    const iconUrl = safeUrl(player.server.icon);
    if (icon.dataset.src !== (iconUrl ?? '')) {
      icon.dataset.src = iconUrl ?? '';
      icon.textContent = '';
      icon.style.setProperty('--h', String(hue(player.server.name)));
      if (iconUrl) {
        const img = el('img');
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => {
          img.remove();
          icon.textContent = player.server.name.charAt(0).toUpperCase();
        });
        img.src = iconUrl;
        icon.append(img);
      } else {
        icon.textContent = player.server.name.charAt(0).toUpperCase();
      }
    }
    root.querySelector('.server-name')!.textContent = player.server.name;

    const badges = root.querySelector<HTMLElement>('.badges')!;
    badges.replaceChildren();
    const sourceKey = player.track.source.toLowerCase().replace(/[^a-z0-9]/g, '');
    const source = el('span', `badge source src-${sourceKey}`, SOURCE_NAMES[sourceKey] ?? player.track.source);
    badges.append(source);
    if (player.paused) badges.append(el('span', 'badge paused', 'Paused'));
    if (player.loop !== 'off') badges.append(el('span', 'badge', player.loop === 'track' ? 'Loop track' : 'Loop queue'));
    if (player.queueSize > 0) badges.append(el('span', 'badge', `+${player.queueSize} queued`));
    root.setAttribute('aria-label', `${player.server.name} is ${player.paused ? 'paused on' : 'playing'} ${player.track.title} by ${player.track.author}`);
  }

  function render(snapshot: LiveSnapshot) {
    receivedAt = performance.now();
    hasData = true;
    offline.hidden = true;
    const players = Array.isArray(snapshot.players) ? snapshot.players : [];
    const seen = new Set<string>();

    players.forEach((player, index) => {
      seen.add(player.id);
      let card = cards.get(player.id);
      if (!card) {
        card = buildCard(player);
        cards.set(player.id, card);
        if (!reduceMotion) card.el.classList.add('enter');
      } else {
        updateCard(card, player);
      }
      const current = grid.children[index];
      if (current !== card.el) grid.insertBefore(card.el, current ?? null);
    });

    for (const [id, card] of cards) {
      if (seen.has(id)) continue;
      cards.delete(id);
      if (reduceMotion) card.el.remove();
      else {
        card.el.classList.add('leave');
        card.el.addEventListener('animationend', () => card.el.remove(), { once: true });
        setTimeout(() => card.el.remove(), 600);
      }
    }

    empty.hidden = players.length > 0;
    const servers = players.length === 1 ? '1 server' : `${players.length} servers`;
    const total = snapshot.totals && snapshot.totals.playing > players.length ? ` · ${snapshot.totals.playing} playing in total` : '';
    setState('live', players.length ? `Live · ${servers} playing${total}` : `Live${total}`);
    tick();
  }

  function tick() {
    const now = performance.now();
    for (const card of cards.values()) {
      const { position, paused, speed, track } = card.data;
      const elapsed = paused ? 0 : (now - receivedAt) * (speed || 1);
      const current = track.isStream ? position + elapsed : Math.min(track.duration, position + elapsed);
      const second = Math.floor(current / 1000);
      if (second === card.shownSecond) continue;
      card.shownSecond = second;
      const fill = card.el.querySelector<HTMLElement>('.fill')!;
      const timeEl = card.el.querySelector<HTMLElement>('.time')!;
      if (track.isStream) {
        fill.style.width = '100%';
        timeEl.textContent = `LIVE · ${fmt(current)}`;
      } else {
        fill.style.width = `${track.duration ? Math.min(100, (current / track.duration) * 100) : 0}%`;
        timeEl.textContent = `${fmt(current)} / ${fmt(track.duration)}`;
      }
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

  if (!('EventSource' in window)) {
    setState('offline', 'Your browser does not support live updates');
    return;
  }

  const source = new EventSource(`${url}/stream`);
  source.addEventListener('snapshot', (event) => {
    try {
      render(JSON.parse((event as MessageEvent<string>).data) as LiveSnapshot);
    } catch {
      /* ignore malformed messages */
    }
  });
  source.addEventListener('open', () => {
    clearTimeout(offlineTimer);
    offlineTimer = undefined;
  });
  source.addEventListener('error', () => {
    setState('reconnecting', hasData ? 'Reconnecting…' : 'Connecting to the bot…');
    if (offlineTimer === undefined) {
      offlineTimer = window.setTimeout(() => {
        if (source.readyState === EventSource.OPEN) return;
        setState('offline', 'Bot offline');
        if (!hasData) offline.hidden = false;
        root.classList.add('is-offline');
      }, 8000);
    }
  });
  source.addEventListener('snapshot', () => root.classList.remove('is-offline'));
}
