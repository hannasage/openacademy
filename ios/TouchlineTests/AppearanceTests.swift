import XCTest
import SwiftUI
import UIKit
@testable import Touchline

final class AppearanceTests: XCTestCase {
    private func components(_ color: Color) -> [Double] {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        XCTAssertTrue(UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a))
        return [Double(r), Double(g), Double(b)]
    }
    private func assertColor(_ color: Color, _ hex: UInt32, file: StaticString = #filePath, line: UInt = #line) {
        for (actual, expected) in zip(components(color), [Double((hex >> 16) & 255), Double((hex >> 8) & 255), Double(hex & 255)]) {
            XCTAssertEqual(actual, expected / 255, accuracy: 0.001, file: file, line: line)
        }
    }
    func testAllFourPalettesMatchApprovedSemanticColors() {
        let cases: [(ThemePair, Bool, String, [UInt32])] = [
            (.bloom, true, "Noir Bloom", [0x0e0620, 0x180d38, 0xf5eaff, 0xa080cc, 0xff39ab, 0x2e1060]),
            (.bloom, false, "Confetti Studio", [0xfcf8ff, 0xffffff, 0x17202a, 0x485463, 0xb56aff, 0xbfcbd8]),
            (.coast, true, "Dusk Protocol", [0x1b1f2a, 0x242b3a, 0xe5e9f0, 0xa7b0c0, 0x35d9ff, 0x3a435a]),
            (.coast, false, "Coastal Day", [0xf6fbff, 0xffffff, 0x17202a, 0x485463, 0x00c8ff, 0xbfcbd8])
        ]
        for (pair, dark, name, values) in cases {
            let palette = HubPalette(pair: pair, dark: dark)
            XCTAssertEqual(palette.name, name)
            for (color, hex) in zip([palette.background, palette.surface, palette.text, palette.muted, palette.accent, palette.border], values) { assertColor(color, hex) }
            assertColor(palette.primaryText, pair == .coast && !dark ? 0x101820 : 0x17202a)
            assertColor(palette.link, dark ? values[4] : values[2])
        }
    }
    func testModesResolveLiveDeviceAppearanceAndIgnoreDeviceForOverrides() {
        for device: ColorScheme in [.dark, .light] {
            XCTAssertEqual(AppearanceMode.system.resolvedScheme(system: device), device)
            XCTAssertEqual(AppearanceMode.dark.resolvedScheme(system: device), .dark)
            XCTAssertEqual(AppearanceMode.light.resolvedScheme(system: device), .light)
        }
        XCTAssertNil(AppearanceMode.system.scheme)
    }
    func testInvalidSavedPreferencesUseExistingDefaultsWithoutRewritingThem() {
        let suite = "Touchline-Appearance-Tests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("future-pair", forKey: AppearancePreferences.pairKey)
        defaults.set("future-mode", forKey: AppearancePreferences.modeKey)
        XCTAssertEqual(AppearancePreferences.pair(rawValue: defaults.string(forKey: AppearancePreferences.pairKey) ?? ""), .bloom)
        XCTAssertEqual(AppearancePreferences.mode(rawValue: defaults.string(forKey: AppearancePreferences.modeKey) ?? ""), .system)
        XCTAssertEqual(defaults.string(forKey: AppearancePreferences.pairKey), "future-pair")
        XCTAssertEqual(defaults.string(forKey: AppearancePreferences.modeKey), "future-mode")
        defaults.set("coast", forKey: AppearancePreferences.pairKey)
        defaults.set("light", forKey: AppearancePreferences.modeKey)
        XCTAssertEqual(AppearancePreferences.pair(rawValue: defaults.string(forKey: AppearancePreferences.pairKey) ?? ""), .coast)
        XCTAssertEqual(AppearancePreferences.mode(rawValue: defaults.string(forKey: AppearancePreferences.modeKey) ?? ""), .light)
    }
    func testTextAndSelectedModeContrastOnEveryPalette() {
        func luminance(_ color: Color) -> Double {
            let rgb = components(color).map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
            return zip(rgb, [0.2126, 0.7152, 0.0722]).map(*).reduce(0, +)
        }
        func ratio(_ a: Color, _ b: Color) -> Double {
            let a = luminance(a), b = luminance(b)
            return (max(a, b) + 0.05) / (min(a, b) + 0.05)
        }
        for pair in ThemePair.allCases {
            for dark in [true, false] {
                let p = HubPalette(pair: pair, dark: dark)
                for foreground in [p.text, p.muted] {
                    for background in [p.background, p.surface] { XCTAssertGreaterThanOrEqual(ratio(foreground, background), 4.5, p.name) }
                }
                XCTAssertGreaterThanOrEqual(ratio(p.primaryText, p.accent), 4.5, p.name)
            }
        }
    }
}
