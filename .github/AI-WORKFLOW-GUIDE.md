# AI Workflow Guide

Our AI setup is built around a simple idea: lessons learned in one session should improve every future session. This guide explains how the file system works, how to invoke it, and how to keep it useful over time.

---

## Mental Model

Every file type has a different purpose and lifespan.

| File type                        | Example                                           | When active               | Purpose                   |
| -------------------------------- | ------------------------------------------------- | ------------------------- | ------------------------- |
| `copilot-instructions.md`        | Writing style rules                               | Always, automatic         | Global rules              |
| `instructions/*.instructions.md` | `typescript.instructions.md`                      | When you `#`-reference it | Domain rules, opt-in      |
| `agents/*.agent.md`              | `expert-react-frontend-engineer.agent.md`         | When you `@`-mention it   | Persona and expertise     |
| `prompts/*.prompt.md`            | `update-typescript-instructions.prompt.md`        | When you `/`-invoke it    | Reusable task templates   |
| `session-feedback/*.md`          | `2026-04-30-user-preferences-session-feedback.md` | When you `#`-reference it | Short-term project memory |

---

## How to Invoke Each Type

**`copilot-instructions.md`** loads automatically. You do not need to reference it.

**Instruction files** load when you `#`-reference them at the start of a message. Type `#` in Copilot Chat and a file picker appears.

> Say you are about to write a new API service. Start your message with `#typescript.instructions.md` and Copilot loads your error handling conventions, naming rules, and preferred patterns without you re-explaining any of it.

```text
#typescript.instructions.md  Add a service that fetches user preferences from the settings endpoint.
```

You can reference multiple files in one message.

```text
#typescript.instructions.md #testing.instructions.md  Add a service that fetches user preferences and write tests for it.
```

**Agents** load via `@` and apply a specific persona for the conversation.

```text
@expert-react-frontend-engineer  Review this component for MUI anti-patterns.
```

**Prompts** are reusable task templates invoked via `/`.

```text
/update-typescript-instructions
```

---

## How a Session Produces Lasting Knowledge

At the end of a meaningful session (one where the AI made mistakes, you corrected it, or you iterated toward a design decision) run the update prompt.

```text
/update-typescript-instructions
```

The prompt reads the entire conversation and does two things:

1. **Filters for generic lessons** and appends them to `.github/instructions/typescript.instructions.md`. A lesson qualifies only if it would prevent a mistake on a different project and is not already covered.
2. **Collects project-specific details** (exact type shapes, edge cases, feature decisions) into `.github/session-feedback/YYYY-MM-DD-[feature]-session-feedback.md`.

The instructions file improves permanently. The session feedback file is temporary.

---

## The Session Feedback File

A **session feedback file** captures what did not qualify as a generic rule: specific color values, component-level decisions, and corrections particular to this feature. It has one purpose: restoring context if you return to the same work in a new session.

> Say you spent a session refining how a complex data transformation works, with specific edge cases handled and type decisions made, and you need to return to it tomorrow. The AI has no memory of yesterday. Reference the session feedback file at the start of the new session and you pick up where you left off.

```text
#2026-04-30-user-preferences-session-feedback.md  Let's continue work on the preferences service.
```

Session feedback files are gitignored and never committed. Once you finish the feature and promote any remaining lessons to the instructions file, delete the feedback file or leave it. It has no further purpose.

```gitignore
.github/session-feedback/
```

---

## Adding a New Domain

When you are working in a new area (testing, accessibility, API design) and the AI starts making consistent mistakes, that is the signal to create a new instructions file.

1. Create `.github/instructions/[domain].instructions.md`.
2. Write the first rule from the mistake that prompted you.
3. Run the appropriate update prompt at the end of future sessions to build it out.

The instructions files are not written up front. They are grown from real sessions.
