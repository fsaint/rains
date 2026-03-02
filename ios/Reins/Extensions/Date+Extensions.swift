import Foundation

extension Date {

    /// Relative time string (e.g., "2 minutes ago", "Yesterday")
    var relativeString: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: self, relativeTo: Date())
    }

    /// Short relative time string (e.g., "2m ago", "1d ago")
    var shortRelativeString: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: self, relativeTo: Date())
    }

    /// Formatted time string (e.g., "10:30 AM")
    var timeString: String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: self)
    }

    /// Formatted date string (e.g., "Mar 1, 2024")
    var dateString: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        return formatter.string(from: self)
    }

    /// Formatted date and time string
    var dateTimeString: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: self)
    }

    /// Whether this date is today
    var isToday: Bool {
        Calendar.current.isDateInToday(self)
    }

    /// Whether this date is yesterday
    var isYesterday: Bool {
        Calendar.current.isDateInYesterday(self)
    }

    /// Smart formatted string - shows time for today, date for older
    var smartString: String {
        if isToday {
            return timeString
        } else if isYesterday {
            return "Yesterday, \(timeString)"
        } else {
            return dateTimeString
        }
    }
}
