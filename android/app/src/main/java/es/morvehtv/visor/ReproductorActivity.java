package es.morvehtv.visor;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.ProgressBar;
import android.widget.SeekBar;
import android.widget.TextView;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Reproductor nativo de MorvehTV con ExoPlayer (Media3), para móvil y Android TV.
 *
 * Dos formas de reproducir, según lo que la web ve en el archivo:
 *  · «directo»: el vídeo se lee tal cual de e2 (MP4, MKV, TS… con audio que el aparato sabe
 *    reproducir). Saltos e idiomas los hace ExoPlayer.
 *  · «servidor»: el servidor lo convierte al vuelo en HLS (audio AC3/DTS, vídeo no H.264…). Cada
 *    sesión empieza en un segundo («desde»); saltar lejos o cambiar de idioma pide otra.
 *
 * Controles como en la web: no arranca solo, botones a la izquierda (idioma, ▶, ⟲10, 10⟳, ⛶) y
 * luego la barra; todo se esconde solo a los 3 s viendo el vídeo. Con el mando: OK pausa, ← →
 * mueven 10 s con los controles escondidos, ↓ enseña los botones y ahí ← → pasan de uno a otro.
 */
@OptIn(markerClass = UnstableApi.class)
public class ReproductorActivity extends Activity {

    private static final long OCULTAR_MS = 3000;

    private ExoPlayer player;
    private PlayerView vista;
    private View arriba, controles;
    private ImageButton bGrande, bPlay, bSalir;
    private Button bAudio, bAtras, bAdelante, bVolver;
    private ProgressBar cargando;
    private SeekBar barra;
    private TextView tiempo, titulo, mensaje;
    private final Handler hilo = new Handler(Looper.getMainLooper());

    // Lo que manda la web
    private String key, url, modo;
    private double duracion;
    private JSONArray audios;
    private boolean directo;

    // Modo «servidor»
    private int audio = 0;
    private String sesion;
    private double desde = 0;
    private int turno = 0;
    private String cookie;

    private boolean arrastrando = false;
    private boolean visibles = true;

    @Override
    protected void onCreate(Bundle guardado) {
        super.onCreate(guardado);
        setContentView(R.layout.reproductor);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        pantallaCompleta();

        vista = findViewById(R.id.vista);
        arriba = findViewById(R.id.arriba);
        controles = findViewById(R.id.controles);
        bGrande = findViewById(R.id.grande);
        bAudio = findViewById(R.id.audio);
        bPlay = findViewById(R.id.play);
        bAtras = findViewById(R.id.atras);
        bAdelante = findViewById(R.id.adelante);
        bSalir = findViewById(R.id.salir);
        bVolver = findViewById(R.id.volver);
        cargando = findViewById(R.id.cargando);
        barra = findViewById(R.id.barra);
        tiempo = findViewById(R.id.tiempo);
        titulo = findViewById(R.id.titulo);
        mensaje = findViewById(R.id.mensaje);

        try {
            JSONObject d = new JSONObject(getIntent().getStringExtra("datos"));
            key = d.getString("key");
            url = d.optString("url", null);
            modo = d.optString("modo", "servidor");
            duracion = d.optDouble("duracion", 0);
            audios = d.optJSONArray("audios");
            titulo.setText(d.optString("titulo", ""));
        } catch (Exception e) {
            finish();
            return;
        }
        if (audios == null) audios = new JSONArray();
        directo = "directo".equals(modo) && url != null;
        cookie = CookieManager.getInstance().getCookie(BuildConfig.SERVIDOR);

        // Las peticiones al servidor (HLS) llevan la cookie de la sesión de la app
        Map<String, String> cabeceras = new HashMap<>();
        if (cookie != null) cabeceras.put("Cookie", cookie);
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent("MorvehTV/" + BuildConfig.VERSION_NAME)
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(30000)
                .setDefaultRequestProperties(cabeceras);
        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(http))
                .setSeekBackIncrementMs(10000)
                .setSeekForwardIncrementMs(10000)
                .build();
        vista.setPlayer(player);
        vista.setUseController(false);
        vista.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        vista.setShutterBackgroundColor(Color.BLACK);
        vista.setKeepContentOnPlayerReset(true);
        player.addListener(new Escucha());

        bGrande.setOnClickListener(v -> alternar());
        bPlay.setOnClickListener(v -> alternar());
        bAtras.setOnClickListener(v -> saltar(-10));
        bAdelante.setOnClickListener(v -> saltar(10));
        bSalir.setOnClickListener(v -> finish());
        bVolver.setOnClickListener(v -> finish());
        bAudio.setOnClickListener(v -> elegirAudio());
        bAudio.setVisibility(audios.length() > 1 ? View.VISIBLE : View.GONE);
        pintarAudio();

