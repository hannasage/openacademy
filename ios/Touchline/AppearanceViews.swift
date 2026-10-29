import SwiftUI

struct AppearanceButton: View {
    @Environment(\.hubPalette) private var palette
    @Environment(\.dynamicTypeSize) private var textSize
    @State private var showing = false
    @AccessibilityFocusState private var triggerFocused: Bool
    // A split-view sidebar can be compact even when its popover has room on iPad.
    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    var body: some View {
        Button { showing = true } label: { Label("Theme", systemImage: "paintpalette") }
            .labelStyle(.titleAndIcon)
            .accessibilityLabel("Appearance")
            .accessibilityIdentifier("appearance-trigger")
            .accessibilityFocused($triggerFocused)
            .popover(isPresented: $showing, attachmentAnchor: .rect(.bounds), arrowEdge: .top) {
                AppearanceView()
                    .frame(width: isPad ? 360 : nil)
                    .frame(height: isPad ? (textSize.isAccessibilitySize ? 700 : 560) : nil)
                    .presentationCompactAdaptation(.sheet)
                    .presentationDetents(textSize.isAccessibilitySize ? [.large] : [.height(560), .large])
                    .presentationDragIndicator(isPad ? .hidden : .visible)
                    .presentationCornerRadius(16)
                    .presentationBackground(palette.surface)
            }
            .onChange(of: showing) { _, value in if !value { triggerFocused = true } }
    }
}

struct AppearanceView: View {
    @AppStorage(AppearancePreferences.pairKey) private var pair = "bloom"
    @AppStorage(AppearancePreferences.modeKey) private var mode = "system"
    @Environment(\.hubPalette) private var palette
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.dynamicTypeSize) private var textSize
    @Environment(\.dismiss) private var dismiss
    private var selectedPair: ThemePair { AppearancePreferences.pair(rawValue: pair) }
    private var selectedMode: AppearanceMode { AppearancePreferences.mode(rawValue: mode) }
    private var controlBorder: Color { contrast == .increased ? palette.muted : palette.border }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Appearance").font(.title3.bold()).accessibilityAddTraits(.isHeader)
                VStack(alignment: .leading, spacing: 12) {
                    Text("Theme pair").font(.subheadline.weight(.medium)).accessibilityAddTraits(.isHeader)
                    ForEach(ThemePair.allCases) { choice in pairButton(choice) }
                }
                VStack(alignment: .leading, spacing: 12) {
                    Text("Mode").font(.subheadline.weight(.medium)).accessibilityAddTraits(.isHeader)
                    let layout = textSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 6)) : AnyLayout(HStackLayout(spacing: 6))
                    layout { ForEach(AppearanceMode.allCases) { choice in modeButton(choice) } }
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text(palette.name).fontWeight(.medium).accessibilityIdentifier("appearance-current")
                    Text(selectedMode == .system ? "Following your device · \(colorScheme == .dark ? "Dark" : "Light")" : "\(selectedMode.rawValue.capitalized) appearance")
                        .foregroundStyle(palette.muted).accessibilityIdentifier("appearance-resolution")
                    Text("Saved on this device.").foregroundStyle(palette.muted)
                }.font(.subheadline).fixedSize(horizontal: false, vertical: true)
                Button("Done") { dismiss() }
                    .font(.subheadline.weight(.medium))
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(controlBorder, lineWidth: 1))
                    .accessibilityIdentifier("appearance-done")
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(palette.text)
        .background(palette.surface)
        .buttonStyle(.plain)
        .accessibilityIdentifier("appearance-panel")
        .accessibilityAction(.escape) { dismiss() }
    }

    private func pairButton(_ choice: ThemePair) -> some View {
        let selected = selectedPair == choice
        return Button { pair = choice.rawValue } label: {
            HStack(spacing: 12) {
                Circle().fill(selected ? palette.accent : .clear)
                    .overlay(Circle().stroke(selected ? palette.accent : palette.muted, lineWidth: 1))
                    .frame(width: 18, height: 18).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(choice.darkName).fontWeight(.medium)
                    Text(choice.lightName).foregroundStyle(palette.muted)
                }
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(spacing: 4) {
                    ForEach([true, false], id: \.self) { dark in
                        let swatch = HubPalette(pair: choice, dark: dark)
                        Circle().fill(swatch.background)
                            .overlay(Circle().stroke(swatch.accent, lineWidth: 2))
                            .frame(width: 18, height: 18)
                    }
                }.frame(width: 20).accessibilityHidden(true)
            }
            .padding(.horizontal, 12).padding(.vertical, 14)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(palette.background, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? palette.accent : controlBorder, lineWidth: selected ? 2 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .accessibilityLabel("\(choice.darkName), \(choice.lightName)")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("appearance-pair-" + choice.rawValue)
    }

    private func modeButton(_ choice: AppearanceMode) -> some View {
        let selected = selectedMode == choice
        return Button { mode = choice.rawValue } label: {
            Text(choice.rawValue.capitalized)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(selected ? palette.primaryText : palette.text)
                .padding(.horizontal, 8).padding(.vertical, 10)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(selected ? palette.accent : palette.surface, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? palette.accent : controlBorder, lineWidth: 1))
                .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("appearance-mode-" + choice.rawValue)
    }
}
