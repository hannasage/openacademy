import XCTest
import Combine
@testable import Touchline

final class FoundationTests: XCTestCase {
    func fixture(_ path: String) throws -> Data {
        let root = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contracts", withExtension: nil))
        return try Data(contentsOf: root.appendingPathComponent(path))
    }
    func testSharedContractsAndSemanticFailures() throws {
        let cases = try JSONSerialization.jsonObject(with: fixture("cases.json")) as! [[String: Any]]
        let validator = try ContractReader()
        for item in cases {
            let schema = item["schema"] as! String
            let data = try fixture(item["file"] as! String)
            let valid = item["valid"] as! Bool && item["semanticValid"] as? Bool != false
            if valid { XCTAssertNoThrow(try validator.validate(data, schema: schema), item["name"] as! String) }
            else { XCTAssertThrowsError(try validator.validate(data, schema: schema), item["name"] as! String) }
        }
    }
    func testUnsupportedSchemaKeywordsFailClosed() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("{\"$id\":\"test\",\"type\":\"object\",\"unknownValidation\":true}".utf8).write(to: directory.appendingPathComponent("test.schema.json"))
        XCTAssertThrowsError(try ContractReader(directory: directory).validate(Data("{}".utf8), schema: "test.schema.json"))
    }
    func testLegacyISODateSpellingsRemainReadable() throws {
        let reader = try ContractReader()
        var value = try JSONSerialization.jsonObject(with: fixture("valid/legacy-backup.json")) as! [String: Any]
        var state = value["state"] as! [String: Any]
        for date in ["20261029", "2026-W44-4", "2026W444", "2026W44", "2026-W44"] {
            state["startDate"] = date; value["state"] = state
            XCTAssertNoThrow(try reader.validate(JSONSerialization.data(withJSONObject: value), schema: "legacy-backup.v1.schema.json"))
        }
        for invalid in ["2026W99", "٢٠٢٦-W٠١", "٢٠٢٦-W01", "2026-W٠١", "2026-W01-١", "٢٠٢٦٠١٠١", "٢٠٢٦-01-01"] {
            state["startDate"] = invalid; value["state"] = state
            XCTAssertThrowsError(try reader.validate(JSONSerialization.data(withJSONObject: value), schema: "legacy-backup.v1.schema.json"), invalid)
        }
    }
    func testTypedSnapshotsAndRecordVersions() throws {
        let reader = try ContractReader()
        let snapshot: PublishedCourse = try reader.decode(fixture("valid/published-course.json"), schema: "published-course.v1.schema.json")
        XCTAssertEqual(snapshot.curriculum.id, snapshot.progress.curriculumId)
        let record: LocalRecord = try reader.decode(fixture("valid/local-record.json"), schema: "local-record.v2.schema.json")
        XCTAssertEqual(record.version, 2)
        let hub: HubDescription = try reader.decode(fixture("valid/hub-description.json"), schema: "hub-description.v1.schema.json")
        XCTAssertEqual(hub.auth.email, "otp")
    }
    func testScopeIsolatesIdenticalCurriculaAndKeepsFailedWrites() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let reader = try ContractReader()
        let snapshot: PublishedCourse = try reader.decode(fixture("valid/published-course.json"), schema: "published-course.v1.schema.json")
        let a = try AccountScope(hubID: UUID(), backendOrigin: "https://one.example", accountID: UUID())
        let b = try AccountScope(hubID: a.hubID, backendOrigin: a.backendOrigin, accountID: UUID())
        let cache = try FileReadingCache(directory: directory, reader: reader)
        try cache.save([snapshot], scope: a, refreshedAt: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(try cache.load(scope: a)?.records.count, 1)
        XCTAssertNil(try cache.load(scope: b))
        XCTAssertNil(try cache.load(scope: AccountScope(hubID: UUID(), backendOrigin: a.backendOrigin, accountID: a.accountID)))
        XCTAssertNil(try cache.load(scope: AccountScope(hubID: a.hubID, backendOrigin: "https://two.example", accountID: a.accountID)))
        XCTAssertEqual(try AccountScope.legacy(connection: Connection(url: "https://example.supabase.co", publishableKey: "sb_publishable_test"), accountID: a.accountID).hubID.uuidString.lowercased(), "5f1a10e2-8270-5f0c-a408-2a87c5c1390f")
        let failing = try FileReadingCache(directory: directory, reader: reader, writer: { _, _ in throw CocoaError(.fileWriteOutOfSpace) })
        XCTAssertThrowsError(try failing.save([], scope: a, refreshedAt: Date()))
        XCTAssertEqual(try cache.load(scope: a)?.records.count, 1)
        try cache.save([snapshot], scope: b, refreshedAt: Date())
        let savedURL = directory.appendingPathComponent(b.storageKey + ".json")
        // Simulator storage does not expose iOS Data Protection attributes.
        #if !targetEnvironment(simulator)
        let attributes = try FileManager.default.attributesOfItem(atPath: savedURL.path)
        XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType, .completeUntilFirstUserAuthentication)
        #endif
        var corrupted = try JSONSerialization.jsonObject(with: Data(contentsOf: savedURL)) as! [String: Any]
        var records = corrupted["records"] as! [[String: Any]]
        records[0]["draft"] = "private extension"
        corrupted["records"] = records
        let bytes = try JSONSerialization.data(withJSONObject: corrupted)
        try bytes.write(to: savedURL)
        XCTAssertThrowsError(try cache.load(scope: b))
        XCTAssertEqual(try Data(contentsOf: savedURL), bytes)
        try cache.save([snapshot], scope: b, refreshedAt: Date())
        try cache.remove(scope: a)
        XCTAssertNil(try cache.load(scope: a))
        XCTAssertEqual(try cache.load(scope: b)?.records.count, 1)
    }
    func testOversizedImportsPreservePreviousBytes() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let reader = try ContractReader()
        let backup: LearningBackup = try reader.decode(fixture("valid/legacy-backup.json"), schema: "legacy-backup.v1.schema.json")
        let cache = try FileReadingCache(directory: directory, reader: reader)
        try cache.saveImports([backup])
        let target = directory.appendingPathComponent("local-imports-v1.json")
        let original = try Data(contentsOf: target)
        var document = try JSONSerialization.jsonObject(with: JSONEncoder().encode(backup)) as! [String: Any]
        var curriculum = document["curriculum"] as! [String: Any]
        var state = document["state"] as! [String: Any]
        curriculum["description"] = String(repeating: "x", count: 1_000_000)
        let records: [LearningBackup] = try (0..<21).map { index in
            let id = "large-import-\(index)"
            curriculum["id"] = id; state["curriculumId"] = id
            document["curriculum"] = curriculum; document["state"] = state
            return try reader.decode(JSONSerialization.data(withJSONObject: document), schema: "legacy-backup.v1.schema.json")
        }
        XCTAssertGreaterThan(try JSONEncoder().encode(records).count, 20_000_000)
        XCTAssertThrowsError(try cache.saveImports(records))
        XCTAssertEqual(try Data(contentsOf: target), original)
        XCTAssertEqual(try cache.loadImports().count, 1)
    }
    func testOwnerlessCacheIsQuarantinedWithoutChangingItsBytes() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let legacy = directory.appendingPathComponent("courses.json")
        let bytes = Data("private legacy data".utf8)
        try bytes.write(to: legacy)
        let cache = try FileReadingCache(directory: directory, reader: ContractReader())
        XCTAssertTrue(cache.hasUnownedLegacyCache)
        XCTAssertEqual(try Data(contentsOf: legacy), bytes)
        let scope = try AccountScope(hubID: UUID(), backendOrigin: "https://example.com", accountID: UUID())
        XCTAssertNil(try cache.load(scope: scope))
    }
}

