import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PRINTER_PRESETS,
  applyPrinterLayoutToHtml,
  applyPrinterPreset,
  encodePrinterProfileNotes,
  formatPrinterHardwareSummary,
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

test('profile notes round-trip layout and hardware without losing normal notes', () => {
  const encoded = encodePrinterProfileNotes({
    notes: JSON.stringify({ legacy_key: 'kept' }),
    user_notes: 'Near prep table',
    orientation: 'landscape',
    padding_top_mm: 0.5,
    padding_right_mm: 1,
    padding_bottom_mm: 1.5,
    padding_left_mm: 2,
    preset_id: 'generic-zpl-203',
    network_protocol: 'lpr',
    lpr_queue: 'raw',
    media_sensor: 'black_mark',
    gap_mm: 3,
    gap_offset_mm: -0.5,
    black_mark_mm: 4,
    black_mark_offset_mm: 1.25,
    print_speed_mm_s: 102,
    darkness: 11,
    x_offset_mm: -1.2,
    y_offset_mm: 0.8,
    connection_timeout_ms: 6500,
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
  assert.deepEqual(parsed.hardware, {
    preset_id: 'generic-zpl-203',
    network_protocol: 'lpr',
    lpr_queue: 'raw',
    media_sensor: 'black_mark',
    gap_mm: 3,
    gap_offset_mm: -0.5,
    black_mark_mm: 4,
    black_mark_offset_mm: 1.25,
    print_speed_mm_s: 102,
    darkness: 11,
    x_offset_mm: -1.2,
    y_offset_mm: 0.8,
    connection_timeout_ms: 6500,
  })
})

test('normalization clamps hardware tuning to safe ranges', () => {
  const normalized = normalizePrinterProfile({
    ...baseProfile,
    notes: JSON.stringify({
      printer_hardware: {
        network_protocol: 'unsupported',
        media_sensor: 'wrong',
        darkness: 99,
        print_speed_mm_s: 2,
        x_offset_mm: -99,
        connection_timeout_ms: 999999,
      },
    }),
  })

  assert.equal(normalized.network_protocol, 'raw_tcp')
  assert.equal(normalized.media_sensor, 'gap')
  assert.equal(normalized.darkness, 15)
  assert.equal(normalized.print_speed_mm_s, 10)
  assert.equal(normalized.x_offset_mm, -20)
  assert.equal(normalized.connection_timeout_ms, 30000)
})

test('printer presets provide safe command-language defaults without changing connection', () => {
  assert.equal(PRINTER_PRESETS.length, 4)
  const profile = applyPrinterPreset({
    ...baseProfile,
    connection_type: 'bluetooth',
    command_language: 'browser',
  }, 'generic-cpcl-203')

  assert.equal(profile.connection_type, 'bluetooth')
  assert.equal(profile.command_language, 'cpcl')
  assert.equal(profile.dpi, 203)
  assert.equal(profile.media_sensor, 'gap')
  assert.equal(profile.print_speed_mm_s, 51)
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

test('hardware summary includes protocol, sensor, speed, darkness and origin offsets', () => {
  const text = formatPrinterHardwareSummary({
    ...baseProfile,
    connection_type: 'network',
    command_language: 'tspl',
    notes: encodePrinterProfileNotes({
      network_protocol: 'lpr',
      lpr_queue: 'raw',
      media_sensor: 'black_mark',
      black_mark_mm: 3,
      print_speed_mm_s: 76,
      darkness: 9,
      x_offset_mm: -0.5,
      y_offset_mm: 1,
    }),
  })

  assert.equal(text, 'LPR · raw · Black mark 3 mm · 76 mm/s · darkness 9/15 · offset -0.5/1 mm')
})
