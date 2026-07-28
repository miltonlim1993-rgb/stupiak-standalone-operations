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
const registration = 'registerPlugin(DirectLabelPrintPlugin.class);'

if (!mainActivity.includes(registration)) {
  if (!mainActivity.includes('import android.os.Bundle;')) {
    const packagePattern = /package\s+[^;]+;/
    if (!packagePattern.test(mainActivity)) throw new Error('Unable to find MainActivity package declaration')
    mainActivity = mainActivity.replace(packagePattern, (declaration) => `${declaration}\n\nimport android.os.Bundle;`)
  }

  const onCreatePattern = /((?:public|protected)\s+void\s+onCreate\s*\(\s*Bundle\s+savedInstanceState\s*\)\s*\{)/
  if (onCreatePattern.test(mainActivity)) {
    mainActivity = mainActivity.replace(onCreatePattern, (match) => `${match}\n        ${registration}`)
  } else {
    const classPattern = /(public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{)/
    if (!classPattern.test(mainActivity)) throw new Error('Unable to find Capacitor MainActivity class')
    mainActivity = mainActivity.replace(classPattern, `$1
    @Override
    public void onCreate(Bundle savedInstanceState) {
        ${registration}
        super.onCreate(savedInstanceState);
    }
`)
  }

  const registrationCount = mainActivity.split(registration).length - 1
  if (registrationCount !== 1) throw new Error(`Expected one DirectLabelPrint registration, found ${registrationCount}`)
  const registrationIndex = mainActivity.indexOf(registration)
  const superIndex = mainActivity.indexOf('super.onCreate(savedInstanceState);')
  if (superIndex < 0 || registrationIndex > superIndex) throw new Error('DirectLabelPrint must register before super.onCreate')
  await fs.writeFile(mainActivityPath, mainActivity)
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
import java.io.InputStream;
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
        if (needsBluetoothPermission(call)) {
            requestPermissionForAlias("bluetooth", call, "bluetoothPrintPermissionCallback");
            return;
        }
        prepareDirectPrint(call);
    }

    @PluginMethod
    public void testConnection(PluginCall call) {
        if (needsBluetoothPermission(call)) {
            requestPermissionForAlias("bluetooth", call, "bluetoothTestPermissionCallback");
            return;
        }
        new Thread(() -> runConnectionTest(call), "chefops-printer-connection-test").start();
    }

    @PluginMethod
    public void calibrateMedia(PluginCall call) {
        if (needsBluetoothPermission(call)) {
            requestPermissionForAlias("bluetooth", call, "bluetoothCalibrationPermissionCallback");
            return;
        }
        new Thread(() -> runMediaCalibration(call), "chefops-printer-media-calibration").start();
    }

    @PermissionCallback
    private void bluetoothPrintPermissionCallback(PluginCall call) {
        if (bluetoothGranted()) prepareDirectPrint(call);
        else call.reject("Bluetooth permission is required for direct label printing");
    }

    @PermissionCallback
    private void bluetoothTestPermissionCallback(PluginCall call) {
        if (bluetoothGranted()) new Thread(() -> runConnectionTest(call), "chefops-printer-connection-test").start();
        else call.reject("Bluetooth permission is required to test this printer");
    }

    @PermissionCallback
    private void bluetoothCalibrationPermissionCallback(PluginCall call) {
        if (bluetoothGranted()) new Thread(() -> runMediaCalibration(call), "chefops-printer-media-calibration").start();
        else call.reject("Bluetooth permission is required to calibrate this printer");
    }

    private boolean bluetoothGranted() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || getPermissionState("bluetooth") == PermissionState.GRANTED;
    }

    private boolean needsBluetoothPermission(PluginCall call) {
        return "bluetooth".equals(normalized(call.getString("connectionType", "")))
            && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && getPermissionState("bluetooth") != PermissionState.GRANTED;
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
        final String networkProtocol = normalized(call.getString("networkProtocol", "raw_tcp"));
        final String lprQueue = safe(call.getString("lprQueue", "lp"));
        final String bluetoothName = safe(call.getString("bluetoothDeviceName", ""));
        final String bluetoothId = safe(call.getString("bluetoothDeviceId", ""));
        final int timeoutMs = clamp(call.getInt("connectionTimeoutMs", 4000), 1000, 30000);
        final String mediaSensor = normalized(call.getString("mediaSensor", "gap"));
        final double gapMm = range(call.getDouble("gapMm", 2d), 2d, 0d, 20d);
        final double gapOffsetMm = range(call.getDouble("gapOffsetMm", 0d), 0d, -20d, 20d);
        final double blackMarkMm = range(call.getDouble("blackMarkMm", 2d), 2d, 0d, 20d);
        final double blackMarkOffsetMm = range(call.getDouble("blackMarkOffsetMm", 0d), 0d, -20d, 20d);
        final int speedMmS = clamp(call.getInt("printSpeedMmS", 76), 10, 305);
        final int darkness = clamp(call.getInt("darkness", 8), 0, 15);
        final double xOffsetMm = range(call.getDouble("xOffsetMm", 0d), 0d, -20d, 20d);
        final double yOffsetMm = range(call.getDouble("yOffsetMm", 0d), 0d, -20d, 20d);

        try {
            validateConnection(connectionType, networkProtocol, commandLanguage, ipAddress, bluetoothName, bluetoothId);
        } catch (Exception error) {
            call.reject(message(error, "Invalid printer profile"));
            return;
        }

        final int widthPx = Math.max(64, (int) Math.round((widthMm / 25.4d) * dpi));
        final int heightPx = Math.max(64, (int) Math.round((heightMm / 25.4d) * dpi));
        final int xOffsetPx = (int) Math.round((xOffsetMm / 25.4d) * dpi);
        final int yOffsetPx = (int) Math.round((yOffsetMm / 25.4d) * dpi);

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

                                Bitmap sourceBitmap = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888);
                                Canvas sourceCanvas = new Canvas(sourceBitmap);
                                sourceCanvas.drawColor(Color.WHITE);
                                view.draw(sourceCanvas);

                                Bitmap outputBitmap = sourceBitmap;
                                if (xOffsetPx != 0 || yOffsetPx != 0) {
                                    outputBitmap = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888);
                                    Canvas offsetCanvas = new Canvas(outputBitmap);
                                    offsetCanvas.drawColor(Color.WHITE);
                                    offsetCanvas.drawBitmap(sourceBitmap, xOffsetPx, yOffsetPx, null);
                                    sourceBitmap.recycle();
                                }

                                byte[] raster = bitmapToMonochrome(outputBitmap);
                                outputBitmap.recycle();
                                byte[] payload = buildPayload(
                                    commandLanguage, raster, widthPx, heightPx, widthMm, heightMm, copies,
                                    mediaSensor, gapMm, gapOffsetMm, blackMarkMm, blackMarkOffsetMm,
                                    speedMmS, darkness
                                );

                                new Thread(() -> sendWithRetry(
                                    call, view, payload, connectionType, networkProtocol, lprQueue,
                                    ipAddress, port, bluetoothName, bluetoothId, timeoutMs,
                                    retryLimit, copies, commandLanguage
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

    private void runConnectionTest(PluginCall call) {
        try {
            ConnectionSettings settings = connectionSettings(call);
            String printer = testTransport(settings);
            JSObject result = new JSObject();
            result.put("connected", true);
            result.put("printer", printer);
            result.put("connectionType", settings.connectionType);
            result.put("networkProtocol", settings.networkProtocol);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(message(error, "Printer connection test failed"));
        }
    }

    private void runMediaCalibration(PluginCall call) {
        try {
            ConnectionSettings settings = connectionSettings(call);
            String language = normalized(call.getString("commandLanguage", ""));
            String sensor = normalized(call.getString("mediaSensor", "gap"));
            if ("escpos".equals(language)) throw new IllegalArgumentException("ESC/POS has no standard media calibration command");
            if ("continuous".equals(sensor)) throw new IllegalArgumentException("Continuous media does not use gap or black-mark calibration");
            byte[] payload = calibrationPayload(language, sensor);
            String printer = sendTransport(payload, settings);
            JSObject result = new JSObject();
            result.put("calibrated", true);
            result.put("printer", printer);
            result.put("commandLanguage", language);
            result.put("mediaSensor", sensor);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(message(error, "Printer media calibration failed"));
        }
    }

    private ConnectionSettings connectionSettings(PluginCall call) {
        String connectionType = normalized(call.getString("connectionType", ""));
        String networkProtocol = normalized(call.getString("networkProtocol", "raw_tcp"));
        String commandLanguage = normalized(call.getString("commandLanguage", ""));
        String ipAddress = safe(call.getString("ipAddress", ""));
        int port = clamp(call.getInt("port", "lpr".equals(networkProtocol) ? 515 : 9100), 1, 65535);
        String lprQueue = safe(call.getString("lprQueue", "lp"));
        String bluetoothName = safe(call.getString("bluetoothDeviceName", ""));
        String bluetoothId = safe(call.getString("bluetoothDeviceId", ""));
        int timeoutMs = clamp(call.getInt("connectionTimeoutMs", 4000), 1000, 30000);
        validateConnection(connectionType, networkProtocol, commandLanguage, ipAddress, bluetoothName, bluetoothId);
        return new ConnectionSettings(connectionType, networkProtocol, ipAddress, port, lprQueue, bluetoothName, bluetoothId, timeoutMs);
    }

    private void validateConnection(String connectionType, String networkProtocol, String commandLanguage, String ipAddress, String bluetoothName, String bluetoothId) {
        if (!"network".equals(connectionType) && !"bluetooth".equals(connectionType)) {
            throw new IllegalArgumentException("Direct print needs Wi-Fi / LAN or Bluetooth Classic");
        }
        if ("network".equals(connectionType)) {
            if (ipAddress.isEmpty()) throw new IllegalArgumentException("Printer IP address is missing");
            if (!"raw_tcp".equals(networkProtocol) && !"lpr".equals(networkProtocol)) {
                throw new IllegalArgumentException("Unsupported network protocol");
            }
        }
        if ("bluetooth".equals(connectionType) && bluetoothName.isEmpty() && bluetoothId.isEmpty()) {
            throw new IllegalArgumentException("Paired Bluetooth printer name or MAC address is missing");
        }
        if (!commandLanguage.isEmpty()
            && !"tspl".equals(commandLanguage)
            && !"zpl".equals(commandLanguage)
            && !"cpcl".equals(commandLanguage)
            && !"escpos".equals(commandLanguage)) {
            throw new IllegalArgumentException("Unsupported direct printer command language");
        }
    }

    private void sendWithRetry(
        PluginCall call, WebView view, byte[] payload, String connectionType,
        String networkProtocol, String lprQueue, String ipAddress, int port,
        String bluetoothName, String bluetoothId, int timeoutMs, int retryLimit,
        int copies, String commandLanguage
    ) {
        Exception lastError = null;
        String printer = "";
        int attempts = Math.max(1, retryLimit + 1);

        for (int attempt = 1; attempt <= attempts; attempt++) {
            try {
                ConnectionSettings settings = new ConnectionSettings(
                    connectionType, networkProtocol, ipAddress, port, lprQueue,
                    bluetoothName, bluetoothId, timeoutMs
                );
                printer = sendTransport(payload, settings);
                JSObject result = new JSObject();
                result.put("printed", true);
                result.put("printer", printer);
                result.put("copies", copies);
                result.put("commandLanguage", commandLanguage);
                result.put("connectionType", connectionType);
                result.put("networkProtocol", networkProtocol);
                result.put("attempt", attempt);
                destroyView(view);
                call.resolve(result);
                return;
            } catch (Exception error) {
                lastError = error;
                if (attempt < attempts) {
                    try { Thread.sleep(250L * attempt); }
                    catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
        }

        destroyView(view);
        call.reject(message(lastError, "Direct label printing failed"));
    }

    private String testTransport(ConnectionSettings settings) throws Exception {
        if ("network".equals(settings.connectionType)) {
            Socket socket = new Socket();
            try {
                socket.connect(new InetSocketAddress(settings.ipAddress, settings.port), settings.timeoutMs);
                return settings.ipAddress + ":" + settings.port;
            } finally {
                try { socket.close(); } catch (Exception ignored) {}
            }
        }
        BluetoothSocket socket = openBluetooth(settings.bluetoothName, settings.bluetoothId);
        try {
            BluetoothDevice device = socket.getRemoteDevice();
            return safe(device.getName()).isEmpty() ? device.getAddress() : device.getName();
        } finally {
            try { socket.close(); } catch (Exception ignored) {}
        }
    }

    private String sendTransport(byte[] payload, ConnectionSettings settings) throws Exception {
        if ("network".equals(settings.connectionType)) {
            if ("lpr".equals(settings.networkProtocol)) {
                return sendNetworkLpr(payload, settings.ipAddress, settings.port, settings.lprQueue, settings.timeoutMs);
            }
            return sendNetworkRaw(payload, settings.ipAddress, settings.port, settings.timeoutMs);
        }
        return sendBluetooth(payload, settings.bluetoothName, settings.bluetoothId);
    }

    private String sendNetworkRaw(byte[] payload, String ipAddress, int port, int timeoutMs) throws Exception {
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress(ipAddress.trim(), port), timeoutMs);
            socket.setSoTimeout(timeoutMs);
            OutputStream output = socket.getOutputStream();
            output.write(payload);
            output.flush();
            return ipAddress.trim() + ":" + port;
        } finally {
            try { socket.close(); } catch (Exception ignored) {}
        }
    }

    private String sendNetworkLpr(byte[] payload, String ipAddress, int port, String queue, int timeoutMs) throws Exception {
        String safeQueue = safe(queue).isEmpty() ? "lp" : safe(queue);
        String host = "stupiaks-ops";
        String controlName = "cfA001" + host;
        String dataName = "dfA001" + host;
        byte[] control = ("H" + host + "\nPstupiaks\nJStupiak Label\nl" + dataName + "\nU" + dataName + "\nNlabel\n").getBytes(StandardCharsets.US_ASCII);

        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress(ipAddress.trim(), port), timeoutMs);
            socket.setSoTimeout(timeoutMs);
            InputStream input = socket.getInputStream();
            OutputStream output = socket.getOutputStream();
            lprCommand(output, input, (byte) 0x02, safeQueue + "\n");
            lprCommand(output, input, (byte) 0x02, control.length + " " + controlName + "\n");
            output.write(control);
            output.write(0);
            output.flush();
            requireLprAck(input);
            lprCommand(output, input, (byte) 0x03, payload.length + " " + dataName + "\n");
            output.write(payload);
            output.write(0);
            output.flush();
            requireLprAck(input);
            return ipAddress.trim() + ":" + port + "/" + safeQueue;
        } finally {
            try { socket.close(); } catch (Exception ignored) {}
        }
    }

    private void lprCommand(OutputStream output, InputStream input, byte command, String text) throws Exception {
        output.write(command);
        output.write(text.getBytes(StandardCharsets.US_ASCII));
        output.flush();
        requireLprAck(input);
    }

    private void requireLprAck(InputStream input) throws Exception {
        int ack = input.read();
        if (ack != 0) throw new IllegalStateException("LPR printer rejected the print job");
    }

    private BluetoothSocket openBluetooth(String requestedName, String requestedId) throws Exception {
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

        if (selected == null) throw new IllegalStateException("The configured Bluetooth printer is not paired with this phone");
        adapter.cancelDiscovery();
        BluetoothSocket socket = selected.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
        socket.connect();
        return socket;
    }

    private String sendBluetooth(byte[] payload, String requestedName, String requestedId) throws Exception {
        BluetoothSocket socket = openBluetooth(requestedName, requestedId);
        try {
            OutputStream output = socket.getOutputStream();
            output.write(payload);
            output.flush();
            BluetoothDevice selected = socket.getRemoteDevice();
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
        String language, byte[] raster, int widthPx, int heightPx,
        double widthMm, double heightMm, int copies, String mediaSensor,
        double gapMm, double gapOffsetMm, double blackMarkMm,
        double blackMarkOffsetMm, int speedMmS, int darkness
    ) throws Exception {
        int widthBytes = (widthPx + 7) / 8;
        if ("tspl".equals(language)) return buildTspl(raster, widthBytes, heightPx, widthMm, heightMm, copies, mediaSensor, gapMm, gapOffsetMm, blackMarkMm, blackMarkOffsetMm, speedMmS, darkness);
        if ("zpl".equals(language)) return buildZpl(raster, widthBytes, heightPx, widthPx, copies, mediaSensor, speedMmS, darkness);
        if ("cpcl".equals(language)) return buildCpcl(raster, widthBytes, heightPx, widthPx, copies, mediaSensor, speedMmS, darkness);
        return buildEscPos(raster, widthBytes, heightPx, copies);
    }

    private byte[] buildTspl(
        byte[] raster, int widthBytes, int heightPx, double widthMm,
        double heightMm, int copies, String mediaSensor, double gapMm,
        double gapOffsetMm, double blackMarkMm, double blackMarkOffsetMm,
        int speedMmS, int darkness
    ) throws Exception {
        String sensor = tsplSensor(mediaSensor, gapMm, gapOffsetMm, blackMarkMm, blackMarkOffsetMm);
        int speedIps = clamp((int) Math.round(speedMmS / 25.4d), 1, 12);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        output.write(String.format(Locale.US,
            "SIZE %.1f mm,%.1f mm\r\n%s\r\nSPEED %d\r\nDENSITY %d\r\nDIRECTION 1\r\nCLS\r\nBITMAP 0,0,%d,%d,0,",
            widthMm, heightMm, sensor, speedIps, darkness, widthBytes, heightPx
        ).getBytes(StandardCharsets.US_ASCII));
        output.write(raster);
        output.write(String.format(Locale.US, "\r\nPRINT 1,%d\r\n", copies).getBytes(StandardCharsets.US_ASCII));
        return output.toByteArray();
    }

    private String tsplSensor(String mediaSensor, double gapMm, double gapOffsetMm, double blackMarkMm, double blackMarkOffsetMm) {
        if ("black_mark".equals(mediaSensor)) return String.format(Locale.US, "BLINE %.1f mm,%.1f mm", blackMarkMm, blackMarkOffsetMm);
        if ("continuous".equals(mediaSensor)) return "GAP 0 mm,0 mm";
        return String.format(Locale.US, "GAP %.1f mm,%.1f mm", gapMm, gapOffsetMm);
    }

    private byte[] buildZpl(byte[] raster, int widthBytes, int heightPx, int widthPx, int copies, String mediaSensor, int speedMmS, int darkness) {
        String hex = toHex(raster);
        int total = raster.length;
        int speedIps = clamp((int) Math.round(speedMmS / 25.4d), 1, 14);
        int darknessZpl = clamp(darkness * 2, 0, 30);
        String media = "black_mark".equals(mediaSensor) ? "^MNM" : "continuous".equals(mediaSensor) ? "^MNN" : "^MNY";
        String command = String.format(Locale.US,
            "~SD%02d^XA%s^PR%d^PW%d^LL%d^FO0,0^GFA,%d,%d,%d,%s^FS^PQ%d^XZ",
            darknessZpl, media, speedIps, widthPx, heightPx, total, total, widthBytes, hex, copies
        );
        return command.getBytes(StandardCharsets.US_ASCII);
    }

    private byte[] buildCpcl(byte[] raster, int widthBytes, int heightPx, int widthPx, int copies, String mediaSensor, int speedMmS, int darkness) {
        int speed = clamp((int) Math.round(speedMmS / 25.4d), 1, 5);
        int tone = clamp((int) Math.round((darkness / 15d) * 200d), 0, 200);
        String sensor = "black_mark".equals(mediaSensor) ? "BAR-SENSE" : "continuous".equals(mediaSensor) ? "JOURNAL" : "GAP-SENSE";
        String command = String.format(Locale.US,
            "! 0 200 200 %d %d\r\nPW %d\r\n%s\r\nSPEED %d\r\nTONE %d\r\nEG %d %d 0 0 %s\r\nFORM\r\nPRINT\r\n",
            heightPx, copies, widthPx, sensor, speed, tone, widthBytes, heightPx, toHex(raster)
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

    private byte[] calibrationPayload(String language, String mediaSensor) {
        if ("tspl".equals(language)) {
            String command = "black_mark".equals(mediaSensor) ? "BLINEDETECT\r\n" : "GAPDETECT\r\n";
            return command.getBytes(StandardCharsets.US_ASCII);
        }
        if ("zpl".equals(language)) {
            String media = "black_mark".equals(mediaSensor) ? "^MNM" : "^MNY";
            return ("^XA" + media + "^XZ~JC").getBytes(StandardCharsets.US_ASCII);
        }
        if ("cpcl".equals(language)) {
            String sensor = "black_mark".equals(mediaSensor) ? "BAR-SENSE" : "GAP-SENSE";
            return ("! UTILITIES\r\n" + sensor + "\r\nFORM\r\nPRINT\r\n").getBytes(StandardCharsets.US_ASCII);
        }
        throw new IllegalArgumentException("This command language does not support automatic media calibration");
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

    private static double range(Double value, double fallback, double minimum, double maximum) {
        double number = value == null || !Double.isFinite(value) ? fallback : value;
        return Math.max(minimum, Math.min(maximum, number));
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

    private static class ConnectionSettings {
        final String connectionType;
        final String networkProtocol;
        final String ipAddress;
        final int port;
        final String lprQueue;
        final String bluetoothName;
        final String bluetoothId;
        final int timeoutMs;

        ConnectionSettings(String connectionType, String networkProtocol, String ipAddress, int port, String lprQueue, String bluetoothName, String bluetoothId, int timeoutMs) {
            this.connectionType = connectionType;
            this.networkProtocol = networkProtocol;
            this.ipAddress = ipAddress;
            this.port = port;
            this.lprQueue = lprQueue;
            this.bluetoothName = bluetoothName;
            this.bluetoothId = bluetoothId;
            this.timeoutMs = timeoutMs;
        }
    }
}
`)

console.log('Configured Android direct label printing with Raw TCP/LPR, Bluetooth Classic, media calibration and printer tuning.')
