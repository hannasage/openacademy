import Foundation

struct LearningResource: Codable { let title: String; let url: String; let use: String }
struct LearningModule: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let phase: String
    let question: String
    let outcome: String
    let math: String
    let tasks: [String]
    let weeks: [String]
    let evidence: String
    let challenge: String
    let resources: [String]
    let reading: String
    let dataset: String
    let hours: Double
    let weekStart: Double
    let weekEnd: Double
    let prerequisites: [String]
}
struct Curriculum: Codable, Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let description: String
    let weeks: Int
    let weeklyHours: Double
    let resources: [String: LearningResource]
    let modules: [LearningModule]
    let nextPhase: [String]?
}
struct ModuleProgress: Codable {
    let status: String
    let tasks: [Bool]
    let notes: String
    let evidence: String
    let hours: Double
}
struct Experiment: Codable, Identifiable {
    let id: String; let date: String; let module: String
    let title: String; let hypothesis: String; let result: String
}
struct LearningProgress: Codable {
    let version: Int
    let revision: Int
    let curriculumId: String
    let weeklyHours: Double
    let startDate: String
    let modules: [String: ModuleProgress]
    let experiments: [Experiment]
    static func empty(for c: Curriculum) -> Self {
        Self(version: 1, revision: 0, curriculumId: c.id, weeklyHours: c.weeklyHours, startDate: "", modules: [:], experiments: [])
    }
}
struct LearningBackup: Codable, Identifiable {
    var readerID: String? = nil
    var id: String { readerID ?? curriculum.id }
    enum CodingKeys: String, CodingKey { case curriculum, state }
    let curriculum: Curriculum
    let state: LearningProgress
}
struct CloudCourse: Decodable {
    let curriculum: Curriculum
    let progress: LearningProgress
    let revision: Int
    let updated_at: String
}
struct Connection: Codable {
    var url: String
    var publishableKey: String
    func validated() throws -> Connection {
        guard let u = URL(string: url), u.scheme == "https", u.host != nil,
              u.user == nil, u.password == nil, u.path.isEmpty || u.path == "/", u.query == nil, u.fragment == nil,
              !publishableKey.isEmpty, !publishableKey.hasPrefix("sb_secret_") else {
            throw HubError.message("Use an HTTPS project URL and a publishable key. Never enter a secret key.")
        }
        if publishableKey.hasPrefix("ey") {
            let parts = publishableKey.split(separator: ".")
            guard parts.count == 3 else { throw HubError.message("Invalid publishable key.") }
            var segment = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            segment += String(repeating: "=", count: (4 - segment.count % 4) % 4)
            guard let data = Data(base64Encoded: segment),
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any], json["role"] as? String == "anon" else {
                throw HubError.message("Only a publishable key or legacy anon key is allowed.")
            }
        }
        var result = self
        result.url = try AccountScope.canonicalOrigin(url)
        return result
    }
}
enum HubError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}


enum LibraryStatus: String, Codable { case active, paused, completed, saved }
struct PublishedCourse: Codable {
    let format: String
    let version: Int
    let curriculum: Curriculum
    let progress: LearningProgress
    let status: LibraryStatus
    let revision: Int
    let publishedAt: String
    var backup: LearningBackup { LearningBackup(curriculum: curriculum, state: progress) }
}
struct PublishedLibrary: Codable {
    let version: Int
    let revision: Int
    let focusCurriculumId: String?
}
struct LocalRecord: Decodable {
    struct Origin: Decodable { let kind: String; let hubId: UUID?; let backendOrigin: String?; let accountId: UUID? }
    struct ViewState: Decodable { let selectedModuleId: String }
    struct Draft: Decodable {
        struct PendingExperiment: Decodable { let id: String?; let date: String; let module: String; let title: String; let hypothesis: String; let result: String }
        let experiment: PendingExperiment?
    }
    let format: String
    let version: Int
    let recordId: UUID
    let origin: Origin
    let curriculum: Curriculum
    let state: LearningProgress
    let status: LibraryStatus
    let view: ViewState
    let draft: Draft
    var backup: LearningBackup { LearningBackup(curriculum: curriculum, state: state) }
}
struct HubDescription: Codable {
    struct Backend: Codable { let type: String; let url: String; let publishableKey: String }
    struct Contracts: Codable { let snapshot: Int; let progress: Int }
    struct Auth: Codable { let email: String; let providers: [String] }
    let format: String
    let version: Int
    let hubId: UUID
    let name: String
    let hubOrigin: String
    let backend: Backend
    let contracts: Contracts
    let auth: Auth
}
