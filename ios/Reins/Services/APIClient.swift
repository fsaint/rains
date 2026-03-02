import Foundation

/// Errors that can occur during API operations
enum APIError: LocalizedError {
    case invalidURL
    case networkError(Error)
    case invalidResponse
    case httpError(statusCode: Int, message: String?)
    case decodingError(Error)
    case notFound
    case serverError(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        case .invalidResponse:
            return "Invalid response from server"
        case .httpError(let code, let message):
            return "HTTP error \(code): \(message ?? "Unknown")"
        case .decodingError(let error):
            return "Failed to parse response: \(error.localizedDescription)"
        case .notFound:
            return "Resource not found"
        case .serverError(let message):
            return "Server error: \(message)"
        }
    }
}

/// API response wrapper
struct APIResponse<T: Decodable>: Decodable {
    let data: T?
    let error: APIErrorResponse?
}

/// API error response structure
struct APIErrorResponse: Decodable {
    let code: String
    let message: String
    let details: [String: AnyCodable]?
}

/// Paginated response wrapper
struct PaginatedResponse<T: Decodable>: Decodable {
    let items: [T]
    let total: Int
    let limit: Int
    let offset: Int
    let hasMore: Bool
}

/// HTTP client for the Reins API
actor APIClient {

    static let shared = APIClient()

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: config)

        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let dateString = try container.decode(String.self)

            // Try ISO8601 with fractional seconds
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: dateString) {
                return date
            }

            // Try ISO8601 without fractional seconds
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: dateString) {
                return date
            }

            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date format: \(dateString)")
        }

        self.encoder = JSONEncoder()
        self.encoder.dateEncodingStrategy = .iso8601
    }

    // MARK: - Approvals

    /// Fetch all pending approval requests
    func fetchApprovals(agentId: String? = nil) async throws -> [ApprovalRequest] {
        var path = "/api/approvals"
        if let agentId = agentId {
            path += "?agentId=\(agentId)"
        }
        let response: APIResponse<[ApprovalRequest]> = try await get(path: path)
        return response.data ?? []
    }

    /// Fetch a single approval request
    func fetchApproval(id: String) async throws -> ApprovalRequest {
        let response: APIResponse<ApprovalRequest> = try await get(path: "/api/approvals/\(id)")
        guard let approval = response.data else {
            throw APIError.notFound
        }
        return approval
    }

    /// Approve a pending request
    func approveRequest(id: String, comment: String? = nil) async throws -> ApprovalRequest {
        let body: [String: Any] = comment != nil ? ["comment": comment!] : [:]
        let response: APIResponse<ApprovalRequest> = try await post(path: "/api/approvals/\(id)/approve", body: body)
        guard let approval = response.data else {
            throw APIError.serverError("Failed to approve request")
        }
        return approval
    }

    /// Reject a pending request
    func rejectRequest(id: String, reason: String?) async throws -> ApprovalRequest {
        let body: [String: Any] = reason != nil ? ["reason": reason!] : [:]
        let response: APIResponse<ApprovalRequest> = try await post(path: "/api/approvals/\(id)/reject", body: body)
        guard let approval = response.data else {
            throw APIError.serverError("Failed to reject request")
        }
        return approval
    }

    // MARK: - Agents

    /// Fetch all agents
    func fetchAgents() async throws -> [Agent] {
        let response: APIResponse<[Agent]> = try await get(path: "/api/agents")
        return response.data ?? []
    }

    /// Fetch a single agent
    func fetchAgent(id: String) async throws -> Agent {
        let response: APIResponse<Agent> = try await get(path: "/api/agents/\(id)")
        guard let agent = response.data else {
            throw APIError.notFound
        }
        return agent
    }

    // MARK: - Audit

    /// Fetch audit log entries
    func fetchAuditLog(filter: AuditFilter? = nil) async throws -> [AuditEntry] {
        var queryItems: [URLQueryItem] = []

        if let filter = filter {
            if let startDate = filter.startDate {
                queryItems.append(URLQueryItem(name: "startDate", value: ISO8601DateFormatter().string(from: startDate)))
            }
            if let endDate = filter.endDate {
                queryItems.append(URLQueryItem(name: "endDate", value: ISO8601DateFormatter().string(from: endDate)))
            }
            if let agentId = filter.agentId {
                queryItems.append(URLQueryItem(name: "agentId", value: agentId))
            }
            if let eventType = filter.eventType {
                queryItems.append(URLQueryItem(name: "eventType", value: eventType.rawValue))
            }
            if let tool = filter.tool {
                queryItems.append(URLQueryItem(name: "tool", value: tool))
            }
            if let result = filter.result {
                queryItems.append(URLQueryItem(name: "result", value: result.rawValue))
            }
            if let limit = filter.limit {
                queryItems.append(URLQueryItem(name: "limit", value: String(limit)))
            }
            if let offset = filter.offset {
                queryItems.append(URLQueryItem(name: "offset", value: String(offset)))
            }
        }

        var path = "/api/audit"
        if !queryItems.isEmpty {
            var components = URLComponents(string: path)!
            components.queryItems = queryItems
            path = components.string!
        }

        let response: APIResponse<[AuditEntry]> = try await get(path: path)
        return response.data ?? []
    }

    // MARK: - Device Registration

    /// Register device for push notifications
    func registerDevice(token: String, deviceId: String) async throws {
        let body: [String: Any] = [
            "token": token,
            "deviceId": deviceId,
            "platform": "ios"
        ]
        let _: APIResponse<DeviceRegistrationResponse> = try await post(path: "/api/devices/register", body: body)
    }

    /// Unregister device from push notifications
    func unregisterDevice(deviceId: String) async throws {
        try await delete(path: "/api/devices/\(deviceId)")
    }

    // MARK: - Connections

    /// Fetch all active connections
    func fetchConnections() async throws -> [AgentConnection] {
        let response: APIResponse<[AgentConnection]> = try await get(path: "/api/connections")
        return response.data ?? []
    }

    // MARK: - Health

    /// Check API health
    func checkHealth() async throws -> Bool {
        struct HealthResponse: Decodable {
            let status: String
        }
        let response: HealthResponse = try await get(path: "/health")
        return response.status == "ok"
    }

    // MARK: - Private Helpers

    private func get<T: Decodable>(path: String) async throws -> T {
        let url = AppConfig.apiBaseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        return try await perform(request)
    }

    private func post<T: Decodable>(path: String, body: [String: Any]) async throws -> T {
        let url = AppConfig.apiBaseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        return try await perform(request)
    }

    private func delete(path: String) async throws {
        let url = AppConfig.apiBaseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"

        let (_, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        if httpResponse.statusCode == 404 {
            throw APIError.notFound
        }

        if httpResponse.statusCode >= 400 {
            throw APIError.httpError(statusCode: httpResponse.statusCode, message: nil)
        }
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse

        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.networkError(error)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        if httpResponse.statusCode == 404 {
            throw APIError.notFound
        }

        if httpResponse.statusCode >= 400 {
            // Try to parse error response
            if let errorResponse = try? decoder.decode(APIResponse<EmptyResponse>.self, from: data),
               let error = errorResponse.error {
                throw APIError.httpError(statusCode: httpResponse.statusCode, message: error.message)
            }
            throw APIError.httpError(statusCode: httpResponse.statusCode, message: nil)
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }
}

/// Empty response placeholder
private struct EmptyResponse: Decodable {}

/// Device registration response
private struct DeviceRegistrationResponse: Decodable {
    let deviceId: String
}
