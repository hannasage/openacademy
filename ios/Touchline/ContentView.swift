import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @Environment(\.hubPalette) private var palette
    @EnvironmentObject private var store: HubStore
    @State private var selected: String?
    @State private var showingConnection = false
    @State private var showingAppearance = false
    @State private var importing = false
    private var current: LearningBackup? { store.courses.first { $0.id == selected } }

    var body: some View {
        NavigationSplitView {
            List(selection: $selected) {
                Section {
                    ForEach(store.courses) { backup in
                        NavigationLink(value: backup.id) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(backup.curriculum.title).font(.headline)
                                Text("\(backup.state.modules.values.filter { $0.status == "complete" }.count) of \(backup.curriculum.modules.count) modules complete")
                                    .font(.subheadline).foregroundStyle(palette.muted)
                            }.padding(.vertical, 4)
                        }
                    }
                } header: { Text("Your curricula") }
                .listRowBackground(palette.surface)
                Section {
                    Text(store.message).font(.subheadline).foregroundStyle(palette.muted)
                    if let refreshed = store.lastRefresh {
                        Text("Downloaded \(refreshed.formatted(date: .abbreviated, time: .shortened))").font(.caption)
                    }
                }.listRowBackground(palette.surface)
            }
            .hubSurface()
            .navigationTitle("Touchline")
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showingAppearance = true } label: { Label("Appearance", systemImage: "paintpalette") }
                    Button { importing = true } label: { Label("Import file", systemImage: "square.and.arrow.down") }
                    Button { showingConnection = true } label: { Label("Backend and account", systemImage: "person.crop.circle") }
                }
                ToolbarItem(placement: .bottomBar) {
                    Button { Task { await store.refresh() } } label: { Label("Refresh published courses", systemImage: "arrow.clockwise") }
                        .disabled(store.busy || !store.signedIn)
                }
            }
            .overlay { if store.busy { ProgressView("Updating…").padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12)) } }
        } detail: {
            NavigationStack {
                if let backup = current {
                    CourseView(backup: backup)
                } else {
                    ContentUnavailableView("Choose a curriculum", systemImage: "books.vertical", description: Text("Read a lesson, revisit your progress, or open a source."))
                        .hubSurface()
                }
            }.id(store.readingIdentity)
        }
        .background(palette.background)
        .sheet(isPresented: $showingAppearance) { AppearanceView() }
        .sheet(isPresented: $showingConnection) { ConnectionView().environmentObject(store) }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            if case .success(let url) = result { Task { await store.importFile(url) } }
            if case .failure(let error) = result { store.message = error.localizedDescription }
        }
        .task { await store.restoreSession() }
    }
}
struct CourseView: View {
    @Environment(\.hubPalette) private var palette
    let backup: LearningBackup
    var body: some View {
        List {
            Section {
                Text(backup.curriculum.description)
                LabeledContent("Duration", value: "\(backup.curriculum.weeks) weeks")
                LabeledContent("Study time", value: "\(backup.state.modules.values.reduce(0) { $0 + $1.hours }.formatted()) hours")
                Text("This is a saved reading copy. Update progress in the desktop hub, publish it, then refresh here.")
                    .font(.subheadline).foregroundStyle(palette.muted)
            }.listRowBackground(palette.surface)
            Section("Learning path") {
                ForEach(backup.curriculum.modules) { module in
                    NavigationLink {
                        ModuleView(module: module, course: backup.curriculum, progress: backup.state.modules[module.id])
                    } label: {
                        HStack {
                            Image(systemName: backup.state.modules[module.id]?.status == "complete" ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(.tint)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(module.title)
                                Text("Weeks \(module.weekStart.formatted())–\(module.weekEnd.formatted()) · \(module.phase)")
                                    .font(.caption).foregroundStyle(palette.muted)
                            }
                        }.padding(.vertical, 4)
                    }.listRowBackground(palette.surface)
                }
            }
            if !backup.state.experiments.isEmpty {
                Section("Experiments") {
                    ForEach(backup.state.experiments) { experiment in
                        NavigationLink(experiment.title) {
                            List {
                                Section("Hypothesis and setup") { Text(experiment.hypothesis) }.listRowBackground(palette.surface)
                                Section("Result and next step") { Text(experiment.result.isEmpty ? "Planned. Results are not recorded yet." : experiment.result) }.listRowBackground(palette.surface)
                                Section { Text(experiment.date) }.listRowBackground(palette.surface)
                            }.hubSurface().navigationTitle(experiment.title).textSelection(.enabled)
                        }
                    }
                }.listRowBackground(palette.surface)
            }
        }.hubSurface().navigationTitle(backup.curriculum.title).navigationBarTitleDisplayMode(.inline)
    }
}
struct ModuleView: View {
    @Environment(\.hubPalette) private var palette
    let module: LearningModule
    let course: Curriculum
    let progress: ModuleProgress?
    var body: some View {
        List {
            Section {
                Text(module.question).font(.title2).fontDesign(.serif)
                Text(module.outcome)
                LabeledContent("Status", value: progress?.status.replacingOccurrences(of: "-", with: " ") ?? "Not started")
            }.listRowBackground(palette.surface)
            Section("The experiment") {
                ForEach(Array(module.tasks.enumerated()), id: \.offset) { index, task in
                    Label(task, systemImage: (progress?.tasks.indices.contains(index) == true && progress?.tasks[index] == true) ? "checkmark.circle.fill" : "circle")
                        .padding(.vertical, 4)
                }
            }.listRowBackground(palette.surface)
            Section("Ideas behind the code") { Text(module.math) }.listRowBackground(palette.surface)
            Section("Your rhythm") { ForEach(module.weeks, id: \.self) { Text($0) } }.listRowBackground(palette.surface)
            Section("Data") { Text(module.dataset) }.listRowBackground(palette.surface)
            Section("Read with a question") {
                Text(module.reading)
                ForEach(module.resources, id: \.self) { id in
                    if let resource = course.resources[id], let url = URL(string: resource.url) {
                        Link(destination: url) {
                            VStack(alignment: .leading, spacing: 6) {
                                Label(resource.title, systemImage: "arrow.up.right.square")
                                Text(resource.use).font(.subheadline).foregroundStyle(palette.muted)
                            }.padding(.vertical, 4)
                        }
                    }
                }
            }.listRowBackground(palette.surface)
            Section("Show what you know") { Text(module.evidence); Text(module.challenge) }.listRowBackground(palette.surface)
            if let progress {
                Section("Your evidence") { Text(progress.evidence.isEmpty ? "No evidence recorded yet." : progress.evidence) }.listRowBackground(palette.surface)
                Section("Your notes") { Text(progress.notes.isEmpty ? "No notes recorded yet." : progress.notes) }.listRowBackground(palette.surface)
            }
        }.hubSurface().navigationTitle(module.title).navigationBarTitleDisplayMode(.inline).textSelection(.enabled)
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
