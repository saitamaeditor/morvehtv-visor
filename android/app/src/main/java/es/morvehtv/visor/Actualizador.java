package es.morvehtv.visor;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Comprueba al abrir la app si hay un APK más nuevo publicado en GitHub (version.json junto a
 * MorvehTV.apk) y, si el usuario quiere, lo descarga y lo instala encima con PackageInstaller.
 * Android siempre pide confirmar la instalación; la primera vez, además, hay que permitir que
 * MorvehTV instale apps.
 */
class Actualizador {

    static final String ACCION_RESULTADO = "es.morvehtv.visor.RESULTADO_INSTALACION";
    private static final String BASE = "https://github.com/saitamaeditor/morvehtv-visor/releases/latest/download/";
    // Si dices «Ahora no», no vuelve a preguntar por esa versión hasta el día siguiente
    private static final long ESPERA_TRAS_NO = 24L * 3600 * 1000;

    private final Activity actividad;
    private final SharedPreferences prefs;
    private AlertDialog progreso;
    private int versionPendiente = 0;
    private boolean esperandoPermiso = false;

    Actualizador(Activity actividad) {
        this.actividad = actividad;
        this.prefs = actividad.getSharedPreferences("actualizaciones", Activity.MODE_PRIVATE);
    }

    /** En segundo plano: mira la versión publicada y pregunta si es más nueva que la instalada. */
    void comprobar() {
        new Thread(() -> {
            try {
                JSONObject v = new JSONObject(new String(leer(BASE + "version.json"), "UTF-8"));
                int nueva = v.getInt("versionCode");
                String nombre = v.optString("versionName", String.valueOf(nueva));
                if (nueva <= BuildConfig.VERSION_CODE) return;
                long rechazada = prefs.getLong("no-" + nueva, 0);
                if (System.currentTimeMillis() - rechazada < ESPERA_TRAS_NO) return;
                actividad.runOnUiThread(() -> preguntar(nueva, nombre));
            } catch (Exception ignorada) {
                // Sin internet o sin versión publicada: se vuelve a mirar la próxima vez
            }
        }).start();
    }

    private void preguntar(int nueva, String nombre) {
        if (actividad.isFinishing()) return;
        new AlertDialog.Builder(actividad)
                .setTitle("Nueva versión de MorvehTV")
                .setMessage("Hay una actualización (" + nombre + "). Tienes la " + BuildConfig.VERSION_NAME + ".\n¿Quieres instalarla ahora?")
                .setPositiveButton("Actualizar", (d, w) -> empezar(nueva))
                .setNegativeButton("Ahora no", (d, w) -> prefs.edit().putLong("no-" + nueva, System.currentTimeMillis()).apply())
                .show();
    }

    private void empezar(int nueva) {
        versionPendiente = nueva;
        // Android 8+: la primera vez hay que permitir que MorvehTV instale apps
        if (Build.VERSION.SDK_INT >= 26 && !actividad.getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(actividad)
                    .setTitle("Un permiso más")
                    .setMessage("Para actualizarse, MorvehTV necesita permiso para instalar apps. Actívalo en la pantalla que se abre y vuelve atrás.")
                    .setPositiveButton("Abrir ajustes", (d, w) -> abrirPermiso())
                    .setNegativeButton("Cancelar", null)
                    .show();
            return;
        }
        descargar();
    }

    private void abrirPermiso() {
        esperandoPermiso = true;
        try {
            actividad.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + actividad.getPackageName())));
        } catch (ActivityNotFoundException e) {
            // Algunas teles no tienen esa pantalla: se explica dónde está
            esperandoPermiso = false;
            new AlertDialog.Builder(actividad)
                    .setTitle("Un permiso más")
                    .setMessage("Ve a Ajustes → Apps → Seguridad → «Orígenes desconocidos» y activa MorvehTV. Después vuelve a abrir la app.")
                    .setPositiveButton("Vale", null)
                    .show();
        }
    }

    /** Al volver de los ajustes: si ya se dio el permiso, sigue con la descarga. */
    void alVolver() {
        if (!esperandoPermiso) return;
        esperandoPermiso = false;
        if (Build.VERSION.SDK_INT < 26 || actividad.getPackageManager().canRequestPackageInstalls()) descargar();
    }

    private void descargar() {
        progreso = new AlertDialog.Builder(actividad)
                .setTitle("Actualizando MorvehTV")
                .setMessage("Descargando… 0 %")
                .setCancelable(false)
                .show();
        new Thread(() -> {
            try {
                instalar();
            } catch (Exception e) {
                actividad.runOnUiThread(() -> {
                    cerrarProgreso();
                    Toast.makeText(actividad, "No se pudo descargar la actualización", Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    // Descarga el APK directamente dentro de una sesión de instalación de Android
    private void instalar() throws Exception {
        HttpURLConnection c = abrir(BASE + "MorvehTV.apk");
        long total = c.getContentLengthLong();
        PackageInstaller instalador = actividad.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(actividad.getPackageName());
        int id = instalador.createSession(params);
        try (PackageInstaller.Session sesion = instalador.openSession(id)) {
            try (InputStream in = c.getInputStream(); OutputStream out = sesion.openWrite("MorvehTV.apk", 0, total)) {
                byte[] trozo = new byte[64 * 1024];
                long leidos = 0;
                int n, ultimo = -1;
                while ((n = in.read(trozo)) > 0) {
                    out.write(trozo, 0, n);
                    leidos += n;
                    int pct = total > 0 ? (int) (leidos * 100 / total) : 0;
                    if (pct != ultimo) {
                        ultimo = pct;
                        actividad.runOnUiThread(() -> { if (progreso != null) progreso.setMessage("Descargando… " + pct + " %"); });
                    }
                }
                sesion.fsync(out);
            } finally {
                c.disconnect();
            }
            Intent aviso = new Intent(actividad, MainActivity.class).setAction(ACCION_RESULTADO);
            int banderas = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pi = PendingIntent.getActivity(actividad, versionPendiente, aviso, banderas);
            sesion.commit(pi.getIntentSender());
        }
        actividad.runOnUiThread(() -> { if (progreso != null) progreso.setMessage("Instalando…"); });
    }

    /** Android contesta aquí: pide confirmación al usuario o informa del resultado. */
    @SuppressWarnings("deprecation")
    void resultado(Intent intent) {
        int estado = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (estado == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmar = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirmar != null) actividad.startActivity(confirmar);
            return;
        }
        cerrarProgreso();
        if (estado != PackageInstaller.STATUS_SUCCESS) {
            Toast.makeText(actividad, "No se instaló la actualización", Toast.LENGTH_LONG).show();
        }
        // Si fue bien, Android cierra la app y la vuelve a abrir ya actualizada
    }

    private void cerrarProgreso() {
        if (progreso != null && progreso.isShowing()) progreso.dismiss();
        progreso = null;
    }

    private static HttpURLConnection abrir(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true); // GitHub redirige las descargas a su almacén
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "MorvehTV/" + BuildConfig.VERSION_NAME);
        if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
        return c;
    }

    private static byte[] leer(String url) throws Exception {
        HttpURLConnection c = abrir(url + "?t=" + System.currentTimeMillis());
        try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) out.write(b, 0, n);
            return out.toByteArray();
        } finally {
            c.disconnect();
        }
    }
}
