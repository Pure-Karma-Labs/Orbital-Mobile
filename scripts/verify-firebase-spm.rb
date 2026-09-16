#!/usr/bin/env ruby
# verify-firebase-spm.rb — Guard 2 of 3 for issue #769.
# Verifies that the committed app project and Package.resolved carry the
# expected Firebase Swift Package Manager pin. Invoked from the Podfile
# post_integrate hook (next-run tripwire) and by the CI harness before
# pod install. See docs/ios-dependency-delivery.md.
#
# Usage:
#   ruby scripts/verify-firebase-spm.rb \
#     --pbxproj ios/OrbitalMobile.xcodeproj/project.pbxproj \
#     --resolved ios/OrbitalMobile.xcworkspace/xcshareddata/swiftpm/Package.resolved \
#     --expected-url https://github.com/firebase/firebase-ios-sdk.git \
#     --expected-version 12.18.0 \
#     --app-target OrbitalMobile \
#     [--bootstrap]
#
# Exit codes: 0 = OK, 1 = failure, 2 = usage error.

require 'json'
require 'optparse'

DOCS = 'docs/ios-dependency-delivery.md'

options = {}
parser = OptionParser.new do |o|
  o.banner = "Usage: #{File.basename($0)} --pbxproj PATH --resolved PATH --expected-url URL --expected-version VER --app-target TARGET [--bootstrap]"
  o.on('--pbxproj PATH',          'Path to OrbitalMobile.xcodeproj/project.pbxproj') { |v| options[:pbxproj] = v }
  o.on('--resolved PATH',         'Path to Package.resolved') { |v| options[:resolved] = v }
  o.on('--expected-url URL',      'Expected firebase-ios-sdk repository URL') { |v| options[:url] = v }
  o.on('--expected-version VER',  'Expected firebase-ios-sdk version (exactVersion)') { |v| options[:version] = v }
  o.on('--app-target NAME',       'Xcode app target name (default: OrbitalMobile)') { |v| options[:target] = v }
  o.on('--bootstrap',             'Bootstrap mode: downgrade missing-reference and missing-resolved to warnings') { options[:bootstrap] = true }
end

begin
  parser.parse!
rescue OptionParser::InvalidOption => e
  STDERR.puts e.message
  STDERR.puts parser.banner
  exit 2
end

missing = %i[pbxproj resolved url version].select { |k| options[k].nil? }
unless missing.empty?
  STDERR.puts "Missing required options: #{missing.map { |k| "--#{k}" }.join(', ')}"
  STDERR.puts parser.banner
  exit 2
end

options[:target] ||= 'OrbitalMobile'

failures = 0
warnings = 0
bootstrap = options[:bootstrap]

def fail_check(msg)
  STDERR.puts "[Orbital] #{msg} -- see #{DOCS} (#769)"
end

def warn_check(msg)
  STDERR.puts "[Orbital] WARNING: #{msg} -- see #{DOCS} (#769)"
end

# ---------------------------------------------------------------------------
# Read the pbxproj
# ---------------------------------------------------------------------------
pbxproj_content = begin
  File.read(options[:pbxproj])
rescue => e
  fail_check "verify-firebase-spm: cannot read pbxproj: #{e.message}"
  exit 1
end

# ---------------------------------------------------------------------------
# Check 1: Exactly one XCRemoteSwiftPackageReference, canonical URL, exactVersion
# ---------------------------------------------------------------------------
# Uniqueness is counted on the isa literal itself, so an object written with an
# unusual id (lowercase hex, different length) cannot hide from the count.
isa_count = pbxproj_content.scan(/isa = XCRemoteSwiftPackageReference;/).size
spr_objects = pbxproj_content.scan(/[0-9A-Za-z]{24}\s*\/\*.*?\*\/\s*=\s*\{[^}]*isa = XCRemoteSwiftPackageReference;[^}]*\}/m)
if isa_count != spr_objects.size
  fail_check "pbxproj has #{isa_count} 'isa = XCRemoteSwiftPackageReference;' object(s) but only #{spr_objects.size} " \
             "could be parsed as a package reference — the project carries a malformed or disguised package reference"
  failures += 1
end

zero_references = isa_count.zero?

if zero_references
  msg = "pbxproj has no XCRemoteSwiftPackageReference — firebase-ios-sdk package reference is missing from the app project"
  if bootstrap
    warn_check msg + " (bootstrap mode: warning only)"
    warnings += 1
  else
    fail_check msg
    failures += 1
  end
elsif isa_count > 1
  fail_check "pbxproj has #{isa_count} XCRemoteSwiftPackageReference objects — exactly one is required; " \
             "no Swift package other than firebase-ios-sdk may appear in the app project"
  failures += 1
