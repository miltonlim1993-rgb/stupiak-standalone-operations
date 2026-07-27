import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const androidRoot = path.join(root, 'web', 'android')
const javaRoot = path.join(androidRoot, 'app', 'src', 'main', 'java', 'com', 'stupiaks', 'ops')
const mainActivityPath = path.join(javaRoot, 'MainActivity.java')
const pluginPath = path.join(javaRoot, 'DirectLabelPrintPlugin.java')
const manifestPath = path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml')

await fs.mkdir(javaRoot, { recursive: true })

let mainActivity = await fs.readFile(mainActivityPath, 'utf8')
const registration =
  'registerPlugin(DirectLabelPrintPlugin.class);'

if (!mainActivity.includes(registration)) {
  if (!mainActivity.includes('import android.os.Bundle;')) {
    const packagePattern = /package\s+[^;]+;/

    if (!packagePattern.test(mainActivity)) {
      throw new Error(
        'Unable to find MainActivity package declaration',
      )
    }

    mainActivity = mainActivity.replace(
      packagePattern,
      (declaration) =>
        `${declaration}\n\nimport android.os.Bundle;`,
    )
  }

  const onCreatePattern =
    /((?:public|protected)\s+void\s+onCreate\s*\(\s*Bundle\s+savedInstanceState\s*\)\s*\{)/

  if (onCreatePattern.test(mainActivity)) {
    mainActivity = mainActivity.replace(
      onCreatePattern,
      (match) =>
        `${match}\n        ${registration}`,
    )
  } else {
    const classPattern =
      /(public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{)/

    if (!classPattern.test(mainActivity)) {
      throw new Error(
        'Unable to find Capacitor MainActivity class',
      )
    }

    mainActivity = mainActivity.replace(
      classPattern,
      `$1
    @Override
    public void onCreate(Bundle savedInstanceState) {
        ${registration}
        super.onCreate(savedInstanceState);
    }
`,
    )
  }

  const registrationCount =
    mainActivity.split(registration).length - 1

  if (registrationCount !== 1) {
    throw new Error(
      `Expected one DirectLabelPrint registration, found ${registrationCount}`,
    )
  }

  const registrationIndex =
    mainActivity.indexOf(registration)

  const superIndex =
    mainActivity.indexOf(
      'super.onCreate(savedInstanceState);',
    )

  if (
    superIndex < 0
    || registrationIndex > superIndex
  ) {
    throw new Error(
      'DirectLabelPrint must register before super.onCreate',
    )
  }

  await fs.writeFile(
    mainActivityPath,
    mainActivity,
  )
}

let manifest = await fs.readFile(manifestPath, 'utf8')
const permissions = [
  '    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />',
  '    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />',
  '    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />',
  '    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />',
]
for (const permission of permissions) {
  const name = permission.match(/android:name="([^"]+)"/)?.[1]
  if (name && !manifest.includes(`android:name="${name}"`)) {
    manifest = manifest.replace(/\s*<application\b/, `\n${permission}\n\n    <application`)
  }
}
await fs.writeFile(manifestPath, manifest)

await fs.writeFile(pluginPath, String.raw`package com.stupiaks.ops;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

@CapacitorPlugin(
    name = "DirectLabelPrint",
    permissions = {
        @Permission(
            alias = "bluetooth",
            strings = {
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN
            }
        )
    }
)
public class DirectLabelPrintPlugin extends Plugin {
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private final List<WebView> activeViews = new ArrayList<>();

    @PluginMethod
    public void printDirect(PluginCall call) {
        String connectionType = normalized(call.getString("connectionType", ""));
        if ("bluetooth".equals(connectionType)
            && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && getPermissionState("bluetooth") != PermissionState.GRANTED) {
            requestPermissionForAlias("bluetooth", call, "bluetoothPermissionCallback");
            return;
        }
        prepareDirectPrint(call);
    }

    @PermissionCallback
    private void bluetoothPermissionCallback(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            || getPermissionState("bluetooth") == PermissionState.GRANTED) {
            prepareDirectPrint(call);
        } else {
            call.reject("Bluetooth permission is required for direct label printing");
        }
    }

    private void prepareDirectPrint(PluginCall call) {
        final String html = call.getString("html", "");
        if (html == null || html.trim().isEmpty()) {
            call.reject("Label HTML is empty");
            return;
        }

        final double widthMm = positive(call.getDouble("widthMm", 40d), 40d);
        final double heightMm = positive(call.getDouble("heightMm", 30d), 30d);
        final int dpi = clamp(call.getInt("dpi", 203), 72, 600);
        final int copies = clamp(call.getInt("copies", 1), 1, 100);
        final int retryLimit = clamp(call.getInt("retryLimit", 0), 0, 20);
        final String connectionType = normalized(call.getString("connectionType", ""));
        final String commandLanguage = normalized(call.getString("commandLanguage", ""));
        final String ipAddress = safe(call.getString("ipAddress", ""));
        final int port = clamp(call.getInt("port", 9100), 1, 65535);
        final String bluetoothMode = normalized(call.getString("bluetoothMode", "classic"));
        final String bluetoothName = safe(call.getString("bluetoothDeviceName", ""));
        final String bluetoothId = safe(call.getString("bluetoothDeviceId", ""));

        if (!"network".equals(connectionType) && !"bluetooth".equals(connectionType)) {
            call.reject("Direct print needs a Wi-Fi / LAN or Bluetooth printer profile");
            return;
        }
        if ("bluetooth".equals(connectionType) && "ble".equals(bluetoothMode)) {
            call.reject("Direct BLE printing is not supported. Use Bluetooth Classic / paired printer or Wi-Fi / LAN");
            return;
        }
        if (!"tspl".equals(commandLanguage)
            && !"zpl".equals(commandLanguage)
            && !"cpcl".equals(commandLanguage)
            && !"escpos".equals(commandLanguage)) {
            call.reject("Unsupported direct printer command language");
            return;
        }

        final int widthPx = Math.max(64, (int) Math.round((widthMm / 25.4d) * dpi));
        final int heightPx = Math.max(64, (int) Math.round((heightMm / 25.4d) * dpi));

        getActivity().runOnUiThread(() -> {
            try {
                WebView renderView = new WebView(getContext());
                renderView.setBackgroundColor(Color.WHITE);
                WebSettings settings = renderView.getSettings();
                settings.setJavaScriptEnabled(false);
                settings.setUseWideViewPort(true);
                settings.setLoadWithOverviewMode(false);
                settings.setSupportZoom(false);
                settings.setBuiltInZoomControls(false);
                settings.setDisplayZoomControls(false);
                settings.setTextZoom(100);
                renderView.setVerticalScrollBarEnabled(false);
                renderView.setHorizontalScrollBarEnabled(false);
                activeViews.add(renderView);

                final boolean[] rendered = { false };
                renderView.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        if (rendered[0]) return;
                        rendered[0] = true;
                        view.postDelayed(() -> {
                            try {
                                int widthSpec = View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY);
                                int heightSpec = View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY);
                                view.measure(widthSpec, heightSpec);
                                view.layout(0, 0, widthPx, heightPx);

                                Bitmap bitmap = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888);
                                Canvas canvas = new Canvas(bitmap);
                                canvas.drawColor(Color.WHITE);
                                view.draw(canvas);

                                byte[] raster = bitmapToMonochrome(bitmap);
                                bitmap.recycle();
                                byte[] payload = buildPayload(commandLanguage, raster, widthPx, heightPx, widthMm, heightMm, copies);

                                new Thread(() -> sendWithRetry(
                                    call,
                                    view,
                                    payload,
                                    connectionType,
                                    ipAddress,
                                    port,
                                    bluetoothName,
                                    bluetoothId,
                                    retryLimit,
                                    copies,
                                    commandLanguage
                                ), "chefops-direct-label-print").start();
                            } catch (Exception error) {
                                destroyView(view);
                                call.reject(message(error, "Unable to render label for direct printing"));
                            }
                        }, 120L);
                    }
                });

                renderView.loadDataWithBaseURL("https://localhost/", html, "text/html", "UTF-8", null);
            } catch (Exception error) {
                call.reject(message(error, "Unable to prepare direct label print"));
            }
        });
    }

    private void sendWithRetry(
        PluginCall call,
        WebView view,
        byte[] payload,
        String connectionType,
        String ipAddress,
        int port,
        String bluetoothName,
        String bluetoothId,
        int retryLimit,
        int copies,
        String commandLanguage
    ) {
        Exception lastError = null;
        String printer = "";
        int attempts = Math.max(1, retryLimit + 1);

        for (int attempt = 1; attempt <= attempts; attempt++) {
            try {
                if ("network".equals(connectionType)) {
                    printer = sendNetwork(payload, ipAddress, port);
                } else {
                    printer = sendBluetooth(payload, bluetoothName, bluetoothId);
                }

                JSObject result = new JSObject();
                result.put("printed", true);
                result.put("printer", printer);
                result.put("copies", copies);
                result.put("commandLanguage", commandLanguage);
                result.put("connectionType", connectionType);
                result.put("attempt", attempt);
                destroyView(view);
                call.resolve(result);
                return;
            } catch (Exception error) {
                lastError = error;
                if (attempt < attempts) {
                    try {
                        Thread.sleep(250L * attempt);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
        }

        destroyView(view);
        call.reject(message(lastError, "Direct label printing failed"));
    }

    private String sendNetwork(byte[] payload, String ipAddress, int port) throws Exception {
        if (ipAddress == null || ipAddress.trim().isEmpty()) {
            throw new IllegalArgumentException("Printer IP address is missing");
        }
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress(ipAddress.trim(), port), 3500);
            socket.setSoTimeout(3500);
            OutputStream output = socket.getOutputStream();
            output.write(payload);
            output.flush();
            return ipAddress.trim() + ":" + port;
        } finally {
            try { socket.close(); } catch (Exception ignored) {}
        }
    }

    private String sendBluetooth(byte[] payload, String requestedName, String requestedId) throws Exception {
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) throw new IllegalStateException("Bluetooth is unavailable on this device");
        if (!adapter.isEnabled()) throw new IllegalStateException("Turn on Bluetooth before printing");

        Set<BluetoothDevice> bonded = adapter.getBondedDevices();
        BluetoothDevice selected = null;
        String wantedId = safe(requestedId).toUpperCase(Locale.ROOT);
        String wantedName = safe(requestedName).toLowerCase(Locale.ROOT);

        for (BluetoothDevice device : bonded) {
            String address = safe(device.getAddress()).toUpperCase(Locale.ROOT);
            String name = safe(device.getName()).toLowerCase(Locale.ROOT);
            if (!wantedId.isEmpty() && address.equals(wantedId)) {
                selected = device;
                break;
            }
            if (selected == null && !wantedName.isEmpty() && (name.equals(wantedName) || name.contains(wantedName))) {
                selected = device;
            }
        }

        if (selected == null) {
            throw new IllegalStateException("The configured Bluetooth printer is not paired with this phone");
        }

        adapter.cancelDiscovery();
        BluetoothSocket socket = selected.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
        try {
            socket.connect();
            OutputStream output = socket.getOutputStream();
            output.write(payload);
            output.flush();
            return safe(selected.getName()).isEmpty() ? selected.getAddress() : selected.getName();
        } finally {
            try { socket.close(); } catch (Exception ignored) {}
        }
    }

    private byte[] bitmapToMonochrome(Bitmap bitmap) {
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        int widthBytes = (width + 7) / 8;
        byte[] raster = new byte[widthBytes * height];
        int[] row = new int[width];

        for (int y = 0; y < height; y++) {
            bitmap.getPixels(row, 0, width, 0, y, width, 1);
            for (int x = 0; x < width; x++) {
                int color = row[x];
                int alpha = Color.alpha(color);
                int luminance = (Color.red(color) * 299 + Color.green(color) * 587 + Color.blue(color) * 114) / 1000;
                if (alpha > 20 && luminance < 170) {
                    int offset = y * widthBytes + (x / 8);
                    raster[offset] = (byte) (raster[offset] | (0x80 >> (x % 8)));
                }
            }
        }
        return raster;
    }

    private byte[] buildPayload(
        String language,
        byte[] raster,
        int widthPx,
        int heightPx,
        double widthMm,
        double heightMm,
        int copies
    ) throws Exception {
        int widthBytes = (widthPx + 7) / 8;
        if ("tspl".equals(language)) return buildTspl(raster, widthBytes, heightPx, widthMm, heightMm, copies);
        if ("zpl".equals(language)) return buildZpl(raster, widthBytes, heightPx, widthPx, copies);
        if ("cpcl".equals(language)) return buildCpcl(raster, widthBytes, heightPx, widthPx, copies);
        return buildEscPos(raster, widthBytes, heightPx, copies);
    }

    private byte[] buildTspl(byte[] raster, int widthBytes, int heightPx, double widthMm, double heightMm, int copies) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        output.write(String.format(Locale.US,
            "SIZE %.1f mm,%.1f mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 1\r\nCLS\r\nBITMAP 0,0,%d,%d,0,",
            widthMm, heightMm, widthBytes, heightPx
        ).getBytes(StandardCharsets.US_ASCII));
        output.write(raster);
        output.write(String.format(Locale.US, "\r\nPRINT 1,%d\r\n", copies).getBytes(StandardCharsets.US_ASCII));
        return output.toByteArray();
    }

    private byte[] buildZpl(byte[] raster, int widthBytes, int heightPx, int widthPx, int copies) {
        String hex = toHex(raster);
        int total = raster.length;
        String command = String.format(Locale.US,
            "^XA^PW%d^LL%d^FO0,0^GFA,%d,%d,%d,%s^FS^PQ%d^XZ",
            widthPx, heightPx, total, total, widthBytes, hex, copies
        );
        return command.getBytes(StandardCharsets.US_ASCII);
    }

    private byte[] buildCpcl(byte[] raster, int widthBytes, int heightPx, int widthPx, int copies) {
        String command = String.format(Locale.US,
            "! 0 200 200 %d %d\r\nPW %d\r\nEG %d %d 0 0 %s\r\nFORM\r\nPRINT\r\n",
            heightPx, copies, widthPx, widthBytes, heightPx, toHex(raster)
        );
        return command.getBytes(StandardCharsets.US_ASCII);
    }

    private byte[] buildEscPos(byte[] raster, int widthBytes, int heightPx, int copies) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        for (int copy = 0; copy < copies; copy++) {
            output.write(new byte[] {
                0x1D, 0x76, 0x30, 0x00,
                (byte) (widthBytes & 0xFF), (byte) ((widthBytes >> 8) & 0xFF),
                (byte) (heightPx & 0xFF), (byte) ((heightPx >> 8) & 0xFF)
            });
            output.write(raster);
            output.write(new byte[] { 0x0A, 0x0A });
        }
        return output.toByteArray();
    }

    private String toHex(byte[] bytes) {
        char[] hex = "0123456789ABCDEF".toCharArray();
        char[] result = new char[bytes.length * 2];
        for (int index = 0; index < bytes.length; index++) {
            int value = bytes[index] & 0xFF;
            result[index * 2] = hex[value >>> 4];
            result[index * 2 + 1] = hex[value & 0x0F];
        }
        return new String(result);
    }

    private void destroyView(WebView view) {
        getActivity().runOnUiThread(() -> {
            activeViews.remove(view);
            try { view.stopLoading(); } catch (Exception ignored) {}
            try { view.destroy(); } catch (Exception ignored) {}
        });
    }

    private static int clamp(Integer value, int minimum, int maximum) {
        int number = value == null ? minimum : value;
        return Math.max(minimum, Math.min(maximum, number));
    }

    private static double positive(Double value, double fallback) {
        return value != null && value > 0d ? value : fallback;
    }

    private static String normalized(String value) {
        return safe(value).toLowerCase(Locale.ROOT);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    private static String message(Exception error, String fallback) {
        if (error == null || error.getMessage() == null || error.getMessage().trim().isEmpty()) return fallback;
        return error.getMessage();
    }
}
`)

console.log('Configured Android direct label printing for Wi-Fi/LAN and paired Bluetooth Classic printers.')
