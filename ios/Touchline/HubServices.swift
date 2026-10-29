import Foundation
import Supabase
import Helpers

@MainActor
protocol HubService: AnyObject {
    var cachedAccountID: UUID? { get }
    var onAccountChange: ((UUID?) -> Void)? { get set }
    func signIn(email: String, password: String) async throws -> UUID
    func signOut() async throws
    func fetch(accountID: UUID) async throws -> Data
    func fetchLibrary(accountID: UUID) async throws -> Data?
    func requestCode(email: String) async throws
    func verifyCode(email: String, code: String) async throws -> UUID
    func signIn(provider: String) async throws -> UUID
    func verifyAccount() async throws -> UUID
    func fetchCatalog(accountID: UUID) async throws -> Data
    func fetchCourse(accountID: UUID, curriculumID: String) async throws -> Data
    func cancelAuthentication()
}
extension HubService {
    func fetchLibrary(accountID: UUID) async throws -> Data? { nil }
    func requestCode(email: String) async throws { throw HubError.message("Email sign-in is unavailable.") }
    func verifyCode(email: String, code: String) async throws -> UUID { throw HubError.message("Email sign-in is unavailable.") }
    func signIn(provider: String) async throws -> UUID { throw HubError.message("Provider sign-in is unavailable.") }
    func verifyAccount() async throws -> UUID { throw HubAccessError.unauthorized }
    func fetchCatalog(accountID: UUID) async throws -> Data { throw HubError.message("The published catalog is unavailable.") }
    func fetchCourse(accountID: UUID, curriculumID: String) async throws -> Data { throw HubError.message("Download selection is unavailable.") }
    func cancelAuthentication() {}
}

