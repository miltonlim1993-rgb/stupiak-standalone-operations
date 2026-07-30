import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const androidRoot = path.join(root, 'web', 'android')
const javaRoot = path.join(androidRoot, 'app', 'src', 'main', 'java', 'com', 'stupiaks', 'ops')
const sourceRoot = path.join(root, 'scripts', 'android-task-alarm')
const mainActivityPath = path.join(javaRoot, 'MainActivity.java')
const manifestPath = path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml')
const nativeFiles = [
  'TaskAlarmPlugin.java',
  'TaskAlarmScheduler.java',
  'TaskAlarmReceiver.java',
  'TaskAlarmBootReceiver.java',
  'TaskAlarmService.java',
  'TaskAlarmActivity.java',
]

await fs.mkdir(javaRoot, { recursive: true })
for (const file of nativeFiles) {
  await fs.copyFile(path.join(sourceRoot, file), path.join(javaRoot, file))
}

let mainActivity = await fs.readFile(mainActivityPath, 'utf8')
if (!mainActivity.includes('registerPlugin(TaskAlarmPlugin.class);')) {
  const anchor = mainActivity.includes('registerPlugin(DirectLabelPrintPlugin.class);')
    ? '        registerPlugin(DirectLabelPrintPlugin.class);\n'
    : '        registerPlugin(NativeLabelPrintPlugin.class);\n'
  if (!mainActivity.includes(anchor)) throw new Error('Unable to find Android plugin registration anchor')
  mainActivity = mainActivity.replace(anchor, `${anchor}        registerPlugin(TaskAlarmPlugin.class);\n`)
}

if (!mainActivity.includes('import android.content.Intent;')) {
  mainActivity = mainActivity.replace('import android.graphics.Color;\n', 'import android.content.Intent;\nimport android.graphics.Color;\n')
}
if (!mainActivity.includes('import org.json.JSONObject;')) {
  mainActivity = mainActivity.replace('import com.getcapacitor.BridgeActivity;\n', 'import com.getcapacitor.BridgeActivity;\n\nimport org.json.JSONObject;\n')
}

if (!mainActivity.includes('deliverAlertTarget(getIntent());')) {
  const anchor = '        WindowCompat.getInsetsController(getWindow(), webView).setAppearanceLightNavigationBars(true);\n'
  if (!mainActivity.includes(anchor)) throw new Error('Unable to find MainActivity system-bar anchor')
  mainActivity = mainActivity.replace(anchor, `${anchor}\n        deliverAlertTarget(getIntent());\n`)
}

if (!mainActivity.includes('private void deliverAlertTarget(Intent intent)')) {
  const insertAt = mainActivity.lastIndexOf('\n}')
  if (insertAt < 0) throw new Error('Unexpected MainActivity structure')
  const methods = String.raw`

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        deliverAlertTarget(intent);
    }

    private void deliverAlertTarget(Intent intent) {
        if (intent == null) return;
        String targetPage = intent.getStringExtra(TaskAlarmScheduler.EXTRA_TARGET_PAGE);
        if (targetPage == null || targetPage.trim().isEmpty()) return;
        intent.removeExtra(TaskAlarmScheduler.EXTRA_TARGET_PAGE);

        WebView webView = getBridge().getWebView();
        String quotedTarget = JSONObject.quote(targetPage.trim());
        String script = "window.__chefopsPendingAlertTarget=" + quotedTarget
            + ";window.dispatchEvent(new CustomEvent('chefops:native-alert-open',{detail:{targetPage:window.__chefopsPendingAlertTarget}}));";
        Runnable deliver = () -> webView.evaluateJavascript(script, null);
        webView.postDelayed(deliver, 650L);
        webView.postDelayed(deliver, 1800L);
    }
`
  mainActivity = `${mainActivity.slice(0, insertAt)}${methods}${mainActivity.slice(insertAt)}`
}
await fs.writeFile(mainActivityPath, mainActivity)

let manifest = await fs.readFile(manifestPath, 'utf8')
const permissions = [
  '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  '    <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />',
  '    <uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT" />',
  '    <uses-permission android:name="android.permission.WAKE_LOCK" />',
  '    <uses-permission android:name="android.permission.VIBRATE" />',
  '    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />',
  '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
  '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />',
]
for (const permission of permissions) {
  const name = permission.match(/android:name="([^"]+)"/)?.[1]
  if (name && !manifest.includes(`android:name="${name}"`)) {
    manifest = manifest.replace(/\s*<application\b/, `\n${permission}\n\n    <application`)
  }
}

if (!manifest.includes('android:name=".TaskAlarmReceiver"')) {
  const components = String.raw`
        <!-- Stupiak's Ops Task / SOP alarm runtime -->
        <receiver
            android:name=".TaskAlarmReceiver"
            android:enabled="true"
            android:exported="false" />

        <receiver
            android:name=".TaskAlarmBootReceiver"
            android:enabled="true"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.TIME_SET" />
                <action android:name="android.intent.action.TIMEZONE_CHANGED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
            </intent-filter>
        </receiver>

        <service
            android:name=".TaskAlarmService"
            android:enabled="true"
            android:exported="false"
            android:foregroundServiceType="mediaPlayback" />

        <activity
            android:name=".TaskAlarmActivity"
            android:excludeFromRecents="true"
            android:exported="false"
            android:launchMode="singleTop"
            android:showWhenLocked="true"
            android:turnScreenOn="true"
            android:theme="@style/AppTheme.NoActionBar" />
`
  manifest = manifest.replace(/\s*<\/application>/, `\n${components}\n    </application>`)
}
await fs.writeFile(manifestPath, manifest)

console.log('Configured native Task / SOP exact alarms, reboot recovery, lock-screen UI and continuous alarm service.')
