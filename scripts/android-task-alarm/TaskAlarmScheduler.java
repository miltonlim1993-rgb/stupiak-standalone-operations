package com.stupiaks.ops;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSArray;

import org.json.JSONArray;
import org.json.JSONObject;

public final class TaskAlarmScheduler {
    public static final String PREFS = "stupiaks_task_alarm_schedule";
    public static final String PREF_SCHEDULE = "schedule";
    public static final String EXTRA_ALERT_ID = "chefops_alert_id";
    public static final String EXTRA_TITLE = "chefops_alert_title";
    public static final String EXTRA_MESSAGE = "chefops_alert_message";
    public static final String EXTRA_TARGET_PAGE = "chefops_target_page";
    public static final String EXTRA_KIND = "chefops_alert_kind";
    public static final String EXTRA_TRIGGER_AT = "chefops_trigger_at";

    private TaskAlarmScheduler() {}

    public static int replaceSchedule(Context context, JSArray source) throws Exception {
        JSONArray alerts = new JSONArray(source.toString());
        cancelSaved(context);
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(PREF_SCHEDULE, alerts.toString())
            .apply();
        return scheduleArray(context, alerts);
    }

    public static int rescheduleSaved(Context context) {
        try {
            String raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(PREF_SCHEDULE, "[]");
            return scheduleArray(context, new JSONArray(raw == null ? "[]" : raw));
        } catch (Exception ignored) {
            return 0;
        }
    }

    private static int scheduleArray(Context context, JSONArray alerts) throws Exception {
        int scheduled = 0;
        long now = System.currentTimeMillis();
        for (int index = 0; index < alerts.length(); index++) {
            JSONObject alert = alerts.optJSONObject(index);
            if (alert == null) continue;
            String id = alert.optString("id", "").trim();
            long triggerAt = alert.optLong("triggerAt", 0L);
            if (id.isEmpty() || triggerAt <= now - 30_000L) continue;
            scheduleOne(context, alert, triggerAt);
            scheduled++;
        }
        return scheduled;
    }

    private static void cancelSaved(Context context) {
        try {
            String raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(PREF_SCHEDULE, "[]");
            JSONArray alerts = new JSONArray(raw == null ? "[]" : raw);
            AlarmManager alarmManager = context.getSystemService(AlarmManager.class);
            if (alarmManager == null) return;
            for (int index = 0; index < alerts.length(); index++) {
                JSONObject alert = alerts.optJSONObject(index);
                if (alert == null) continue;
                String id = alert.optString("id", "").trim();
                if (id.isEmpty()) continue;
                PendingIntent pending = alarmPendingIntent(context, id, alert, PendingIntent.FLAG_NO_CREATE);
                if (pending != null) alarmManager.cancel(pending);
            }
        } catch (Exception ignored) {
        }
    }

    private static void scheduleOne(Context context, JSONObject alert, long triggerAt) {
        AlarmManager alarmManager = context.getSystemService(AlarmManager.class);
        if (alarmManager == null) return;
        String id = alert.optString("id", "");
        PendingIntent operation = alarmPendingIntent(context, id, alert, PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent showIntent = openPendingIntent(context, id, alert);
        if (operation == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, operation);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            alarmManager.setAlarmClock(new AlarmManager.AlarmClockInfo(triggerAt, showIntent), operation);
        } else {
            alarmManager.setExact(AlarmManager.RTC_WAKEUP, triggerAt, operation);
        }
    }

    private static PendingIntent alarmPendingIntent(Context context, String id, JSONObject alert, int mode) {
        Intent intent = new Intent(context, TaskAlarmReceiver.class)
            .setAction("com.stupiaks.ops.TASK_ALARM." + id)
            .putExtra(EXTRA_ALERT_ID, id)
            .putExtra(EXTRA_TITLE, alert.optString("title", "Stupiak's Ops"))
            .putExtra(EXTRA_MESSAGE, alert.optString("message", "Task / SOP reminder"))
            .putExtra(EXTRA_TARGET_PAGE, alert.optString("targetPage", "/tasks"))
            .putExtra(EXTRA_KIND, alert.optString("kind", "task"))
            .putExtra(EXTRA_TRIGGER_AT, alert.optLong("triggerAt", 0L));

        return PendingIntent.getBroadcast(
            context,
            requestCode(id),
            intent,
            mode | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static PendingIntent openPendingIntent(Context context, String id, JSONObject alert) {
        Intent intent = new Intent(context, MainActivity.class)
            .putExtra(EXTRA_TARGET_PAGE, alert.optString("targetPage", "/tasks"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(
            context,
            requestCode(id) ^ 0x5A5A5A5A,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    public static int requestCode(String id) {
        return id == null ? 1 : (id.hashCode() & 0x7fffffff);
    }
}
