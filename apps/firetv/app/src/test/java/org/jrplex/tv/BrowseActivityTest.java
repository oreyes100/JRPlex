package org.jrplex.tv;

import android.app.AlertDialog;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.recyclerview.widget.RecyclerView;
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
@Config(sdk=28)
public class BrowseActivityTest {
    static final String TOKEN="t".repeat(43), SECRET="s".repeat(43), MEDIA="m".repeat(43);
    static class MemoryStore implements AccountStore {
        volatile String token;
        @Override public String read(String server){return token;}
        @Override public void save(String server,String token){this.token=token;}
        @Override public void clear(){token=null;}
    }
    static class Api implements TvApi {
        volatile boolean approved;
        final CopyOnWriteArrayList<String> paths=new CopyOnWriteArrayList<>();
        final CopyOnWriteArrayList<JSONObject> progress=new CopyOnWriteArrayList<>();
        @Override public JSONObject call(String method,String path,JSONObject input)throws Exception{
            paths.add(path);
            if(path.endsWith("/link/start"))return new JSONObject().put("secret",SECRET).put("code","ABCD-EFGH").put("expiresAt",System.currentTimeMillis()+300000).put("verificationUrl",ReceiverProtocol.DEFAULT_SERVER+"/activate#code=ABCDEFGH");
            if(path.endsWith("/link/poll"))return approved?new JSONObject().put("status","approved").put("token",TOKEN):new JSONObject().put("status","pending");
            if(path.endsWith("/session"))return new JSONObject().put("user",new JSONObject().put("Name","Fixture account"));
            if(path.startsWith("/api/tv/catalog"))return new JSONObject().put("items",new JSONArray().put(new JSONObject().put("Id","movie").put("Name","Fixture movie").put("Type","Movie"))).put("total",1);
            if(path.startsWith("/api/tv/item"))return new JSONObject().put("Id","movie").put("Name","Fixture movie").put("Type","Movie").put("Position",12);
            if(path.endsWith("/play"))return new JSONObject().put("position",input.getDouble("position")).put("media",new JSONObject().put("id",MEDIA).put("url",ReceiverProtocol.DEFAULT_SERVER+"/cast/media/"+MEDIA+"/torrent").put("contentType","video/mp4").put("title","Fixture movie").put("canSeek",true).put("expiresAt",System.currentTimeMillis()+300000).put("mediaSourceId","source").put("playSessionId","session"));
            if(path.endsWith("/progress"))progress.add(input);
            return new JSONObject().put("ok",true);
        }
        @Override public byte[] image(String path){return new byte[0];}
    }
    public static class Screen extends BrowseActivity {
        final Api fixture=new Api();final MemoryStore storage=new MemoryStore();final ReceiverActivityTest.FakePlayer playback=new ReceiverActivityTest.FakePlayer();
        @Override protected TvApi createApi(String origin,String token){return fixture;}
        @Override protected AccountStore createStore(){return storage;}
        @Override protected Playback createPlayback(FrameLayout parent){return playback;}
    }
    private void until(BooleanSupplier condition)throws Exception{
        for(int i=0;i<250;i++){shadowOf(Looper.getMainLooper()).idle();if(condition.getAsBoolean())return;Thread.sleep(10);}fail("Async condition not met");
    }
    @Test public void qrEnrollmentSavesAccountAndOpensCatalogWithoutSender()throws Exception{
        try(ActivityController<Screen> controller=Robolectric.buildActivity(Screen.class).setup().visible()){
            Screen view=controller.get();until(()->((TextView)view.findViewById(BrowseActivity.LINK_CODE)).getText().toString().equals("ABCD-EFGH"));
            assertNotNull(view.findViewById(BrowseActivity.LINK_QR));view.fixture.approved=true;
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));until(()->view.storage.token!=null);
            until(()->view.findViewById(BrowseActivity.GRID)!=null&&((RecyclerView)view.findViewById(BrowseActivity.GRID)).getAdapter()!=null);
            assertEquals(TOKEN,view.storage.token);assertEquals(1,((RecyclerView)view.findViewById(BrowseActivity.GRID)).getAdapter().getItemCount());
        }
    }
    @Test public void storedAccountOpensLibraryAndPlaysLocallyWithoutLinkOrPhone()throws Exception{
        try(ActivityController<Screen> controller=Robolectric.buildActivity(Screen.class).create()){
            Screen view=controller.get();view.storage.token=TOKEN;controller.start().resume().visible();
            until(()->view.findViewById(BrowseActivity.GRID)!=null&&((RecyclerView)view.findViewById(BrowseActivity.GRID)).getAdapter()!=null);
            assertFalse(view.fixture.paths.contains("/api/tv/link/start"));
            RecyclerView grid=view.findViewById(BrowseActivity.GRID);grid.measure(View.MeasureSpec.makeMeasureSpec(960,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(400,View.MeasureSpec.EXACTLY));grid.layout(0,0,960,400);
            until(()->grid.getChildCount()>0);grid.getChildAt(0).performClick();until(()->org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog()!=null);
            AlertDialog dialog=org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();until(()->view.playback.loads==1);
            assertEquals(12000,view.playback.position);view.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE));assertTrue(view.playback.paused);
            until(()->!view.fixture.progress.isEmpty());assertEquals("source",view.fixture.progress.get(0).getString("mediaSourceId"));
            controller.pause().stop();until(()->view.fixture.paths.contains("/api/tv/stop"));
            assertTrue(view.fixture.progress.stream().anyMatch(p->p.optString("event").equals("stop")));assertEquals(TOKEN,view.storage.token);
        }
    }
}
