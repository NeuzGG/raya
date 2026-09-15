const ids = new Map();

/** Remember slash command ids so messages can show clickable command mentions. */
export function setCommandIds(commands) {
  ids.clear();
  for (const command of commands) ids.set(command.name, command.id);
}

/** `</play:123>` when the id is known, otherwise `/play` as code. */
export function command(name) {
  const id = ids.get(name.split(' ')[0]);
  return id ? `</${name}:${id}>` : `\`/${name}\``;
}
