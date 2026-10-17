package org.jrplex.tv;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class ReceiverProtocolTest {
    private static final String SERVER = "https://jrplex.example";
    private static final String ID = "a".repeat(43);
    private JSONObject play(boolean seek) throws Exception {
        return new JSONObject().put("position", 24.5).put("media", new JSONObject()
                .put("id", ID).put("url", SERVER + "/cast/media/" + ID + "/jellyfin/Videos/movie/master.m3u8")
                .put("contentType", "application/vnd.apple.mpegurl").put("canSeek", seek).put("expiresAt", 10000).put("title", "Fixture"));
    }
    @Test public void requiresHttpsOriginWithoutCredentialsPathsOrQueries() {
        assertEquals(SERVER, ReceiverProtocol.origin(" HTTPS://JRPLEX.EXAMPLE/ "));
        for (String url : new String[]{"http://example.com", "https://a:b@example.com", "https://example.com/app", "https://example.com?x", "https://example.com#x", "file:///tmp/x", "https://example.com:0", "https://example.com:65536"})
            assertThrows(url, IllegalArgumentException.class, () -> ReceiverProtocol.origin(url));
    }
    @Test public void acceptsSameServerScopedHlsAndPreservesSeekablePosition() throws Exception {
        ReceiverProtocol.Media media = ReceiverProtocol.media(SERVER, play(true), 1000);
        assertEquals(24500, media.position); assertEquals(ID, media.id); assertTrue(media.canSeek);
        assertEquals(0, ReceiverProtocol.media(SERVER, play(false), 1000).position);
    }
    @Test public void rejectsExternalExpiredOrUnscopedSources() throws Exception {
        JSONObject input = play(true); JSONObject media = input.getJSONObject("media");
        for (String url : new String[]{"https://evil.example/cast/media/" + ID + "/torrent", SERVER + ".evil.example/cast/media/" + ID + "/torrent", SERVER + "/api/private", SERVER + "/cast/media/" + "b".repeat(43) + "/torrent", SERVER + "/cast/media/" + ID + "/torrent#secret"}) {
            media.put("url", url); assertThrows(IllegalArgumentException.class, () -> ReceiverProtocol.media(SERVER, input, 1000));
        }
        assertThrows(IllegalArgumentException.class, () -> ReceiverProtocol.media(SERVER, play(true), 10001));
        media = play(true).getJSONObject("media"); media.put("contentType", "text/html");
        JSONObject bad = new JSONObject().put("media", media);
        assertThrows(IllegalArgumentException.class, () -> ReceiverProtocol.media(SERVER, bad, 1000));
    }
    @Test public void stateBoundsHandleUnknownLiveDurationAndRejectInvalidSeek() {
        assertEquals(0, ReceiverProtocol.reportSeconds(Long.MIN_VALUE), 0);
        assertEquals(604800, ReceiverProtocol.reportSeconds(Long.MAX_VALUE), 0);
        assertEquals(12.5, ReceiverProtocol.reportSeconds(12500), 0);
        for (double value : new double[]{-1, Double.NaN, Double.POSITIVE_INFINITY, 604801})
            assertThrows(IllegalArgumentException.class, () -> ReceiverProtocol.seconds(value));
    }
}
