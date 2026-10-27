package ru.mirea.spatialatlas;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Surface;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Screen-top compass bearing. No location/course fallback or background sensor. */
@CapacitorPlugin(name = "Heading")
public class HeadingPlugin extends Plugin implements SensorEventListener {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final float[] rotation = new float[9];
    private final float[] screenRotation = new float[9];
    private final float[] orientation = new float[3];
    private SensorManager manager;
    private Sensor sensor;
    private String activeId;
    private long lastSentNanos;
    private boolean stopped;

    @PluginMethod
    public void start(PluginCall call) {
        main.post(() -> {
            String id = call.getString("id");
            if (id == null || id.isEmpty()) { call.reject("Не указан наблюдатель компаса.", "HEADING_INVALID_ID"); return; }
            if (stopped) { call.reject("Компас доступен при открытом приложении.", "HEADING_ABORTED"); return; }
            manager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
            if (manager == null) { call.reject("На устройстве нет компаса.", "HEADING_UNAVAILABLE"); return; }
            sensor = manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
            if (sensor == null) sensor = manager.getDefaultSensor(Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR);
            if (sensor == null) { call.reject("На устройстве нет абсолютного датчика направления.", "HEADING_UNAVAILABLE"); return; }
            cleanup();
            activeId = id;
            lastSentNanos = 0;
            if (!manager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_UI, main)) {
                cleanup(); call.reject("Не удалось включить компас.", "HEADING_UNAVAILABLE"); return;
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            if (activeId != null && activeId.equals(call.getString("id"))) cleanup();
            call.resolve();
        });
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onSensorChanged(SensorEvent event) {
        if (activeId == null || stopped || event.sensor != sensor) return;
        if (event.accuracy < SensorManager.SENSOR_STATUS_ACCURACY_MEDIUM) {
            emitError("Компас неточен. Уберите телефон от металла и повторите позже.", "HEADING_UNRELIABLE", false);
            return;
        }
        long elapsedNanos = SystemClock.elapsedRealtimeNanos();
        long ageNanos = elapsedNanos - event.timestamp;
        if (ageNanos < 0 || ageNanos > 5_000_000_000L || event.timestamp - lastSentNanos < 100_000_000L) return;
        SensorManager.getRotationMatrixFromVector(rotation, event.values);
        int displayRotation = getActivity().getWindowManager().getDefaultDisplay().getRotation();
        int x = SensorManager.AXIS_X;
        int y = SensorManager.AXIS_Y;
        switch (displayRotation) {
            case Surface.ROTATION_90: x = SensorManager.AXIS_Y; y = SensorManager.AXIS_MINUS_X; break;
            case Surface.ROTATION_180: x = SensorManager.AXIS_MINUS_X; y = SensorManager.AXIS_MINUS_Y; break;
            case Surface.ROTATION_270: x = SensorManager.AXIS_MINUS_Y; y = SensorManager.AXIS_X; break;
            default: break;
        }
        if (!SensorManager.remapCoordinateSystem(rotation, x, y, screenRotation)) return;
        // A vertical screen's top edge has no stable horizontal bearing.
        if (Math.hypot(screenRotation[1], screenRotation[4]) < 0.1) {
            emitError("Немного наклоните телефон: направление верхнего края не определено.", "HEADING_UNRELIABLE", false);
            return;
        }
        SensorManager.getOrientation(screenRotation, orientation);
        double degrees = (Math.toDegrees(orientation[0]) + 360.0) % 360.0;
        if (!Double.isFinite(degrees)) return;
        JSObject value = new JSObject();
        value.put("id", activeId);
        value.put("degrees", degrees);
        value.put("timestamp", System.currentTimeMillis() - ageNanos / 1_000_000L);
        value.put("reference", "magnetic");
        value.put("accuracyStatus", event.accuracy == SensorManager.SENSOR_STATUS_ACCURACY_HIGH ? "high" : "medium");
        // Android often supplies qualitative accuracy only; never invent degrees.
        if (event.values.length >= 5 && Float.isFinite(event.values[4]) && event.values[4] >= 0) value.put("accuracyDegrees", Math.toDegrees(event.values[4]));
        lastSentNanos = event.timestamp;
        notifyListeners("heading", value);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        if (activeId != null && accuracy < SensorManager.SENSOR_STATUS_ACCURACY_MEDIUM) emitError("Компас пока неточен.", "HEADING_UNRELIABLE", false);
    }

    private void emitError(String message, String code, boolean fatal) {
        if (activeId == null) return;
        JSObject error = new JSObject(); error.put("message", message); error.put("code", code); error.put("fatal", fatal);
        JSObject value = new JSObject(); value.put("id", activeId); value.put("error", error);
        notifyListeners("heading", value);
    }

    private void cleanup() {
        if (manager != null) manager.unregisterListener(this);
        activeId = null;
        lastSentNanos = 0;
    }

    @Override protected void handleOnStart() { stopped = false; }
    @Override protected void handleOnStop() { stopped = true; emitError("Компас остановлен в фоне.", "HEADING_ABORTED", true); cleanup(); }
    @Override protected void handleOnDestroy() { stopped = true; cleanup(); }
}
