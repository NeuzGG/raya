const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

/** Tiny leveled console logger. */
export function createLogger({ debug = false } = {}) {
  const min = debug ? LEVELS.debug : LEVELS.info;
  const write = (level, stream) => (...args) => {
    if (LEVELS[level] < min) return;
    stream(`${stamp()} ${level.toUpperCase().padEnd(5)}`, ...args);
  };
  return {
    debug: write('debug', console.log),
    info: write('info', console.log),
    warn: write('warn', console.warn),
    error: write('error', console.error),
  };
}
