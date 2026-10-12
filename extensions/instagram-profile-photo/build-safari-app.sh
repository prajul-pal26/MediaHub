#!/bin/bash
# ==============================================================================
# Build Native macOS Safari Extension App for MediaHub Instagram Photo Sync
# ==============================================================================

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="MediaHub Safari Extension"
APP_DIR="${DIR}/${APP_NAME}.app"
PLUGINS_DIR="${APP_DIR}/Contents/PlugIns"
EXT_NAME="MediaHub Instagram Photo Sync Extension"
APPEX_DIR="${PLUGINS_DIR}/${EXT_NAME}.appex"

echo "Building ${APP_NAME}..."

rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS"
mkdir -p "${APP_DIR}/Contents/Resources"
mkdir -p "${APPEX_DIR}/Contents/MacOS"
mkdir -p "${APPEX_DIR}/Contents/Resources"

# 1. Compile Host Application Executable
cat << 'EOF' > /tmp/main.swift
import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let alert = NSAlert()
        alert.messageText = "MediaHub Instagram Photo Sync"
        alert.informativeText = "The Safari extension is installed. Please enable it in Safari Settings → Extensions."
        alert.addButton(withTitle: "Open Safari Settings")
        alert.addButton(withTitle: "Quit")
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Safari.Extensions")!)
        }
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
EOF

swiftc /tmp/main.swift -o "${APP_DIR}/Contents/MacOS/${APP_NAME}" -target arm64-apple-macos14.0 -framework AppKit

# 2. Compile Safari Web Extension Handler
cat << 'EOF' > /tmp/SafariWebExtensionHandler.swift
import Foundation
import SafariServices

@objc(SafariWebExtensionHandler)
public class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    public func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
EOF

swiftc /tmp/SafariWebExtensionHandler.swift \
  -emit-library \
  -o "${APPEX_DIR}/Contents/MacOS/${EXT_NAME}" \
  -target arm64-apple-macos14.0 \
  -framework Foundation \
  -framework SafariServices

# 3. Create Main App Info.plist
cat << EOF > "${APP_DIR}/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.mediahub.instagram-photo-sync</string>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>${APP_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
</dict>
</plist>
EOF

# 4. Create Extension Info.plist
cat << EOF > "${APPEX_DIR}/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.mediahub.instagram-photo-sync.Extension</string>
    <key>CFBundleName</key>
    <string>${EXT_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>${EXT_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>XPC!</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>NSExtension</key>
    <dict>
        <key>NSExtensionPointIdentifier</key>
        <string>com.apple.Safari.web-extension</string>
        <key>NSExtensionPrincipalClass</key>
        <string>SafariWebExtensionHandler</string>
    </dict>
</dict>
</plist>
EOF

# 5. Copy WebExtension Resources to Extension Bundle
cp "${DIR}/manifest.json" "${APPEX_DIR}/Contents/Resources/"
cp "${DIR}/background.js" "${APPEX_DIR}/Contents/Resources/"
cp "${DIR}/mediahub-bridge.js" "${APPEX_DIR}/Contents/Resources/"
cp "${DIR}/instagram-photo-uploader.js" "${APPEX_DIR}/Contents/Resources/"
cp "${DIR}/popup.html" "${APPEX_DIR}/Contents/Resources/"
cp "${DIR}/popup.js" "${APPEX_DIR}/Contents/Resources/"

# 6. Ad-hoc Sign the App & Appex
codesign -s - --force --deep "${APP_DIR}"

echo "Successfully built ${APP_DIR}!"
echo "To use in Safari: Develop menu → Allow Unsigned Extensions, then open ${APP_NAME}.app"
