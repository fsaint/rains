import Foundation

/// Events received from the WebSocket
enum WebSocketEvent {
    case approvalRequest(ApprovalRequest)
    case approvalResolved(ApprovalRequest)
    case agentStatus(agentId: String, status: AgentStatus)
    case credentialHealth(credentialId: String, valid: Bool)
    case spendAlert(agentId: String, message: String)
    case connectionStatus(agentId: String, connected: Bool)
    case connected
    case disconnected(Error?)
}

/// WebSocket message structure from backend
private struct WebSocketMessage: Decodable {
    let type: String
    let data: AnyCodable
    let timestamp: Date?
}

/// WebSocket client for real-time updates
@MainActor
class WebSocketClient: NSObject, ObservableObject {

    static let shared = WebSocketClient()

    @Published private(set) var isConnected = false
    @Published private(set) var lastError: Error?

    private var webSocket: URLSessionWebSocketTask?
    private var session: URLSession!
    private var reconnectTimer: Timer?
    private var eventHandlers: [(WebSocketEvent) -> Void] = []

    private let decoder: JSONDecoder
    private let reconnectDelay: TimeInterval = 5.0
    private var shouldReconnect = false

    private override init() {
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .iso8601

        super.init()

        let config = URLSessionConfiguration.default
        self.session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }

    /// Subscribe to WebSocket events
    func subscribe(_ handler: @escaping (WebSocketEvent) -> Void) {
        eventHandlers.append(handler)
    }

    /// Connect to the WebSocket server
    func connect() {
        guard webSocket == nil else { return }

        shouldReconnect = true
        let url = AppConfig.webSocketURL
        webSocket = session.webSocketTask(with: url)
        webSocket?.resume()

        receiveMessage()
    }

    /// Disconnect from the WebSocket server
    func disconnect() {
        shouldReconnect = false
        reconnectTimer?.invalidate()
        reconnectTimer = nil

        webSocket?.cancel(with: .normalClosure, reason: nil)
        webSocket = nil

        isConnected = false
        emit(.disconnected(nil))
    }

    /// Send a message through the WebSocket
    func send(_ message: [String: Any]) async throws {
        guard let webSocket = webSocket else {
            throw WebSocketError.notConnected
        }

        let data = try JSONSerialization.data(withJSONObject: message)
        let string = String(data: data, encoding: .utf8)!

        try await webSocket.send(.string(string))
    }

    // MARK: - Private Methods

    private func receiveMessage() {
        webSocket?.receive { [weak self] result in
            guard let self = self else { return }

            switch result {
            case .success(let message):
                Task { @MainActor in
                    self.handleMessage(message)
                    self.receiveMessage()
                }

            case .failure(let error):
                Task { @MainActor in
                    self.handleError(error)
                }
            }
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text):
            parseMessage(text)
        case .data(let data):
            if let text = String(data: data, encoding: .utf8) {
                parseMessage(text)
            }
        @unknown default:
            break
        }
    }

    private func parseMessage(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }

        do {
            let message = try decoder.decode(WebSocketMessage.self, from: data)
            handleParsedMessage(message)
        } catch {
            print("WebSocket: Failed to parse message: \(error)")
        }
    }

    private func handleParsedMessage(_ message: WebSocketMessage) {
        switch message.type {
        case "approval_request":
            if let jsonData = try? JSONSerialization.data(withJSONObject: message.data.value),
               let approval = try? decoder.decode(ApprovalRequest.self, from: jsonData) {
                emit(.approvalRequest(approval))
            }

        case "approval_resolved":
            if let jsonData = try? JSONSerialization.data(withJSONObject: message.data.value),
               let approval = try? decoder.decode(ApprovalRequest.self, from: jsonData) {
                emit(.approvalResolved(approval))
            }

        case "agent_status":
            if let dict = message.data.value as? [String: Any],
               let agentId = dict["agentId"] as? String,
               let statusStr = dict["status"] as? String,
               let status = AgentStatus(rawValue: statusStr) {
                emit(.agentStatus(agentId: agentId, status: status))
            }

        case "credential_health":
            if let dict = message.data.value as? [String: Any],
               let credentialId = dict["credentialId"] as? String,
               let valid = dict["valid"] as? Bool {
                emit(.credentialHealth(credentialId: credentialId, valid: valid))
            }

        case "spend_alert":
            if let dict = message.data.value as? [String: Any],
               let agentId = dict["agentId"] as? String,
               let alertMessage = dict["message"] as? String {
                emit(.spendAlert(agentId: agentId, message: alertMessage))
            }

        case "connection_status":
            if let dict = message.data.value as? [String: Any],
               let agentId = dict["agentId"] as? String,
               let connected = dict["connected"] as? Bool {
                emit(.connectionStatus(agentId: agentId, connected: connected))
            }

        default:
            print("WebSocket: Unknown message type: \(message.type)")
        }
    }

    private func handleError(_ error: Error) {
        lastError = error
        isConnected = false
        webSocket = nil

        emit(.disconnected(error))

        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard shouldReconnect else { return }

        reconnectTimer?.invalidate()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: reconnectDelay, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.connect()
            }
        }
    }

    private func emit(_ event: WebSocketEvent) {
        for handler in eventHandlers {
            handler(event)
        }
    }
}

// MARK: - URLSessionWebSocketDelegate

extension WebSocketClient: URLSessionWebSocketDelegate {

    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        Task { @MainActor in
            self.isConnected = true
            self.lastError = nil
            self.emit(.connected)
        }
    }

    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        Task { @MainActor in
            self.isConnected = false
            self.webSocket = nil
            self.emit(.disconnected(nil))
            self.scheduleReconnect()
        }
    }
}

/// WebSocket specific errors
enum WebSocketError: LocalizedError {
    case notConnected
    case sendFailed

    var errorDescription: String? {
        switch self {
        case .notConnected:
            return "WebSocket is not connected"
        case .sendFailed:
            return "Failed to send message"
        }
    }
}