@MainActor
final class SupabaseHubService: HubService {
    private let client: SupabaseClient
    private let connection: Connection
    private let hub: HubDescription?
    private let browser: NativeAuthBrowsing
    private let transport: URLSession
    private var observation: Task<Void, Never>?
    private var authAttempt: NativeAuthAttempt?
    private var authGeneration = 0
    private var registeredSession: UUID?
    var onAccountChange: ((UUID?) -> Void)?
    var cachedAccountID: UUID? { client.auth.currentSession?.user.id }
    init(connection: Connection, hub: HubDescription? = nil, browser: NativeAuthBrowsing? = nil,
         storage: (any AuthLocalStorage)? = nil, transport: URLSession? = nil) {
        self.connection = connection; self.hub = hub; self.browser = browser ?? NativeAuthBrowser(); self.transport = transport ?? HubNetworkSession.make()
        client = SupabaseClient(supabaseURL: URL(string: connection.url)!, supabaseKey: connection.publishableKey,
            options: .init(auth: .init(storage: storage ?? KeychainLocalStorage(service: "love.hannasage.touchline.auth"),
                storageKey: hub?.authStorageKey ?? "touchline.legacy-disabled", flowType: .pkce, autoRefreshToken: false, emitLocalSessionAsInitialSession: true),
                global: .init(session: self.transport)))
        let auth = client.auth
        observation = Task { [weak self] in
            for await (_, session) in auth.authStateChanges {
                guard !Task.isCancelled else { break }
                self?.onAccountChange?(session?.user.id)
            }
        }
    }
    deinit { observation?.cancel(); transport.invalidateAndCancel() }
    func signIn(email: String, password: String) async throws -> UUID {
        throw HubError.message("Find your hub and request an email sign-in code.")
    }
    func requestCode(email: String) async throws {
        guard hub != nil else { throw HubError.message("Confirm a hub first.") }
        try await client.auth.signInWithOTP(email: email, shouldCreateUser: true)
    }
    func verifyCode(email: String, code: String) async throws -> UUID {
        let epoch = authGeneration
        let response = try await client.auth.verifyOTP(email: email, token: code, type: .email)
        try await requireAuthGeneration(epoch)
        guard let session = response.session, session.user.id == cachedAccountID else { throw HubAccessError.unauthorized }
        let account = try await verifyAccount()
        try await requireAuthGeneration(epoch)
        return account
    }
    func signIn(provider: String) async throws -> UUID {
        guard let hub, hub.auth.providers.contains(provider), ["google", "apple"].contains(provider) else { throw HubError.message("This hub has not enabled that sign-in method.") }
        let epoch = authGeneration
        let attempt = NativeAuthAttempt(hub: hub)
        authAttempt = attempt
        defer { if authAttempt?.id == attempt.id { authAttempt = nil } }
        let url = try client.auth.getOAuthSignInURL(provider: provider == "google" ? .google : .apple, redirectTo: attempt.returnURL)
        let result = try await browser.open(url)
        guard authAttempt?.id == attempt.id else { throw HubAccessError.cancelled }
        let code = try attempt.code(from: result, hub: hub)
        // Consume the app-bound return before exchanging its single-use code.
        authAttempt = nil
        _ = try await client.auth.exchangeCodeForSession(authCode: code)
        try await requireAuthGeneration(epoch)
        let account = try await verifyAccount()
        try await requireAuthGeneration(epoch)
        return account
    }
    private func requireAuthGeneration(_ epoch: Int) async throws {
        guard epoch == authGeneration else {
            // An in-flight SDK response must not restore tokens after cancellation or sign-out.
            try await client.auth.signOut(scope: .local)
            throw HubAccessError.cancelled
        }
    }
    func cancelAuthentication() { authGeneration += 1; authAttempt = nil; browser.cancel() }
    func verifyAccount() async throws -> UUID {
        guard let account = cachedAccountID else { throw HubAccessError.unauthorized }
        _ = try await verifiedTransfer(accountID: account)
        return account
    }
    func signOut() async throws {
        cancelAuthentication()
        if let account = cachedAccountID {
            do {
                let transfer = try await verifiedTransfer(accountID: account)
                guard let registeredSession else { throw HubAccessError.unauthorized }
                let result = try await transfer.request("rpc/revoke_touchline_session", parameters: ["target_session_id": registeredSession.uuidString.lowercased()], limit: 4096)
                guard String(data: result, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) == "true" else { throw HubError.message("The backend did not confirm sign-out. Retry cleanup.") }
            } catch {
                if !Self.denied(error) { throw error }
            }
        }
        try await client.auth.signOut(scope: .local)
        registeredSession = nil
    }
    func fetchLibrary(accountID: UUID) async throws -> Data? {
        try await privateRead(accountID: accountID) { try await $0.request("learning_library_snapshots", query: [URLQueryItem(name: "select", value: "snapshot")], limit: 10_000) }
    }
    func fetch(accountID: UUID) async throws -> Data {
        try await privateRead(accountID: accountID) { try await $0.request("learning_courses", query: [URLQueryItem(name: "select", value: "*"), URLQueryItem(name: "order", value: "updated_at.desc"), URLQueryItem(name: "limit", value: "101")]) }
    }
    func fetchCatalog(accountID: UUID) async throws -> Data {
        try await privateRead(accountID: accountID) { try await $0.request("learning_courses", query: [URLQueryItem(name: "select", value: "id,format_version,revision,status,curriculum->title"), URLQueryItem(name: "order", value: "updated_at.desc"), URLQueryItem(name: "limit", value: "101")], limit: 2_000_000) }
    }
    func fetchCourse(accountID: UUID, curriculumID: String) async throws -> Data {
        try await privateRead(accountID: accountID) { try await $0.request("learning_courses", query: [URLQueryItem(name: "select", value: "*"), URLQueryItem(name: "id", value: "eq." + curriculumID), URLQueryItem(name: "limit", value: "2")]) }
    }
    private func privateRead(accountID: UUID, _ read: (NativePrivateTransfer) async throws -> Data) async throws -> Data {
        do {
            let transfer = try await verifiedTransfer(accountID: accountID)
            return try await read(transfer)
        } catch { if Self.denied(error) { throw HubAccessError.unauthorized }; throw error }
    }
    private func verifiedTransfer(accountID: UUID) async throws -> NativePrivateTransfer {
        do {
            guard hub != nil else { throw HubAccessError.unauthorized }
            let session = try await client.auth.session
            let user = try await client.auth.user(jwt: session.accessToken)
            guard user.id == accountID, session.user.id == accountID, user.emailConfirmedAt != nil,
                  user.email?.isEmpty == false, !user.isAnonymous else { throw HubAccessError.unauthorized }
            let token = session.accessToken
            let transfer = NativePrivateTransfer(connection: connection, token: token, transport: transport)
            let bytes = try await transfer.request("rpc/register_touchline_session", parameters: ["device_label": "Touchline iPhone or iPad"], limit: 4096)
            guard let result = try JSONSerialization.jsonObject(with: bytes) as? [String: String], Set(result.keys) == Set(["accountId", "sessionId"]),
                  UUID(uuidString: result["accountId"] ?? "") == accountID, let sessionID = UUID(uuidString: result["sessionId"] ?? "") else { throw HubAccessError.unauthorized }
            registeredSession = sessionID
            guard cachedAccountID == accountID else { throw HubAccessError.unauthorized }
            return transfer
        } catch { if Self.denied(error) { throw HubAccessError.unauthorized }; throw error }
    }
    static func denied(_ error: Error) -> Bool {
        if case HubAccessError.unauthorized = error { return true }
        if let auth = error as? AuthError {
            if auth == .sessionMissing { return true }
            if case .api(_, _, _, let response) = auth { return [401, 403].contains(response.statusCode) }
        }
        if let error = error as? HTTPError { return [401, 403].contains(error.response.statusCode) }
        if let error = error as? PostgrestError { return ["42501", "PGRST301", "PGRST303"].contains(error.code ?? "") }
        return false
    }
}

