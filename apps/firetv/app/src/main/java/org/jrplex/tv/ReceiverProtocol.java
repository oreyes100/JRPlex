package org.jrplex.tv;

import org.json.JSONException;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;
import java.util.ArrayList;
import java.util.Locale;

/** Only the server's scoped media capabilities may reach the player. */
final class ReceiverProtocol {
    static final String DEFAULT_SERVER = "https://jrplexps.duckdns.org";
    static String origin(String input) {
        try {
            URI uri = new URI(input.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || !(uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))
                    || uri.getPort() == 0 || uri.getPort() > 65535) throw new IllegalArgumentException();
            return "https://" + uri.getRawAuthority().toLowerCase(Locale.ROOT);
        } catch (Exception error) { throw new IllegalArgumentException("Usa la dirección HTTPS de tu servidor, sin rutas ni credenciales."); }
    }
    static double seconds(double value) {
        if (Double.isNaN(value) || Double.isInfinite(value) || value < 0 || value > 604800) throw new IllegalArgumentException("Posición de vídeo no válida.");
        return value;
    }
    static double reportSeconds(long milliseconds) {
        return milliseconds <= 0 ? 0 : Math.min(milliseconds / 1000.0, 604800);
    }
    static Media media(String server, JSONObject command, long now) throws JSONException {
        JSONObject item = command.getJSONObject("media");
        String id = item.getString("id"); String url = item.getString("url");
        URI uri;
        try { uri = URI.create(url); }
        catch (IllegalArgumentException error) { throw new IllegalArgumentException("Fuente de TV no válida."); }
        String type = item.getString("contentType").toLowerCase(Locale.ROOT);
        if (!id.matches("[A-Za-z0-9_-]{43}") || uri.getRawUserInfo() != null || uri.getRawFragment() != null
                || !origin(uri.getScheme() + "://" + uri.getRawAuthority()).equals(server))
            throw new IllegalArgumentException("La fuente recibida no pertenece a este servidor o no es compatible.");
        if (item.getLong("expiresAt") <= now) throw new IllegalArgumentException("El envío caducó. Vuelve a enviarlo desde JRPlex.");
        if (type.equals("application/x-jrplex-slideshow")) {
            JSONArray rawPhotos = item.optJSONArray("photos");
            if (!url.equals(server + "/cast/media/" + id + "/slideshow") || rawPhotos == null || rawPhotos.length() < 1 || rawPhotos.length() > 100) throw new IllegalArgumentException("La presentación no contiene fotografías válidas.");
            ArrayList<Photo> photos = new ArrayList<>();
            for (int index = 0; index < rawPhotos.length(); index++) {
                JSONObject photo = rawPhotos.getJSONObject(index); String photoUrl = photo.getString("url"); URI photoUri;
                try { photoUri = URI.create(photoUrl); } catch (IllegalArgumentException error) { throw new IllegalArgumentException("La fuente de fotografía no es válida."); }
                String expected = "/cast/media/" + id + "/photo/[A-Za-z0-9_-]{1,128}";
                if (photoUri.getRawUserInfo() != null || photoUri.getRawQuery() != null || photoUri.getRawFragment() != null
                        || !origin(photoUri.getScheme() + "://" + photoUri.getRawAuthority()).equals(server) || !photoUri.getRawPath().matches(expected)) throw new IllegalArgumentException("La presentación contiene una fotografía de otro servidor.");
                photos.add(new Photo(photoUrl, photo.optString("name", "Fotografía")));
            }
            return new Media(id, url, type, item.optString("title", "Presentación"), false, 0, photos);
        }
        if (!url.startsWith(server + "/cast/media/" + id + "/")
                || !(type.equals("video/mp4") || type.equals("video/webm") || type.equals("audio/mpeg")
                || type.equals("application/vnd.apple.mpegurl") || type.equals("application/x-mpegurl")))
            throw new IllegalArgumentException("La fuente recibida no pertenece a este servidor o no es compatible.");
        boolean seek = item.optBoolean("canSeek", false);
        double position = seconds(command.optDouble("position", 0));
        return new Media(id, url, type, item.optString("title", "JRPlex"), seek, seek ? (long) (position * 1000) : 0, null);
    }
    static final class Media {
        final String id, url, type, title; final boolean canSeek; final long position; final ArrayList<Photo> photos;
        Media(String id, String url, String type, String title, boolean canSeek, long position, ArrayList<Photo> photos) {
            this.id = id; this.url = url; this.type = type; this.title = title;
            this.canSeek = canSeek; this.position = position; this.photos = photos;
        }
    }
    static final class Photo { final String url, name; Photo(String url, String name) { this.url = url; this.name = name; } }
}
