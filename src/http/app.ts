import cors from 'cors';
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { HttpError, RequestAbandonedError } from '../errors.js';
import { FfmpegError } from '../hls/ffmpeg.js';
import type { HlsService, ServedFile } from '../hls/hls-service.js';
import { errorMessage, logger } from '../logger.js';
import { MatroskaError } from '../matroska/ebml.js';

// A torrent's file list is fixed by its info hash, so it caches for a day.
const FILE_LIST_CACHE = 'public, max-age=86400';

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

  app.get('/m3u8', async (req, res) => {
    const magnet = magnetFromQuery(req);
    const file =
      typeof req.query.file === 'string' ? req.query.file : undefined;
    await sendFile(res, await hls.master(magnet, file, lifetime(res)));
  });

  app.get('/warm', async (req, res) => {
    const file =
      typeof req.query.file === 'string' ? req.query.file : undefined;
    res.json(await hls.warm(magnetFromQuery(req), file));
  });

  app.get('/files', async (req, res) => {
    const files = await hls.files(magnetFromQuery(req), lifetime(res));
    res.setHeader('Cache-Control', FILE_LIST_CACHE);
    res.json(files);
  });

  app.get('/status', (_req, res) => {
    res.json(status());
  });

  // The info hash, the file index and every path segment come from the
  // client. HlsService.resolve checks all three before a path is built.
  app.get('/:infoHash/:fileIndex/*path', async (req, res) => {
    const { infoHash, fileIndex } = req.params;
    const parts = ([] as string[]).concat(req.params.path);
    const file = await hls.resolve(infoHash, fileIndex, parts, lifetime(res));
    await sendFile(res, file);
  });

  // Express 5 forwards a thrown error to the middleware below, so an
  // unmatched route answers with the same JSON shape as a failed one.
  app.use(() => {
    throw new HttpError(404, 'Not found');
  });
  app.use(errorHandler);

  return app;
}

/**
 * Reads the magnet from the raw query string. A magnet URI carries its own
 * `&tr=` trackers, which the parsed query would split into separate keys.
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
  // A percent-encoded magnet still holds its trackers. A bare one lost them
  // to the split, so every later parameter but `file=` belongs back on it.
  if (magnet.includes('&')) {
    return magnet;
  }

  const extras = parts
    .slice(index + 1)
    .filter((part) => !part.startsWith('file='));
  return [magnet, ...extras].join('&');
}

/**
 * Signal that aborts with RequestAbandonedError once the client drops the
 * response. Reads, queue slots and ffmpeg processes downstream all take it.
 */
function lifetime(res: Response): AbortSignal {
  const controller = new AbortController();
  res.once('close', () =>
    controller.abort(new RequestAbandonedError('Request ended')),
  );
  return controller.signal;
}

function sendFile(res: Response, file: ServedFile): Promise<void> {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Cache-Control', file.cacheControl);
  return new Promise((resolve, reject) => {
    // Once the headers are out a failure can no longer become a status, so
    // this resolves and leaves the truncated body to speak for itself.
    res.sendFile(
      file.path,
      { dotfiles: 'allow', cacheControl: false },
      (err) => {
        if (err && !res.headersSent) {
          reject(err);
        } else {
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
  // Nobody is left to read a response, and a client leaving is not a fault.
  if (err instanceof RequestAbandonedError) {
    logger.debug('Request abandoned', { path: req.path });
    return;
  }

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
      // ffmpeg stderr runs long and the reason for the failure sits at its end.
      ...(err instanceof FfmpegError
        ? { stderr: err.stderr.slice(-2000) }
        : {}),
    });
  } else {
    logger.warn('Request rejected', { path: req.path, status, error: message });
  }

  // The status is already sent, so destroying the socket is the only way to
  // mark the body as incomplete rather than let it look finished.
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(status).json({ error: message });
};
