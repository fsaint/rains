import SwiftUI

/// Style for action buttons
enum ActionButtonStyle {
    case approve
    case reject
    case primary
    case secondary

    var backgroundColor: Color {
        switch self {
        case .approve:
            return .safeGreen
        case .reject:
            return .alertRed
        case .primary:
            return .trustBlue
        case .secondary:
            return .surfaceGray
        }
    }

    var foregroundColor: Color {
        switch self {
        case .approve, .reject, .primary:
            return .white
        case .secondary:
            return .reinsNavy
        }
    }
}

/// A styled action button
struct ActionButton: View {
    let title: String
    let style: ActionButtonStyle
    let isLoading: Bool
    let action: () -> Void

    init(
        _ title: String,
        style: ActionButtonStyle = .primary,
        isLoading: Bool = false,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.style = style
        self.isLoading = isLoading
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView()
                        .progressViewStyle(CircularProgressViewStyle(tint: style.foregroundColor))
                        .scaleEffect(0.8)
                }
                Text(title)
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(style.backgroundColor)
            .foregroundStyle(style.foregroundColor)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .disabled(isLoading)
    }
}

/// A compact icon button
struct IconButton: View {
    let systemName: String
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.title2)
                .foregroundStyle(color)
                .frame(width: 44, height: 44)
                .background(color.opacity(0.1))
                .clipShape(Circle())
        }
    }
}

#Preview {
    VStack(spacing: 20) {
        ActionButton("Approve", style: .approve) {}
        ActionButton("Reject", style: .reject) {}
        ActionButton("Connect", style: .primary) {}
        ActionButton("Cancel", style: .secondary) {}
        ActionButton("Loading...", style: .primary, isLoading: true) {}

        HStack(spacing: 20) {
            IconButton(systemName: "checkmark", color: .safeGreen) {}
            IconButton(systemName: "xmark", color: .alertRed) {}
            IconButton(systemName: "arrow.clockwise", color: .trustBlue) {}
        }
    }
    .padding()
}
