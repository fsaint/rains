import Foundation

/// View model for the approval detail screen
@MainActor
class ApprovalDetailViewModel: ObservableObject {

    @Published var approval: ApprovalRequest
    @Published var agent: Agent?
    @Published var isLoading = false
    @Published var isProcessing = false
    @Published var error: String?
    @Published var actionCompleted = false

    private let apiClient = APIClient.shared

    init(approval: ApprovalRequest) {
        self.approval = approval
    }

    /// Load additional details
    func loadDetails() async {
        isLoading = true
        error = nil

        do {
            // Refresh the approval
            approval = try await apiClient.fetchApproval(id: approval.id)

            // Load the agent info
            agent = try await apiClient.fetchAgent(id: approval.agentId)
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    /// Approve the request
    func approve(comment: String? = nil) async {
        guard approval.isPending else {
            error = "This request has already been resolved"
            return
        }

        isProcessing = true
        error = nil

        do {
            approval = try await apiClient.approveRequest(id: approval.id, comment: comment)
            actionCompleted = true
        } catch {
            self.error = error.localizedDescription
        }

        isProcessing = false
    }

    /// Reject the request
    func reject(reason: String?) async {
        guard approval.isPending else {
            error = "This request has already been resolved"
            return
        }

        isProcessing = true
        error = nil

        do {
            approval = try await apiClient.rejectRequest(id: approval.id, reason: reason)
            actionCompleted = true
        } catch {
            self.error = error.localizedDescription
        }

        isProcessing = false
    }

    /// Formatted arguments for display
    var formattedArguments: [(key: String, value: String)] {
        approval.arguments.map { (key: $0.key, value: $0.value.displayString) }
            .sorted { $0.key < $1.key }
    }

    /// Whether action buttons should be shown
    var showActions: Bool {
        approval.isPending && !isProcessing
    }
}
