import SwiftUI

struct ReadingLibraryView: View {
    @Environment(\.hubPalette) private var palette
    let copies: [LearningBackup]
    @Binding var selection: String?
    let message: String
    let busy: Bool
    let lastRefresh: Date?
    private var focus: LearningBackup? { copies.first { $0.isPublishedFocus } }
    private func matches(_ copy: LearningBackup, status: LibraryStatus) -> Bool { copy.readingStatus == status && !copy.isPublishedFocus }
    var body: some View {
        List(selection: $selection) {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Text(focus == nil ? "Your learning library" : "Your current focus")
                        .font(.title.bold()).accessibilityAddTraits(.isHeader)
                    Text("One focus helps. Other plans stay open.").foregroundStyle(palette.muted)
                    if focus == nil { Text("Set and publish a focus from the desktop hub when you are ready.").font(.subheadline).foregroundStyle(palette.muted) }
                }.listRowBackground(palette.background).listRowSeparator(.hidden)
                if let focus { courseLink(focus).listRowBackground(palette.surface) }
            }
            courseSection(focus == nil ? "Active curricula" : "Also active", copies.filter { matches($0, status: .active) })
            courseSection("Paused", copies.filter { matches($0, status: .paused) })
            courseSection("Completed", copies.filter { matches($0, status: .completed) })
            courseSection("Saved for later", copies.filter { matches($0, status: .saved) })
            courseSection("On this device", copies.filter { $0.readingSource != .downloaded })
            if copies.isEmpty {
                Section { ContentUnavailableView("No reading copies", systemImage: "books.vertical", description: Text("Import a curriculum backup or connect your hub to download published lessons.")) }.listRowBackground(palette.surface)
            }
            Section {
                Text("Switching lessons keeps your published focus. Each curriculum remembers your place while the app is open.").font(.subheadline).foregroundStyle(palette.muted)
                ReadingStatus(message: message, busy: busy, lastRefresh: lastRefresh)
            }.listRowBackground(palette.background)
        }
        .listStyle(.insetGrouped).hubSurface()
    }
    @ViewBuilder private func courseSection(_ title: String, _ items: [LearningBackup]) -> some View {
        if !items.isEmpty {
            Section(title) { ForEach(items) { courseLink($0) } }.listRowBackground(palette.surface)
        }
    }
    private func courseLink(_ copy: LearningBackup) -> some View {
        NavigationLink(value: copy.id) {
            VStack(alignment: .leading, spacing: 12) {
                Text(copy.curriculum.title).font(copy.isPublishedFocus ? .title2.bold() : .headline).fixedSize(horizontal: false, vertical: true)
                Text(copy.progressLabel).font(.subheadline).foregroundStyle(palette.muted)
                ProgressView(value: Double(copy.completedModules), total: Double(max(copy.curriculum.modules.count, 1)))
                    .accessibilityLabel("Module progress").accessibilityValue(copy.progressLabel)
                Text(copy.isPublishedFocus ? "Published focus · Downloaded" : copy.readingSource.label).font(.caption).foregroundStyle(palette.muted)
                if let next = copy.nextModule { Text("Next: " + next.title).font(.subheadline) }
            }.padding(.vertical, 12)
        }
        .accessibilityIdentifier("course-" + copy.curriculum.id + (copy.readingSource == .downloaded ? "-downloaded" : "-local"))
    }
}

struct ReadingStatus: View {
    @Environment(\.hubPalette) private var palette
    let message: String
    let busy: Bool
    let lastRefresh: Date?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if busy { ProgressView("Updating saved copies") }
            Text(message).font(.subheadline).accessibilityIdentifier("reading-status")
            if let lastRefresh { Text("Last successful download: " + lastRefresh.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(palette.muted) }
        }.accessibilityElement(children: .contain)
    }
}

