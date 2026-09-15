import { UserError } from '../music/guards.js';
import { clean } from '../ui/format.js';
import { command } from '../ui/mentions.js';

const EXPECTED = new Set(['NO_NODES', 'NODE_NOT_READY', 'VOICE_TIMEOUT', 'QUEUE_FULL', 'PLAYER_DESTROYED', 'NO_TRACK', 'INVALID_ARGUMENT']);

/** A friendly message for any error thrown while handling an interaction. */
export function describeError(error) {
  if (error instanceof UserError) return error.message;
  switch (error?.code) {
    case 'NO_NODES':
    case 'NODE_NOT_READY':
      return 'The music server is offline right now. Try again in a moment.';
    case 'VOICE_TIMEOUT':
      return "I couldn't connect to your voice channel. Try again, or check my permissions there.";
    case 'QUEUE_FULL':
      return 'The queue is full. Remove some songs first.';
    case 'PLAYER_DESTROYED':
      return `The player was stopped. Start a new one with ${command('play')}.`;
    case 'NO_TRACK':
      return 'Nothing is playing right now.';
    case 'REST_TIMEOUT':
    case 'NETWORK_ERROR':
      return "The music server didn't answer in time. Please try again.";
    case 'REST_ERROR':
      return `The music server couldn't do that: ${clean(error.body?.message ?? error.message, 150)}`;
    case 'INVALID_ARGUMENT':
      return clean(error.message, 200);
    default:
      return 'Something went wrong. Please try again.';
  }
}

/** Whether an error is worth logging (bugs and outages, not user mistakes). */
export function isUnexpected(error) {
  return !(error instanceof UserError) && !EXPECTED.has(error?.code);
}
