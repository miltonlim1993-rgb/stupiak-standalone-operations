package com.stupiaks.ops;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public class TaskAlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Intent service = new Intent(context, TaskAlarmService.class)
            .setAction(TaskAlarmService.ACTION_START);

        if (intent != null && intent.getExtras() != null) {
            service.putExtras(intent.getExtras());
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(service);
        } else {
            context.startService(service);
        }
    }
}