/// Preserve the HTTP status before decoding: PostgREST's error decoder can discard it.
private struct NativePrivateTransfer {
    let connection: Connection
    let token: String
    let transport: URLSession
    func request(_ route: String, query: [URLQueryItem] = [], parameters: [String: String]? = nil, limit: Int = 20_000_000) async throws -> Data {
        var parts = URLComponents(string: connection.url + "/rest/v1/" + route)!
        if !query.isEmpty { parts.queryItems = query }
        let url = parts.url!
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue(connection.publishableKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let parameters {
            request.httpMethod = "POST"; request.httpBody = try JSONEncoder().encode(parameters)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (stream, response) = try await transport.bytes(for: request)
        defer { stream.task.cancel() }
        guard let http = response as? HTTPURLResponse, http.url == url else { throw HubError.message("The hub returned an unexpected destination.") }
        if [401, 403].contains(http.statusCode) { throw HubAccessError.unauthorized }
        guard (200..<300).contains(http.statusCode) else { throw HubError.message("The hub returned status \(http.statusCode). Try again when the service is available.") }
        guard http.expectedContentLength <= limit else { throw HubError.message("The hub response is too large.") }
        var bytes = Data()
        for try await byte in stream {
            guard bytes.count < limit else { throw HubError.message("The hub response is too large.") }
            bytes.append(byte)
        }
        return bytes
    }
}

@MainActor
final class OfflineTestHubService: HubService {
    private(set) var cachedAccountID: UUID?
    private var signOutFailures: Int
    var onAccountChange: ((UUID?) -> Void)?
    init(accountID: UUID? = nil, signOutFailures: Int = 0) {
        cachedAccountID = accountID; self.signOutFailures = signOutFailures
    }
    func signIn(email: String, password: String) async throws -> UUID { throw HubError.message("Network access is disabled in this test.") }
    func signOut() async throws {
        if signOutFailures > 0 {
            signOutFailures -= 1
            throw HubError.message("The test account could not sign out.")
        }
        cachedAccountID = nil; onAccountChange?(nil)
    }
    func fetch(accountID: UUID) async throws -> Data { throw HubError.message("Network access is disabled in this test.") }
}

/// Disposable, network-free app fixtures selected only by the isolated test host.
struct NativeConnectionFixtureDiscovery: HubDiscovering {
    static let hub = HubDescription(format: "touchline-hub", version: 1,
        hubId: UUID(uuidString: "33333333-3333-4333-8333-333333333333")!, name: "Fixture learning hub",
        hubOrigin: "https://learn.example.org", backend: .init(type: "supabase", url: "https://fixture.supabase.co", publishableKey: "sb_publishable_fixture"),
        contracts: .init(snapshot: 1, progress: 1), auth: .init(email: "otp", providers: ["google", "apple"]))
    func discover(_ input: String) async throws -> HubDescription {
        guard try HubLink.origin(input) == Self.hub.hubOrigin else { throw HubError.message("Use the isolated fixture hub address.") }
        return Self.hub
    }
}
@MainActor final class NativeConnectionFixtureService: HubService {
    var cachedAccountID: UUID?
    var onAccountChange: ((UUID?) -> Void)?
    private let account = UUID()
    private var rows: [[String: Any]] = []
    init(curriculum: Curriculum?) {
        guard let curriculum else { return }
        do {
            rows = try ["soccer", "shaders", "photography"].enumerated().map { index, id in
                var content = try JSONSerialization.jsonObject(with: JSONEncoder().encode(curriculum)) as! [String: Any]
                content["id"] = id; content["title"] = ["Soccer → machine learning", "Creative coding with shaders", "Photography fundamentals"][index]
                let course = try JSONDecoder().decode(Curriculum.self, from: JSONSerialization.data(withJSONObject: content))
                let progress = try JSONSerialization.jsonObject(with: JSONEncoder().encode(LearningProgress.empty(for: course)))
                return ["id": id, "format_version": 1, "curriculum": content, "progress": progress, "status": index == 2 ? "paused" : "active", "revision": 1, "updated_at": "2026-10-28T12:00:00Z"]
            }
        } catch { rows = [] }
    }
    func signIn(email: String, password: String) async throws -> UUID { throw HubAccessError.unauthorized }
    func requestCode(email: String) async throws {}
    func verifyCode(email: String, code: String) async throws -> UUID {
        guard code == "123456" else { throw HubError.message("The code expired. Request another code.") }
        cachedAccountID = account; return account
    }
    func signIn(provider: String) async throws -> UUID { throw HubAccessError.cancelled }
    func verifyAccount() async throws -> UUID { guard cachedAccountID == account else { throw HubAccessError.unauthorized }; return account }
    func signOut() async throws { cachedAccountID = nil; onAccountChange?(nil) }
    func fetch(accountID: UUID) async throws -> Data { _ = try await verifyAccount(); return try JSONSerialization.data(withJSONObject: rows) }
    func fetchCatalog(accountID: UUID) async throws -> Data {
        _ = try await verifyAccount()
        return try JSONSerialization.data(withJSONObject: rows.map { row in
            ["id": row["id"]!, "format_version": row["format_version"]!, "revision": row["revision"]!, "status": row["status"]!, "title": (row["curriculum"] as! [String: Any])["title"]!]
        })
    }
    func fetchCourse(accountID: UUID, curriculumID: String) async throws -> Data { _ = try await verifyAccount(); return try JSONSerialization.data(withJSONObject: rows.filter { $0["id"] as? String == curriculumID }) }
    func fetchLibrary(accountID: UUID) async throws -> Data? {
        _ = try await verifyAccount()
        return Data("[{\"snapshot\":{\"version\":1,\"revision\":1,\"focusCurriculumId\":\"soccer\"}}]".utf8)
    }
}
