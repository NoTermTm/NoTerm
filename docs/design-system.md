# NoTerm Design System

This document is the source of truth for future UI work. Any `normalize`,
`typeset`, `arrange`, `polish`, `clarify`, or related design pass should follow
these rules before introducing new visual patterns.

## Product Direction

NoTerm is a calm operator workspace for engineers working with real shells,
servers, transfers, keys, tunnels, and AI-assisted troubleshooting.

The product should feel:

- Calm under pressure
- Professional and trustworthy
- Compact but readable
- Terminal-first
- Helpful without becoming chat-product-like

The product should not feel:

- Decorative for its own sake
- Like a generic AI dashboard
- Like a marketing site
- Overly playful, glossy, or theatrical
- Card-heavy or visually noisy

## Design North Star

The terminal is the primary surface. Every surrounding interface should either
help the user act faster, understand system state, or reduce risk.

Use the aesthetic of a refined desktop utility:

- Quiet surfaces
- Precise spacing
- Clear hierarchy
- Minimal elevation
- Few accents
- Direct controls
- Progressive disclosure for secondary tools

## Visual Language

### Surfaces

Use three surface levels only:

- `base`: the app background and terminal-adjacent panels
- `raised`: popovers, dropdowns, floating search, transient menus
- `selected`: active navigation, current connection, focused row

Rules:

- Do not wrap every section in a card.
- Do not nest cards inside cards.
- Prefer dividers, spacing, and alignment over boxed containers.
- Shadows are reserved for floating surfaces only.
- Main workspace panels should use borders and subtle contrast, not heavy
  elevation.

### Radius

Use restrained radius:

- `6px`: compact controls, rows, chips
- `8px`: buttons, inputs, list items, small panels
- `10px`: popovers and larger floating surfaces
- `12px`: outer app/window radius only when needed

Avoid large pill shapes except for badges, chips, and counters.

### Elevation

Elevation must communicate layering, not decoration.

- No shadow for static panels.
- Small shadow for dropdowns and context menus.
- Medium shadow for toasts and temporary overlays.
- Avoid glow, glass, radial light, and dramatic blur.

## Color System

### Palette Direction

Use tinted neutrals with one operational accent.

Primary neutral family:

- Background: warm off-white or dark graphite depending on theme
- Text: high-contrast neutral, not pure black or pure white
- Borders: low-contrast neutral with enough visibility for structure

Primary accent:

- Blue is used for focus, active state, links, and primary actions.

Semantic colors:

- Green: success or connected state
- Orange/amber: warning or pending state
- Red: destructive or failed state

Rules:

- Do not use multiple brand accent colors in the same feature unless each has a
  clear semantic role.
- Do not use gradients for normal UI surfaces.
- Do not use radial gradients or decorative light blooms.
- Do not use color to decorate headings or cards.
- AI-related UI should use the same app accent and surface system, not a
  separate visual brand.

### Color Usage

Use color sparingly:

- Active navigation: accent text plus subtle selected background
- Focus: accent outline or ring
- Primary action: accent background only when it is the main action
- Status: semantic color plus text/icon, never color alone

Most controls should be neutral until hovered, focused, selected, or in an error
state.

## Typography

### Fonts

UI font:

- Use the system UI stack defined by `--font-ui`.
- Do not add decorative display fonts.
- Do not add a second UI font unless the whole product typography system is
  intentionally revised.

Terminal font:

- Use the configured terminal monospace stack.
- Preserve icon font fallbacks for Nerd Font / symbol glyph support.
- Terminal text should remain visually dominant inside the terminal area.

### Type Scale

Use a compact desktop-app type scale:

- Caption: `0.75rem` for timestamps, badges, tiny metadata
- Meta: `0.8125rem` for secondary labels and compact controls
- UI: `0.875rem` for normal controls, rows, menu items
- Body: `1rem` for readable paragraph text and settings descriptions
- Subhead: `1.125rem` for panel headings
- Title: `1.25rem` for page titles

Rules:

- Do not invent arbitrary font sizes.
- Use size, weight, color, and spacing together for hierarchy.
- Do not rely on bold text everywhere.
- Body copy should be readable; dense control labels may be smaller.
- Use tabular numbers for counters, durations, ports, transfer sizes, and
  aligned numeric data.

### Weight Strategy

- Regular: normal descriptions and body text
- Medium: control labels and navigation labels
- Semibold: section headers, selected labels, important row titles
- Bold: rare, only for strong page-level emphasis or numeric counters

Avoid mixing medium and semibold inconsistently for the same role.

## Spacing And Layout

### Spacing Scale

Use this spacing rhythm:

- `4px`: icon/text micro gaps
- `6px`: dense control internals
- `8px`: related inline controls
- `10px`: compact row padding
- `12px`: normal component padding
- `16px`: group spacing
- `20px`: panel padding
- `24px`: page padding or major section separation
- `32px`: rare major layout separation

