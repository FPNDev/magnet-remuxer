import { HttpError } from '../errors.js';

const HEX_HASH = /^[0-9a-f]{40}$/i;
// A magnet carries the info hash as 40 hex characters or as 32 base32
// characters. Everything downstream uses the hex form.
const BASE32_HASH = /^[a-z2-7]{32}$/i;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Lower case only: hashes are normalised before they reach a cache path or
// a request path.
export function isInfoHash(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function parseInfoHash(magnet: string): string {
  let url: URL;
  try {
    url = new URL(magnet.trim());
  } catch {
    throw new HttpError(400, 'Invalid magnet link');
  }
  if (url.protocol !== 'magnet:') {
    throw new HttpError(400, 'Invalid magnet link');
  }

  for (const xt of url.searchParams.getAll('xt')) {
    const hash = /^urn:btih:(.+)$/i.exec(xt)?.[1];
    if (!hash) {
      continue;
    }
    if (HEX_HASH.test(hash)) {
      return hash.toLowerCase();
    }
    if (BASE32_HASH.test(hash)) {
      return base32ToHex(hash);
    }
  }
  throw new HttpError(400, 'Magnet link has no BitTorrent info hash');
}

export function trackersOf(magnet: string): string[] {
  return magnetParams(magnet, 'tr');
}

export function peersOf(magnet: string): string[] {
  return magnetParams(magnet, 'x.pe');
}

function magnetParams(magnet: string, key: string): string[] {
  try {
    return new URL(magnet).searchParams.getAll(key);
  } catch {
    return [];
  }
}

function base32ToHex(input: string): string {
  let bits = 0;
  let value = 0;
  let hex = '';
  for (const char of input.toUpperCase()) {
    // Bits arrive five at a time and leave eight at a time, so at most twelve
    // are ever pending.
    value = ((value << 5) | BASE32_ALPHABET.indexOf(char)) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ((value >> bits) & 0xff).toString(16).padStart(2, '0');
    }
  }
  return hex;
}
