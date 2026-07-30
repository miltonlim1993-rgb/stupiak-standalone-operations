package com.stupiaks.ops;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "TaskAlarm",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class TaskAlarmPlugin extends Plugin {
    @PluginMethod
    public void getPermissionState(PluginCall call) {
        call.resolve(permissionState(false));
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
            return;
        }
        call.resolve(openRequiredSetting());
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        call.resolve(openRequiredSetting());
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        JSObject result = openRequiredSetting();
        if (!result.optBoolean("settingsOpened", false)) {
            try {
                Intent intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
                    .putExtra(Settings.EXTRA_CHANNEL_ID, TaskAlarmService.CHANNEL_ID);
                getActivity().startActivity(intent);
                result.put("settingsOpened", true);
                result.put("settingsType", "notificationChannel");
            } catch (Exception error) {
                Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(fallback);
                result.put("settingsOpened", true);
                result.put("settingsType", "application");
            }
        }
        call.resolve(result);
    }

    @PluginMethod
    public void syncAlarms(PluginCall call) {
        JSArray alerts = call.getArray("alerts");
        if (alerts == null) alerts = new JSArray();
        try {
            int scheduled = TaskAlarmScheduler.replaceSchedule(getContext(), alerts);
            JSObject result = permissionState(false);
            result.put("scheduled", scheduled);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "Unable to schedule Task / SOP alarms" : error.getMessage());
        }
    }

    @PluginMethod
    public void stopAlarm(PluginCall call) {
        Intent stop = new Intent(getContext(), TaskAlarmService.class)
            .setAction(TaskAlarmService.ACTION_STOP)
            .putExtra(TaskAlarmScheduler.EXTRA_ALERT_ID, call.getString("id", ""));
        getContext().startService(stop);
        JSObject result = new JSObject();
        result.put("stopped", true);
        call.resolve(result);
    }

    private JSObject openRequiredSetting() {
        Context context = getContext();
        AlarmManager alarmManager = context.getSystemService(AlarmManager.class);
        NotificationManager notificationManager = context.getSystemService(NotificationManager.class);
        boolean exactAlarmGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            || (alarmManager != null && alarmManager.canScheduleExactAlarms());
        boolean fullScreenIntentGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE
            || (notificationManager != null && notificationManager.canUseFullScreenIntent());
        JSObject state = permissionState(false);

        try {
            if (!exactAlarmGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
                    .setData(Uri.parse("package:" + context.getPackageName()));
                getActivity().startActivity(intent);
                state.put("settingsOpened", true);
                state.put("settingsType", "exactAlarm");
                return state;
            }

            if (!fullScreenIntentGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                Intent intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
                    .setData(Uri.parse("package:" + context.getPackageName()));
                getActivity().startActivity(intent);
                state.put("settingsOpened", true);
                state.put("settingsType", "fullScreenIntent");
                return state;
            }
        } catch (Exception ignored) {
        }

        state.put("settingsOpened", false);
        return state;
    }

    private JSObject permissionState(boolean settingsOpened) {
        Context context = getContext();
        NotificationManager notificationManager = context.getSystemService(NotificationManager.class);
        AlarmManager alarmManager = context.getSystemService(AlarmManager.class);

        boolean notificationsGranted;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationsGranted = context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            notificationsGranted = notificationManager == null || notificationManager.areNotificationsEnabled();
        } else {
            notificationsGranted = true;
        }

        boolean exactAlarmGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            || (alarmManager != null && alarmManager.canScheduleExactAlarms());
        boolean fullScreenIntentGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE
            || (notificationManager != null && notificationManager.canUseFullScreenIntent());

        JSObject state = new JSObject();
        state.put("notificationsGranted", notificationsGranted);
        state.put("exactAlarmGranted", exactAlarmGranted);
        state.put("fullScreenIntentGranted", fullScreenIntentGranted);
        state.put("settingsOpened", settingsOpened);
        state.put("enabled", notificationsGranted && exactAlarmGranted);
        return state;
    }
}
