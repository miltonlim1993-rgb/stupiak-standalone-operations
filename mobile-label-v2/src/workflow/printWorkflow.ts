import { createDraftLabel } from '../domain/engine';
import { DraftLabelRequest, LabelBatch } from '../domain/types';
import { LabelBackend } from '../data/backend';
import { LabelPrinter, PrinterTarget } from '../printing/printer';

export interface TsplBuilder {
  build(batch: LabelBatch, copies: number): string;
}

export interface ExecutePrintInput {
  request: DraftLabelRequest;
  allBatches: LabelBatch[];
  backend: LabelBackend;
  printer: LabelPrinter;
  tspl: TsplBuilder;
  printerTarget: PrinterTarget;
  copies?: number;
  now?: Date;
}

export interface ExecutePrintResult {
  batch: LabelBatch;
  printed: boolean;
  error?: string;
}

/**
 * Two-phase local workflow:
 * 1. validate + reserve batch/source quantity
 * 2. send stable TSPL
 * 3. commit printed, or cancel reservation on failure
 *
 * Later the same contract maps directly to GAS V2 endpoints without changing
 * UI/domain code.
 */
export async function executePrintWorkflow(
  input: ExecutePrintInput,
): Promise<ExecutePrintResult> {
  const now = input.now || new Date();
  const copies = Math.max(1, Number(input.copies || 1));
  const draft = createDraftLabel(input.request, input.allBatches, now);
  const pending = await input.backend.reserveDraft(draft);

  try {
    const payload = input.tspl.build(pending, copies);
    const print = await input.printer.printRawTspl(payload, copies, input.printerTarget);
    if (!print.ok) {
      throw new Error(print.error || 'Printer rejected the label.');
    }
    const committed = await input.backend.commitPrinted(
      pending.batchId,
      new Date().toISOString(),
      print.host || input.printerTarget.host,
    );
    return { batch: committed, printed: true };
  } catch (error) {
    await input.backend.cancelPending(
      pending.batchId,
      error instanceof Error ? error.message : String(error),
    );
    return {
      batch: { ...pending, status: 'cancelled' },
      printed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
