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
            return new ReceiverApi() {
                @Override public JSONObject post(String path, JSONObject input) throws Exception {
                    return new JSONObject().put("secret", "s".repeat(43)).put("code", "123456")
                            .put("expiresAt", System.currentTimeMillis() + 300000).put("paired", false).put("commands", new org.json.JSONArray());
                }
                @Override public byte[] image(String path) { return new byte[0]; }
            };
        }
    }
    @Test public void constructsAndReleasesNativePlayerOnSupportedAndroidVersions() {
        try (var controller = Robolectric.buildActivity(NativeActivity.class).setup()) {
            assertNotNull(controller.get().findViewById(ReceiverActivity.CODE_ID));
            controller.pause().stop();
        }
    }
    public static class NativeBrowse extends BrowseActivity {
        final BrowseActivityTest.Api fixture = new BrowseActivityTest.Api();
        @Override protected TvApi createApi(String origin, String token) { return fixture; }
        @Override protected AccountStore createStore() { return new BrowseActivityTest.MemoryStore(); }
    }
    @Test public void standaloneLauncherConstructsAndReleasesNativePlayerOnMinimumSdk() {
        try (var controller = Robolectric.buildActivity(NativeBrowse.class).setup()) {
            assertNotNull(controller.get().findViewById(BrowseActivity.STATUS));
            controller.pause().stop();
        }
    }
}
