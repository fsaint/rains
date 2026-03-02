import Foundation

/// Type of audit event
enum AuditEventType: String, Codable, CaseIterable {
    case toolCall = "tool_call"
    case approval
    case policyChange = "policy_change"
    case auth
    case connection

    var displayName: String {
        switch self {
        case .toolCall: return "Tool Call"
        case .approval: return "Approval"
        case .policyChange: return "Policy Change"
        case .auth: return "Authentication"
        case .connection: return "Connection"
        }
    }

    var iconName: String {
        switch self {
        case .toolCall: return "hammer"
        case .approval: return "checkmark.circle"
        case .policyChange: return "doc.text"
        case .auth: return "key"
        case .connection: return "network"
        }
    }
}

/// Result of an audited action
enum AuditResult: String, Codable, CaseIterable {
    case success
    case blocked
    case error
    case pending

    var displayName: String {
        switch self {
        case .success: return "Success"
        case .blocked: return "Blocked"
        case .error: return "Error"
        case .pending: return "Pending"
        }
    }
}

/// An entry in the audit log
struct AuditEntry: Identifiable, Codable, Equatable {
    let id: Int
    let timestamp: Date
    let eventType: AuditEventType
    let agentId: String?
    let tool: String?
    let arguments: [String: AnyCodable]?
    let result: AuditResult?
    let durationMs: Int?
    let metadata: [String: AnyCodable]?

    /// Formatted duration string
    var durationString: String? {
        guard let ms = durationMs else { return nil }
        if ms < 1000 {
            return "\(ms)ms"
        }
        return String(format: "%.2fs", Double(ms) / 1000.0)
    }

    /// Summary description of the event
    var summary: String {
        switch eventType {
        case .toolCall:
            if let tool = tool {
                return "Called \(tool)"
            }
            return "Tool call"
        case .approval:
            return "Approval request"
        case .policyChange:
            return "Policy updated"
        case .auth:
            return "Authentication event"
        case .connection:
            return "Connection event"
        }
    }
}

/// Filter options for audit log queries
struct AuditFilter: Encodable {
    var startDate: Date?
    var endDate: Date?
    var agentId: String?
    var eventType: AuditEventType?
    var tool: String?
    var result: AuditResult?
    var limit: Int?
    var offset: Int?
}
