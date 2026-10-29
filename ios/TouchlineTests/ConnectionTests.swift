import XCTest
import AVFoundation
import Supabase
@testable import Touchline

private func connectionFixture<T: Decodable>(_ name: String, schema: String) throws -> T {
    let directory = Bundle(for: NativeConnectionTests.self).url(forResource: "contracts", withExtension: nil)!
    return try ContractReader().decode(Data(contentsOf: directory.appendingPathComponent("valid/" + name + ".json")), schema: schema)
}
private struct FixtureDiscovery: HubDiscovering {
    var hub: HubDescription
    func discover(_ input: String) async throws -> HubDescription { _ = try HubLink.origin(input); return hub }
}
private final class HeldDiscovery: HubDiscovering {
    let hub: HubDescription
    var gate: CheckedContinuation<Void, Never>?
    init(hub: HubDescription) { self.hub = hub }
    func discover(_ input: String) async throws -> HubDescription { await withCheckedContinuation { gate = $0 }; return hub }
}
@MainActor private final class ConnectionService: HubService {
    var cachedAccountID: UUID?
    var onAccountChange: ((UUID?) -> Void)?
    let account = UUID()
    var requests: [String] = []
    var catalog = Data("[]".utf8)
    var rows: [String: Data] = [:]
    var failures: [String: Error] = [:]
    var accountError: Error?
    var codeError: Error?
    var codeGate: CheckedContinuation<Void, Never>?
    var holdCode = false
    var gate: CheckedContinuation<Void, Never>?
    var hold = false
    var library = Data("[]".utf8)
    func signIn(email: String, password: String) async throws -> UUID { throw HubAccessError.unauthorized }
    func requestCode(email: String) async throws { requests.append("code:" + email); if holdCode { await withCheckedContinuation { codeGate = $0 } } }
    func verifyCode(email: String, code: String) async throws -> UUID {
        requests.append("verify:" + code)
        if let codeError { throw codeError }
        cachedAccountID = account; return account
    }
    func verifyAccount() async throws -> UUID { if let accountError { throw accountError }; return account }
    func signIn(provider: String) async throws -> UUID { requests.append(provider); cachedAccountID = account; return account }
    func signOut() async throws { requests.append("signout"); cachedAccountID = nil; onAccountChange?(nil) }
    func fetch(accountID: UUID) async throws -> Data { requests.append("catalog"); if let accountError { throw accountError }; return catalog }
    func fetchLibrary(accountID: UUID) async throws -> Data? { library }
    func fetchCatalog(accountID: UUID) async throws -> Data {
        requests.append("catalog"); if let accountError { throw accountError }
        let rows = try JSONSerialization.jsonObject(with: catalog) as! [[String: Any]]
        return try JSONSerialization.data(withJSONObject: rows.map { row in
            ["id": row["id"]!, "format_version": row["format_version"]!, "revision": row["revision"]!, "status": row["status"]!, "title": (row["curriculum"] as! [String: Any])["title"]!]
        })
    }
    func fetchCourse(accountID: UUID, curriculumID: String) async throws -> Data {
        requests.append(curriculumID)
        if hold { await withCheckedContinuation { gate = $0 } }
        if let error = failures[curriculumID] { throw error }
        return rows[curriculumID] ?? Data("[]".utf8)
    }
}
@MainActor final class NativeConnectionTests: XCTestCase {
    private func fixture() throws -> (HubStore, ConnectionService, FileReadingCache, UserDefaults, HubDescription) {
        let hub: HubDescription = try connectionFixture("hub-description", schema: "hub-description.v1.schema.json")
        let backup: LearningBackup = try connectionFixture("legacy-backup", schema: "legacy-backup.v1.schema.json")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let suite = "touchline-p14-tests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        // No normal app preferences or real Keychain service are accessed by these fixtures.
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        let cache = try FileReadingCache(directory: root, reader: ContractReader())
        let service = ConnectionService()
        let store = HubStore(cache: cache, reader: try ContractReader(), bundled: backup, defaults: defaults,
            makeService: { _ in service }, makeHubService: { _ in service }, discovery: FixtureDiscovery(hub: hub))
        return (store, service, cache, defaults, hub)
    }
    private func row(_ id: String, revision: Int = 1) throws -> [String: Any] {
        let backup: LearningBackup = try connectionFixture("legacy-backup", schema: "legacy-backup.v1.schema.json")
        var curriculum = try JSONSerialization.jsonObject(with: JSONEncoder().encode(backup.curriculum)) as! [String: Any]
        var progress = try JSONSerialization.jsonObject(with: JSONEncoder().encode(backup.state)) as! [String: Any]
        curriculum["id"] = id; curriculum["title"] = "Course " + id; progress["curriculumId"] = id
        return ["id": id, "format_version": 1, "curriculum": curriculum, "progress": progress, "status": "active", "revision": revision, "updated_at": "2026-10-28T12:00:00.123456+00:00"]
    }
    private func configure(_ service: ConnectionService) throws {
        service.catalog = try JSONSerialization.data(withJSONObject: [row("one"), row("two"), row("three")])
        for id in ["one", "two", "three"] { service.rows[id] = try JSONSerialization.data(withJSONObject: [row(id)]) }
        service.library = Data("[{\"snapshot\":{\"version\":1,\"revision\":1,\"focusCurriculumId\":\"one\"}}]".utf8)
    }
    private func login(_ store: HubStore) async {
        await store.discoverHub("https://learn.example.org")
        await store.confirmHub()
        await store.requestCode(email: "reader@example.org")
        await store.verifyCode("123456")
    }
    func testLinksRejectCredentialsQueriesFragmentsAndHostileSchemes() throws {
        XCTAssertEqual(try HubLink.origin("touchline://connect?hub=https%3A%2F%2Flearn.example.org"), "https://learn.example.org")
        for link in ["http://learn.example.org", "https://reader@learn.example.org", "https://learn.example.org/path", "https://learn.example.org?token=secret", "https://learn.example.org#token", "touchline://connect?hub=https://learn.example.org&token=secret", "touchline://wrong?hub=https://learn.example.org", "javascript:alert(1)"] {
            XCTAssertThrowsError(try HubLink.origin(link), link)
        }
    }
    func testOAuthReturnIsBoundToHubBackendNonceAndExpiry() throws {
        let hub: HubDescription = try connectionFixture("hub-description", schema: "hub-description.v1.schema.json")
        let now = Date(), attempt = NativeAuthAttempt(hub: hub)
        let valid = URL(string: attempt.returnURL.absoluteString + "&code=one-use")!
        XCTAssertEqual(try attempt.code(from: valid, hub: hub, now: now.addingTimeInterval(1)), "one-use")
        for text in [valid.absoluteString + "&code=duplicate", valid.absoluteString + "#access_token=secret", valid.absoluteString.replacingOccurrences(of: "/return", with: "/other"), valid.absoluteString.replacingOccurrences(of: attempt.id.uuidString.lowercased(), with: UUID().uuidString)] {
            XCTAssertThrowsError(try attempt.code(from: URL(string: text)!, hub: hub))
        }
        XCTAssertThrowsError(try attempt.code(from: valid, hub: hub, now: now.addingTimeInterval(601)))
        var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(hub)) as! [String: Any]; json["hubId"] = UUID().uuidString.lowercased()
        let other: HubDescription = try ContractReader().decode(JSONSerialization.data(withJSONObject: json), schema: "hub-description.v1.schema.json")
        XCTAssertThrowsError(try attempt.code(from: valid, hub: other))
        XCTAssertNotEqual(hub.authStorageKey, other.authStorageKey)
        XCTAssertNotEqual(try hub.scope(accountID: UUID()).storageKey, try other.scope(accountID: UUID()).storageKey)
    }
    func testDeniedCameraDoesNotRequestPermissionAgain() async {
        var asked = false
        let denied = await HubCameraPermission.request(status: .denied, ask: { asked = true; return true })
        XCTAssertFalse(denied); XCTAssertFalse(asked)
        let accepted = await HubCameraPermission.request(status: .notDetermined, ask: { asked = true; return true })
        XCTAssertTrue(accepted); XCTAssertTrue(asked)
    }
    func testDiscoveryRequiresReviewBeforeAuthenticationAndCanCancel() async throws {
        let (store, service, _, _, _) = try fixture()
        await store.discoverHub("https://learn.example.org")
        XCTAssertNotNil(store.candidateHub); XCTAssertNil(store.hub); XCTAssertTrue(service.requests.isEmpty)
        await store.requestCode(email: "reader@example.org")
        XCTAssertTrue(service.requests.isEmpty)
        store.cancelHubReview(); XCTAssertNil(store.candidateHub)
    }
    func testDismissedDiscoveryAndCodeRequestCannotRepopulateReopenedScreen() async throws {
        let (_, service, cache, defaults, hub) = try fixture()
        let discovery = HeldDiscovery(hub: hub)
        let store = HubStore(cache: cache, reader: try ContractReader(), bundled: nil, defaults: defaults,
            makeService: { _ in service }, makeHubService: { _ in service }, discovery: discovery)
        let discover = Task { await store.discoverHub(hub.hubOrigin) }
        for _ in 0..<100 where discovery.gate == nil { await Task.yield() }
        store.cancelConnectionAttempt(); discovery.gate?.resume(); await discover.value
        XCTAssertNil(store.candidateHub); XCTAssertNil(store.hub)
        let retry = Task { await store.discoverHub(hub.hubOrigin) }
        discovery.gate = nil
        for _ in 0..<100 where discovery.gate == nil { await Task.yield() }
        discovery.gate?.resume(); await retry.value; await store.confirmHub()
        service.holdCode = true
        let code = Task { await store.requestCode(email: "fixture@example.org") }
        for _ in 0..<100 where service.codeGate == nil { await Task.yield() }
        store.cancelConnectionAttempt(); service.codeGate?.resume(); await code.value
        XCTAssertNil(store.codeEmail); XCTAssertFalse(store.signedIn)
    }
    func testEmailCodeDoesNotDownloadUntilSelectionAndFocusIsOnlySuggestion() async throws {
        let (store, service, cache, _, hub) = try fixture(); try configure(service)
        await login(store)
        XCTAssertTrue(store.signedIn); XCTAssertEqual(store.availableDownloads.count, 3)
        XCTAssertEqual(store.selectedDownloads, ["one"])
        XCTAssertFalse(store.courses.contains { $0.readingSource == .downloaded })
        XCTAssertNil(try cache.load(scope: hub.scope(accountID: service.account)))
        store.selectDownload("one", selected: false); store.selectDownload("two", selected: true)
        await store.downloadSelected()
        XCTAssertEqual(store.courses.filter { $0.readingSource == .downloaded }.map { $0.curriculum.id }, ["two"])
        XCTAssertFalse(service.requests.contains("one")); XCTAssertFalse(service.requests.contains("three"))
    }
    func testExpiredCodeAllowsResendWithoutActivatingAccount() async throws {
        let (store, service, _, _, _) = try fixture(); service.codeError = HubError.message("Code expired")
        await login(store)
        XCTAssertFalse(store.signedIn); XCTAssertEqual(store.codeEmail, "reader@example.org")
        await store.requestCode(email: "reader@example.org")
        XCTAssertEqual(service.requests.filter { $0.hasPrefix("code:") }.count, 2)
        service.codeError = nil; await store.verifyCode("new-code")
        XCTAssertTrue(store.signedIn)
    }
    func testIndependentRefreshKeepsFailedCopyAndItsDownloadTime() async throws {
        let (store, service, cache, _, hub) = try fixture(); try configure(service); await login(store)
        store.selectDownload("two", selected: true); await store.downloadSelected()
        let old = try XCTUnwrap(try cache.load(scope: hub.scope(accountID: service.account)))
        service.rows["one"] = try JSONSerialization.data(withJSONObject: [row("one", revision: 2)])
        service.failures["two"] = URLError(.notConnectedToInternet)
        await store.downloadSelected()
        let updated = try XCTUnwrap(try cache.load(scope: hub.scope(accountID: service.account)))
        XCTAssertEqual(updated.records.first { $0.curriculum.id == "one" }?.revision, 2)
        XCTAssertEqual(updated.records.first { $0.curriculum.id == "two" }?.revision, 1)
        XCTAssertEqual(old.downloadedAt?["two"], updated.downloadedAt?["two"])
        XCTAssertTrue(store.message.contains("1 could not refresh"))
    }
    func testRevocationOnReconnectRemovesScopedCacheButTransientOfflineKeepsIt() async throws {
        let (store, service, cache, defaults, hub) = try fixture(); try configure(service); await login(store); await store.downloadSelected()
        let scope = try hub.scope(accountID: service.account)
        service.accountError = URLError(.notConnectedToInternet)
        let offline = HubStore(cache: cache, reader: try ContractReader(), bundled: nil, defaults: defaults, makeService: { _ in service }, makeHubService: { _ in service })
        await offline.restoreSession()
        XCTAssertTrue(offline.signedIn); XCTAssertEqual(offline.courses.count, 1)
        service.accountError = HubAccessError.unauthorized
        await offline.restoreSession()
        XCTAssertFalse(offline.signedIn); XCTAssertTrue(offline.courses.isEmpty); XCTAssertNil(try cache.load(scope: scope))
    }
    func testSignOutDuringDownloadCannotRestorePrivateContent() async throws {
        let (store, service, cache, _, hub) = try fixture(); try configure(service); await login(store)
        service.hold = true
        let work = Task { await store.downloadSelected() }
        for _ in 0..<100 where service.gate == nil { await Task.yield() }
        XCTAssertNotNil(service.gate)
        await store.signOut(); service.gate?.resume(); await work.value
        XCTAssertFalse(store.signedIn); XCTAssertFalse(store.courses.contains { $0.readingSource == .downloaded })
        XCTAssertNil(try cache.load(scope: hub.scope(accountID: service.account)))
    }
    func testInvalidPublicationDoesNotReplaceOtherSelectedSnapshots() async throws {
        let (store, service, _, _, _) = try fixture(); try configure(service); await login(store)
        store.selectDownload("two", selected: true); store.selectDownload("three", selected: true)
        service.rows["two"] = Data("[{\"format_version\":2}]".utf8)
        await store.downloadSelected()
        XCTAssertEqual(Set(store.courses.filter { $0.readingSource == .downloaded }.map { $0.curriculum.id }), ["one", "three"])
        XCTAssertTrue(store.message.contains("1 could not refresh"))
    }
    func testOfflineDownloadRemovalDoesNotDependOnCatalog() async throws {
        let (store, service, cache, defaults, hub) = try fixture(); try configure(service); await login(store)
        store.selectDownload("two", selected: true); await store.downloadSelected()
        service.accountError = URLError(.notConnectedToInternet)
        let offline = HubStore(cache: cache, reader: try ContractReader(), bundled: nil, defaults: defaults, makeService: { _ in service }, makeHubService: { _ in service })
        await offline.restoreSession()
        XCTAssertTrue(offline.availableDownloads.isEmpty)
        let before = service.requests
        offline.removeDownload("one")
        XCTAssertEqual(service.requests, before)
        XCTAssertEqual(offline.courses.map { $0.curriculum.id }, ["two"])
        XCTAssertEqual(try cache.load(scope: hub.scope(accountID: service.account))?.records.map { $0.curriculum.id }, ["two"])
    }
    func testRemovingDownloadDoesNotCallBackendOrRemoveOtherCurriculum() async throws {
        let (store, service, cache, _, hub) = try fixture(); try configure(service); await login(store)
        store.selectDownload("two", selected: true); await store.downloadSelected()
        let requests = service.requests
        store.removeDownload("one")
        XCTAssertEqual(service.requests, requests)
        XCTAssertEqual(try cache.load(scope: hub.scope(accountID: service.account))?.records.map { $0.curriculum.id }, ["two"])
    }
}