struct ReadingCourseView: View {
    @Environment(\.hubPalette) private var palette
    let copy: LearningBackup
    let resume: () -> Void
    var body: some View {
        List {
            Section {
                Text(copy.curriculum.title).font(.largeTitle.bold()).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                Text(copy.curriculum.description)
                Text(copy.isPublishedFocus ? "Your published focus" : copy.readingSource.label).font(.subheadline).foregroundStyle(palette.muted)
                Text(copy.progressLabel)
                LabeledContent("Study time", value: hoursLabel(copy.state.modules.values.reduce(0) { $0 + $1.hours }))
                Button("Continue reading", action: resume).buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("continue-reading")
                Text("Reading another curriculum does not change your focus.").font(.subheadline).foregroundStyle(palette.muted)
            }.listRowBackground(palette.surface)
            Section("Learning path") {
                ForEach(copy.curriculum.modules) { module in
                    NavigationLink(value: ReadingRoute.lesson(module.id)) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(module.title).font(.headline).fixedSize(horizontal: false, vertical: true)
                            Text("Weeks \(module.weekStart.formatted())–\(module.weekEnd.formatted()) · " + readableStatus(copy.state.modules[module.id]?.status)).font(.subheadline).foregroundStyle(palette.muted)
                        }.padding(.vertical, 6)
                    }.accessibilityIdentifier("lesson-" + module.id)
                }
            }.listRowBackground(palette.surface)
            Section("Experiments") {
                if copy.state.experiments.isEmpty { Text("No experiments in this reading copy yet.").foregroundStyle(palette.muted) }
                ForEach(copy.state.experiments) { experiment in
                    NavigationLink(value: ReadingRoute.experiment(experiment.id)) {
                        VStack(alignment: .leading, spacing: 6) { Text(experiment.title).font(.headline); Text(experiment.date).font(.subheadline).foregroundStyle(palette.muted) }
                    }.accessibilityIdentifier("experiment-" + experiment.id)
                }
            }.listRowBackground(palette.surface)
            Section { ReadingCopyNote(copy: copy) }.listRowBackground(palette.background)
        }.hubSurface().navigationTitle("Curriculum").navigationBarTitleDisplayMode(.inline)
    }
}

struct ReadingDestination: View {
    let copy: LearningBackup
    let route: ReadingRoute
    var body: some View {
        switch route {
        case .lesson(let id):
            if let module = copy.curriculum.modules.first(where: { $0.id == id }) { ReadingLessonView(copy: copy, module: module) }
        case .sources(let id):
            if let module = copy.curriculum.modules.first(where: { $0.id == id }) { ReadingSourcesView(module: module, curriculum: copy.curriculum, progress: copy.state.modules[module.id]) }
        case .offline(let id):
            if let module = copy.curriculum.modules.first(where: { $0.id == id }) { OfflineLessonView(copy: copy, module: module) }
        case .experiment(let id):
            if let experiment = copy.state.experiments.first(where: { $0.id == id }) { ReadingExperimentView(experiment: experiment) }
        }
    }
}

struct ReadingLessonView: View {
    @Environment(\.hubPalette) private var palette
    let copy: LearningBackup
    let module: LearningModule
    private var progress: ModuleProgress? { copy.state.modules[module.id] }
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 16) {
                    Text(module.question).font(.largeTitle.bold()).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                    Text(module.outcome).foregroundStyle(palette.muted)
                    Text("Weeks \(module.weekStart.formatted())–\(module.weekEnd.formatted()) · " + readableStatus(progress?.status)).font(.subheadline)
                }
            }.listRowBackground(palette.background)
            Section("Your applied challenge") {
                Text(module.challenge)
                ForEach(Array(module.tasks.enumerated()), id: \.offset) { index, task in
                    let done = progress?.tasks.indices.contains(index) == true && progress?.tasks[index] == true
                    Label(task, systemImage: done ? "checkmark.circle.fill" : "circle")
                        .padding(.vertical, 4).accessibilityLabel((done ? "Complete: " : "Not complete: ") + task)
                }
            }.listRowBackground(palette.surface)
            Section {
                NavigationLink(value: ReadingRoute.sources(module.id)) { Text("Read sources · \(module.resources.count) links") }.accessibilityIdentifier("read-sources")
                NavigationLink("View downloaded lesson", value: ReadingRoute.offline(module.id)).accessibilityIdentifier("offline-lesson")
            }.listRowBackground(palette.surface)
            Section("Your published progress") {
                LabeledContent("Study time", value: hoursLabel(progress?.hours ?? 0))
                Text("Evidence").font(.headline).accessibilityAddTraits(.isHeader)
                Text(progress?.evidence.isEmpty == false ? progress!.evidence : "No evidence recorded yet.")
                Text("Notes").font(.headline).accessibilityAddTraits(.isHeader)
                Text(progress?.notes.isEmpty == false ? progress!.notes : "No notes recorded yet.")
            }.listRowBackground(palette.surface)
            Section { ReadingCopyNote(copy: copy) }.listRowBackground(palette.background)
        }.hubSurface().navigationTitle(module.title).navigationBarTitleDisplayMode(.inline).textSelection(.enabled)
    }
}

