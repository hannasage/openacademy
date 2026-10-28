import Foundation
import Supabase
import SwiftUI

@MainActor
final class HubStore: ObservableObject {
    @Published var courses: [LearningBackup] = []
    @Published var connection = Connection(url: "", publishableKey: "")
    @Published var message = "Read the bundled course or connect your own backend."
    @Published var busy = false
    @Published var signedIn = false
    @Published var lastRefresh: Date?
    private var client: SupabaseClient?
    private let directory: URL

    init() {
        directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Touchline", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let file = directory.appendingPathComponent("courses.json")
            if FileManager.default.fileExists(atPath: file.path) {
                courses = try JSONDecoder().decode([LearningBackup].self, from: Data(contentsOf: file))
                message = "Reading saved copies. Refresh to fetch newer published progress."
            }
            if let data = UserDefaults.standard.data(forKey: "touchline.connection") {
                connection = try JSONDecoder().decode(Connection.self, from: data).validated()
                configureClient()
            }
            lastRefresh = UserDefaults.standard.object(forKey: "touchline.lastRefresh") as? Date
            if courses.isEmpty, let url = Bundle.main.url(forResource: "curriculum", withExtension: "json") {
                let c = try JSONDecoder().decode(Curriculum.self, from: Data(contentsOf: url))
                courses = [LearningBackup(curriculum: c, state: .empty(for: c))]
            }
        } catch { message = "Saved data could not be read: \(error.localizedDescription). Import a backup to recover." }
    }
    private func configureClient() {
        guard let url = URL(string: connection.url) else { return }
        client = SupabaseClient(supabaseURL: url, supabaseKey: connection.publishableKey)
    }
    private func persist() throws {
        try JSONEncoder().encode(courses).write(to: directory.appendingPathComponent("courses.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func connect(_ value: Connection) async {
        await perform {
            let valid = try value.validated()
            if let existing = self.client { try await existing.auth.signOut(scope: .local) }
            self.connection = valid
            self.configureClient()
            self.signedIn = false
            // Different projects never share cached private learning records.
            self.courses = []
            self.lastRefresh = nil
            UserDefaults.standard.removeObject(forKey: "touchline.lastRefresh")
            try self.persist()
            UserDefaults.standard.set(try JSONEncoder().encode(valid), forKey: "touchline.connection")
            self.message = "Backend connected. Sign in with its owner account."
        }
    }
    func restoreSession() async {
        guard let client else { return }
        do { _ = try await client.auth.session; signedIn = true }
        catch { signedIn = false }
    }
    func signIn(email: String, password: String) async {
        await perform {
            guard let client = self.client else { throw HubError.message("Connect a backend first.") }
            _ = try await client.auth.signIn(email: email, password: password)
            self.signedIn = true
            self.message = "Signed in. Refresh to download published courses."
        }
        if signedIn { await refresh() }
    }
    func signOut() async {
        await perform {
            if let client = self.client { try await client.auth.signOut() }
            self.signedIn = false
            self.courses = []
            self.lastRefresh = nil
            try self.persist()
            UserDefaults.standard.removeObject(forKey: "touchline.lastRefresh")
            self.message = "Signed out. Downloaded private courses were removed from this device."
        }
    }
    func refresh() async {
        await perform {
            guard let client = self.client else { throw HubError.message("Connect your backend first.") }
            let rows: [CloudCourse] = try await client.from("learning_courses").select().order("updated_at", ascending: false).execute().value
            let incoming = rows.map { LearningBackup(curriculum: $0.curriculum, state: $0.progress) }
            for item in incoming { try self.validate(item) }
            // Keep local imports until a matching course replaces them.
            self.courses = incoming + self.courses.filter { old in !incoming.contains(where: { $0.id == old.id }) }
            try self.persist()
            self.lastRefresh = Date()
            UserDefaults.standard.set(self.lastRefresh, forKey: "touchline.lastRefresh")
            self.message = rows.isEmpty ? "No published courses yet. Publish a course from the desktop hub." : "Downloaded \(rows.count) courses for offline reading."
        }
    }
    func importFile(_ url: URL) async {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            guard data.count <= 2_000_000 else { throw HubError.message("The import must be smaller than 2 MB.") }
            if let c = try? JSONDecoder().decode(Connection.self, from: data) { await connect(c); return }
            let backup = try JSONDecoder().decode(LearningBackup.self, from: data)
            try validate(backup)
            courses.removeAll { $0.id == backup.id }
            courses.insert(backup, at: 0)
            try persist()
            message = "Imported \(backup.curriculum.title). This is an offline snapshot."
        } catch { message = error.localizedDescription }
    }
    private func validate(_ backup: LearningBackup) throws {
        guard backup.state.curriculumId == backup.id, !backup.curriculum.modules.isEmpty,
              Set(backup.curriculum.modules.map(\.id)).count == backup.curriculum.modules.count else {
            throw HubError.message("The curriculum and progress do not match.")
        }
        for resource in backup.curriculum.resources.values {
            guard let url = URL(string: resource.url), ["https", "http"].contains(url.scheme ?? "") else {
                throw HubError.message("A resource contains an unsupported link.")
            }
        }
    }
    private func perform(_ work: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { try await work() } catch { message = error.localizedDescription + " Your saved reading copies remain available." }
    }
}
