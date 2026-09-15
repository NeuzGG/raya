import { escapeHtml } from './highlight';

/** Visual simulation of Raya's resume, failover and snapshot-restore behaviour. */

type Status = 'ready' | 'reconnecting' | 'down';

interface SimNode {
  name: string;
  status: Status;
  attempts: number;
  card: HTMLElement;
  slots: HTMLElement;
  timers: number[];
}

interface SimPlayer {
  id: number;
  hue: number;
  node: SimNode | null;
  el: HTMLElement;
}

const NODE_NAMES = ['tokyo', 'frankfurt', 'virginia'];
const FAILOVER_DELAY = 2200;

export function mountFailoverDemo(root: HTMLElement): void {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stage = root.querySelector<HTMLElement>('[data-nodes]')!;
  const orphanTray = root.querySelector<HTMLElement>('[data-orphans]')!;
  const logEl = root.querySelector<HTMLElement>('[data-log]')!;
  const overlay = root.querySelector<HTMLElement>('[data-overlay]')!;
  let nodes: SimNode[] = [];
  let players: SimPlayer[] = [];
  let nextId = 1;
  let busy = false;
  const t0 = performance.now();

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, reduceMotion ? Math.min(ms, 60) : ms));

  function log(kind: 'event' | 'call' | 'note' | 'warn', text: string, detail = '') {
    const row = document.createElement('div');
    row.className = `log-row ${kind}`;
    const time = ((performance.now() - t0) / 1000).toFixed(1);
    row.innerHTML =
      kind === 'call'
        ? `<span class="t">${time}s</span><span class="c">› ${escapeHtml(text)}</span>`
        : `<span class="t">${time}s</span><span class="e">${escapeHtml(text)}</span><span class="d">${escapeHtml(detail)}</span>`;
    logEl.prepend(row);
    while (logEl.children.length > 40) logEl.lastElementChild!.remove();
  }

  function renderNode(node: SimNode) {
    node.card.dataset.status = node.status;
    const count = players.filter((p) => p.node === node).length;
    const label = node.card.querySelector<HTMLElement>('[data-status]')!;
    label.textContent =
      node.status === 'ready' ? 'ready' : node.status === 'reconnecting' ? `reconnecting #${node.attempts}` : `down · retry #${node.attempts}`;
    const penalty = node.status === 'ready' ? count * 11 + 6 : 100;
    node.card.querySelector<HTMLElement>('[data-penalty]')!.style.width = `${Math.min(100, penalty)}%`;
    node.card.querySelector<HTMLElement>('[data-penalty-value]')!.textContent = node.status === 'ready' ? String(count + 6) : '∞';
    node.card.querySelector<HTMLElement>('[data-count]')!.textContent = `${count} ${count === 1 ? 'player' : 'players'}`;
    node.card.querySelector<HTMLButtonElement>('[data-restore]')!.hidden = node.status !== 'down';
    node.card.querySelectorAll<HTMLButtonElement>('[data-blip], [data-crash]').forEach((b) => (b.disabled = node.status !== 'ready' || busy));
  }

  const renderAll = () => {
    nodes.forEach(renderNode);
    orphanTray.hidden = !players.some((p) => !p.node);
  };

  function bestNode(exclude?: SimNode): SimNode | null {
    const ready = nodes.filter((n) => n.status === 'ready' && n !== exclude);
    if (!ready.length) return null;
    return ready.reduce((best, n) =>
      players.filter((p) => p.node === n).length < players.filter((p) => p.node === best).length ? n : best,
    );
  }

  function flip(el: HTMLElement, mutate: () => void) {
    const first = el.getBoundingClientRect();
    mutate();
    if (reduceMotion) return;
    const last = el.getBoundingClientRect();
    el.animate(
      [
        { transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(1.25)`, zIndex: 5 },
        { transform: 'none', zIndex: 5 },
      ],
      { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  }

  function addPlayer(silent = false) {
    const node = bestNode();
    const el = document.createElement('span');
    const player: SimPlayer = { id: nextId++, hue: (nextId * 47) % 360, node, el };
    el.className = 'player-dot';
    el.style.setProperty('--h', String(player.hue));
    el.title = `Guild #${player.id}`;
    el.innerHTML = `<i></i><span class="sr-only">Guild ${player.id}</span>`;
    (node ? node.slots : orphanTray).appendChild(el);
    if (!reduceMotion) el.animate([{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    players.push(player);
    if (!silent) log('event', 'playerCreate', node ? `guild #${player.id} → ${node.name} (lowest penalty)` : `guild #${player.id} waiting for a node`);
    renderAll();
  }

  function clearTimers(node: SimNode) {
    node.timers.forEach((t) => clearTimeout(t));
    node.timers = [];
  }

  async function movePlayers(from: SimNode | null) {
    const affected = players.filter((p) => p.node === from);
    for (const player of affected) {
      const target = bestNode(from ?? undefined);
      if (!target) {
        if (player.node) {
          flip(player.el, () => orphanTray.appendChild(player.el));
          player.node = null;
          log('warn', 'no ready node', `guild #${player.id} waits for one`);
          renderAll();
        }
        continue;
      }
      flip(player.el, () => target.slots.appendChild(player.el));
      log('event', 'playerNodeMove', `guild #${player.id} ${from?.name ?? 'waiting'} → ${target.name}`);
      player.node = target;
      renderAll();
      await wait(260);
    }
  }

  function blip(node: SimNode) {
    if (node.status !== 'ready') return;
    node.status = 'reconnecting';
    node.attempts = 1;
    renderAll();
    log('event', 'nodeDisconnect', `${node.name} · code 1006`);
    log('event', 'nodeReconnecting', `${node.name} · attempt 1 in 1000ms`);
    node.timers.push(
      window.setTimeout(() => {
        node.status = 'ready';
        node.attempts = 0;
        log('event', 'nodeReady', `${node.name} · resumed: true`);
        const mine = players.filter((p) => p.node === node);
        mine.forEach((p) => {
          if (!reduceMotion) p.el.animate([{ boxShadow: '0 0 0 0 var(--mint)' }, { boxShadow: '0 0 0 10px transparent' }], { duration: 700 });
        });
        if (mine.length) log('event', 'playerResume', `${mine.length} players on ${node.name}, nothing replayed`);
        renderAll();
      }, reduceMotion ? 80 : 1400),
    );
  }

  function crash(node: SimNode) {
    if (node.status !== 'ready') return;
    node.status = 'reconnecting';
    node.attempts = 1;
    renderAll();
    log('event', 'nodeDisconnect', `${node.name} · code 1006`);
    log('event', 'nodeReconnecting', `${node.name} · attempt 1 in 1000ms`);
    let delay = 1000;
    const retry = () => {
      if (node.status === 'ready') return;
      node.attempts++;
      delay = Math.min(delay * 2, 30000);
      log('event', 'nodeReconnecting', `${node.name} · attempt ${node.attempts} in ${delay}ms`);
      renderAll();
      node.timers.push(window.setTimeout(retry, reduceMotion ? 100 : Math.min(6000, 1500 * node.attempts)));
    };
    node.timers.push(window.setTimeout(retry, reduceMotion ? 100 : 900));
    node.timers.push(
      window.setTimeout(async () => {
        if (node.status === 'ready') return;
        node.status = 'down';
        log('note', `failover.delay passed, ${node.name} did not come back`);
        renderAll();
        await movePlayers(node);
      }, reduceMotion ? 120 : FAILOVER_DELAY),
    );
  }

  async function restoreNode(node: SimNode) {
    clearTimers(node);
    node.status = 'ready';
    node.attempts = 0;
    log('event', 'nodeReady', `${node.name} · resumed: false (session expired)`);
    renderAll();
    if (players.some((p) => !p.node)) await movePlayers(null);
  }

  async function restartBot() {
    if (busy) return;
    busy = true;
    renderAll();
    root.classList.add('restarting');
    overlay.hidden = false;
    log('call', 'const snapshot = await raya.shutdown()');
    log('note', `snapshot saved: ${players.length} players, queues and sessions`);
    await wait(1600);
    log('call', 'const raya = new Raya({ nodes, connector, restore: snapshot })');
    await wait(500);
    for (const node of nodes.filter((n) => n.status === 'ready')) {
      log('event', 'nodeReady', `${node.name} · resumed: true`);
      await wait(180);
    }
    root.classList.remove('restarting');
    overlay.hidden = true;
    const restored = players.filter((p) => p.node);
    restored.forEach((p, i) => {
      if (!reduceMotion) p.el.animate([{ transform: 'scale(0.6)' }, { transform: 'scale(1.15)' }, { transform: 'scale(1)' }], { duration: 500, delay: i * 40 });
    });
    log('event', 'playerResume', `${restored.length} players restored, audio never stopped`);
    busy = false;
    renderAll();
  }

  function reset() {
    nodes.forEach(clearTimers);
    players.forEach((p) => p.el.remove());
    players = [];
    nextId = 1;
    stage.innerHTML = '';
    nodes = NODE_NAMES.map((name) => createNode(name));
    for (let i = 0; i < 9; i++) addPlayer(true);
    logEl.innerHTML = '';
    log('note', 'Crash or blip a node, restart the bot, or add players.');
    renderAll();
  }

  function createNode(name: string): SimNode {
    const card = document.createElement('div');
    card.className = 'node';
    card.innerHTML = `
      <div class="node-head">
        <span class="light" aria-hidden="true"></span>
        <strong>${name}</strong>
        <span class="status" data-status>ready</span>
      </div>
      <div class="penalty"><span>penalty</span><div class="meter"><i data-penalty></i></div><b data-penalty-value>6</b></div>
      <div class="slots" data-slots></div>
      <div class="node-foot">
        <span data-count>0 players</span>
        <span class="node-actions">
          <button type="button" data-blip>Network blip</button>
          <button type="button" data-crash class="danger">Crash</button>
          <button type="button" data-restore hidden class="ok">Bring back</button>
        </span>
      </div>`;
    stage.appendChild(card);
    const node: SimNode = { name, status: 'ready', attempts: 0, card, slots: card.querySelector('[data-slots]')!, timers: [] };
    card.querySelector('[data-blip]')!.addEventListener('click', () => blip(node));
    card.querySelector('[data-crash]')!.addEventListener('click', () => crash(node));
    card.querySelector('[data-restore]')!.addEventListener('click', () => restoreNode(node));
    return node;
  }

  root.querySelector('[data-add]')!.addEventListener('click', () => addPlayer());
  root.querySelector('[data-restart]')!.addEventListener('click', restartBot);
  root.querySelector('[data-reset]')!.addEventListener('click', reset);
  reset();
}
