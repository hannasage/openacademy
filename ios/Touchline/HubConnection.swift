import Foundation
import AuthenticationServices
import UIKit
import CryptoKit

/// A confirmed backend rejection differs from a temporary inability to connect.
enum HubAccessError: LocalizedError {
    case unauthorized
    case cancelled
    var errorDescription: String? {
        switch self {
        case .unauthorized: return "This session no longer has access. Sign in again."
        case .cancelled: return "Sign-in cancelled."
        }
    }
}

extension HubDescription {
    var connection: Connection { Connection(url: backend.url, publishableKey: backend.publishableKey) }
    var authStorageKey: String {
        "touchline.auth." + SHA256.hash(data: Data("\(hubId.uuidString.lowercased())\n\(backend.url)".utf8)).map { String(format: "%02x", $0) }.joined()
    }
    func scope(accountID: UUID) throws -> AccountScope { try AccountScope(hubID: hubId, backendOrigin: backend.url, accountID: accountID) }
}

struct HubLink {
    static func origin(_ input: String) throws -> String {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf8.count <= 2048 else { throw HubError.message("The hub link is too long.") }
        if let link = URLComponents(string: trimmed), link.scheme == "touchline" {
            guard link.host == "connect", link.path.isEmpty, link.user == nil, link.password == nil, link.port == nil, link.fragment == nil,
                  let items = link.queryItems, items.count == 1, items[0].name == "hub", let address = items[0].value else {
                throw HubError.message("Use a hub address or a Touchline hub link.")
            }
            return try AccountScope.canonicalOrigin(address)
        }
        return try AccountScope.canonicalOrigin(trimmed)
    }
}

protocol HubDiscovering {
    func discover(_ input: String) async throws -> HubDescription
}
final class HubDiscovery: NSObject, HubDiscovering, URLSessionTaskDelegate, @unchecked Sendable {
    private let reader: ContractReader
    private let configuration: URLSessionConfiguration
    init(reader: ContractReader, configuration: URLSessionConfiguration = .ephemeral) { self.reader = reader; self.configuration = configuration }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func discover(_ input: String) async throws -> HubDescription {
        let origin = try HubLink.origin(input)
        let url = URL(string: origin + "/.well-known/touchline.json")!
        configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (stream, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, http.url == url,
              http.mimeType == "application/json", http.expectedContentLength <= 32_768 else {
            throw HubError.message("The hub did not return a supported connection description.")
        }
        var data = Data()
        for try await byte in stream {
            guard data.count < 32_768 else { throw HubError.message("The hub description is too large.") }
            data.append(byte)
        }
        let hub: HubDescription = try reader.decode(data, schema: "hub-description.v1.schema.json")
        guard hub.hubOrigin == origin else { throw HubError.message("The discovered hub address does not match the link.") }
        return hub
    }
}

struct NativeAuthAttempt {
    static let scheme = "love.hannasage.touchline"
    let id: UUID
    let hubID: UUID
    let backendOrigin: String
    let startedAt: Date
    init(hub: HubDescription, now: Date = Date()) {
        id = UUID(); hubID = hub.hubId; backendOrigin = hub.backend.url; startedAt = now
    }
    var returnURL: URL { URL(string: "\(Self.scheme)://auth/return?attempt=\(id.uuidString.lowercased())")! }
    func code(from url: URL, hub: HubDescription, now: Date = Date()) throws -> String {
        guard hub.hubId == hubID, hub.backend.url == backendOrigin, now.timeIntervalSince(startedAt) >= 0, now.timeIntervalSince(startedAt) <= 600,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.scheme == Self.scheme,
              parts.host == "auth", parts.path == "/return", parts.port == nil, parts.user == nil, parts.password == nil, parts.fragment == nil,
              let items = parts.queryItems, items.count == 2, Set(items.map(\.name)) == Set(["attempt", "code"]),
              items.first(where: { $0.name == "attempt" })?.value == id.uuidString.lowercased(),
              let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty, code.utf8.count <= 2048 else {
            throw HubError.message("This sign-in return does not match the request. Start sign-in again.")
        }
        return code
    }
}

@MainActor protocol NativeAuthBrowsing: AnyObject {
    func open(_ url: URL) async throws -> URL
    func cancel()
}
@MainActor final class NativeAuthBrowser: NSObject, NativeAuthBrowsing, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var continuation: CheckedContinuation<URL, Error>?
    private var requestID: UUID?
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
    func open(_ url: URL) async throws -> URL {
        cancel()
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let requestID = UUID(); self.requestID = requestID
            let next = ASWebAuthenticationSession(url: url, callbackURLScheme: NativeAuthAttempt.scheme) { [weak self] result, error in
                Task { @MainActor in
                    guard let self, self.requestID == requestID else { return }
                    self.requestID = nil
                    self.session = nil
                    let pending = self.continuation; self.continuation = nil
                    if let result { pending?.resume(returning: result) }
                    else { pending?.resume(throwing: error ?? HubAccessError.cancelled) }
                }
            }
            next.presentationContextProvider = self; next.prefersEphemeralWebBrowserSession = true
            session = next
            if !next.start() { self.continuation = nil; session = nil; continuation.resume(throwing: HubError.message("The sign-in browser could not open. Try again.")) }
        }
    }
    func cancel() {
        requestID = nil
        let pending = continuation; continuation = nil
        session?.cancel(); session = nil
        pending?.resume(throwing: HubAccessError.cancelled)
    }
}

/// Auth requests never follow a redirect to a different service or send ambient credentials.
final class HubNetworkSession: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static func make() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = 20; config.timeoutIntervalForResource = 30
        return URLSession(configuration: config, delegate: HubNetworkSession(), delegateQueue: nil)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

struct DownloadChoice: Decodable, Identifiable {
    let id: String
    let title: String
    let status: LibraryStatus
    let revision: Int
    let formatVersion: Int
    enum CodingKeys: String, CodingKey { case id, title, status, revision; case formatVersion = "format_version" }
    static func decode(_ row: [String: Any]) throws -> DownloadChoice {
        guard Set(row.keys) == Set(["id", "title", "status", "revision", "format_version"]) else { throw HubError.message("The published catalog has unsupported fields.") }
        let value = try JSONDecoder().decode(Self.self, from: JSONSerialization.data(withJSONObject: row))
        guard value.formatVersion == 1, value.revision >= 1, value.revision <= 9_007_199_254_740_991,
              value.id.range(of: "^[a-z0-9][a-z0-9-]{0,59}$", options: .regularExpression) != nil,
              !value.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw HubError.message("This published curriculum is unsupported.") }
        return value
    }
}
