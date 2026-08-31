import { Platform } from 'react-native';
import { LabelPrinter, PrintResult, PrinterTarget } from './printer';

type TcpSocketModule = {
  createConnection: (
    options: { host: string; port: number },
    callback?: () => void,
  ) => {
    setTimeout: (timeout: number, callback?: () => void) => unknown;
    setNoDelay?: (enabled?: boolean) => unknown;
    write: (
      data: string,
      encoding?: 'ascii' | 'utf8' | 'binary',
      callback?: (error?: Error) => void,
    ) => unknown;
    end: (callback?: () => void) => unknown;
    destroy: () => unknown;
    on: (event: string, callback: (...args: any[]) => void) => unknown;
  };
};

let TcpSocket: TcpSocketModule | null = null;
if (Platform.OS !== 'web') {
  try {
    const tcpPackage = require('react-native-tcp-socket');
    TcpSocket = tcpPackage?.default ?? tcpPackage;
  } catch {
    TcpSocket = null;
  }
}

const CONNECT_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 10000;
const CLOSE_FALLBACK_MS = 350;

function normalizeTarget(target: PrinterTarget) {
  const host = String(target.host || '').trim();
  const port = Number(target.port || 9100);
  if (!host) throw new Error('Printer host is required.');
  if (!Number.isFinite(port) || port <= 0) throw new Error('Printer port is invalid.');
  return { host, port };
}

async function writeRaw(payload: string, target: PrinterTarget): Promise<PrintResult> {
  if (!TcpSocket) {
    return { ok: false, error: 'Direct WiFi printing requires a native build.' };
  }

  let resolved: { host: string; port: number };
  try {
    resolved = normalizeTarget(target);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  return new Promise<PrintResult>((resolve) => {
    let settled = false;
    let connected = false;
    let writeCompleted = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: PrintResult, socket?: ReturnType<TcpSocketModule['createConnection']>) => {
      if (settled) return;
      settled = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (!result.ok) {
        try {
          socket?.destroy();
        } catch {}
      }
      resolve(result);
    };

    try {
      const socket = TcpSocket!.createConnection(resolved, () => {
        connected = true;
        socket.setTimeout(WRITE_TIMEOUT_MS, () => {
          finish(
            {
              ok: false,
              host: resolved.host,
              error: `Printer write timed out after ${WRITE_TIMEOUT_MS}ms.`,
            },
            socket,
          );
        });

        try {
          socket.setNoDelay?.(true);
          socket.write(payload, 'ascii', (error?: Error) => {
            if (error) {
              finish({ ok: false, host: resolved.host, error: error.message }, socket);
              return;
            }
            writeCompleted = true;
            socket.end();
            fallbackTimer = setTimeout(() => {
              finish({ ok: true, host: resolved.host });
            }, CLOSE_FALLBACK_MS);
          });
        } catch (error) {
          finish(
            {
              ok: false,
              host: resolved.host,
              error: error instanceof Error ? error.message : String(error),
            },
            socket,
          );
        }
      });

      socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
        finish(
          {
            ok: false,
            host: resolved.host,
            error: connected
              ? `Printer socket timed out after ${WRITE_TIMEOUT_MS}ms.`
              : `Could not connect to printer after ${CONNECT_TIMEOUT_MS}ms.`,
          },
          socket,
        );
      });

      socket.on('error', (error: Error) => {
        finish({ ok: false, host: resolved.host, error: error.message || 'Printer socket error.' }, socket);
      });
      socket.on('close', () => {
        if (writeCompleted) finish({ ok: true, host: resolved.host });
      });
    } catch (error) {
      finish({
        ok: false,
        host: resolved.host,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export class NativeTcpPrinter implements LabelPrinter {
  async printRawTspl(payload: string, _copies: number, target: PrinterTarget): Promise<PrintResult> {
    return writeRaw(payload, target);
  }

  async testConnection(target: PrinterTarget): Promise<PrintResult> {
    if (!TcpSocket) return { ok: false, error: 'Direct WiFi printing requires a native build.' };
    let resolved: { host: string; port: number };
    try {
      resolved = normalizeTarget(target);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    return new Promise<PrintResult>((resolve) => {
      let settled = false;
      const finish = (result: PrintResult, socket?: ReturnType<TcpSocketModule['createConnection']>) => {
        if (settled) return;
        settled = true;
        try {
          socket?.destroy();
        } catch {}
        resolve(result);
      };

      try {
        const socket = TcpSocket!.createConnection(resolved, () => {
          finish({ ok: true, host: resolved.host }, socket);
        });
        socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
          finish({ ok: false, host: resolved.host, error: 'Connection timed out.' }, socket);
        });
        socket.on('error', (error: Error) => {
          finish({ ok: false, host: resolved.host, error: error.message }, socket);
        });
      } catch (error) {
        finish({
          ok: false,
          host: resolved.host,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}
