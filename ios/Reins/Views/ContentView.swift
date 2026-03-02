import SwiftUI

/// Main tab navigation view
struct ContentView: View {
    @StateObject private var approvalsViewModel = ApprovalsViewModel()
    @StateObject private var activityViewModel = ActivityViewModel()
    @StateObject private var authService = AuthenticationService.shared
    @ObservedObject private var webSocket = WebSocketClient.shared
    @ObservedObject private var pushManager = PushNotificationManager.shared

    @State private var selectedTab = 0
    @State private var showSettings = false
    @State private var showApprovalDetail = false
    @State private var selectedApprovalId: String?

    var body: some View {
        Group {
            if authService.isAuthenticated {
                mainContent
            } else {
                SetupView()
            }
        }
        .task {
            await authService.checkConnection()
        }
        .onChange(of: pushManager.pendingApprovalId) { newId in
            if let id = newId {
                selectedApprovalId = id
                selectedTab = 0
                showApprovalDetail = true
                pushManager.clearPendingApproval()
            }
        }
    }

    private var mainContent: some View {
        TabView(selection: $selectedTab) {
            NavigationStack {
                ApprovalsListView(viewModel: approvalsViewModel)
                    .navigationTitle("Approvals")
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            ConnectionIndicator(isConnected: webSocket.isConnected)
                        }
                        ToolbarItem(placement: .topBarTrailing) {
                            Button {
                                showSettings = true
                            } label: {
                                Image(systemName: "gear")
                            }
                        }
                    }
                    .navigationDestination(isPresented: $showApprovalDetail) {
                        if let id = selectedApprovalId,
                           let approval = approvalsViewModel.approvals.first(where: { $0.id == id }) {
                            ApprovalDetailView(approval: approval)
                        }
                    }
            }
            .tabItem {
                Label("Approvals", systemImage: "checkmark.circle")
            }
            .badge(approvalsViewModel.pendingCount)
            .tag(0)

            NavigationStack {
                ActivityFeedView(viewModel: activityViewModel)
                    .navigationTitle("Activity")
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button {
                                showSettings = true
                            } label: {
                                Image(systemName: "gear")
                            }
                        }
                    }
            }
            .tabItem {
                Label("Activity", systemImage: "list.bullet")
            }
            .tag(1)
        }
        .tint(.trustBlue)
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .task {
            // Connect WebSocket
            WebSocketClient.shared.connect()

            // Request push notifications
            await pushManager.requestAuthorization()

            // Load initial data
            await approvalsViewModel.loadApprovals()
            await activityViewModel.loadActivity()
        }
    }
}

#Preview {
    ContentView()
}
