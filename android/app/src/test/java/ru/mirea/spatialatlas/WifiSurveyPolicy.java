package ru.mirea.spatialatlas;

import java.util.ArrayDeque;

/** Monotonic time only: changing the device's clock cannot bypass a scan limit. */
final class WifiSurveyPolicy {
    static final long WINDOW_MS = 120_000;
    static final int MAX_SCANS = 4;
    static final long MAX_RESULT_AGE_MS = 15_000;
    static final long SCAN_START_TOLERANCE_MS = 2_000;
    private final ArrayDeque<Long> attempts = new ArrayDeque<>();
    private long retryAfterMs;

    long nextScanInMs(long elapsedMs) {
        while (!attempts.isEmpty() && elapsedMs - attempts.peekFirst() >= WINDOW_MS) {
            attempts.removeFirst();
        }
        long rateDelay = attempts.size() < MAX_SCANS ? 0 : Math.max(0, attempts.peekFirst() + WINDOW_MS - elapsedMs);
        return Math.max(rateDelay, Math.max(0, retryAfterMs - elapsedMs));
    }

    boolean recordAttempt(long elapsedMs) {
        if (nextScanInMs(elapsedMs) > 0) return false;
        attempts.addLast(elapsedMs);
        return true;
    }

    void systemRejectedScan(long elapsedMs) {
        // Android does not expose its remaining throttle budget. Back off
        // conservatively rather than repeatedly requesting rejected scans.
        retryAfterMs = elapsedMs + 30_000;
    }

    static long resultAgeMs(long timestampMicros, long elapsedMs, long scanStartedMs) {
        if (timestampMicros <= 0) return -1;
        long measuredMs = timestampMicros / 1_000;
        long ageMs = elapsedMs - measuredMs;
        if (ageMs < 0 || ageMs > MAX_RESULT_AGE_MS || measuredMs < scanStartedMs - SCAN_START_TOLERANCE_MS) return -1;
        return ageMs;
    }
}
