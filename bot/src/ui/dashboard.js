import { card } from './components.js';
import { command } from './mentions.js';

/**
 * The resting state of a `/setup` dashboard: one message that lives in the request channel
 * and turns into the live player as soon as something starts playing.
 */
export function renderDashboardIdle({ name = 'Raya', avatar = null, voiceChannelId = null, djRoleId = null } = {}) {
  const lines = [
    voiceChannelId ? `Join <#${voiceChannelId}> and send a song with ${command('play')}.` : `Join a voice channel and use ${command('play')}.`,
    'Paste a YouTube, Spotify or SoundCloud link, or just type what you want to hear.',
  ];
  const notes = ['This message turns into the player once the music starts.'];
  if (djRoleId) notes.push(`Only <@&${djRoleId}> can skip, stop or change the sound.`);

  return card(
    [`**${name}** is ready\n${lines.join('\n')}`, notes.map((note) => `-# ${note}`).join('\n')],
    [],
    { thumbnail: { url: avatar, description: `${name} avatar` } },
  );
}
