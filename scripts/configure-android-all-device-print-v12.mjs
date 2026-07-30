import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const androidRoot = path.join(root, 'web', 'android')
const javaRoot = path.join(androidRoot, 'app', 'src', 'main', 'java', 'com', 'stupiaks', 'ops')
const pluginPath = path.join(javaRoot, 'DirectLabelPrintPlugin.java')
const mainActivityPath = path.join(javaRoot, 'MainActivity.java')

const mainActivity = await fs.readFile(mainActivityPath, 'utf8')
if (!mainActivity.includes('registerPlugin(DirectLabelPrintPlugin.class);')) {
  throw new Error('DirectLabelPrintPlugin must be registered before installing all-device print v12')
}

await fs.writeFile(pluginPath, String.raw`package com.stupiaks.ops;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Build;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.util.Base64;
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

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
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
    public void printSystem(PluginCall call) {
        final String html = call.getString("html", "");
        if (html == null || html.trim().isEmpty()) {
            call.reject("Label HTML is empty");
            return;
        }
        final String jobName = safe(call.getString("jobName", "Stupiak Label"));
        final double widthMm = positive(call.getDouble("widthMm", 40d), 40d);
        final double heightMm = positive(call.getDouble("heightMm", 30d), 30d);
        final int dpi = clamp(call.getInt("dpi", 203), 72, 600);

        getActivity().runOnUiThread(() -> {
            try {
                WebView printView = createWebView();
                activeViews.add(printView);
                final boolean[] opened = { false };
                printView.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        if (opened[0]) return;
                        opened[0] = true;
                        view.postDelayed(() -> {
                            try {
                                PrintManager manager = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
                                if (manager == null) throw new IllegalStateException("Android System Print is unavailable");
                                PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(jobName.isEmpty() ? "Stupiak Label" : jobName);
                                int widthMils = Math.max(1, (int) Math.round((widthMm / 25.4d) * 1000d));
                                int heightMils = Math.max(1, (int) Math.round((heightMm / 25.4d) * 1000d));
                                PrintAttributes.MediaSize media = new PrintAttributes.MediaSize(
                                    "STUPIAK_LABEL_" + widthMils + "_" + heightMils,
                                    String.format(Locale.US, "%.1f x %.1f mm", widthMm, heightMm),
                                    widthMils,
                                    heightMils
                                );
                                PrintAttributes attributes = new PrintAttributes.Builder()
                                    .setMediaSize(media)
                                    .setResolution(new PrintAttributes.Resolution("STUPIAK", dpi + " dpi", dpi, dpi))
                                    .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                                    .setColorMode(PrintAttributes.COLOR_MODE_MONOCHROME)
                                    .build();
                                manager.print(jobName.isEmpty() ? "Stupiak Label" : jobName, adapter, attributes);
                                JSObject result = new JSObject();
                                result.put("printed", true);
                                result.put("dialog", true);
                                result.put("printer", "Android System Print / installed driver");
                                result.put("connectionType", "system_print");
                                call.resolve(result);
                                view.postDelayed(() -> destroyView(view), 120000L);
                            } catch (Exception error) {
                                destroyView(view);
                                call.reject(message(error, "Unable to open Android System Print"));
                            }
                        }, 120L);
                    }
                });
                printView.loadDataWithBaseURL("https://localhost/", html, "text/html", "UTF-8", null);
            } catch (Exception error) {
                call.reject(message(error, "Unable to prepare Android System Print"));
            }
        });
    }

    @PluginMethod
    public void testConnection(PluginCall call) {
        if (needsBluetoothPermission(call)) {
            requestPermissionForAlias("bluetooth", call, "bluetoothTestPermissionCallback");
            return;
        }
        new Thread(() -> runConnectionTest(call), "chefops-printer-connection-test-v12").start();
    }

    @PluginMethod
    public void calibrateMedia(PluginCall call) {
        if (needsBluetoothPermission(call)) {
            requestPermissionForAlias("bluetooth", call, "bluetoothCalibrationPermissionCallback");
            return;
        }
        new Thread(() -> runMediaCalibration(call), "chefops-printer-media-calibration-v12").start();
    }

    @PermissionCallback
    private void bluetoothPrintPermissionCallback(PluginCall call) {
        if (bluetoothGranted()) prepareDirectPrint(call);
        else call.reject("Bluetooth permission is required for direct label printing");
    }

    @PermissionCallback
    private void bluetoothTestPermissionCallback(PluginCall call) {
        if (bluetoothGranted()) new Thread(() -> runConnectionTest(call), "chefops-printer-connection-test-v12").start();
        else call.reject("Bluetooth permission is required to test this printer");
    }

    @PermissionCallback
    private void bluetoothCalibrationPermissionCallback(PluginCall call) {
        if (bluetoothGranted()) new Thread(() -> runMediaCalibration(call), "chefops-printer-media-calibration-v12").start();
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

    private WebView createWebView() {
        WebView view = new WebView(getContext());
        view.setBackgroundColor(Color.WHITE);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);
        return view;
    }

    private void prepareDirectPrint(PluginCall call) {
        final String html = call.getString("html", "");
        final String rawCommandBase64 = safe(call.getString("rawCommandBase64", ""));
        final String renderMode = safe(call.getString("renderMode", "html-raster"));
        if ((html == null || html.trim().isEmpty()) && rawCommandBase64.isEmpty()) {
            call.reject("Label HTML and RAW command are empty");
            return;
        }

        final double widthMm = positive(call.getDouble("widthMm", 40d), 40d);
        final double heightMm = positive(call.getDouble("heightMm", 30d), 30d);
        final int dpi = clamp(call.getInt("dpi", 203), 72, 600);
        final int copies = clamp(call.getInt("copies", 1), 1, 100);
        final int retryLimit = clamp(call.getInt("retryLimit", 0), 0, 20);
        final String commandLanguage = normalized(call.getString("commandLanguage", ""));
        final ConnectionSettings connection;
        try {
            connection = connectionSettings(call);
            validateConnection(connection, commandLanguage);
        } catch (Exception error) {
            call.reject(message(error, "Invalid printer profile"));
            return;
        }

        final int timeoutMs = connection.timeoutMs;
        final String mediaSensor = normalized(call.getString("mediaSensor", "gap"));
        final double gapMm = range(call.getDouble("gapMm", 2d), 2d, 0d, 20d);
        final double gapOffsetMm = range(call.getDouble("gapOffsetMm", 0d), 0d, -20d, 20d);
        final double blackMarkMm = range(call.getDouble("blackMarkMm", 2d), 2d, 0d, 20d);
        final double blackMarkOffsetMm = range(call.getDouble("blackMarkOffsetMm", 0d), 0d, -20d, 20d);
        final int speedMmS = clamp(call.getInt("printSpeedMmS", 76), 10, 305);
        final int darkness = clamp(call.getInt("darkness", 8), 0, 15);
        final double xOffsetMm = range(call.getDouble("xOffsetMm", 0d), 0d, -20d, 20d);
        final double yOffsetMm = range(call.getDouble("yOffsetMm", 0d), 0d, -20d, 20d);

        if (!rawCommandBase64.isEmpty()) {
            try {
                final byte[] rawPayload = Base64.decode(rawCommandBase64, Base64.DEFAULT);
                if (rawPayload.length == 0) throw new IllegalArgumentException("Native printer payload is empty");
                new Thread(() -> sendWithRetry(call, null, rawPayload, connection, retryLimit, copies, commandLanguage, renderMode), "chefops-native-command-v12").start();
            } catch (Exception error) {
                call.reject(message(error, "Unable to decode native printer payload"));
            }
            return;
        }

        final int widthPx = Math.max(64, (int) Math.round((widthMm / 25.4d) * dpi));
        final int heightPx = Math.max(64, (int) Math.round((heightMm / 25.4d) * dpi));
        final int xOffsetPx = (int) Math.round((xOffsetMm / 25.4d) * dpi);
        final int yOffsetPx = (int) Math.round((yOffsetMm / 25.4d) * dpi);

        getActivity().runOnUiThread(() -> {
            try {
                WebView renderView = createWebView();
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
                                new Thread(() -> sendWithRetry(call, view, payload, connection, retryLimit, copies, commandLanguage, "html-raster"), "chefops-direct-label-print-v12").start();
                            } catch (Exception error) {
                                destroyView(view);
                                call.reject(message(error, "Unable to render label for printing"));
                            }
                        }, 120L);
                    }
                });
                renderView.loadDataWithBaseURL("https://localhost/", html, "text/html", "UTF-8", null);
            } catch (Exception error) {
                call.reject(message(error, "Unable to prepare label print"));
            }
        });
    }

    private void runConnectionTest(PluginCall call) {
        try {
            ConnectionSettings settings = connectionSettings(call);
            validateConnection(settings, normalized(call.getString("commandLanguage", "")));
            String printer = testTransport(settings);
            JSObject result = new JSObject();
            result.put("connected", true);
            result.put("printer", printer);
            result.put("connectionType", settings.connectionType);
            result.put("networkProtocol", settings.networkProtocol);
            result.put("bridgeTransport", settings.bridgeTransport);
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
            validateConnection(settings, language);
            if ("escpos".equals(language)) throw new IllegalArgumentException("ESC/POS has no standard media calibration command");
            if ("continuous".equals(sensor)) throw new IllegalArgumentException("Continuous media does not use gap or black-mark calibration");
            byte[] payload = calibrationPayload(language, sensor);
            String printer = sendTransport(payload, settings);
            JSObject result = new JSObject();
            result.put("calibrated", true);
            result.put("printer", printer);
            result.put("commandLanguage", language);
            result.put("mediaSensor", sensor);
            result.put("connectionType", settings.connectionType);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(message(error, "Printer media calibration failed"));
        }
    }

    private ConnectionSettings connectionSettings(PluginCall call) {
        String connectionType = normalized(call.getString("connectionType", ""));
        String networkProtocol = normalized(call.getString("networkProtocol", "raw_tcp"));
        String ipAddress = safe(call.getString("ipAddress", ""));
        int port = clamp(call.getInt("port", "lpr".equals(networkProtocol) ? 515 : 9100), 1, 65535);
        String lprQueue = safe(call.getString("lprQueue", "lp"));
        String bluetoothName = safe(call.getString("bluetoothDeviceName", ""));
        String bluetoothId = safe(call.getString("bluetoothDeviceId", ""));
        String bridgeUrl = normalizeBridgeUrl(call.getString("bridgeUrl", ""));
        String bridgeToken = safe(call.getString("bridgeToken", ""));
        String bridgeTransport = normalized(call.getString("bridgeTransport", "queue"));
        String bridgeQueue = safe(call.getString("bridgeQueue", ""));
        String bridgePrinterIp = safe(call.getString("bridgePrinterIp", ""));
        int bridgePrinterPort = clamp(call.getInt("bridgePrinterPort", "lpr".equals(bridgeTransport) ? 515 : 9100), 1, 65535);
        String bridgeLprQueue = safe(call.getString("bridgeLprQueue", "lp"));
        int timeoutMs = clamp(call.getInt("connectionTimeoutMs", 4000), 1000, 30000);
        return new ConnectionSettings(
            connectionType, networkProtocol, ipAddress, port, lprQueue,
            bluetoothName, bluetoothId, bridgeUrl, bridgeToken, bridgeTransport,
            bridgeQueue, bridgePrinterIp, bridgePrinterPort, bridgeLprQueue, timeoutMs
        );
    }

    private void validateConnection(ConnectionSettings settings, String commandLanguage) {
        if (!"network".equals(settings.connectionType)
            && !"bluetooth".equals(settings.connectionType)
            && !"driver_bridge".equals(settings.connectionType)) {
            throw new IllegalArgumentException("Managed print requires Direct Wi-Fi/LAN, Bluetooth Classic, or Driver Bridge");
        }
        if ("network".equals(settings.connectionType)) {
            if (settings.ipAddress.isEmpty()) throw new IllegalArgumentException("Printer IP address is missing");
            if (!"raw_tcp".equals(settings.networkProtocol) && !"lpr".equals(settings.networkProtocol)) throw new IllegalArgumentException("Unsupported network protocol");
        }
        if ("bluetooth".equals(settings.connectionType) && settings.bluetoothName.isEmpty() && settings.bluetoothId.isEmpty()) {
            throw new IllegalArgumentException("Paired Bluetooth printer name or MAC address is missing");
        }
        if ("driver_bridge".equals(settings.connectionType)) {
            if (settings.bridgeUrl.isEmpty()) throw new IllegalArgumentException("Print Bridge URL is missing");
            if (settings.bridgeToken.isEmpty()) throw new IllegalArgumentException("Print Bridge pairing token is missing");
            if ("queue".equals(settings.bridgeTransport) && settings.bridgeQueue.isEmpty()) throw new IllegalArgumentException("Installed printer queue is missing");
            if (!"queue".equals(settings.bridgeTransport) && settings.bridgePrinterIp.isEmpty()) throw new IllegalArgumentException("Bridge printer IP address is missing");
        }
        if (!commandLanguage.isEmpty()
            && !"tspl".equals(commandLanguage)
            && !"zpl".equals(commandLanguage)
            && !"cpcl".equals(commandLanguage)
            && !"escpos".equals(commandLanguage)) {
            throw new IllegalArgumentException("Unsupported printer command language");
        }
    }

    private void sendWithRetry(PluginCall call, WebView view, byte[] payload, ConnectionSettings settings, int retryLimit, int copies, String commandLanguage, String renderMode) {
        Exception lastError = null;
        int attempts = Math.max(1, retryLimit + 1);
        for (int attempt = 1; attempt <= attempts; attempt++) {
            try {
                String printer = sendTransport(payload, settings);
                JSObject result = new JSObject();
                result.put("printed", true);
                result.put("printer", printer);
                result.put("copies", copies);
                result.put("commandLanguage", commandLanguage);
                result.put("connectionType", settings.connectionType);
                result.put("networkProtocol", settings.networkProtocol);
                result.put("bridgeTransport", settings.bridgeTransport);
                result.put("renderMode", renderMode);
                result.put("attempt", attempt);
                destroyView(view);
                call.resolve(result);
                return;
            } catch (Exception error) {
                lastError = error;
                if (attempt < attempts) {
                    try { Thread.sleep(300L * attempt); }
                    catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); break; }
                }
            }
        }
        destroyView(view);
        call.reject(message(lastError, "Label printing failed after all retries"));
    }

    private String testTransport(ConnectionSettings settings) throws Exception {
        if ("driver_bridge".equals(settings.connectionType)) return testBridge(settings);
        if ("network".equals(settings.connectionType)) {
            Socket socket = new Socket();
            try {
                socket.connect(new InetSocketAddress(settings.ipAddress, settings.port), settings.timeoutMs);
                return settings.ipAddress + ":" + settings.port;
            } finally { try { socket.close(); } catch (Exception ignored) {} }
        }
        BluetoothSocket socket = openBluetooth(settings.bluetoothName, settings.bluetoothId);
        try {
            BluetoothDevice device = socket.getRemoteDevice();
            return safe(device.getName()).isEmpty() ? device.getAddress() : device.getName();
        } finally { try { socket.close(); } catch (Exception ignored) {} }
    }

    private String sendTransport(byte[] payload, ConnectionSettings settings) throws Exception {
        if ("driver_bridge".equals(settings.connectionType)) return sendBridge(payload, settings);
        if ("network".equals(settings.connectionType)) {
            if ("lpr".equals(settings.networkProtocol)) return sendNetworkLpr(payload, settings.ipAddress, settings.port, settings.lprQueue, settings.timeoutMs);
            return sendNetworkRaw(payload, settings.ipAddress, settings.port, settings.timeoutMs);
        }
        return sendBluetooth(payload, settings.bluetoothName, settings.bluetoothId);
    }

    private String testBridge(ConnectionSettings settings) throws Exception {
        httpJson("GET", settings.bridgeUrl + "/health", settings.bridgeToken, null, settings.timeoutMs);
        JSONObject body = bridgeTarget(settings);
        JSONObject result = httpJson("POST", settings.bridgeUrl + "/test", settings.bridgeToken, body, settings.timeoutMs);
        return result.optString("printer", "Print Bridge");
    }

    private String sendBridge(byte[] payload, ConnectionSettings settings) throws Exception {
        JSONObject body = bridgeTarget(settings);
        body.put("payloadBase64", Base64.encodeToString(payload, Base64.NO_WRAP));
        body.put("timeoutMs", settings.timeoutMs);
        JSONObject result = httpJson("POST", settings.bridgeUrl + "/print", settings.bridgeToken, body, Math.max(settings.timeoutMs, 10000));
        return result.optString("printer", settings.bridgeQueue.isEmpty() ? "Print Bridge" : settings.bridgeQueue);
    }

    private JSONObject bridgeTarget(ConnectionSettings settings) throws Exception {
        JSONObject body = new JSONObject();
        body.put("mode", settings.bridgeTransport);
        if ("queue".equals(settings.bridgeTransport)) body.put("queue", settings.bridgeQueue);
        else {
            body.put("host", settings.bridgePrinterIp);
            body.put("port", settings.bridgePrinterPort);
            if ("lpr".equals(settings.bridgeTransport)) body.put("queue", settings.bridgeLprQueue);
        }
        return body;
    }

    private JSONObject httpJson(String method, String urlText, String token, JSONObject body, int timeoutMs) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(urlText).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setConnectTimeout(timeoutMs);
            connection.setReadTimeout(timeoutMs);
            connection.setRequestProperty("Accept", "application/json");
            if (!token.isEmpty()) connection.setRequestProperty("X-Print-Bridge-Token", token);
            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); output.flush(); }
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            String text = readStream(stream);
            JSONObject result = text.isEmpty() ? new JSONObject() : new JSONObject(text);
            if (status < 200 || status >= 300 || !result.optBoolean("ok", true)) {
                throw new IllegalStateException(result.optString("error", "Print Bridge request failed (" + status + ")"));
            }
            return result;
        } finally { connection.disconnect(); }
    }

    private String readStream(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) builder.append(line);
        }
        return builder.toString();
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
        } finally { try { socket.close(); } catch (Exception ignored) {} }
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
            output.write(control); output.write(0); output.flush(); requireLprAck(input);
            lprCommand(output, input, (byte) 0x03, payload.length + " " + dataName + "\n");
            output.write(payload); output.write(0); output.flush(); requireLprAck(input);
            return ipAddress.trim() + ":" + port + "/" + safeQueue;
        } finally { try { socket.close(); } catch (Exception ignored) {} }
    }

    private void lprCommand(OutputStream output, InputStream input, byte command, String text) throws Exception {
        output.write(command); output.write(text.getBytes(StandardCharsets.US_ASCII)); output.flush(); requireLprAck(input);
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
            if (!wantedId.isEmpty() && address.equals(wantedId)) { selected = device; break; }
            if (selected == null && !wantedName.isEmpty() && (name.equals(wantedName) || name.contains(wantedName))) selected = device;
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
            output.write(payload); output.flush();
            BluetoothDevice selected = socket.getRemoteDevice();
            return safe(selected.getName()).isEmpty() ? selected.getAddress() : selected.getName();
        } finally { try { socket.close(); } catch (Exception ignored) {} }
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

    private byte[] buildPayload(String language, byte[] raster, int widthPx, int heightPx, double widthMm, double heightMm, int copies, String mediaSensor, double gapMm, double gapOffsetMm, double blackMarkMm, double blackMarkOffsetMm, int speedMmS, int darkness) throws Exception {
        int widthBytes = (widthPx + 7) / 8;
        if ("tspl".equals(language)) return buildTspl(raster, widthBytes, heightPx, widthMm, heightMm, copies, mediaSensor, gapMm, gapOffsetMm, blackMarkMm, blackMarkOffsetMm, speedMmS, darkness);
        if ("zpl".equals(language)) return buildZpl(raster, widthBytes, heightPx, widthPx, copies, mediaSensor, speedMmS, darkness);
        if ("cpcl".equals(language)) return buildCpcl(raster, widthBytes, heightPx, widthPx, copies, mediaSensor, speedMmS, darkness);
        return buildEscPos(raster, widthBytes, heightPx, copies);
    }

    private byte[] buildTspl(byte[] raster, int widthBytes, int heightPx, double widthMm, double heightMm, int copies, String mediaSensor, double gapMm, double gapOffsetMm, double blackMarkMm, double blackMarkOffsetMm, int speedMmS, int darkness) throws Exception {
        String sensor = tsplSensor(mediaSensor, gapMm, gapOffsetMm, blackMarkMm, blackMarkOffsetMm);
        int speedIps = clamp((int) Math.round(speedMmS / 25.4d), 1, 12);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        output.write(String.format(Locale.US, "SIZE %.1f mm,%.1f mm\r\n%s\r\nSPEED %d\r\nDENSITY %d\r\nDIRECTION 1\r\nCLS\r\nBITMAP 0,0,%d,%d,0,", widthMm, heightMm, sensor, speedIps, darkness, widthBytes, heightPx).getBytes(StandardCharsets.US_ASCII));
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
        String command = String.format(Locale.US, "~SD%02d^XA%s^PR%d^PW%d^LL%d^FO0,0^GFA,%d,%d,%d,%s^FS^PQ%d^XZ", darknessZpl, media, speedIps, widthPx, heightPx, total, total, widthBytes, hex, copies);
        return command.getBytes(StandardCharsets.US_ASCII);
    }

    private byte[] buildCpcl(byte[] raster, int widthBytes, int heightPx, int widthPx, int copies, String mediaSensor, int speedMmS, int darkness) {
        int speed = clamp((int) Math.round(speedMmS / 25.4d), 1, 5);
        int tone = clamp((int) Math.round((darkness / 15d) * 200d), 0, 200);
        String sensor = "black_mark".equals(mediaSensor) ? "BAR-SENSE" : "continuous".equals(mediaSensor) ? "JOURNAL" : "GAP-SENSE";
        String command = String.format(Locale.US, "! 0 200 200 %d %d\r\nPW %d\r\n%s\r\nSPEED %d\r\nTONE %d\r\nEG %d %d 0 0 %s\r\nFORM\r\nPRINT\r\n", heightPx, copies, widthPx, sensor, speed, tone, widthBytes, heightPx, toHex(raster));
        return command.getBytes(StandardCharsets.US_ASCII);
    }

    private byte[] buildEscPos(byte[] raster, int widthBytes, int heightPx, int copies) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        for (int copy = 0; copy < copies; copy++) {
            output.write(new byte[] { 0x1D, 0x76, 0x30, 0x00, (byte) (widthBytes & 0xFF), (byte) ((widthBytes >> 8) & 0xFF), (byte) (heightPx & 0xFF), (byte) ((heightPx >> 8) & 0xFF) });
            output.write(raster);
            output.write(new byte[] { 0x0A, 0x0A });
        }
        return output.toByteArray();
    }

    private byte[] calibrationPayload(String language, String mediaSensor) {
        if ("tspl".equals(language)) return ("black_mark".equals(mediaSensor) ? "BLINEDETECT\r\n" : "GAPDETECT\r\n").getBytes(StandardCharsets.US_ASCII);
        if ("zpl".equals(language)) return ("^XA" + ("black_mark".equals(mediaSensor) ? "^MNM" : "^MNY") + "^XZ~JC").getBytes(StandardCharsets.US_ASCII);
        if ("cpcl".equals(language)) return ("! UTILITIES\r\n" + ("black_mark".equals(mediaSensor) ? "BAR-SENSE" : "GAP-SENSE") + "\r\nFORM\r\nPRINT\r\n").getBytes(StandardCharsets.US_ASCII);
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

    private String normalizeBridgeUrl(String value) {
        String url = safe(value).replaceAll("/+$", "");
        if (url.isEmpty()) return "";
        if (!url.matches("(?i)^https?://.*")) url = "http://" + url;
        return url.replaceAll("(?i)/(health|printers|discover|test|print|print-queue|print-usb)$", "");
    }

    private void destroyView(WebView view) {
        if (view == null) return;
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

    private static String normalized(String value) { return safe(value).toLowerCase(Locale.ROOT); }
    private static String safe(String value) { return value == null ? "" : value.trim(); }
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
        final String bridgeUrl;
        final String bridgeToken;
        final String bridgeTransport;
        final String bridgeQueue;
        final String bridgePrinterIp;
        final int bridgePrinterPort;
        final String bridgeLprQueue;
        final int timeoutMs;

        ConnectionSettings(String connectionType, String networkProtocol, String ipAddress, int port, String lprQueue, String bluetoothName, String bluetoothId, String bridgeUrl, String bridgeToken, String bridgeTransport, String bridgeQueue, String bridgePrinterIp, int bridgePrinterPort, String bridgeLprQueue, int timeoutMs) {
            this.connectionType = connectionType;
            this.networkProtocol = networkProtocol;
            this.ipAddress = ipAddress;
            this.port = port;
            this.lprQueue = lprQueue;
            this.bluetoothName = bluetoothName;
            this.bluetoothId = bluetoothId;
            this.bridgeUrl = bridgeUrl;
            this.bridgeToken = bridgeToken;
            this.bridgeTransport = bridgeTransport;
            this.bridgeQueue = bridgeQueue;
            this.bridgePrinterIp = bridgePrinterIp;
            this.bridgePrinterPort = bridgePrinterPort;
            this.bridgeLprQueue = bridgeLprQueue;
            this.timeoutMs = timeoutMs;
        }
    }
}
`)

const source = await fs.readFile(pluginPath, 'utf8')
const required = [
  'public void printSystem(PluginCall call)',
  'driver_bridge',
  'Android System Print / installed driver',
  'X-Print-Bridge-Token',
  'chefops-direct-label-print-v12',
  'result.put("renderMode", renderMode)',
]
for (const marker of required) {
  if (!source.includes(marker)) throw new Error(`All-device Android print marker is missing: ${marker}`)
}

console.log('Configured Android all-device printing v12: System Print, Raw TCP, LPR, Bluetooth Classic and Windows/macOS Print Bridge.')
