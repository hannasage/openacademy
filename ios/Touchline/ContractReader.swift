import Foundation
import CoreFoundation

/// A fail-closed reader for the exact schema subset shipped with Touchline.
/// It is not a general JSON Schema implementation. New keywords require tests.
struct ContractReader {
    private let schemas: [String: [String: Any]]
    init(bundle: Bundle = .main) throws {
        guard let directory = bundle.url(forResource: "contracts", withExtension: nil) else {
            throw HubError.message("The application is missing its data contracts.")
        }
        try self.init(directory: directory)
    }
    init(directory: URL) throws {
        var result: [String: [String: Any]] = [:]
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) where url.lastPathComponent.hasSuffix(".schema.json") {
            guard let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any], let id = object["$id"] as? String else { throw HubError.message("A data contract is invalid.") }
            result[url.lastPathComponent] = object
            result[id] = object
        }
        schemas = result
    }
    func decode<T: Decodable>(_ data: Data, schema: String) throws -> T {
        try validate(data, schema: schema)
        return try JSONDecoder().decode(T.self, from: data)
    }
    func validate(_ data: Data, schema: String) throws {
        guard data.count <= 2_000_000, let definition = schemas[schema] else { throw HubError.message("Unsupported or oversized learning data.") }
        let value = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        try check(value, against: definition, depth: 0)
        try semantic(value, schema: schema)
    }
    private func fail() throws -> Never { throw HubError.message("The learning data does not match a supported contract.") }
    private func equal(_ lhs: Any, _ rhs: Any) -> Bool {
        // JSON booleans and numeric 0/1 must remain different.
        if type(of: lhs) == NSNull.self || type(of: rhs) == NSNull.self { return lhs is NSNull && rhs is NSNull }
        if let l = lhs as? NSNumber, let r = rhs as? NSNumber {
            return (CFGetTypeID(l) == CFBooleanGetTypeID()) == (CFGetTypeID(r) == CFBooleanGetTypeID()) && l == r
        }
        return (lhs as? NSObject)?.isEqual(rhs) == true
    }
    private func matches(_ value: Any, type: String) -> Bool {
        switch type {
        case "null": return value is NSNull
        case "object": return value is [String: Any]
        case "array": return value is [Any]
        case "string": return value is String
        case "boolean": return (value as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } ?? false
        case "number", "integer":
            guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return false }
            return type == "number" || n.doubleValue.rounded() == n.doubleValue
        default: return false
        }
    }
    private func check(_ value: Any, against schema: [String: Any], depth: Int) throws {
        guard depth < 60 else { try fail() }
        let keywords: Set<String> = ["$schema", "$id", "$ref", "$defs", "type", "properties", "required", "additionalProperties", "propertyNames", "items", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "pattern", "enum", "const", "oneOf", "allOf", "if", "then"]
        guard Set(schema.keys).isSubset(of: keywords) else { try fail() }
        if let ref = schema["$ref"] as? String {
            let parts = ref.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
            guard var target = schemas[String(parts[0])] else { try fail() }
            if parts.count == 2 {
                guard parts[1].hasPrefix("/") else { try fail() }
                for key in parts[1].dropFirst().split(separator: "/") {
                    let decoded = key.replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
                    guard let child = target[decoded] as? [String: Any] else { try fail() }
                    target = child
                }
            }
            try check(value, against: target, depth: depth + 1)
        }
        if let oneOf = schema["oneOf"] as? [[String: Any]], oneOf.filter({ (try? check(value, against: $0, depth: depth + 1)) != nil }).count != 1 { try fail() }
        if let allOf = schema["allOf"] as? [[String: Any]] { for sub in allOf { try check(value, against: sub, depth: depth + 1) } }
        if let condition = schema["if"] as? [String: Any], (try? check(value, against: condition, depth: depth + 1)) != nil, let then = schema["then"] as? [String: Any] { try check(value, against: then, depth: depth + 1) }
        if let constant = schema["const"], !equal(value, constant) { try fail() }
        if let options = schema["enum"] as? [Any], !options.contains(where: { equal(value, $0) }) { try fail() }
        let types = (schema["type"] as? [String]) ?? (schema["type"] as? String).map { [$0] }
        if let types, !types.contains(where: { matches(value, type: $0) }) { try fail() }
        if let text = value as? String {
            if let min = schema["minLength"] as? Int, text.unicodeScalars.count < min { try fail() }
            if let max = schema["maxLength"] as? Int, text.unicodeScalars.count > max { try fail() }
            if let pattern = schema["pattern"] as? String, try NSRegularExpression(pattern: pattern).firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) == nil { try fail() }
        }
        if matches(value, type: "number"), let number = value as? NSNumber {
            let n = number.doubleValue
            if let min = schema["minimum"] as? Double, n < min { try fail() }
            if let min = schema["exclusiveMinimum"] as? Double, n <= min { try fail() }
            if let max = schema["maximum"] as? Double, n > max { try fail() }
        }
        if let array = value as? [Any] {
            if let min = schema["minItems"] as? Int, array.count < min { try fail() }
            if let max = schema["maxItems"] as? Int, array.count > max { try fail() }
            if schema["uniqueItems"] as? Bool == true {
                for i in array.indices { if array[..<i].contains(where: { equal($0, array[i]) }) { try fail() } }
            }
            if let item = schema["items"] as? [String: Any] { for entry in array { try check(entry, against: item, depth: depth + 1) } }
        }
        if let object = value as? [String: Any] {
            let properties = schema["properties"] as? [String: [String: Any]] ?? [:]
            if let required = schema["required"] as? [String], !required.allSatisfy({ object[$0] != nil }) { try fail() }
            for (key, child) in object {
                if let names = schema["propertyNames"] as? [String: Any] { try check(key, against: names, depth: depth + 1) }
                if let property = properties[key] { try check(child, against: property, depth: depth + 1) }
                else if schema["additionalProperties"] as? Bool == false { try fail() }
                else if let additional = schema["additionalProperties"] as? [String: Any] { try check(child, against: additional, depth: depth + 1) }
            }
        }
    }
    private func calendarDate(_ value: String) -> Bool {
        if value.isEmpty { return true }
        if value.range(of: "^[0-9]{8}$", options: .regularExpression) != nil {
            let digits = Array(value)
            return calendarDate(String(digits[0..<4]) + "-" + String(digits[4..<6]) + "-" + String(digits[6..<8]))
        }
        for pattern in ["^([0-9]{4})-W([0-9]{2})(?:-([1-7]))?$", "^([0-9]{4})W([0-9]{2})([1-7])?$"] {
            let regex = try! NSRegularExpression(pattern: pattern)
            if let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) {
                let text = value as NSString
                guard let year = Int(text.substring(with: match.range(at: 1))),
                      let week = Int(text.substring(with: match.range(at: 2))) else { return false }
                let dayText = match.range(at: 3).location == NSNotFound ? "1" : text.substring(with: match.range(at: 3))
                guard let day = Int(dayText) else { return false }
                var calendar = Calendar(identifier: .iso8601); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
                guard year > 0, (1...53).contains(week), let date = calendar.date(from: DateComponents(weekday: day % 7 + 1, weekOfYear: week, yearForWeekOfYear: year)) else { return false }
                return calendar.component(.weekOfYear, from: date) == week && calendar.component(.yearForWeekOfYear, from: date) == year
            }
        }
        guard value.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else { return false }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        guard let date = formatter.date(from: value) else { return false }
        return formatter.string(from: date) == value
    }
    private func semantic(_ value: Any, schema: String) throws {
        guard let object = value as? [String: Any] else { return }
        if let origin = object["origin"] as? [String: Any], let url = origin["backendOrigin"] as? String { guard try AccountScope.canonicalOrigin(url) == url else { try fail() } }
        for key in ["hubOrigin", "backendOrigin"] { if let url = object[key] as? String { guard try AccountScope.canonicalOrigin(url) == url else { try fail() } } }
        if let backend = object["backend"] as? [String: Any], let url = backend["url"] as? String, let key = backend["publishableKey"] as? String {
            guard try AccountScope.canonicalOrigin(url) == url else { try fail() }
            _ = try Connection(url: url, publishableKey: key).validated()
        }
        if let timestamp = object["publishedAt"] as? String {
            let prefix = String(timestamp.prefix(10))
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = timestamp.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
            guard calendarDate(prefix), formatter.date(from: timestamp) != nil else { try fail() }
        }
        let curriculum = object["curriculum"] as? [String: Any] ?? (schema.contains("curriculum.v1") ? object : nil)
        let progress = (object["state"] ?? object["progress"]) as? [String: Any] ?? (schema.contains("progress.v1") ? object : nil)
        if let progress, let date = progress["startDate"] as? String, !calendarDate(date) { try fail() }
        guard let curriculum, let modules = curriculum["modules"] as? [[String: Any]] else { return }
        let ids = modules.compactMap { $0["id"] as? String }
        guard Set(ids).count == ids.count else { try fail() }
        let resources = curriculum["resources"] as? [String: Any] ?? [:]
        let duration = curriculum["weeks"] as? Double ?? 0
        for module in modules {
            guard let refs = module["resources"] as? [String], refs.allSatisfy({ resources[$0] != nil }), let prerequisites = module["prerequisites"] as? [String], prerequisites.allSatisfy({ ids.contains($0) }), let start = module["weekStart"] as? Double, let end = module["weekEnd"] as? Double, start <= end, end <= duration else { try fail() }
        }
        if let progress {
            guard progress["curriculumId"] as? String == curriculum["id"] as? String else { try fail() }
            for (key, raw) in progress["modules"] as? [String: Any] ?? [:] {
                guard let module = modules.first(where: { $0["id"] as? String == key }), let item = raw as? [String: Any], (item["tasks"] as? [Bool])?.count == (module["tasks"] as? [String])?.count else { try fail() }
            }
            for experiment in progress["experiments"] as? [[String: Any]] ?? [] { guard ids.contains(experiment["module"] as? String ?? "") else { try fail() } }
        }
        if let view = object["view"] as? [String: Any], !ids.contains(view["selectedModuleId"] as? String ?? "") { try fail() }
        if let draft = object["draft"] as? [String: Any], let experiment = draft["experiment"] as? [String: Any] {
            guard ids.contains(experiment["module"] as? String ?? ""), calendarDate(experiment["date"] as? String ?? "") else { try fail() }
        }
    }
}
