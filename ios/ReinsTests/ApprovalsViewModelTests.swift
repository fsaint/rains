import XCTest
@testable import Reins

final class ApprovalsViewModelTests: XCTestCase {

    func testPendingApprovals() async {
        let viewModel = await ApprovalsViewModel()

        let pendingApproval = ApprovalRequest(
            id: "1",
            agentId: "agent-123",
            tool: "send_email",
            arguments: [:],
            context: nil,
            status: .pending,
            requestedAt: Date(),
            expiresAt: Date().addingTimeInterval(3600)
        )

        let approvedApproval = ApprovalRequest(
            id: "2",
            agentId: "agent-456",
            tool: "create_draft",
            arguments: [:],
            context: nil,
            status: .approved,
            requestedAt: Date().addingTimeInterval(-7200),
            expiresAt: Date().addingTimeInterval(-3600),
            resolvedAt: Date().addingTimeInterval(-3500),
            resolvedBy: "user"
        )

        await MainActor.run {
            viewModel.approvals = [pendingApproval, approvedApproval]
        }

        await MainActor.run {
            XCTAssertEqual(viewModel.pendingCount, 1)
            XCTAssertEqual(viewModel.pendingApprovals.count, 1)
            XCTAssertEqual(viewModel.pendingApprovals.first?.id, "1")
        }
    }

    func testApprovalExpiry() {
        let expiredApproval = ApprovalRequest(
            id: "1",
            agentId: "agent-123",
            tool: "send_email",
            arguments: [:],
            context: nil,
            status: .pending,
            requestedAt: Date().addingTimeInterval(-7200),
            expiresAt: Date().addingTimeInterval(-3600) // Expired 1 hour ago
        )

        XCTAssertTrue(expiredApproval.isExpired)
        XCTAssertFalse(expiredApproval.isPending)
        XCTAssertEqual(expiredApproval.timeRemaining, 0)
    }

    func testTimeRemainingString() {
        // Test hours remaining
        let hoursRemaining = ApprovalRequest(
            id: "1",
            agentId: "agent-123",
            tool: "send_email",
            arguments: [:],
            context: nil,
            status: .pending,
            requestedAt: Date(),
            expiresAt: Date().addingTimeInterval(7200) // 2 hours
        )
        XCTAssertTrue(hoursRemaining.timeRemainingString.contains("h"))

        // Test minutes remaining
        let minutesRemaining = ApprovalRequest(
            id: "2",
            agentId: "agent-123",
            tool: "send_email",
            arguments: [:],
            context: nil,
            status: .pending,
            requestedAt: Date(),
            expiresAt: Date().addingTimeInterval(1800) // 30 minutes
        )
        XCTAssertTrue(minutesRemaining.timeRemainingString.contains("m"))
    }
}
