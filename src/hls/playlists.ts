import {
  aacChannels,
  codecString,
  type Rendition,
  type RenditionSet,
} from '../media/codecs.js';
import {
  segmentCount,
  segmentEnd,
  segmentStart,
  type MediaIndex,
} from '../media/media-index.js';
import type { MkvTrack } from '../matroska/tracks.js';

const AUDIO_GROUP = 'audio';
const SUBTITLE_GROUP = 'subs';

// HLS wants BCP 47 language tags. Matroska carries ISO 639-2, which has
// both a bibliographic and a terminological code for some languages.
const ISO_639_1: Record<string, string> = {
  ara: 'ar',
  bul: 'bg',
  cat: 'ca',
  ces: 'cs',
  cze: 'cs',
  chi: 'zh',
  zho: 'zh',
  dan: 'da',
  deu: 'de',
  ger: 'de',
  ell: 'el',
  gre: 'el',
  eng: 'en',
  spa: 'es',
  est: 'et',
  fas: 'fa',
  per: 'fa',
  fin: 'fi',
  fra: 'fr',
  fre: 'fr',
  heb: 'he',
  hin: 'hi',
  hrv: 'hr',
  hun: 'hu',
  ind: 'id',
  ita: 'it',
  jpn: 'ja',
  kat: 'ka',
  geo: 'ka',
  kaz: 'kk',
  kor: 'ko',
  lit: 'lt',
  lav: 'lv',
  msa: 'ms',
  may: 'ms',
  nld: 'nl',
  dut: 'nl',
  nor: 'no',
  nob: 'nb',
  pol: 'pl',
  por: 'pt',
  ron: 'ro',
  rum: 'ro',
  rus: 'ru',
  slk: 'sk',
  slo: 'sk',
  slv: 'sl',
  srp: 'sr',
  swe: 'sv',
  tha: 'th',
  tur: 'tr',
  ukr: 'uk',
  vie: 'vi',
};

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

export function renditionPath(rendition: Rendition): string {
  switch (rendition.type) {
    case 'video':
      return 'video';
    case 'audio':
      return `audio/${rendition.track.number}`;
    case 'subtitle':
      return `subtitles/${rendition.track.number}`;
  }
}

export function segmentFileName(rendition: Rendition, n: number): string {
  return `${n}.${rendition.type === 'subtitle' ? 'vtt' : 'm4s'}`;
}

export function mediaPlaylist(index: MediaIndex, rendition: Rendition): string {
  const durations = Array.from(
    { length: segmentCount(index) },
    (_, n) => segmentEnd(index, n) - segmentStart(index, n),
  );

  // Version 7 is the floor for fragmented MP4 segments and EXT-X-MAP.
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    // Must be an integer and no shorter than the longest segment.
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  // Subtitle renditions are WebVTT and have no init segment.
  if (rendition.type !== 'subtitle') {
    lines.push('#EXT-X-MAP:URI="init.mp4"');
  }
  for (const [n, duration] of durations.entries()) {
    lines.push(
      `#EXTINF:${duration.toFixed(3)},`,
      segmentFileName(rendition, +n),
    );
  }
  lines.push('#EXT-X-ENDLIST');

  return `${lines.join('\n')}\n`;
}

export function masterPlaylist(
  index: MediaIndex,
  renditions: RenditionSet,
  basePath: string,
): string {
  const uri = (rendition: Rendition) =>
    `${basePath}/${renditionPath(rendition)}/index.m3u8`;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];

  // At most one member of an audio group may be DEFAULT.
  const defaultAudio =
    renditions.audio.find((audio) => audio.track.isDefault) ??
    renditions.audio[0];
  const audioNames = new Set<string>();
  for (const audio of renditions.audio) {
    const channels = audio.transcode
      ? aacChannels(audio.track)
      : (audio.track.channels ?? 2);
    lines.push(
      `#EXT-X-MEDIA:${attributes({
        TYPE: 'AUDIO',
        'GROUP-ID': quoted(AUDIO_GROUP),
        NAME: quoted(uniqueLabel(audio.track, audioNames)),
        LANGUAGE: optionalQuoted(bcp47(audio.track.language)),
        DEFAULT: audio === defaultAudio ? 'YES' : 'NO',
        AUTOSELECT: 'YES',
        CHANNELS: quoted(String(channels)),
        URI: quoted(uri(audio)),
      })}`,
    );
  }

  const subtitleNames = new Set<string>();
  for (const subtitle of renditions.subtitles) {
    lines.push(
      `#EXT-X-MEDIA:${attributes({
        TYPE: 'SUBTITLES',
        'GROUP-ID': quoted(SUBTITLE_GROUP),
        NAME: quoted(uniqueLabel(subtitle.track, subtitleNames)),
        LANGUAGE: optionalQuoted(bcp47(subtitle.track.language)),
        DEFAULT: 'NO',
        AUTOSELECT: 'YES',
        FORCED: subtitle.track.isForced ? 'YES' : 'NO',
        URI: quoted(uri(subtitle)),
      })}`,
    );
  }

  const { track } = renditions.video;
  const codecs = [renditions.video, ...renditions.audio].map(codecString);
  const averageBandwidth = Math.round((index.fileLength * 8) / index.duration);
  lines.push(
    `#EXT-X-STREAM-INF:${attributes({
      // BANDWIDTH is a peak figure. Per-segment rates are not indexed, so the
      // file average stands in for it.
      BANDWIDTH: String(Math.round(averageBandwidth * 1.5)),
      'AVERAGE-BANDWIDTH': String(averageBandwidth),
      CODECS: codecs.every(Boolean)
        ? quoted([...new Set(codecs)].join(','))
        : undefined,
      RESOLUTION:
        track.width && track.height
          ? `${track.width}x${track.height}`
          : undefined,
      'FRAME-RATE': track.defaultDurationNs
        ? (1e9 / track.defaultDurationNs).toFixed(3)
        : undefined,
      AUDIO: renditions.audio.length ? quoted(AUDIO_GROUP) : undefined,
      SUBTITLES: renditions.subtitles.length
        ? quoted(SUBTITLE_GROUP)
        : undefined,
      'CLOSED-CAPTIONS': 'NONE',
    })}`,
    uri(renditions.video),
  );

  return `${lines.join('\n')}\n`;
}

function attributes(values: Record<string, string | undefined>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

// A quoted attribute value may hold neither a double quote nor a line
// break.
function quoted(value: string): string {
  return `"${value.replace(/["\r\n]/g, "'")}"`;
}

function optionalQuoted(value: string | undefined): string | undefined {
  return value === undefined ? undefined : quoted(value);
}

function bcp47(language: string): string | undefined {
  if (!language || language === 'und') {
    return undefined;
  }
  return ISO_639_1[language.toLowerCase()] ?? language;
}

function uniqueLabel(track: MkvTrack, used: Set<string>): string {
  const language = bcp47(track.language);
  let label = track.name;
  if (!label && language) {
    try {
      label = languageNames.of(language);
    } catch {
      label = undefined;
    }
  }
  label ||= `Track ${track.number}`;

  if (used.has(label)) {
    label = `${label} (${track.number})`;
  }
  used.add(label);
  return label;
}
