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
    var scheme: ColorScheme? { self == .system ? nil : (self == .dark ? .dark : .light) }
}

struct HubPalette {
    let name: String
    let background: Color
    let surface: Color
    let text: Color
    let muted: Color
    let accent: Color
    let link: Color

    init(pair: ThemePair, dark: Bool) {
        name = dark ? pair.darkName : pair.lightName
        let values: [UInt32]
        switch (pair, dark) {
        case (.bloom, true): values = [0x0e0620, 0x180d38, 0xf5eaff, 0xa080cc, 0xFF39AB]
        case (.bloom, false): values = [0xFCF8FF, 0xFFFFFF, 0x17202A, 0x485463, 0xB56AFF]
        case (.coast, true): values = [0x1b1f2a, 0x242b3a, 0xe5e9f0, 0xa7b0c0, 0x35D9FF]
        case (.coast, false): values = [0xF6FBFF, 0xFFFFFF, 0x17202A, 0x485463, 0x00C8FF]
        }
        func color(_ value: UInt32) -> Color {
            Color(red: Double((value >> 16) & 255)/255, green: Double((value >> 8) & 255)/255, blue: Double(value & 255)/255)
        }
        background = color(values[0]); surface = color(values[1]); text = color(values[2])
        muted = color(values[3]); accent = color(values[4])
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

struct AppearanceRoot: View {
    @AppStorage("touchline.themePair") private var pair = "bloom"
    @AppStorage("touchline.appearanceMode") private var mode = "system"
    var body: some View {
        ResolvedAppearance(pair: ThemePair(rawValue: pair) ?? .bloom)
            .preferredColorScheme((AppearanceMode(rawValue: mode) ?? .system).scheme)
    }
}

private struct ResolvedAppearance: View {
    @Environment(\.colorScheme) private var colorScheme
    let pair: ThemePair
    var body: some View {
        let palette = HubPalette(pair: pair, dark: colorScheme == .dark)
        ContentView()
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
    }
}
extension View {
    func hubSurface() -> some View { modifier(HubSurface()) }
}

struct AppearanceView: View {
    @AppStorage("touchline.themePair") private var pair = "bloom"
    @AppStorage("touchline.appearanceMode") private var mode = "system"
    @Environment(\.hubPalette) private var palette
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("Theme pair") {
                    ForEach(ThemePair.allCases) { choice in
                        Button { pair = choice.rawValue } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(choice.darkName)
                                    Text(choice.lightName).font(.subheadline).foregroundStyle(palette.muted)
                                }
                                Spacer()
                                ForEach([true, false], id: \.self) { dark in
                                    let swatch = HubPalette(pair: choice, dark: dark)
                                    RoundedRectangle(cornerRadius: 4).fill(swatch.background)
                                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(swatch.accent, lineWidth: 2))
                                        .frame(width: 16, height: 24).accessibilityHidden(true)
                                }
                                Image(systemName: pair == choice.rawValue ? "checkmark.circle.fill" : "circle")
                            }.frame(minHeight: 44).foregroundStyle(palette.text)
                        }.accessibilityAddTraits(pair == choice.rawValue ? [.isSelected] : [])
                    }
                }.listRowBackground(palette.surface)
                Section("Mode") {
                    Picker("Mode", selection: $mode) {
                        ForEach(AppearanceMode.allCases) { choice in
                            Text(choice.rawValue.capitalized).tag(choice.rawValue)
                        }
                    }.pickerStyle(.segmented).padding(.vertical, 8)
                }.listRowBackground(palette.surface)
                Section {
                    Text(palette.name)
                    if mode == "system" { Text("Following your device appearance.") }
                    Text("Saved on this device.")
                }.foregroundStyle(palette.muted).listRowBackground(palette.surface)
            }
            .hubSurface()
            .navigationTitle("Appearance")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