Rules:

- Prefer `gap` over margins for sibling spacing.
- Keep related controls tight.
- Separate unrelated groups more generously.
- Avoid using the same padding everywhere.
- Avoid arbitrary values unless required for optical alignment.

### Page Structure

Desktop utility pages should follow this hierarchy:

1. Navigation/sidebar
2. Page or feature header if needed
3. Primary working area
4. Secondary tools or inspector panels
5. Transient overlays

The user should be able to identify the primary working area within two seconds.

### Density

NoTerm should be compact, not cramped.

- Terminal and connection workflows may be dense.
- Settings and configuration pages may breathe more.
- AI output should be readable, but not styled like a standalone chat product.
- Use progressive disclosure for advanced options.

## Components

### Buttons

Button hierarchy:

- Primary: one per local decision area
- Secondary: neutral bordered or subtle filled button
- Ghost/icon: tool actions, toolbar controls, row actions
- Danger: destructive actions only

Rules:

- Prefer icons for obvious tool actions.
- Always provide `title` or accessible labels for icon-only buttons.
- Do not make every action blue.
- Do not use oversized rounded buttons in dense tool surfaces.

### Inputs

Inputs should feel precise and calm:

- Neutral background
- Clear border
- Accent focus ring
- Compact height in toolbars
- Larger height only in forms or text entry areas

Avoid decorative inset shadows or heavy filled backgrounds.

### Lists And Rows

Rows should be scan-friendly:

- Strong primary label
- Muted secondary metadata
- Status placed consistently
- Actions revealed on hover or placed in a predictable trailing area

Selected rows should use subtle background plus accent marker or text, not heavy
filled color.

### AI Assistant UI

AI should feel like a contextual operator assistant, not a separate product.

Rules:

- Use the same typography, surfaces, and accent system as the rest of the app.
- Prefer compact contextual summaries over large chat bubbles.
- Use progressive disclosure for logs, plans, and advanced reasoning.
- Avoid colorful gradient assistant cards.
- Avoid theatrical loading states.
- Make actions explicit: suggest, apply, stop, clear, inspect.

## Motion

Motion should explain state changes:

- Hover/focus: 120-160ms
- Open/close overlays: 160-220ms
- Toast entrance: 180-240ms
- Use ease-out timing

Rules:

- Avoid bounce and elastic easing.
- Avoid animating layout-heavy properties when transform/opacity works.
- Respect reduced motion.
- Do not use motion as decoration.

## Copy

Voice:

- Direct
- Calm
- Specific
- Non-blaming

Rules:

- Labels should name the action or object clearly.
- Error messages should explain what happened and what to do next.
- Avoid redundant descriptions under obvious labels.
- Avoid marketing copy inside tool surfaces.

## Accessibility

All design work must preserve or improve:

- Keyboard navigation
- Visible focus
- Color contrast
- Text overflow handling
- Hit target size
- Screen-reader labels for icon-only controls
- Status communicated by text/icon, not color alone

## Rules For Design Passes

### normalize

Use `normalize` when a feature visually diverges from the system.

Normalize in this order:

1. Replace hard-coded colors, spacing, radius, and shadows with tokens.
2. Remove decorative gradients, glows, and unnecessary cards.
3. Align controls with existing button/input/list patterns.
4. Consolidate repeated one-off styles.
5. Verify focus, hover, disabled, loading, empty, and error states.

### typeset

Use `typeset` when a page feels generic, muddy, or hard to scan.

Typeset in this order:

1. Map every text element to a role: title, subhead, label, body, meta, caption.
2. Replace arbitrary sizes with the type scale.
3. Normalize weights by role.
4. Improve line-height and text color contrast.
5. Add tabular numbers where numeric scanning matters.

### arrange

Use `arrange` when a layout feels crowded, monotonous, or visually weak.

Arrange in this order:

1. Identify the primary working area.
2. Tighten related controls and separate unrelated groups.
3. Replace unnecessary containers with spacing/dividers.
4. Align rows, toolbars, and panels to a visible structure.
5. Check the squint test: primary, secondary, and tertiary areas should be clear.

### polish

Use `polish` only after the structure is right.

Polish should refine:

- Optical alignment
- Hover/focus consistency
- Border contrast
- Empty/loading/error states
- Text truncation
- Responsive edge cases

## Acceptance Checklist

Before shipping UI changes, verify:

- The terminal or primary work area remains visually dominant.
- No new decorative gradients, glows, or card nesting were introduced.
- Colors have clear semantic purpose.
- Typography uses the defined scale and role-based weights.
- Spacing uses the defined rhythm.
- Static panels do not use decorative shadows.
- AI UI feels integrated with the app, not visually separate.
- Keyboard focus and accessibility labels are intact.
- The result feels calmer and clearer than before.