struct ReadingSourcesView: View {
    @Environment(\.hubPalette) private var palette
    @Environment(\.openURL) private var openURL
    let module: LearningModule
    let curriculum: Curriculum
    let progress: ModuleProgress?
    @State private var failedSource: String?
    var body: some View {
        List {
            Section {
                Text("The ideas behind your experiment.").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                Text(module.reading)
                Text("External sources need an internet connection. Downloaded lessons do not include linked books or datasets.").font(.subheadline).foregroundStyle(palette.muted)
            }.listRowBackground(palette.background)
            ForEach(module.resources, id: \.self) { id in
                if let resource = curriculum.resources[id] {
                    Section {
                        Text(resource.title).font(.title2.bold()).accessibilityAddTraits(.isHeader)
                        Text(resource.use).foregroundStyle(palette.muted)
                        Button("Open source") { open(resource) }
                            .accessibilityLabel("Open " + resource.title).accessibilityIdentifier("source-" + id)
                            .buttonStyle(.bordered).controlSize(.large)
                        if failedSource == resource.title {
                            Text("This source did not open. Check your connection and try again. Your lesson stays open here.")
                                .accessibilityIdentifier("source-error")
                            if let url = ReadingSource.safeURL(resource.url) { ShareLink("Share source link", item: url) }
                        }
                    }.listRowBackground(palette.surface)
                }
            }
            if module.resources.isEmpty { Section { Text("This lesson has no linked sources.") }.listRowBackground(palette.surface) }
            Section("Your AI tutor") {
                Text("Ask for one hint at a time, then explain the result in your own words.").foregroundStyle(palette.muted)
                DisclosureGroup("View tutor prompt") {
                    let prompt = ReadingSource.tutorPrompt(module: module, course: curriculum, progress: progress)
                    Text(prompt).textSelection(.enabled)
                    Text("This prompt includes notes and evidence from your saved copy. Choose what to share.").font(.subheadline).foregroundStyle(palette.muted)
                    ShareLink("Share tutor prompt", item: prompt)
                }
            }.listRowBackground(palette.surface)
        }.hubSurface().navigationTitle("Read & explore").navigationBarTitleDisplayMode(.inline).textSelection(.enabled)
    }
    private func open(_ resource: LearningResource) {
        guard let url = ReadingSource.safeURL(resource.url) else { failedSource = resource.title; return }
        openURL(url) { accepted in if !accepted { failedSource = resource.title } else { failedSource = nil } }
    }
}

