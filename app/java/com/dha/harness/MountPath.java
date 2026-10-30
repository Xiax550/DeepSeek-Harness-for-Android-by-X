package com.dha.harness;

/** Safe, user-visible guest paths for bind mounts. */
final class MountPath {
    private static final String[] RESERVED = {
            "/", "/dev", "/proc", "/sys", "/root", "/sdcard", "/mnt"
    };

    private MountPath() {
    }

    static String defaultGuestPath(String host) {
        String name = host == null ? "" : new java.io.File(host).getName();
        if (name.isEmpty()) name = "mount";
        StringBuilder safe = new StringBuilder();
        for (char c : name.toCharArray()) {
            safe.append(Character.isLetterOrDigit(c) || c == '.' || c == '_' || c == '-'
                    ? c : '_');
        }
        return "/mnt/" + safe;
    }

    static String normalizeGuest(String guest) {
        String value = guest == null ? "" : guest.trim().replace('\\', '/');
        while (value.contains("//")) value = value.replace("//", "/");
        if (value.endsWith("/") && value.length() > 1) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    static boolean safeGuest(String guest) {
        String value = normalizeGuest(guest);
        if (!value.startsWith("/") || value.contains("/../") || value.endsWith("/..")) {
            return false;
        }
        for (String reserved : RESERVED) {
            if (reserved.equals(value)) return false;
        }
        return value.length() > 1;
    }
}
