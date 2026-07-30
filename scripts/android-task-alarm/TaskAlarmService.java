package com.stupiaks.ops;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;

public class TaskAlarmService extends Service {
    public static final String CHANNEL_ID = "stupiaks_ops_alarm_v1";
    public static final String ACTION_START = "com.stupiaks.ops.action.START_TASK_ALARM";
    public static final String ACTION_STOP = "com.stupiaks.ops.action.STOP_TASK_ALARM";
    private static final int NOTIFICATION_ID = 46110;

    private MediaPlayer mediaPlayer;
    private Vibrator vibrator;
    private PowerManager.WakeLock wakeLock;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopAlarm();
            return START_NOT_STICKY;
        }

        String alertId = value(intent, TaskAlarmScheduler.EXTRA_ALERT_ID, "");
        String title = value(intent, TaskAlarmScheduler.EXTRA_TITLE, "Stupiak's Ops");
        String message = value(intent, TaskAlarmScheduler.EXTRA_MESSAGE, "Task / SOP reminder");
        String targetPage = value(intent, TaskAlarmScheduler.EXTRA_TARGET_PAGE, "/tasks");
        String kind = value(intent, TaskAlarmScheduler.EXTRA_KIND, "task");

        startForeground(NOTIFICATION_ID, buildNotification(alertId, title, message, targetPage, kind));
        acquireWakeLock();
        startSound();
        startVibration();
        return START_REDELIVER_INTENT;
    }

    @Override
    public void onDestroy() {
        releaseAlarmResources();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification buildNotification(String alertId, String title, String message, String targetPage, String kind) {
        Intent fullScreen = new Intent(this, TaskAlarmActivity.class)
            .putExtra(TaskAlarmScheduler.EXTRA_ALERT_ID, alertId)
            .putExtra(TaskAlarmScheduler.EXTRA_TITLE, title)
            .putExtra(TaskAlarmScheduler.EXTRA_MESSAGE, message)
            .putExtra(TaskAlarmScheduler.EXTRA_TARGET_PAGE, targetPage)
            .putExtra(TaskAlarmScheduler.EXTRA_KIND, kind)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        PendingIntent fullScreenIntent = PendingIntent.getActivity(
            this,
            TaskAlarmScheduler.requestCode(alertId) ^ 0x11111111,
            fullScreen,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent open = new Intent(this, MainActivity.class)
            .putExtra(TaskAlarmScheduler.EXTRA_TARGET_PAGE, targetPage)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openIntent = PendingIntent.getActivity(
            this,
            TaskAlarmScheduler.requestCode(alertId) ^ 0x22222222,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stop = new Intent(this, TaskAlarmService.class)
            .setAction(ACTION_STOP)
            .putExtra(TaskAlarmScheduler.EXTRA_ALERT_ID, alertId);
        PendingIntent stopIntent = PendingIntent.getService(
            this,
            TaskAlarmScheduler.requestCode(alertId) ^ 0x33333333,
            stop,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Uri alarmUri = alarmUri();
        AudioAttributes attributes = alarmAttributes();
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);

        builder
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setColor(Color.rgb(242, 170, 0))
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(new Notification.BigTextStyle().bigText(message))
            .setCategory(Notification.CATEGORY_ALARM)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setPriority(Notification.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(false)
            .setContentIntent(openIntent)
            .setFullScreenIntent(fullScreenIntent, true)
            .addAction(android.R.drawable.ic_menu_view, "打开任务 / SOP", openIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "已处理，停止", stopIntent);

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setSound(alarmUri, AudioManager.STREAM_ALARM);
            builder.setVibrate(new long[] { 0L, 700L, 250L, 700L, 250L, 1200L });
        } else {
            builder.setSound(alarmUri, attributes);
        }
        return builder.build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Task & SOP alarms",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Urgent Task and SOP reminders that continue until acknowledged.");
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[] { 0L, 700L, 250L, 700L, 250L, 1200L });
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.setSound(alarmUri(), alarmAttributes());
        manager.createNotificationChannel(channel);
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        if (powerManager == null) return;
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "StupiaksOps:TaskAlarm");
        wakeLock.acquire(15 * 60 * 1000L);
    }

    private void startSound() {
        releaseMediaPlayer();
        try {
            audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
            AudioAttributes attributes = alarmAttributes();
            if (audioManager != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                        .setAudioAttributes(attributes)
                        .setAcceptsDelayedFocusGain(false)
                        .build();
                    audioManager.requestAudioFocus(audioFocusRequest);
                } else {
                    audioManager.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
                }
            }

            mediaPlayer = new MediaPlayer();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                mediaPlayer.setAudioAttributes(attributes);
            } else {
                mediaPlayer.setAudioStreamType(AudioManager.STREAM_ALARM);
            }
            mediaPlayer.setDataSource(this, alarmUri());
            mediaPlayer.setLooping(true);
            mediaPlayer.prepare();
            mediaPlayer.start();
        } catch (Exception ignored) {
            releaseMediaPlayer();
        }
    }

    private void startVibration() {
        vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        if (vibrator == null || !vibrator.hasVibrator()) return;
        long[] pattern = new long[] { 0L, 700L, 250L, 700L, 250L, 1200L };
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
        } else {
            vibrator.vibrate(pattern, 0);
        }
    }

    private void stopAlarm() {
        releaseAlarmResources();
        stopForeground(true);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(NOTIFICATION_ID);
        stopSelf();
    }

    private void releaseAlarmResources() {
        releaseMediaPlayer();
        if (vibrator != null) {
            vibrator.cancel();
            vibrator = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }

    private void releaseMediaPlayer() {
        if (mediaPlayer != null) {
            try { mediaPlayer.stop(); } catch (Exception ignored) {}
            try { mediaPlayer.release(); } catch (Exception ignored) {}
            mediaPlayer = null;
        }
        if (audioManager != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
                audioManager.abandonAudioFocusRequest(audioFocusRequest);
            } else {
                audioManager.abandonAudioFocus(null);
            }
        }
        audioFocusRequest = null;
        audioManager = null;
    }

    private AudioAttributes alarmAttributes() {
        return new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
    }

    private Uri alarmUri() {
        Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        if (uri == null) uri = Settings.System.DEFAULT_ALARM_ALERT_URI;
        return uri;
    }

    private String value(Intent intent, String key, String fallback) {
        if (intent == null) return fallback;
        String value = intent.getStringExtra(key);
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }
}
