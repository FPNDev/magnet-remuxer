import cors from 'cors';
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { HttpError } from '../errors.js';
import { FfmpegError } from '../hls/ffmpeg.js';
import type { HlsService, ServedFile } from '../hls/hls-service.js';
import { errorMessage, logger } from '../logger.js';
import { MatroskaError } from '../matroska/ebml.js';

export interface AppDependencies {
  hls: HlsService;
  status: () => unknown;
}

export function createApp({ hls, status }: AppDependencies): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'HEAD'],
      exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
    }),
  );
  app.use(requestLogger);

  /** GET /m3u8?magnet=<magnet link>[&file=<torrent file index>] → master playlist */
  app.get('/m3u8', async (req, res) => {
    const magnet = magnetFromQuery(req);
    const file =
      typeof req.query.file === 'string' ? req.query.file : undefined;
    await sendFile(res, await hls.master(magnet, file));
  });

  /** GET /files?magnet=<magnet link> → files in the torrent */
  app.get('/files', async (req, res) => {
    res.json(await hls.files(magnetFromQuery(req)));
  });

  app.get('/status', (_req, res) => {
    res.json(status());
  });

  /** Media playlists, init sections and segments referenced by the master playlist. */
  app.get('/:infoHash/:fileIndex/*path', async (req, res) => {
    const { infoHash, fileIndex } = req.params;
    const parts = ([] as string[]).concat(req.params.path);
    await sendFile(res, await hls.resolve(infoHash, fileIndex, parts));
  });

  app.use(() => {
    throw new HttpError(404, 'Not found');
  });
  app.use(errorHandler);

  return app;
}

/**
 * A magnet link carries its own "?" and "&", so clients may send it encoded or
 * raw. The raw query text is used as-is: re-encoding it would corrupt values
 * such as `x.pe=host:port`.
 */
function magnetFromQuery(req: Request): string {
  const query = req.originalUrl.slice(req.originalUrl.indexOf('?') + 1);
  const parts = query.split('&');
  const index = parts.findIndex((part) => part.startsWith('magnet='));
  if (index === -1) {
    throw new HttpError(400, 'Missing "magnet" query parameter');
  }

  let magnet: string;
  try {
    magnet = decodeURIComponent(parts[index]!.slice('magnet='.length));
  } catch {
    throw new HttpError(400, 'Invalid magnet link');
  }
  if (magnet.includes('&')) {
    return magnet;
  } // the client encoded the whole link

  // A raw link: its own parameters were split off as top-level ones.
  const extras = parts
    .slice(index + 1)
    .filter((part) => !part.startsWith('file='));
  return [magnet, ...extras].join('&');
}

function sendFile(res: Response, file: ServedFile): Promise<void> {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Cache-Control', file.cacheControl);
  return new Promise((resolve, reject) => {
    res.sendFile(
      file.path,
      { dotfiles: 'allow', cacheControl: false },
      (err) => {
        // Once headers are out, failures are client disconnects.
        if (err && !res.headersSent) reject(err);
        else {
          resolve();
        }
      },
    );
  });
}

const requestLogger: RequestHandler = (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    logger.debug('HTTP', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - started,
    });
  });
  next();
};

const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const status =
    err instanceof HttpError
      ? err.status
      : err instanceof MatroskaError
        ? 422
        : 500;
  const message = errorMessage(err);

  if (status >= 500) {
    logger.error('Request failed', {
      path: req.path,
      error: message,
      ...(err instanceof FfmpegError
        ? { stderr: err.stderr.slice(-2000) }
        : {}),
    });
  } else {
    logger.warn('Request rejected', { path: req.path, status, error: message });
  }

  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(status).json({ error: message });
};
