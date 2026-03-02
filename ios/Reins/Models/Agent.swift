import Foundation

/// Status of an AI agent
enum AgentStatus: String, Codable, CaseIterable {
    case active
    case suspended
    case pending

    var displayName: String {
        switch self {
        case .active: return "Active"
        case .suspended: return "Suspended"
        case .pending: return "Pending"
        }
    }
}

/// An AI agent registered with Reins
struct Agent: Identifiable, Codable, Equatable {
    let id: String
    let name: String
    let description: String?
    let policyId: String?
    let credentials: [String]
    let status: AgentStatus
    let createdAt: Date
    let updatedAt: Date

    /// Whether the agent is currently operational
    var isActive: Bool {
        status == .active
    }
}

/// Connection status for an agent
struct AgentConnection: Codable, Equatable {
    let agentId: String
    let connectedAt: Date
    let lastActivity: Date
    let status: ConnectionStatus
    let transport: TransportType

    enum ConnectionStatus: String, Codable {
        case connected
        case disconnected
    }

    enum TransportType: String, Codable {
        case stdio
        case http
        case websocket
    }
}
