require 'xcodeproj'
require 'fileutils'
require 'json'
root = File.expand_path(__dir__)
signing_path = File.join(root, 'LocalConfiguration/Signing.json')
development_team = nil
if File.exist?(signing_path)
  begin
    signing = JSON.parse(File.read(signing_path))
    development_team = signing.fetch('developmentTeam') if signing.is_a?(Hash)
  rescue JSON::ParserError, KeyError
    abort 'LocalConfiguration/Signing.json must contain a developmentTeam string (10 uppercase letters/digits).'
  end
  unless development_team.is_a?(String) && development_team.match?(/\A[A-Z0-9]{10}\z/)
    abort 'LocalConfiguration/Signing.json must contain a developmentTeam string (10 uppercase letters/digits).'
  end
end
project = Xcodeproj::Project.new(File.join(root, 'Assistant.xcodeproj'))
package = project.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)
package.repositoryURL = 'https://github.com/firebase/firebase-ios-sdk.git'
package.requirement = { 'kind' => 'exactVersion', 'version' => '12.19.2' }
project.root_object.package_references << package
sources = project.main_group.new_group('Sources', 'Sources')
refs = Dir[File.join(root, 'Sources/*.swift')].sort.map { |file| sources.new_file(File.basename(file)) }
shared = project.main_group.new_group('Shared', 'Shared')
shared_refs = Dir[File.join(root, 'Shared/*.swift')].sort.map { |file| shared.new_file(File.basename(file)) }
controls_group = project.main_group.new_group('Controls', 'Controls')
controls_refs = Dir[File.join(root, 'Controls/*.swift')].sort.map { |file| controls_group.new_file(File.basename(file)) }
apps = {}
[['Assistant-iOS', :ios, '17.0', 'ios'], ['Assistant-macOS', :osx, '14.0', 'macos']].each do |name, platform, minimum, suffix|
  target = project.new_target(:application, name, platform, minimum)
  target.product_reference.path = 'Assistant.app'
  (refs + shared_refs).each { |ref| target.source_build_phase.add_file_reference(ref) }
  apps[platform] = target
  catalog = project.main_group.new_file("Assets/#{platform == :ios ? 'iOS' : 'macOS'}.xcassets")
  target.resources_build_phase.add_file_reference(catalog)
  %w[FirebaseCore FirebaseMessaging].each do |product|
    dependency = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
    dependency.package = package
    dependency.product_name = product
    target.package_product_dependencies << dependency
    build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
    build_file.product_ref = dependency
    target.frameworks_build_phase.files << build_file
  end
  target.build_configurations.each do |config|
    settings = config.build_settings
    settings['SWIFT_VERSION'] = '5.0'
    settings['ASSETCATALOG_COMPILER_APPICON_NAME'] = 'AppIcon'
    settings['PRODUCT_BUNDLE_IDENTIFIER'] = "#{ENV.fetch('ASSISTANT_BUNDLE_PREFIX', 'com.example.assistant')}.#{suffix}"
    settings['PRODUCT_NAME'] = 'Assistant'
    settings['INFOPLIST_FILE'] = "Configuration/#{suffix}-Info.plist"
    settings['CODE_SIGN_ENTITLEMENTS'] = "Configuration/#{suffix}.entitlements"
    settings['CODE_SIGN_STYLE'] = development_team ? 'Automatic' : 'Manual'
    settings['DEVELOPMENT_TEAM'] = development_team || ''
    settings['CODE_SIGN_IDENTITY'] = 'Apple Development' if development_team
    settings['CURRENT_PROJECT_VERSION'] = '1'
    settings['MARKETING_VERSION'] = '1.0.0'
    settings['ENABLE_USER_SCRIPT_SANDBOXING'] = 'NO'
    settings['ASSISTANT_APP_ORIGIN'] = ENV.fetch('ASSISTANT_APP_ORIGIN', 'https://assistant.example.com/')
    settings['SWIFT_EMIT_LOC_STRINGS'] = 'YES'
    settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = config.name == 'Debug' ? 'DEBUG' : ''
    settings['TARGETED_DEVICE_FAMILY'] = '1,2' if platform == :ios
    settings['SUPPORTS_MACCATALYST'] = 'NO' if platform == :ios
    settings['ENABLE_HARDENED_RUNTIME'] = 'YES' if platform == :osx
    settings['COMBINE_HIDPI_IMAGES'] = 'YES' if platform == :osx
  end
  phase = target.new_shell_script_build_phase('Optional local Firebase configuration')
  phase.shell_script = <<~SH
    set -eu
    SOURCE="${SRCROOT}/LocalConfiguration/#{suffix}/GoogleService-Info.plist"
    DESTINATION="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/GoogleService-Info.plist"
    if [ -f "$SOURCE" ]; then
      mkdir -p "$(dirname "$DESTINATION")"
      cp "$SOURCE" "$DESTINATION"
    else
      rm -f "$DESTINATION"
    fi
  SH
  phase.always_out_of_date = '1'
  scheme = Xcodeproj::XCScheme.new
  scheme.add_build_target(target)
  scheme.set_launch_target(target)
  scheme.save_as(project.path, name, true)
end

ios_app = apps.fetch(:ios)
controls = project.new_target(:app_extension, 'Assistant-Controls', :ios, '18.0')
(controls_refs + shared_refs).each { |ref| controls.source_build_phase.add_file_reference(ref) }
%w[WidgetKit SwiftUI AppIntents].each { |framework| controls.add_system_framework(framework) }
controls.build_configurations.each do |config|
  settings = config.build_settings
  settings['SWIFT_VERSION'] = '5.0'
  settings['PRODUCT_NAME'] = 'AssistantControls'
  settings['PRODUCT_BUNDLE_IDENTIFIER'] = "#{ENV.fetch('ASSISTANT_BUNDLE_PREFIX', 'com.example.assistant')}.ios.controls"
  settings['INFOPLIST_FILE'] = 'Configuration/controls-Info.plist'
  settings['CODE_SIGN_STYLE'] = development_team ? 'Automatic' : 'Manual'
  settings['DEVELOPMENT_TEAM'] = development_team || ''
  settings['CODE_SIGN_IDENTITY'] = 'Apple Development' if development_team
  settings['CURRENT_PROJECT_VERSION'] = '1'
  settings['MARKETING_VERSION'] = '1.0.0'
  settings['TARGETED_DEVICE_FAMILY'] = '1,2'
  settings['IPHONEOS_DEPLOYMENT_TARGET'] = '18.0'
  settings['SKIP_INSTALL'] = 'YES'
  settings['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = config.name == 'Debug' ? 'DEBUG' : ''
end
ios_app.add_dependency(controls)
embed = ios_app.new_copy_files_build_phase('Embed Foundation Extensions')
embed.symbol_dst_subfolder_spec = :plug_ins
build_file = embed.add_file_reference(controls.product_reference, true)
build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
project.save
