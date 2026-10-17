package org.jrplex.tv;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

/** Real Media3 view/session construction, not a hardware decode test. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {23, 28})
public class NativePlaybackTest {
    public static class NativeActivity extends ReceiverActivity {
        @Override protected ReceiverApi createApi(String origin) {
            return (path, input) -> new JSONObject().put("secret", "s".repeat(43)).put("code", "123456")
                    .put("expiresAt", System.currentTimeMillis() + 300000).put("paired", false).put("commands", new org.json.JSONArray());
        }
    }
    @Test public void constructsAndReleasesNativePlayerOnSupportedAndroidVersions() {
        try (var controller = Robolectric.buildActivity(NativeActivity.class).setup()) {
            assertNotNull(controller.get().findViewById(ReceiverActivity.CODE_ID));
            controller.pause().stop();
        }
    }
}
