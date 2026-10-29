import SwiftUI

enum ThemePair: String, CaseIterable, Identifiable {
    case bloom, coast
    var id: String { rawValue }
    var darkName: String { self == .bloom ? "Noir Bloom" : "Dusk Protocol" }
    var lightName: String { self == .bloom ? "Confetti Studio" : "Coastal Day" }
}

enum AppearanceMode: String, CaseIterable, Identifiable {
    case dark, light, system
    var id: String { rawValue }
    func resolvedScheme(system: ColorScheme) -> ColorScheme { scheme ?? system }
    var scheme: ColorScheme? { self == .system ? nil : (self == .dark ? .dark : .light) }
}

struct HubPalette {
    let colorScheme: ColorScheme
    let name: String
    let background: Color
    let surface: Color
    let text: Color
    let muted: Color
    let accent: Color
    let link: Color
    let border: Color
    let primaryText: Color

    init(pair: ThemePair, dark: Bool) {
        colorScheme = dark ? .dark : .light
        name = dark ? pair.darkName : pair.lightName
        let values: [UInt32]
        switch (pair, dark) {
        case (.bloom, true): values = [0x0e0620, 0x180d38, 0xf5eaff, 0xa080cc, 0xFF39AB, 0x2e1060]
        case (.bloom, false): values = [0xFCF8FF, 0xFFFFFF, 0x17202A, 0x485463, 0xB56AFF, 0xbfcbd8]
        case (.coast, true): values = [0x1b1f2a, 0x242b3a, 0xe5e9f0, 0xa7b0c0, 0x35D9FF, 0x3a435a]
        case (.coast, false): values = [0xF6FBFF, 0xFFFFFF, 0x17202A, 0x485463, 0x00C8FF, 0xbfcbd8]
        }
        func color(_ value: UInt32) -> Color {
            Color(red: Double((value >> 16) & 255)/255, green: Double((value >> 8) & 255)/255, blue: Double(value & 255)/255)
        }
        background = color(values[0]); surface = color(values[1]); text = color(values[2])
        muted = color(values[3]); accent = color(values[4])
        border = color(values[5]); primaryText = color(pair == .coast && !dark ? 0x101820 : 0x17202a)
        // Projection UI uses its text color for readable accents on light surfaces.
        link = dark ? accent : text
    }
}

private struct HubPaletteKey: EnvironmentKey {
    static let defaultValue = HubPalette(pair: .bloom, dark: true)
}
extension EnvironmentValues {
    var hubPalette: HubPalette {
        get { self[HubPaletteKey.self] }
        set { self[HubPaletteKey.self] = newValue }
    }
}

enum AppearancePreferences {
    static let pairKey = "touchline.themePair"
    static let modeKey = "touchline.appearanceMode"
    static func pair(rawValue: String) -> ThemePair { ThemePair(rawValue: rawValue) ?? .bloom }
    static func mode(rawValue: String) -> AppearanceMode { AppearanceMode(rawValue: rawValue) ?? .system }
    // UI tests retain only appearance across relaunch. Learning and account fixtures stay isolated.
    static let defaults: UserDefaults = {
        let process = ProcessInfo.processInfo
        guard process.arguments.contains("--touchline-ui-test") || process.environment["XCTestConfigurationFilePath"] != nil else { return .standard }
        let id = process.environment["TOUCHLINE_APPEARANCE_TEST_SUITE"].flatMap(UUID.init(uuidString:)) ?? UUID()
        return UserDefaults(suiteName: "Touchline-Appearance-Tests-" + id.uuidString)!
    }()
}

struct AppearanceRoot: View {
    @AppStorage private var pair: String
    @AppStorage private var mode: String
    private let defaults: UserDefaults
    init(defaults: UserDefaults = AppearancePreferences.defaults) {
        self.defaults = defaults
        _pair = AppStorage(wrappedValue: "bloom", AppearancePreferences.pairKey, store: defaults)
        _mode = AppStorage(wrappedValue: "system", AppearancePreferences.modeKey, store: defaults)
    }
    var body: some View {
        ResolvedAppearance(pair: AppearancePreferences.pair(rawValue: pair), mode: AppearancePreferences.mode(rawValue: mode))
            .defaultAppStorage(defaults)
    }
}

private struct ResolvedAppearance: View {
    @Environment(\.colorScheme) private var colorScheme
    let pair: ThemePair
    let mode: AppearanceMode
    var body: some View {
        let resolvedScheme = mode.resolvedScheme(system: colorScheme)
        let palette = HubPalette(pair: pair, dark: resolvedScheme == .dark)
        ContentView()
            .environment(\.colorScheme, resolvedScheme)
            .environment(\.hubPalette, palette)
            .tint(palette.link)
            .foregroundStyle(palette.text)
            .background(palette.background)
    }
}

private struct HubSurface: ViewModifier {
    @Environment(\.hubPalette) private var palette
    func body(content: Content) -> some View {
        content.scrollContentBackground(.hidden)
            .background(palette.background)
            .toolbarBackground(palette.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(palette.colorScheme, for: .navigationBar)
    }
}
extension View {
    func hubSurface() -> some View { modifier(HubSurface()) }
}
