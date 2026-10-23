# Plan the workshop with Maya

A checklist is a start. Now try keeping the workshop's decisions together while the work changes: plan the session, draft an invitation, prepare the shopping list, and finish a run sheet.

Maya is a **Persona**, FLUJO's experimental way to give an AI continuing instructions, memory and goals across conversations. You can inspect her work and adjust the context rather than starting from an empty prompt each time.

**Day 1, Day 2 and Day 3 below are compressed demonstration sessions.** They are not elapsed days, and they do not show unattended work between sessions or establish long-term reliability.

This recording uses published **FLUJO 3.46.2**, with **Workshop AI** connected to OpenRouter's `google/gemini-3-flash-preview`. It reached a completed goal and four completed tasks after operator review and corrections. Read the resulting workshop pack.

## Set Maya up

Start with the tested AI and public coffee source from [the first-agent guide](first-agent.md). In **Settings**, turn on **Enable experimental features** to show Personas and Roles.

Open **Personas → Create Persona**. The wizard moves through **About → Role → Apps → Supplemental behaviors → Review**. Name her `Maya` and give her a one-sentence purpose: help prepare a small beginner coffee workshop while keeping confirmed decisions distinct from suggestions.

Choose a Role, or use **Create a simple Role**. A Role is reusable setup for this kind of helper; it supplies the instructions and the flow that runs its AI. If readiness shows **Configure models**, open the Role and choose the AI for its flow before continuing. The Persona wizard does not have a separate model picker. The recorded example uses **Workshop planner** with **Workshop AI** and **fetch-mcp**. Review the setup, then choose **Create Persona**.