elsif spr_objects.size == 1
  obj = spr_objects.first
  # Check URL
  if obj =~ /repositoryURL\s*=\s*"([^"]+)"/
    actual_url = $1
    unless actual_url == options[:url]
      fail_check "pbxproj XCRemoteSwiftPackageReference has repositoryURL #{actual_url.inspect}, " \
                 "expected #{options[:url].inspect} — do NOT 'fix' the Podfile literal; verify that " \
                 "@react-native-firebase/app was not tampered with (sdkVersions.ios.firebaseSpmUrl)"
      failures += 1
    end
  else
    fail_check "pbxproj XCRemoteSwiftPackageReference has no repositoryURL field"
    failures += 1
  end
  # Check exactVersion requirement
  if obj =~ /requirement\s*=\s*\{([^}]*)\}/m
    req = $1
    if req =~ /kind\s*=\s*(\w+)/
      kind = $1
      unless kind == 'exactVersion'
        fail_check "pbxproj XCRemoteSwiftPackageReference requirement kind is #{kind.inspect}, " \
                   "expected exactVersion — the floating upToNextMajorVersion requirement allows Xcode " \
                   "to resolve a version newer than #{options[:version]}; set exactVersion by hand"
        failures += 1
      end
    else
      fail_check "pbxproj XCRemoteSwiftPackageReference requirement has no kind field"
      failures += 1
    end
    if req =~ /version\s*=\s*([0-9][^\s;]+)/
      pinned_version = $1
      unless pinned_version == options[:version]
        fail_check "pbxproj XCRemoteSwiftPackageReference exactVersion is #{pinned_version.inspect}, " \
                   "expected #{options[:version].inspect} — update the exactVersion requirement in the pbxproj to match RNFirebaseSPM.version"
        failures += 1
      end
    else
      fail_check "pbxproj XCRemoteSwiftPackageReference requirement has no version field"
      failures += 1
    end
  else
    fail_check "pbxproj XCRemoteSwiftPackageReference has no requirement block"
    failures += 1
  end
end

# ---------------------------------------------------------------------------
# Check 2: app target has FirebaseCore product dependency + PBXBuildFile
# ---------------------------------------------------------------------------
# Only skip when check 1 hit the zero-references bootstrap case
check2_skip = zero_references && bootstrap

unless check2_skip
  # Find the OrbitalMobile PBXNativeTarget block
  target_name = options[:target]
  # Match the native target block by name
  native_target_block = nil
  # The PBXNativeTarget section spans from "name = OrbitalMobile;" to the closing "}"
  pbxproj_content.scan(/\{[^{}]*name = #{Regexp.escape(target_name)};[^{}]*\}/m) do |block|
    if block.include?('isa = PBXNativeTarget')
      native_target_block = block
    end
  end

  firebase_core_dep_id = nil
  if pbxproj_content =~ /([0-9A-F]{24})\s*\/\*\s*FirebaseCore\s*\*\/\s*=\s*\{[^}]*isa = XCSwiftPackageProductDependency;[^}]*productName = FirebaseCore;[^}]*\}/m
    firebase_core_dep_id = $1
  end

  if firebase_core_dep_id.nil?
    fail_check "pbxproj has no XCSwiftPackageProductDependency with productName = FirebaseCore — " \
               "RNFB's post_integrate has not run yet (bootstrap), or the app project was manually edited"
    failures += 1
  else
    # Check that native target references this dep in packageProductDependencies
    if native_target_block.nil?
      fail_check "pbxproj has no PBXNativeTarget named #{target_name.inspect} — check --app-target"
      failures += 1
    else
      unless native_target_block.include?(firebase_core_dep_id)
        fail_check "PBXNativeTarget #{target_name.inspect} does not list the FirebaseCore " \
                   "XCSwiftPackageProductDependency (#{firebase_core_dep_id}) in packageProductDependencies"
        failures += 1
      end
    end

    # A PBXBuildFile whose productRef is this dependency is what actually links
    # the product ("productRef = <id>" occurs only inside PBXBuildFile objects).
    unless pbxproj_content.include?("productRef = #{firebase_core_dep_id}")
      fail_check "pbxproj has no PBXBuildFile with productRef = #{firebase_core_dep_id} (FirebaseCore) — " \
                 "the product dependency is declared but never linked (RNFB #9158 shape)"
      failures += 1
    end
  end
end

# ---------------------------------------------------------------------------
# Check 3: Package.resolved
# ---------------------------------------------------------------------------
resolved_path = options[:resolved]
resolved_missing = !File.exist?(resolved_path)
resolved_data = nil

if resolved_missing
  msg = "Package.resolved not found at #{resolved_path} — run xcodebuild -resolvePackageDependencies " \
        "-workspace ios/OrbitalMobile.xcworkspace -scheme OrbitalMobile " \
        "-clonedSourcePackagesDirPath ~/Library/Caches/orbital-spm to generate it"
  if bootstrap
    warn_check msg + " (bootstrap mode: warning only)"
    warnings += 1
  else
    fail_check msg
    failures += 1
  end
