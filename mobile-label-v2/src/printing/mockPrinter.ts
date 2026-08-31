import { LabelPrinter, PrintResult, PrinterTarget } from './printer';

/** Useful for emulator/UI tests without touching a physical printer. */
export class MockPrinter implements LabelPrinter {
  async printRawTspl(_payload: string, _copies: number, target: PrinterTarget): Promise<PrintResult> {
    return { ok: true, host: target.host || 'mock-printer' };
  }

  async testConnection(target: PrinterTarget): Promise<PrintResult> {
    return { ok: true, host: target.host || 'mock-printer' };
  }
}
