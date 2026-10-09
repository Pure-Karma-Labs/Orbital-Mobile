require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "OrbitalMediaExport"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/Pure-Karma-Labs/Orbital-Mobile.git", :tag => "#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm}"

  # Photos: PHPhotoLibrary / PHAssetCreationRequest (add-only).
  # UIKit: UIDocumentPickerViewController + RCTPresentedViewController.
  # UniformTypeIdentifiers: UTType(mimeType:) for the resource UTI and the
  # staging-alias extension.
  #
  # NO privacy manifest: this pod calls no required-reason API (no file
  # timestamps, no disk space, no NSUserDefaults, no stat/statfs). Enforced by
  # the `media-export-native-pins` rule in scripts/check-security-invariants.mjs.
  s.frameworks   = "Photos", "UIKit", "UniformTypeIdentifiers"

  # Pulls in React-Core, ReactCommon/turbomodule, and the generated codegen
  # spec target for the New Architecture.
  install_modules_dependencies(s)
end
