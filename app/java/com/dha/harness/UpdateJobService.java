package com.dha.harness;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.os.Handler;
import android.os.Looper;

public final class UpdateJobService extends JobService {
    @Override public boolean onStartJob(JobParameters params) {
        Updates.automatic("night", () -> new Handler(Looper.getMainLooper()).post(() -> {
            jobFinished(params, false);
            Updates.schedule(true);
        }));
        return true;
    }

    @Override public boolean onStopJob(JobParameters params) {
        return true;
    }
}
