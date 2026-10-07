# The inbox

The inbox comes to you: a pill in the stage's corner counts what needs you, a card rises
above it when something new arrives, and the drawer holds the whole queue. You never have
to watch every session.

**On this page:** [How a notification is born](#how-a-notification-is-born) ·
[Card types](#card-types) · [Choosing what reaches you](#choosing-what-reaches-you) ·
[What clears a card](#what-clears-a-card) · [The pill and the drawer](#the-pill-and-the-drawer)

<img src="../assets/guide/05-inbox-asks.png" alt="Two cards: a permission ask with a scope ladder, and a question with two options" width="360">

## How a notification is born

Hive TTY writes a small hooks file for every session it starts. Claude Code then reports
what it is doing to a receiver inside the app, over loopback, with a per-session token.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/diagrams/inbox.dark.svg">
  <img src="../assets/diagrams/inbox.light.svg" alt="A hook event reaches the receiver; the status tracker updates the dot, and the notifier raises a card or a desktop notification per your setting">
</picture>

| What Claude did | Kind raised |
| --- | --- |
| asked for permission, or asked a question | session blocked on you |
| finished its turn with nothing left running | session became yours again |
| sat idle waiting for input for a while | session ran out of instructions |
| an agent or session asked the overmind something | an agent asks you |

## Card types

- **Session cards.** Click to open the session. The card goes away on its own once the
  session stops waiting.
- **Question cards.** An agent or session asked something, with options. Click an option,
  or choose **Other…** and type your own answer when none of them fits. A question with
  no options shows the **Your answer** box straight away. Either way the answer goes back
  through the [ledger](ledger.md) and wakes the asker. Telling an agent to stop is an
  answer too: it closes its job as incomplete, tells whoever gave it the job, and
  releases what it was holding.
- **Permission cards.** An agent wants a tool outside its fence. The card shows the real
  call, like `pnpm test`, and a scope ladder: **once**, a command family like `pnpm *`, or
  **all Bash**. Anything wider than once is written into the agent's definition.
- **Redirected questions.** A question an agent asked a session that has since closed
  comes to you instead, captioned with the session it was meant for. Answer it here; the
  agent wakes as if that session had answered.
- **Goal cards.** A session running `/goal-on` reports its goal: active, a turn refused
  until the evidence exists, done or failed. One card per goal, updated in place; it
  reads itself once the goal settles.
- **Update, clone and PR cards.** A new version, a finished clone, a PR approved, merged or
  failing checks.

**Example.** An agent asks before it deploys:

```text
Deploy to production?          [ Approve ]  [ Reject ]
```

Clicking **Approve** posts an answer to that ask. The agent wakes, reads it, and carries on.

## Choosing what reaches you

**Settings › Notifications** has one row per kind. Each is **Off**, **Inbox**, or **Both**
(inbox plus a desktop notification).

![Settings › Notifications with a delivery choice per event](../assets/guide/17-settings-notifications.png)

Or in the config file:

```json
"notifications": {
  "session.blocked": "both",
  "session.idle": "inbox",
  "session.input_needed": "off"
}
```

A session is one card. When "runs out of instructions" replaces that session's "yours again"
card, it notifies the desktop if either of the two is set to **Both**, so looking away after a
turn you watched end still brings the notification.

## What clears a card

- Opening the session or agent it is about.
- The session leaving "needs input": you approved, answered, or typed a refusal.
  Pressing Escape on a prompt sends no hook, so that card stays until the next prompt.

The inbox keeps the latest 50 cards of news, and every card still waiting on you however
many there are. It does not survive a restart. The dock icon counts what waits on you:
open questions, permission requests and sessions waiting on you, not unread cards.

## The pill and the drawer

The Inbox sits in the stage's bottom-right corner, just above the page's own
input.

- **The pill** counts what needs you: open questions, permission requests,
  review requests, and sessions waiting on you (blocked, yours again, or out of
  instructions), leaving out the session on stage. What bounces the dock is
  always on it. Turning a kind **Off** in Settings › Notifications keeps it off
  the pill too. It is
  absent at zero, and reads **99+** past ninety-nine; a screen reader still
  hears the exact number. With one thing waiting it reads **1 needs you**; with
  more, **5 need you | Open all**. The count shows or hides the cards over it;
  **Open all** opens the drawer.
- **Cards.** A new ask rises above the pill as an answerable card, and stays
  until you deal with it. Everything waiting stacks under it, the newest on
  top. Answering the top card resolves it: it fades out and the next one
  rises in its place. ✕ folds the cards into the pill without answering
  anything, so the count stays; the count brings them back. A card never takes
  the keyboard.
- **Notes.** A session off stage that asks a question, or becomes yours again, rises as a note:
  **Open the session** takes you there, **Later** folds the cards into the pill.
- **The quiet rules.** With the keyboard in a terminal, nothing rises; the
  pill pulses once instead. With Settings open, arrivals wait and rise when it
  closes. The session on stage never shows.
- **The drawer.** **Open all** opens a 400px panel on the right, "Needs you", with
  every ask whole and the sessions off stage under it. Esc or ✕ closes it.
  Clicking an ask's desktop notification opens the drawer on that ask.
- **Yours again.** A session in the Sessions panel that finished and is
  waiting for you reads "yours again" until you open it.

Echoes (news cards) are not in the Inbox: they show on Home,
under **While you were away**, once nothing needs you. On Home, a **Needs you**
row opens the drawer on that ask.

