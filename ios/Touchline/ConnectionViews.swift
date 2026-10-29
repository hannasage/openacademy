import SwiftUI
import AVFoundation

struct ConnectionView: View {
    @EnvironmentObject private var store: HubStore
    @Environment(\.hubPalette) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var email = ""
    @State private var code = ""
    @State private var findingAnother = false
    @State private var scanning = false
    @State private var cameraMessage: String?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if store.needsSignOutRetry { signOut }
                    if let candidate = store.candidateHub { review(candidate) }
                    else if findingAnother || store.hub == nil && !store.signedIn { discovery }
                    else if store.signedIn { downloadSelection }
                    else if let email = store.codeEmail { confirmation(email) }
                    else if let hub = store.hub { signIn(hub) }
                    if store.signedIn && !store.needsSignOutRetry { signOut }
                    if store.busy { ProgressView("Connecting…").accessibilityIdentifier("connection-progress") }
                    Text(store.message).font(.subheadline).foregroundStyle(palette.muted).accessibilityIdentifier("connection-message")
                }
                .frame(maxWidth: 560, alignment: .leading).padding(24).frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .hubSurface()
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { store.cancelConnectionAttempt(); dismiss() } } }
            .sheet(isPresented: $scanning) {
                HubScannerView { result in
                    scanning = false
                    switch result {
                    case .success(let link): address = link; Task { await store.discoverHub(link) }
                    case .failure(let error): cameraMessage = error.localizedDescription
                    }
                }
            }
            .onDisappear { store.cancelConnectionAttempt() }
        }
    }
    private var title: String {
        if store.candidateHub != nil { return "Review your hub" }
        if findingAnother || store.hub == nil && !store.signedIn { return "Connect your hub" }
        if store.signedIn { return "Keep learning offline" }
        return store.codeEmail == nil ? "Sign in" : "Check your email"
    }
    private func heading(_ text: String) -> some View { Text(text).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader) }
    private func note(_ text: String) -> some View { Text(text).font(.body).foregroundStyle(palette.muted) }
    private func action(_ text: String, primary: Bool = false, _ work: @escaping () -> Void) -> some View {
        Button(action: work) { Text(text).font(.body.weight(.medium)).frame(maxWidth: .infinity).frame(minHeight: 44) }
            .buttonStyle(ConnectionButtonStyle(primary: primary)).disabled(store.busy)
    }
    private var discovery: some View {
        Group {
            heading("Find your learning hub.")
            note("Scan the hub code on your desktop, or open a link someone has shared with you.")
            action("Scan hub QR code", primary: true) {
                Task {
                    let permission = ProcessInfo.processInfo.arguments.contains("--touchline-ui-test") ? false : await HubCameraPermission.request()
                    if permission { scanning = true; cameraMessage = nil }
                    else { cameraMessage = "Camera access is unavailable. Allow it in Settings, or enter your hub address below." }
                }
            }
            if let cameraMessage { note(cameraMessage).accessibilityIdentifier("camera-message") }
            Text("Or enter your hub address").font(.headline)
            field("Hub address", text: $address).keyboardType(.URL).textContentType(.URL).accessibilityIdentifier("hub-address")
            action("Find my hub") { Task { await store.discoverHub(address) } }
            note("The app discovers the connection settings. You will confirm the destination before signing in.")
            Divider()
            Text("No hub yet?").font(.title2.bold())
            note("Create your private hub from the desktop setup. You can return here when it is ready.")
            if findingAnother { action("Keep current hub") { findingAnother = false } }
        }
    }
    private func review(_ hub: HubDescription) -> some View {
        Group {
            heading(hub.name)
            note("Check these addresses before continuing. A hub link does not grant account access.")
            identity(hub)
            if store.hub != nil { note("Changing hubs signs out the current account and removes its private downloads from this device. Local imports stay available.") }
            action("Use this hub", primary: true) { Task { await store.confirmHub(); if store.candidateHub == nil { findingAnother = false } } }
            action("Cancel") { store.cancelHubReview() }
        }
    }
    private func identity(_ hub: HubDescription) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Hub address").font(.headline)
            Text(hub.hubOrigin).textSelection(.enabled).foregroundStyle(palette.link)
            Text("Backend address").font(.headline)
            Text(hub.backend.url).textSelection(.enabled)
            Text("Hub ID").font(.headline)
            Text(hub.hubId.uuidString.lowercased()).font(.subheadline).textSelection(.enabled)
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading).background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
    }
    private func signIn(_ hub: HubDescription) -> some View {
        Group {
            heading(hub.name)
            Text(hub.hubOrigin).foregroundStyle(palette.link).textSelection(.enabled)
            note("Check the address before continuing.")
            field("Email", text: $email).keyboardType(.emailAddress).textContentType(.emailAddress).accessibilityIdentifier("signin-email")
            action("Email me a sign-in code", primary: true) { Task { await store.requestCode(email: email) } }
            note("No password to create or remember.")
            if !hub.auth.providers.isEmpty {
                Divider()
                ForEach(hub.auth.providers, id: \.self) { provider in
                    action("Continue with " + (provider == "google" ? "Google" : "Apple")) { Task { await store.signIn(provider: provider) } }
                }
                note("Additional sign-in methods enabled by this hub.")
            }
            action("Use a different hub") { findingAnother = true }
            note("This hub is private. Signing in does not give an unapproved account access.")
        }
    }
    private func confirmation(_ email: String) -> some View {
        Group {
            heading("A code, and you are in.")
            note("Enter the code sent to\n" + email)
            field("Sign-in code", text: $code).textContentType(.oneTimeCode).keyboardType(.asciiCapable).accessibilityIdentifier("signin-code")
            action("Verify & continue", primary: true) { Task { await store.verifyCode(code); code = "" } }
            action("Send a new code") { Task { await store.requestCode(email: email) } }
            note("Code expired? Request another here.\nConnection lost? Try again when online.")
            action("Use another email") { code = ""; store.useAnotherEmail() }
        }
    }
    private var downloadSelection: some View {
        Group {
            heading("What would you like to take with you?")
            note("Your focus is selected first. Add any other curricula you want to read.")
            if store.availableDownloads.isEmpty {
                note("Load the published library to choose downloads. Existing reading copies stay available offline.")
            }
            ForEach(store.availableDownloads, id: \.id) { snapshot in
                VStack(alignment: .leading, spacing: 12) {
                    Toggle(isOn: Binding(get: { store.selectedDownloads.contains(snapshot.id) }, set: { store.selectDownload(snapshot.id, selected: $0) })) {
                        Text(snapshot.title).font(.title3.bold())
                    }.toggleStyle(.switch).disabled(store.busy).accessibilityIdentifier("download-choice-" + snapshot.id)
                    Text((store.isPublishedFocus(snapshot.id) ? "Focus" : snapshot.status.rawValue.capitalized) + " · " + store.downloadedProgress(snapshot.id)).font(.subheadline).foregroundStyle(palette.muted)
                    if let result = store.downloadResults[snapshot.id] { Text(result).font(.subheadline) }
                    if store.courses.contains(where: { $0.readingSource == .downloaded && $0.curriculum.id == snapshot.id }) {
                        Button("Remove download", role: .destructive) { store.removeDownload(snapshot.id) }.disabled(store.busy)
                    }
                }.padding(20).background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
            }
            let savedOnly = store.courses.filter { copy in copy.readingSource == .downloaded && !store.availableDownloads.contains { $0.id == copy.curriculum.id } }
            if !savedOnly.isEmpty {
                Text("Saved on this device").font(.title2.bold())
                ForEach(savedOnly) { copy in
                    VStack(alignment: .leading, spacing: 12) {
                        Text(copy.curriculum.title).font(.title3.bold())
                        Text(copy.progressLabel).font(.subheadline).foregroundStyle(palette.muted)
                        Button("Remove download", role: .destructive) { store.removeDownload(copy.curriculum.id) }
                            .frame(minHeight: 44).disabled(store.busy)
                            .accessibilityLabel("Remove download: " + copy.curriculum.title)
                            .accessibilityIdentifier("remove-download-" + copy.curriculum.id)
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading).background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            action("Download selected · \(store.selectedDownloads.count)", primary: true) { Task { await store.downloadSelected() } }
                .disabled(store.selectedDownloads.isEmpty)
            action("Reload published library") { Task { await store.loadDownloadChoices() } }
            note("Only published lessons and progress are downloaded. Linked books and datasets need their own downloads.")
            note("Removing a download keeps the curriculum and its progress in your hub.")
            action("Use a different hub") { findingAnother = true }
        }
    }
    private var signOut: some View {
        Button(store.needsSignOutRetry ? "Retry sign-out and cleanup" : "Sign out and remove downloaded copies", role: .destructive) {
            Task { await store.signOut() }
        }.frame(minHeight: 44).accessibilityIdentifier("sign-out")
    }
    private func field(_ label: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.headline)
            TextField(label, text: text).textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(12).frame(minHeight: 48).background(palette.surface, in: RoundedRectangle(cornerRadius: 8)).disabled(store.busy)
        }
    }
}
private struct ConnectionButtonStyle: ButtonStyle {
    @Environment(\.hubPalette) private var palette
    let primary: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.padding(.horizontal, 12).padding(.vertical, 2)
            .foregroundStyle(primary ? palette.primaryText : palette.text)
            .background(primary ? palette.accent : palette.surface, in: RoundedRectangle(cornerRadius: 8))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}
