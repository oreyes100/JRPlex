package org.jrplex.tv;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

interface AccountStore {
    String read(String server) throws Exception;
    void save(String server, String token) throws Exception;
    void clear();
    static byte[] encrypt(SecretKey key, String server, String token) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key); cipher.updateAAD(server.getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8)); byte[] bytes = new byte[12 + encrypted.length]; System.arraycopy(cipher.getIV(), 0, bytes, 0, 12); System.arraycopy(encrypted, 0, bytes, 12, encrypted.length); return bytes;
    }
    static String decrypt(SecretKey key, String server, byte[] bytes) throws Exception {
        if (bytes.length < 29) throw new IllegalArgumentException("Acceso cifrado no válido.");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, bytes, 0, 12)); cipher.updateAAD(server.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(bytes, 12, bytes.length - 12), StandardCharsets.UTF_8);
    }
    final class Encrypted implements AccountStore {
        private static final String ALIAS = "jrplex-tv-account-v2";
        private final android.content.SharedPreferences preferences;
        Encrypted(Context context) { preferences = context.getSharedPreferences("tv-account", Context.MODE_PRIVATE); }
        private SecretKey key() throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
            if (!store.containsAlias(ALIAS)) {
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build()); generator.generateKey();
            }
            return (SecretKey) store.getKey(ALIAS, null);
        }
        @Override public String read(String server) throws Exception {
            String saved = preferences.getString("credential", null); if (saved == null) return null;
            byte[] bytes = Base64.decode(saved, Base64.NO_WRAP);
            String token = AccountStore.decrypt(key(), server, bytes);
            if (!token.matches("[A-Za-z0-9_-]{43}")) throw new IllegalArgumentException("Acceso guardado no válido."); return token;
        }
        @Override public void save(String server, String token) throws Exception {
            if (!token.matches("[A-Za-z0-9_-]{43}")) throw new IllegalArgumentException("Acceso no válido.");
            byte[] bytes = AccountStore.encrypt(key(), server, token);
            if (!preferences.edit().putString("credential", Base64.encodeToString(bytes, Base64.NO_WRAP)).commit()) throw new java.io.IOException("No se pudo guardar el acceso de la TV.");
        }
        @Override public void clear() { preferences.edit().remove("credential").apply(); }
    }
}
