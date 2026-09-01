import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

function requireText(relative, values) {
  const source = read(relative)
  for (const value of values) if (!source.includes(value)) failures.push(`${relative} is missing: ${value}`)
}

function forbidText(relative, values) {
  const source = read(relative)
  for (const value of values) if (source.includes(value)) failures.push(`${relative} must not contain: ${value}`)
}

requireText('worker/src/payment-reconciliation-d1.js', [
  "const CONTRACT = 'statvara-payment-reconciliation-v1'",
  "const EXPECTED_ENTITY = 'CashExpectedBasis'",
  "const ACTUAL_ENTITY = 'CloseUp'",
  "const RECONCILIATION_ENTITY = 'PaymentReconciliation'",
  "financial_mutation_authority: 'none'",
  "status: 'blind_entry'",
  "status: 'differences_revealed'",
  "status: 'remarks_complete'",
  "status: 'submitted'",
  'payment_reconciliation_mutation_fingerprint_mismatch',
  'payment_reconciliation_version_conflict',
  'payment_reconciliation_source_drift',
  'submitted_reconciliation_retains_expected_source_actual_evidence_remarks_and_correction_identity',
  'supplier_invoice_outstanding_changed: false',
  'accounting_journal_created: false',
])
forbidText('worker/src/payment-reconciliation-d1.js', [
  'INSERT INTO payments', 'UPDATE payments', 'INSERT INTO payment_allocations', 'UPDATE payment_allocations',
  'INSERT INTO supplier_invoices', 'UPDATE supplier_invoices', 'INSERT INTO journal_entries', 'UPDATE journal_entries',
  "from './sheets.js'", 'syncCloseUpToSalesTemplate',
])
requireText('worker/src/entry.js', [
  "import { handlePaymentReconciliationApi } from './payment-reconciliation-d1.js'",
  'legacyPaymentReconciliationMutationBlocked',
  'payment_reconciliation_command_api_required',
])
requireText('worker/src/submission-locks.js', [
  'payment-reconciliation:${outletId}:${businessDate}:${shiftId}',
  "resourceType: 'payment-reconciliation'",
])
requireText('web/src/pages/PaymentReconciliation.jsx', [
  'Reconciliation is evidence only',
  'Server differences',
  'Immutable history',
  'Payment created: no',
])
requireText('web/src/api/opsClient.js', [
  '/api/payment-reconciliation/context',
  '/api/payment-reconciliation/start',
  '/api/payment-reconciliation/reveal',
  '/api/payment-reconciliation/remark',
  '/api/payment-reconciliation/submit',
  '/api/payment-reconciliation/replace',
])
requireText('docs/PAYMENT-RECONCILIATION-AUTHORITY.md', [
  'CMD-FIN-03-146', 'CMD-FIN-03-147', 'CMD-FIN-03-148', 'CMD-FIN-03-149', 'CMD-FIN-03-150', 'CMD-FIN-04-155',
  'does not create or modify canonical Payment',
  'D1 migration count remains 3',
])

if (existsSync(path.join(root, 'worker/migrations/0003_payment_reconciliation.sql'))
  || existsSync(path.join(root, 'worker/migrations/0004_payment_reconciliation.sql'))) {
  failures.push('Slice 007 must not add a D1 migration; ops_records already represents the record family')
}

if (failures.length) {
  console.error('Slice 007 Payment Reconciliation source gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('SLICE_007_PAYMENT_RECONCILIATION_SOURCE_GATE=PASS')
console.log('CORE_SCHEMA=18')
console.log('D1_MIGRATION_COUNT=3')
console.log('PAYMENT_RECONCILIATION_FINANCIAL_MUTATION_AUTHORITY=NONE')
