import Foundation
import CryptoKit

struct AccountScope: Codable, Equatable {
    let hubID: UUID
    let backendOrigin: String
    let accountID: UUID
    init(hubID: UUID, backendOrigin: String, accountID: UUID) throws {
        guard try Self.canonicalOrigin(backendOrigin) == backendOrigin else { throw HubError.message("The backend origin is not canonical.") }
        self.hubID = hubID; self.backendOrigin = backendOrigin; self.accountID = accountID
    }
    static func canonicalOrigin(_ value: String) throws -> String {
        guard let url = URLComponents(string: value), url.scheme?.lowercased() == "https", let host = url.host?.lowercased(), !host.isEmpty, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/", url.port == nil || (1...65535).contains(url.port!) else { throw HubError.message("Use an HTTPS backend origin without a path or credentials.") }
        var result = URLComponents(); result.scheme = "https"; result.host = host; result.port = url.port == 443 ? nil : url.port
        guard let string = result.string else { throw HubError.message("Invalid backend origin.") }
        return string
    }
    static func legacy(connection: Connection, accountID: UUID) throws -> AccountScope {
        let origin = try canonicalOrigin(connection.url)
        var bytes: [UInt8] = [0x6b,0xa7,0xb8,0x11,0x9d,0xad,0x11,0xd1,0x80,0xb4,0,0xc0,0x4f,0xd4,0x30,0xc8]
        bytes.append(contentsOf: origin.utf8)
        var digest = Array(Insecure.SHA1.hash(data: Data(bytes)).prefix(16)); digest[6] = (digest[6] & 15) | 80; digest[8] = (digest[8] & 63) | 128
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        let chars = Array(hex)
        let groups = [String(chars[0..<8]),String(chars[8..<12]),String(chars[12..<16]),String(chars[16..<20]),String(chars[20..<32])]
        return try AccountScope(hubID: UUID(uuidString: groups.joined(separator: "-"))!, backendOrigin: origin, accountID: accountID)
    }
    var storageKey: String {
        SHA256.hash(data: Data("\(hubID.uuidString.lowercased())\n\(backendOrigin)\n\(accountID.uuidString.lowercased())".utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
struct CachedDownload: Codable {
    let format: String
    let version: Int
    let scope: AccountScope
    let records: [PublishedCourse]
    let refreshedAt: Date
}
protocol ReadingCache {
    var hasUnownedLegacyCache: Bool { get }
    func load(scope: AccountScope) throws -> CachedDownload?
    func save(_ records: [PublishedCourse], scope: AccountScope, refreshedAt: Date) throws
    func remove(scope: AccountScope) throws
    func loadImports() throws -> [LearningBackup]
    func saveImports(_ records: [LearningBackup]) throws
}
final class FileReadingCache: ReadingCache {
    private let directory: URL
    private let reader: ContractReader
    private let writer: (Data, URL) throws -> Void
    init(directory: URL, reader: ContractReader, writer: @escaping (Data, URL) throws -> Void = { data, url in
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }) throws {
        self.directory = directory; self.reader = reader; self.writer = writer
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        try safe(directory)
    }
    private func safe(_ url: URL) throws {
        if try url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true { throw HubError.message("A reading-cache path is unsafe.") }
    }
    private func location(_ scope: AccountScope) -> URL { directory.appendingPathComponent(scope.storageKey + ".json") }
    var hasUnownedLegacyCache: Bool { FileManager.default.fileExists(atPath: directory.appendingPathComponent("courses.json").path) }
    func load(scope: AccountScope) throws -> CachedDownload? {
        let url = location(scope)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        try safe(url)
        let data = try Data(contentsOf: url)
        guard data.count <= 20_000_000 else { throw HubError.message("The reading cache is too large.") }
        guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any], Set(envelope.keys) == Set(["format", "version", "scope", "records", "refreshedAt"]),
              let origin = envelope["scope"] as? [String: Any], Set(origin.keys) == Set(["hubID", "backendOrigin", "accountID"]),
              let snapshots = envelope["records"] as? [[String: Any]], snapshots.count <= 100 else { throw HubError.message("The reading cache has an unsupported format.") }
        for snapshot in snapshots { try reader.validate(JSONSerialization.data(withJSONObject: snapshot), schema: "published-course.v1.schema.json") }
        let saved = try JSONDecoder().decode(CachedDownload.self, from: data)
        guard saved.format == "touchline-native-cache", saved.version == 1, saved.scope == scope else { throw HubError.message("The saved download belongs to another account or version.") }
        try validate(saved.records)
        return saved
    }
    private func validate(_ records: [PublishedCourse]) throws {
        guard records.count <= 100, Set(records.map { $0.curriculum.id }).count == records.count else { throw HubError.message("Downloaded curricula contain duplicate identifiers.") }
        for record in records { try reader.validate(JSONEncoder().encode(record), schema: "published-course.v1.schema.json") }
    }
    func save(_ records: [PublishedCourse], scope: AccountScope, refreshedAt: Date) throws {
        try validate(records)
        let target = location(scope)
        if FileManager.default.fileExists(atPath: target.path) { try safe(target) }
        let bytes = try JSONEncoder().encode(CachedDownload(format: "touchline-native-cache", version: 1, scope: scope, records: records, refreshedAt: refreshedAt))
        guard bytes.count <= 20_000_000 else { throw HubError.message("The reading cache is too large.") }
        try writer(bytes, target)
    }
    func remove(scope: AccountScope) throws {
        let target = location(scope)
        if FileManager.default.fileExists(atPath: target.path) { try safe(target); try FileManager.default.removeItem(at: target) }
    }
    func loadImports() throws -> [LearningBackup] {
        let target = directory.appendingPathComponent("local-imports-v1.json")
        guard FileManager.default.fileExists(atPath: target.path) else { return [] }
        try safe(target)
        let data = try Data(contentsOf: target)
        guard data.count <= 20_000_000 else { throw HubError.message("Local imports are too large.") }
        guard let entries = try JSONSerialization.jsonObject(with: data) as? [[String: Any]], entries.count <= 100 else { throw HubError.message("The local import cache is invalid.") }
        for entry in entries { try reader.validate(JSONSerialization.data(withJSONObject: entry), schema: "legacy-backup.v1.schema.json") }
        let records = try JSONDecoder().decode([LearningBackup].self, from: data)
        try validateImports(records)
        return records
    }
    private func validateImports(_ records: [LearningBackup]) throws {
        guard records.count <= 100, Set(records.map { $0.curriculum.id }).count == records.count else { throw HubError.message("Local imports contain duplicate identifiers.") }
        for record in records { try reader.validate(JSONEncoder().encode(record), schema: "legacy-backup.v1.schema.json") }
    }
    func saveImports(_ records: [LearningBackup]) throws {
        try validateImports(records)
        let target = directory.appendingPathComponent("local-imports-v1.json")
        if FileManager.default.fileExists(atPath: target.path) { try safe(target) }
        let bytes = try JSONEncoder().encode(records)
        guard bytes.count <= 20_000_000 else { throw HubError.message("Local imports are too large.") }
        try writer(bytes, target)
    }
}
