import SwiftUI

/// Initial setup view for configuring the API connection
struct SetupView: View {
    @StateObject private var authService = AuthenticationService.shared
    @State private var apiURL = AppConfig.defaultAPIBaseURL.absoluteString
    @State private var isConnecting = false

    var body: some View {
        VStack(spacing: 32) {
            Spacer()

            // Logo and title
            VStack(spacing: 16) {
                Image(systemName: "shield.checkered")
                    .font(.system(size: 80))
                    .foregroundStyle(Color.trustBlue)

                Text("Reins")
                    .font(.largeTitle)
                    .fontWeight(.bold)

                Text("The trust layer for AI agents")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            // Connection form
            VStack(spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("API Server")
                        .font(.subheadline)
                        .fontWeight(.medium)

                    TextField("https://api.example.com", text: $apiURL)
                        .textFieldStyle(.roundedBorder)
                        .autocapitalization(.none)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                }

                if let error = authService.connectionError {
                    HStack {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Color.alertRed)
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(Color.alertRed)
                    }
                }

                ActionButton("Connect", style: .primary, isLoading: isConnecting) {
                    connect()
                }
            }
            .padding(.horizontal, 32)

            Spacer()

            // Footer
            Text("Enter the URL of your Reins server to get started")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            Spacer()
                .frame(height: 20)
        }
        .padding()
    }

    private func connect() {
        isConnecting = true

        Task {
            _ = await authService.configure(apiURL: apiURL)
            isConnecting = false
        }
    }
}

#Preview {
    SetupView()
}
