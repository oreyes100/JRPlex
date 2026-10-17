package org.jrplex.tv;

import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.media3.common.util.UnstableApi;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.RecyclerView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URLEncoder;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Standalone catalog client. The phone is used only to enroll a dedicated account. */
@UnstableApi
public class BrowseActivity extends AppCompatActivity {
    static final int LINK_CODE = 2001, LINK_QR = 2002, STATUS = 2003, GRID = 2004;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor(), images = Executors.newFixedThreadPool(2);
    private volatile int generation;
    private volatile boolean foreground;
    private FrameLayout root;
    private LinearLayout content;
    private TextView status, linkCode;
    private ImageView qr, photograph;
    private Playback player;
    private AccountStore store;
    private String server, token, linkSecret, userName = "", activeItem;
    private JSONObject activeMedia;
    private boolean photoVisible, browsing, preparing;
    private final java.util.concurrent.atomic.AtomicBoolean progressPending = new java.util.concurrent.atomic.AtomicBoolean();
    private long codeExpires;
    private int linkFailures;
    private TvApi api;
    private Entry entry = new Entry("home", "", "", 0, "Biblioteca");
    private final ArrayDeque<Entry> history = new ArrayDeque<>();
    private final android.util.LruCache<String, Bitmap> imageCache = new android.util.LruCache<>(8 * 1024 * 1024) {
        @Override protected int sizeOf(String key, Bitmap bitmap) { return bitmap.getAllocationByteCount(); }
    };
    static final class Entry {
        final String kind, parent, search, title; final int offset;
        Entry(String kind, String parent, String search, int offset, String title) { this.kind = kind; this.parent = parent; this.search = search; this.offset = offset; this.title = title; }
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) { @Override public void handleOnBackPressed() { back(); } });
        server = getSharedPreferences("tv-client", MODE_PRIVATE).getString("server", ReceiverProtocol.DEFAULT_SERVER);
        root = new FrameLayout(this); root.setBackgroundColor(Color.rgb(16, 20, 24)); setContentView(root);
        player = createPlayback(root); store = createStore();
        photograph = new ImageView(this); photograph.setScaleType(ImageView.ScaleType.FIT_CENTER); photograph.setBackgroundColor(Color.BLACK); photograph.setVisibility(View.GONE); root.addView(photograph, new FrameLayout.LayoutParams(-1, -1));
        content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); content.setPadding(dp(30), dp(16), dp(30), dp(48)); root.addView(content, new FrameLayout.LayoutParams(-1, -1));
        status = new TextView(this); status.setId(STATUS); status.setTextColor(Color.WHITE); status.setTextSize(15); status.setPadding(dp(20), dp(8), dp(20), dp(8)); status.setGravity(Gravity.CENTER); status.setBackgroundColor(0xE6101418);
        root.addView(status, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
    }
    protected TvApi createApi(String origin, String credential) { return new TvApi.Http(origin, credential); }
    protected AccountStore createStore() { return new AccountStore.Encrypted(this); }
    protected Playback createPlayback(FrameLayout parent) { return new Playback.Native(this, parent, this::playerChanged); }
    protected long now() { return System.currentTimeMillis(); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private TextView label(LinearLayout parent, String text, int size) {
        TextView view = new TextView(this); view.setText(text); view.setTextColor(Color.WHITE); view.setTextSize(size); view.setPadding(dp(6), dp(3), dp(6), dp(3)); parent.addView(view); return view;
    }
    private Button button(LinearLayout parent, String text, Runnable action) {
        Button button = new Button(this); button.setText(text); button.setAllCaps(false); button.setFocusable(true); button.setMinHeight(dp(44)); parent.addView(button); button.setOnClickListener(view -> action.run()); return button;
    }
    private void message(String value) { status.setText(value); status.setVisibility(View.VISIBLE); }
    private static JSONObject data(String key, Object value) throws org.json.JSONException { return new JSONObject().put(key, value); }
    private String encode(String text) { try { return URLEncoder.encode(text, "UTF-8"); } catch (Exception error) { throw new IllegalArgumentException(error); } }
    @Override public void onStart() {
        super.onStart(); foreground = true; int run = ++generation; message("Abriendo tu biblioteca…");
        io.execute(() -> {
            try { String saved = store.read(server); handler.post(() -> { if (run != generation || !foreground) return; token = saved; api = createApi(server, token); if (saved == null) startLink(); else accountSession(); }); }
            catch (Exception error) { store.clear(); handler.post(() -> { if (run == generation && foreground) startLink(); }); }
        });
    }
    @Override public void onStop() { foreground = false; ++generation; handler.removeCallbacksAndMessages(null); stopPlayback(); photograph.setVisibility(View.GONE); photoVisible = false; super.onStop(); }
    @Override public void onDestroy() { player.release(); imageCache.evictAll(); io.shutdown(); images.shutdownNow(); super.onDestroy(); }
    private interface Result { void accept(JSONObject result) throws Exception; }
    private void request(String method, String path, JSONObject input, Result action) {
        int run = generation; TvApi target = api;
        io.execute(() -> {
            try {
                JSONObject result = target.call(method, path, input);
                handler.post(() -> {
                    if (run != generation || !foreground) {
                        if (path.equals("/api/tv/play") && !io.isShutdown()) io.execute(() -> { try { target.call("POST", "/api/tv/stop", data("mediaId", result.getJSONObject("media").getString("id"))); } catch (Exception ignored) { } });
                        return;
                    }
                    try { action.accept(result); } catch (Exception error) { failure(error); }
                });
            } catch (Exception error) { handler.post(() -> { if (run == generation && foreground) failure(error); }); }
        });
    }
    private void failure(Exception error) {
        preparing = false;
        if (error instanceof TvApi.Failure && ((TvApi.Failure) error).status == 401 && token != null) { store.clear(); token = null; stopPlayback(); startLink(); return; }
        if (error instanceof TvApi.Failure && ((TvApi.Failure) error).status == 401 && linkSecret != null) { startLink(); return; }
        message(error instanceof TvApi.Failure ? error.getMessage() : "No se pudo conectar o reproducir. Comprueba la red y vuelve a intentarlo.");
        if (!browsing && token == null) {
            int run = generation; long delay = error instanceof TvApi.Failure && ((TvApi.Failure) error).status == 429 ? 60000 : Math.min(30000, 2000L << Math.min(linkFailures++, 4));
            handler.postDelayed(() -> { if (run == generation && foreground) { if (linkSecret == null || now() >= codeExpires) startLink(); else pollLink(); } }, delay);
        }
    }
    private void accountSession() {
        request("GET", "/api/tv/session", null, result -> { userName = result.getJSONObject("user").getString("Name"); browse(entry, false); });
        content.removeAllViews(); label(content, "JRPlex TV", 28); button(content, "Reintentar conexión", this::accountSession); button(content, "Vincular otra cuenta", this::confirmLogout);
    }
    private void startLink() {
        if (!foreground) return;
        ++generation; handler.removeCallbacksAndMessages(null); stopPlayback(); token = null; linkSecret = null; browsing = false; api = createApi(server, null);
        content.setVisibility(View.VISIBLE); content.removeAllViews(); label(content, "JRPlex TV · Vincula tu cuenta", 28);
        LinearLayout row = new LinearLayout(this); row.setGravity(Gravity.CENTER_VERTICAL); content.addView(row, new LinearLayout.LayoutParams(-1, 0, 1));
        qr = new ImageView(this); qr.setId(LINK_QR); qr.setContentDescription("Escanea para vincular tu cuenta desde el teléfono"); row.addView(qr, new LinearLayout.LayoutParams(dp(220), dp(220)));
        LinearLayout text = new LinearLayout(this); text.setOrientation(LinearLayout.VERTICAL); text.setPadding(dp(24), 0, 0, 0); row.addView(text, new LinearLayout.LayoutParams(0, -2, 1));
        label(text, "1. Escanea el QR con tu teléfono.\n2. Entra con tu cuenta y confirma.\n3. Elige y reproduce aquí con el mando.", 19);
        label(text, "También puedes abrir " + server + "/activate", 16);
        linkCode = label(text, "····-····", 36); linkCode.setId(LINK_CODE); linkCode.setTextColor(Color.rgb(73, 211, 200));
        label(text, "El código dura 5 minutos y se renueva solo.\nDespués de vincular, no necesitas el teléfono.", 15);
        LinearLayout buttons = new LinearLayout(this); content.addView(buttons); button(buttons, "Nuevo código", this::startLink).requestFocus(); button(buttons, "Cambiar servidor", this::configure); button(buttons, "Recibir un envío", this::receiveCast);
        message("Preparando código y QR…");
        try { request("POST", "/api/tv/link/start", data("name", "JRPlex Fire TV"), result -> {
            String secret = result.getString("secret"), code = result.getString("code"), url = result.getString("verificationUrl");
            if (!secret.matches("[A-Za-z0-9_-]{43}") || !code.matches("[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}")) throw new IllegalArgumentException("Código no válido.");
            Bitmap bitmap = QrCode.create(server, url); linkSecret = secret; codeExpires = result.getLong("expiresAt"); linkFailures = 0;
            qr.setImageBitmap(bitmap); linkCode.setText(code); message("Esperando que vincules tu cuenta desde el teléfono…"); pollLink();
        }); } catch (Exception error) { failure(error); }
    }
    private void pollLink() {
        if (!foreground || linkSecret == null) return;
        if (now() >= codeExpires) { startLink(); return; }
        try { request("POST", "/api/tv/link/poll", data("secret", linkSecret), result -> {
            if (result.getString("status").equals("approved")) {
                String credential = result.getString("token"); if (!credential.matches("[A-Za-z0-9_-]{43}")) throw new IllegalArgumentException("Acceso no válido.");
                int run = generation; message("Guardando el acceso de esta TV…");
                io.execute(() -> { try { store.save(server, credential); handler.post(() -> { if (run != generation || !foreground) return; token = credential; linkSecret = null; api = createApi(server, token); accountSession(); }); }
                    catch (Exception error) { handler.post(() -> { if (run == generation && foreground) message("No se pudo guardar el acceso cifrado. Vuelve a vincular la cuenta."); }); } });
            } else { int run = generation; handler.postDelayed(() -> { if (run == generation && foreground) pollLink(); }, 2000); }
        }); } catch (Exception error) { failure(error); }
    }
    private void receiveCast() { startActivity(new Intent(this, ReceiverActivity.class).putExtra("server", server)); }
    private void browse(Entry next, boolean remember) {
        if (remember) history.push(entry); entry = next; browsing = true; ++generation; handler.removeCallbacksAndMessages(null); content.setVisibility(View.VISIBLE); content.removeAllViews();
        label(content, "JRPlex TV · " + userName + " · " + next.title, 23);
        HorizontalScrollView navScroll = new HorizontalScrollView(this); LinearLayout nav = new LinearLayout(this); navScroll.addView(nav); content.addView(navScroll);
        String[] names = {"Inicio", "Continuar", "Películas", "Series", "Música", "Fotos"}; String[] kinds = {"home", "resume", "movies", "series", "music", "photos"};
        for (int i = 0; i < names.length; i++) { String name = names[i], kind = kinds[i]; button(nav, name, () -> { history.clear(); browse(new Entry(kind, "", "", 0, name), false); }); }
        button(nav, "Buscar", this::search); button(nav, "Cuenta", this::account);
        RecyclerView grid = new RecyclerView(this); grid.setId(GRID); grid.setLayoutManager(new GridLayoutManager(this, 5)); grid.setClipToPadding(false); grid.setPadding(0, dp(8), 0, dp(8)); content.addView(grid, new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout pages = new LinearLayout(this); pages.setGravity(Gravity.CENTER); content.addView(pages);
        message("Cargando biblioteca…");
        String path = "/api/tv/catalog?kind=" + encode(next.kind) + "&parent=" + encode(next.parent) + "&search=" + encode(next.search) + "&offset=" + next.offset;
        request("GET", path, null, result -> {
            JSONArray list = result.getJSONArray("items"); ArrayList<JSONObject> items = new ArrayList<>(); for (int i = 0; i < list.length(); i++) items.add(list.getJSONObject(i));
            grid.setAdapter(new CatalogAdapter(items, generation));
            if (next.offset > 0) button(pages, "Página anterior", () -> browse(new Entry(next.kind, next.parent, next.search, Math.max(0, next.offset - 40), next.title), false));
            int total = result.getInt("total"); label(pages, total == 0 ? "Sin resultados" : (next.offset + 1) + "–" + (next.offset + items.size()) + " de " + total, 15);
            if (next.offset + items.size() < total) button(pages, "Página siguiente", () -> browse(new Entry(next.kind, next.parent, next.search, next.offset + 40, next.title), false));
            message(items.isEmpty() ? "No hay contenido en esta vista. Prueba otra biblioteca o búsqueda." : "Elige un título con el mando. Atrás vuelve a la vista anterior.");
            if (!items.isEmpty()) grid.post(() -> { if (grid.getChildCount() > 0) grid.getChildAt(0).requestFocus(); });
        });
    }
    private void search() {
        EditText input = new EditText(this); input.setSingleLine(); input.setText(entry.search);
        new AlertDialog.Builder(this).setTitle("Buscar en mi biblioteca").setView(input).setNegativeButton("Cancelar", null).setPositiveButton("Buscar", (dialog, which) -> browse(new Entry("home", "", input.getText().toString().trim(), 0, "Buscar"), true)).show();
    }
    private void account() { new AlertDialog.Builder(this).setTitle("Cuenta · " + userName).setItems(new String[]{"Recibir un envío", "Cambiar servidor", "Desvincular esta TV"}, (dialog, which) -> { if (which == 0) receiveCast(); else if (which == 1) configure(); else confirmLogout(); }).setNegativeButton("Volver", null).show(); }
    private void confirmLogout() { new AlertDialog.Builder(this).setTitle("¿Desvincular esta TV?").setMessage("Esta TV dejará de tener acceso a tu cuenta.").setNegativeButton("Cancelar", null).setPositiveButton("Desvincular", (dialog, which) -> logout()).show(); }
    private void logout() {
        stopPlayback(); TvApi previous = api; store.clear(); token = null; imageCache.evictAll(); history.clear(); entry = new Entry("home", "", "", 0, "Biblioteca");
        io.execute(() -> { try { previous.call("POST", "/api/tv/logout", new JSONObject()); } catch (Exception ignored) { } }); startLink();
    }
    private void configure() {
        EditText input = new EditText(this); input.setText(server); input.setSingleLine(); input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("Servidor HTTPS JRPlex").setView(input).setNegativeButton("Cancelar", null).setPositiveButton("Guardar", null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try { String next = ReceiverProtocol.origin(input.getText().toString()); if (next.equals(server)) { dialog.dismiss(); return; }
                if (token != null) { TvApi previous = api; io.execute(() -> { try { previous.call("POST", "/api/tv/logout", new JSONObject()); } catch (Exception ignoredError) { } }); }
                stopPlayback(); store.clear(); imageCache.evictAll(); server = next; getSharedPreferences("tv-client", MODE_PRIVATE).edit().putString("server", next).apply(); dialog.dismiss(); startLink();
            } catch (IllegalArgumentException error) { input.setError(error.getMessage()); }
        })); dialog.show();
    }
    private void select(JSONObject summary) {
        String id = summary.optString("Id"); String type = summary.optString("Type");
        if (summary.optBoolean("IsFolder") || type.matches("Series|Season|MusicAlbum|CollectionFolder|Folder|MusicArtist|Playlist")) { browse(new Entry(entry.kind, id, "", 0, summary.optString("Name")), true); return; }
        if (type.equals("Photo")) { showPhoto(id); return; }
        request("GET", "/api/tv/item?id=" + encode(id), null, item -> {
            double position = item.optDouble("Position", 0); String overview = item.optString("Overview");
            AlertDialog.Builder dialog = new AlertDialog.Builder(this).setTitle(item.optString("Name")).setMessage(overview.isEmpty() ? "Reproducir en esta TV" : overview).setNegativeButton("Volver", null);
            if (position > 5) dialog.setPositiveButton("Continuar · " + (int) (position / 60) + " min", (value, which) -> play(id, position)).setNeutralButton("Desde el principio", (value, which) -> play(id, 0));
            else dialog.setPositiveButton("Reproducir", (value, which) -> play(id, 0)); dialog.show();
        });
    }
    private void play(String id, double position) {
        if (preparing) return; stopPlayback(); preparing = true; message("Preparando el vídeo…");
        try { request("POST", "/api/tv/play", new JSONObject().put("itemId", id).put("position", position), result -> {
            ReceiverProtocol.Media media = ReceiverProtocol.media(server, result, now()); preparing = false; activeItem = id; activeMedia = result.getJSONObject("media");
            content.setVisibility(View.GONE); player.load(media); progress("start"); scheduleProgress();
        }); } catch (Exception error) { failure(error); }
    }
    private void scheduleProgress() { int run = generation; handler.postDelayed(() -> { if (run == generation && activeMedia != null && foreground) { progress("progress"); scheduleProgress(); } }, 10000); }
    private void progress(String event) {
        if (activeItem == null) return; String id = activeItem; double position = ReceiverProtocol.reportSeconds(player.position()); boolean paused = player.paused(); TvApi target = api; JSONObject media = activeMedia;
        if (event.equals("progress") && !progressPending.compareAndSet(false, true)) return;
        io.execute(() -> { try { target.call("POST", "/api/tv/progress", new JSONObject().put("itemId", id).put("mediaId", media.optString("id")).put("position", position).put("paused", paused).put("event", event)
                    .put("mediaSourceId", media.optString("mediaSourceId", "")).put("playSessionId", media.optString("playSessionId", "")).put("canSeek", media.optBoolean("canSeek", true)).put("playMethod", media.optString("playMethod", "DirectPlay"))); } catch (Exception ignored) { /* Playback is not blocked by resume reporting. */ } finally { if (event.equals("progress")) progressPending.set(false); } });
    }
    private void stopPlayback() {
        preparing = false;
        if (activeMedia != null) {
            progress("stop"); String mediaId = activeMedia.optString("id"); TvApi target = api; activeMedia = null; activeItem = null;
            if (!io.isShutdown()) io.execute(() -> { try { target.call("POST", "/api/tv/stop", data("mediaId", mediaId)); } catch (Exception ignored) { } });
        }
        player.clear();
    }
    private void playerChanged() {
        if (status == null || activeMedia == null) return;
        String state = player.status();
        if (state.equals("playing")) status.setVisibility(View.GONE);
        else if (state.equals("error")) message("No se pudo reproducir. Pulsa Atrás para volver a intentarlo.");
        else if (state.equals("ended")) { stopPlayback(); browse(entry, false); message("La reproducción terminó. Elige otro título."); }
        else message(state.equals("paused") ? "En pausa · pulsa ▶/Ⅱ para continuar" : "Cargando vídeo…");
    }
    private void showPhoto(String id) {
        int run = generation; TvApi target = api; content.setVisibility(View.GONE); photograph.setImageDrawable(null); photograph.setVisibility(View.VISIBLE); photoVisible = true; message("Cargando foto…");
        images.execute(() -> { try { byte[] bytes = target.image("/api/tv/photo?id=" + encode(id)); Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length); handler.post(() -> { if (run == generation && foreground && photoVisible) { photograph.setImageBitmap(bitmap); message("Foto · pulsa Atrás para volver a la biblioteca"); } }); }
            catch (Exception error) { handler.post(() -> { if (run == generation && foreground && photoVisible) message("No se pudo cargar la foto. Pulsa Atrás."); }); } });
    }
    private void back() {
        if (activeMedia != null) { new AlertDialog.Builder(this).setTitle("¿Volver a la biblioteca?").setNegativeButton("Seguir viendo", (d, w) -> player.focus()).setPositiveButton("Guardar y volver", (d, w) -> { stopPlayback(); browse(entry, false); }).show(); }
        else if (photoVisible) { photograph.setVisibility(View.GONE); photograph.setImageDrawable(null); photoVisible = false; content.setVisibility(View.VISIBLE); }
        else if (browsing && !history.isEmpty()) browse(history.pop(), false);
        else if (browsing && !entry.kind.equals("home")) browse(new Entry("home", "", "", 0, "Biblioteca"), false);
        else finish();
    }
    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (activeMedia != null) {
            int key = event.getKeyCode();
            if (key == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || key == KeyEvent.KEYCODE_MEDIA_PLAY || key == KeyEvent.KEYCODE_MEDIA_PAUSE) {
                if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) { if (key == KeyEvent.KEYCODE_MEDIA_PAUSE || (key == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE && !player.paused())) player.pause(); else player.resume(); } return true;
            }
            if (key == KeyEvent.KEYCODE_MEDIA_REWIND || key == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD) { if (event.getAction() == KeyEvent.ACTION_DOWN && activeMedia.optBoolean("canSeek")) player.seek(Math.max(0, player.position() + (key == KeyEvent.KEYCODE_MEDIA_REWIND ? -10000 : 10000))); return true; }
        }
        return super.dispatchKeyEvent(event);
    }
    private final class CatalogAdapter extends RecyclerView.Adapter<Card> {
        private final ArrayList<JSONObject> items; private final int run;
        CatalogAdapter(ArrayList<JSONObject> items, int run) { this.items = items; this.run = run; }
        @Override public Card onCreateViewHolder(ViewGroup parent, int type) {
            LinearLayout view = new LinearLayout(BrowseActivity.this); view.setOrientation(LinearLayout.VERTICAL); view.setPadding(dp(8), dp(8), dp(8), dp(8)); view.setFocusable(true); view.setClickable(true); view.setBackgroundResource(R.drawable.tv_card);
            ImageView image = new ImageView(BrowseActivity.this); image.setScaleType(ImageView.ScaleType.CENTER_CROP); view.addView(image, new LinearLayout.LayoutParams(-1, dp(138)));
            TextView title = label(view, "", 16); title.setMaxLines(2); title.setMinHeight(dp(44)); return new Card(view, image, title);
        }
        @Override public void onBindViewHolder(Card holder, int index) {
            JSONObject item = items.get(index); String id = item.optString("Id"); holder.image.setImageDrawable(null); holder.title.setText((item.optBoolean("IsFolder") ? "▣ " : "") + item.optString("Name")); holder.itemView.setOnClickListener(view -> select(item)); holder.itemView.setContentDescription(item.optString("Name"));
            holder.image.setTag(id); Bitmap cached = imageCache.get(id); if (cached != null) holder.image.setImageBitmap(cached);
            else if (item.optBoolean("Image")) { TvApi target = api; images.execute(() -> { try { byte[] bytes = target.image("/api/tv/image?id=" + encode(id)); Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length); handler.post(() -> { if (run == generation && foreground && bitmap != null) { imageCache.put(id, bitmap); if (id.equals(holder.image.getTag())) holder.image.setImageBitmap(bitmap); } }); } catch (Exception ignored) { } }); }
        }
        @Override public int getItemCount() { return items.size(); }
    }
    private static final class Card extends RecyclerView.ViewHolder {
        final ImageView image; final TextView title; Card(View view, ImageView image, TextView title) { super(view); this.image = image; this.title = title; }
    }
}
