package org.jrplex.tv;

import android.graphics.Bitmap;
import android.graphics.Color;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;
import com.google.zxing.common.BitMatrix;
import java.util.HashMap;

final class QrCode {
    static Bitmap create(String server, String verificationUrl) throws Exception {
        String prefix = server + "/activate#code=";
        if (!verificationUrl.startsWith(prefix) || !verificationUrl.substring(prefix.length()).matches("[A-HJ-NP-Z2-9]{8}")) throw new IllegalArgumentException("El enlace QR no pertenece a este servidor.");
        HashMap<EncodeHintType, Object> hints = new HashMap<>(); hints.put(EncodeHintType.MARGIN, 4); hints.put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M);
        BitMatrix matrix = new QRCodeWriter().encode(verificationUrl, BarcodeFormat.QR_CODE, 512, 512, hints);
        int[] pixels = new int[512 * 512]; for (int y = 0; y < 512; y++) for (int x = 0; x < 512; x++) pixels[y * 512 + x] = matrix.get(x, y) ? Color.BLACK : Color.WHITE;
        return Bitmap.createBitmap(pixels, 512, 512, Bitmap.Config.ARGB_8888);
    }
}
