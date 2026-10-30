package com.dha.harness;

/**
 * Is the runtime on disk the one this shell should use?
 *
 * The payload carries a `.payload-<version>` marker in the runtime directory, and
 * `Payload.install()` extracts only when {@link App#isBundledReady()} is false. That
 * check used to accept *any* marker, which meant "some runtime exists" — so a shell
 * that ships a newer payload never replaced it:
 *
 *   * an app update kept the old runtime forever (new `pnpm`, new apt packages and
 *     the whole terminal line would never arrive — installing the full APK changed
 *     nothing on a device that already had a runtime);
 *   * a stale file the user had installed by hand (e.g. a `pnpm` symlink) survived
 *     every update, which is how "预装 pnpm" silently failed.
 *
 * A full shell therefore accepts only its own payload's marker. A slim shell carries
 * no payload at all, so whatever runtime is present (downloaded as `t<terminal>` or
 * imported by the user) is the right one — that leniency stays.
 *
 * Pure on purpose: no Android types, so the decision table is testable on a JVM
 * (see {@code HotVersion} for the same pattern).
 */
final class PayloadMarker {
    private PayloadMarker() {}

    /** Marker name a runtime must carry to count as current for this shell. */
    static String expected(boolean bundledPayload, String payloadVersion, String terminalVersion) {
        if (bundledPayload) {
            return payloadVersion == null || payloadVersion.isEmpty() ? null : ".payload-" + payloadVersion;
        }
        return ".payload-t" + terminalVersion;
    }

    /**
     * @param markerNames      entries of the runtime directory, or null when absent
     * @param bundledPayload   whether this APK carries a payload asset at all
     * @param payloadVersion   {@code BuildInfo.PAYLOAD_VERSION}
     * @param terminalVersion  {@code BuildInfo.ROOTFS_VERSION}
     */
    static boolean isReady(String[] markerNames, boolean bundledPayload, String payloadVersion, String terminalVersion) {
        if (markerNames == null) return false;
        String want = expected(bundledPayload, payloadVersion, terminalVersion);
        if (bundledPayload) {
            if (want == null) return false;
            for (String name : markerNames) {
                if (want.equals(name)) return true;
            }
            return false;
        }
        // Slim shell: any payload marker means "a runtime is installed".
        for (String name : markerNames) {
            if (name != null && name.startsWith(".payload-")) return true;
        }
        return false;
    }
}
