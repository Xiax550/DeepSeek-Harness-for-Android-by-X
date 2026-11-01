package com.dha.harness;

/** Recover only the upstream bootstrap failure, never an ordinary chat error. */
final class WebBootPolicy {
    static final String PROBE = "(function(){var boot=document.querySelector('[data-dsh-boot]');"
            + "if(!boot)return 'ready';return (boot.textContent||'').indexOf('Failed to load plugins')>=0"
            + "?'failed':'loading'})()";

    static boolean canRetry(int attempts) {
        return attempts >= 0 && attempts < 2;
    }

    private WebBootPolicy() {}
}
