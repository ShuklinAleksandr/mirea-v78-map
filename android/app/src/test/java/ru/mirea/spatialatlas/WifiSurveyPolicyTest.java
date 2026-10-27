package ru.mirea.spatialatlas;

import static org.junit.Assert.*;
import org.junit.Test;

public class WifiSurveyPolicyTest {
    @Test public void aFifthRequestMustWaitForTheOldestAttemptToExpire() {
        WifiSurveyPolicy policy = new WifiSurveyPolicy();
        assertTrue(policy.recordAttempt(100));
        assertTrue(policy.recordAttempt(200));
        assertTrue(policy.recordAttempt(300));
        assertTrue(policy.recordAttempt(400));
        assertEquals(119_600, policy.nextScanInMs(500));
        assertFalse(policy.recordAttempt(500));
        assertEquals(1, policy.nextScanInMs(120_099));
        assertTrue(policy.recordAttempt(120_100));
        assertEquals(100, policy.nextScanInMs(120_100));
    }

    @Test public void anOldCacheIsNotFreshEvenWhenItsAgeIsOtherwiseSmall() {
        assertEquals(-1, WifiSurveyPolicy.resultAgeMs(90_000_000L, 101_000, 100_000));
        assertEquals(-1, WifiSurveyPolicy.resultAgeMs(0, 101_000, 100_000));
        assertEquals(-1, WifiSurveyPolicy.resultAgeMs(102_000_000L, 101_000, 100_000));
        assertEquals(-1, WifiSurveyPolicy.resultAgeMs(98_000_000L, 113_001, 100_000));
    }

    @Test public void aSystemRejectionRequiresAnExplicitDelayedRetry() {
        WifiSurveyPolicy policy = new WifiSurveyPolicy();
        assertTrue(policy.recordAttempt(1_000));
        policy.systemRejectedScan(1_010);
        assertEquals(30_000, policy.nextScanInMs(1_010));
        assertFalse(policy.recordAttempt(31_009));
        assertTrue(policy.recordAttempt(31_010));
        assertEquals(0, policy.nextScanInMs(31_010));
    }

    @Test public void freshBroadcastResultsRetainTheirMeasuredAge() {
        assertEquals(1500, WifiSurveyPolicy.resultAgeMs(100_500_000L, 102_000, 100_000));
        assertEquals(15_000, WifiSurveyPolicy.resultAgeMs(98_000_000L, 113_000, 100_000));
        assertEquals(0, WifiSurveyPolicy.resultAgeMs(100_000_000L, 100_000, 100_000));
    }
}
