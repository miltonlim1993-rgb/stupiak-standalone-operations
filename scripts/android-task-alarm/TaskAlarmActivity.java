package com.stupiaks.ops;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class TaskAlarmActivity extends Activity {
    private String alertId = "";
    private String targetPage = "/tasks";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        wakeScreen();

        Intent intent = getIntent();
        alertId = value(intent, TaskAlarmScheduler.EXTRA_ALERT_ID, "");
        targetPage = value(intent, TaskAlarmScheduler.EXTRA_TARGET_PAGE, "/tasks");
        String title = value(intent, TaskAlarmScheduler.EXTRA_TITLE, "Task / SOP Reminder");
        String message = value(intent, TaskAlarmScheduler.EXTRA_MESSAGE, "Please open Stupiak's Ops and handle this reminder.");

        setContentView(buildContent(title, message));
    }

    @Override
    public void onBackPressed() {
        // The alarm continues until the user deliberately acknowledges it.
    }

    private void wakeScreen() {
        getWindow().addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
        );
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            KeyguardManager manager = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            if (manager != null) manager.requestDismissKeyguard(this, null);
        }
    }

    private LinearLayout buildContent(String title, String message) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(dp(24), dp(36), dp(24), dp(36));
        root.setBackgroundColor(Color.rgb(10, 10, 10));

        TextView eyebrow = new TextView(this);
        eyebrow.setText("STUPIAK'S OPS ALARM");
        eyebrow.setTextColor(Color.rgb(242, 170, 0));
        eyebrow.setTextSize(13f);
        eyebrow.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        eyebrow.setGravity(Gravity.CENTER);
        root.addView(eyebrow, matchWrap(dp(12)));

        TextView heading = new TextView(this);
        heading.setText(title);
        heading.setTextColor(Color.WHITE);
        heading.setTextSize(28f);
        heading.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        heading.setGravity(Gravity.CENTER);
        heading.setPadding(0, dp(12), 0, dp(12));
        root.addView(heading, matchWrap(dp(12)));

        TextView body = new TextView(this);
        body.setText(message);
        body.setTextColor(Color.rgb(225, 225, 225));
        body.setTextSize(16f);
        body.setGravity(Gravity.CENTER);
        body.setLineSpacing(0f, 1.2f);
        root.addView(body, matchWrap(dp(28)));

        TextView warning = new TextView(this);
        warning.setText("响铃会持续到你按下处理按钮。");
        warning.setTextColor(Color.BLACK);
        warning.setTextSize(14f);
        warning.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        warning.setGravity(Gravity.CENTER);
        warning.setPadding(dp(16), dp(14), dp(16), dp(14));
        warning.setBackgroundColor(Color.rgb(242, 170, 0));
        LinearLayout.LayoutParams warningParams = matchWrap(dp(22));
        warningParams.width = ViewGroup.LayoutParams.MATCH_PARENT;
        root.addView(warning, warningParams);

        Button openButton = new Button(this);
        openButton.setText("打开任务 / SOP");
        openButton.setTextSize(16f);
        openButton.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        openButton.setTextColor(Color.BLACK);
        openButton.setBackgroundColor(Color.WHITE);
        openButton.setOnClickListener((view) -> acknowledge(true));
        LinearLayout.LayoutParams openParams = matchWrap(dp(12));
        openParams.width = ViewGroup.LayoutParams.MATCH_PARENT;
        openParams.height = dp(58);
        root.addView(openButton, openParams);

        Button stopButton = new Button(this);
        stopButton.setText("已处理，停止声音");
        stopButton.setTextSize(16f);
        stopButton.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        stopButton.setTextColor(Color.BLACK);
        stopButton.setBackgroundColor(Color.rgb(242, 170, 0));
        stopButton.setOnClickListener((view) -> acknowledge(false));
        LinearLayout.LayoutParams stopParams = matchWrap(0);
        stopParams.width = ViewGroup.LayoutParams.MATCH_PARENT;
        stopParams.height = dp(58);
        root.addView(stopButton, stopParams);

        return root;
    }

    private void acknowledge(boolean openApp) {
        Intent stop = new Intent(this, TaskAlarmService.class)
            .setAction(TaskAlarmService.ACTION_STOP)
            .putExtra(TaskAlarmScheduler.EXTRA_ALERT_ID, alertId);
        startService(stop);

        if (openApp) {
            Intent app = new Intent(this, MainActivity.class)
                .putExtra(TaskAlarmScheduler.EXTRA_TARGET_PAGE, targetPage)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(app);
        }
        finishAndRemoveTask();
    }

    private LinearLayout.LayoutParams matchWrap(int bottomMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.bottomMargin = bottomMargin;
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private String value(Intent intent, String key, String fallback) {
        if (intent == null) return fallback;
        String value = intent.getStringExtra(key);
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }
}
