package org.jrplex.tv;

import android.app.AlertDialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.media3.common.util.UnstableApi;
import androidx.appcompat.app.AppCompatActivity;
import androidx.activity.OnBackPressedCallback;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** A foreground, credential-free receiver; no account login or WebView. */
@UnstableApi
public class ReceiverActivity extends AppCompatActivity {
    static final int CODE_ID = 1001, STATUS_ID = 1002, RENEW_ID = 1003, SERVER_ID = 1004;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile int generation;
    private volatile boolean foreground;
    private boolean paired;
    private long ack, expiresAt, lastContact;
    private int failures;
    private String server, secret, mediaId;
    private boolean canSeek;
    private String playbackError;
    private ReceiverApi api;
    private Playback player;
    private FrameLayout root;
    private LinearLayout pairing;
    private TextView code, status, address, expiry;
    private Button renew;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { handleBack(); }
        });
        server = ReceiverProtocol.origin(getIntent().getStringExtra("server") != null ? getIntent().getStringExtra("server") : getPreferences(MODE_PRIVATE).getString("server", ReceiverProtocol.DEFAULT_SERVER));
        root = new FrameLayout(this); root.setBackgroundColor(Color.rgb(16, 20, 24)); setContentView(root);
        player = createPlayback(root);
        pairing = new LinearLayout(this); pairing.setOrientation(LinearLayout.VERTICAL); pairing.setGravity(Gravity.CENTER);
        pairing.setPadding(dp(48), dp(20), dp(48), dp(58));
        root.addView(pairing, new FrameLayout.LayoutParams(-1, -1));
        label(pairing, "JRPlex TV", 30, Color.WHITE);
        address = label(pairing, server, 17, Color.rgb(73, 211, 200));
        label(pairing, "En tu móvil o computadora abre un vídeo en JRPlex.\nElige Enviar a TV e introduce este código:", 19, Color.WHITE);
        code = label(pairing, "······", 58, Color.rgb(73, 211, 200)); code.setTypeface(Typeface.MONOSPACE, Typeface.BOLD); code.setId(CODE_ID);
        expiry = label(pairing, "Preparando vinculación…", 15, Color.LTGRAY);
        LinearLayout buttons = new LinearLayout(this); buttons.setGravity(Gravity.CENTER); pairing.addView(buttons);
        renew = button(buttons, "Nuevo código", this::begin); renew.setId(RENEW_ID);
        Button change = button(buttons, "Cambiar servidor", this::configure); change.setId(SERVER_ID);
        button(buttons, "Acerca de", this::about);
        label(pairing, "Después de vincular, elige esta pantalla para los siguientes vídeos.\nMando: ▶/Ⅱ pausa · ◀/▶ controles · Atrás vuelve a vinculación", 14, Color.LTGRAY);
        status = new TextView(this); status.setId(STATUS_ID); status.setTextColor(Color.WHITE); status.setTextSize(16);
        status.setBackgroundColor(0xD9101418); status.setPadding(dp(24), dp(8), dp(24), dp(8)); status.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams info = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM); root.addView(status, info);
        renew.requestFocus();
    }
    protected ReceiverApi createApi(String origin) { return new ReceiverApi.Http(origin); }
    protected Playback createPlayback(FrameLayout parent) { return new Playback.Native(this, parent, this::playbackChanged); }
    protected long now() { return System.currentTimeMillis(); }
    private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density); }
    private TextView label(LinearLayout parent, String text, int size, int color) {
        TextView view = new TextView(this); view.setText(text); view.setTextSize(size); view.setTextColor(color); view.setGravity(Gravity.CENTER); view.setPadding(0, dp(4), 0, dp(4)); parent.addView(view); return view;
    }
    private Button button(LinearLayout parent, String text, Runnable action) {
        Button view = new Button(this); view.setText(text); view.setAllCaps(false); view.setFocusable(true); view.setMinHeight(dp(48));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2); params.setMargins(dp(8), dp(4), dp(8), dp(4)); parent.addView(view, params);
        view.setOnClickListener(ignored -> action.run()); return view;
    }
    @Override public void onStart() { super.onStart(); foreground = true; begin(); }
    @Override public void onStop() {
        foreground = false; ++generation; handler.removeCallbacksAndMessages(null); end();
        mediaId = null; player.clear(); super.onStop();
    }
    @Override public void onDestroy() { player.release(); io.shutdown(); super.onDestroy(); }
    private void end() {
        String previous = secret; secret = null;
        ReceiverApi previousApi = api;
        if (previous != null && previousApi != null && !io.isShutdown()) io.execute(() -> {
            try { previousApi.post("/cast/receiver/end", object("secret", previous)); } catch (Exception ignored) { /* Expiry is the fallback if offline. */ }
        });
    }
    private static JSONObject object(String key, Object value) {
        JSONObject json = new JSONObject(); try { json.put(key, value); } catch (JSONException error) { throw new IllegalArgumentException(error); } return json;
    }
    private void begin() {
        if (!foreground) return;
        int run = ++generation; handler.removeCallbacksAndMessages(null); end();
        player.clear(); mediaId = null; playbackError = null; ack = 0; paired = false; failures = 0;
        pairing.setVisibility(View.VISIBLE); code.setText("······"); code.setTextSize(58); expiry.setText("El código se renueva automáticamente al caducar.");
        status.setText("Conectando con JRPlex…"); renew.setEnabled(false); renew.requestFocus();
        api = createApi(server); start(run);
    }
    private interface Result { void accept(JSONObject result) throws Exception; }
    private void request(int run, String path, JSONObject input, Result result) {
        ReceiverApi target = api;
        io.execute(() -> {
            try {
                JSONObject value = target.post(path, input);
                if (run != generation || !foreground) {
                    if (path.endsWith("/start")) try { target.post("/cast/receiver/end", object("secret", value.getString("secret"))); } catch (Exception ignored) { }
                    return;
                }
                handler.post(() -> {
                    if (run != generation || !foreground) {
                        if (path.endsWith("/start") && !io.isShutdown()) io.execute(() -> { try { target.post("/cast/receiver/end", object("secret", value.getString("secret"))); } catch (Exception ignored) { } });
                        return;
                    }
                    try { result.accept(value); } catch (Exception error) { failed(run, path, error); }
                });
            } catch (Exception error) { handler.post(() -> { if (run == generation && foreground) failed(run, path, error); }); }
        });
    }
    private void start(int run) {
        request(run, "/cast/receiver/start", object("name", "JRPlex Fire TV"), result -> {
            String next = result.getString("secret"); String nextCode = result.getString("code");
            if (!next.matches("[A-Za-z0-9_-]{43}") || !nextCode.matches("[0-9]{6}")) throw new JSONException("Invalid pairing");
            secret = next; expiresAt = result.getLong("expiresAt"); lastContact = now(); failures = 0;
            code.setText(nextCode); renew.setEnabled(true); renew.requestFocus(); status.setText("Esperando que introduzcas el código en JRPlex…"); poll(run);
        });
    }
    private JSONObject state() throws JSONException {
        return new JSONObject().put("mediaId", mediaId == null ? JSONObject.NULL : mediaId)
                .put("status", mediaId == null ? "ready" : playbackError != null ? "error" : player.status())
                .put("position", ReceiverProtocol.reportSeconds(player.position()))
                .put("duration", ReceiverProtocol.reportSeconds(player.duration())).put("paused", player.paused());
    }
    private void poll(int run) {
        if (!foreground || run != generation || secret == null) return;
        if (!paired && now() >= expiresAt) { begin(); return; }
        try {
            JSONObject input = new JSONObject().put("secret", secret).put("ack", ack).put("state", state());
            request(run, "/cast/receiver/poll", input, result -> {
                lastContact = now(); failures = 0; paired = result.getBoolean("paired");
                if (paired && mediaId == null) {
                    code.setText("Vinculada"); code.setTextSize(36); expiry.setText("Lista para recibir vídeos durante tu sesión.");
                    status.setText("Pantalla vinculada. Elige un vídeo en JRPlex y envíalo aquí.");
                } else if (!paired) expiry.setText("Código válido por " + Math.max(1, (expiresAt - now() + 59999) / 60000) + " min · renovación automática");
                JSONArray commands = result.getJSONArray("commands");
                for (int i = 0; i < commands.length(); i++) {
                    JSONObject command = commands.getJSONObject(i); long sequence = command.getLong("sequence");
                    if (sequence <= ack) continue;
                    try { apply(command); }
                    catch (Exception error) { playbackError = "No se pudo abrir el vídeo. Vuelve a enviarlo desde JRPlex."; player.clear(); status.setText(playbackError); }
                    ack = sequence;
                }
                if (mediaId != null) playbackChanged();
                handler.postDelayed(() -> poll(run), 1000);
            });
        } catch (JSONException error) { failed(run, "/cast/receiver/poll", error); }
    }
    private void apply(JSONObject command) throws JSONException {
        String action = command.getString("command");
        switch (action) {
            case "play":
                ReceiverProtocol.Media media = ReceiverProtocol.media(server, command, now());
                mediaId = media.id; canSeek = media.canSeek; playbackError = null;
                pairing.setVisibility(View.GONE); status.setVisibility(View.VISIBLE);
                status.setText("Preparando " + media.title + "…"); player.load(media); break;
            case "pause": player.pause(); break;
            case "resume": if (mediaId != null) player.resume(); break;
            case "seek": if (mediaId != null && canSeek) player.seek((long) (ReceiverProtocol.seconds(command.getDouble("position")) * 1000)); break;
            case "stop":
                mediaId = null; playbackError = null; player.clear(); pairing.setVisibility(View.VISIBLE);
                status.setVisibility(View.VISIBLE); status.setText("Pantalla vinculada. Puedes enviar otro vídeo."); renew.requestFocus(); break;
            default: throw new IllegalArgumentException("Control no válido.");
        }
    }
    private void failed(int run, String path, Exception error) {
        ++failures; renew.setEnabled(true);
        if (error instanceof ReceiverApi.Failure && (((ReceiverApi.Failure) error).status == 401 || ((ReceiverApi.Failure) error).status == 403)) {
            status.setVisibility(View.VISIBLE); status.setText("La vinculación terminó. Preparando un nuevo código…");
            handler.postDelayed(this::begin, 2000); return;
        }
        if (mediaId != null && now() - lastContact >= 15000) { player.clear(); playbackError = "Se perdió la conexión. Vuelve a enviar el vídeo cuando se recupere."; }
        status.setVisibility(View.VISIBLE); status.setText(playbackError != null ? playbackError : "No se pudo conectar. Comprueba la red o cambia el servidor. Reintentando…");
        long delay = error instanceof ReceiverApi.Failure && ((ReceiverApi.Failure) error).status == 429 ? 60000 : Math.min(30000, 2000L << Math.min(failures - 1, 4));
        handler.postDelayed(() -> { if (run != generation || !foreground) return; if (path.endsWith("/start")) start(run); else poll(run); }, delay);
    }
    private void playbackChanged() {
        if (status == null || mediaId == null) return;
        String current = playbackError != null ? "error" : player.status();
        if (current.equals("playing")) status.setVisibility(View.GONE);
        else {
            status.setVisibility(View.VISIBLE);
            status.setText(current.equals("error") ? "No se pudo reproducir. Revisa la red y vuelve a enviar el vídeo desde JRPlex."
                    : current.equals("ended") ? "El vídeo terminó. Puedes enviar otro desde JRPlex."
                    : current.equals("paused") ? "En pausa · pulsa ▶/Ⅱ para continuar" : "Cargando vídeo…");
        }
    }
    private void configure() {
        EditText input = new EditText(this); input.setText(server); input.setSingleLine(); input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setPadding(dp(24), dp(12), dp(24), dp(12));
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("Servidor JRPlex · HTTPS").setView(input)
                .setNegativeButton("Cancelar", null).setPositiveButton("Guardar", null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                server = ReceiverProtocol.origin(input.getText().toString()); getPreferences(MODE_PRIVATE).edit().putString("server", server).apply();
                address.setText(server); dialog.dismiss(); begin();
            } catch (IllegalArgumentException error) { input.setError(error.getMessage()); }
        })); dialog.show();
    }
    private void about() {
        try (var notice = getAssets().open("NOTICE.txt"); var license = getAssets().open("APACHE-2.0.txt")) {
            android.widget.ScrollView scroll = new android.widget.ScrollView(this);
            TextView text = new TextView(this); text.setTextSize(15); text.setPadding(dp(24), dp(12), dp(24), dp(12));
            text.setText(new String(readAsset(notice), java.nio.charset.StandardCharsets.UTF_8) + "\n\n" + new String(readAsset(license), java.nio.charset.StandardCharsets.UTF_8));
            scroll.addView(text); new AlertDialog.Builder(this).setTitle("JRPlex TV 2.0.0 · Licencias").setView(scroll).setPositiveButton("Cerrar", null).show();
        } catch (java.io.IOException error) { status.setText("JRPlex TV 2.0.0 · github.com/oreyes100/JRPlex"); }
    }
    private byte[] readAsset(java.io.InputStream stream) throws java.io.IOException {
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream(); byte[] part = new byte[4096]; int count;
        while ((count = stream.read(part)) != -1) buffer.write(part, 0, count);
        return buffer.toByteArray();
    }
    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (mediaId != null) {
            int key = event.getKeyCode();
            if (key == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || key == KeyEvent.KEYCODE_MEDIA_PLAY || key == KeyEvent.KEYCODE_MEDIA_PAUSE) {
                if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                    if (key == KeyEvent.KEYCODE_MEDIA_PAUSE || (key == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE && !player.paused())) player.pause(); else player.resume();
                } return true;
            }
            if (key == KeyEvent.KEYCODE_MEDIA_REWIND || key == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD) {
                if (event.getAction() == KeyEvent.ACTION_DOWN && canSeek) player.seek(Math.max(0, player.position() + (key == KeyEvent.KEYCODE_MEDIA_REWIND ? -10000 : 10000)));
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }
    private void handleBack() {
        if (mediaId != null) new AlertDialog.Builder(this).setTitle("¿Dejar de reproducir en esta TV?")
                .setMessage("JRPlex volverá al dispositivo desde el que enviaste el vídeo.")
                .setNegativeButton("Seguir viendo", (dialog, which) -> player.focus())
                .setPositiveButton("Detener y volver", (dialog, which) -> begin()).show();
        else finish();
    }
}
