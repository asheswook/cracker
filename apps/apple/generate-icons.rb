require 'json'
require 'fileutils'
require 'open3'
root = File.expand_path(__dir__)
source = File.read(File.join(root, '../web/public/icon.svg'))
[['iOS', [[1024, 'universal', '1024x1024', '1x']]],
 ['macOS', [16,32,128,256,512].flat_map { |size| [1,2].map { |scale| [size * scale, 'mac', "#{size}x#{size}", "#{scale}x"] } }]].each do |platform, sizes|
  directory = File.join(root, "Assets/#{platform}.xcassets/AppIcon.appiconset")
  FileUtils.mkdir_p(directory)
  images = sizes.map do |pixels, idiom, size, scale|
    filename = "icon-#{size}-#{scale}.png"
    svg = platform == 'iOS' ? source.sub('rx="112"', '') : source.sub('viewBox="0 0 512 512"', 'viewBox="-56 -56 624 624"')
    output, status = Open3.capture2('rsvg-convert', '-w', pixels.to_s, '-h', pixels.to_s, stdin_data: svg)
    raise 'rsvg-convert failed' unless status.success?
    File.binwrite(File.join(directory, filename), output)
    platform == 'iOS' ? { 'filename' => filename, 'idiom' => idiom, 'size' => size, 'platform' => 'ios' } : { 'filename' => filename, 'idiom' => idiom, 'size' => size, 'scale' => scale }
  end
  File.write(File.join(directory, 'Contents.json'), JSON.pretty_generate({ 'images' => images, 'info' => { 'author' => 'xcode', 'version' => 1 } }))
end
