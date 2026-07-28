import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyPrinterLayoutToHtml,
  encodePrinterProfileNotes,
  formatPrinterLayoutOutcome,
  normalizePrinterProfile,
  parsePrinterProfileNotes,
  resolvePrinterLayout,
  selectPrinterProfile,
} from '../../web/src/lib/label-printer-profile.js'

const baseProfile = {
  id: 'printer-a',
  outlet_id: 'outlet-1',
  purpose: 'food_label',
  profile_name: 'Kitchen Printer',
  enabled: true,
  label_width_mm: 40,
  label_height_mm: 30,
}

test('content orientation never swaps physical direct-print media dimensions', () => {
  const portraitPreference = resolvePrinterLayout({
    ...baseProfile,
    orientation: 'portrait',
  })
  assert.equal(portraitPreference.orientation_mode, 'portrait')
  assert.equal(portraitPreference.media_orientation, 'landscape')
  assert.equal(portraitPreference.width_mm, 40)
  assert.equal(portraitPreference.height_mm, 30)

  const landscapePreference = resolvePrinterLayout({
    ...baseProfile,
    label_width_mm: 30,
    label_height_mm: 40,
    orientation: 'landscape',
  })
  assert.equal(landscapePreference.orientation_mode, 'landscape')
  assert.equal(landscapePreference.media_orientation, 'portrait')
  assert.equal(landscapePreference.width_mm, 30)
  assert.equal(landscapePreference.height_mm, 40)
})

test('four-side padding is injected without changing the physical media size', () => {
  const source = '<html><head><style>@page{size:40mm 30mm;margin:0}.label{padding:9mm}</style></head><body><div class="label">TEST LABEL</div></body></html>'
  const transformed = applyPrinterLayoutToHtml(source, {
    ...baseProfile,
    orientation: 'portrait',
    padding_top_mm: 1,
    padding_right_mm: 2,
    padding_bottom_mm: 3,
    padding_left_mm: 4,
  })

  assert.equal(transformed.layout.orientation_mode, 'portrait')
  assert.equal(transformed.layout.media_orientation, 'landscape')
  assert.match(transformed.html, /@page\{size:40mm 30mm!important;margin:0!important\}/)
  assert.match(transformed.html, /padding:1mm 2mm 3mm 4mm!important/)
  assert.equal((transformed.html.match(/id="chefops-printer-layout"/g) || []).length, 1)
})

test('multiple profiles select the device choice before outlet default', () => {
  const profiles = [
    {
      ...baseProfile,
      id: 'printer-default',
      profile_name: 'Counter Printer',
      is_default: true,
    },
    {
      ...baseProfile,
      id: 'printer-kitchen',
      profile_name: 'Kitchen Printer',
      is_default: false,
    },
    {
      ...baseProfile,
      id: 'printer-disabled',
      profile_name: 'Disabled Printer',
      enabled: false,
    },
    {
      ...baseProfile,
      id: 'other-outlet',
      outlet_id: 'outlet-2',
      is_default: true,
    },
  ]

  assert.equal(
    selectPrinterProfile(profiles, 'outlet-1', 'printer-kitchen')?.id,
    'printer-kitchen',
  )
  assert.equal(
    selectPrinterProfile(profiles, 'outlet-1', 'missing-profile')?.id,
    'printer-default',
  )
  assert.equal(
    selectPrinterProfile(profiles, 'outlet-1', 'printer-disabled')?.id,
    'printer-default',
  )
})

test('profile notes round-trip layout without losing normal notes', () => {
  const encoded = encodePrinterProfileNotes({
    notes: JSON.stringify({ legacy_key: 'kept' }),
    user_notes: 'Near prep table',
    orientation: 'landscape',
    padding_top_mm: 0.5,
    padding_right_mm: 1,
    padding_bottom_mm: 1.5,
    padding_left_mm: 2,
  })
  const parsed = parsePrinterProfileNotes(encoded)

  assert.equal(parsed.legacy_key, 'kept')
  assert.equal(parsed.user_notes, 'Near prep table')
  assert.deepEqual(parsed.layout, {
    orientation: 'landscape',
    padding_top_mm: 0.5,
    padding_right_mm: 1,
    padding_bottom_mm: 1.5,
    padding_left_mm: 2,
  })
})

test('server boolean strings are normalized safely', () => {
  const normalized = normalizePrinterProfile({
    ...baseProfile,
    enabled: 'false',
    is_default: 'true',
    auto_print: 'false',
    standby_enabled: 'true',
    auto_reconnect: 'false',
    queue_when_offline: 'true',
  })

  assert.equal(normalized.enabled, false)
  assert.equal(normalized.is_default, true)
  assert.equal(normalized.auto_print, false)
  assert.equal(normalized.standby_enabled, true)
  assert.equal(normalized.auto_reconnect, false)
  assert.equal(normalized.queue_when_offline, true)
})

test('print outcome reports physical media dimensions and padding', () => {
  const text = formatPrinterLayoutOutcome({
    orientation: 'landscape',
    media_orientation: 'landscape',
    width_mm: 40,
    height_mm: 30,
    padding_top_mm: 1,
    padding_right_mm: 2,
    padding_bottom_mm: 3,
    padding_left_mm: 4,
  })

  assert.equal(text, 'Landscape media · 40×30 mm · padding 1/2/3/4 mm')
})
