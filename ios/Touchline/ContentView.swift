import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @Environment(\.hubPalette) private var palette
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var columns: NavigationSplitViewVisibility = .all
    @EnvironmentObject private var store: HubStore
    @StateObject private var navigation = ReadingNavigation()
    @State private var showingConnection = false
    @State private var importing = false
    private var current: LearningBackup? { store.courses.first { $0.id == navigation.selected } }

    var body: some View {
        TabView {
            NavigationSplitView(columnVisibility: $columns) {
                ReadingLibraryView(copies: store.courses, selection: $navigation.selected, message: store.message, busy: store.busy, lastRefresh: store.lastRefresh)
                    .navigationTitle("Library")
                    .toolbar {
                        ToolbarItemGroup(placement: .topBarTrailing) {
                            AppearanceButton()
                            Button { importing = true } label: { Label("Import file", systemImage: "square.and.arrow.down") }
                            Button { showingConnection = true } label: { Label("Backend and account", systemImage: "person.crop.circle") }
                        }
                    }
            } detail: {
                if let copy = current {
                    NavigationStack(path: Binding(get: { navigation.path(for: copy.id) }, set: { navigation.setPath($0, for: copy.id) })) {
                        ReadingCourseView(copy: copy, resume: { navigation.resume(copy) })
                            .toolbar { ToolbarItem(placement: .topBarTrailing) { AppearanceButton() } }
                            .navigationDestination(for: ReadingRoute.self) { route in
                                ReadingDestination(copy: copy, route: route)
                                    .toolbar { ToolbarItem(placement: .topBarTrailing) { AppearanceButton() } }
                            }
                    }
                } else {
                    ContentUnavailableView("Choose a curriculum", systemImage: "books.vertical", description: Text("Read a lesson, revisit your progress, or open a source."))
                        .hubSurface()
                }
            }
            .navigationSplitViewStyle(.balanced)
            .onChange(of: navigation.selected) { _, selected in
                if sizeClass == .regular { columns = selected == nil ? .all : .detailOnly }
            }
            .tabItem { Label("Library", systemImage: "books.vertical") }
            NavigationStack {
                ReadingDownloadsView(copies: store.courses, message: store.message, lastRefresh: store.lastRefresh,
                    busy: store.busy, signedIn: store.signedIn,
                    refresh: { Task { await store.refresh() } }, connect: { showingConnection = true })
                .toolbar { ToolbarItem(placement: .topBarTrailing) { AppearanceButton() } }
            }
            .tabItem { Label("Devices", systemImage: "ipad.and.iphone") }
        }
        .background(palette.background)
        .environment(\.openURL, OpenURLAction { url in
            ProcessInfo.processInfo.arguments.contains("--touchline-ui-test") ? .discarded : .systemAction(url)
        })
        .sheet(isPresented: $showingConnection) { ConnectionView().environmentObject(store) }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            if case .success(let url) = result { Task { await store.importFile(url) } }
            if case .failure(let error) = result { store.message = error.localizedDescription }
        }
        .onReceive(store.$courses) { navigation.reconcile($0) }
        .onChange(of: store.readingIdentity) { _, _ in navigation.reconcile(store.courses) }
        .task { await store.restoreSession() }
    }
}
struct ConnectionView: View {
    @Environment(\.hubPalette) private var palette
    @EnvironmentObject var store: HubStore
    @Environment(\.dismiss) var dismiss
    @State private var url = ""
    @State private var key = ""
    @State private var email = ""
    @State private var password = ""
    var body: some View {
        NavigationStack {
            Form {
                Section("Your Supabase backend") {
                    TextField("Project URL", text: $url).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Publishable key", text: $key).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Connect backend") { Task { await store.connect(Connection(url: url, publishableKey: key)) } }
                    Text("You can also import touchline-connection.json from the desktop hub. Changing backends clears downloaded courses.")
                        .font(.subheadline).foregroundStyle(palette.muted)
                }.listRowBackground(palette.surface)
                Section("Owner account") {
                    TextField("Email", text: $email).keyboardType(.emailAddress).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Password", text: $password).textContentType(.password)
                    Button("Sign in") {
                        Task { await store.signIn(email: email, password: password); password = "" }
                    }.disabled(email.isEmpty || password.isEmpty)
                    if store.signedIn || store.needsSignOutRetry {
                        Button(store.needsSignOutRetry ? "Retry sign-out and cleanup" : "Sign out and remove downloaded copies", role: .destructive) {
                            Task { await store.signOut() }
                        }.accessibilityIdentifier("sign-out")
                    }
                    Text("Create and confirm your owner account in the desktop hub first. This app only signs in to your chosen backend.")
                        .font(.subheadline).foregroundStyle(palette.muted)
                }.listRowBackground(palette.surface)
                Section { Text(store.message) }.listRowBackground(palette.surface)
            }
            .hubSurface()
            .disabled(store.busy)
            .navigationTitle("Connection")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear { url = store.connection.url; key = store.connection.publishableKey }
        }
    }
}
