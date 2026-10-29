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
    @Published private(set) var hub: HubDescription?
    @Published private(set) var candidateHub: HubDescription?
    @Published private(set) var codeEmail: String?
    @Published private(set) var availableDownloads: [DownloadChoice] = []
    @Published private(set) var selectedDownloads: Set<String> = []
    @Published private(set) var downloadResults: [String: String] = [:]
    private let makeHubService: @MainActor (HubDescription) -> HubService
    private let discovery: HubDiscovering?
    private var authInProgress = false
    private let cache: ReadingCache?
    private let reader: ContractReader?
    private let defaults: UserDefaults
    private let bundled: LearningBackup?
    private var imports: [LearningBackup] = []
    private var importsLoadFailed = false
    private var downloaded: [PublishedCourse] = []
    private var downloadedAt: [String: Date] = [:]
    private var publishedLibrary: PublishedLibrary?
    private var scope: AccountScope?
    private var service: HubService?
    private let makeService: (Connection) -> HubService
    private var generation = 0
    private var connectionGeneration = 0
    private var cleanupStateInvalid = false
    private var cleanupRequired = false
    private var cleanupMarkerFailed = false
    private var pendingRemoval: AccountScope?

    convenience init() {
        let isolated = ProcessInfo.processInfo.arguments.contains("--touchline-ui-test") || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        let connectionFixture = isolated && ProcessInfo.processInfo.arguments.contains("--touchline-ui-test-connection")
        let root = isolated ? FileManager.default.temporaryDirectory.appendingPathComponent("Touchline-UITests-" + UUID().uuidString) : FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Touchline", isDirectory: true)
        let reader = try? ContractReader()
        let cache = reader.flatMap { try? FileReadingCache(directory: root, reader: $0) }
        let curriculum = Bundle.main.url(forResource: "curriculum", withExtension: "json").flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONDecoder().decode(Curriculum.self, from: $0) }
        let defaults = isolated ? UserDefaults(suiteName: "Touchline-UITests-" + UUID().uuidString)! : .standard
        self.init(cache: cache, reader: reader, bundled: curriculum.map { LearningBackup(curriculum: $0, state: .empty(for: $0)) }, defaults: defaults, makeService: { connection in
            if isolated { return OfflineTestHubService() }
            return SupabaseHubService(connection: connection)
        }, makeHubService: { hub in
            if connectionFixture { return NativeConnectionFixtureService(curriculum: curriculum) }
            if isolated { return OfflineTestHubService() }
            return SupabaseHubService(connection: hub.connection, hub: hub)
        }, discovery: connectionFixture ? NativeConnectionFixtureDiscovery() : (isolated ? nil : reader.map { HubDiscovery(reader: $0) }))
        if isolated && ProcessInfo.processInfo.arguments.contains("--touchline-ui-test-reading"), let curriculum, let cache {
            do {
                let account = UUID()
                connection = Connection(url: "https://example.invalid", publishableKey: "sb_publishable_test")
                service = OfflineTestHubService(accountID: account)
                let scope = try AccountScope.legacy(connection: connection, accountID: account)
                let records = try ["reading-one", "reading-two"].enumerated().map { index, id in
                    var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(curriculum)) as! [String: Any]
                    json["id"] = id
                    json["title"] = index == 0 ? "Soccer forecasts and the experiments behind reliable probabilities" : "Creative coding with light, color, and motion"
                    let course = try JSONDecoder().decode(Curriculum.self, from: JSONSerialization.data(withJSONObject: json))
                    let first = course.modules[0]
                    let progress = LearningProgress(version: 1, revision: 1, curriculumId: id, weeklyHours: course.weeklyHours, startDate: "", modules: [first.id: ModuleProgress(status: "active", tasks: first.tasks.map { _ in false }, notes: index == 0 ? "First course notes" : "Second course notes", evidence: "", hours: Double(index + 1))], experiments: [Experiment(id: "experiment-" + id, date: "2026-10-28", module: first.id, title: "Experiment for " + id, hypothesis: "An isolated test hypothesis", result: index == 0 ? "First result" : "Second result")])
                    return PublishedCourse(format: "touchline-snapshot", version: 1, curriculum: course, progress: progress, status: index == 0 ? .active : .paused, revision: 1, publishedAt: "2026-10-28T12:00:00Z")
                }
                try cache.save(records, scope: scope, refreshedAt: Date(timeIntervalSince1970: 1_793_188_800), library: PublishedLibrary(version: 1, revision: 1, focusCurriculumId: "reading-one"))
                try activate(accountID: account)
            } catch { message = "The reading test fixture failed: " + error.localizedDescription }
        }
        if isolated && ProcessInfo.processInfo.arguments.contains("--touchline-ui-test-signout-retry") {
            let account = UUID()
            connection = Connection(url: "https://example.invalid", publishableKey: "sb_publishable_test")
            service = OfflineTestHubService(accountID: account, signOutFailures: 1)
            try? activate(accountID: account)
        }
    }
    init(cache: ReadingCache?, reader: ContractReader?, bundled: LearningBackup?, defaults: UserDefaults, makeService: @escaping (Connection) -> HubService,
         makeHubService: @escaping @MainActor (HubDescription) -> HubService = { SupabaseHubService(connection: $0.connection, hub: $0) }, discovery: HubDiscovering? = nil) {
        self.cache = cache; self.reader = reader; self.bundled = bundled; self.defaults = defaults; self.makeService = makeService; self.makeHubService = makeHubService; self.discovery = discovery
        do {
            if let intent = try cache?.loadCleanup() { pendingRemoval = intent.scope; cleanupRequired = true; needsSignOutRetry = true }
        } catch { cleanupStateInvalid = true; needsSignOutRetry = true; message = "Saved cleanup information could not be read. Private copies stay hidden until it is restored." }
        do { imports = try cache?.loadImports() ?? [] }
        catch {
            importsLoadFailed = true
            message = "Local imports could not be read. The bundled curriculum remains available."
        }
        render()
        if cache == nil || reader == nil { message = "Saved data is unavailable. The bundled curriculum remains available." }
        else if cache?.hasUnownedLegacyCache == true { message = "An older download has no account identity. Its original file is preserved and is not shown. Import a trusted backup to read it." }
        if let data = defaults.data(forKey: "touchline.hub"), let reader {
            do {
                let saved: HubDescription = try reader.decode(data, schema: "hub-description.v1.schema.json")
                hub = saved; connection = try saved.connection.validated(); installService()
            } catch { message = "The saved hub is invalid. Local reading remains available." }
        } else if let data = defaults.data(forKey: "touchline.connection") {
            do { connection = try JSONDecoder().decode(Connection.self, from: data).validated(); installService() }
            catch { message = "The saved connection is invalid. Local reading remains available." }
        }
    }
    private func render() {
        var local = imports
        if var bundled, !local.contains(where: { $0.curriculum.id == bundled.curriculum.id }) { bundled.readingSource = .bundled; local.append(bundled) }
        var next = local.map { item in var item = item; item.readerID = "local:" + item.curriculum.id; return item }
        if let scope {
            next += downloaded.map { snapshot in
                var item = snapshot.backup
                item.readerID = scope.storageKey + ":" + item.curriculum.id
                item.readingStatus = snapshot.status; item.readingSource = .downloaded; item.downloadedAt = downloadedAt[snapshot.curriculum.id] ?? lastRefresh
                item.isPublishedFocus = snapshot.status == .active && publishedLibrary?.focusCurriculumId == snapshot.curriculum.id
                return item
            }
        }
        courses = next
    }
    private func installService() {
        service?.onAccountChange = nil
        let next: HubService
        if let hub { next = makeHubService(hub) } else { next = makeService(connection) }
        service = next
        next.onAccountChange = { [weak self, weak next] accountID in
            guard let self, let next, self.service === next, let scope = self.scope, scope.accountID != accountID else { return }
            self.invalidateAccount(removeDownloads: true)
        }
    }
    private func invalidateAccount(removeDownloads: Bool) {
        let old = scope
        var markerSaved = true
        if removeDownloads {
            do { try recordCleanup(old ?? pendingRemoval) }
            catch { markerSaved = false; cleanupMarkerFailed = true; pendingRemoval = old ?? pendingRemoval; cleanupRequired = true; needsSignOutRetry = true }
        }
        generation += 1; availableDownloads = []; selectedDownloads = []; downloadResults = [:]; codeEmail = nil; readingIdentity = UUID(); scope = nil; downloaded = []; downloadedAt = [:]; publishedLibrary = nil; signedIn = false; lastRefresh = nil
        defaults.removeObject(forKey: "touchline.activeScope")
        render()
        message = "The account session ended. Private downloads are hidden."
        if removeDownloads, !markerSaved {
            message = "Private downloads are hidden, but cleanup could not be recorded. Retry sign-out when storage is available."
        } else if removeDownloads, let old {
            do { pendingRemoval = old; try cache?.remove(scope: old); pendingRemoval = nil }
            catch {
                needsSignOutRetry = true
                message = "Private downloads are hidden, but removal failed. Retry sign-out after storage is available."
            }
        }
    }
    private func recordCleanup(_ old: AccountScope?) throws {
        guard let cache, !cleanupStateInvalid else { throw HubError.message("Cleanup storage is unavailable.") }
        try cache.saveCleanup(scope: old)
        pendingRemoval = old; cleanupRequired = true; needsSignOutRetry = true; cleanupMarkerFailed = false
    }
    private func finishCleanup() throws {
        guard let cache, pendingRemoval == nil else { throw HubError.message("Download cleanup is unfinished.") }
        try cache.clearCleanup()
        cleanupRequired = false; cleanupMarkerFailed = false; needsSignOutRetry = false
    }
    private func requireGeneration(_ value: Int) throws {
        guard value == generation else { throw HubError.message("The account changed during this request. Try again.") }
    }
    private func requireCompletedCleanup() throws {
        guard pendingRemoval == nil, !cleanupStateInvalid, !cleanupRequired else {
            throw HubError.message("Finish the pending download cleanup with Retry sign-out and cleanup before changing accounts or backends.")
        }
    }
    private func activate(accountID: UUID) throws {
        try requireCompletedCleanup()
        let next = try accountScope(accountID)
        // Validate the existing file before enabling writes for this account.
        guard let cache else { throw HubError.message("Reading storage is unavailable.") }
        let saved = try cache.load(scope: next)
        if scope != next { readingIdentity = UUID(); downloaded = []; publishedLibrary = nil; lastRefresh = nil; scope = next; render() }
        signedIn = true
        defaults.set(try JSONEncoder().encode(next), forKey: "touchline.activeScope")
        downloaded = saved?.records ?? []; downloadedAt = saved?.downloadedAt ?? [:]; selectedDownloads = Set(downloaded.map { $0.curriculum.id }); publishedLibrary = saved?.library; lastRefresh = saved?.refreshedAt; render()
    }
    func connect(_ value: Connection) async {
        guard !busy else { return }
        await perform {
            try self.requireCompletedCleanup()
            let valid = try value.validated()
            self.invalidateAccount(removeDownloads: true)
            guard self.pendingRemoval == nil, !self.cleanupStateInvalid, !self.cleanupMarkerFailed else { throw HubError.message("Retry sign-out and cleanup before changing hubs.") }
            do { if let service = self.service { try await service.signOut() } }
            catch { self.needsSignOutRetry = true; throw error }
            try self.finishCleanup()
            self.connection = valid; self.installService()
            self.defaults.set(try JSONEncoder().encode(valid), forKey: "touchline.connection")
            self.message = "Backend connected. Sign in with its owner account."
        }
    }
    func restoreSession() async {
        guard !needsSignOutRetry, let service, let id = service.cachedAccountID, let data = defaults.data(forKey: "touchline.activeScope") else { return }
        do {
            let previous = try JSONDecoder().decode(AccountScope.self, from: data)
            guard previous == (try accountScope(id)) else { invalidateAccount(removeDownloads: false); return }
            try activate(accountID: id)
            if hub != nil {
                let epoch = generation
                do { _ = try await service.verifyAccount(); try requireGeneration(epoch) }
                catch {
                    guard generation == epoch else { return }
                    if SupabaseHubService.denied(error) { invalidateAccount(removeDownloads: true); needsSignOutRetry = true; message = pendingRemoval == nil ? "This session no longer has access. Private downloads are hidden. Sign in again after cleanup." : "This session no longer has access. Private downloads are hidden, but removal failed. Retry sign-out after storage is available." }
                    else { message = "The hub is unavailable. Saved downloads remain available offline." }
                }
            }
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
        guard !cleanupStateInvalid else {
            message = "Saved cleanup information is damaged. Private copies stay hidden. Restore the app data from a trusted backup before connecting again."
            return
        }
        let previous = scope ?? pendingRemoval
        do { try recordCleanup(previous) }
        catch {
            pendingRemoval = previous; cleanupRequired = true; needsSignOutRetry = true; cleanupMarkerFailed = true
            invalidateAccount(removeDownloads: false)
            message = "Private downloads are hidden, but sign-out could not be recorded. Retry when storage is available."
            return
        }
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
        if failures.isEmpty {
            do { try finishCleanup() }
            catch { failures.append("Saved cleanup could not be completed: " + error.localizedDescription) }
        }
        needsSignOutRetry = !failures.isEmpty
        message = failures.isEmpty ? "Signed out. Local imports and the bundled curriculum remain available." : "Private downloads are hidden. " + failures.joined(separator: " ")
    }
    func refresh() async {
        if hub != nil { await downloadSelected(); return }
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
            let libraryBytes = try await service.fetchLibrary(accountID: scope.accountID)
            try self.requireGeneration(epoch)
            var library: PublishedLibrary?
            if let libraryBytes {
                guard libraryBytes.count <= 10_000, let rows = try JSONSerialization.jsonObject(with: libraryBytes) as? [[String: Any]], rows.count <= 1 else { throw HubError.message("The published library is invalid.") }
                if let row = rows.first {
                    guard let value = row["snapshot"] else { throw HubError.message("The published library is missing its snapshot.") }
                    library = try reader.decode(JSONSerialization.data(withJSONObject: value), schema: "published-library.v1.schema.json")
                }
            }
            let now = Date()
            try cache.save(snapshots, scope: scope, refreshedAt: now, library: library)
            self.publishedLibrary = library; self.downloaded = snapshots; self.lastRefresh = now; self.render()
            self.message = snapshots.isEmpty ? "No published courses yet. Publish from the desktop hub." : "Downloaded \(snapshots.count) curricula for offline reading."
        }
    }
    private func accountScope(_ account: UUID) throws -> AccountScope {
        if let hub { return try hub.scope(accountID: account) }
        return try AccountScope.legacy(connection: connection, accountID: account)
    }
    func discoverHub(_ input: String) async {
        await perform {
            guard let discovery = self.discovery else { throw HubError.message("Hub discovery is unavailable in this test.") }
            let epoch = self.generation, visit = self.connectionGeneration
            let candidate = try await discovery.discover(input)
            try self.requireGeneration(epoch); try self.requireConnectionGeneration(visit)
            self.candidateHub = candidate
            self.message = "Review this hub and its backend before continuing."
        }
    }
    func cancelHubReview() { candidateHub = nil }
    func confirmHub() async {
        guard let candidate = candidateHub else { return }
        await perform {
            try self.requireCompletedCleanup()
            guard let reader = self.reader else { throw HubError.message("Connection validation is unavailable.") }
            try reader.validate(JSONEncoder().encode(candidate), schema: "hub-description.v1.schema.json")
            let valid = try candidate.connection.validated(), visit = self.connectionGeneration
            self.invalidateAccount(removeDownloads: true)
            guard self.pendingRemoval == nil, !self.cleanupStateInvalid, !self.cleanupMarkerFailed else { throw HubError.message("Retry sign-out and cleanup before changing hubs.") }
            do { try await self.service?.signOut() }
            catch { self.needsSignOutRetry = true; throw error }
            try self.finishCleanup()
            try self.requireConnectionGeneration(visit)
            self.hub = candidate; self.connection = valid; self.installService()
            self.defaults.set(try JSONEncoder().encode(candidate), forKey: "touchline.hub")
            self.candidateHub = nil; self.needsSignOutRetry = false
            self.message = "Hub confirmed. Sign in to its owner account."
        }
    }
    func requestCode(email: String) async {
        await perform {
            try self.requireCompletedCleanup()
            guard self.hub != nil, let service = self.service, !self.needsSignOutRetry else { throw HubError.message("Confirm a hub and finish sign-out cleanup first.") }
            let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
            guard address.count <= 254, address.contains("@"), !address.contains(where: { $0.isWhitespace }) else { throw HubError.message("Enter your email address.") }
            let epoch = self.generation, visit = self.connectionGeneration
            try await service.requestCode(email: address)
            try self.requireGeneration(epoch); try self.requireConnectionGeneration(visit)
            self.codeEmail = address; self.message = "Enter the code sent to " + address + "."
        }
    }
    func useAnotherEmail() { codeEmail = nil }
    func verifyCode(_ code: String) async {
        guard let email = codeEmail else { return }
        await authenticate { service in
            guard !code.isEmpty, code.count <= 128, !code.contains(where: { $0.isWhitespace }) else { throw HubError.message("Enter the sign-in code from your email.") }
            return try await service.verifyCode(email: email, code: code)
        }
    }
    func signIn(provider: String) async {
        guard hub?.auth.providers.contains(provider) == true else { return }
        await authenticate { try await $0.signIn(provider: provider) }
    }
    private func authenticate(_ work: (HubService) async throws -> UUID) async {
        await perform {
            try self.requireCompletedCleanup()
            guard let service = self.service, self.hub != nil, !self.needsSignOutRetry else { throw HubError.message("Confirm a hub and finish sign-out cleanup first.") }
            let epoch = self.generation
            self.authInProgress = true
            defer { self.authInProgress = false }
            let account = try await work(service)
            try self.requireGeneration(epoch)
            guard service.cachedAccountID == account else { throw HubAccessError.unauthorized }
            try self.activate(accountID: account)
            self.codeEmail = nil
            self.message = "Signed in. Choose curricula to keep offline."
        }
        if signedIn { await loadDownloadChoices() }
    }
    private func requireConnectionGeneration(_ value: Int) throws {
        guard value == connectionGeneration else { throw HubError.message("The connection screen was closed. Start the request again when ready.") }
    }
    func cancelConnectionAttempt() {
        connectionGeneration += 1
        candidateHub = nil
        if authInProgress { generation += 1; service?.cancelAuthentication() }
    }
    func loadDownloadChoices() async {
        await perform {
            guard let scope = self.scope, let service = self.service, self.signedIn else { throw HubError.message("Sign in first.") }
            let epoch = self.generation
            let bytes = try await service.fetchCatalog(accountID: scope.accountID)
            try self.requireGeneration(epoch)
            guard bytes.count <= 2_000_000 else { throw HubError.message("The published catalog is too large.") }
            let rows = try self.downloadRows(bytes)
            var snapshots: [DownloadChoice] = []; var invalid = 0
            let counts = Dictionary(grouping: rows.compactMap { $0["id"] as? String }, by: { $0 }).mapValues(\.count)
            for row in rows {
                do {
                    let snapshot = try DownloadChoice.decode(row)
                    guard counts[snapshot.id] == 1 else { throw HubError.message("The hub returned duplicate curricula.") }
                    snapshots.append(snapshot)
                } catch { invalid += 1 }
            }
            let library = try await self.readLibrary(service, scope: scope, epoch: epoch)
            try self.requireGeneration(epoch)
            self.publishedLibrary = library
            self.availableDownloads = snapshots.sorted {
                let left = $0.status == .active && $0.id == library?.focusCurriculumId
                let right = $1.status == .active && $1.id == library?.focusCurriculumId
                return left != right ? left : $0.title.localizedStandardCompare($1.title) == .orderedAscending
            }
            self.selectedDownloads.formUnion(self.downloaded.map { $0.curriculum.id })
            if self.selectedDownloads.isEmpty, let first = self.availableDownloads.first, first.status == .active, first.id == library?.focusCurriculumId { self.selectedDownloads.insert(first.id) }
            self.render()
            self.message = invalid == 0 ? "Choose the curricula you want to read offline." : "Some publications are invalid and cannot be downloaded. Valid copies remain available."
        }
    }
    func downloadedProgress(_ id: String) -> String { downloaded.first { $0.curriculum.id == id }?.backup.progressLabel ?? "Published" }
    func isPublishedFocus(_ id: String) -> Bool { publishedLibrary?.focusCurriculumId == id && availableDownloads.contains { $0.id == id && $0.status == .active } }
    func selectDownload(_ id: String, selected: Bool) {
        guard !busy, availableDownloads.contains(where: { $0.id == id }) else { return }
        if selected { selectedDownloads.insert(id) } else { selectedDownloads.remove(id) }
    }
    func downloadSelected() async {
        await perform {
            guard let scope = self.scope, let service = self.service, let cache = self.cache, self.signedIn else { throw HubError.message("Sign in before downloading curricula.") }
            let epoch = self.generation
            // Restore the existing selection after an offline launch; never infer it from remote order.
            let selected = self.selectedDownloads
            guard !selected.isEmpty else { throw HubError.message("Choose at least one curriculum to download.") }
            var libraryWarning = false
            do { self.publishedLibrary = try await self.readLibrary(service, scope: scope, epoch: epoch) }
            catch {
                try self.requireGeneration(epoch)
                if SupabaseHubService.denied(error) { throw error }
                libraryWarning = true
            }
            var successes = 0; var failures = 0
            for id in selected.sorted() {
                do {
                    let bytes = try await service.fetchCourse(accountID: scope.accountID, curriculumID: id)
                    try self.requireGeneration(epoch)
                    let rows = try self.downloadRows(bytes)
                    guard rows.count == 1 else { throw HubError.message("This publication is no longer available. Its saved copy was kept.") }
                    let snapshot = try self.decodeDownload(rows[0])
                    guard snapshot.curriculum.id == id else { throw HubError.message("The returned curriculum does not match this download.") }
                    var next = self.downloaded.filter { $0.curriculum.id != id }; next.append(snapshot)
                    let now = Date()
                    var dates = self.downloadedAt
                    for old in self.downloaded where dates[old.curriculum.id] == nil { dates[old.curriculum.id] = self.lastRefresh ?? now }
                    dates[id] = now
                    try cache.save(next, scope: scope, refreshedAt: now, library: self.publishedLibrary, downloadedAt: dates)
                    self.downloadedAt = dates; self.downloaded = next; self.lastRefresh = now; self.render()
                    self.downloadResults[id] = "Downloaded"; successes += 1
                } catch {
                    try self.requireGeneration(epoch)
                    if SupabaseHubService.denied(error) { throw error }
                    self.downloadResults[id] = error.localizedDescription; failures += 1
                }
            }
            self.message = "Downloaded \(successes) curricula." + (failures > 0 ? " \(failures) could not refresh. Their last saved copies were kept." : " Ready for offline reading.") + (libraryWarning ? " Published focus could not refresh; its last saved value was kept." : "")
        }
    }
    func removeDownload(_ id: String) {
        guard !busy, let scope, let cache else { return }
        do {
            let next = downloaded.filter { $0.curriculum.id != id }
            var dates = downloadedAt; dates.removeValue(forKey: id)
            try cache.save(next, scope: scope, refreshedAt: lastRefresh ?? Date(), library: publishedLibrary, downloadedAt: dates)
            downloadedAt = dates; downloaded = next; selectedDownloads.remove(id); downloadResults[id] = "Removed from this device"; render()
            message = "Download removed. The curriculum and its progress remain in your hub."
        } catch { message = "The download could not be removed. Its saved copy is unchanged." }
    }
    private func downloadRows(_ bytes: Data) throws -> [[String: Any]] {
        guard bytes.count <= 20_000_000, let rows = try JSONSerialization.jsonObject(with: bytes) as? [[String: Any]], rows.count <= 100 else { throw HubError.message("The download is invalid or too large.") }
        return rows
    }
    private func decodeDownload(_ row: [String: Any]) throws -> PublishedCourse {
        guard let reader, row["format_version"] as? Int == 1, let id = row["id"] as? String else { throw HubError.message("This publication version is unsupported.") }
        let snapshot: [String: Any] = ["format": "touchline-snapshot", "version": 1, "curriculum": row["curriculum"] ?? NSNull(), "progress": row["progress"] ?? NSNull(), "revision": row["revision"] ?? NSNull(), "status": row["status"] ?? NSNull(), "publishedAt": Self.utcTimestamp(row["updated_at"] as? String ?? "")]
        let decoded: PublishedCourse = try reader.decode(JSONSerialization.data(withJSONObject: snapshot), schema: "published-course.v1.schema.json")
        guard id == decoded.curriculum.id else { throw HubError.message("The publication has mismatched curriculum identifiers.") }
        return decoded
    }
    private func readLibrary(_ service: HubService, scope: AccountScope, epoch: Int) async throws -> PublishedLibrary? {
        guard let bytes = try await service.fetchLibrary(accountID: scope.accountID) else { throw HubError.message("The hub did not return its published library.") }
        try requireGeneration(epoch)
        guard bytes.count <= 10_000, let rows = try JSONSerialization.jsonObject(with: bytes) as? [[String: Any]], rows.count <= 1, let reader else { throw HubError.message("The published library is invalid.") }
        guard let row = rows.first else { return nil }
        guard let value = row["snapshot"] else { throw HubError.message("The published library is missing its snapshot.") }
        return try reader.decode(JSONSerialization.data(withJSONObject: value), schema: "published-library.v1.schema.json")
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
                message = "Use your hub address or QR code to review its identity before signing in. Raw backend files are no longer used for connection."
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
        catch {
            if SupabaseHubService.denied(error) {
                invalidateAccount(removeDownloads: true); needsSignOutRetry = true
                message = "This session no longer has access. Private downloads are hidden. Sign in again after cleanup."
            } else { message = error.localizedDescription + " The last saved reading copies remain unchanged." }
        }
    }
}
