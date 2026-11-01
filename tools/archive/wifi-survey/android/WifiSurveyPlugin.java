package ru.mirea.spatialatlas;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import org.json.JSONException;
import org.json.JSONObject;

/** Explicit, foreground-only survey observations. No automatic positioning. */
@CapacitorPlugin(
    name = "WifiSurvey",
    permissions = {
        @Permission(alias = "surveyLocation", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION })
    }
)
public class WifiSurveyPlugin extends Plugin {
    private static final long TIMEOUT_MS = 15_000;
    private static final int MAX_EXPORT_BYTES = 8 * 1024 * 1024;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final WifiSurveyPolicy policy = new WifiSurveyPolicy();
    private PluginCall pending;
    private BroadcastReceiver receiver;
    private Runnable timeout;
    private long scanStartedMs;
    private boolean permissionPending;
    private boolean stopped;

    private WifiManager wifi() {
        return (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
    }

    private boolean supported() {
        return getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_WIFI) && wifi() != null;
    }

    private boolean preciseLocationGranted() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean locationEnabled() {
        LocationManager manager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return manager.isLocationEnabled();
        return manager.isProviderEnabled(LocationManager.GPS_PROVIDER) || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    private JSObject device() {
        JSObject value = new JSObject();
        value.put("manufacturer", Build.MANUFACTURER);
        value.put("model", Build.MODEL);
        value.put("androidVersion", Build.VERSION.RELEASE);
        value.put("api", Build.VERSION.SDK_INT);
        return value;
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        main.post(() -> {
            try {
                boolean available = supported();
                JSObject value = new JSObject();
                value.put("supported", available);
                value.put("wifiEnabled", available && wifi().isWifiEnabled());
                value.put("locationEnabled", locationEnabled());
                value.put("preciseLocationGranted", preciseLocationGranted());
                value.put("nextScanInMs", policy.nextScanInMs(SystemClock.elapsedRealtime()));
                value.put("device", device());
                call.resolve(value);
            } catch (SecurityException error) {
                call.reject("Android не разрешил проверить состояние Wi-Fi.", "PERMISSION_DENIED");
            }
        });
    }

    @PluginMethod
    public void scan(PluginCall call) {
        main.post(() -> {
            if (pending != null) {
                call.reject("Дождитесь завершения текущего замера.", "BUSY");
                return;
            }
            if (stopped) {
                call.reject("Откройте приложение, чтобы записать замер.", "CANCELLED");
                return;
            }
            if (!supported()) {
                call.reject("На этом устройстве сканирование Wi-Fi недоступно.", "UNSUPPORTED");
                return;
            }
            pending = call;
            if (!preciseLocationGranted()) {
                permissionPending = true;
                requestPermissionForAlias("surveyLocation", call, "surveyPermissionResult");
            } else beginScan(call);
        });
    }

    @PermissionCallback
    private void surveyPermissionResult(PluginCall call) {
        main.post(() -> {
            if (call == null || pending != call) return;
            permissionPending = false;
            if (stopped) {
                rejectPending("Замер отменён: приложение свёрнуто.", "CANCELLED");
            } else if (!preciseLocationGranted()) {
                rejectPending("Для замеров Wi-Fi разрешите точное местоположение. Примерного доступа недостаточно.", "PRECISE_LOCATION_REQUIRED");
            } else beginScan(call);
        });
    }

    @SuppressWarnings("deprecation")
    private void beginScan(PluginCall call) {
        if (call == null || pending != call) return;
        try {
            WifiManager manager = wifi();
            if (manager == null || !manager.isWifiEnabled()) {
                rejectPending("Включите Wi-Fi в настройках телефона и повторите замер.", "WIFI_DISABLED");
                return;
            }
            if (!locationEnabled()) {
                rejectPending("Включите определение местоположения в настройках телефона.", "LOCATION_DISABLED");
                return;
            }
            long elapsedMs = SystemClock.elapsedRealtime();
            long next = policy.nextScanInMs(elapsedMs);
            if (next > 0) {
                JSObject data = new JSObject();
                data.put("nextScanInMs", next);
                rejectPending("Android ограничивает частоту замеров. Повторите через " + ((next + 999) / 1000) + " с.", "SCAN_THROTTLED", data);
                return;
            }
            scanStartedMs = elapsedMs;
            receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    if (pending != call || !WifiManager.SCAN_RESULTS_AVAILABLE_ACTION.equals(intent.getAction())) return;
                    if (!intent.getBooleanExtra(WifiManager.EXTRA_RESULTS_UPDATED, false)) {
                        rejectPending("Android не обновил Wi-Fi-замер. Старые данные не записаны; повторите позже.", "SCAN_FAILED");
                        return;
                    }
                    readFreshResults(call);
                }
            };
            // This protected system broadcast may originate in a privileged Wi-Fi process.
            // Only fresh timestamps from WifiManager are accepted, never intent-supplied results.
            ContextCompat.registerReceiver(getContext(), receiver, new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION), ContextCompat.RECEIVER_EXPORTED);
            timeout = () -> rejectPending("Wi-Fi не ответил за 15 секунд. Замер не сохранён; повторите позже.", "SCAN_TIMEOUT");
            main.postDelayed(timeout, TIMEOUT_MS);
            policy.recordAttempt(elapsedMs);
            if (!manager.startScan()) {
                policy.systemRejectedScan(SystemClock.elapsedRealtime());
                JSObject data = new JSObject();
                data.put("nextScanInMs", policy.nextScanInMs(SystemClock.elapsedRealtime()));
                rejectPending("Android не запустил сканирование. Возможны ограничение частоты или недоступность Wi-Fi. Повторите через 30 с.", "SCAN_THROTTLED", data);
            }
        } catch (SecurityException error) {
            rejectPending("Android не разрешил сканирование. Проверьте доступ к точному местоположению.", "PRECISE_LOCATION_REQUIRED");
        } catch (RuntimeException error) {
            rejectPending("Не удалось запустить Wi-Fi-замер. Повторите попытку.", "SCAN_FAILED");
        }
    }

    @SuppressWarnings("deprecation")
    private void readFreshResults(PluginCall call) {
        if (call == null || pending != call) return;
        try {
            if (stopped || !preciseLocationGranted() || !locationEnabled() || !wifi().isWifiEnabled()) {
                rejectPending("Замер прерван: проверьте Wi-Fi, местоположение и разрешения.", "SCAN_FAILED");
                return;
            }
            long elapsedMs = SystemClock.elapsedRealtime();
            List<ScanResult> results = wifi().getScanResults();
            JSArray networks = new JSArray();
            long oldestAgeMs = 0;
            if (results != null) for (ScanResult result : results) {
                long ageMs = WifiSurveyPolicy.resultAgeMs(result.timestamp, elapsedMs, scanStartedMs);
                if (ageMs < 0 || result.BSSID == null || !result.BSSID.matches("(?i)([0-9a-f]{2}:){5}[0-9a-f]{2}") || result.BSSID.equalsIgnoreCase("00:00:00:00:00:00") || result.BSSID.equalsIgnoreCase("02:00:00:00:00:00") || result.BSSID.equalsIgnoreCase("ff:ff:ff:ff:ff:ff") || result.level < -127 || result.level > 0 || result.frequency <= 0) continue;
                JSObject network = new JSObject();
                network.put("ssid", result.SSID == null ? "" : result.SSID);
                network.put("bssid", result.BSSID.toLowerCase(Locale.ROOT));
                network.put("rssi", result.level);
                network.put("frequency", result.frequency);
                network.put("ageMs", ageMs);
                network.put("is80211mcResponder", result.is80211mcResponder());
                networks.put(network);
                oldestAgeMs = Math.max(oldestAgeMs, ageMs);
            }
            if (networks.length() == 0) {
                rejectPending("Свежих точек доступа не найдено. Пустой или устаревший замер не записан.", "SCAN_EMPTY");
                return;
            }
            JSObject value = new JSObject();
            value.put("capturedAt", System.currentTimeMillis());
            value.put("ageMs", oldestAgeMs);
            value.put("fresh", true);
            value.put("source", "active-scan");
            value.put("networks", networks);
            value.put("device", device());
            cleanup();
            pending = null;
            call.resolve(value);
        } catch (SecurityException error) {
            rejectPending("Доступ к точному местоположению отозван. Замер не записан.", "PRECISE_LOCATION_REQUIRED");
        } catch (RuntimeException error) {
            rejectPending("Не удалось прочитать новый Wi-Fi-замер. Повторите попытку.", "SCAN_FAILED");
        }
    }

    private void cleanup() {
        if (timeout != null) main.removeCallbacks(timeout);
        timeout = null;
        if (receiver != null) {
            try { getContext().unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) { /* Already removed. */ }
        }
        receiver = null;
    }

    private void rejectPending(String message, String code) { rejectPending(message, code, null); }

    private void rejectPending(String message, String code, JSObject data) {
        PluginCall call = pending;
        pending = null;
        cleanup();
        if (call != null) call.reject(message, code, data);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        main.post(() -> {
            permissionPending = false;
            rejectPending("Замер отменён.", "CANCELLED");
            call.resolve();
        });
    }

    @Override
    protected void handleOnStart() { stopped = false; }

    @Override
    protected void handleOnStop() {
        stopped = true;
        // A runtime permission prompt may pause the activity. No receiver exists
        // until permission returns; the callback checks the resumed foreground.
        if (!permissionPending) rejectPending("Замер отменён: приложение свёрнуто.", "CANCELLED");
        else cleanup();
    }

    @Override
    protected void handleOnDestroy() {
        stopped = true;
        permissionPending = false;
        rejectPending("Замер отменён: приложение закрыто.", "CANCELLED");
    }

    @PluginMethod
    public void exportSurvey(PluginCall call) {
        String json = call.getString("json");
        if (json == null || json.length() == 0 || json.length() > MAX_EXPORT_BYTES) {
            call.reject("Файл замеров пустой или слишком большой (не больше 8 МБ).", "EXPORT_INVALID");
            return;
        }
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_EXPORT_BYTES) {
            call.reject("Файл замеров слишком большой (не больше 8 МБ).", "EXPORT_TOO_LARGE");
            return;
        }
        try {
            JSONObject document = new JSONObject(json);
            if (!"v-78".equals(document.optString("campusId"))) {
                call.reject("Это не файл замеров Вернадского, 78.", "EXPORT_INVALID");
                return;
            }
            File directory = new File(getContext().getCacheDir(), "wifi-surveys");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new java.io.IOException("Cannot create survey cache");
            SimpleDateFormat format = new SimpleDateFormat("yyyyMMdd-HHmmss-SSS", Locale.ROOT);
            format.setTimeZone(TimeZone.getTimeZone("UTC"));
            File file = File.createTempFile("MIREA-V78-WiFi-" + format.format(new Date()) + "-", ".json", directory);
            try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); }
            JSObject value = new JSObject();
            value.put("uri", Uri.fromFile(file).toString());
            value.put("filename", file.getName());
            call.resolve(value);
        } catch (JSONException error) {
            call.reject("Файл замеров содержит некорректный JSON.", "EXPORT_INVALID");
        } catch (java.io.IOException error) {
            call.reject("Не удалось создать файл замеров. Проверьте свободное место.", "EXPORT_FAILED");
        }
    }
}
