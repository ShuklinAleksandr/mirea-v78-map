package ru.mirea.spatialatlas;

import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Local GPS/manual-point export. No location, storage or network permission. */
@CapacitorPlugin(name = "GpsCalibrationExport")
public class GpsCalibrationExportPlugin extends Plugin {
    private static final int MAX_EXPORT_BYTES = 4 * 1024 * 1024;

    @PluginMethod
    public void exportSurvey(PluginCall call) {
        String json = call.getString("json");
        if (json == null || json.length() == 0 || json.length() > MAX_EXPORT_BYTES) {
            call.reject("Файл GPS-замеров пустой или слишком большой (не больше 4 МБ).", "EXPORT_INVALID");
            return;
        }
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_EXPORT_BYTES) {
            call.reject("Файл GPS-замеров слишком большой (не больше 4 МБ).", "EXPORT_TOO_LARGE");
            return;
        }
        File file = null;
        try {
            JSONTokener tokener = new JSONTokener(json);
            Object root = tokener.nextValue();
            if (!(root instanceof JSONObject) || tokener.nextClean() != 0 ||
                !"v-78".equals(((JSONObject) root).opt("campusId"))) {
                call.reject("Это не файл GPS-замеров Вернадского, 78.", "EXPORT_INVALID");
                return;
            }
            File directory = new File(getContext().getCacheDir(), "gps-calibration");
            if (!directory.isDirectory() && !directory.mkdirs()) {
                throw new IOException("Cannot create GPS export cache");
            }
            SimpleDateFormat format = new SimpleDateFormat("yyyyMMdd-HHmmss-SSS", Locale.ROOT);
            format.setTimeZone(TimeZone.getTimeZone("UTC"));
            file = File.createTempFile("MIREA-V78-GPS-" + format.format(new Date()) + "-", ".json", directory);
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(bytes);
            }
            JSObject value = new JSObject();
            value.put("uri", Uri.fromFile(file).toString());
            value.put("filename", file.getName());
            call.resolve(value);
        } catch (JSONException error) {
            call.reject("Файл GPS-замеров содержит некорректный JSON.", "EXPORT_INVALID");
        } catch (IOException | SecurityException error) {
            if (file != null) file.delete();
            call.reject("Не удалось создать файл GPS-замеров. Проверьте свободное место.", "EXPORT_FAILED");
        }
    }
}
