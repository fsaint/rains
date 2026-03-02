import SwiftUI

/// Activity feed showing audit log entries
struct ActivityFeedView: View {
    @ObservedObject var viewModel: ActivityViewModel

    var body: some View {
        Group {
            if viewModel.isLoading && viewModel.entries.isEmpty {
                loadingView
            } else if viewModel.entries.isEmpty {
                emptyView
            } else {
                activityList
            }
        }
        .refreshable {
            await viewModel.refresh()
        }
    }

    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
            Text("Loading activity...")
                .foregroundStyle(.secondary)
        }
    }

    private var emptyView: some View {
        ContentUnavailableView {
            Label("No Activity", systemImage: "list.bullet")
        } description: {
            Text("Agent activity and audit events will appear here.")
        }
    }

    private var activityList: some View {
        List {
            ForEach(viewModel.groupedByDate, id: \.date) { group in
                Section(group.date) {
                    ForEach(group.entries) { entry in
                        ActivityRowView(entry: entry)
                    }
                }
            }

            if viewModel.hasMore {
                Section {
                    Button {
                        Task {
                            await viewModel.loadMore()
                        }
                    } label: {
                        HStack {
                            Spacer()
                            if viewModel.isLoading {
                                ProgressView()
                            } else {
                                Text("Load More")
                            }
                            Spacer()
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if let error = viewModel.error {
                VStack {
                    Spacer()
                    Text(error)
                        .foregroundStyle(.white)
                        .padding()
                        .background(Color.alertRed)
                }
            }
        }
    }
}

/// A row displaying an audit entry
struct ActivityRowView: View {
    let entry: AuditEntry

    var body: some View {
        HStack(spacing: 12) {
            // Icon
            Image(systemName: entry.eventType.iconName)
                .font(.title3)
                .foregroundStyle(iconColor)
                .frame(width: 32, height: 32)
                .background(iconColor.opacity(0.1))
                .clipShape(Circle())

            // Content
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(entry.summary)
                        .font(.subheadline)
                        .fontWeight(.medium)

                    Spacer()

                    Text(entry.timestamp.timeString)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 8) {
                    if let agentId = entry.agentId {
                        Label(agentId, systemImage: "cpu")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    if let result = entry.result {
                        ResultBadge(result: result)
                    }

                    if let duration = entry.durationString {
                        Text(duration)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var iconColor: Color {
        if let result = entry.result {
            return result.color
        }

        switch entry.eventType {
        case .toolCall:
            return .trustBlue
        case .approval:
            return .cautionAmber
        case .policyChange:
            return .neutralGray
        case .auth:
            return .trustBlue
        case .connection:
            return .safeGreen
        }
    }
}

#Preview {
    NavigationStack {
        ActivityFeedView(viewModel: ActivityViewModel())
            .navigationTitle("Activity")
    }
}
