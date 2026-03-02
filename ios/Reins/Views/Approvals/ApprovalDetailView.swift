import SwiftUI

/// Detailed view of an approval request with approve/reject actions
struct ApprovalDetailView: View {
    @StateObject private var viewModel: ApprovalDetailViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var showRejectSheet = false
    @State private var rejectReason = ""
    @State private var approveComment = ""

    init(approval: ApprovalRequest) {
        _viewModel = StateObject(wrappedValue: ApprovalDetailViewModel(approval: approval))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Header
                headerSection

                // Tool info
                toolSection

                // Arguments
                if !viewModel.approval.arguments.isEmpty {
                    argumentsSection
                }

                // Context
                if let context = viewModel.approval.context, !context.isEmpty {
                    contextSection(context)
                }

                // Agent info
                if let agent = viewModel.agent {
                    agentSection(agent)
                }

                // Action buttons
                if viewModel.showActions {
                    actionSection
                }

                // Resolution info
                if !viewModel.approval.isPending {
                    resolutionSection
                }
            }
            .padding()
        }
        .navigationTitle("Approval Request")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.loadDetails()
        }
        .onChange(of: viewModel.actionCompleted) { _, completed in
            if completed {
                dismiss()
            }
        }
        .sheet(isPresented: $showRejectSheet) {
            rejectSheet
        }
        .overlay {
            if viewModel.isLoading {
                ProgressView()
            }
        }
        .alert("Error", isPresented: .constant(viewModel.error != nil)) {
            Button("OK") {
                viewModel.error = nil
            }
        } message: {
            Text(viewModel.error ?? "")
        }
    }

    // MARK: - Sections

    private var headerSection: some View {
        VStack(spacing: 12) {
            StatusBadge(status: viewModel.approval.status)

            Text(viewModel.approval.tool)
                .font(.title2)
                .fontWeight(.bold)

            if viewModel.approval.isPending {
                HStack(spacing: 4) {
                    Image(systemName: "clock")
                    Text("Expires in \(viewModel.approval.timeRemainingString)")
                }
                .font(.subheadline)
                .foregroundStyle(viewModel.approval.timeRemaining < 300 ? .alertRed : .secondary)
            }

            Text("Requested \(viewModel.approval.requestedAt.relativeString)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding()
        .background(Color.surfaceGray)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var toolSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Tool", systemImage: "hammer")
                .font(.headline)

            Text(viewModel.approval.tool)
                .font(.body.monospaced())
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.surfaceGray)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private var argumentsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Arguments", systemImage: "list.bullet")
                .font(.headline)

            VStack(spacing: 0) {
                ForEach(viewModel.formattedArguments, id: \.key) { arg in
                    HStack(alignment: .top) {
                        Text(arg.key)
                            .font(.subheadline.monospaced())
                            .foregroundStyle(.secondary)
                            .frame(width: 100, alignment: .leading)

                        Text(arg.value)
                            .font(.subheadline)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.vertical, 8)
                    .padding(.horizontal, 12)

                    if arg.key != viewModel.formattedArguments.last?.key {
                        Divider()
                    }
                }
            }
            .background(Color.surfaceGray)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private func contextSection(_ context: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Context", systemImage: "text.quote")
                .font(.headline)

            Text(context)
                .font(.body)
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.surfaceGray)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private func agentSection(_ agent: Agent) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Agent", systemImage: "cpu")
                .font(.headline)

            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(agent.name)
                        .font(.subheadline)
                        .fontWeight(.medium)

                    if let description = agent.description {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                AgentStatusBadge(status: agent.status)
            }
            .padding()
            .background(Color.surfaceGray)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private var actionSection: some View {
        VStack(spacing: 12) {
            TextField("Add a comment (optional)", text: $approveComment)
                .textFieldStyle(.roundedBorder)

            HStack(spacing: 12) {
                ActionButton("Reject", style: .reject, isLoading: viewModel.isProcessing) {
                    showRejectSheet = true
                }

                ActionButton("Approve", style: .approve, isLoading: viewModel.isProcessing) {
                    Task {
                        await viewModel.approve(comment: approveComment.isEmpty ? nil : approveComment)
                    }
                }
            }
        }
        .padding(.top)
    }

    private var resolutionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Resolution", systemImage: "checkmark.seal")
                .font(.headline)

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Status")
                        .foregroundStyle(.secondary)
                    Spacer()
                    StatusBadge(status: viewModel.approval.status)
                }

                if let resolvedBy = viewModel.approval.resolvedBy {
                    HStack {
                        Text("Resolved by")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(resolvedBy)
                    }
                }

                if let resolvedAt = viewModel.approval.resolvedAt {
                    HStack {
                        Text("Resolved at")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(resolvedAt.dateTimeString)
                    }
                }

                if let comment = viewModel.approval.resolutionComment {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Comment")
                            .foregroundStyle(.secondary)
                        Text(comment)
                            .italic()
                    }
                }
            }
            .font(.subheadline)
            .padding()
            .background(Color.surfaceGray)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    // MARK: - Sheets

    private var rejectSheet: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Text("Reject this request?")
                    .font(.headline)

                TextField("Reason for rejection", text: $rejectReason, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(3...6)

                ActionButton("Reject Request", style: .reject, isLoading: viewModel.isProcessing) {
                    Task {
                        await viewModel.reject(reason: rejectReason.isEmpty ? nil : rejectReason)
                        showRejectSheet = false
                    }
                }

                Spacer()
            }
            .padding()
            .navigationTitle("Reject Request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showRejectSheet = false
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

#Preview {
    NavigationStack {
        ApprovalDetailView(approval: ApprovalRequest(
            id: "1",
            agentId: "agent-123",
            tool: "send_email",
            arguments: [
                "to": AnyCodable("user@example.com"),
                "subject": AnyCodable("Meeting Follow-up"),
                "body": AnyCodable("Thank you for your time today...")
            ],
            context: "Following up after the product demo meeting",
            status: .pending,
            requestedAt: Date().addingTimeInterval(-300),
            expiresAt: Date().addingTimeInterval(3300)
        ))
    }
}