[![Maya's review screen confirms Workshop planner, Workshop AI and fetch-mcp before Create Persona](../../githubpages/assets/journeys/08-maya-review.png)](../../githubpages/assets/journeys/08-maya-review.png)

Keep invitations as drafts; sending messages and buying supplies are outside this example. Use **Memory → Add memory** after creation for facts you want Maya to retain; the creation wizard does not add them.

## Day 1 — Give her a clear finish line

Choose **Give this Persona a goal**. Set **Goal** to `Prepare our beginner coffee workshop`. Use **Helpful context (optional)** to describe the audience, time and equipment. Include the [public coffee guide's URL](https://www.aboutcoffee.org/brewing/pour-over-coffee/) and any checklist you have reviewed; reusing connections does not automatically transfer the Workshop helper's conversation into Maya's context. Define success as four reviewable items:

- A short workshop plan.
- An invitation draft.
- A shopping list with planning quantities; check your own supplies before buying.
- A run sheet you can follow during the session.

For example:

```text
Help me prepare a 90-minute beginner coffee workshop for six adults at three
shared stations. Read the full guide at
https://www.aboutcoffee.org/brewing/pour-over-coffee/
with fetch_readable, using max_length 20000, and use the reviewed checklist
in Helpful context. First prepare a plan and invitation draft. Ask me for
the venue, date and final attendance before finalizing. Later we will update
the shopping list and run sheet. Keep decisions and next steps saved.
Draft only: do not send invitations or buy anything.
```

Before choosing **Start working**, configure the goal's continuation. For this ongoing example, leave **Keep working on this goal** selected. In **Success criteria**, require the plan, invitation marked **DRAFT**, shopping list with quantities and 90-minute run sheet to match the latest confirmed decisions. Require the owner's explicit **“finalize the workshop pack”** instruction before completion. Leaving success criteria empty creates work that continues until stopped. Review the work-session cadence and optional limits before starting.

[![The goal form contains the workshop title, context and explicit final-approval success criteria, with Start working enabled](../../githubpages/assets/journeys/09-day1-goal.png)](../../githubpages/assets/journeys/09-day1-goal.png)

This is a later view of the original inputs, re-entered after completion to show the filled form. The operator canceled it; no duplicate goal was created.

Read the first plan. Confirm the constraints you want to carry forward, and inspect the Persona's **Memory** area before relying on a remembered fact. Pause the ongoing goal between demonstration sessions and continue when you are ready; the Day labels do not schedule anything automatically. For a single response instead, clear **Keep working on this goal** before starting.

In the recorded first round, Maya produced a workshop plan and invitation draft, created four child tasks, recorded progress and asked for the missing details. The capture operator then explicitly paused the goal and reviewed and accepted two suggested memories. These were deliberate review actions; the recording does not show unattended acceptance of everything Maya proposed.

[![Maya's initial workshop plan specifies 90 minutes, six adults and three shared stations, with the invitation marked DRAFT below](../../githubpages/assets/journeys/11-day1-plan.png)](../../githubpages/assets/journeys/11-day1-plan.png)

Review memories with **Accept suggestion**, **Correct** or **Forget**. This screenshot was taken during review: the invitation is remembered and the proposed plan still needs a decision.

[![Maya's memory page shows a remembered invitation and a proposed workshop plan with Accept suggestion, Correct and Forget controls](../../githubpages/assets/journeys/10-day1-memory.png)](../../githubpages/assets/journeys/10-day1-memory.png)

## Day 2 — Revise the same goal

Return to **Maya → Tasks** and use the goal's **Open chat** link. Send the new brief in that conversation while the ongoing goal is paused. The next brief changes attendance to **eight people, including one who wants decaf**, and confirms the **community room on October 17, 2026 at 10:00 a.m.** Keep the **90-minute session and three shared stations**. Ask what needs to change, then update the invitation and shopping list.

```text
Let's continue the same workshop. Tell me which decisions you are carrying
forward. There will be eight people, including one who wants decaf.
The community room is available on October 17 at 10 a.m.
Keep the 90-minute plan and three shared stations. Update the plan,
invitation draft and shopping list. Save the updated decisions in memory
and update the existing tasks. Keep invitations as drafts.
```

Check the output against both the earlier decisions and the new constraint. Review proposed memories in **Memory**, then return to the goal and use **Continue goal** to resume background work. **Continue goal** resumes the saved goal; it does not collect a new brief. Pause again when reviewing the next result. A plausible recap is not enough: correct missing or stale details and inspect the activity history.

[![Maya's revised shopping draft includes regular and decaf coffee, filters, water and equipment](../../githubpages/assets/journeys/12-day2-shopping.png)](../../githubpages/assets/journeys/12-day2-shopping.png)

This later view of the saved Day 2 response is still a draft: it suggests four equipment sets and 20+ cups. The final review makes the fourth set optional and settles on 24 cups.

[![The paused goal shows two work sessions and progress updated for eight participants while awaiting final approval](../../githubpages/assets/journeys/13-day2-progress.png)](../../githubpages/assets/journeys/13-day2-progress.png)

After the second background work session, the saved progress reflects eight participants and the revised venue/date. The original description still says six adults. Read the current decisions and output as well as the goal's status.

## Day 3 — Finish with something you can run

After reviewing the revisions, send the following message in the same conversation used for Day 2; you can reopen it from Maya's **Conversations**. Give the explicit approval required by the goal's success criteria only when you are ready:

```text
Finalize the workshop pack. Review the plan, invitation draft and shopping list together.
Resolve inconsistencies, flag anything I still need to confirm, and make
a simple run sheet with preparation, welcome, demonstration, practice and cleanup.
Keep all external actions as drafts for my review.
```

Review the actual deliverables before considering the goal complete. Check quantities, times and unresolved decisions yourself. A success label or a confident response alone does not establish that the materials are ready.

[![Maya's saved response includes a 10:00 to 11:30 run sheet and a separate decaf handling note](../../githubpages/assets/journeys/14-day3-runsheet.png)](../../githubpages/assets/journeys/14-day3-runsheet.png)

The response above supplied the run sheet, but its claim that everything was complete and archived did not prove the saved goal was finished. After **Continue goal**, a later goal session still asked for approval. The operator opened that newer goal chat, explicitly asked Maya to remember the approval, then used **Memory → Correct** to save the final details and marked the memory **Important**. Another **Continue goal** completed the saved goal after **four work sessions** across the three demonstration sessions.

[![The final details and approval are saved as Important memory with Correct, Forget and Unpin from core controls](../../githubpages/assets/journeys/15-day3-approval.png)](../../githubpages/assets/journeys/15-day3-approval.png)

One further check found the shopping task still had older quantities. The operator asked Maya to reconcile the saved task with the approved pack: **500 g regular coffee, 100 g decaf, at least 40 filters, 10 L water and 24 tasting cups**, with three shared equipment sets and an optional fourth set. These are planning estimates approved for this demonstration, not quantities prescribed by the coffee source.

[![The saved goal is completed after four work sessions, and the completed shopping task contains the corrected final quantities](../../githubpages/assets/journeys/16-day3-goal-completed.png)](../../githubpages/assets/journeys/16-day3-goal-completed.png)

The saved goal and all four child tasks are completed. Its old **Next step** still asks for approval, its original description still mentions six adults, and the earlier six-person plan remains in memory. The final pack and corrected task agree with the Important memory, but older context was not all removed. The operator checked the saved task states and materials instead of relying on the completion label alone.

**Open the workshop pack →** It contains the plan, invitation marked DRAFT, shopping quantities and 90-minute run sheet. This readable edition reconciles the generated response with the accepted corrections and removes the unsupported archiving claim; the original response remains in the runtime evidence. No invitation was sent and no purchase was made.

## What this example teaches

An agent gives you a reusable way to do a task. A Persona adds continuing context and a place to manage related work. You still choose its model, connected tools and instructions, and you can inspect memories and activity rather than treating them as invisible.

Personas, Roles and persistent goals are experimental. Schedules require the FLUJO server to run; provider limits, failed tools and approval requests may interrupt work. Use pause/stop controls for ongoing goals and check what actually completed. [Capability maturity](../start-here/capabilities.md) · [Persona acceptance limits](../performance/persona-goal-endurance-acceptance.md).

## About the recorded example

The runtime evidence contains the exact prompts, dates, saved tasks, memories and outputs. The sample prompts here are readable guide versions, not a verbatim transcript. The capture manifest and provenance notes identify each image and later retake. All three demonstration sessions took place on October 11, 2026. The software was operated by an agent, including the review and approval steps; this was not an independent human usability study.

[Website Builder](website-builder.md) · [Coffee-reading helper](first-agent.md) · [Start here](../start-here/README.md) · [Privacy and costs](../start-here/privacy.md)
