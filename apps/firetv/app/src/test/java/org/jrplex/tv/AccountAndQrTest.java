package org.jrplex.tv;

import android.graphics.Bitmap;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.common.HybridBinarizer;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk={23,28},manifest=Config.NONE)
public class AccountAndQrTest {
    @Test public void generatedQrDecodesToSameOriginLinkAndContainsNoCredential()throws Exception{
        String origin=ReceiverProtocol.DEFAULT_SERVER,url=origin+"/activate#code=ABCDEFGH";Bitmap bitmap=QrCode.create(origin,url);
        int[] pixels=new int[512*512];bitmap.getPixels(pixels,0,512,0,0,512,512);
        String decoded=new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(512,512,pixels)))).getText();assertEquals(url,decoded);
        assertFalse(decoded.contains("token"));assertFalse(decoded.contains("secret"));assertThrows(IllegalArgumentException.class,()->QrCode.create(origin,"https://evil.invalid/activate#code=ABCDEFGH"));
    }
    @Test public void encryptedCredentialAuthenticatesServerAndRejectsTampering()throws Exception{
        var key=new SecretKeySpec(new byte[32],"AES");String token="t".repeat(43);byte[] encrypted=AccountStore.encrypt(key,ReceiverProtocol.DEFAULT_SERVER,token);
        assertFalse(new String(encrypted,StandardCharsets.ISO_8859_1).contains(token));assertEquals(token,AccountStore.decrypt(key,ReceiverProtocol.DEFAULT_SERVER,encrypted));
        assertThrows(Exception.class,()->AccountStore.decrypt(key,"https://other.invalid",encrypted));encrypted[20]^=1;assertThrows(Exception.class,()->AccountStore.decrypt(key,ReceiverProtocol.DEFAULT_SERVER,encrypted));
    }
}
