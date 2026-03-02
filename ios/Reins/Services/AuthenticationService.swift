import Foundation

/// Handles authentication with the Reins backend
@MainActor
class AuthenticationService: ObservableObject {

    static let shared = AuthenticationService()

    @Published private(set) var isAuthenticated = false
    @Published private(set) var isCheckingConnection = false
    @Published private(set) var connectionError: String?

    private let apiTokenKey = "api_token"

    /// Current API token (if any)
    var apiToken: String? {
        get { UserDefaults.standard.string(forKey: apiTokenKey) }
        set {
            if let value = newValue {
                UserDefaults.standard.set(value, forKey: apiTokenKey)
            } else {
                UserDefaults.standard.removeObject(forKey: apiTokenKey)
            }
        }
    }

    private init() {}

    /// Check connection to the backend
    func checkConnection() async -> Bool {
        isCheckingConnection = true
        connectionError = nil

        defer { isCheckingConnection = false }

        do {
            let healthy = try await APIClient.shared.checkHealth()
            isAuthenticated = healthy
            return healthy
        } catch let error as APIError {
            connectionError = error.errorDescription
            isAuthenticated = false
            return false
        } catch {
            connectionError = error.localizedDescription
            isAuthenticated = false
            return false
        }
    }

    /// Configure the API endpoint and test connection
    func configure(apiURL: String) async -> Bool {
        guard AppConfig.setAPIBaseURL(apiURL) else {
            connectionError = "Invalid URL format"
            return false
        }

        return await checkConnection()
    }

    /// Sign out and clear credentials
    func signOut() {
        apiToken = nil
        isAuthenticated = false
        connectionError = nil

        // Disconnect WebSocket
        WebSocketClient.shared.disconnect()

        // Unregister push notifications
        Task {
            await PushNotificationManager.shared.unregister()
        }
    }
}
