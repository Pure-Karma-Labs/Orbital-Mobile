# Screen: Auth (Login + Signup)

## Purpose

Entry point for the app. Authenticate existing users or register new accounts against the orbital-backend.

## Layout

```
┌─────────────────────────────┐
│        Status Bar            │
├─────────────────────────────┤
│                              │
│     ╔═════════════════╗      │
│     ║  Welcome to     ║      │
│     ║  Orbital!       ║      │
│     ╚═════════════════╝      │
│                              │
│   ┌─────────────────────┐    │
│   │  Email              │    │
│   └─────────────────────┘    │
│   ┌─────────────────────┐    │
│   │  Password           │    │
│   └─────────────────────┘    │
│                              │
│   ┌─────────────────────┐    │
│   │     Log In          │    │
│   └─────────────────────┘    │
│                              │
│   Don't have an account?     │
│   Sign up                    │
│                              │
└─────────────────────────────┘
```

### Measurements

| Element | Spec |
|---|---|
| Horizontal padding | `spacing.lg` (24) |
| Welcome banner | ASCII double-box, mono font, `fontSize.sm` (11), `colors.blue` |
| Title below banner | "Orbital" in `fontSize.2xl` (32), bold, `colors.blue` |
| Subtitle | `fontSize.base` (13), `colors.textSecondary` |
| Input fields | Full width, `components.input` tokens, `spacing.md` (12) gap between |
| Login button | Full width, primary (blue bg, white text, bold), 44pt min height |
| Gap above button | `spacing.lg` (24) |
| Switch link | `fontSize.base` (13), `colors.blue`, underlined (retro web pattern) |
| Vertical centering | Content centered in safe area with keyboard avoidance |

## States

### Default
Email and password inputs empty, login button enabled.

### Loading
Button shows inline spinner (white, 16px), button text hidden, button disabled.

### Error
Red banner at top: `colors.error` at 10% opacity background, error message in `colors.error`.
Input border changes to `colors.error` on the field with the issue.
Error text below field: `fontSize.sm` (11), `colors.error`.

### Signup Variant
Same layout but:
- Title: "Create Account"
- Fields: Display Name, Email, Password, Confirm Password
- Button: "Sign Up" (primary blue)
- Switch link: "Already have an account? Log in"

## Interactions

- **Keyboard avoidance:** `KeyboardAvoidingView` pushes content up when keyboard appears
- **Return key:** Email input → focuses password. Password → submits form.
- **Switch animation:** Crossfade between login/signup at `duration.fast` (150ms)

## Light + Dark Mode

- Background: `colors.background` (warm canvas / midnight canvas)
- Welcome banner: `colors.blue` text in both modes
- Inputs: `colors.surfaceElevated` background, `colors.borderSubtle` border
- All text tokens swap per theme automatically

## Desktop Reference

Reference `OrbitalLogin.tsx` in Orbital-Desktop for visual style of the welcome banner and field layout. Do NOT replicate the desktop's centered card — mobile uses full-width inputs with horizontal padding.
