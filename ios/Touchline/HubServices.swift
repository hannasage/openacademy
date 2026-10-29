import Foundation
import Supabase

@MainActor
protocol HubService: AnyObject {
    var cachedAccountID: UUID? { get }
    var onAccountChange: ((UUID?) -> Void)? { get set }
    func signIn(email: String, password: String) async throws -> UUID
    func signOut() async throws
    func fetch(accountID: UUID) async throws -> Data
    func fetchLibrary(accountID: UUID) async throws -> Data?
}
extension HubService { func fetchLibrary(accountID: UUID) async throws -> Data? { nil } }

@MainActor
final class SupabaseHubService: HubService {
    private let client: SupabaseClient
    private let connection: Connection
    private var observation: Task<Void, Never>?
    var onAccountChange: ((UUID?) -> Void)?
    var cachedAccountID: UUID? { client.auth.currentSession?.user.id }
    init(connection: Connection) {
        self.connection = connection
        client = SupabaseClient(supabaseURL: URL(string: connection.url)!, supabaseKey: connection.publishableKey)
        let auth = client.auth
        observation = Task { [weak self] in
            for await (_, session) in auth.authStateChanges {
                guard !Task.isCancelled else { break }
                self?.onAccountChange?(session?.user.id)
            }
        }
    }
    deinit { observation?.cancel() }
    func signIn(email: String, password: String) async throws -> UUID {
        let session = try await client.auth.signIn(email: email, password: password)
        let user = try await client.auth.user(jwt: session.accessToken)
        guard user.id == session.user.id else { throw HubError.message("The signed-in account changed. Try again.") }
        return user.id
    }
    func signOut() async throws { try await client.auth.signOut() }
    func fetchLibrary(accountID: UUID) async throws -> Data? {
        let transfer = try await verifiedTransfer(accountID: accountID)
        return try await transfer.from("learning_library_snapshots").select("snapshot").execute().data
    }
    func fetch(accountID: UUID) async throws -> Data {
        let transfer = try await verifiedTransfer(accountID: accountID)
        return try await transfer.from("learning_courses").select().order("updated_at", ascending: false).execute().data
    }
    private func verifiedTransfer(accountID: UUID) async throws -> SupabaseClient {
        let session = try await client.auth.session
        let user = try await client.auth.user(jwt: session.accessToken)
        guard user.id == accountID, session.user.id == accountID else { throw HubError.message("Sign in to the matching account before refreshing.") }
        let token = session.accessToken
        let transfer = SupabaseClient(supabaseURL: URL(string: connection.url)!, supabaseKey: connection.publishableKey,
            options: .init(auth: .init(accessToken: { token })))
        return transfer
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
