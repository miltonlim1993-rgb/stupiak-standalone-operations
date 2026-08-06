import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const pluginPath = path.join(
  root,
  'web',
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'stupiaks',
  'ops',
  'DirectLabelPrintPlugin.java',
)

let source = await fs.readFile(pluginPath, 'utf8')

function replaceOnce(search, replacement, label) {
  if (source.includes(replacement)) return
  if (!source.includes(search)) throw new Error(`Unable to install ${label}: source marker was not found`)
  source = source.replace(search, replacement)
}

replaceOnce(
  'import android.os.Build;\n',
  'import android.os.Build;\nimport android.util.Base64;\n',
  'Android Base64 import',
)

replaceOnce(
  '        final String html = call.getString("html", "");\n',
  '        final String html = call.getString("html", "");\n        final String rawCommandBase64 = safe(call.getString("rawCommandBase64", ""));\n        final String renderMode = safe(call.getString("renderMode", "html-raster"));\n',
  'raw TSPL request fields',
)

replaceOnce(
  '        final int widthPx = Math.max(64, (int) Math.round((widthMm / 25.4d) * dpi));\n',
  `        if (!rawCommandBase64.isEmpty()) {
            try {
                final byte[] rawPayload = Base64.decode(rawCommandBase64, Base64.DEFAULT);
                if (rawPayload.length == 0) throw new IllegalArgumentException("Native TSPL payload is empty");
                new Thread(() -> sendWithRetry(
                    call, null, rawPayload, connectionType, networkProtocol, lprQueue,
                    ipAddress, port, bluetoothName, bluetoothId, timeoutMs,
                    retryLimit, copies, commandLanguage, renderMode
                ), "chefops-native-tspl-food-label").start();
                return;
            } catch (Exception error) {
                call.reject(message(error, "Unable to decode native TSPL food-label payload"));
                return;
            }
        }

        final int widthPx = Math.max(64, (int) Math.round((widthMm / 25.4d) * dpi));
`,
  'raw TSPL fast path',
)

replaceOnce(
  `                                    retryLimit, copies, commandLanguage
                                ), "chefops-direct-label-print").start();`,
  `                                    retryLimit, copies, commandLanguage, "html-raster"
                                ), "chefops-direct-label-print").start();`,
  'raster render mode',
)

replaceOnce(
  `        int copies, String commandLanguage
    ) {`,
  `        int copies, String commandLanguage, String renderMode
    ) {`,
  'render mode method argument',
)

replaceOnce(
  `                result.put("networkProtocol", networkProtocol);
                result.put("attempt", attempt);`,
  `                result.put("networkProtocol", networkProtocol);
                result.put("renderMode", renderMode);
                result.put("attempt", attempt);`,
  'render mode result telemetry',
)

replaceOnce(
  `    private void destroyView(WebView view) {
        getActivity().runOnUiThread(() -> {`,
  `    private void destroyView(WebView view) {
        if (view == null) return;
        getActivity().runOnUiThread(() -> {`,
  'null-safe WebView cleanup',
)

const required = [
  'rawCommandBase64',
  'chefops-native-tspl-food-label',
  'Base64.decode',
  'result.put("renderMode", renderMode)',
  'if (view == null) return;',
]
for (const marker of required) {
  if (!source.includes(marker)) throw new Error(`Android TSPL compatibility marker is missing: ${marker}`)
}

await fs.writeFile(pluginPath, source)
console.log('Configured Android native TSPL food-label compatibility path with raster fallback.')
