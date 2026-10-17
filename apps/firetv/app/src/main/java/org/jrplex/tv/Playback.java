package org.jrplex.tv;

import android.app.Activity;
import android.view.View;
import android.view.ViewGroup;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.ui.PlayerView;

interface Playback {
    void load(ReceiverProtocol.Media media);
    void pause(); void resume(); void seek(long position); void clear(); void release();
    long position(); long duration(); boolean paused(); String status();
    void focus();

    @UnstableApi
    final class Native implements Playback {
        private final PlayerView view;
        private final ExoPlayer player;
        private final MediaSession session;
        private boolean failed;
        private boolean canSeek;
        Native(Activity activity, ViewGroup parent, Runnable changed) {
            player = new ExoPlayer.Builder(activity).build();
            player.setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true);
            player.setHandleAudioBecomingNoisy(true);
            session = new MediaSession.Builder(activity, player).build();
            view = new PlayerView(activity); view.setPlayer(player);
            view.setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING);
            view.setControllerAutoShow(true); view.setKeepScreenOn(true);
            view.setFocusable(true); view.setVisibility(View.GONE);
            parent.addView(view, new ViewGroup.LayoutParams(-1, -1));
            player.addListener(new Player.Listener() {
                @Override public void onEvents(Player value, Player.Events events) { changed.run(); }
                @Override public void onPlayerError(PlaybackException error) { failed = true; changed.run(); }
            });
        }
        @Override public void load(ReceiverProtocol.Media media) {
            failed = false; canSeek = media.canSeek;
            view.setShowFastForwardButton(canSeek); view.setShowRewindButton(canSeek);
            view.setVisibility(View.VISIBLE);
            MediaItem item = new MediaItem.Builder().setUri(media.url).setMimeType(media.type)
                    .setMediaMetadata(new MediaMetadata.Builder().setTitle(media.title).build()).build();
            player.setMediaItem(item, media.position); player.prepare(); player.play(); focus();
        }
        @Override public void pause() { player.pause(); }
        @Override public void resume() { if (failed) { failed = false; player.prepare(); } player.play(); }
        @Override public void seek(long position) { if (canSeek && player.isCurrentMediaItemSeekable()) player.seekTo(Math.max(0, Math.min(position, duration() > 0 ? duration() - 1 : position))); }
        @Override public void clear() { player.stop(); player.clearMediaItems(); view.setVisibility(View.GONE); failed = false; }
        @Override public void release() { view.setPlayer(null); session.release(); player.release(); }
        @Override public long position() { return Math.max(0, player.getCurrentPosition()); }
        @Override public long duration() { return Math.max(0, player.getDuration()); }
        @Override public boolean paused() { return !player.getPlayWhenReady(); }
        @Override public String status() {
            if (failed) return "error";
            if (player.getPlaybackState() == Player.STATE_ENDED) return "ended";
            if (player.isPlaying()) return "playing";
            if (player.getPlaybackState() == Player.STATE_BUFFERING || player.getPlaybackState() == Player.STATE_IDLE) return "buffering";
            return "paused";
        }
        @Override public void focus() { view.requestFocus(); view.showController(); }
    }
}
