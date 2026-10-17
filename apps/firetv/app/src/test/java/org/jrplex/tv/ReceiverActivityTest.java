package org.jrplex.tv;

import android.os.Looper;
import android.view.KeyEvent;
import android.widget.FrameLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.android.controller.ActivityController;
import java.time.Duration;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BooleanSupplier;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class ReceiverActivityTest {
    static final String SECRET = "s".repeat(43), MEDIA = "m".repeat(43);
    static class FakeApi implements ReceiverApi {
        final CopyOnWriteArrayList<String> requests = new CopyOnWriteArrayList<>();
        final CopyOnWriteArrayList<JSONObject> reports = new CopyOnWriteArrayList<>();
        JSONArray commands = new JSONArray(); volatile boolean paired = false; volatile boolean failStart; volatile int startCount;
        volatile long expiresAt = System.currentTimeMillis() + 300000;
        @Override public synchronized JSONObject post(String path, JSONObject input) throws Exception {
            requests.add(path);
            if (path.endsWith("/start")) {
                startCount++; if (failStart) { failStart = false; throw new Failure(503, "fixture"); }
                return new JSONObject().put("secret", SECRET).put("code", "123456").put("expiresAt", expiresAt);
            }
            if (path.endsWith("/poll")) { reports.add(input); JSONArray next = commands; commands = new JSONArray(); return new JSONObject().put("paired", paired).put("commands", next); }
            return new JSONObject().put("ok", true);
        }
        synchronized void command(JSONObject command) { commands.put(command); }
    }
    static class FakePlayer implements Playback {
        int loads, releases; long position; boolean paused = true; boolean seekable;
        @Override public void load(ReceiverProtocol.Media media) { loads++; position = media.position; paused = false; seekable = media.canSeek; }
        @Override public void pause() { paused = true; }
        @Override public void resume() { paused = false; }
        @Override public void seek(long value) { position = value; }
        @Override public void clear() { paused = true; }
        @Override public void release() { releases++; }
        @Override public long position() { return position; }
        @Override public long duration() { return 100000; }
        @Override public boolean paused() { return paused; }
        @Override public String status() { return paused ? "paused" : "playing"; }
        @Override public void focus() { }
    }
    public static class TestActivity extends ReceiverActivity {
        final FakeApi fixture = new FakeApi(); final FakePlayer player = new FakePlayer();
        long clock = System.currentTimeMillis();
        @Override protected long now() { return clock; }
        @Override protected ReceiverApi createApi(String origin) { return fixture; }
        @Override protected Playback createPlayback(FrameLayout view) { return player; }
    }
    private void until(BooleanSupplier condition) throws Exception {
        for (int i = 0; i < 200; i++) { shadowOf(Looper.getMainLooper()).idle(); if (condition.getAsBoolean()) return; Thread.sleep(10); }
        fail("Async condition did not complete");
    }
    private void tick() { shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1)); }
    private JSONObject play(boolean seek) throws Exception {
        return new JSONObject().put("sequence", 1).put("command", "play").put("position", 12).put("media", new JSONObject()
                .put("id", MEDIA).put("url", ReceiverProtocol.DEFAULT_SERVER + "/cast/media/" + MEDIA + "/torrent")
                .put("contentType", "video/mp4").put("canSeek", seek).put("expiresAt", System.currentTimeMillis() + 300000));
    }
    @Test public void generatesCodeWithoutLoginAndRemoteButtonHasInitialFocus() throws Exception {
        try (ActivityController<TestActivity> activity = Robolectric.buildActivity(TestActivity.class).setup().visible()) {
            TestActivity view = activity.get(); until(() -> ((TextView) view.findViewById(ReceiverActivity.CODE_ID)).getText().toString().equals("123456"));
            assertTrue(view.findViewById(ReceiverActivity.RENEW_ID).hasFocus());
            until(() -> !view.fixture.reports.isEmpty());
            assertTrue(view.fixture.reports.get(0).getJSONObject("state").isNull("mediaId"));
            activity.pause().stop(); until(() -> view.fixture.requests.contains("/cast/receiver/end"));
        }
    }
    @Test public void commandsAreAcknowledgedOnceAndPhysicalRemoteControlsPlayback() throws Exception {
        try (ActivityController<TestActivity> activity = Robolectric.buildActivity(TestActivity.class).setup()) {
            TestActivity view = activity.get(); until(() -> !view.fixture.reports.isEmpty()); view.fixture.paired = true;
            view.fixture.command(play(true)); tick(); until(() -> view.player.loads == 1);
            assertEquals(12000, view.player.position);
            view.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)); assertTrue(view.player.paused);
            view.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY)); assertFalse(view.player.paused);
            view.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD)); assertEquals(22000, view.player.position);
            view.fixture.command(play(true)); tick(); until(() -> view.fixture.reports.size() >= 3); assertEquals(1, view.player.loads);
            assertEquals(1, view.fixture.reports.get(view.fixture.reports.size() - 1).getLong("ack"));
            activity.pause().stop(); until(() -> view.fixture.requests.contains("/cast/receiver/end"));
            assertTrue(view.player.paused);
        }
    }
    @Test public void convertedTorrentCannotSeekAndForegroundReturnCreatesNewPairing() throws Exception {
        try (ActivityController<TestActivity> activity = Robolectric.buildActivity(TestActivity.class).setup()) {
            TestActivity view = activity.get(); until(() -> !view.fixture.reports.isEmpty()); view.fixture.paired = true;
            view.fixture.command(play(false)); tick(); until(() -> view.player.loads == 1);
            view.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD)); assertEquals(0, view.player.position);
            activity.pause().stop().restart().resume(); until(() -> view.fixture.startCount >= 2);
            assertEquals(view.fixture.requests.toString(), 2, view.fixture.startCount);
            assertTrue(view.fixture.requests.contains("/cast/receiver/end"));
        }
    }
    @Test public void expiredUnpairedCodeRenewsAutomatically() throws Exception {
        try (ActivityController<TestActivity> activity = Robolectric.buildActivity(TestActivity.class).setup()) {
            TestActivity view = activity.get(); until(() -> !view.fixture.reports.isEmpty());
            view.fixture.expiresAt += 300001; view.clock += 300001; tick(); until(() -> view.fixture.startCount >= 2);
            assertEquals(view.fixture.requests.toString(), 2, view.fixture.startCount);
            assertTrue(view.fixture.requests.contains("/cast/receiver/end"));
        }
    }
    @Test public void transientStartFailureShowsErrorAndRetries() throws Exception {
        try (ActivityController<TestActivity> activity = Robolectric.buildActivity(TestActivity.class).create()) {
            TestActivity view = activity.get(); view.fixture.failStart = true; activity.start().resume();
            until(() -> ((TextView) view.findViewById(ReceiverActivity.STATUS_ID)).getText().toString().contains("Reintentando"));
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
            until(() -> ((TextView) view.findViewById(ReceiverActivity.CODE_ID)).getText().toString().equals("123456")); assertEquals(2, view.fixture.startCount);
        }
    }
}
