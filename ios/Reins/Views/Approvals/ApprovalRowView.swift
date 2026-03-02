import SwiftUI

/// A row displaying an approval request summary
struct ApprovalRowView: View {
    let approval: ApprovalRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(approval.tool)
                    .font(.headline)
                    .foregroundStyle(.primary)

                Spacer()

                StatusBadge(status: approval.status)
            }

            HStack {
                Label(approval.agentId, systemImage: "cpu")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Spacer()

                if approval.isPending {
                    Text(approval.timeRemainingString)
                        .font(.caption)
                        .foregroundStyle(approval.timeRemaining < 300 ? .alertRed : .secondary)
                } else {
                    Text(approval.requestedAt.shortRelativeString)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let context = approval.context, !context.isEmpty {
                Text(context)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            if !approval.arguments.isEmpty {
                HStack(spacing: 4) {
                    ForEach(Array(approval.arguments.keys.prefix(3)), id: \.self) { key in
                        Text(key)
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.surfaceGray)
                            .clipShape(Capsule())
                    }

                    if approval.arguments.count > 3 {
                        Text("+\(approval.arguments.count - 3)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

#Preview {
    List {
        ApprovalRowView(approval: ApprovalRequest(
            id: "1",
            agentId: "agent-123",
            tool: "send_email",
            arguments: [
                "to": AnyCodable("user@example.com"),
                "subject": AnyCodable("Hello"),
                "body": AnyCodable("Test message")
            ],
            context: "Sending a follow-up email to the customer",
            status: .pending,
            requestedAt: Date().addingTimeInterval(-300),
            expiresAt: Date().addingTimeInterval(3300)
        ))

        ApprovalRowView(approval: ApprovalRequest(
            id: "2",
            agentId: "agent-456",
            tool: "create_draft",
            arguments: [:],
            context: nil,
            status: .approved,
            requestedAt: Date().addingTimeInterval(-7200),
            expiresAt: Date().addingTimeInterval(-3600),
            resolvedAt: Date().addingTimeInterval(-3600),
            resolvedBy: "admin"
        ))
    }
}
