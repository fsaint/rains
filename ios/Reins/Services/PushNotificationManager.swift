import Foundation
import UserNotifications
import UIKit

/// Manages push notification registration and handling
@MainActor
class PushNotificationManager: NSObject, ObservableObject {

    static let shared = PushNotificationManager()

    @Published private(set) var isAuthorized = false
    @Published private(set) var deviceToken: String?
    @Published private(set) var pendingApprovalId: String?

    private let deviceIdKey = "device_id"

    /// Unique identifier for this device
    var deviceId: String {
        if let existing = UserDefaults.standard.string(forKey: deviceIdKey) {
            return existing
        }
        let newId = UUID().uuidString
        UserDefaults.standard.set(newId, forKey: deviceIdKey)
        return newId
    }

    private override init() {
        super.init()
    }

    /// Request notification permissions
    func requestAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()

        do {
            let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            isAuthorized = granted

            if granted {
                await registerForRemoteNotifications()
                setupNotificationCategories()
            }

            return granted
        } catch {
            print("Push notification authorization failed: \(error)")
            return false
        }
    }

    /// Check current authorization status
    func checkAuthorizationStatus() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        isAuthorized = settings.authorizationStatus == .authorized
    }

    /// Register for remote notifications
    func registerForRemoteNotifications() async {
        await MainActor.run {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Handle successful device token registration
    func didRegisterForRemoteNotifications(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        self.deviceToken = token

        Task {
            await registerTokenWithBackend(token: token)
        }
    }

    /// Handle failed device token registration
    func didFailToRegisterForRemoteNotifications(error: Error) {
        print("Failed to register for remote notifications: \(error)")
    }

    /// Handle received notification
    func handleNotification(userInfo: [AnyHashable: Any]) {
        guard let aps = userInfo["aps"] as? [String: Any] else { return }

        // Check for approval-related notification
        if let approvalId = userInfo["approvalId"] as? String {
            pendingApprovalId = approvalId
        }

        // Handle background notification data
        if let category = aps["category"] as? String {
            switch category {
            case "APPROVAL_REQUEST":
                if let approvalId = userInfo["approvalId"] as? String {
                    pendingApprovalId = approvalId
                }
            default:
                break
            }
        }
    }

    /// Clear pending approval navigation
    func clearPendingApproval() {
        pendingApprovalId = nil
    }

    /// Unregister device from push notifications
    func unregister() async {
        guard let _ = deviceToken else { return }

        do {
            try await APIClient.shared.unregisterDevice(deviceId: deviceId)
            deviceToken = nil
        } catch {
            print("Failed to unregister device: \(error)")
        }
    }

    // MARK: - Private Methods

    private func registerTokenWithBackend(token: String) async {
        do {
            try await APIClient.shared.registerDevice(token: token, deviceId: deviceId)
            print("Device registered with backend")
        } catch {
            print("Failed to register device with backend: \(error)")
        }
    }

    private func setupNotificationCategories() {
        let center = UNUserNotificationCenter.current()

        // Approve action
        let approveAction = UNNotificationAction(
            identifier: "APPROVE_ACTION",
            title: "Approve",
            options: [.authenticationRequired]
        )

        // Reject action
        let rejectAction = UNNotificationAction(
            identifier: "REJECT_ACTION",
            title: "Reject",
            options: [.authenticationRequired, .destructive]
        )

        // View action
        let viewAction = UNNotificationAction(
            identifier: "VIEW_ACTION",
            title: "View Details",
            options: [.foreground]
        )

        // Approval request category
        let approvalCategory = UNNotificationCategory(
            identifier: "APPROVAL_REQUEST",
            actions: [approveAction, rejectAction, viewAction],
            intentIdentifiers: [],
            options: .customDismissAction
        )

        center.setNotificationCategories([approvalCategory])
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension PushNotificationManager: UNUserNotificationCenterDelegate {

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // Show banner and play sound even when app is in foreground
        return [.banner, .sound, .badge]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo

        await MainActor.run {
            switch response.actionIdentifier {
            case "APPROVE_ACTION":
                handleQuickApprove(userInfo: userInfo)

            case "REJECT_ACTION":
                handleQuickReject(userInfo: userInfo)

            case "VIEW_ACTION", UNNotificationDefaultActionIdentifier:
                handleNotification(userInfo: userInfo)

            default:
                break
            }
        }
    }

    @MainActor
    private func handleQuickApprove(userInfo: [AnyHashable: Any]) {
        guard let approvalId = userInfo["approvalId"] as? String else { return }

        Task {
            do {
                _ = try await APIClient.shared.approveRequest(id: approvalId)
            } catch {
                print("Quick approve failed: \(error)")
                // Navigate to approval for manual action
                pendingApprovalId = approvalId
            }
        }
    }

    @MainActor
    private func handleQuickReject(userInfo: [AnyHashable: Any]) {
        guard let approvalId = userInfo["approvalId"] as? String else { return }

        Task {
            do {
                _ = try await APIClient.shared.rejectRequest(id: approvalId, reason: "Rejected via notification")
            } catch {
                print("Quick reject failed: \(error)")
                // Navigate to approval for manual action
                pendingApprovalId = approvalId
            }
        }
    }
}