@MainActor
private final class TestService: HubService {
    var cachedAccountID: UUID?
    var onAccountChange: ((UUID?) -> Void)?
    var nextAccount = UUID()
    var bytes = Data("[]".utf8)
    var libraryBytes: Data?
    func fetchLibrary(accountID: UUID) async throws -> Data? { libraryBytes }
    var fetchWork: (() async throws -> Data)?
    func signIn(email: String, password: String) async throws -> UUID { cachedAccountID = nextAccount; return nextAccount }
    func signOut() async throws { cachedAccountID = nil; onAccountChange?(nil) }
    func fetch(accountID: UUID) async throws -> Data {
        guard accountID == cachedAccountID else { throw HubError.message("Wrong account") }
        if let fetchWork { return try await fetchWork() }
        return bytes
    }
}

@MainActor
final class HubStoreTests: XCTestCase {
    private func setup() throws -> (HubStore, TestService, FileReadingCache, URL, LearningBackup, UserDefaults) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let reader = try ContractReader()
        let bundle = Bundle(for: Self.self).url(forResource: "contracts", withExtension: nil)!
        let backup: LearningBackup = try reader.decode(Data(contentsOf: bundle.appendingPathComponent("valid/legacy-backup.json")), schema: "legacy-backup.v1.schema.json")
        let cache = try FileReadingCache(directory: root, reader: reader)
        let service = TestService()
        let suite = "touchline-tests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        let store = HubStore(cache: cache, reader: reader, bundled: backup, defaults: defaults, makeService: { _ in service })
        return (store, service, cache, root, backup, defaults)
    }
    private func rows(_ backup: LearningBackup) throws -> Data {
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(backup)) as! [String: Any]
        return try JSONSerialization.data(withJSONObject: [["curriculum": json["curriculum"]!, "progress": json["state"]!, "revision": 1, "updated_at": "2026-10-28T12:00:00Z"]])
    }
    func testPublishedCourseUpdatesKeepCloudNavigationDuringRefreshAndImport() async throws {
        let (store, service, _, root, backup, _) = try setup()
        service.bytes = try rows(backup)
        await store.connect(Connection(url: "https://example.supabase.co", publishableKey: "sb_publishable_test"))
        await store.signIn(email: "test@example.com", password: "test")
        let cloud = try XCTUnwrap(store.courses.first { $0.readingSource == .downloaded })
        let module = try XCTUnwrap(cloud.curriculum.modules.first)
        let navigation = ReadingNavigation()
        navigation.select(cloud.id)
        let path: [ReadingRoute] = [.lesson(module.id), .sources(module.id)]
        navigation.setPath(path, for: cloud.id)
        var observedSelections: [String?] = []
        var observedPaths: [[ReadingRoute]] = []
        let subscription = store.$courses.sink { courses in
            navigation.reconcile(courses)
            observedSelections.append(navigation.selected)
            observedPaths.append(navigation.path(for: cloud.id))
        }
        defer { subscription.cancel() }
        await store.refresh()
        XCTAssertTrue(store.message.hasPrefix("Downloaded "))
        let incoming = root.appendingPathComponent("navigation-import.json")
        try JSONEncoder().encode(backup).write(to: incoming)
        await store.importFile(incoming)
        XCTAssertTrue(store.message.hasPrefix("Imported "))
        XCTAssertGreaterThanOrEqual(observedSelections.count, 3)
        XCTAssertTrue(observedSelections.allSatisfy { $0 == cloud.id })
        XCTAssertTrue(observedPaths.allSatisfy { $0 == path })
        XCTAssertEqual(navigation.selected, cloud.id)
        XCTAssertEqual(navigation.path(for: cloud.id), path)
    }
    func testTwoDownloadsKeepPublishedFocusProgressAndExperimentsOffline() async throws {
        let (store, service, cache, _, backup, defaults) = try setup()
        let original = try JSONSerialization.jsonObject(with: rows(backup)) as! [[String: Any]]
        var first = original[0], second = original[0]
        var curriculum = second["curriculum"] as! [String: Any]
        curriculum["id"] = "second-course"; curriculum["title"] = "Another course"
        var progress = second["progress"] as! [String: Any]
        progress["curriculumId"] = "second-course"
        progress["experiments"] = [["id": "second-experiment", "date": "2026-10-28", "module": backup.curriculum.modules[0].id, "title": "Second experiment", "hypothesis": "A separate hypothesis", "result": "A separate result"]]
        second["curriculum"] = curriculum; second["progress"] = progress; second["status"] = "paused"
        first["status"] = "active"
        service.bytes = try JSONSerialization.data(withJSONObject: [first, second])
        service.libraryBytes = try JSONSerialization.data(withJSONObject: [["snapshot": ["version": 1, "revision": 1, "focusCurriculumId": backup.curriculum.id]]])
        await store.connect(Connection(url: "https://example.supabase.co", publishableKey: "sb_publishable_test"))
        await store.signIn(email: "test@example.com", password: "test")
        let cloud = store.courses.filter { $0.readingSource == .downloaded }
        XCTAssertEqual(cloud.count, 2)
        XCTAssertEqual(cloud.first?.isPublishedFocus, true)
        XCTAssertEqual(cloud.last?.readingStatus, .paused)
        XCTAssertEqual(cloud.last?.state.experiments.first?.result, "A separate result")
        XCTAssertTrue(cloud.first?.state.experiments.isEmpty == true)
        let previousRefresh = store.lastRefresh
        service.libraryBytes = Data("[{\"snapshot\":{\"version\":999}}]".utf8)
        await store.refresh()
        XCTAssertEqual(store.lastRefresh, previousRefresh)
        XCTAssertTrue(store.courses.contains { $0.isPublishedFocus })
        service.fetchWork = { throw URLError(.notConnectedToInternet) }
        let relaunched = HubStore(cache: cache, reader: try ContractReader(), bundled: backup, defaults: defaults, makeService: { _ in service })
        await relaunched.restoreSession()
        let restored = relaunched.courses.filter { $0.readingSource == .downloaded }
        XCTAssertEqual(restored.count, 2)
        XCTAssertEqual(restored.last?.state.experiments.first?.result, "A separate result")
        XCTAssertEqual(restored.first?.state.modules[backup.curriculum.modules[0].id]?.notes, backup.state.modules[backup.curriculum.modules[0].id]?.notes)
        XCTAssertTrue(restored.first?.isPublishedFocus == true)
    }
    func testNetworkFailurePreservesCurrentDownloadAndOfflineRelaunch() async throws {
        let (store, service, cache, _, backup, defaults) = try setup()
        service.bytes = try rows(backup)
        await store.connect(Connection(url: "https://example.supabase.co", publishableKey: "sb_publishable_test"))
        await store.signIn(email: "test@example.com", password: "test")
        XCTAssertEqual(store.courses.count, 2)
        XCTAssertNotEqual(store.courses[0].id, store.courses[1].id)
        let refreshed = store.lastRefresh
        service.bytes = Data("[{\"revision\":999}]".utf8)
        await store.refresh()
        XCTAssertEqual(store.courses.count, 2)
        XCTAssertEqual(store.lastRefresh, refreshed)
        service.fetchWork = { throw URLError(.notConnectedToInternet) }
        await store.refresh()
        XCTAssertEqual(store.courses.count, 2)
        XCTAssertEqual(store.lastRefresh, refreshed)
        let relaunched = HubStore(cache: cache, reader: try ContractReader(), bundled: backup, defaults: defaults, makeService: { _ in service })
        await relaunched.restoreSession()
        XCTAssertEqual(relaunched.courses.count, 2)
        await relaunched.signOut()
        XCTAssertEqual(relaunched.courses.count, 1)
        XCTAssertFalse(relaunched.signedIn)
    }
    func testImportDuringDelayedRefreshReportsRetryAndPreservesBytes() async throws {
        let (store, service, _, root, backup, _) = try setup()
        let incoming = root.appendingPathComponent("import.json")
        try JSONEncoder().encode(backup).write(to: incoming)
        await store.importFile(incoming)
        let saved = root.appendingPathComponent("local-imports-v1.json")
        let original = try Data(contentsOf: saved)
        service.bytes = try rows(backup)
        await store.connect(Connection(url: "https://example.supabase.co", publishableKey: "sb_publishable_test"))
        await store.signIn(email: "test@example.com", password: "test")
        var document = try JSONSerialization.jsonObject(with: JSONEncoder().encode(backup)) as! [String: Any]
        var state = document["state"] as! [String: Any]
        state["weeklyHours"] = 4; document["state"] = state
        try JSONSerialization.data(withJSONObject: document).write(to: incoming)
        let started = expectation(description: "Refresh waits for its response")
        var response: CheckedContinuation<Data, Never>?
        let bytes = service.bytes
        service.fetchWork = {
            await withCheckedContinuation { continuation in
                response = continuation
                started.fulfill()
            }
        }
        let refreshing = Task { await store.refresh() }
        defer { response?.resume(returning: bytes) }
        await fulfillment(of: [started], timeout: 2)
        XCTAssertTrue(store.busy)
        await store.importFile(incoming)
        XCTAssertEqual(try Data(contentsOf: saved), original)
        XCTAssertEqual(store.courses.first { $0.id.hasPrefix("local:") }?.state.weeklyHours, backup.state.weeklyHours)
        XCTAssertEqual(store.message, "A request is in progress. Wait for it to finish, then import the file again.")
        response?.resume(returning: bytes); response = nil
        await refreshing.value
        XCTAssertFalse(store.busy)
        XCTAssertEqual(try Data(contentsOf: saved), original)
        await store.importFile(incoming)
        XCTAssertEqual(store.courses.first { $0.id.hasPrefix("local:") }?.state.weeklyHours, 4)
        XCTAssertTrue(store.message.hasPrefix("Imported "))
    }
    func testAccountSwitchDuringDownloadCannotRestorePrivateContent() async throws {
        let (store, service, cache, _, backup, _) = try setup()
        service.bytes = try rows(backup)
        await store.connect(Connection(url: "https://example.supabase.co", publishableKey: "sb_publishable_test"))
        await store.signIn(email: "test@example.com", password: "test")
        let oldAccount = service.nextAccount
        let oldScope = try AccountScope.legacy(connection: store.connection, accountID: oldAccount)
        let bytes = service.bytes
        service.fetchWork = {
            service.cachedAccountID = UUID()
            service.onAccountChange?(service.cachedAccountID)
            return bytes
        }
        await store.refresh()
        XCTAssertFalse(store.signedIn)
        XCTAssertEqual(store.courses.count, 1)
        XCTAssertNil(try cache.load(scope: oldScope))
    }
    func testFailedCacheWriteDoesNotReplaceVisibleDownloads() async throws {
        let (_, service, cache, root, backup, defaults) = try setup()
        let scope = try AccountScope.legacy(connection: Connection(url: "https://example.supabase.co", publishableKey: "sb_publishable_test"), accountID: service.nextAccount)
        let failing = try FileReadingCache(directory: root, reader: ContractReader(), writer: { _, _ in throw CocoaError(.fileWriteOutOfSpace) })
        let store = HubStore(cache: failing, reader: try ContractReader(), bundled: backup, defaults: defaults, makeService: { _ in service })
        service.bytes = try rows(backup)
        await store.connect(Connection(url: "https://example.supabase.co", publishableKey: "sb_publishable_test"))
        await store.signIn(email: "test@example.com", password: "test")
        XCTAssertEqual(store.courses.count, 1)
        XCTAssertNil(store.lastRefresh)
        XCTAssertNil(try cache.load(scope: scope))
        XCTAssertTrue(store.message.contains("unchanged"))
    }
    func testSignOutHidesImmediatelyAndStillSignsOutWhenFileRemovalFails() async throws {
        let (_, service, cache, _, backup, defaults) = try setup()
        let failing = RemovalFailureCache(cache)
        let store = HubStore(cache: failing, reader: try ContractReader(), bundled: backup, defaults: defaults, makeService: { _ in service })
        service.bytes = try rows(backup)
        await store.connect(Connection(url: "https://example.supabase.co", publishableKey: "sb_publishable_test"))
        await store.signIn(email: "test@example.com", password: "test")
        let scope = try AccountScope.legacy(connection: store.connection, accountID: service.nextAccount)
        await store.signOut()
        XCTAssertFalse(store.signedIn)
        XCTAssertEqual(store.courses.count, 1)
        XCTAssertNil(service.cachedAccountID)
        XCTAssertNotNil(try cache.load(scope: scope))
        XCTAssertTrue(store.message.contains("removal failed"))
        XCTAssertTrue(store.needsSignOutRetry)
        failing.failRemoval = false
        await store.signOut()
        XCTAssertNil(try cache.load(scope: scope))
        XCTAssertFalse(store.needsSignOutRetry)
    }
    func testFailedCleanupBlocksAnotherAccountUntilRecovered() async throws {
        let (_, service, cache, _, backup, defaults) = try setup()
        let failing = RemovalFailureCache(cache)
        let store = HubStore(cache: failing, reader: try ContractReader(), bundled: backup, defaults: defaults, makeService: { _ in service })
        service.bytes = try rows(backup)
        await store.connect(Connection(url: "https://example.supabase.co", publishableKey: "sb_publishable_test"))
        await store.signIn(email: "a@example.com", password: "test")
        let a = try AccountScope.legacy(connection: store.connection, accountID: service.nextAccount)
        await store.signOut()
        XCTAssertNotNil(try cache.load(scope: a))
        service.nextAccount = UUID()
        await store.signIn(email: "b@example.com", password: "test")
        XCTAssertFalse(store.signedIn)
        XCTAssertNil(service.cachedAccountID)
        XCTAssertTrue(store.needsSignOutRetry)
        XCTAssertTrue(store.message.contains("Finish the pending download cleanup"))
        XCTAssertNotNil(try cache.load(scope: a))
        let restoredScope = try AccountScope.legacy(connection: store.connection, accountID: service.nextAccount)
        service.cachedAccountID = service.nextAccount
        defaults.set(try JSONEncoder().encode(restoredScope), forKey: "touchline.activeScope")
        await store.restoreSession()
        XCTAssertFalse(store.signedIn)
        await store.connect(Connection(url: "https://other.example", publishableKey: "sb_publishable_other"))
        XCTAssertEqual(store.connection.url, a.backendOrigin)
        XCTAssertNotNil(try cache.load(scope: a))
        failing.failRemoval = false
        await store.signOut()
        XCTAssertNil(try cache.load(scope: a))
        XCTAssertFalse(store.needsSignOutRetry)
        await store.signIn(email: "b@example.com", password: "test")
        XCTAssertTrue(store.signedIn)
        let b = try AccountScope.legacy(connection: store.connection, accountID: service.nextAccount)
        XCTAssertNotNil(try cache.load(scope: b))
        await store.signOut()
        XCTAssertNil(try cache.load(scope: a))
        XCTAssertNil(try cache.load(scope: b))
        XCTAssertFalse(store.needsSignOutRetry)
    }
    func testImportedBackupNeverReplacesMatchingCloudCopy() async throws {
        let (store, service, _, root, backup, _) = try setup()
        service.bytes = try rows(backup)
        await store.connect(Connection(url: "https://example.supabase.co", publishableKey: "sb_publishable_test"))
        await store.signIn(email: "test@example.com", password: "test")
        var document = try JSONSerialization.jsonObject(with: JSONEncoder().encode(backup)) as! [String: Any]
        var state = document["state"] as! [String: Any]; state["weeklyHours"] = 4; document["state"] = state
        let file = root.appendingPathComponent("import.json")
        try JSONSerialization.data(withJSONObject: document).write(to: file)
        await store.importFile(file)
        XCTAssertEqual(store.courses.count, 2)
        XCTAssertEqual(store.courses.first { $0.id.hasPrefix("local:") }?.state.weeklyHours, 4)
        XCTAssertEqual(store.courses.first { !$0.id.hasPrefix("local:") }?.state.weeklyHours, backup.state.weeklyHours)
        await store.signOut()
        XCTAssertEqual(store.courses.first?.state.weeklyHours, 4)
    }
    func testDamagedLocalImportsBlockReplacementAndKeepBundledCurriculum() async throws {
        let (_, service, cache, root, backup, defaults) = try setup()
        let damaged = Data("not JSON".utf8)
        try damaged.write(to: root.appendingPathComponent("local-imports-v1.json"))
        let store = HubStore(cache: cache, reader: try ContractReader(), bundled: backup, defaults: defaults, makeService: { _ in service })
        XCTAssertEqual(store.courses.count, 1)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("local-imports-v1.json")), damaged)
        XCTAssertTrue(store.message.contains("could not be read"))
        let incoming = root.appendingPathComponent("valid-import.json")
        try JSONEncoder().encode(backup).write(to: incoming)
        await store.importFile(incoming)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("local-imports-v1.json")), damaged)
        XCTAssertEqual(store.courses.count, 1)
        XCTAssertTrue(store.message.contains("could not be read"))
        XCTAssertFalse(store.message.hasPrefix("Imported "))
    }
    func testUnsupportedContractAndUnknownVersionFail() throws {
        let reader = try ContractReader()
        XCTAssertThrowsError(try reader.validate(Data("{}".utf8), schema: "future.v9.schema.json"))
        XCTAssertThrowsError(try reader.validate(Data("{\"version\":2,\"revision\":0,\"focusCurriculumId\":null}".utf8), schema: "published-library.v1.schema.json"))
    }
}


