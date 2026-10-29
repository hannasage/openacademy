import Foundation
import SwiftUI

@MainActor
final class HubStore: ObservableObject {
    @Published private(set) var courses: [LearningBackup] = []
    @Published var connection = Connection(url: "", publishableKey: "")
    @Published var message = "Read the bundled course or connect your own backend."
    @Published private(set) var busy = false
    @Published private(set) var signedIn = false
    @Published private(set) var needsSignOutRetry = false
    @Published private(set) var lastRefresh: Date?
    @Published private(set) var readingIdentity = UUID()
    private let cache: ReadingCache?
    private let reader: ContractReader?
    private let defaults: UserDefaults
    private let bundled: LearningBackup?
    private var imports: [LearningBackup] = []
    private var importsLoadFailed = false
    private var downloaded: [PublishedCourse] = []
    private var scope: AccountScope?
    private var service: HubService?
    private let makeService: (Connection) -> HubService
    private var generation = 0
    private var pendingRemoval: AccountScope?

    convenience init() {
        let isolated = ProcessInfo.processInfo.arguments.contains("--touchline-ui-test") || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        let root = isolated ? FileManager.default.temporaryDirectory.appendingPathComponent("Touchline-UITests-" + UUID().uuidString) : FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Touchline", isDirectory: true)
        let reader = try? ContractReader()
        let cache = reader.flatMap { try? FileReadingCache(directory: root, reader: $0) }
        let curriculum = Bundle.main.url(forResource: "curriculum", withExtension: "json").flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONDecoder().decode(Curriculum.self, from: $0) }
        let defaults = isolated ? UserDefaults(suiteName: "Touchline-UITests-" + UUID().uuidString)! : .standard
        self.init(cache: cache, reader: reader, bundled: curriculum.map { LearningBackup(curriculum: $0, state: .empty(for: $0)) }, defaults: defaults, makeService: { connection in
            if isolated { return OfflineTestHubService() }
            return SupabaseHubService(connection: connection)
        })
        if isolated && ProcessInfo.processInfo.arguments.contains("--touchline-ui-test-signout-retry") {
            let account = UUID()
            connection = Connection(url: "https://example.invalid", publishableKey: "sb_publishable_test")
            service = OfflineTestHubService(accountID: account, signOutFailures: 1)
            try? activate(accountID: account)
        }
    }
    init(cache: ReadingCache?, reader: ContractReader?, bundled: LearningBackup?, defaults: UserDefaults, makeService: @escaping (Connection) -> HubService) {
        self.cache = cache; self.reader = reader; self.bundled = bundled; self.defaults = defaults; self.makeService = makeService
        do { imports = try cache?.loadImports() ?? [] }
        catch {
            importsLoadFailed = true
            message = "Local imports could not be read. The bundled curriculum remains available."
        }
        render()
        if cache == nil || reader == nil { message = "Saved data is unavailable. The bundled curriculum remains available." }
        else if cache?.hasUnownedLegacyCache == true { message = "An older download has no account identity. Its original file is preserved and is not shown. Import a trusted backup to read it." }
        if let data = defaults.data(forKey: "touchline.connection") {
            do { connection = try JSONDecoder().decode(Connection.self, from: data).validated(); installService() }
            catch { message = "The saved connection is invalid. Local reading remains available." }
        }
    }
    private func render() {
        var local = imports
        if let bundled, !local.contains(where: { $0.curriculum.id == bundled.curriculum.id }) { local.append(bundled) }
        courses = local.map { item in var item = item; item.readerID = "local:" + item.curriculum.id; return item }
        if let scope {
            courses += downloaded.map { snapshot in var item = snapshot.backup; item.readerID = scope.storageKey + ":" + item.curriculum.id; return item }
        }
    }
    private func installService() {
        service?.onAccountChange = nil
        let next = makeService(connection)
        service = next
        next.onAccountChange = { [weak self, weak next] accountID in
            guard let self, let next, self.service === next, let scope = self.scope, scope.accountID != accountID else { return }
            self.invalidateAccount(removeDownloads: true)
        }
    }
    private func invalidateAccount(removeDownloads: Bool) {
        let old = scope
        generation += 1; readingIdentity = UUID(); scope = nil; downloaded = []; signedIn = false; lastRefresh = nil
        defaults.removeObject(forKey: "touchline.activeScope")
        render()
        message = "The account session ended. Private downloads are hidden."
        if removeDownloads, let old {
            do { pendingRemoval = old; try cache?.remove(scope: old); pendingRemoval = nil }
            catch {
                needsSignOutRetry = true
                message = "Private downloads are hidden, but removal failed. Retry sign-out after storage is available."
            }
        }
    }
    private func requireGeneration(_ value: Int) throws {
        guard value == generation else { throw HubError.message("The account changed during this request. Try again.") }
    }
    private func requireCompletedCleanup() throws {
        guard pendingRemoval == nil else {
            throw HubError.message("Finish the pending download cleanup with Retry sign-out and cleanup before changing accounts or backends.")
        }
    }
    private func activate(accountID: UUID) throws {
        try requireCompletedCleanup()
        let next = try AccountScope.legacy(connection: connection, accountID: accountID)
        if scope != next { readingIdentity = UUID(); downloaded = []; lastRefresh = nil; scope = next; render() }
        signedIn = true
        defaults.set(try JSONEncoder().encode(next), forKey: "touchline.activeScope")
        let saved = try cache?.load(scope: next)
        downloaded = saved?.records ?? []; lastRefresh = saved?.refreshedAt; render()
    }
    func connect(_ value: Connection) async {
        guard !busy else { return }
        await perform {
            try self.requireCompletedCleanup()
            let valid = try value.validated()
            self.invalidateAccount(removeDownloads: true)
            try self.requireCompletedCleanup()
            do { if let service = self.service { try await service.signOut() } }
            catch { self.needsSignOutRetry = true; throw error }
            self.needsSignOutRetry = self.pendingRemoval != nil
            self.connection = valid; self.installService()
            self.defaults.set(try JSONEncoder().encode(valid), forKey: "touchline.connection")
            self.message = "Backend connected. Sign in with its owner account."
        }
    }
    func restoreSession() async {
        guard let service, let id = service.cachedAccountID, let data = defaults.data(forKey: "touchline.activeScope") else { return }
        do {
            let previous = try JSONDecoder().decode(AccountScope.self, from: data)
            guard previous == (try AccountScope.legacy(connection: connection, accountID: id)) else { invalidateAccount(removeDownloads: false); return }
            try activate(accountID: id)
        } catch { message = "Saved downloads could not be read. Local reading remains available." }
    }
    func signIn(email: String, password: String) async {
        await perform {
            try self.requireCompletedCleanup()
            guard let service = self.service else { throw HubError.message("Connect a backend first.") }
            self.invalidateAccount(removeDownloads: false)
            let epoch = self.generation
            let account = try await service.signIn(email: email, password: password)
            try self.requireGeneration(epoch)
            guard service.cachedAccountID == account else { throw HubError.message("The signed-in account changed. Try again.") }
            try self.activate(accountID: account)
            self.message = "Signed in. Refresh to download published courses."
        }
        if signedIn { await refresh() }
    }
    func signOut() async {
        let previous = scope ?? pendingRemoval
        invalidateAccount(removeDownloads: false)
        // Hiding happens before any await, including an interrupted transfer.
        var failures: [String] = []
        if let previous {
            pendingRemoval = previous
            do { try cache?.remove(scope: previous); pendingRemoval = nil }
            catch { failures.append("Download removal failed: " + error.localizedDescription) }
        }
        do { if let service { try await service.signOut() } }
        catch { failures.append("Account sign-out failed: " + error.localizedDescription) }
        needsSignOutRetry = !failures.isEmpty
        message = failures.isEmpty ? "Signed out. Local imports and the bundled curriculum remain available." : "Private downloads are hidden. " + failures.joined(separator: " ")
    }
    func refresh() async {
        await perform {
            guard let service = self.service, let scope = self.scope, self.signedIn, let reader = self.reader, let cache = self.cache else { throw HubError.message("Sign in before refreshing published courses.") }
            let epoch = self.generation
            let bytes = try await service.fetch(accountID: scope.accountID)
            try self.requireGeneration(epoch)
            guard bytes.count <= 20_000_000, let rows = try JSONSerialization.jsonObject(with: bytes) as? [[String: Any]], rows.count <= 100 else { throw HubError.message("The download is invalid or too large.") }
            let snapshots: [PublishedCourse] = try rows.map { row in
                // Compatibility with the current table. Later publishing supplies these fields directly.
                let snapshot: [String: Any] = ["format": "touchline-snapshot", "version": 1, "curriculum": row["curriculum"] ?? NSNull(), "progress": row["progress"] ?? NSNull(), "revision": row["revision"] ?? NSNull(), "status": row["status"] ?? "active", "publishedAt": Self.utcTimestamp(row["updated_at"] as? String ?? "")]
                return try reader.decode(JSONSerialization.data(withJSONObject: snapshot), schema: "published-course.v1.schema.json")
            }
            try self.requireGeneration(epoch)
            let now = Date()
            try cache.save(snapshots, scope: scope, refreshedAt: now)
            self.downloaded = snapshots; self.lastRefresh = now; self.render()
            self.message = snapshots.isEmpty ? "No published courses yet. Publish from the desktop hub." : "Downloaded \(snapshots.count) curricula for offline reading."
        }
    }
    private static func utcTimestamp(_ value: String) -> String {
        // PostgreSQL timestamps can include an offset and microseconds.
        let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = format.date(from: value) { format.formatOptions = [.withInternetDateTime]; return format.string(from: date) }
        format.formatOptions = [.withInternetDateTime]
        return format.date(from: value).map { format.string(from: $0) } ?? value
    }
    func importFile(_ url: URL) async {
        guard !busy else {
            message = "A request is in progress. Wait for it to finish, then import the file again."
            return
        }
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let bytes = try Data(contentsOf: url)
            guard bytes.count <= 2_000_000 else { throw HubError.message("The import must be smaller than 2 MB.") }
            if let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], object["format"] as? String == "touchline-connection" || object["publishableKey"] != nil {
                let next = try JSONDecoder().decode(Connection.self, from: bytes).validated()
                await connect(next)
                return
            }
        } catch { message = error.localizedDescription; return }
        await perform {
            guard let reader = self.reader, let cache = self.cache else { throw HubError.message("Local storage is unavailable.") }
            guard !self.importsLoadFailed else { throw HubError.message("Saved local imports could not be read. New imports are blocked to preserve the original file.") }
            let data = try Data(contentsOf: url)
            guard data.count <= 2_000_000 else { throw HubError.message("The import must be smaller than 2 MB.") }
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let backup: LearningBackup
            if object?["format"] as? String == "touchline-record" {
                let record: LocalRecord = try reader.decode(data, schema: "local-record.v2.schema.json"); backup = record.backup
            } else { backup = try reader.decode(data, schema: "legacy-backup.v1.schema.json") }
            var next = self.imports.filter { $0.curriculum.id != backup.curriculum.id }; next.insert(backup, at: 0)
            try cache.saveImports(next)
            self.imports = next; self.render(); self.message = "Imported \(backup.curriculum.title) as a local reading copy."
        }
    }
    private func perform(_ work: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { try await work() }
        catch { message = error.localizedDescription + " The last saved reading copies remain unchanged." }
    }
}
