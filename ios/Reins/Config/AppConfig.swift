import Foundation

/// App configuration for API endpoints and environment settings
enum AppConfig {

    // MARK: - API Configuration

    /// Base URL for the Reins backend API
    static var apiBaseURL: URL {
        if let urlString = UserDefaults.standard.string(forKey: "api_base_url"),
           let url = URL(string: urlString) {
            return url
        }
        return defaultAPIBaseURL
    }

    /// Default API base URL for development
    static let defaultAPIBaseURL = URL(string: "http://localhost:3000")!

    /// WebSocket URL for real-time updates
    static var webSocketURL: URL {
        var components = URLComponents(url: apiBaseURL, resolvingAgainstBaseURL: false)!
        components.scheme = apiBaseURL.scheme == "https" ? "wss" : "ws"
        components.path = "/ws"
        return components.url!
    }

    // MARK: - App Settings

    /// Whether push notifications are enabled
    static var pushNotificationsEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: "push_notifications_enabled") }
        set { UserDefaults.standard.set(newValue, forKey: "push_notifications_enabled") }
    }

    /// Whether to show pending approval badges
    static var showBadges: Bool {
        get { UserDefaults.standard.object(forKey: "show_badges") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "show_badges") }
    }

    /// Refresh interval for polling (in seconds)
    static var refreshInterval: TimeInterval {
        get { UserDefaults.standard.double(forKey: "refresh_interval") }
        set { UserDefaults.standard.set(newValue, forKey: "refresh_interval") }
    }

    static let defaultRefreshInterval: TimeInterval = 30

    // MARK: - Methods

    /// Update the API base URL
    static func setAPIBaseURL(_ urlString: String) -> Bool {
        guard let url = URL(string: urlString) else { return false }
        UserDefaults.standard.set(url.absoluteString, forKey: "api_base_url")
        return true
    }

    /// Reset to default configuration
    static func resetToDefaults() {
        UserDefaults.standard.removeObject(forKey: "api_base_url")
        UserDefaults.standard.removeObject(forKey: "push_notifications_enabled")
        UserDefaults.standard.removeObject(forKey: "show_badges")
        UserDefaults.standard.removeObject(forKey: "refresh_interval")
    }
}