struct OfflineLessonView: View {
    @Environment(\.hubPalette) private var palette
    let copy: LearningBackup
    let module: LearningModule
    var body: some View {
        List {
            Section {
                Text("Keep reading.").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                Text("This lesson is available on this device without a connection.")
                if let saved = copy.downloadedAt { Text("Saved " + saved.formatted(date: .abbreviated, time: .shortened)).font(.subheadline).foregroundStyle(palette.muted) }
            }.listRowBackground(palette.background)
            Section("Ideas behind the code") { Text(module.math) }.listRowBackground(palette.surface)
            Section("Your rhythm") { ForEach(module.weeks, id: \.self) { Text($0) } }.listRowBackground(palette.surface)
            Section("Data") { Text(module.dataset) }.listRowBackground(palette.surface)
            Section("Show what you know") { Text(module.evidence) }.listRowBackground(palette.surface)
            Section { Text("Linked books and datasets need their own downloads. Refresh from Devices when you want newer published progress.").font(.subheadline).foregroundStyle(palette.muted) }.listRowBackground(palette.background)
        }.hubSurface().navigationTitle("Downloaded lesson").navigationBarTitleDisplayMode(.inline).textSelection(.enabled)
    }
}

struct ReadingExperimentView: View {
    @Environment(\.hubPalette) private var palette
    let experiment: Experiment
    var body: some View {
        List {
            Section { Text(experiment.title).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader); Text(experiment.date).foregroundStyle(palette.muted) }.listRowBackground(palette.background)
            Section("Hypothesis and setup") { Text(experiment.hypothesis) }.listRowBackground(palette.surface)
            Section("Result and next step") { Text(experiment.result.isEmpty ? "Planned. Results are not recorded yet." : experiment.result) }.listRowBackground(palette.surface)
            Section { Text("Continue experiments in the desktop hub.").font(.subheadline).foregroundStyle(palette.muted) }.listRowBackground(palette.background)
        }.hubSurface().navigationTitle("Experiment").navigationBarTitleDisplayMode(.inline).textSelection(.enabled)
    }
}

struct ReadingDownloadsView: View {
    @Environment(\.hubPalette) private var palette
    let copies: [LearningBackup]
    let message: String
    let lastRefresh: Date?
    let busy: Bool
    let signedIn: Bool
    let refresh: () -> Void
    let connect: () -> Void
    var body: some View {
        List {
            Section {
                Text("Keep learning offline").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                Text("These reading copies are saved on this device. Linked books and datasets need their own downloads.").foregroundStyle(palette.muted)
                Button("Backend and account", action: connect).buttonStyle(.bordered).controlSize(.large)
                Button("Refresh published courses", action: refresh).buttonStyle(.borderedProminent).controlSize(.large).disabled(busy || !signedIn)
            }.listRowBackground(palette.background)
            Section("Saved on this device") {
                ForEach(copies) { copy in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(copy.curriculum.title).font(.headline)
                        Text(copy.readingSource.label + (copy.readingStatus.map { " · " + $0.rawValue.capitalized } ?? "")).font(.subheadline).foregroundStyle(palette.muted)
                        Text(copy.progressLabel).font(.subheadline)
                    }.padding(.vertical, 6)
                }
                if copies.isEmpty { Text("No reading copies yet. Connect your hub or import a backup from Library.") }
            }.listRowBackground(palette.surface)
            Section { ReadingStatus(message: message, busy: busy, lastRefresh: lastRefresh) }.listRowBackground(palette.background)
        }.hubSurface().navigationTitle("Devices").navigationBarTitleDisplayMode(.inline)
    }
}

private struct ReadingCopyNote: View {
    @Environment(\.hubPalette) private var palette
    let copy: LearningBackup
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(copy.readingSource == .downloaded ? "Progress comes from your last published snapshot. Update it on desktop, publish, then refresh here." : "This is a local reading copy. Update learning records in the desktop hub.")
            if let saved = copy.downloadedAt { Text("Last downloaded " + saved.formatted(date: .abbreviated, time: .shortened)) }
        }.font(.subheadline).foregroundStyle(palette.muted)
    }
}
private func readableStatus(_ value: String?) -> String { (value ?? "not started").replacingOccurrences(of: "-", with: " ").capitalized }

private func hoursLabel(_ value: Double) -> String { value.formatted() + (value == 1 ? " hour" : " hours") }
