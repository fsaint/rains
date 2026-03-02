import Foundation

/// View model for the activity feed
@MainActor
class ActivityViewModel: ObservableObject {

    @Published var entries: [AuditEntry] = []
    @Published var isLoading = false
    @Published var error: String?
    @Published var hasMore = true

    private var currentOffset = 0
    private let pageSize = 50

    /// Load audit log entries
    func loadActivity(refresh: Bool = false) async {
        if refresh {
            currentOffset = 0
            hasMore = true
        }

        guard hasMore else { return }

        isLoading = true
        error = nil

        do {
            let filter = AuditFilter(limit: pageSize, offset: currentOffset)
            let fetched = try await APIClient.shared.fetchAuditLog(filter: filter)

            if refresh {
                entries = fetched
            } else {
                entries.append(contentsOf: fetched)
            }

            hasMore = fetched.count == pageSize
            currentOffset += fetched.count
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    /// Refresh the activity feed
    func refresh() async {
        await loadActivity(refresh: true)
    }

    /// Load more entries
    func loadMore() async {
        guard !isLoading && hasMore else { return }
        await loadActivity()
    }

    /// Group entries by date
    var groupedByDate: [(date: String, entries: [AuditEntry])] {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none

        let grouped = Dictionary(grouping: entries) { entry in
            formatter.string(from: entry.timestamp)
        }

        return grouped
            .sorted { lhs, rhs in
                guard let lhsDate = entries.first(where: { formatter.string(from: $0.timestamp) == lhs.key })?.timestamp,
                      let rhsDate = entries.first(where: { formatter.string(from: $0.timestamp) == rhs.key })?.timestamp else {
                    return false
                }
                return lhsDate > rhsDate
            }
            .map { (date: $0.key, entries: $0.value.sorted { $0.timestamp > $1.timestamp }) }
    }
}