private final class RemovalFailureCache: ReadingCache {
    let wrapped: FileReadingCache
    var failRemoval = true
    init(_ wrapped: FileReadingCache) { self.wrapped = wrapped }
    var hasUnownedLegacyCache: Bool { wrapped.hasUnownedLegacyCache }
    func load(scope: AccountScope) throws -> CachedDownload? { try wrapped.load(scope: scope) }
    func save(_ records: [PublishedCourse], scope: AccountScope, refreshedAt: Date, library: PublishedLibrary?) throws { try wrapped.save(records, scope: scope, refreshedAt: refreshedAt, library: library) }
    func remove(scope: AccountScope) throws { if failRemoval { throw CocoaError(.fileWriteNoPermission) }; try wrapped.remove(scope: scope) }
    func loadImports() throws -> [LearningBackup] { try wrapped.loadImports() }
    func saveImports(_ records: [LearningBackup]) throws { try wrapped.saveImports(records) }
}


@MainActor
final class ReadingScreenTests: XCTestCase {
    private func backup() throws -> LearningBackup {
        let root = Bundle(for: Self.self).url(forResource: "contracts", withExtension: nil)!
        return try ContractReader().decode(Data(contentsOf: root.appendingPathComponent("valid/legacy-backup.json")), schema: "legacy-backup.v1.schema.json")
    }
    func testSelectionSurvivesRefreshAndKeepsSeparateLessonPaths() throws {
        var first = try backup(); first.readerID = "account:first"
        var second = try backup(); second.readerID = "account:second"
        let navigation = ReadingNavigation()
        navigation.select(first.id)
        navigation.setPath([.lesson(first.curriculum.modules[0].id)], for: first.id)
        navigation.select(second.id)
        navigation.setPath([.lesson(second.curriculum.modules[0].id), .sources(second.curriculum.modules[0].id)], for: second.id)
        navigation.reconcile([first, second])
        XCTAssertEqual(navigation.selected, second.id)
        XCTAssertEqual(navigation.path(for: second.id).count, 2)
        navigation.select(first.id)
        XCTAssertEqual(navigation.path(for: first.id), [.lesson(first.curriculum.modules[0].id)])
        navigation.reconcile([second])
        XCTAssertNil(navigation.selected)
        XCTAssertTrue(navigation.path(for: first.id).isEmpty)
        navigation.select(second.id)
        navigation.setPath([.lesson("removed-module"), .sources("removed-module")], for: second.id)
        navigation.reconcile([second])
        XCTAssertEqual(navigation.selected, second.id)
        XCTAssertTrue(navigation.path(for: second.id).isEmpty)
    }
    func testLibraryFocusIsExplicitAndCacheSurvivesRelaunch() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let reader = try ContractReader(), cache = try FileReadingCache(directory: root, reader: reader)
        let item = try backup()
        let snapshot = PublishedCourse(format: "touchline-snapshot", version: 1, curriculum: item.curriculum, progress: item.state, status: .active, revision: 1, publishedAt: "2026-10-28T12:00:00Z")
        let scope = try AccountScope(hubID: UUID(), backendOrigin: "https://example.com", accountID: UUID())
        let library = PublishedLibrary(version: 1, revision: 1, focusCurriculumId: item.curriculum.id)
        try cache.save([snapshot], scope: scope, refreshedAt: Date(), library: library)
        XCTAssertEqual(try cache.load(scope: scope)?.library?.focusCurriculumId, item.curriculum.id)
        let file = root.appendingPathComponent(scope.storageKey + ".json")
        var envelope = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        envelope["library"] = ["version": 1, "revision": 1, "focusCurriculumId": item.curriculum.id, "privateField": "reject"]
        try JSONSerialization.data(withJSONObject: envelope).write(to: file)
        XCTAssertThrowsError(try cache.load(scope: scope))
        try cache.save([snapshot], scope: scope, refreshedAt: Date(), library: PublishedLibrary(version: 1, revision: 2, focusCurriculumId: nil))
        XCTAssertEqual(try cache.load(scope: scope)?.library?.revision, 2)
        XCTAssertNil(try cache.load(scope: scope)?.library?.focusCurriculumId)
        try cache.save([snapshot], scope: scope, refreshedAt: Date())
        XCTAssertNil(try cache.load(scope: scope)?.library)
    }
    func testTutorPromptUsesThisCopiesNotesAndRemainingTask() throws {
        let copy = try backup(), module = try XCTUnwrap(copy.curriculum.modules.first)
        let prompt = ReadingSource.tutorPrompt(module: module, course: copy.curriculum, progress: copy.state.modules[module.id])
        XCTAssertTrue(prompt.contains(copy.curriculum.title))
        XCTAssertTrue(prompt.contains("Keep the split fixed."))
        XCTAssertTrue(prompt.contains(module.tasks[1]))
        XCTAssertTrue(prompt.contains(module.challenge))
    }
    func testUnsafeSourceIsRejectedBeforeOpening() {
        XCTAssertNil(ReadingSource.safeURL("javascript:alert(1)"))
        XCTAssertNil(ReadingSource.safeURL("https://user:password@example.com/"))
        XCTAssertNotNil(ReadingSource.safeURL("https://example.com/book"))
    }
}
