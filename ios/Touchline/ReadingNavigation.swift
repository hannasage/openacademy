import SwiftUI

enum ReadingRoute: Hashable {
    case lesson(String), sources(String), offline(String), experiment(String)
    func exists(in copy: LearningBackup) -> Bool {
        switch self {
        case .lesson(let id), .sources(let id), .offline(let id): return copy.curriculum.modules.contains { $0.id == id }
        case .experiment(let id): return copy.state.experiments.contains { $0.id == id }
        }
    }
}

@MainActor
final class ReadingNavigation: ObservableObject {
    @Published var selected: String?
    @Published private var paths: [String: [ReadingRoute]] = [:]
    private var lastLessons: [String: String] = [:]
    func select(_ id: String?) { selected = id }
    func path(for id: String) -> [ReadingRoute] { paths[id] ?? [] }
    func setPath(_ path: [ReadingRoute], for id: String) {
        paths[id] = path
        for case .lesson(let module) in path { lastLessons[id] = module }
    }
    func resume(_ copy: LearningBackup) {
        selected = copy.id
        let module = copy.curriculum.modules.first { $0.id == lastLessons[copy.id] } ?? copy.nextModule
        if let module { setPath([.lesson(module.id)], for: copy.id) }
    }
    func reconcile(_ copies: [LearningBackup]) {
        let ids = Set(copies.map(\.id))
        if let selected, !ids.contains(selected) { self.selected = nil }
        paths = paths.filter { ids.contains($0.key) }
        lastLessons = lastLessons.filter { ids.contains($0.key) }
        for copy in copies { paths[copy.id] = Array(path(for: copy.id).prefix { $0.exists(in: copy) }) }
    }
}

enum ReadingSource {
    static func tutorPrompt(module: LearningModule, course: Curriculum, progress: ModuleProgress?) -> String {
        let task = module.tasks.enumerated().first { index, _ in !(progress?.tasks.indices.contains(index) == true && progress?.tasks[index] == true) }?.element ?? module.challenge
        let notes = progress?.notes.isEmpty == false ? progress!.notes : "None yet."
        let evidence = progress?.evidence.isEmpty == false ? progress!.evidence : "None yet."
        return """
        Act as my tutor for \(course.title). Module: \(module.title).
        Goal: \(module.outcome)
        Concepts: \(module.math)
        Task: \(task)
        My notes: \(notes)
        Evidence: \(evidence)
        I am an experienced software engineer learning through applied projects. Ask what I predict before showing code. Give one small hint at a time. Ask me to calculate or implement a small example myself. Explain notation through the project. Help me test claims and inspect errors. Do not treat generated code as proof of my understanding. End with this independent challenge: \(module.challenge)
        """
    }

    static func safeURL(_ value: String) -> URL? {
        guard let url = URL(string: value), ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return nil }
        return url
    }
}
