import SwiftUI

extension Color {
    // MARK: - Primary Colors

    /// Primary text and headers - Reins Navy (#1a2332)
    static let reinsNavy = Color(red: 0.102, green: 0.137, blue: 0.196)

    /// Primary actions and links - Trust Blue (#2563eb)
    static let trustBlue = Color(red: 0.145, green: 0.388, blue: 0.922)

    /// Success states and approvals - Safe Green (#059669)
    static let safeGreen = Color(red: 0.020, green: 0.588, blue: 0.412)

    // MARK: - Secondary Colors

    /// Warnings and pending approvals - Caution Amber (#d97706)
    static let cautionAmber = Color(red: 0.851, green: 0.467, blue: 0.024)

    /// Errors and blocked actions - Alert Red (#dc2626)
    static let alertRed = Color(red: 0.863, green: 0.149, blue: 0.149)

    /// Secondary text and borders - Neutral Gray (#64748b)
    static let neutralGray = Color(red: 0.392, green: 0.455, blue: 0.545)

    // MARK: - Background Colors

    /// Cards and secondary surfaces - Surface Gray (#f8fafc)
    static let surfaceGray = Color(red: 0.973, green: 0.980, blue: 0.988)

    /// Dark mode background - Dark Mode Base (#0f172a)
    static let darkModeBase = Color(red: 0.059, green: 0.090, blue: 0.165)
}

// MARK: - Approval Status Colors

extension ApprovalStatus {
    var color: Color {
        switch self {
        case .pending:
            return .cautionAmber
        case .approved:
            return .safeGreen
        case .rejected:
            return .alertRed
        case .expired:
            return .neutralGray
        }
    }
}

// MARK: - Audit Result Colors

extension AuditResult {
    var color: Color {
        switch self {
        case .success:
            return .safeGreen
        case .blocked:
            return .alertRed
        case .error:
            return .alertRed
        case .pending:
            return .cautionAmber
        }
    }
}

// MARK: - Agent Status Colors

extension AgentStatus {
    var color: Color {
        switch self {
        case .active:
            return .safeGreen
        case .suspended:
            return .alertRed
        case .pending:
            return .cautionAmber
        }
    }
}
