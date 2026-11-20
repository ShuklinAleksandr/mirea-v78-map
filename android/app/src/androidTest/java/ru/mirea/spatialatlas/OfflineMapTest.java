package ru.mirea.spatialatlas;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.res.AssetManager;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.InputStream;
import java.util.Scanner;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class OfflineMapTest {
    @Test
    public void installedAppContainsEveryMapFileInItsOfflinePackage() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("ru.mirea.spatialatlas", context.getPackageName());
        AssetManager assets = context.getAssets();
        try (Scanner scanner = new Scanner(assets.open("public/mobile-package.json"), "UTF-8")) {
            JSONObject descriptor = new JSONObject(scanner.useDelimiter("\\A").next());
            JSONArray campuses = descriptor.getJSONArray("campuses");
            assertEquals(1, campuses.length());
            assertEquals("v-78", campuses.getJSONObject(0).getString("id"));
            JSONArray files = descriptor.getJSONArray("files");
            assertTrue(files.length() > 0);
            for (int i = 0; i < files.length(); i++) {
                String path = files.getJSONObject(i).getString("path");
                try (InputStream input = assets.open("public/" + path)) {
                    assertTrue(path, input.read() >= 0);
                }
            }
        }
    }
}
