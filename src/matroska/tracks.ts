import {
  childElements,
  readBigUint,
  readBytes,
  readFloat,
  readString,
  readUint,
  type EbmlElement,
} from './ebml.js';
import { Id } from './ids.js';

export type TrackKind = 'video' | 'audio' | 'subtitle';

export interface MkvTrack {
  number: number;
  uid: string;
  kind: TrackKind;
  codecId: string;
  /** Base64-encoded CodecPrivate. */
  codecPrivate?: string | undefined;
  name?: string | undefined;
  /** BCP 47 tag when the file has one, otherwise ISO 639-2 (e.g. "eng"). */
  language: string;
  isDefault: boolean;
  isForced: boolean;
  isEnabled: boolean;
  defaultDurationNs?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  sampleRate?: number | undefined;
  channels?: number | undefined;
  /** Base64-encoded raw TrackEntry element, used to build single-track headers. */
  entry: string;
}

const TRACK_KINDS: Record<number, TrackKind> = {
  1: 'video',
  2: 'audio',
  17: 'subtitle',
};

/** Parses the TrackEntry children of a Tracks element. */
export function parseTracks(buf: Uint8Array, tracks: EbmlElement): MkvTrack[] {
  const result: MkvTrack[] = [];
  for (const el of childElements(buf, tracks.dataStart, tracks.dataEnd)) {
    if (el.id !== Id.TrackEntry) continue;
    const track = parseTrackEntry(buf, el);
    if (track) result.push(track);
  }
  return result;
}

function parseTrackEntry(buf: Uint8Array, entry: EbmlElement): MkvTrack | null {
  // Defaults as defined by the Matroska specification.
  const track: MkvTrack = {
    number: 0,
    uid: '',
    kind: 'video',
    codecId: '',
    language: 'eng',
    isDefault: true,
    isForced: false,
    isEnabled: true,
    entry: Buffer.from(buf.subarray(entry.start, entry.dataEnd)).toString(
      'base64',
    ),
  };
  let type = 0;
  let bcp47: string | undefined;

  for (const el of childElements(buf, entry.dataStart, entry.dataEnd)) {
    switch (el.id) {
      case Id.TrackNumber:
        track.number = readUint(buf, el);
        break;
      case Id.TrackUID:
        track.uid = readBigUint(buf, el);
        break;
      case Id.TrackType:
        type = readUint(buf, el);
        break;
      case Id.CodecID:
        track.codecId = readString(buf, el);
        break;
      case Id.CodecPrivate:
        track.codecPrivate = readBytes(buf, el).toString('base64');
        break;
      case Id.Name:
        track.name = readString(buf, el) || undefined;
        break;
      case Id.Language:
        track.language = readString(buf, el) || 'und';
        break;
      case Id.LanguageBCP47:
        bcp47 = readString(buf, el) || undefined;
        break;
      case Id.FlagDefault:
        track.isDefault = readUint(buf, el) === 1;
        break;
      case Id.FlagForced:
        track.isForced = readUint(buf, el) === 1;
        break;
      case Id.FlagEnabled:
        track.isEnabled = readUint(buf, el) === 1;
        break;
      case Id.DefaultDuration:
        track.defaultDurationNs = readUint(buf, el);
        break;
      case Id.Video:
        for (const v of childElements(buf, el.dataStart, el.dataEnd)) {
          if (v.id === Id.PixelWidth) track.width = readUint(buf, v);
          if (v.id === Id.PixelHeight) track.height = readUint(buf, v);
        }
        break;
      case Id.Audio:
        track.sampleRate = 8000;
        track.channels = 1;
        for (const a of childElements(buf, el.dataStart, el.dataEnd)) {
          if (a.id === Id.SamplingFrequency) track.sampleRate = readFloat(buf, a);
          if (a.id === Id.Channels) track.channels = readUint(buf, a);
        }
        break;
    }
  }

  const kind = TRACK_KINDS[type];
  if (!kind || !track.number || !track.codecId) return null;

  track.kind = kind;
  if (bcp47) track.language = bcp47;
  return track;
}
