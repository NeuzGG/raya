export { Raya } from './Raya';
export type { RayaStats } from './Raya';

export { Node, NodeState } from './node/Node';
export { Rest } from './node/Rest';
export type { HttpMethod, RequestOptions } from './node/Rest';

export { Player } from './player/Player';
export { Queue } from './player/Queue';
export { Filters, EqualizerPresets } from './player/Filters';
export type { EqualizerPreset, BassBoostLevel } from './player/Filters';
export { defaultAutoplay, relatedQueries } from './player/autoplay';
export { VoiceStatus, MAX_VOICE_STATUS_LENGTH } from './plugins/VoiceStatus';
export type { VoiceStatusOptions, VoiceStatusTemplate } from './plugins/VoiceStatus';
export { NowPlayingFeed } from './plugins/NowPlayingFeed';
export type {
  NowPlayingFeedOptions,
  LiveBotInfo,
  LiveServerInfo,
  LiveTrack,
  LiveNowPlaying,
  LivePlayer,
  LiveSnapshot,
} from './plugins/NowPlayingFeed';

export { Connectors, DiscordJSConnector, ErisConnector, OceanicConnector } from './connectors';
export type { DiscordJSClientLike, ErisClientLike, OceanicClientLike } from './connectors';

export { RayaError, RestError } from './utils/errors';
export type { RayaErrorCode } from './utils/errors';
export { decodeTrack, tryDecodeTrack, encodeTrack } from './utils/TrackCodec';
export { SearchSources, buildIdentifier, isUrl } from './utils/sources';
export type { SearchSourceAlias } from './utils/sources';
export { LRUCache } from './utils/LRUCache';
export { TypedEmitter } from './utils/TypedEmitter';

export * from './types/lavalink';
export * from './types/raya';

export { VERSION } from './version';

import { Raya } from './Raya';
export default Raya;