        barra.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s, int p, boolean deUsuario) {
                if (deUsuario) pintarTiempo(p);
            }
            @Override public void onStartTrackingTouch(SeekBar s) { arrastrando = true; mostrar(); }
            @Override public void onStopTrackingTouch(SeekBar s) { arrastrando = false; ir(s.getProgress(), player.getPlayWhenReady()); mostrar(); }
        });
        // Tocar la imagen enseña u oculta los controles (no pausa)
        findViewById(R.id.raiz).setOnClickListener(v -> { if (visibles) ocultar(); else mostrar(); });

        // No arranca solo: se prepara y espera a ▶
        if (directo) {
            player.setMediaItem(MediaItem.fromUri(url));
            player.prepare();
            player.setPlayWhenReady(false);
        } else {
            ir(0, false);
        }
        hilo.post(reloj);
        mostrar();
        bGrande.requestFocus();
    }

    // ---------- Tiempo ----------
    private double ahora() {
        double pos = Math.max(0, player.getCurrentPosition()) / 1000.0;
        return directo ? pos : desde + pos;
    }

    private double total() {
        if (duracion > 0) return duracion;
        long d = player.getDuration();
        return d == C.TIME_UNSET ? 0 : d / 1000.0;
    }

    private final Runnable reloj = new Runnable() {
        @Override public void run() {
            if (!arrastrando && player != null) {
                barra.setMax((int) Math.max(1, total()));
                barra.setProgress((int) ahora());
                pintarTiempo(ahora());
            }
            hilo.postDelayed(this, 500);
        }
    };

    private void pintarTiempo(double t) {
        tiempo.setText(hms(t) + " / " + hms(total()));
    }

    private static String hms(double s) {
        int x = (int) Math.max(0, s);
        int h = x / 3600, m = (x % 3600) / 60, seg = x % 60;
        return h > 0 ? String.format(Locale.ROOT, "%d:%02d:%02d", h, m, seg) : String.format(Locale.ROOT, "%d:%02d", m, seg);
    }

    // ---------- Reproducir, pausar, saltar ----------
    private void alternar() {
        if (player.getPlayWhenReady()) player.pause();
        else if (player.getPlaybackState() == Player.STATE_ENDED) ir(0, true);
        else if (player.getPlaybackState() == Player.STATE_IDLE && player.getMediaItemCount() > 0) {
            // Tras un error: se vuelve a intentar desde el mismo punto
            mensaje.setVisibility(View.GONE);
            if (directo) { player.prepare(); player.play(); }
            else retomarYReproducir();
        } else player.play();
        pintarPlay();
        mostrar();
    }

    private void retomarYReproducir() {
        player.setPlayWhenReady(true);
        retomar();
    }

    private void saltar(double s) {
        ir(ahora() + s, player.getPlayWhenReady());
        mostrar();
    }

    // Lo ya preparado de la sesión HLS actual (en segundos desde «desde»)
    private double preparado() {
        long d = player.getDuration();
        return d == C.TIME_UNSET ? 0 : d / 1000.0;
    }

    private void ir(double t, boolean reproducir) {
        double fin = total();
        t = Math.max(0, fin > 5 ? Math.min(t, fin - 5) : t);
        if (directo) {
            player.seekTo((long) (t * 1000));
            return;
        }
        // Dentro de lo ya preparado: salto inmediato
        if (sesion != null && t >= desde && t - desde < preparado() - 2) {
            player.seekTo((long) ((t - desde) * 1000));
            return;
        }
        // Más lejos: el servidor prepara otra sesión empezando 20 s antes (así retroceder un poco
        // también es inmediato)
        final double objetivo = t;
        final int mio = ++turno;
        final int antes = (int) Math.min(20, Math.floor(t));
        final int inicio = (int) Math.floor(t) - antes;
        cargando.setVisibility(View.VISIBLE);
        mensaje.setVisibility(View.GONE);
        barra.setProgress((int) t);
        pintarTiempo(t);
        new Thread(() -> {
            try {
                JSONObject r = new JSONObject(pedir("api/hls?key=" + URLEncoder.encode(key, "UTF-8")
                        + "&desde=" + inicio + "&margen=" + antes + "&audio=" + audio));
                runOnUiThread(() -> {
                    if (mio != turno || isFinishing()) { parar(r.optString("id")); return; }
                    parar(sesion);
                    sesion = r.optString("id");
                    desde = r.optDouble("desde", inicio);
                    String ruta = r.optString("url").replaceFirst("^/", "");
                    // Lista HLS que va creciendo: sin acelerar para «alcanzar el directo»
                    MediaItem item = new MediaItem.Builder()
                            .setUri(BuildConfig.SERVIDOR + ruta)
                            .setMimeType(MimeTypes.APPLICATION_M3U8)
                            .setLiveConfiguration(new MediaItem.LiveConfiguration.Builder()
                                    .setMinPlaybackSpeed(1f).setMaxPlaybackSpeed(1f).build())
                            .build();
                    // Se conserva lo que haya pulsado el usuario mientras se preparaba (▶ o pausa);
                    // solo se fuerza a reproducir al seguir tras el final provisional de la lista
                    player.setMediaItem(item, (long) ((objetivo - desde) * 1000));
                    player.prepare();
                    if (reproducir) player.setPlayWhenReady(true);
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    if (mio != turno) return;
                    cargando.setVisibility(View.GONE);
                    avisar("No se pudo preparar el vídeo. Pulsa ▶ para reintentar.");
                });
            }
        }).start();
    }

    // Si la sesión del servidor se pierde (reinicio, corte), se prepara otra desde el mismo segundo
    private void retomar() {
        String vieja = sesion;
        sesion = null;
        parar(vieja);
        ir(ahora(), player.getPlayWhenReady());
    }

    private void parar(String id) {
        if (id == null || id.isEmpty()) return;
        new Thread(() -> {
            try { pedir("api/hls-parar?id=" + URLEncoder.encode(id, "UTF-8")); } catch (Exception ignorada) {}
        }).start();
    }

    private String pedir(String ruta) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(BuildConfig.SERVIDOR + ruta).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);
        if (cookie != null) c.setRequestProperty("Cookie", cookie);
        try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) out.write(b, 0, n);
            return out.toString("UTF-8");
        } finally {
            c.disconnect();
        }
    }

    // ---------- Idioma del audio ----------
    private void pintarAudio() {
        if (directo) {
            List<Tracks.Group> g = gruposAudio();
            bAudio.setVisibility(g.size() > 1 ? View.VISIBLE : View.GONE);
            for (Tracks.Group grupo : g) if (grupo.isSelected()) bAudio.setText(nombrePista(grupo.getTrackFormat(0), 0));
        } else if (audios.length() > 1) {
            bAudio.setText(nombrePista(audios.optJSONObject(audio), audio));
        }
    }

    private List<Tracks.Group> gruposAudio() {
        List<Tracks.Group> lista = new ArrayList<>();
        if (player == null) return lista;
        for (Tracks.Group g : player.getCurrentTracks().getGroups()) {
            if (g.getType() == C.TRACK_TYPE_AUDIO && g.isSupported()) lista.add(g);
        }
        return lista;
    }

    private static String nombrePista(Format f, int n) {
        String t = f.label != null ? f.label : f.language != null ? f.language : "Pista " + (n + 1);
        return t.toUpperCase(Locale.ROOT);
    }

    private static String nombrePista(JSONObject a, int n) {
        if (a == null) return "Pista " + (n + 1);
        String t = a.optString("titulo", "");
        if (t.isEmpty()) t = a.optString("idioma", "");
        if (t.isEmpty()) t = "Pista " + (n + 1);
        return t.toUpperCase(Locale.ROOT);
    }

    private void elegirAudio() {
        mostrar();
        if (directo) {
            List<Tracks.Group> g = gruposAudio();
            if (g.size() < 2) return;
            String[] nombres = new String[g.size()];
            int elegido = 0;
            for (int i = 0; i < g.size(); i++) {
                nombres[i] = nombrePista(g.get(i).getTrackFormat(0), i);
                if (g.get(i).isSelected()) elegido = i;
            }
            new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                    .setTitle("Idioma del audio")
                    .setSingleChoiceItems(nombres, elegido, (d, i) -> {
                        player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                                .setOverrideForType(new TrackSelectionOverride(g.get(i).getMediaTrackGroup(), 0))
                                .build());
                        d.dismiss();
                    })
                    .show();
        } else {
            if (audios.length() < 2) return;
            String[] nombres = new String[audios.length()];
            for (int i = 0; i < audios.length(); i++) nombres[i] = nombrePista(audios.optJSONObject(i), i);
            new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                    .setTitle("Idioma del audio")
                    .setSingleChoiceItems(nombres, audio, (d, i) -> {
                        d.dismiss();
                        if (i == audio) return;
                        audio = i;
                        pintarAudio();
                        // Otro idioma = otra sesión del servidor desde el mismo segundo
                        String vieja = sesion;
                        sesion = null;
                        parar(vieja);
                        ir(ahora(), player.getPlayWhenReady());
                    })
                    .show();
        }
    }

    // ---------- Mostrar y esconder los controles ----------
    private final Runnable ocultarLuego = this::ocultar;

    private void mostrar() {
        visibles = true;
        arriba.animate().alpha(1f).setDuration(200).start();
        controles.animate().alpha(1f).setDuration(200).start();
        arriba.setVisibility(View.VISIBLE);
        controles.setVisibility(View.VISIBLE);
        hilo.removeCallbacks(ocultarLuego);
        if (player != null && player.isPlaying()) hilo.postDelayed(ocultarLuego, OCULTAR_MS);
    }

    private void ocultar() {
        if (player == null || !player.isPlaying() || arrastrando) return;
        visibles = false;
        arriba.animate().alpha(0f).setDuration(300).withEndAction(() -> { if (!visibles) arriba.setVisibility(View.INVISIBLE); }).start();
        controles.animate().alpha(0f).setDuration(300).withEndAction(() -> { if (!visibles) controles.setVisibility(View.INVISIBLE); }).start();
        // Con los controles escondidos, el mando vuelve a mover el vídeo
        View foco = getCurrentFocus();
        if (foco != null) foco.clearFocus();
    }

    // ---------- Mando de la tele y teclado ----------
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (e.getAction() != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(e);
        int k = e.getKeyCode();
        switch (k) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_SPACE:
                alternar();
                return true;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                saltar(30);
                return true;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                saltar(-30);
                return true;
            case KeyEvent.KEYCODE_BACK:
                return super.dispatchKeyEvent(e);
        }
        if (!visibles) {
            switch (k) {
                case KeyEvent.KEYCODE_DPAD_LEFT:
                    saltar(-10);
                    return true;
                case KeyEvent.KEYCODE_DPAD_RIGHT:
                    saltar(10);
                    return true;
                case KeyEvent.KEYCODE_DPAD_CENTER:
                case KeyEvent.KEYCODE_ENTER:
                    alternar();
                    return true;
                case KeyEvent.KEYCODE_DPAD_UP:
                case KeyEvent.KEYCODE_DPAD_DOWN:
                    mostrar();
                    bPlay.requestFocus();
                    return true;
                default:
                    mostrar();
                    return super.dispatchKeyEvent(e);
            }
        }
        mostrar();
        return super.dispatchKeyEvent(e);
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent e) {
        if (e.getAction() == MotionEvent.ACTION_DOWN && visibles) {
            // Mientras se usan los controles no se esconden
            hilo.removeCallbacks(ocultarLuego);
            if (player != null && player.isPlaying()) hilo.postDelayed(ocultarLuego, OCULTAR_MS);
        }
        return super.dispatchTouchEvent(e);
    }

    // ---------- Estado del reproductor ----------
    private class Escucha implements Player.Listener {
        @Override public void onIsPlayingChanged(boolean reproduciendo) {
            pintarPlay();
            boolean enPausa = !player.getPlayWhenReady();
            bGrande.setVisibility(enPausa ? View.VISIBLE : View.GONE);
            if (reproduciendo) mostrar();
            else { hilo.removeCallbacks(ocultarLuego); mostrar(); }
        }

        @Override public void onPlayWhenReadyChanged(boolean playWhenReady, int razon) {
            bGrande.setVisibility(playWhenReady ? View.GONE : View.VISIBLE);
            pintarPlay();
        }

        @Override public void onPlaybackStateChanged(int estado) {
            cargando.setVisibility(estado == Player.STATE_BUFFERING ? View.VISIBLE : View.GONE);
            if (estado == Player.STATE_READY) mensaje.setVisibility(View.GONE);
            // La lista del servidor aún se está creando: al llegar a su final provisional se pide más
            if (estado == Player.STATE_ENDED && !directo && ahora() < total() - 10) ir(ahora(), true);
        }

        @Override public void onTracksChanged(Tracks t) {
            if (directo) pintarAudio();
        }

        @Override public void onPlayerError(PlaybackException error) {
            cargando.setVisibility(View.GONE);
            if (!directo) {
                retomar();
                return;
            }
            avisar("No se pudo reproducir este vídeo en este aparato.");
        }
    }

    // ▶ si está en pausa; pausa si va a reproducirse (aunque aún se esté preparando)
    private void pintarPlay() {
        bPlay.setImageResource(player != null && player.getPlayWhenReady() ? R.drawable.ic_pausa : R.drawable.ic_play);
    }

    private void avisar(String texto) {
        mensaje.setText(texto);
        mensaje.setVisibility(View.VISIBLE);
        mostrar();
    }

    // ---------- Pantalla completa ----------
    @SuppressWarnings("deprecation")
    private void pantallaCompleta() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    public void onWindowFocusChanged(boolean conFoco) {
        super.onWindowFocusChanged(conFoco);
        if (conFoco) pantallaCompleta();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (player != null) player.pause();
    }

    @Override
    protected void onDestroy() {
        hilo.removeCallbacksAndMessages(null);
        parar(sesion);
        if (player != null) player.release();
        player = null;
        super.onDestroy();
    }
}
