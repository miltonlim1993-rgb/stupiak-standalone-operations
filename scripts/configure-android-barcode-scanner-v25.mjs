import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const androidRoot = path.join(root, 'web', 'android')
const appGradlePath = path.join(androidRoot, 'app', 'build.gradle')
const manifestPath = path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml')
const javaRoot = path.join(androidRoot, 'app', 'src', 'main', 'java', 'com', 'stupiaks', 'ops')
const mainActivityPath = path.join(javaRoot, 'MainActivity.java')
const pluginPath = path.join(javaRoot, 'NativeBarcodeScannerPlugin.java')

await fs.mkdir(javaRoot, { recursive: true })

let gradle = await fs.readFile(appGradlePath, 'utf8')
const gradleMarker = '// stupiaksNativeBarcodeScannerV25'
if (!gradle.includes(gradleMarker)) {
  const dependenciesOpen = /dependencies\s*\{/m
  if (!dependenciesOpen.test(gradle)) throw new Error('Unable to find dependencies block in app/build.gradle')
  gradle = gradle.replace(
    dependenciesOpen,
    `dependencies {\n    ${gradleMarker}\n    implementation "com.google.android.gms:play-services-code-scanner:16.1.0"`,
  )
}
await fs.writeFile(appGradlePath, gradle)

let manifest = await fs.readFile(manifestPath, 'utf8')
const metadataName = 'com.google.mlkit.vision.DEPENDENCIES'
if (!manifest.includes(`android:name="${metadataName}"`)) {
  const applicationOpen = /(<application\b[^>]*>)/m
  if (!applicationOpen.test(manifest)) throw new Error('Unable to find Android application element')
  manifest = manifest.replace(
    applicationOpen,
    `$1\n        <meta-data android:name="${metadataName}" android:value="barcode_ui" />`,
  )
}
await fs.writeFile(manifestPath, manifest)

let mainActivity = await fs.readFile(mainActivityPath, 'utf8')
const registration = 'registerPlugin(NativeBarcodeScannerPlugin.class);'
if (!mainActivity.includes(registration)) {
  const superCall = 'super.onCreate(savedInstanceState);'
  if (!mainActivity.includes(superCall)) throw new Error('Unable to find MainActivity super.onCreate call')
  mainActivity = mainActivity.replace(superCall, `        ${registration}\n        ${superCall}`)
}
const registrationCount = mainActivity.split(registration).length - 1
if (registrationCount !== 1) throw new Error(`Expected one NativeBarcodeScanner registration, found ${registrationCount}`)
if (mainActivity.indexOf(registration) > mainActivity.indexOf('super.onCreate(savedInstanceState);')) {
  throw new Error('NativeBarcodeScanner must register before super.onCreate')
}
await fs.writeFile(mainActivityPath, mainActivity)

await fs.writeFile(pluginPath, `package com.stupiaks.ops;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

@CapacitorPlugin(name = "NativeBarcodeScanner")
public class NativeBarcodeScannerPlugin extends Plugin {
    @PluginMethod
    public void scan(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(
                    Barcode.FORMAT_EAN_13,
                    Barcode.FORMAT_EAN_8,
                    Barcode.FORMAT_UPC_A,
                    Barcode.FORMAT_UPC_E,
                    Barcode.FORMAT_CODE_128,
                    Barcode.FORMAT_CODE_39,
                    Barcode.FORMAT_QR_CODE
                )
                .enableAutoZoom()
                .build();

            GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(getActivity(), options);
            scanner.startScan()
                .addOnSuccessListener(barcode -> {
                    String rawValue = barcode.getRawValue();
                    if (rawValue == null || rawValue.trim().isEmpty()) {
                        call.reject("No barcode was detected");
                        return;
                    }
                    JSObject result = new JSObject();
                    result.put("rawValue", rawValue.trim());
                    result.put("format", barcode.getFormat());
                    result.put("valueType", barcode.getValueType());
                    result.put("scanner", "google-code-scanner-v25");
                    call.resolve(result);
                })
                .addOnCanceledListener(() -> call.reject("Scan cancelled"))
                .addOnFailureListener(error -> {
                    String message = error.getMessage();
                    call.reject(message == null || message.trim().isEmpty()
                        ? "Barcode scanner could not start"
                        : message);
                });
        });
    }
}
`)

console.log('Android supermarket barcode scanner v25 configured.')
console.log('Plugin: NativeBarcodeScanner')
console.log('Formats: EAN-13, EAN-8, UPC-A/E, Code 128, Code 39, QR')
console.log('Auto zoom: enabled')