else
  resolved_data = begin
    JSON.parse(File.read(resolved_path))
  rescue => e
    fail_check "Package.resolved is not valid JSON: #{e.message}"
    failures += 1
    nil
  end

  if resolved_data
    # Check format version
    unless resolved_data['version'] == 3
      fail_check "Package.resolved format version is #{resolved_data['version'].inspect}, expected 3"
      failures += 1
    end

    pins = resolved_data['pins'] || []

    # Find firebase-ios-sdk pin
    firebase_pin = pins.find { |p| p['identity'] == 'firebase-ios-sdk' }
    if firebase_pin.nil?
      fail_check "Package.resolved has no pin for firebase-ios-sdk"
      failures += 1
    else
      pin_version = firebase_pin.dig('state', 'version')
      pin_location = firebase_pin['location']
      unless pin_version == options[:version]
        fail_check "Package.resolved firebase-ios-sdk pin version is #{pin_version.inspect}, " \
                   "expected #{options[:version].inspect} — run the bootstrap resolve or the RNFB bump procedure"
        failures += 1
      end
      unless pin_location == options[:url]
        fail_check "Package.resolved firebase-ios-sdk pin location is #{pin_location.inspect}, " \
                   "expected #{options[:url].inspect}"
        failures += 1
      end
    end

    # Allow-listed github.com orgs: exactly the orgs the committed Package.resolved
    # uses (google, firebase, googleads; grpc-binary and abseil live under google/).
    # A new org in the graph is a reviewed diff here AND in Package.resolved.
    ALLOWED_ORGS = %w[firebase google googleads].freeze

    pins.each do |pin|
      loc = pin['location'].to_s
      identity = pin['identity']
      # Check host is github.com
      unless loc.start_with?('https://github.com/')
        fail_check "Package.resolved pin #{identity.inspect} has location #{loc.inspect} — " \
                   "only github.com locations are allowed (supply-chain anchor)"
        failures += 1
        next
      end
      # Exactly org/repo, no traversal, before the org lookup (a location such as
      # https://github.com/google/../../evil/x.git would otherwise pass as "google").
      path_parts = loc.sub('https://github.com/', '').split('/')
      if path_parts.size != 2 || path_parts.any? { |p| p.empty? || p == '.' || p == '..' }
        fail_check "Package.resolved pin #{identity.inspect} has location #{loc.inspect} — " \
                   "expected exactly https://github.com/<org>/<repo>(.git) with no traversal"
        failures += 1
        next
      end
      org = path_parts.first.downcase
      unless ALLOWED_ORGS.include?(org)
        fail_check "Package.resolved pin #{identity.inspect} location org is #{org.inspect}, " \
                   "not in the allowlist #{ALLOWED_ORGS.inspect} — verify this package belongs in the graph"
        failures += 1
      end
      # Check revision is a 40-hex string
      revision = pin.dig('state', 'revision').to_s
      unless revision =~ /\A[0-9a-f]{40}\z/
        fail_check "Package.resolved pin #{identity.inspect} has revision #{revision.inspect}, " \
                   "expected a 40-hex commit SHA"
        failures += 1
      end
    end
  end
end

# ---------------------------------------------------------------------------
# Check 4: no SwiftPM mirror/registry configuration next to the workspace or
# project. swiftpm/configuration/ is gitignored (per-user), so a mirrors.json
# or registries.json there would redirect the fetch URL AFTER every literal
# comparison above, invisibly to git status and to CI.
# ---------------------------------------------------------------------------
resolved_dir = File.dirname(resolved_path)
project_swiftpm = File.expand_path('../../../OrbitalMobile.xcodeproj/project.xcworkspace/xcshareddata/swiftpm', resolved_dir)
[resolved_dir, project_swiftpm].each do |dir|
  %w[mirrors.json registries.json].each do |name|
    cfg = File.join(dir, 'configuration', name)
    next unless File.exist?(cfg)
    fail_check "#{cfg} exists — a SwiftPM mirror/registry configuration can redirect the firebase-ios-sdk " \
               "fetch URL after every URL check has passed; delete it (nothing in this repo needs one)"
    failures += 1
  end
end

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
if failures > 0
  exit 1
end

# Print success line
if resolved_data
  pins = resolved_data['pins'] || []
  n_pins = pins.size
  firebase_pin = pins.find { |p| p['identity'] == 'firebase-ios-sdk' }
  version = firebase_pin&.dig('state', 'version') || options[:version]
  revision = firebase_pin&.dig('state', 'revision') || '?'
  puts "verify-firebase-spm: OK (#{n_pins} pins, firebase-ios-sdk #{version} @ #{revision[0, 10]})"
elsif bootstrap && warnings > 0
  puts "verify-firebase-spm: OK (bootstrap mode, #{warnings} warning(s))"
else
  puts "verify-firebase-spm: OK"
end