private final class IsolatedAuthStorage: AuthLocalStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    func store(key: String, value: Data) throws { lock.lock(); defer { lock.unlock() }; values[key] = value }
    func retrieve(key: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[key] }
    func remove(key: String) throws { lock.lock(); defer { lock.unlock() }; values.removeValue(forKey: key) }
}
private final class ConnectionURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    static var holdPath: String?
    static var held: (() -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.notConnectedToInternet) }
            let (status, data) = try handler(request)
            let deliver = { [self] in
                client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
            }
            if request.url?.path == Self.holdPath { Self.held = deliver } else { deliver() }
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
@MainActor private final class FixtureBrowser: NativeAuthBrowsing {
    var calls = 0
    var returnCode = true
    var result: ((URL) throws -> URL)?
    func open(_ url: URL) async throws -> URL {
        calls += 1
        if let result { return try result(url) }
        throw HubAccessError.cancelled
    }
    func cancel() {}
}
@MainActor final class NativeAccountProtocolTests: XCTestCase {
    private var paths: [String] = []
    private var registrationDenied = false
    private var rejectEmail = false
    private var confirmed = true
    private var anonymous = false
    private var wrongAccount = false
    private var registrationAccount: UUID?
    private let account = UUID(), sessionID = UUID()
    private func user(_ id: UUID? = nil) -> User {
        User(id: id ?? account, appMetadata: [:], userMetadata: [:], aud: "authenticated", email: "fixture@example.org", createdAt: Date(), emailConfirmedAt: confirmed ? Date() : nil, role: "authenticated", updatedAt: Date(), isAnonymous: anonymous)
    }
    private func service(browser: FixtureBrowser? = nil, storage: IsolatedAuthStorage = IsolatedAuthStorage()) throws -> SupabaseHubService {
        let hub: HubDescription = try connectionFixture("hub-description", schema: "hub-description.v1.schema.json")
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ConnectionURLProtocol.self]
        let session = URLSession(configuration: config)
        let encoder = AuthClient.Configuration.jsonEncoder
        let token = "fixture-header.fixture-payload.fixture-signature"
        ConnectionURLProtocol.handler = { [self] request in
            // Every request is intercepted. No test can fall through to the network.
            guard request.url?.host == "fixture.supabase.co" else { throw URLError(.unsupportedURL) }
            let path = request.url!.path; paths.append(path)
            switch path {
            case "/auth/v1/otp":
                let body = try JSONSerialization.jsonObject(with: Self.body(request)) as! [String: Any]
                XCTAssertEqual(body["create_user"] as? Bool, true)
                if rejectEmail { return (403, Data("{\"msg\":\"This deployment is private\",\"code\":\"email_address_not_authorized\"}".utf8)) }
                return (200, Data("{}".utf8))
            case "/auth/v1/verify", "/auth/v1/token":
                if path == "/auth/v1/token" {
                    let body = try JSONSerialization.jsonObject(with: Self.body(request)) as! [String: Any]
                    XCTAssertFalse((body["code_verifier"] as? String ?? "").isEmpty)
                    XCTAssertEqual(body["auth_code"] as? String, "one-use")
                }
                return (200, try encoder.encode(Session(accessToken: token, tokenType: "bearer", expiresIn: 3600, expiresAt: Date().timeIntervalSince1970 + 3600, refreshToken: "fixture-refresh", user: user())))
            case "/auth/v1/user": return (200, try encoder.encode(user(wrongAccount ? UUID() : account)))
            case "/rest/v1/rpc/register_touchline_session":
                if registrationDenied { return (403, Data("{\"code\":\"42501\",\"message\":\"Access revoked\"}".utf8)) }
                return (200, try JSONSerialization.data(withJSONObject: ["accountId": (registrationAccount ?? account).uuidString.lowercased(), "sessionId": sessionID.uuidString.lowercased()]))
            case "/rest/v1/rpc/revoke_touchline_session": return (200, Data("true".utf8))
            case "/rest/v1/learning_courses":
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + token)
                return (200, Data("[]".utf8))
            case "/auth/v1/logout": return (204, Data())
            default: throw URLError(.unsupportedURL)
            }
        }
        addTeardownBlock { ConnectionURLProtocol.handler = nil; session.invalidateAndCancel() }
        return SupabaseHubService(connection: hub.connection, hub: hub, browser: browser, storage: storage, transport: session)
    }
    private static func body(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; bytes.append(buffer, count: count) }
        return bytes
    }
    func testFirstOwnerCanRequestCodeButUnapprovedEmailIsRejected() async throws {
        let service = try service()
        try await service.requestCode(email: "fixture@example.org")
        rejectEmail = true
        do { try await service.requestCode(email: "not-owner@example.org"); XCTFail("The backend rejected this account") }
        catch { XCTAssertTrue(SupabaseHubService.denied(error)) }
        XCTAssertNil(service.cachedAccountID)
        XCTAssertEqual(paths, ["/auth/v1/otp", "/auth/v1/otp"])
    }
    func testOTPVerifiesUserAndRegistersBeforeAnyPrivateRead() async throws {
        let service = try service()
        try await service.requestCode(email: "fixture@example.org")
        XCTAssertEqual(paths, ["/auth/v1/otp"])
        let id = try await service.verifyCode(email: "fixture@example.org", code: "123456")
        XCTAssertEqual(id, account)
        _ = try await service.fetch(accountID: id)
        XCTAssertEqual(paths, ["/auth/v1/otp", "/auth/v1/verify", "/auth/v1/user", "/rest/v1/rpc/register_touchline_session", "/auth/v1/user", "/rest/v1/rpc/register_touchline_session", "/rest/v1/learning_courses"])
        try await service.signOut()
        XCTAssertTrue(paths.contains("/rest/v1/rpc/revoke_touchline_session")); XCTAssertNil(service.cachedAccountID)
    }
    func testUnconfirmedAnonymousChangedAndUnapprovedAccountsCannotRead() async throws {
        for scenario in 0..<4 {
            paths = []; confirmed = scenario != 0; anonymous = scenario == 1; wrongAccount = scenario == 2; registrationDenied = scenario == 3
            let service = try service()
            do { _ = try await service.verifyCode(email: "fixture@example.org", code: "123456"); XCTFail("Account should be rejected") }
            catch { XCTAssertTrue(SupabaseHubService.denied(error)) }
            XCTAssertFalse(paths.contains("/rest/v1/learning_courses"))
        }
    }
    func testCancelledEmailVerificationCannotRestoreSDKSession() async throws {
        let service = try service()
        ConnectionURLProtocol.holdPath = "/auth/v1/verify"
        defer { ConnectionURLProtocol.holdPath = nil; ConnectionURLProtocol.held = nil }
        let request = Task { try await service.verifyCode(email: "fixture@example.org", code: "123456") }
        for _ in 0..<100 where ConnectionURLProtocol.held == nil { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertNotNil(ConnectionURLProtocol.held)
        service.cancelAuthentication()
        ConnectionURLProtocol.held?()
        do { _ = try await request.value; XCTFail("Cancelled verification") } catch {}
        XCTAssertNil(service.cachedAccountID)
        XCTAssertFalse(paths.contains("/rest/v1/rpc/register_touchline_session"))
    }
    func testCatalogRequestsOnlyMetadataAndSelectedFetchPinsItsID() async throws {
        let service = try service(); _ = try await service.verifyCode(email: "fixture@example.org", code: "123456")
        let previous = ConnectionURLProtocol.handler!
        var selects: [String] = []
        ConnectionURLProtocol.handler = { request in
            if request.url?.path == "/rest/v1/learning_courses" {
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
                let select = query.first { $0.name == "select" }!.value!
                selects.append(select)
                if select == "*" { XCTAssertEqual(query.first { $0.name == "id" }?.value, "eq.chosen-course") }
            }
            return try previous(request)
        }
        _ = try await service.fetchCatalog(accountID: account)
        _ = try await service.fetchCourse(accountID: account, curriculumID: "chosen-course")
        XCTAssertEqual(selects, ["id,format_version,revision,status,curriculum->title", "*"])
    }
    func testUntypedRegistrationAndPrivateReadDenialsAreNotOfflineFailures() async throws {
        for status in [401, 403] {
            for body in [Data(), Data("Denied".utf8), Data("{\"message\":\"Denied\"}".utf8)] {
                let service = try service()
                _ = try await service.verifyCode(email: "fixture@example.org", code: "123456")
                let normal = ConnectionURLProtocol.handler!
                ConnectionURLProtocol.handler = { request in
                    if request.url?.path == "/rest/v1/rpc/register_touchline_session" { return (status, body) }
                    return try normal(request)
                }
                do { _ = try await service.verifyAccount(); XCTFail("Confirmed registration denial") }
                catch { XCTAssertTrue(SupabaseHubService.denied(error)) }
                ConnectionURLProtocol.handler = { request in
                    if request.url?.path == "/rest/v1/learning_courses" { return (status, body) }
                    return try normal(request)
                }
                do { _ = try await service.fetchCourse(accountID: account, curriculumID: "fixture-course"); XCTFail("Confirmed private-read denial") }
                catch { XCTAssertTrue(SupabaseHubService.denied(error)) }
            }
        }
    }
    func testCachedReconnectKeepsCopiesOn503ButClearsOnlyItsScopeOnPlain403() async throws {
        let service = try service(); _ = try await service.verifyCode(email: "fixture@example.org", code: "123456")
        let hub: HubDescription = try connectionFixture("hub-description", schema: "hub-description.v1.schema.json")
        let backup: LearningBackup = try connectionFixture("legacy-backup", schema: "legacy-backup.v1.schema.json")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let cache = try FileReadingCache(directory: root, reader: ContractReader())
        let scope = try hub.scope(accountID: account), other = try hub.scope(accountID: UUID())
        let course = PublishedCourse(format: "touchline-snapshot", version: 1, curriculum: backup.curriculum, progress: backup.state, status: .active, revision: 1, publishedAt: "2026-10-28T12:00:00Z")
        try cache.save([course], scope: scope, refreshedAt: Date()); try cache.save([course], scope: other, refreshedAt: Date())
        let suite = "touchline-protocol-reconnect-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        defaults.set(try JSONEncoder().encode(hub), forKey: "touchline.hub")
        defaults.set(try JSONEncoder().encode(scope), forKey: "touchline.activeScope")
        let store = HubStore(cache: cache, reader: try ContractReader(), bundled: backup, defaults: defaults, makeService: { _ in service }, makeHubService: { _ in service })
        let normal = ConnectionURLProtocol.handler!
        ConnectionURLProtocol.handler = { request in
            if request.url?.path == "/rest/v1/rpc/register_touchline_session" { return (503, Data("Unavailable".utf8)) }
            return try normal(request)
        }
        await store.restoreSession()
        XCTAssertTrue(store.signedIn); XCTAssertTrue(store.courses.contains { $0.readingSource == .downloaded })
        ConnectionURLProtocol.handler = { request in
            if request.url?.path == "/rest/v1/rpc/register_touchline_session" { return (403, Data("Denied".utf8)) }
            return try normal(request)
        }
        await store.restoreSession()
        XCTAssertFalse(store.signedIn); XCTAssertFalse(store.courses.contains { $0.readingSource == .downloaded })
        XCTAssertTrue(store.courses.contains { $0.readingSource == .bundled })
        XCTAssertNil(try cache.load(scope: scope)); XCTAssertNotNil(try cache.load(scope: other))
    }
    func testRegistrationIdentityMustMatchVerifiedAccount() async throws {
        registrationAccount = UUID(); let service = try service()
        do { _ = try await service.verifyCode(email: "fixture@example.org", code: "123456"); XCTFail("Wrong registration account") }
        catch { XCTAssertTrue(SupabaseHubService.denied(error)) }
        XCTAssertFalse(paths.contains("/rest/v1/learning_courses"))
    }
    func testRevokedSessionIsRejectedBeforePrivateRead() async throws {
        let service = try service(); _ = try await service.verifyCode(email: "fixture@example.org", code: "123456")
        paths = []; registrationDenied = true
        do { _ = try await service.fetch(accountID: account); XCTFail("Revoked session") }
        catch { XCTAssertTrue(SupabaseHubService.denied(error)) }
        XCTAssertFalse(paths.contains("/rest/v1/learning_courses"))
    }
    func testCancelledOrMismatchedBrowserCannotExchangeCode() async throws {
        let browser = FixtureBrowser(), service = try service(browser: browser)
        do { _ = try await service.signIn(provider: "google"); XCTFail("Cancelled") } catch {}
        XCTAssertEqual(browser.calls, 1); XCTAssertTrue(paths.isEmpty)
        browser.result = { _ in URL(string: "love.hannasage.touchline://auth/return?attempt=wrong&code=stolen")! }
        do { _ = try await service.signIn(provider: "apple"); XCTFail("Mismatched callback") } catch {}
        XCTAssertTrue(paths.isEmpty)
        do { _ = try await service.signIn(provider: "github"); XCTFail("Unconfigured provider") } catch {}
        XCTAssertEqual(browser.calls, 2)
    }
    func testValidProviderReturnUsesPKCEThenVerifiesAndRegisters() async throws {
        let browser = FixtureBrowser(), service = try service(browser: browser)
        browser.result = { url in
            let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            XCTAssertEqual(parts.host, "fixture.supabase.co")
            XCTAssertNotNil(parts.queryItems?.first { $0.name == "code_challenge" })
            let redirect = try XCTUnwrap(parts.queryItems?.first { $0.name == "redirect_to" }?.value)
            return URL(string: redirect + "&code=one-use")!
        }
        let id = try await service.signIn(provider: "google")
        XCTAssertEqual(id, account)
        XCTAssertEqual(paths, ["/auth/v1/token", "/auth/v1/user", "/rest/v1/rpc/register_touchline_session"])
    }
    func testDiscoveryRejectsChangedOriginRedirectsAndOversizedDescriptions() async throws {
        let hub: HubDescription = try connectionFixture("hub-description", schema: "hub-description.v1.schema.json")
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ConnectionURLProtocol.self]
        let discovery = HubDiscovery(reader: try ContractReader(), configuration: config)
        ConnectionURLProtocol.handler = { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertEqual(request.url?.path, "/.well-known/touchline.json")
            return (200, try JSONEncoder().encode(hub))
        }
        let found = try await discovery.discover("https://learn.example.org"); XCTAssertEqual(found.hubId, hub.hubId)
        do { _ = try await discovery.discover("https://other.example.org"); XCTFail("Changed origin") } catch {}
        ConnectionURLProtocol.handler = { _ in (302, Data("{}".utf8)) }
        do { _ = try await discovery.discover("https://learn.example.org"); XCTFail("Redirect") } catch {}
        ConnectionURLProtocol.handler = { _ in (200, Data(repeating: 32, count: 32_769)) }
        do { _ = try await discovery.discover("https://learn.example.org"); XCTFail("Oversized") } catch {}
        ConnectionURLProtocol.handler = nil
    }
}
