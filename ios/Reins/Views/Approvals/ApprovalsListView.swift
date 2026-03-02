import SwiftUI

/// List of pending approval requests
struct ApprovalsListView: View {
    @ObservedObject var viewModel: ApprovalsViewModel

    var body: some View {
        Group {
            if viewModel.isLoading && viewModel.approvals.isEmpty {
                loadingView
            } else if viewModel.approvals.isEmpty {
                emptyView
            } else {
                approvalsList
            }
        }
        .refreshable {
            await viewModel.loadApprovals()
        }
    }

    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
            Text("Loading approvals...")
                .foregroundStyle(.secondary)
        }
    }

    private var emptyView: some View {
        ContentUnavailableView {
            Label("No Pending Approvals", systemImage: "checkmark.circle")
        } description: {
            Text("When agents request access to sensitive tools, they'll appear here for your review.")
        }
    }

    private var approvalsList: some View {
        List {
            if !viewModel.pendingApprovals.isEmpty {
                Section("Pending") {
                    ForEach(viewModel.pendingApprovals) { approval in
                        NavigationLink(value: approval) {
                            ApprovalRowView(approval: approval)
                        }
                    }
                }
            }

            if !viewModel.recentResolvedApprovals.isEmpty {
                Section("Recent") {
                    ForEach(viewModel.recentResolvedApprovals) { approval in
                        NavigationLink(value: approval) {
                            ApprovalRowView(approval: approval)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationDestination(for: ApprovalRequest.self) { approval in
            ApprovalDetailView(approval: approval)
        }
        .overlay {
            if let error = viewModel.error {
                errorBanner(error)
            }
        }
    }

    private func errorBanner(_ message: String) -> some View {
        VStack {
            Spacer()
            HStack {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.white)
                Text(message)
                    .foregroundStyle(.white)
                    .font(.footnote)
                Spacer()
                Button {
                    viewModel.error = nil
                } label: {
                    Image(systemName: "xmark")
                        .foregroundStyle(.white)
                }
            }
            .padding()
            .background(Color.alertRed)
        }
    }
}

#Preview {
    NavigationStack {
        ApprovalsListView(viewModel: ApprovalsViewModel())
            .navigationTitle("Approvals")
    }
}
