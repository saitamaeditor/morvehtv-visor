import AVFoundation
import UIKit

// Arranque de la app: el sonido de los vídeos suena aunque el iPhone esté en silencio (como en
// cualquier app de vídeo) y sigue en segundo plano o en imagen dentro de imagen.
@main
final class App: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions opciones: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting sesion: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default Configuration", sessionRole: sesion.role)
    }
}

// La única ventana: la web de MorvehTV
final class Escena: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ escena: UIScene, willConnectTo sesion: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let ventana = escena as? UIWindowScene else { return }
        let w = UIWindow(windowScene: ventana)
        w.rootViewController = Visor()
        w.backgroundColor = .black
        w.makeKeyAndVisible()
        window = w
    }
}
