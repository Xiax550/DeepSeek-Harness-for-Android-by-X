package com.dha.harness;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Bring DHA back after a reboot or an app update.
 *
 * Both services are already foreground/sticky once running; this is the cold
 * entry point they had no way to reach without opening MainActivity by hand.
 */
public final class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                && !Intent.ACTION_USER_UNLOCKED.equals(action)
                && !Intent.ACTION_USER_PRESENT.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            return;
        }
        Context app = context.getApplicationContext();
        if (!Payload.isReady()) {
            App.log("boot receiver: payload is not ready yet");
            return;
        }
        App.log("boot receiver: " + action);
        // Apply the bundled hot overlay before either WebView exists. Otherwise
        // an update can start the Java services first and keep rendering the
        // previous composer until the user opens the app again.
        Payload.applyHot(app);
        DshService.ensure(app);
        BallService.restore(app);
    }
}
