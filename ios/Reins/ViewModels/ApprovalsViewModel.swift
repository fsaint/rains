import Foundation

/// View model for the approvals list
@MainActor
class ApprovalsViewModel: ObservableObject {

    @Published var approvals: [ApprovalRequest] = []
    @Published var isLoading = false
    @Published var error: String?
    @Published var selectedApproval: ApprovalRequest?

    private var isSubscribedToWebSocket = false

    init() {
        subscribeToWebSocket()
    }

    /// Load pending approvals from the API
    func loadApprovals() async {
        isLoading = true
        error = nil

        do {
            let fetched = try await APIClient.shared.fetchApprovals()
            // Sort by requested date, newest first
            approvals = fetched.sorted { $0.requestedAt > $1.requestedAt }
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    /// Approve a request
    func approve(_ approval: ApprovalRequest, comment: String? = nil) async -> Bool {
        do {
            let updated = try await APIClient.shared.approveRequest(id: approval.id, comment: comment)
            updateApproval(updated)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Reject a request
    func reject(_ approval: ApprovalRequest, reason: String?) async -> Bool {
        do {
            let updated = try await APIClient.shared.rejectRequest(id: approval.id, reason: reason)
            updateApproval(updated)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Get count of pending approvals
    var pendingCount: Int {
        approvals.filter { $0.isPending }.count
    }

    /// Filter to only pending approvals
    var pendingApprovals: [ApprovalRequest] {
        approvals.filter { $0.isPending }
    }

    /// Filter to resolved approvals (recent)
    var recentResolvedApprovals: [ApprovalRequest] {
        approvals
            .filter { !$0.isPending }
            .prefix(10)
            .map { $0 }
    }

    // MARK: - Private Methods

    private func subscribeToWebSocket() {
        guard !isSubscribedToWebSocket else { return }
        isSubscribedToWebSocket = true

        WebSocketClient.shared.subscribe { [weak self] event in
            Task { @MainActor in
                self?.handleWebSocketEvent(event)
            }
        }
    }

    private func handleWebSocketEvent(_ event: WebSocketEvent) {
        switch event {
        case .approvalRequest(let approval):
            // Add new approval at the top
            if !approvals.contains(where: { $0.id == approval.id }) {
                approvals.insert(approval, at: 0)
            }

        case .approvalResolved(let approval):
            updateApproval(approval)

        case .connected:
            // Refresh approvals when reconnected
            Task {
                await loadApprovals()
            }

        default:
            break
        }
    }

    private func updateApproval(_ updated: ApprovalRequest) {
        if let index = approvals.firstIndex(where: { $0.id == updated.id }) {
            approvals[index] = updated
        }

        // Also update selected approval if it matches
        if selectedApproval?.id == updated.id {
            selectedApproval = updated
        }
    }
}
