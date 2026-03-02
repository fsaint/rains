# Reins Brand Guidelines

## Brand Essence

### Tagline
**"The trust layer for AI agents"**

### Brand Promise
Reins gives organizations confident control over AI agent capabilities without sacrificing productivity. We make AI governance invisible when everything's fine and unmistakable when it matters.

### Brand Personality
- **Trustworthy** - Security-first, transparent, reliable
- **Empowering** - Enables rather than restricts
- **Technical** - Built by engineers, for engineers
- **Calm** - Reduces anxiety about AI autonomy

## Visual Identity

### Logo Concept

The Reins logo should evoke:
- Control and guidance (like horse reins)
- Connection between human intent and AI action
- Trust and safety

**Primary Mark:** Abstract representation of connected pathways or guiding lines
**Wordmark:** Clean, modern sans-serif typeface

### Color Palette

#### Primary Colors

| Name | Hex | Usage |
|------|-----|-------|
| Reins Navy | `#1a2332` | Primary text, headers |
| Trust Blue | `#2563eb` | Primary actions, links |
| Safe Green | `#059669` | Success states, approvals |

#### Secondary Colors

| Name | Hex | Usage |
|------|-----|-------|
| Caution Amber | `#d97706` | Warnings, pending approvals |
| Alert Red | `#dc2626` | Errors, blocked actions |
| Neutral Gray | `#64748b` | Secondary text, borders |

#### Background Colors

| Name | Hex | Usage |
|------|-----|-------|
| Canvas White | `#ffffff` | Primary background |
| Surface Gray | `#f8fafc` | Cards, secondary surfaces |
| Dark Mode Base | `#0f172a` | Dark theme background |

### Typography

#### Primary Typeface
**Inter** - For UI, body text, and general communication
- Clean, highly legible
- Excellent for screens
- Open source

#### Monospace
**JetBrains Mono** or **Fira Code** - For code, technical content, CLI output
- Clear distinction between similar characters
- Developer-friendly

#### Type Scale

| Level | Size | Weight | Usage |
|-------|------|--------|-------|
| Display | 48px | 700 | Hero headlines |
| H1 | 32px | 600 | Page titles |
| H2 | 24px | 600 | Section headers |
| H3 | 20px | 500 | Subsections |
| Body | 16px | 400 | Paragraphs |
| Small | 14px | 400 | Captions, metadata |
| Code | 14px | 400 | Technical content |

### Iconography

Use **Lucide Icons** (or similar line-based set):
- Consistent 1.5px stroke weight
- Rounded corners
- 24x24px default size

Key icons for Reins concepts:
- Shield - Security, protection
- Key - Credentials, authentication
- Filter - Policy, permissions
- Eye - Monitoring, visibility
- Check - Approval, success
- Lock - Encryption, restricted

## Voice & Tone

### Writing Principles

1. **Clear over clever** - Avoid jargon unless addressing technical audience
2. **Confident but humble** - State capabilities directly without overselling
3. **Active voice** - "Reins filters tool access" not "Tool access is filtered by Reins"
4. **Human-centered** - Always acknowledge human oversight and control

### Terminology

| Use | Avoid |
|-----|-------|
| Control | Restrict, limit, block |
| Policy | Rules, restrictions |
| Approve | Allow, permit |
| Monitor | Surveil, track |
| Credential vault | Secret storage |
| Trust layer | Security layer |

### Example Copy

**Homepage Hero:**
> Give your AI agents capabilities, not keys to the kingdom. Reins provides the control plane for AI tool access—so agents can be productive while you stay in command.

**Feature Description:**
> Policy-based tool filtering lets you define exactly what each agent can do. Allow read operations, block deletions, require approval for sensitive actions—all in simple YAML.

**Error Message:**
> This action requires approval. Your request has been queued for review by an authorized team member.

## Application Guidelines

### Dashboard Design

- Clean, minimal interface
- Status-first information hierarchy
- Color coding for states (green=healthy, amber=needs attention, red=action required)
- Real-time updates without visual noise

### Documentation Style

- Code examples in every section
- Progressive disclosure (quick start → detailed guides)
- Copy-pastable configurations
- Clear prerequisites and assumptions

### CLI Output

- Structured, parseable output
- Color coding for status (green=success, yellow=warning, red=error)
- Quiet by default, verbose with flags
- Machine-readable JSON option

### Marketing Materials

- Lead with the problem, not the solution
- Show, don't tell (demos, screenshots, examples)
- Developer-to-developer tone
- Open source ethos

## Brand Assets

### Required Assets (To Be Created)

- [ ] Primary logo (SVG, PNG)
- [ ] Logo variations (dark mode, monochrome)
- [ ] Favicon and app icons
- [ ] Social media profile images
- [ ] Open Graph images for link previews
- [ ] README badges
- [ ] Presentation template
- [ ] Documentation site theme

### Asset Specifications

| Asset | Format | Sizes |
|-------|--------|-------|
| Logo | SVG, PNG | Original, 200px, 100px, 50px |
| Favicon | ICO, PNG | 16x16, 32x32, 180x180 |
| OG Image | PNG | 1200x630 |
| App Icon | PNG | 512x512, 192x192, 144x144 |

## Competitive Positioning

### What Makes Reins Different

1. **MCP-native** - Built specifically for the MCP protocol, not retrofitted
2. **Developer-first** - YAML policies, CLI tools, API-first design
3. **Transparent** - Open source, auditable, no black boxes
4. **Granular** - Tool-level control, not just service-level

### Key Messages by Audience

**For Developers:**
> "Policy as code for AI agent permissions. Define what your agents can do in version-controlled YAML."

**For Security Teams:**
> "Complete audit trail of every AI agent action. Approve sensitive operations before they execute."

**For Leadership:**
> "Deploy AI agents confidently with governance built in. Control spend, access, and capabilities from a single pane."

## Brand Evolution

This is a living document. As Reins grows:
- Gather user feedback on brand perception
- Test messaging with target audiences
- Evolve visual identity while maintaining core principles
- Document all brand decisions in ADRs
