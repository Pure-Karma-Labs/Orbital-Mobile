import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import RNBootSplash
import UIKit

/// UIScene lifecycle host for React Native (issue #815).
///
/// iOS 27 refuses to launch apps built against the iOS 27 SDK with no
/// UIApplicationSceneManifest. React Native 0.82 ships no scene support, so the
/// three pieces upstream added in facebook/react-native#57700 are hand-ported:
///   1. connectionOptions -> launchOptions  (launchOptions(from:) below)
///   2. scene(_:openURLContexts:)           -> RCTLinkingManager
///   3. scene(_:continue:)                  -> RCTLinkingManager
/// Shape deliberately mirrors the react-native-community/template SceneDelegate.
///
/// DELETE these shims (and AppDelegate.window) when BOTH greps return hits —
/// they return zero on 0.82.1 (tracking issue: #311, whose 0.86 target does NOT
/// yet satisfy this; upstream scene support is in no stable release as of
/// 0.87.1):
///   grep -c connectionOptions node_modules/react-native/Libraries/AppDelegate/RCTReactNativeFactory.h
///   grep -c scene node_modules/react-native/Libraries/LinkingIOS/RCTLinkingManager.h
/// Then call startReactNative(withModuleName:in:connectionOptions:) and
/// RCTLinkingManager.scene(_:openURLContexts:) / .scene(_:continue:) directly.
///
/// One RN host per process: Info.plist pins UIApplicationSupportsMultipleScenes
/// to false (guarded by security invariant #14). A second scene would create a
/// second RCTReactNativeFactory in this process — two bootstrap() runs, two
/// SQLCipher connections on one orbital.db, two WebSocket sessions and two
/// writers to the Signal stores. Multi-window is not a free toggle.
class SceneDelegate: RCTDefaultReactNativeFactoryDelegate, UIWindowSceneDelegate {
  var window: UIWindow?
  var reactNativeFactory: RCTReactNativeFactory?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }

    dependencyProvider = RCTAppDependencyProvider()
    let factory = RCTReactNativeFactory(delegate: self)
    reactNativeFactory = factory

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    // Compatibility shim: RCTDeviceInfo.mm:245 (iPad split-view heuristic) and
    // RCTLogBoxView.mm:85 (dev only) still read
    // UIApplication.shared.delegate.window on 0.82; upstream now reads
    // RCTKeyWindow(). RNFBMessaging+NSNotificationCenter.m also reads it (at
    // launch and on every foreground) but only acts on an RCTRootView, which the
    // New Architecture never installs — the shim is inert for RNFB only while
    // RCTNewArchEnabled stays true. Delete with the header's condition.
    (UIApplication.shared.delegate as? AppDelegate)?.window = window

    factory.startReactNative(
      withModuleName: "OrbitalMobile",
      in: window,
      launchOptions: Self.launchOptions(from: connectionOptions)
    )
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    let appDelegate = UIApplication.shared.delegate as? AppDelegate
    if appDelegate?.window === window { appDelegate?.window = nil }
  }

  // MARK: - Inbound links (warm)

  // Forwards whatever URL iOS hands the scene into RN's global URL notification.
  // Bounded today by two facts: Info.plist declares only the `orbital` scheme
  // and no CFBundleDocumentTypes / UIFileSharingEnabled /
  // LSSupportsOpeningDocumentsInPlace, so iOS cannot hand us file:// or foreign
  // schemes; and React Navigation's `linking` config (prefix filter on
  // orbital://) is the ONLY JS `url` consumer. If either changes, validate the
  // scheme at the consumer — do not trust the manifest.
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let url = URLContexts.first?.url else { return }
    _ = RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
  }

  // Upstream-parity only: unreachable until an associated-domains entitlement
  // exists (RCTLinkingManager acts only on NSUserActivityTypeBrowsingWeb).
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = RCTLinkingManager.application(UIApplication.shared, continue: userActivity) { _ in }
  }

  // MARK: - RCTReactNativeFactoryDelegate (was ReactNativeDelegate)

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }

  override func customize(_ rootView: RCTRootView) {
    super.customize(rootView)
    RNBootSplash.initWithStoryboard("BootSplash", rootView: rootView)
  }

  // MARK: - connectionOptions -> launchOptions

  /// Swift port of RCTConvertConnectionOptionsToLaunchOptions (RN main,
  /// RCTReactNativeFactory.mm:45-66). Feeds Linking.getInitialURL(), which reads
  /// bridge.launchOptions (RCTLinkingManager.mm:158-162; bridgeless delivers it
  /// via RCTBridgeProxy, RCTInstance.mm:304-321). Notification payloads are
  /// deliberately omitted -- upstream omits them, and the killed-state push tap
  /// is served by RNFB's UNUserNotificationCenter delegate, not launchOptions.
  private static func launchOptions(
    from connectionOptions: UIScene.ConnectionOptions
  ) -> [UIApplication.LaunchOptionsKey: Any] {
    var options: [UIApplication.LaunchOptionsKey: Any] = [:]

    if let url = connectionOptions.urlContexts.first?.url {
      options[.url] = url
    }

    // Upstream-parity only: unreachable until an associated-domains entitlement
    // exists. Kept so the block stays a faithful mirror and deletes mechanically.
    if let activity = connectionOptions.userActivities.first {
      var activityDict: [AnyHashable: Any] = [:]
      activityDict[UIApplication.LaunchOptionsKey.userActivityType.rawValue] = activity.activityType
      activityDict["UIApplicationLaunchOptionsUserActivityKey"] = activity
      options[.userActivityDictionary] = activityDict
    }

    return options
  }
}
