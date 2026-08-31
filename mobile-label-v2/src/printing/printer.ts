export interface PrinterTarget {
  host: string;
  port?: number;
  displayName?: string;
}

export interface PrintResult {
  ok: boolean;
  host?: string;
  error?: string;
}

export interface LabelPrinter {
  printRawTspl(payload: string, copies: number, target: PrinterTarget): Promise<PrintResult>;
  testConnection?(target: PrinterTarget): Promise<PrintResult>;
}

/**
 * Adapter boundary only. The production Stable TSPL transport is intentionally
 * not edited in this phase. A V2 adapter will wrap/reuse it after the domain
 * workflow is proven.
 */
export const PRINT_TRANSPORT_CONTRACT_VERSION = 'stable-tspl-adapter-v1';
