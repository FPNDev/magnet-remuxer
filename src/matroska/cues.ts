import { childElements, readUint, type EbmlElement } from './ebml.js';
import { Id } from './ids.js';

export interface CuePoint {
  /** Timestamp in Matroska ticks (TimestampScale units). */
  time: number;
  track: number;
  /** Cluster position relative to the start of the Segment payload. */
  clusterPosition: number;
  /** Block position relative to the start of the Cluster payload, if recorded. */
  relativePosition: number | undefined;
}

export function parseCues(buf: Uint8Array, cues: EbmlElement): CuePoint[] {
  const result: CuePoint[] = [];

  for (const point of childElements(buf, cues.dataStart, cues.dataEnd)) {
    if (point.id !== Id.CuePoint) {
      continue;
    }

    let time: number | undefined;
    const positions: EbmlElement[] = [];
    for (const el of childElements(buf, point.dataStart, point.dataEnd)) {
      if (el.id === Id.CueTime) {
        time = readUint(buf, el);
      }
      if (el.id === Id.CueTrackPositions) {
        positions.push(el);
      }
    }
    if (time === undefined) {
      continue;
    }

    for (const pos of positions) {
      let track: number | undefined;
      let clusterPosition: number | undefined;
      let relativePosition: number | undefined;
      for (const el of childElements(buf, pos.dataStart, pos.dataEnd)) {
        if (el.id === Id.CueTrack) {
          track = readUint(buf, el);
        }
        if (el.id === Id.CueClusterPosition) {
          clusterPosition = readUint(buf, el);
        }
        if (el.id === Id.CueRelativePosition) {
          relativePosition = readUint(buf, el);
        }
      }
      if (track !== undefined && clusterPosition !== undefined) {
        result.push({ time, track, clusterPosition, relativePosition });
      }
    }
  }

  return result;
}
