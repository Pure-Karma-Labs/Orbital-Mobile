import UIKit
import FirebaseCore

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  /// Compatibility shim only. The real window is created and owned by
  /// SceneDelegate (issue #815); it assigns and clears this property. Two RN
  /// 0.82 call sites still read UIApplication.shared.delegate.window:
  /// RCTDeviceInfo.mm:245 and RCTLogBoxView.mm:85. Delete together with the
  /// SceneDelegate shims under the condition in SceneDelegate.swift's header.
  var window: UIWindow?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Must stay here, before any scene connects: the JS-side Firebase SDK and
    // RNFB's launch observer (RNFBMessaging+NSNotificationCenter.m:81-85) both
    // expect the native app instance to exist by end of didFinishLaunching.
    // APNs registration/device-token callbacks remain UIApplicationDelegate
    // methods under scenes (proxied by GULAppDelegateSwizzler).
    FirebaseApp.configure()
    return true
  }
}
