import type { LavalinkTrack, TrackInfo } from '../types/lavalink';
import { RayaError } from './errors';

/**
 * Local decoder for Lavaplayer's binary track format, so `decodeTrack` does not
 * need a REST round-trip. Format (big-endian, Java DataOutput):
 *
 *   int32   header = messageSize | flags << 30        (flag 1 = versioned)
 *   byte    version                                   (only when versioned)
 *   utf     title, author
 *   int64   length
 *   utf     identifier
 *   bool    isStream
 *   ?utf    uri          (version >= 2)
 *   ?utf    artworkUrl   (version >= 3)
 *   ?utf    isrc         (version >= 3)
 *   utf     sourceName
 *   ...     source specific details (opaque)
 *   int64   position     (always the last 8 bytes of the message)
 *
 * "utf" is Java modified UTF-8 (CESU-8 surrogates, NUL as 0xC0 0x80).
 */

const FLAG_VERSIONED = 1;
const MAX_CHUNK = 8192;

class Reader {
  private pos = 0;

  constructor(
    private readonly buf: Buffer,
    private readonly limit: number,
  ) {}

  public get offset(): number {
    return this.pos;
  }

  public seek(position: number): void {
    this.pos = position;
  }

  private ensure(bytes: number): void {
    if (this.pos + bytes > this.limit) {
      throw new RayaError('DECODE_FAILED', 'Unexpected end of track data');
    }
  }

  public byte(): number {
    this.ensure(1);
    return this.buf[this.pos++]!;
  }

  public bool(): boolean {
    return this.byte() !== 0;
  }

  public int(): number {
    this.ensure(4);
    const value = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return value;
  }

  public long(): number {
    this.ensure(8);
    const value = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return Number(value);
  }

  public utf(): string {
    this.ensure(2);
    const length = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    this.ensure(length);
    const start = this.pos;
    const end = start + length;
    this.pos = end;

    let ascii = true;
    for (let i = start; i < end; i++) {
      if (this.buf[i]! & 0x80) {
        ascii = false;
        break;
      }
    }
    if (ascii) return this.buf.toString('latin1', start, end);

    const units: number[] = [];
    let i = start;
    while (i < end) {
      const a = this.buf[i]!;
      if (a < 0x80) {
        units.push(a);
        i += 1;
      } else if ((a & 0xe0) === 0xc0 && i + 1 < end) {
        units.push(((a & 0x1f) << 6) | (this.buf[i + 1]! & 0x3f));
        i += 2;
      } else if ((a & 0xf0) === 0xe0 && i + 2 < end) {
        units.push(((a & 0x0f) << 12) | ((this.buf[i + 1]! & 0x3f) << 6) | (this.buf[i + 2]! & 0x3f));
        i += 3;
      } else if ((a & 0xf8) === 0xf0 && i + 3 < end) {
        // Standard 4-byte UTF-8 (not produced by Java, tolerated anyway).
        const cp =
          ((a & 0x07) << 18) |
          ((this.buf[i + 1]! & 0x3f) << 12) |
          ((this.buf[i + 2]! & 0x3f) << 6) |
          (this.buf[i + 3]! & 0x3f);
        const offset = cp - 0x10000;
        units.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
        i += 4;
      } else {
        throw new RayaError('DECODE_FAILED', 'Malformed modified UTF-8 in track data');
      }
    }

    let out = '';
    for (let c = 0; c < units.length; c += MAX_CHUNK) {
      out += String.fromCharCode(...units.slice(c, c + MAX_CHUNK));
    }
    return out;
  }

  public nullableUtf(): string | null {
    return this.bool() ? this.utf() : null;
  }
}

/**
 * Decode a base64 Lavalink track without contacting a node.
 * @throws RayaError('DECODE_FAILED') for malformed input
 */
export function decodeTrack(encoded: string): LavalinkTrack {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new RayaError('DECODE_FAILED', 'Encoded track must be a non-empty string');
  }
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 4) throw new RayaError('DECODE_FAILED', 'Track data too short');

  const header = buf.readInt32BE(0);
  const flags = (header >>> 30) & 0b11;
  const size = header & 0x3fffffff;
  const limit = 4 + size;
  if (limit > buf.length || size < 8) {
    throw new RayaError('DECODE_FAILED', 'Track message size does not match data');
  }

  const reader = new Reader(buf, limit);
  reader.seek(4);
  const version = flags & FLAG_VERSIONED ? reader.byte() : 1;

  const title = reader.utf();
  const author = reader.utf();
  const length = reader.long();
  const identifier = reader.utf();
  const isStream = reader.bool();
  const uri = version >= 2 ? reader.nullableUtf() : null;
  const artworkUrl = version >= 3 ? reader.nullableUtf() : null;
  const isrc = version >= 3 ? reader.nullableUtf() : null;
  const sourceName = reader.utf();

  if (reader.offset > limit - 8) {
    throw new RayaError('DECODE_FAILED', 'Track data is missing the position field');
  }
  reader.seek(limit - 8);
  const position = reader.long();

  const info: TrackInfo = {
    identifier,
    isSeekable: !isStream,
    author,
    length,
    isStream,
    position,
    title,
    uri,
    artworkUrl,
    isrc,
    sourceName,
  };

  return { encoded, info, pluginInfo: {}, userData: {} };
}

/** Returns the decoded track, or null instead of throwing. */
export function tryDecodeTrack(encoded: string): LavalinkTrack | null {
  try {
    return decodeTrack(encoded);
  } catch {
    return null;
  }
}

// ==================== Encoder ====================

function utfBytes(value: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0x0001 && c <= 0x007f) {
      bytes.push(c);
    } else if (c <= 0x07ff) {
      bytes.push(0xc0 | ((c >> 6) & 0x1f), 0x80 | (c & 0x3f));
    } else {
      bytes.push(0xe0 | ((c >> 12) & 0x0f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  if (bytes.length > 0xffff) {
    throw new RayaError('INVALID_ARGUMENT', 'String too long to encode');
  }
  const out = Buffer.alloc(2 + bytes.length);
  out.writeUInt16BE(bytes.length, 0);
  Buffer.from(bytes).copy(out, 2);
  return out;
}

/**
 * Encode track info into Lavaplayer's binary format (version 3).
 *
 * Only safe for sources that store no extra details (e.g. YouTube). Sources such as
 * HTTP or LavaSrc append their own data, which you can pass via `sourceDetails`.
 */
export function encodeTrack(
  info: Omit<TrackInfo, 'isSeekable'> & { isSeekable?: boolean },
  sourceDetails: Buffer = Buffer.alloc(0),
): string {
  const parts: Buffer[] = [Buffer.from([3])];
  const long = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(Math.trunc(n)));
    return b;
  };
  const nullable = (v: string | null) => (v === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), utfBytes(v)]));

  parts.push(utfBytes(info.title), utfBytes(info.author), long(info.length), utfBytes(info.identifier));
  parts.push(Buffer.from([info.isStream ? 1 : 0]));
  parts.push(nullable(info.uri), nullable(info.artworkUrl), nullable(info.isrc));
  parts.push(utfBytes(info.sourceName), sourceDetails, long(info.position));

  const body = Buffer.concat(parts);
  const header = Buffer.alloc(4);
  header.writeInt32BE((body.length | (FLAG_VERSIONED << 30)) | 0);
  return Buffer.concat([header, body]).toString('base64');
}
