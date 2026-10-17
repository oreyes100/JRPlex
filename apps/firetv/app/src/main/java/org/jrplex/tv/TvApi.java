package org.jrplex.tv;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;

interface TvApi {
    JSONObject call(String method, String path, JSONObject input) throws Exception;
    byte[] image(String path) throws Exception;
    final class Failure extends IOException {
        final int status;
        Failure(int status, String detail) { super(status == 401 ? "Vuelve a vincular tu cuenta." : status == 429 ? "Demasiados intentos. Espera un momento." : detail != null && !detail.isBlank() ? detail : "No se pudo completar la solicitud (" + status + ")."); this.status = status; }
    }
    final class Http implements TvApi {
        private final String server, token;
        Http(String server, String token) { this.server = ReceiverProtocol.origin(server); this.token = token; }
        private byte[] request(String method, String path, JSONObject input, int maximum) throws Exception {
            if (!path.startsWith("/api/tv/") || path.length() > 2048 || path.contains("#") || path.contains("\\")) throw new IOException("Ruta de TV no válida.");
            HttpsURLConnection connection = (HttpsURLConnection) new URL(server + path).openConnection();
            try {
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(10000); connection.setReadTimeout(20000);
                connection.setRequestMethod(method); connection.setRequestProperty("Origin", server); connection.setRequestProperty("User-Agent", "JRPlexTV/2.1.0");
                if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
                if (input != null) {
                    byte[] bytes = input.toString().getBytes(StandardCharsets.UTF_8); connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json"); connection.setFixedLengthStreamingMode(bytes.length);
                    try (var output = connection.getOutputStream()) { output.write(bytes); }
                }
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    String detail = "";
                    try (InputStream stream = connection.getErrorStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                        if (stream != null) { byte[] part = new byte[2048]; int count; while ((count = stream.read(part)) != -1 && output.size() + count <= 16384) output.write(part, 0, count); }
                        if (output.size() > 0) {
                            String message = new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8)).optString("error", "");
                            if (message.length() <= 180 && !message.matches("(?is).*https?://.*|.*(?:token|authorization|api.?key).*")) detail = message;
                        }
                    } catch (Exception ignored) { }
                    throw new Failure(status, detail);
                }
                try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] part = new byte[8192]; int count;
                    while ((count = stream.read(part)) != -1) { if (output.size() + count > maximum) throw new IOException("Respuesta demasiado grande."); output.write(part, 0, count); }
                    return output.toByteArray();
                }
            } finally { connection.disconnect(); }
        }
        @Override public JSONObject call(String method, String path, JSONObject input) throws Exception { return new JSONObject(new String(request(method, path, input, 2 * 1024 * 1024), StandardCharsets.UTF_8)); }
        @Override public byte[] image(String path) throws Exception { return request("GET", path, null, 12 * 1024 * 1024); }
    }
}
