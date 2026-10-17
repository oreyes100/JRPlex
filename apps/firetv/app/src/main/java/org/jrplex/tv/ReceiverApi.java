package org.jrplex.tv;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;

interface ReceiverApi {
    JSONObject post(String path, JSONObject input) throws Exception;

    final class Failure extends IOException {
        final int status;
        Failure(int status, String message) { super(message); this.status = status; }
    }
    final class Http implements ReceiverApi {
        private final String server;
        Http(String server) { this.server = ReceiverProtocol.origin(server); }
        @Override public JSONObject post(String path, JSONObject input) throws Exception {
            if (!path.matches("/cast/receiver/(start|poll|end)")) throw new IOException("Ruta no válida.");
            HttpsURLConnection connection = (HttpsURLConnection) new URL(server + path).openConnection();
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(8000); connection.setReadTimeout(8000);
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("Origin", server);
                connection.setRequestProperty("User-Agent", "JRPlexTV/1.0.0");
                byte[] bytes = input.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (var output = connection.getOutputStream()) { output.write(bytes); }
                int status = connection.getResponseCode();
                if (status == 401 || status == 403) throw new Failure(status, "La vinculación terminó.");
                if (status == 429) throw new Failure(status, "Demasiados intentos. Espera un minuto.");
                if (status < 200 || status >= 300) throw new Failure(status, "El servidor no respondió. Reintentando…");
                try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
                    byte[] chunk = new byte[4096]; int read;
                    while ((read = stream.read(chunk)) != -1) {
                        if (buffer.size() + read > 131072) throw new IOException("Respuesta de servidor no válida.");
                        buffer.write(chunk, 0, read);
                    }
                    return new JSONObject(buffer.toString(StandardCharsets.UTF_8.name()));
                }
            } finally { connection.disconnect(); }
        }
    }
}
