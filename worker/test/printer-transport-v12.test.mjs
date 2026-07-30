import assert from 'node:assert/strict'
import test from 'node:test'

import {
  effectiveConnectionType,
  encodePrinterTransportNotes,
  normalizeBridgeUrl,
  normalizePrinterTransportProfile,
  printerRouteLabel,
  validatePrinterTransport,
} from '../../web/src/lib/printer-transport-v12.js'

const base = {
  id: 'printer-1',
  outlet_id: 'RR-KCH',
  purpose: 'food_label',
  profile_name: 'Food Label Printer',
  enabled: true,
  command_language: 'tspl',
  label_width_mm: 40,
  label_height_mm: 30,
}

test('bridge transport settings round-trip through existing notes JSON', () => {
  const notes = encodePrinterTransportNotes({
    ...base,
    connection_type: 'driver_bridge',
    bridge_url: '192.168.1.20:8787/print',
    bridge_token: 'secret-token',
    bridge_transport: 'queue',
    bridge_queue: 'Xprinter 365B',
    bridge_platform: 'windows',
    fallback_connection: 'system_print',
    user_notes: 'Kitchen PC',
  })
  const normalized = normalizePrinterTransportProfile({
    ...base,
    connection_type: 'driver_bridge',
    notes,
  })

  assert.equal(normalized.bridge_url, '192.168.1.20:8787/print')
  assert.equal(normalized.bridge_token, 'secret-token')
  assert.equal(normalized.bridge_transport, 'queue')
  assert.equal(normalized.bridge_queue, 'Xprinter 365B')
  assert.equal(normalized.bridge_platform, 'windows')
  assert.equal(normalized.user_notes, 'Kitchen PC')
  assert.equal(normalizeBridgeUrl(normalized.bridge_url), 'http://192.168.1.20:8787')
})

test('direct network uses Android native sockets or Web Local Print Connector', () => {
  const profile = {
    ...base,
    connection_type: 'network',
    ip_address: '192.168.1.50',
    port: 9100,
    network_protocol: 'raw_tcp',
  }
  assert.throws(
    () => validatePrinterTransport(profile, { nativeAndroid: false }),
    /Local Print Connector URL/i,
  )

  const webProfile = {
    ...profile,
    bridge_url: 'http://127.0.0.1:8787',
    bridge_token: 'pairing-token',
  }
  const validatedWeb = validatePrinterTransport(webProfile, { nativeAndroid: false })
  assert.equal(validatedWeb.connection, 'network')
  assert.equal(validatedWeb.viaConnector, true)

  const validatedAndroid = validatePrinterTransport(profile, { nativeAndroid: true })
  assert.equal(validatedAndroid.connection, 'network')
  assert.equal(validatedAndroid.viaConnector, false)
  assert.match(printerRouteLabel(profile), /Direct Raw TCP/)
})

test('driver bridge validates queue, URL and token on web and Android', () => {
  const profile = {
    ...base,
    connection_type: 'driver_bridge',
    notes: encodePrinterTransportNotes({
      ...base,
      bridge_url: 'http://192.168.1.20:8787',
      bridge_token: 'pairing-token',
      bridge_transport: 'queue',
      bridge_queue: 'Kitchen Label Printer',
    }),
  }
  const validatedWeb = validatePrinterTransport(profile, { nativeAndroid: false })
  const validatedAndroid = validatePrinterTransport(profile, { nativeAndroid: true })
  assert.equal(validatedWeb.connection, 'driver_bridge')
  assert.equal(validatedAndroid.connection, 'driver_bridge')
  assert.match(printerRouteLabel(profile), /Kitchen Label Printer/)
})

test('BLE and vendor-driver Bluetooth routes to system print instead of raw Bluetooth', () => {
  const profile = {
    ...base,
    connection_type: 'bluetooth',
    bluetooth_mode: 'ble',
    command_language: 'browser',
  }
  assert.equal(effectiveConnectionType(profile), 'system_print')
  assert.equal(validatePrinterTransport(profile, { nativeAndroid: true }).connection, 'system_print')
  assert.equal(printerRouteLabel(profile), 'Device system print / installed driver')
})

test('Bluetooth Classic remains an Android raw route', () => {
  const profile = {
    ...base,
    connection_type: 'bluetooth',
    bluetooth_mode: 'classic',
    bluetooth_device_name: 'XP-365B',
  }
  assert.equal(validatePrinterTransport(profile, { nativeAndroid: true }).connection, 'bluetooth')
  assert.throws(() => validatePrinterTransport(profile, { nativeAndroid: false }), /Android app/i)
})
