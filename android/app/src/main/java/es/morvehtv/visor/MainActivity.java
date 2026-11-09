package es.morvehtv.visor;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * MorvehTV: tu servidor de Emby (emby.morvehtv.com) a pantalla completa, para móvil y Android TV.
 * La web de Emby hace todo (entrar, bibliotecas, fichas, reproductor); aquí solo se añade lo que una
 * web no puede: vídeo a pantalla completa y en horizontal, botón Atrás del sistema y del mando,
 * teclas multimedia del mando, pantalla encendida mientras se ve algo y actualizarse sola.
 */
public class MainActivity extends Activity {

    private WebView web;
    private View carga;
    private TextView mensaje;
    private Button reintentar;
    private FrameLayout raiz;
    private View vistaCompleta;
    private WebChromeClient.CustomViewCallback alSalirCompleta;
    private boolean cargada = false;
    private final Cromo cromo = new Cromo();
    private Actualizador actualizador;
    private boolean actualizacionMirada = false;
    private final Handler hilo = new Handler(Looper.getMainLooper());
    private static final long TIEMPO_MAXIMO = 45_000;
    private final Runnable agotado = () -> { if (!cargada) error("El servidor no responde (tiempo agotado)."); };

    // Se mete en cada página de Emby: avisa a la app cuando un vídeo empieza o para (pantalla
    // encendida solo mientras se ve algo)
    private static final String VIGIA_VIDEO =
        "(function(){if(window.__morveh)return;window.__morveh=1;" +
        "var a=function(){var v=[].slice.call(document.querySelectorAll('video,audio')).some(function(m){return !m.paused&&!m.ended});" +
        "try{MorvehApp.pantalla(v)}catch(e){}};" +
        "['play','playing','pause','ended','emptied'].forEach(function(t){document.addEventListener(t,a,true)});})();";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle guardado) {
        super.onCreate(guardado);
        setContentView(R.layout.principal);
        raiz = findViewById(R.id.raiz);
        web = findViewById(R.id.web);
        carga = findViewById(R.id.carga);
        mensaje = findViewById(R.id.mensaje);
        reintentar = findViewById(R.id.reintentar);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);

        WebSettings ajustes = web.getSettings();
        ajustes.setJavaScriptEnabled(true);
        ajustes.setDomStorageEnabled(true); // Emby guarda aquí la sesión: se entra una sola vez
        ajustes.setDatabaseEnabled(true);
        ajustes.setMediaPlaybackRequiresUserGesture(false);
        ajustes.setJavaScriptCanOpenWindowsAutomatically(false);
        ajustes.setSupportMultipleWindows(true);
        ajustes.setLoadWithOverviewMode(true);
        ajustes.setUseWideViewPort(true);
        float escala = getResources().getConfiguration().fontScale;
        ajustes.setTextZoom(Math.round(Math.max(0.85f, Math.min(escala, 1.15f)) * 100));
        // OJO: la web de Emby se pone en «modo tele» si el nombre del navegador lleva «tv». Por eso
        // la marca de la app NO lleva «TV» y solo la tele añade «Android TV»
        ajustes.setUserAgentString(ajustes.getUserAgentString() + " Morveh-App" + (esTele() ? " Android TV" : ""));

        CookieManager.getInstance().setAcceptCookie(true);

        web.setBackgroundColor(Color.BLACK);
        web.addJavascriptInterface(new Puente(), "MorvehApp");
        web.setWebViewClient(new Cliente());
        web.setWebChromeClient(cromo);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        if (android.os.Build.VERSION.SDK_INT >= 26) web.setDefaultFocusHighlightEnabled(false);

        reintentar.setOnClickListener(v -> {
            String url = web.getUrl();
            if (url != null && esNuestra(Uri.parse(url))) { prepararCarga(); web.reload(); }
            else abrir();
        });

        // Android 15 dibuja la app por debajo de las barras del sistema: se deja su hueco (salvo viendo un vídeo)
        raiz.setOnApplyWindowInsetsListener((v, insets) -> {
            int arriba, abajo, izq, der;
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets b = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                arriba = b.top; abajo = b.bottom; izq = b.left; der = b.right;
            } else {
                arriba = insets.getSystemWindowInsetTop(); abajo = insets.getSystemWindowInsetBottom();
                izq = insets.getSystemWindowInsetLeft(); der = insets.getSystemWindowInsetRight();
            }
            if (vistaCompleta != null) v.setPadding(0, 0, 0, 0);
            else v.setPadding(izq, arriba, der, abajo);
            return insets;
        });
        actualizador = new Actualizador(this);

        if (guardado != null) web.restoreState(guardado);
        else abrir();
    }

    private boolean esTele() {
        UiModeManager modo = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
        return modo != null && modo.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
    }

    private void abrir() {
        prepararCarga();
        web.loadUrl(BuildConfig.SERVIDOR);
    }

    private void prepararCarga() {
        cargada = false;
        hilo.removeCallbacksAndMessages(null);
        carga.setVisibility(View.VISIBLE);
        reintentar.setVisibility(View.GONE);
        mensaje.setText("Conectando…");
        hilo.postDelayed(agotado, TIEMPO_MAXIMO);
    }

    private void error(String motivo) {
        cargada = false;
        hilo.removeCallbacks(agotado);
        web.stopLoading();
        carga.setVisibility(View.VISIBLE);
        mensaje.setText(motivo + "\nComprueba la conexión a internet y vuelve a intentarlo.");
        reintentar.setVisibility(View.VISIBLE);
        reintentar.requestFocus();
    }

    // Tu Emby (la dirección compilada en BuildConfig.SERVIDOR)
    private static boolean esNuestra(Uri u) {
        Uri casa = Uri.parse(BuildConfig.SERVIDOR);
        return u.getHost() != null && u.getHost().equalsIgnoreCase(casa.getHost());
    }

    private void mostrarWeb() {
        if (reintentar.getVisibility() == View.VISIBLE) return;
        carga.setVisibility(View.GONE);
    }

    private class Cliente extends WebViewClient {
        @Override
        public void onPageCommitVisible(WebView vista, String url) {
            mostrarWeb();
        }

        @Override
        public void onPageFinished(WebView vista, String url) {
            if (reintentar.getVisibility() == View.VISIBLE) return;
            cargada = true;
            hilo.removeCallbacks(agotado);
            mostrarWeb();
            web.evaluateJavascript(VIGIA_VIDEO, null);
            web.requestFocus();
            CookieManager.getInstance().flush();
            // Una vez por apertura, cuando ya se ve la app: ¿hay un APK más nuevo?
            if (!actualizacionMirada) {
                actualizacionMirada = true;
                actualizador.comprobar();
            }
        }

        @Override
        public void onReceivedError(WebView vista, WebResourceRequest pedido, WebResourceError fallo) {
            if (pedido.isForMainFrame()) error("No se pudo conectar con MorvehTV.");
        }

        @Override
        public void onReceivedHttpError(WebView vista, WebResourceRequest pedido, WebResourceResponse respuesta) {
            if (pedido.isForMainFrame() && respuesta.getStatusCode() >= 500) error("El servidor respondió con un error (HTTP " + respuesta.getStatusCode() + ").");
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView vista, WebResourceRequest pedido) {
            if (!pedido.isForMainFrame()) return false;
            Uri u = pedido.getUrl();
            String esquema = u.getScheme();
            if (!"http".equals(esquema) && !"https".equals(esquema)) return true; // intent:, market:…
            if (esNuestra(u)) return false;
            // Otros sitios (tráiler, IMDb, TMDB…): si los abres tú, en el navegador del aparato
            if (pedido.hasGesture()) {
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* sin navegador (tele) */ }
            }
            return true;
        }
    }

    // Vídeo a pantalla completa (el botón de pantalla completa del reproductor de Emby)
    private class Cromo extends WebChromeClient {
        // Ventanas nuevas (enlaces externos con target="_blank"): al navegador del aparato
        @Override
        public boolean onCreateWindow(WebView vista, boolean dialogo, boolean gesto, Message resultado) {
            if (!gesto || dialogo) return false;
            WebView provisional = new WebView(MainActivity.this);
            provisional.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest pedido) {
                    Uri u = pedido.getUrl();
                    if (esNuestra(u)) web.loadUrl(u.toString());
                    else try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* nada */ }
                    hilo.post(v::destroy);
                    return true;
                }
            });
            ((WebView.WebViewTransport) resultado.obj).setWebView(provisional);
            resultado.sendToTarget();
            return true;
        }

        @Override
        public void onShowCustomView(View vista, CustomViewCallback alSalir) {
            if (vistaCompleta != null) { alSalir.onCustomViewHidden(); return; }
            vistaCompleta = vista;
            alSalirCompleta = alSalir;
            raiz.addView(vista, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
            ocultarBarras(true);
            raiz.setPadding(0, 0, 0, 0);
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                getWindow().setAttributes(lp);
            }
            // En el móvil, el vídeo a pantalla completa se ve en horizontal (gira según cómo lo cojas)
            if (!esTele()) setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        }

        @Override
        public void onHideCustomView() {
            if (vistaCompleta == null) return;
            raiz.removeView(vistaCompleta);
            vistaCompleta = null;
            web.setVisibility(View.VISIBLE);
            ocultarBarras(false);
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
                getWindow().setAttributes(lp);
            }
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            raiz.requestApplyInsets();
            if (alSalirCompleta != null) alSalirCompleta.onCustomViewHidden();
            alSalirCompleta = null;
            web.requestFocus();
        }
    }

    @SuppressWarnings("deprecation")
    private void ocultarBarras(boolean ocultar) {
        getWindow().getDecorView().setSystemUiVisibility(ocultar
                ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                : View.SYSTEM_UI_FLAG_VISIBLE);
    }

    // Lo que la página puede pedir a la app
    private class Puente {
        @JavascriptInterface
        public void pantalla(boolean encendida) {
            runOnUiThread(() -> {
                if (encendida) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }
    }

    // Atrás (móvil o mando): primero sale de la pantalla completa; luego vuelve atrás dentro de
    // Emby; en la pantalla de inicio pregunta antes de cerrar la app
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (vistaCompleta != null) { cromo.onHideCustomView(); return; }
        if (!cargada) { super.onBackPressed(); return; }
        if (web.canGoBack()) { web.goBack(); return; }
        new android.app.AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("Salir de MorvehTV")
                .setMessage("¿Quieres cerrar la app?")
                .setPositiveButton("Salir", (d, w) -> finishAndRemoveTask())
                .setNegativeButton("Cancelar", null)
                .show();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        // Algunas teles mandan «Atrás» como tecla y no llaman a onBackPressed
        if (e.getKeyCode() == KeyEvent.KEYCODE_BACK || e.getKeyCode() == KeyEvent.KEYCODE_BUTTON_B) {
            if (e.getAction() == KeyEvent.ACTION_UP) onBackPressed();
            return true;
        }
        // Teclas multimedia del mando (▶❚❚, ⏩, ⏪…): algunas teles se las quedan para el sistema y la
        // web no las recibe. Se le pasan con el nombre que usaría un navegador; el reproductor de
        // Emby las entiende
        String nombre = teclaMultimedia(e.getKeyCode());
        if (nombre != null && cargada) {
            if (e.getAction() == KeyEvent.ACTION_DOWN) {
                web.evaluateJavascript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'" + nombre + "',bubbles:true,cancelable:true}))", null);
            }
            return true;
        }
        // El botón central de algunos mandos (y el «A» de los mandos de juegos) es OK
        if (e.getKeyCode() == KeyEvent.KEYCODE_BUTTON_A || e.getKeyCode() == KeyEvent.KEYCODE_NUMPAD_ENTER) {
            return super.dispatchKeyEvent(new KeyEvent(e.getDownTime(), e.getEventTime(), e.getAction(), KeyEvent.KEYCODE_ENTER,
                    e.getRepeatCount(), e.getMetaState(), e.getDeviceId(), e.getScanCode(), e.getFlags(), e.getSource()));
        }
        return super.dispatchKeyEvent(e);
    }

    private static String teclaMultimedia(int codigo) {
        switch (codigo) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK: return "MediaPlayPause";
            case KeyEvent.KEYCODE_MEDIA_PLAY: return "MediaPlay";
            case KeyEvent.KEYCODE_MEDIA_PAUSE: return "MediaPause";
            case KeyEvent.KEYCODE_MEDIA_STOP: return "MediaStop";
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: return "MediaFastForward";
            case KeyEvent.KEYCODE_MEDIA_REWIND: return "MediaRewind";
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD: return "MediaTrackNext";
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD: return "MediaTrackPrevious";
            default: return null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle estado) {
        super.onSaveInstanceState(estado);
        web.saveState(estado);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        actualizador.alVolver();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (Actualizador.ACCION_RESULTADO.equals(intent.getAction())) actualizador.resultado(intent);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Al salir de la app (inicio, otra app, apagar la pantalla) el vídeo se para
        web.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        hilo.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }
}
