import SwiftUI

/// App settings and configuration
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var authService = AuthenticationService.shared
    @ObservedObject private var pushManager = PushNotificationManager.shared
    @ObservedObject private var webSocket = WebSocketClient.shared

    @State private var apiURL: String = AppConfig.apiBaseURL.absoluteString
    @State private var showBadges = AppConfig.showBadges
    @State private var showDisconnectAlert = false
    @State private var isTestingConnection = false
    @State private var connectionTestResult: String?

    var body: some View {
        NavigationStack {
            Form {
                // Connection Section
                connectionSection

                // Notifications Section
                notificationsSection

                // Preferences Section
                preferencesSection

                // About Section
                aboutSection

                // Sign Out Section
                signOutSection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
            .alert("Disconnect?", isPresented: $showDisconnectAlert) {
                Button("Cancel", role: .cancel) {}
                Button("Disconnect", role: .destructive) {
                    authService.signOut()
                    dismiss()
                }
            } message: {
                Text("You will need to reconnect to receive approval requests.")
            }
        }
    }

    // MARK: - Sections

    private var connectionSection: some View {
        Section {
            HStack {
                Label("Status", systemImage: "wifi")
                Spacer()
                ConnectionIndicator(isConnected: webSocket.isConnected)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("API Server")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                TextField("https://api.example.com", text: $apiURL)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.none)
                    .keyboardType(.URL)
                    .textContentType(.URL)
            }

            Button {
                testConnection()
            } label: {
                HStack {
                    Text("Test Connection")
                    Spacer()
                    if isTestingConnection {
                        ProgressView()
                    } else if let result = connectionTestResult {
                        Text(result)
                            .foregroundStyle(result == "Connected" ? Color.safeGreen : Color.alertRed)
                    }
                }
            }
            .disabled(isTestingConnection)
        } header: {
            Text("Connection")
        } footer: {
            Text("The API server URL for your Reins installation.")
        }
    }

    private var notificationsSection: some View {
        Section {
            HStack {
                Label("Push Notifications", systemImage: "bell")
                Spacer()
                if pushManager.isAuthorized {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.safeGreen)
                } else {
                    Button("Enable") {
                        Task {
                            await pushManager.requestAuthorization()
                        }
                    }
                    .buttonStyle(.bordered)
                }
            }

            if let token = pushManager.deviceToken {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Device Token")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(String(token.prefix(32)) + "...")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text("Receive alerts when agents request approval for sensitive actions.")
        }
    }

    private var preferencesSection: some View {
        Section("Preferences") {
            Toggle(isOn: $showBadges) {
                Label("Show Badge Count", systemImage: "app.badge")
            }
            .onChange(of: showBadges) { newValue in
                AppConfig.showBadges = newValue
            }
        }
    }

    private var aboutSection: some View {
        Section("About") {
            HStack {
                Text("Version")
                Spacer()
                Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0")
                    .foregroundStyle(.secondary)
            }

            HStack {
                Text("Build")
                Spacer()
                Text(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1")
                    .foregroundStyle(.secondary)
            }

            Link(destination: URL(string: "https://github.com/your-org/reins")!) {
                HStack {
                    Label("View on GitHub", systemImage: "link")
                    Spacer()
                    Image(systemName: "arrow.up.right")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var signOutSection: some View {
        Section {
            Button(role: .destructive) {
                showDisconnectAlert = true
            } label: {
                HStack {
                    Spacer()
                    Text("Disconnect")
                    Spacer()
                }
            }
        }
    }

    // MARK: - Actions

    private func testConnection() {
        isTestingConnection = true
        connectionTestResult = nil

        // Update API URL if changed
        _ = AppConfig.setAPIBaseURL(apiURL)

        Task {
            let success = await authService.checkConnection()
            isTestingConnection = false
            connectionTestResult = success ? "Connected" : "Failed"

            // Reconnect WebSocket if successful
            if success {
                WebSocketClient.shared.disconnect()
                WebSocketClient.shared.connect()
            }
        }
    }
}

#Preview {
    SettingsView()
}
