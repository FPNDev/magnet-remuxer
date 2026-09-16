import { spawn, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class FfmpegError extends Error {
  override name = 'FfmpegError';

  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(stderr ? `${message}: ${stderr.trim().split('\n').at(-1)}` : message);
  }
}

export interface FfmpegRun {
  args: string[];
  /** Written to stdin, which is closed when the iterable ends. */
  input?: AsyncIterable<Buffer> | Iterable<Buffer> | undefined;
  /** Receives stdout. */
  output?: Writable | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

const STDERR_LIMIT = 16 * 1024;
const BROKEN_PIPE_CODES = new Set([
  'EPIPE',
  'EOF',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

const running = new Set<ChildProcess>();

export function killAllFfmpeg(): void {
  for (const child of running) {
    child.kill('SIGKILL');
  }
}

/**
 * Runs ffmpeg to completion. Resolves once the process has exited cleanly and
 * stdout has been fully written to `output`.
 */
export async function runFfmpeg(
  ffmpegPath: string,
  run: FfmpegRun,
): Promise<void> {
  run.signal?.throwIfAborted();

  const child = spawn(
    ffmpegPath,
    ['-hide_banner', '-nostats', '-loglevel', 'error', ...run.args],
    {
      stdio: [
        run.input ? 'pipe' : 'ignore',
        run.output ? 'pipe' : 'ignore',
        'pipe',
      ],
      windowsHide: true,
    },
  );
  running.add(child);

  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (text: string) => {
    stderr = (stderr + text).slice(-STDERR_LIMIT);
  });

  let failure: unknown;
  const kill = (reason: unknown) => {
    failure ??= reason;
    child.kill('SIGKILL');
  };

  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (err) => {
      failure ??= err;
      resolve(null);
    });
    child.once('close', (code) => resolve(code));
  });

  const onAbort = () => kill(run.signal!.reason);
  run.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = run.timeoutMs
    ? setTimeout(
        () =>
          kill(
            new FfmpegError(
              `ffmpeg timed out after ${run.timeoutMs} ms`,
              stderr,
            ),
          ),
        run.timeoutMs,
      )
    : undefined;

  // Not awaited: once ffmpeg exits, the caller tears the input down. A broken
  // pipe just means ffmpeg stopped reading; its exit code tells the real story.
  if (run.input) {
    pipeline(run.input, child.stdin!).catch((err: NodeJS.ErrnoException) => {
      if (!BROKEN_PIPE_CODES.has(err.code ?? '')) {
        kill(err);
      }
    });
  }
  const writing = run.output
    ? pipeline(child.stdout!, run.output)
    : Promise.resolve();

  try {
    const [code] = await Promise.all([exited, writing]);
    if (failure) {
      throw failure;
    }
    if (code !== 0) {
      throw new FfmpegError(`ffmpeg exited with code ${code}`, stderr);
    }
  } finally {
    clearTimeout(timer);
    run.signal?.removeEventListener('abort', onAbort);
    running.delete(child);
  }
}
