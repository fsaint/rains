import SwiftUI

/// A badge showing approval status
struct StatusBadge: View {
    let status: ApprovalStatus

    var body: some View {
        Text(status.displayName)
            .font(.caption)
            .fontWeight(.medium)
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(status.color)
            .clipShape(Capsule())
    }
}

/// A badge showing audit result
struct ResultBadge: View {
    let result: AuditResult

    var body: some View {
        Text(result.displayName)
            .font(.caption)
            .fontWeight(.medium)
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(result.color)
            .clipShape(Capsule())
    }
}

/// A badge showing agent status
struct AgentStatusBadge: View {
    let status: AgentStatus

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(status.color)
                .frame(width: 8, height: 8)
            Text(status.displayName)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

/// A connection status indicator
struct ConnectionIndicator: View {
    let isConnected: Bool

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(isConnected ? Color.safeGreen : Color.alertRed)
                .frame(width: 8, height: 8)
            Text(isConnected ? "Connected" : "Disconnected")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

#Preview {
    VStack(spacing: 20) {
        HStack(spacing: 10) {
            StatusBadge(status: .pending)
            StatusBadge(status: .approved)
            StatusBadge(status: .rejected)
            StatusBadge(status: .expired)
        }

        HStack(spacing: 10) {
            ResultBadge(result: .success)
            ResultBadge(result: .blocked)
            ResultBadge(result: .error)
            ResultBadge(result: .pending)
        }

        HStack(spacing: 20) {
            AgentStatusBadge(status: .active)
            AgentStatusBadge(status: .suspended)
            AgentStatusBadge(status: .pending)
        }

        HStack(spacing: 20) {
            ConnectionIndicator(isConnected: true)
            ConnectionIndicator(isConnected: false)
        }
    }
    .padding()
}
